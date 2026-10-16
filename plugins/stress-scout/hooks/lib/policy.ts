/**
 * The tester's sandbox guard: pure checks over a call's arguments.
 *
 * A seatbelt, not a security boundary: it keeps a well-meaning background
 * agent from touching the real project, secrets, the network or the system,
 * but a shell string can always be obfuscated. For OS-level isolation turn on
 * Claude Code's sandbox (/sandbox) as well.
 */
import { basename, isInside, trimSlash } from './util'

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
  'node',
  'deno',
  'bun',
  'ruby',
  'perl',
  'php',
])

/** True when `text` names `path` as a path (not as a prefix of a longer name). */
export function mentions(text: string, path: string): boolean {
  const base = trimSlash(path)
  if (base === '' || base === '/') return false
  for (let i = text.indexOf(base); i >= 0; i = text.indexOf(base, i + 1)) {
    const next = text[i + base.length]
    if (next === undefined || !/[A-Za-z0-9._-]/.test(next)) return true
  }
  return false
}

const isSecretPath = (path: string, home: string): boolean => {
  if (home !== '' && SECRET_HOME_PATHS.some(secret => isInside(path, `${trimSlash(home)}/${secret}`))) {
    return true
  }
  const name = basename(path)
  if (/^\.env(\..+)?$/.test(name) && !/\.(example|sample|template|dist)$/.test(name)) return true
  return /\.(pem|key|p12|pfx|keystore)$/.test(name) || /^id_(rsa|ed25519|ecdsa|dsa)\b/.test(name)
}

/** Reads: anywhere but secrets. */
export function checkRead(path: string, box: Sandbox): Check {
  return isSecretPath(path, box.home) ? deny('secrets and credentials are off-limits to the tester') : OK
}

/**
 * Writes and edits: only inside the run folder (`realPath` is where the path
 * lands, resolved by the caller), and no harness that names the real project.
 */
export function checkWrite(realPath: string | undefined, content: string, box: Sandbox): Check {
  if (realPath === undefined) return deny('could not resolve where this file would land')
  if (!box.runDirs.some(dir => isInside(realPath, dir))) {
    return deny(`files may only be created or changed inside the run folder ${box.runDirs[0] ?? ''}`)
  }
  if (box.roots.some(root => mentions(content, root))) {
    return deny('the harness must not reference the real project; use paths inside the snapshot')
  }
  return OK
}

type Token = { text: string; isOp: boolean }

/** Splits a command into simple commands at ; && || | & and newlines, outside quotes. */
export function splitCommands(command: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
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
      parts.push(current)
      current = ''
      if ((char === '|' || char === '&') && command[i + 1] === char) i++
      continue
    }
    current += char
  }
  parts.push(current)
  return parts.map(part => part.trim()).filter(part => part !== '')
}

/** Shell words of one simple command, quotes removed; redirections as operators. */
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
      else if (char === '\\' && quote === '"' && i + 1 < segment.length) current += segment[++i]
      else current += char
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

/** The command a simple command runs, past assignments, `timeout N` and the like. */
export function commandOf(tokens: readonly Token[]): { word: string; args: string[] } {
  const words = tokens.filter(token => !token.isOp).map(token => token.text)
  let i = 0
  while (i < words.length) {
    const word = words[i] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word === '(' || word === '{' || word === '!') {
      i++
      continue
    }
    const name = basename(word)
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
    return { word: name.replace(/^\(+/, ''), args: words.slice(i + 1) }
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

const isUnderRun = (path: string, box: Sandbox): boolean =>
  box.runDirs.some(dir => isInside(path, dir))

const escapesUp = (path: string): boolean => /^(\.\.\/){2,}|^\.\.\/\.\.$|\/\.\.\/\.\.(\/|$)/.test(path)

/** Where a write may go: the run folder, /dev/null and the like, or a path relative to it. */
function writableTarget(target: string, box: Sandbox): boolean {
  if (target === '' || target === '-' || target.startsWith('&')) return true
  if (/^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(target)) return true
  if (/^\d+$/.test(target)) return true
  if (target.startsWith('~') || target.startsWith('$HOME') || target.startsWith('${HOME}')) return false
  if (target.startsWith('/')) return isUnderRun(target, box)
  if (target.startsWith('$')) return false
  return !escapesUp(target)
}

const installTargetOk = (segment: string, flags: RegExp, box: Sandbox): boolean => {
  for (const match of segment.matchAll(flags)) {
    const path = (match[2] ?? '').replace(/^["']|["']$/g, '')
    if (path !== '' && path.startsWith('/') && isUnderRun(path, box)) return true
  }
  return false
}

/** Shell commands: the checks above, applied to what the command runs and writes. */
export function checkBash(command: string, box: Sandbox, depth = 0): Check {
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
  if (/(^|[\s;&|(`])printenv\b/m.test(text) || /(^|[;&|(`]\s*)export\s+-p\b/m.test(text) || /(^|[;&|]\s*)(env|set)\s*($|[;&|])/m.test(text)) {
    return deny('do not dump environment variables; they may hold secrets')
  }

  const homes = [box.home, '~', '$HOME', '${HOME}'].filter(home => home !== '')
  for (const home of homes) {
    for (const secret of SECRET_HOME_PATHS) {
      if (text.includes(`${trimSlash(home)}/${secret}`)) {
        return deny('secrets and credentials are off-limits to the tester')
      }
    }
  }
  if (/(^|[\s'"=/<])\.env(\.(?!example|sample|template|dist)[A-Za-z0-9_-]+)?(?=$|[\s'";|&)<>])/m.test(text)) {
    return deny('.env files may hold secrets; use a fake config in the harness')
  }

  for (const match of text.matchAll(/\b(?:https?|wss?|ftp):\/\/(\[[^\]\s]+\]|[^/\s:'"`)]+)/gi)) {
    const host = (match[1] ?? '').toLowerCase()
    if (!LOCAL_HOSTS.has(host)) return deny(`network access is limited to localhost (saw ${host})`)
  }
  if (new RegExp(`${word}(ssh|scp|sftp|ftp|telnet|rsync|nc|ncat|netcat|socat)(\\s|$)`).test(text)) {
    return deny('no remote shells or raw network tools; serve and test on localhost only')
  }

  for (const segment of splitCommands(text)) {
    const tokens = tokenize(segment)
    const { word: name, args } = commandOf(tokens)

    const inner =
      /^(sh|bash|zsh|dash)$/.test(name) && args.includes('-c')
        ? args[args.indexOf('-c') + 1]
        : name === 'eval'
          ? args.join(' ')
          : undefined
    if (inner !== undefined) {
      const nested = checkBash(inner, box, depth + 1)
      if (!nested.isAllowed) return nested
    }

    if (name === 'git') {
      const sub = args.find(arg => !arg.startsWith('-') && !/^[./~]/.test(arg)) ?? ''
      if (!READ_ONLY_GIT.has(sub)) return deny(`git ${sub} is not allowed; the tester uses read-only git only`)
    }

    const isNodeInstall =
      /^(npm|pnpm|bun)$/.test(name) && /^(i|install|add|ci)$/.test(args.find(arg => !arg.startsWith('-')) ?? '')
    const isYarnAdd = name === 'yarn' && /^(add|install)$/.test(args[0] ?? '')
    if ((isNodeInstall || isYarnAdd) && !installTargetOk(segment, /(--prefix|--dir|--cwd|-C)[ =]+("?[^\s"]+"?)/g, box)) {
      return deny(`install packages only into the run folder, e.g. npm i --prefix ${box.runDirs[0] ?? '<run>'}/deps <pkg>`)
    }
    const isPip =
      /^pip[0-9.]*$/.test(name) ||
      ((name === 'uv' || /^python[0-9.]*$/.test(name)) && args.includes('pip'))
    if (isPip && args.includes('install')) {
      const pipInRun = tokens.some(token => !token.isOp && token.text.startsWith('/') && isUnderRun(token.text, box) && /pip[0-9.]*$/.test(token.text))
      if (!pipInRun && !installTargetOk(segment, /(--target|-t|--prefix)[ =]+("?[^\s"]+"?)/g, box)) {
        return deny(`install packages only into the run folder, e.g. pip install --target ${box.runDirs[0] ?? '<run>'}/deps <pkg>`)
      }
    }
    if (/^(gem|cargo|go|brew|apt|apt-get|yum|dnf|pacman|apk|port|pipx|poetry|pipenv|conda|mamba)$/.test(name) && /^(install|add|get)$/.test(args[0] ?? '')) {
      return deny(`${name} ${args[0] ?? ''} installs globally; use the standard library or install into the run folder`)
    }

    if (box.roots.some(root => mentions(segment, root))) {
      const isReadOnly =
        READ_ONLY_COMMANDS.has(name) &&
        !/\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/.test(segment) &&
        !tokens.some(token => token.isOp && token.text.includes('>'))
      if (!isReadOnly) {
        return deny(`the real project (${box.roots[0] ?? ''}) is read-only for the tester; work in the snapshot`)
      }
    }

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      if (!token?.isOp || !token.text.includes('>') || token.text.endsWith('&')) continue
      const target = tokens[i + 1]?.text ?? ''
      if (!writableTarget(target, box)) return deny(`writes may only go inside the run folder (redirect to ${target})`)
    }

    const paths = args.filter(arg => !arg.startsWith('-'))
    if (name === 'cd') {
      const target = paths[0] ?? '~'
      if (target === '-' || !writableTarget(target, box)) return deny('stay inside the snapshot or the run folder')
    }
    if (DEST_COMMANDS.has(name) && paths.length >= 2 && !writableTarget(paths.at(-1) ?? '', box)) {
      return deny(`${name} may only write inside the run folder`)
    }
    if (WRITE_COMMANDS.has(name)) {
      for (const path of name === 'chmod' || name === 'chown' || name === 'chgrp' ? paths.slice(1) : paths) {
        if (path === '/' || path === '*' || !writableTarget(path, box)) {
          return deny(`${name} may only touch paths inside the run folder (saw ${path})`)
        }
      }
    }
  }
  return OK
}
