/**
 * The tester's sandbox guard: pure checks over a call's arguments.
 *
 * A seatbelt, not a security boundary: it keeps a well-meaning background
 * agent from touching the real project, secrets, the network or the system,
 * but a shell string can always be obfuscated. For OS-level isolation turn on
 * Claude Code's sandbox (/sandbox) as well.
 */
import { isWindowsPath, windowsCanonical, windowsCanonicalText } from './platform'
import { DEP_DIRS, snapshotOf } from './shadow'
import { basename, isInside, normalizePath, trimSlash } from './util'

export type Sandbox = {
  /** The real project's root, every spelling of it (as given, resolved). */
  roots: readonly string[]
  /** The run's own folder (snapshot, harness, deps, tmp), every spelling. */
  runDirs: readonly string[]
  /** The person's home directory, '' when unknown. */
  home: string
}

export type Check = { isAllowed: true } | { isAllowed: false; reason: string }

const OK: Check = { isAllowed: true }
const deny = (reason: string): Check => ({ isAllowed: false, reason: `stress-scout guard: ${reason}` })

/** The sandbox as the checks compare it: on Windows every path in one spelling (windowsCanonical). */
type Box = { roots: string[]; runDirs: string[]; home: string; isWindows: boolean; given: Sandbox }

const boxOf = (given: Sandbox): Box => {
  const isWindows = [...given.roots, ...given.runDirs].some(isWindowsPath)
  const spell = (path: string): string => (isWindows ? windowsCanonical(path) : path)
  return { roots: given.roots.map(spell), runDirs: given.runDirs.map(spell), home: given.home === '' ? '' : spell(given.home), isWindows, given }
}

/** `path` the way the checks compare it. */
const spelled = (path: string, box: Box): string => (box.isWindows ? windowsCanonical(path) : path)

const LINK_CLIMB =
  "a path that runs through node_modules, .venv or another dependency folder and back up with .. lands in the real project (they are links to it); name the snapshot's files directly"

const SECRET_HOME_PATHS = [
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.kube',
  '.docker',
  '.config/gcloud',
  '.config/gh',
  '.claude',
  '.claude.json',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  // where Windows keeps the same kinds of secrets
  '_netrc',
  'AppData/Roaming/GitHub CLI',
  'AppData/Roaming/gcloud',
  'AppData/Roaming/Microsoft/Credentials',
  'AppData/Local/Microsoft/Credentials',
  'AppData/Roaming/Microsoft/Protect',
]

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'])

const READ_ONLY_GIT = new Set([
  'status',
  'diff',
  'log',
  'show',
  'ls-files',
  'ls-tree',
  'rev-parse',
  'blame',
  'grep',
  'cat-file',
  'describe',
  'version',
  'help',
])

/** Commands that only read, allowed to name the real project. */
const READ_ONLY_COMMANDS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'ls',
  'stat',
  'file',
  'wc',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'find',
  'diff',
  'cmp',
  'md5',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'shasum',
  'readlink',
  'realpath',
  'du',
  'tree',
])

/** Commands whose last argument is where they write. */
const DEST_COMMANDS = new Set(['cp', 'mv', 'ln', 'install', 'rsync'])

/** Commands that write to every path they are given. */
const WRITE_COMMANDS = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'touch',
  'mkdir',
  'chmod',
  'chown',
  'chgrp',
  'truncate',
  'tee',
])

/** Interpreters a heredoc may feed: their heredoc bodies are code, so checked. */
const INTERPRETERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'python',
  'python3',
  'py',
  'node',
  'deno',
  'bun',
  'ruby',
  'perl',
  'php',
])

/**
 * True when `text` names `path` as a path (not as a prefix of a longer name),
 * in any letter case: macOS file systems ignore case by default.
 */
export function mentions(text: string, path: string): boolean {
  const base = trimSlash(path).toLowerCase()
  if (base === '' || base === '/') return false
  const haystack = text.toLowerCase()
  for (let i = haystack.indexOf(base); i >= 0; i = haystack.indexOf(base, i + 1)) {
    const next = haystack[i + base.length]
    if (next === undefined || !/[a-z0-9._-]/.test(next)) return true
  }
  return false
}

const GLOB = /[*?[{]/

/** The regular expression for one segment of a shell glob: `*`, `?`, `[...]` and `{a,b}`. */
function globSource(pattern: string): string {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? ''
    const close = char === '[' ? pattern.indexOf(']', i + 2) : char === '{' ? pattern.indexOf('}', i + 1) : -1
    if (char === '*') source += '.*'
    else if (char === '?') source += '.'
    else if (close > 0) {
      const body = pattern.slice(i + 1, close)
      source +=
        char === '['
          ? `[${body.replace(/^!/, '^').replace(/\\/g, '\\\\').replace(/^(\^?)\]/, '$1\\]')}]`
          : `(?:${body.split(',').map(globSource).join('|')})`
      i = close
    } else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return source
}

/** Whether one segment of a glob can match `name`, in any case; as in the shell, `*` and `?` never match a leading dot. */
function segmentMatches(pattern: string, name: string): boolean {
  if (!GLOB.test(pattern)) return pattern.toLowerCase() === name.toLowerCase()
  if (name.startsWith('.') && /^[*?]/.test(pattern)) return false
  try {
    return new RegExp(`^${globSource(pattern)}$`, 'i').test(name)
  } catch {
    return true
  }
}

/** Whether `word` names `path` or a path inside it, read as a glob when it has wildcards. */
function names(word: string, path: string): boolean {
  if (mentions(word, path)) return true
  if (!GLOB.test(word)) return false
  const pattern = word.split('/')
  const target = trimSlash(path).split('/')
  return pattern.length >= target.length && target.every((part, i) => segmentMatches(pattern[i] ?? '', part))
}

/** `~`, `~user`, `$HOME` or `${HOME}` (on Windows also `$USERPROFILE`) opening a path word, as the shell expands them. */
const HOME_WORD = /^(~[A-Za-z0-9._-]*|\$HOME|\$\{HOME\}|\$USERPROFILE|\$\{USERPROFILE\})(?=[\\/]|$)/

/** `word` with an opening spelling of the person's home written out; another user's `~name` stays. */
function expandHome(word: string, home: string): string {
  const spelled = HOME_WORD.exec(word)?.[1]
  if (spelled === undefined || home === '') return word
  const isOwn = spelled === '~' || spelled.startsWith('$') || spelled === `~${basename(home)}`
  return isOwn ? `${trimSlash(home)}${word.slice(spelled.length)}` : word
}

/**
 * The words of `text` that may be paths: shell words with quoting undone (a
 * quoted path keeps its spaces, a brace list its commas), and the raw text's
 * words, which find paths inside code.
 */
function wordsOf(text: string, isWindows = false): string[] {
  const words = new Set<string>()
  for (const segment of splitCommands(text)) {
    for (const token of tokenize(segment)) {
      if (!token.isOp) for (const piece of token.text.split(/[;&|()<>`='"]+/)) words.add(piece.trim())
    }
  }
  // on Windows a backslash separates a path, so there it splits nothing
  const raw = isWindows ? text.replace(/\\/g, '/') : text
  for (const piece of raw.split(isWindows ? /[\s;&|()<>`=,'"]+/ : /[\s;&|()<>`=,'"\\]+/)) words.add(piece)
  words.delete('')
  return [...words]
}

const pathsOf = (words: readonly string[], home: string, isWindows = false): string[] =>
  words
    .filter(word => word.includes('/') || HOME_WORD.test(word) || (isWindows && (word.includes('\\') || /^[A-Za-z]:/.test(word))))
    .map(word => {
      const expanded = expandHome(word, home)
      return normalizePath(isWindows ? windowsCanonical(expanded) : expanded)
    })

/**
 * The path-like words of `text` as the OS would read them: quoting undone,
 * the person's home spellings written out, and `//`, `/./` and `x/..` folded,
 * so `"$HOME"/../dev/.ssh`, `~//.aws` and `"/home/u/a b/../.ssh"` each read as
 * the path they name. Checked beside the raw text, never instead.
 */
export function pathView(text: string, home = ''): string[] {
  return pathsOf(wordsOf(text), home)
}

/** Whether a path word (folded, perhaps a glob) names a secret in a home folder: the person's, or another user's `~name`. */
function namesHomeSecret(word: string, home: string): boolean {
  const slash = word.indexOf('/')
  const rest = HOME_WORD.test(word) && slash > 0 ? word.slice(slash + 1) : undefined
  return SECRET_HOME_PATHS.some(
    secret => (home !== '' && names(word, `${trimSlash(home)}/${secret}`)) || (rest !== undefined && names(rest, secret)),
  )
}

const isEnvName = (name: string): boolean => /^\.env(\..+)?$/i.test(name) && !/\.(example|sample|template|dist)$/i.test(name)

/** File names that hold keys or secrets wherever they sit, in any case. */
const isSecretName = (name: string): boolean =>
  isEnvName(name) || /\.(pem|key|p12|pfx|keystore|jks)$/i.test(name) || /^id_(rsa|ed25519|ecdsa|dsa)\b/i.test(name)

/** A path word that may lead out of the working directory: absolute, climbing, or starting at a home or a variable. */
const leavesCwd = (path: string): boolean => /^(\/|\.\.(\/|$)|~|\$)/.test(path)

const isSecretPath = (path: string, home: string): boolean => namesHomeSecret(path, home) || isSecretName(basename(path))

/** A glob whose last segment could match a .env file, like `.env*` or `.e?v`. */
const isEnvGlob = (word: string): boolean => {
  const last = word.split('/').at(-1) ?? ''
  return GLOB.test(last) && ['.env', '.env.local'].some(name => segmentMatches(last, name))
}

/** A path into a dependency folder and back up (`node_modules/..`): the OS climbs from the link's target, the real project. */
const climbsLink = (word: string): boolean => {
  const parts = word.split('/')
  const link = parts.findIndex(part => DEP_DIRS.includes(part.toLowerCase()))
  return link >= 0 && parts.slice(link + 1).includes('..')
}

/**
 * True when the absolute `path` lands inside the run folder, and not in one
 * of the snapshot's dependency folders, which are links into the real
 * project. Any `..` is refused: past a link it climbs the real project.
 */
const isUnderRun = (path: string, box: Box): boolean => {
  const given = spelled(path, box)
  if (given.split('/').includes('..')) return false
  const landing = normalizePath(given)
  return (
    box.runDirs.some(dir => isInside(landing, dir)) &&
    !box.runDirs.some(dir => DEP_DIRS.some(dep => names(landing, `${snapshotOf(dir)}/${dep}`)))
  )
}

/** Reads: anywhere but secrets. `realPath` is where the path lands once links resolve, when known. */
export function checkRead(path: string, sandbox: Sandbox, realPath?: string): Check {
  const box = boxOf(sandbox)
  if (climbsLink(spelled(path, box))) return deny(LINK_CLIMB)
  const given = normalizePath(spelled(expandHome(path, box.home), box))
  const real = realPath === undefined ? undefined : spelled(realPath, box)
  const isSecret = isSecretPath(given, box.home) || (real !== undefined && isSecretPath(real, box.home))
  return isSecret ? deny('secrets and credentials are off-limits to the tester') : OK
}

/**
 * Writes and edits: only inside the run folder (`realPath` is where the path
 * lands, resolved by the caller), and no harness that names the real project.
 */
export function checkWrite(realPath: string | undefined, content: string, sandbox: Sandbox): Check {
  if (realPath === undefined) return deny('could not resolve where this file would land')
  const box = boxOf(sandbox)
  if (!isUnderRun(realPath, box)) {
    return deny(`files may only be created or changed inside the run folder ${sandbox.runDirs[0] ?? ''}, outside its linked dependency folders`)
  }
  const text = box.isWindows ? windowsCanonicalText(content) : content
  const view = pathsOf(wordsOf(content, box.isWindows), box.home, box.isWindows)
  if (box.roots.some(root => mentions(text, root) || view.some(word => names(word, root)))) {
    return deny('the harness must not reference the real project; use paths inside the snapshot')
  }
  return OK
}

type Token = { text: string; isOp: boolean }

/** One simple command of a command line, and the operator that follows it ('' at the end). */
type Segment = { text: string; then: string }

/** Splits a command into simple commands at ; && || | & and newlines, outside quotes. */
function segmentsOf(command: string): Segment[] {
  const parts: Segment[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  const cut = (then: string): void => {
    if (current.trim() !== '') parts.push({ text: current.trim(), then })
    current = ''
  }
  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? ''
    if (quote) {
      if (char === '\\' && quote === '"') {
        current += char + (command[i + 1] ?? '')
        i++
        continue
      }
      if (char === quote) quote = null
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '\\') {
      current += char + (command[i + 1] ?? '')
      i++
      continue
    }
    const isRedirectAmp =
      char === '&' && (command[i - 1] === '>' || command[i + 1] === '>')
    if (char === ';' || char === '\n' || char === '|' || (char === '&' && !isRedirectAmp)) {
      if (char === '|' && command[i - 1] === '>') {
        current += char
        continue
      }
      const isDouble = (char === '|' || char === '&') && command[i + 1] === char
      cut(isDouble ? `${char}${char}` : char === '\n' ? ';' : char)
      if (isDouble) i++
      continue
    }
    current += char
  }
  cut('')
  return parts
}

export function splitCommands(command: string): string[] {
  return segmentsOf(command).map(segment => segment.text)
}

const C_ESCAPES: Readonly<Record<string, string>> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }
const C_ESCAPE = /\\(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|([0-7]{1,3})|c.|(.))/ys

/** A `$'...'` string's text from `start` (just past its quote), escapes decoded as bash does, and where it ends. */
function ansiQuoted(text: string, start: number): { text: string; end: number } {
  let out = ''
  let i = start
  while (i < text.length && text[i] !== "'") {
    C_ESCAPE.lastIndex = i
    const escape = text[i] === '\\' ? C_ESCAPE.exec(text) : null
    if (escape === null) {
      out += text[i]
      i++
      continue
    }
    const [whole = '', hex, u16, u32, octal, other] = escape
    const code = hex ?? u16 ?? u32
    if (code !== undefined) out += String.fromCodePoint(Math.min(Number.parseInt(code, 16), 0x10ffff))
    else if (octal !== undefined) out += String.fromCharCode(Number.parseInt(octal, 8) & 0xff)
    else if (other !== undefined) out += C_ESCAPES[other] ?? other
    i += whole.length
  }
  return { text: out, end: i }
}

/** Shell words of one simple command, quotes removed (`$'...'` decoded); redirections as operators. */
export function tokenize(segment: string): Token[] {
  const tokens: Token[] = []
  let current = ''
  let hasWord = false
  let quote: '"' | "'" | null = null
  const push = () => {
    if (hasWord) tokens.push({ text: current, isOp: false })
    current = ''
    hasWord = false
  }
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i] ?? ''
    if (quote) {
      if (char === quote) quote = null
      // inside double quotes a backslash escapes only $ ` " \ and a newline, as in bash: `"C:\Users"` keeps its
      else if (char === '\\' && quote === '"' && '$`"\\\n'.includes(segment[i + 1] ?? 'x')) current += segment[++i]
      else current += char
      continue
    }
    if (char === '$' && segment[i + 1] === "'") {
      const quoted = ansiQuoted(segment, i + 2)
      current += quoted.text
      hasWord = true
      i = quoted.end
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      hasWord = true
      continue
    }
    if (char === '\\' && i + 1 < segment.length) {
      current += segment[++i]
      hasWord = true
      continue
    }
    if (/\s/.test(char)) {
      push()
      continue
    }
    if (char === '>' || char === '<') {
      let op = char
      if (current === '&' || /^\d+$/.test(current)) {
        op = current + op
        current = ''
        hasWord = false
      } else push()
      while (segment[i + 1] === '>' || segment[i + 1] === '&' || segment[i + 1] === '|' || segment[i + 1] === '<') {
        op += segment[++i]
      }
      tokens.push({ text: op, isOp: true })
      continue
    }
    current += char
    hasWord = true
  }
  push()
  return tokens
}

const PREFIX_WORDS = new Set(['time', 'nice', 'nohup', 'exec', 'command', 'builtin', 'env', 'stdbuf', 'ionice'])

/** Shell keywords that open a simple command without being it: `then rm -rf x` runs rm. */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '(', '{'])

/** The command a simple command runs, past assignments, keywords, `timeout N` and the like. */
export function commandOf(tokens: readonly Token[]): { word: string; args: string[] } {
  const words = tokens.filter(token => !token.isOp).map(token => token.text)
  let i = 0
  while (i < words.length) {
    const word = words[i] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || KEYWORDS.has(word)) {
      i++
      continue
    }
    const name = basename(word).replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase()
    if (PREFIX_WORDS.has(name)) {
      i++
      while (i < words.length && /^(-|\d+$)/.test(words[i] ?? '')) i++
      continue
    }
    if (name === 'timeout') {
      i++
      while (i < words.length && (words[i] ?? '').startsWith('-')) {
        const flag = words[i] ?? ''
        i += flag === '-s' || flag === '-k' || flag === '--signal' || flag === '--kill-after' ? 2 : 1
      }
      i++
      continue
    }
    return { word: name.replace(/^[({]+/, ''), args: words.slice(i + 1) }
  }
  return { word: '', args: [] }
}

/** Removes heredoc bodies fed to anything but an interpreter (they are file contents). */
export function stripDataHeredocs(command: string): string {
  const lines = command.split('\n')
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    kept.push(line)
    const heredoc = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)
    if (!heredoc) continue
    const before = line.slice(0, heredoc.index)
    const { word } = commandOf(tokenize(splitCommands(before).at(-1) ?? before))
    const isCode = INTERPRETERS.has(word.replace(/[0-9.]+$/, '')) || INTERPRETERS.has(word)
    const end = lines.findIndex((body, j) => j > i && body.trim() === heredoc[2])
    if (end < 0) continue
    if (isCode) kept.push(...lines.slice(i + 1, end + 1))
    else kept.push(heredoc[2] ?? '')
    i = end
  }
  return kept.join('\n')
}

/**
 * Where the shell stands while one command runs: `path` once a `cd` named a
 * folder by absolute path, else `depth` folders below the one the command
 * started in. That start is inside the run folder: every `cd` is checked, and
 * Claude Code moves a shell that strays outside its allowed folders back.
 */
type Cwd = { path?: string; depth: number }

/** Write targets that are no file: standard streams, /dev/null (NUL on Windows), file descriptors. */
const isStream = (target: string, isWindows: boolean): boolean =>
  target === '' ||
  target === '-' ||
  target.startsWith('&') ||
  /^\d+$/.test(target) ||
  /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(target) ||
  (isWindows && /^nul$/i.test(target))

/**
 * Where `target` lands from `cwd`, or undefined when it may leave the run
 * folder. A `..` counts only at the start of a relative path, and only back
 * out of folders this command entered; after a name it could climb out of
 * one of the snapshot's dependency links, from the real project's side.
 */
function landing(given: string, cwd: Cwd, box: Box): Cwd | undefined {
  const target = spelled(given, box)
  if (target.startsWith('~') || target.startsWith('$')) return undefined
  // `C:x` is relative to whatever folder drive C: was last in
  if (box.isWindows && /^[a-z]:/.test(target)) return undefined
  const isAbsolute = target.startsWith('/')
  const parts = target.split('/').filter(part => part !== '' && part !== '.')
  let up = 0
  while (!isAbsolute && parts[up] === '..') up++
  const rest = parts.slice(up)
  if (rest.includes('..')) return undefined
  const base = isAbsolute ? '' : cwd.path
  if (base !== undefined) {
    const path = normalizePath(`${base}/${parts.join('/')}`)
    return isUnderRun(path, box) ? { path, depth: 0 } : undefined
  }
  // the links sit in the snapshot's top folder: reached as `node_modules` from there, `snapshot/node_modules` from the run folder
  const isLink = (part = ''): boolean => DEP_DIRS.some(dep => segmentMatches(part, dep))
  if (up > cwd.depth || isLink(rest[0]) || (segmentMatches(rest[0] ?? '', 'snapshot') && isLink(rest[1]))) return undefined
  return { depth: cwd.depth - up + rest.length }
}

/** `path` for a refusal, with why when it runs into one of the snapshot's dependency links. */
const shown = (path: string): string =>
  path.split('/').some(part => DEP_DIRS.some(dep => segmentMatches(part, dep)))
    ? `${path}; node_modules, .venv and the snapshot's other dependency folders are links into the real project`
    : path

const installTargetOk = (segment: string, flags: RegExp, box: Box, into = ''): boolean => {
  for (const match of segment.matchAll(flags)) {
    const path = spelled((match[2] ?? '').replace(/^["']|["']$/g, ''), box)
    if (path !== '' && path.startsWith('/') && isUnderRun(`${trimSlash(path)}${into}`, box)) return true
  }
  return false
}

/** Windows shells and system tools: the tester's Bash tool is Git Bash, and these reach past it. */
const WINDOWS_TOOLS = new Set([
  'cmd',
  'powershell',
  'pwsh',
  'wsl',
  'start',
  'runas',
  'reg',
  'regedit',
  'schtasks',
  'sc',
  'net',
  'netsh',
  'icacls',
  'takeown',
  'setx',
  'bcdedit',
  'wmic',
  'mklink',
  'cscript',
  'wscript',
  'mshta',
  'rundll32',
])

/** Shell commands: the checks above, applied to what the command runs and writes. */
export function checkBash(command: string, sandbox: Sandbox, depth = 0): Check {
  return bashCheck(command, boxOf(sandbox), depth)
}

function bashCheck(command: string, box: Box, depth: number): Check {
  if (depth > 3) return deny('command nests too deeply to check')
  const text = stripDataHeredocs(command)
  const word = '(?:^|[\\s;&|(`])'

  if (new RegExp(`${word}(sudo|doas|su)(\\s|$)`).test(text)) return deny('no sudo, doas or su')
  if (new RegExp(`${word}(mkfs\\S*|shutdown|reboot|halt|poweroff|launchctl|systemctl|crontab|diskutil|osascript)\\b`).test(text)) {
    return deny('system administration commands are not allowed')
  }
  if (/:\(\)\s*\{/.test(text) || /\bkill\s+(-\S+\s+)*-1\b/.test(text) || /\bdd\b[^;&|]*\bof=\/dev\//.test(text)) {
    return deny('that command could take down the machine')
  }
  const words = wordsOf(text, box.isWindows)
  const paths = pathsOf(words, box.home, box.isWindows)
  const isEnvDump =
    /(^|[\s;&|(`])printenv\b/m.test(text) ||
    /(^|[;&|(`]\s*)export\s+-p\b/m.test(text) ||
    /(^|[;&|]\s*)(env|set)\s*($|[;&|])/m.test(text) ||
    paths.some(path => /^\/proc\/[^/]+\/environ$/i.test(path))
  if (isEnvDump) return deny('do not dump environment variables; they may hold secrets')

  const homes = [box.home, '~', '$HOME', '${HOME}', ...(box.isWindows ? ['$USERPROFILE', '${USERPROFILE}'] : [])].filter(
    home => home !== '',
  )
  const view = box.isWindows ? windowsCanonicalText(text) : text
  // key files are refused wherever they may lie outside the run folder; the harness may make its own test keys
  const isSecret =
    homes.some(home => SECRET_HOME_PATHS.some(secret => mentions(view, `${trimSlash(home)}/${secret}`))) ||
    paths.some(path => namesHomeSecret(path, box.home) || (leavesCwd(path) && !isUnderRun(path, box) && isSecretName(basename(path))))
  if (isSecret) return deny('secrets and credentials are off-limits to the tester')
  // .env however the shell is made to spell it: `.env*`, `.e""nv`, `.ENV`
  const isEnv =
    /(^|[\s'"=/<])\.env(\.(?!example|sample|template|dist)[A-Za-z0-9_-]+)?(?=$|[\s'";|&)<>])/im.test(text) ||
    words.some(word => isEnvGlob(word) || isEnvName(basename(word)))
  if (isEnv) return deny('.env files may hold secrets; use a fake config in the harness')
  if (words.some(word => climbsLink(spelled(word, box)))) return deny(LINK_CLIMB)

  for (const match of text.matchAll(/\b(?:https?|wss?|ftp):\/\/(\[[^\]\s]+\]|[^/\s:'"`)]+)/gi)) {
    const host = (match[1] ?? '').toLowerCase()
    if (!LOCAL_HOSTS.has(host)) return deny(`network access is limited to localhost (saw ${host})`)
  }
  if (new RegExp(`${word}(ssh|scp|sftp|ftp|telnet|rsync|nc|ncat|netcat|socat)(\\s|$)`).test(text)) {
    return deny('no remote shells or raw network tools; serve and test on localhost only')
  }

  let cwd: Cwd = { depth: 0 }
  const pushed: Cwd[] = []
  for (const { text: segment, then } of segmentsOf(text)) {
    const tokens = tokenize(segment)
    const { word: name, args } = commandOf(tokens)
    if (box.isWindows && WINDOWS_TOOLS.has(name)) {
      return deny(`${name} is not allowed: Windows shells and system tools reach past the sandbox; use bash commands`)
    }

    const inner =
      /^(sh|bash|zsh|dash)$/.test(name) && args.includes('-c')
        ? args[args.indexOf('-c') + 1]
        : name === 'eval'
          ? args.join(' ')
          : undefined
    if (inner !== undefined) {
      const nested = bashCheck(inner, box, depth + 1)
      if (!nested.isAllowed) return nested
    }

    if (name === 'git') {
      const sub = args.find(arg => !arg.startsWith('-') && !/^[./~]/.test(arg)) ?? ''
      if (!READ_ONLY_GIT.has(sub)) return deny(`git ${sub} is not allowed; the tester uses read-only git only`)
    }

    const isNodeInstall =
      /^(npm|pnpm|bun)$/.test(name) && /^(i|install|add|ci)$/.test(args.find(arg => !arg.startsWith('-')) ?? '')
    const isYarnAdd = name === 'yarn' && /^(add|install)$/.test(args[0] ?? '')
    if ((isNodeInstall || isYarnAdd) && !installTargetOk(segment, /(--prefix|--dir|--cwd|-C)[ =]+("?[^\s"]+"?)/g, box, '/node_modules')) {
      return deny(`install packages only into the run folder, e.g. npm i --prefix ${box.given.runDirs[0] ?? '<run>'}/deps <pkg>`)
    }
    const isPip =
      /^pip[0-9.]*$/.test(name) ||
      ((name === 'uv' || /^python[0-9.]*$/.test(name)) && args.includes('pip'))
    if (isPip && args.includes('install')) {
      const pipInRun = tokens.some(token => {
        const path = spelled(token.text, box)
        return !token.isOp && path.startsWith('/') && isUnderRun(path, box) && /pip[0-9.]*(\.exe)?$/i.test(path)
      })
      if (!pipInRun && !installTargetOk(segment, /(--target|-t|--prefix)[ =]+("?[^\s"]+"?)/g, box)) {
        return deny(`install packages only into the run folder, e.g. pip install --target ${box.given.runDirs[0] ?? '<run>'}/deps <pkg>`)
      }
    }
    if (/^(gem|cargo|go|brew|apt|apt-get|yum|dnf|pacman|apk|port|pipx|poetry|pipenv|conda|mamba)$/.test(name) && /^(install|add|get)$/.test(args[0] ?? '')) {
      return deny(`${name} ${args[0] ?? ''} installs globally; use the standard library or install into the run folder`)
    }

    const segmentView = box.isWindows ? windowsCanonicalText(segment) : segment
    const segmentPaths = pathsOf(wordsOf(segment, box.isWindows), box.home, box.isWindows)
    if (box.roots.some(root => mentions(segmentView, root) || segmentPaths.some(path => names(path, root)))) {
      const isReadOnly =
        READ_ONLY_COMMANDS.has(name) &&
        !/\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/.test(segment) &&
        !tokens.some(token => token.isOp && token.text.includes('>'))
      if (!isReadOnly) {
        return deny(`the real project (${box.given.roots[0] ?? ''}) is read-only for the tester; work in the snapshot`)
      }
    }

    const lands = (target: string): Cwd | undefined => (isStream(target, box.isWindows) ? cwd : landing(target, cwd, box))
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      if (!token?.isOp || !token.text.includes('>') || token.text.endsWith('&')) continue
      const target = tokens[i + 1]?.text ?? ''
      if (lands(target) === undefined) return deny(`writes may only go inside the run folder (redirect to ${shown(target)})`)
    }

    const paths = args.filter(arg => !arg.startsWith('-'))
    if (name === 'cd' || name === 'pushd') {
      const target = paths[0] ?? '~'
      const next = target === '-' ? undefined : landing(target, cwd, box)
      if (next === undefined) {
        return deny(
          `stay inside the snapshot or the run folder (saw ${shown(target)}): cd by absolute path, and use \`cd ..\` only to leave a folder this command entered`,
        )
      }
      // a later command runs there only if this one ran in this shell and was not skipped
      if ((then === '&&' || then === ';' || then === '') && !segment.startsWith('(')) {
        if (name === 'pushd') pushed.push(cwd)
        cwd = next
      }
    }
    if (name === 'popd') cwd = pushed.pop() ?? cwd
    if (DEST_COMMANDS.has(name) && paths.length >= 2 && lands(paths.at(-1) ?? '') === undefined) {
      return deny(`${name} may only write inside the run folder (saw ${shown(paths.at(-1) ?? '')})`)
    }
    if (name === 'ln' && paths.some(path => lands(path) === undefined)) {
      return deny('links may only point inside the run folder')
    }
    if (WRITE_COMMANDS.has(name)) {
      for (const path of name === 'chmod' || name === 'chown' || name === 'chgrp' ? paths.slice(1) : paths) {
        if (path === '/' || path === '*' || lands(path) === undefined) {
          return deny(`${name} may only touch paths inside the run folder (saw ${shown(path)})`)
        }
      }
    }
  }
  return OK
}
