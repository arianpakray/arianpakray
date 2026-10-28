import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fnv } from '../hooks/lib/util'

const ROOT = '/work/proj'
const TREE_A = 'a'.repeat(40)
const TREE_B = 'b'.repeat(40)
const TREE_C = 'f'.repeat(40)
const TREE_GONE = '9'.repeat(40)

/** A tool call as the engine makes one; loosely typed, so the test checks the same whatever tools this build declares. */
const toolCall = ($: { tool: { call: unknown } }, input: Record<string, unknown>): Promise<unknown> =>
  ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<unknown>)(input)
const HEAD = 'c'.repeat(40)
const AFTER = 'd'.repeat(40)
const BLOB = 'e'.repeat(40)
const PATCH = [
  'diff --git a/src/cache.ts b/src/cache.ts',
  '--- a/src/cache.ts',
  '+++ b/src/cache.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
].join('\n')
const USAGE = { input_tokens: 900, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const TRIAGE = JSON.stringify({
  worth: true,
  risk: 'high',
  target: 'src/cache.ts:LruCache.set',
  files: ['src/cache.ts'],
  kind: 'concurrency',
  why: 'check-then-act across an await',
  attack: '64 writers x 10k ops',
})
const REPORT = `Ran it.\n\`\`\`json\n${JSON.stringify({
  target: 'src/cache.ts:LruCache.set',
  kind: 'concurrency',
  verdict: 'broke',
  headline: 'lost 1,214 of 10,000 writes under 64 writers',
  evidence: 'eviction reads size before the await',
  before: '1,214/10,000 lost',
  after: '0/10,000 lost',
  fix: { summary: 'evict before the await', explanation: 'no await between check and act', files: ['src/cache.ts'], verified: true },
  nextStep: 'apply the patch and rerun the harness',
  rerun: 'timeout 120 node .stress-scout/race.mjs',
  confidence: 'high',
})}\n\`\`\``
const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
}
const PANE = {
  title: 'Stress Scout',
  isFocused: false,
  bodyColumns: 70,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}
const SURFACES = ['terminal', 'desktop', 'mobile'] as const
const RUN = '/tmp/stress-scout/proj-1234abcd/runs/run-0001-1700000000000'

/** Where the world runs: the project's root and the environment it starts in. */
type Place = { root: string; env: Readonly<Record<string, string>> }

const POSIX: Place = { root: ROOT, env: { HOME: '/Users/dev', TMPDIR: '/tmp', CLAUDE_CODE_EXECPATH: '/opt/claude/bin/claude' } }

// Windows as Claude Code started from PowerShell sees it: no HOME, and a Git Bash TMPDIR it must not use
const WIN_ROOT = 'C:\\work\\proj'
const WINDOWS: Place = {
  root: WIN_ROOT,
  env: {
    USERPROFILE: 'C:\\Users\\dev',
    TEMP: 'C:\\Users\\dev\\AppData\\Local\\Temp',
    TMPDIR: '/tmp',
    CLAUDE_CODE_EXECPATH: 'C:\\Program Files\\claude\\claude.exe',
  },
}

/**
 * A path as a Windows engine answers it: the kit runs on Linux, where `C:\\...`
 * is relative, and resolves it against its own folder first. POSIX paths pass.
 */
const fromDrive = (path: string): string => path.slice(Math.max(0, path.search(/[A-Za-z]:[\\\\/]/)))

const slashed = (path: string): string => path.replace(/\\/g, '/')

/** The kit resolves a path on the machine it runs on: on Windows `/work/proj` reaches a hook as `C:\work\proj`. Read back as written. */
const posixOf = (path: string): string => slashed(fromDrive(path).replace(/^[A-Za-z]:(?=[\\/])/, ''))

/** A PowerShell -EncodedCommand argument read back: base64 of UTF-16LE. */
function decodePowerShell(encoded: string): string {
  const digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  for (let i = 0; i < encoded.length; i += 4) {
    const [a, b, c, d] = [0, 1, 2, 3].map(k => digits.indexOf(encoded[i + k] ?? '='))
    const n = ((a ?? 0) << 18) | ((b ?? 0) << 12) | (Math.max(c ?? 0, 0) << 6) | Math.max(d ?? 0, 0)
    bytes.push((n >> 16) & 255)
    if ((c ?? -1) >= 0) bytes.push((n >> 8) & 255)
    if ((d ?? -1) >= 0) bytes.push(n & 255)
  }
  let text = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) text += String.fromCharCode((bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8))
  return text
}

type Spawned = { argv: readonly string[]; cwd?: string; env?: Readonly<Record<string, string>>; input?: string }

type World = {
  tree: string
  spawned: Spawned[]
  statuses: string[]
  toasts: string[]
  suggestions: string[]
  submitted: { text: string; context: readonly string[] }[]
  writes: Map<string, string>
  triagePrompts: string[]
  /** A slash command's hook is running: the host refuses a prompt.submit then, as the real one does. */
  isInCommand: boolean
  /** Trees the shadow repository does not hold (it was rebuilt since): git refuses to read them. */
  missingTrees: Set<string>
  /** Every command the plugin ran, as its argument vector. */
  runs: (readonly string[])[]
  /** Paths that exist beyond the files the plugin wrote. */
  existing: Set<string>
  /** The account's usage windows, as the last reply reported them. */
  rateLimits: { kind: string; percentUsed: number }[]
  /** The session's credential as `$.session.authorize()` answers it; `refused` makes the call throw. */
  credential: { handle: string; kind: 'bearer' | 'api-key' } | null | 'refused'
  /** Each pane the plugin asked to open, by id. */
  opened: string[]
  /** what $.session.surfaces() answers: one attached window unless a test empties it */
  surfaces: ('terminal' | 'desktop' | 'vscode' | 'mobile')[]
  /** The testers' final reports, in the order they run; REPORT once these run out. */
  reports: string[]
  /** While set, prompt.submit does not resolve: Claude is busy and the prompt waits its turn. */
  submitGate: Promise<void> | undefined
  /** How the next prompt.submit calls fail, one entry each: a throw, or a drop. */
  submitFailures: ('throw' | 'drop')[]
  /** What `uname -s` answers; '' is a machine with none of the offline tools. */
  kernel: string
  /** Whether sandbox-exec or unshare runs here. */
  hasOffline: boolean
  /** The project's own git: its branch and short HEAD. */
  project: { branch: string; head: string }
  /** What hashing the project's src/cache.ts answers. */
  fileSha: string
  /** The exit code of the stored harness command when the plugin reruns it. */
  harnessExit: number
  /** The blob git lists for src/cache.ts; a test changes it to change the file. */
  blob: string
  /** What `$.store` holds: seeded from the stored values, and written to as the plugin runs. */
  store: Map<string, unknown>
}

const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const line = (event: unknown) => `${JSON.stringify(event)}\n`

/** The machine beneath the plugin: git, files, models and the tester process, all from memory. */
function world(on: On, stored: Readonly<Record<string, unknown>> = {}, place: Place = POSIX): World {
  const w: World = {
    tree: TREE_A,
    spawned: [],
    statuses: [],
    toasts: [],
    suggestions: [],
    submitted: [],
    submitGate: undefined,
    submitFailures: [],
    writes: new Map(),
    triagePrompts: [],
    isInCommand: false,
    missingTrees: new Set(),
    runs: [],
    existing: new Set(),
    rateLimits: [],
    credential: null,
    opened: [],
    surfaces: ['desktop'],
    reports: [],
    kernel: '',
    hasOffline: true,
    project: { branch: 'main', head: 'abc1234' },
    fileSha: BLOB,
    harnessExit: 0,
    blob: BLOB,
    store: new Map(Object.entries(stored)),
  }
  on('store.get', ($, e) => ({ value: w.store.get(e.key) }))
  on('store.set', ($, e) => {
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  mock.env(on, place.env)
  const spell = /^[A-Za-z]:/.test(place.root) ? fromDrive : posixOf
  on('session.root', () => ({ value: place.root }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'make the LRU cache safe under concurrent writers', toolUses: [] }] }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: w.rateLimits } }) as never)
  on('session.authorize', () => {
    if (w.credential === 'refused') throw new Error('session.authorize: refused')
    return { value: w.credential }
  })
  on('fs.write', ($, e) => {
    w.writes.set(spell(e.path), e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: [...w.writes.keys(), ...w.existing].some(path => slashed(path) === slashed(spell(e.path))) }))
  on('fs.stat', ($, e) => ({ value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, realPath: spell(e.path) } }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', ($, e) => {
    w.runs.push(e.argv)
    if (e.argv[0] === 'uname') return ok(`${w.kernel}\n`)
    if (e.argv[0] === 'sandbox-exec' || e.argv[0] === 'unshare') {
      return { value: { exitCode: w.hasOffline ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const argv = e.argv.join(' ')
    const index = e.init?.env?.GIT_INDEX_FILE ?? ''
    if (e.argv[0] === 'sh' && e.argv[1] === '-c') {
      return { value: { exitCode: w.harnessExit, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv.some(arg => w.missingTrees.has(arg.replace('^{tree}', '')))) {
      return { value: { exitCode: 128, stdout: '', stderr: 'fatal: bad object', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (argv.includes('rev-parse --path-format')) return ok(`${ROOT}/.git\n`)
    if (argv.includes('rev-parse --short')) return ok(`${w.project.head}\n`)
    if (argv.includes('symbolic-ref')) return ok(`${w.project.branch}\n`)
    if (argv.includes('hash-object')) return ok(`${w.fileSha}\n`)
    if (argv.includes('rev-parse --verify')) return ok(`${HEAD}\n`)
    if (argv.endsWith('write-tree')) return ok(`${index.endsWith('snapshot.index') ? AFTER : w.tree}\n`)
    if (argv.includes('--name-only')) return ok('src/cache.ts\n')
    if (argv.includes('--stat')) return ok(' src/cache.ts | 4 ++--\n')
    if (e.argv.includes('--diff-filter=MRD')) return ok(PATCH)
    if (e.argv.includes('--diff-filter=A')) return ok('')
    // the diff differs per tree, as real edits do: triage verdicts are cached by what the diff says
    if (e.argv.includes('diff')) return ok(`@@ -1 +1 @@\n-old\n+new ${w.tree}\n`)
    if (e.argv.includes('ls-tree')) return ok(`100644 blob ${w.blob}     900\tsrc/cache.ts\n`)
    return ok()
  })
  // the headless tester: a few stream-json lines, the last one cut off without its newline
  on('process.spawn', async function* (_$: unknown, e: Spawned) {
    w.spawned.push({ argv: e.argv, cwd: e.cwd, env: e.env, input: e.input })
    yield { stream: 'stdout' as const, text: line({ type: 'system', subtype: 'init' }) }
    const toolUse = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'timeout 120 node x' } }] } }
    yield { stream: 'stdout' as const, text: line(toolUse) + line(toolUse).slice(0, 20) }
    yield { stream: 'stdout' as const, text: line(toolUse).slice(20) }
    yield { stream: 'stderr' as const, text: 'warming up\n' }
    yield { stream: 'stdout' as const, text: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: w.reports.shift() ?? REPORT, total_cost_usd: 0.42, usage: USAGE }) }
    return { value: { code: 0, signal: null } }
  } as never)
  on('model.complete', ($, e) => {
    w.triagePrompts.push(String(e.prompt))
    return { value: { isAnswered: true as const, text: TRIAGE, usage: USAGE } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', ($, e) => {
    w.statuses.push(e.text ?? '')
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.surfaces', () => ({ value: w.surfaces }))
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('prompt.suggest', ($, e) => {
    w.suggestions.push(e.text)
    return { isShown: true }
  })
  on('prompt.submit', async ($, e) => {
    if (w.isInCommand) throw new Error('prompt.submit: called from a command.run hook, it would wait on the turn this hook is holding')
    w.submitted.push({ text: e.text, context: e.context ?? [] })
    await w.submitGate
    const failure = w.submitFailures.shift()
    if (failure === 'throw') throw new Error('session closed')
    if (failure === 'drop') return { drop: 'busy' } as never
    return { text: e.text, context: e.context }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  return w
}

/** `/stress <args>` as the person types it. */
const stress = (args: string) => ({
  command: 'stress',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

test('a risky edit is triaged, tested in a snapshot by a locked-down tester, and handed back with its verified fix', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(w.statuses.at(-1)).toMatch(/watching/)

  await toolCall($, { tool: 'Edit', file_path: `${ROOT}/src/cache.ts`, old_string: 'old', new_string: 'new' })
  w.tree = TREE_B
  await clock.advance(44_000)
  expect(w.spawned).toHaveLength(0)
  await clock.advance(1_000)
  await clock.settle()

  // triage saw the change and what the developer is working on
  expect(w.triagePrompts).toHaveLength(1)
  expect(w.triagePrompts[0]).toContain('make the LRU cache safe under concurrent writers')
  expect(w.triagePrompts[0]).toContain('src/cache.ts | 4')

  // one headless tester, working in the snapshot, fenced in
  expect(w.spawned).toHaveLength(1)
  const tester = w.spawned[0]
  const argv = tester?.argv ?? []
  const flag = (name: string) => argv[argv.indexOf(name) + 1]
  expect(argv[0]).toBe('/opt/claude/bin/claude')
  expect(argv).toContain('-p')
  expect(flag('--permission-mode')).toBe('dontAsk')
  expect(flag('--tools')).toBe('Bash,Read,Write,Edit')
  expect(flag('--max-budget-usd')).toBe('2')
  expect(flag('--setting-sources')).toBe('user')
  expect(argv).toContain('--strict-mcp-config')
  expect(argv).toContain('--no-session-persistence')
  expect(flag('--plugin-dir')).toBeDefined()
  // compared with forward slashes, from the end: a Windows host spells /tmp as D:\\tmp
  const cwd = slashed(tester?.cwd ?? '')
  expect(cwd).toMatch(/\/tmp\/stress-scout\/proj-[0-9a-f]{8}\/runs\/run-0001-\d+\/snapshot$/)
  expect(cwd.endsWith(`${slashed(flag('--add-dir') ?? '').replace(/^[A-Za-z]:/, '')}/snapshot`)).toBe(true)
  expect(tester?.env?.STRESS_SCOUT_ROLE).toBe('tester')
  expect(tester?.env?.ANTHROPIC_API_KEY).toBe(undefined)
  expect(JSON.parse(tester?.env?.STRESS_SCOUT_ROOTS ?? '[]')).toEqual([ROOT])
  expect(tester?.input).toContain('TARGET: src/cache.ts:LruCache.set')
  expect(tester?.input).toContain('REAL PROJECT (off-limits; never touch or name it): /work/proj')

  // the report came back: toast, suggestion, the patch read back from the snapshot by git
  expect(w.toasts.at(-1)).toMatch(/^stress-scout #1 broke: lost 1,214/)
  expect(w.suggestions.at(-1)).toBe('Apply stress-scout fix #1: evict before the await')
  const patchFile = [...w.writes.keys()].find(path => /[\\/]fix\.patch$/.test(path))
  expect(w.writes.get(patchFile ?? '')).toContain('+new')
  expect(w.statuses.at(-1)).toMatch(/watching · 1\/8 runs/)
  const status = await $.command.run(stress('status') as never)
  expect(status.text).toContain('$0.42')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'stress-scout', surface, component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ text: /stress-scout #1 broke/ })).toBeDefined()
    expect(await ui.find({ key: 'apply' })).toBeDefined()
    expect(await ui.find({ text: /verified fix: evict before the await/ })).toBeDefined()
    // a graphical surface draws the band as one card edged in the verdict's color; the terminal keeps bare rows
    const cards = (await ui.findAll({ type: 'Box' })).filter(b => b.props.borderStyle === 'round')
    expect(cards).toHaveLength(surface === 'terminal' ? 0 : 1)
    if (surface !== 'terminal') expect(cards[0]?.props.borderColor).toBe('error')
    await ui.unmount()

    const pane = await $.ui.mount({ plugin: 'stress-scout', surface, component: 'Pane', requestId: 'stress-scout', props: PANE })
    expect(await pane.find({ text: /#1 broke/ })).toBeDefined()
    const paneCards = (await pane.findAll({ type: 'Box' })).filter(b => b.props.borderStyle === 'round')
    expect(paneCards).toHaveLength(surface === 'terminal' ? 0 : 1)
    await pane.unmount()
  }

  // one press hands it over in full; the band then steps aside
  const band = await $.ui.mount({ plugin: 'stress-scout', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'apply' })
  await clock.settle()
  const handed = w.submitted.at(-1)
  expect(handed?.text).toMatch(/^Apply stress-scout fix #1: evict before the await\n/)
  expect(handed?.text).toContain('```diff')
  expect(handed?.text).toContain('Before the fix: 1,214/10,000 lost')
  // the whole patch is inline, so the session isn't sent to read it from outside the project
  expect(handed?.text).not.toContain('/fix.patch')
  expect(await band.find({ text: /engine band/ })).toBeDefined()
  await band.unmount()

  // handed over already: /stress apply says so and sends nothing more
  const count = w.submitted.length
  const applied = await $.command.run(stress('apply 1') as never)
  expect(applied.text).toBe('Finding #1 is already handed to Claude.')
  await clock.settle()
  expect(w.submitted).toHaveLength(count)
  expect((await $.command.run(stress('status') as never)).text).toContain('#1 broke src/cache.ts:LruCache.set: lost 1,214')

  // typed by hand (or taken from the Tab suggestion): the details ride along as hidden context, once
  await $.prompt.submit({ text: 'Apply stress-scout fix #1: evict before the await', wait: false, origin: { kind: 'composer' } })
  const typed = w.submitted.at(-1)
  expect(typed?.context).toHaveLength(1)
  expect(typed?.context[0]).toContain('```diff')
})

test('memory: the same code is not stress-tested twice', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await toolCall($, { tool: 'Edit', file_path: `${ROOT}/src/cache.ts`, old_string: 'old', new_string: 'new' })
  w.tree = TREE_B
  await clock.advance(45_000)
  await clock.settle()
  expect(w.spawned).toHaveLength(1)

  // another edit elsewhere; the triage picks the same, unchanged file again
  await toolCall($, { tool: 'Edit', file_path: `${ROOT}/README.md`, old_string: 'a', new_string: 'b' })
  w.tree = TREE_C
  await clock.advance(4 * 60_000)
  await clock.settle()
  expect(w.triagePrompts).toHaveLength(2)
  expect(w.triagePrompts[1]).toContain('src/cache.ts | concurrency | broke')
  expect(w.spawned).toHaveLength(1)

  const status = await $.command.run(stress('status') as never)
  expect(status.text).toContain('#1 broke src/cache.ts:LruCache.set')
})

test('the pane draws on every surface, and Pause stops automatic runs', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'stress-scout', surface, component: 'Pane', requestId: 'stress-scout', props: PANE })
    expect(await ui.find({ text: /stress-scout · watching/ })).toBeDefined()
    expect(await ui.find({ text: /No findings yet/ })).toBeDefined()
    expect(await ui.find({ key: 'run' })).toBeDefined()
    await ui.unmount()
  }
  const pane = await $.ui.mount({ plugin: 'stress-scout', surface: 'desktop', component: 'Pane', requestId: 'stress-scout', props: PANE })
  await pane.press({ key: 'pause' })
  expect(await pane.find({ text: /stress-scout · paused/ })).toBeDefined()
  expect(w.statuses.at(-1)).toMatch(/paused/)
  await pane.unmount()

  await toolCall($, { tool: 'Write', file_path: `${ROOT}/src/queue.ts`, content: 'x' })
  w.tree = TREE_B
  await clock.advance(10 * 60_000)
  await clock.settle()
  expect(w.triagePrompts).toHaveLength(0)
  expect(w.spawned).toHaveLength(0)

  const resumed = await $.command.run(stress('resume') as never)
  expect(resumed.text).toBe('Resumed.')
  const help = await $.command.run(stress('help') as never)
  expect(help.text).toContain('/stress apply [N]')
})

test('a focused /stress run skips triage and goes straight to the tester', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const started = await $.command.run(stress('the retry loop in api/client.ts') as never)
  expect(started.text).toContain('Stress-testing "the retry loop in api/client.ts"')
  await clock.settle()
  expect(w.triagePrompts).toHaveLength(0)
  expect(w.spawned).toHaveLength(1)
  expect(w.spawned[0]?.input).toContain('TARGET: the retry loop in api/client.ts')
})

test('the pane opens by itself when a session starts', { timeoutMs: 30_000 }, async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  expect(w.opened).toEqual(['stress-scout'])
})

test('a session with no surface attached does not try to place the pane', { timeoutMs: 30_000 }, async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  const w = world(on)
  w.surfaces = []
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: false })
  expect(w.opened).toEqual([])
})

test('/stress start runs a test, as /stress run does', { timeoutMs: 30_000 }, async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  world(on)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  const started = await $.command.run(stress('start') as never)
  expect(started.text).toContain('Stress-testing the latest change')
})

test('openPaneOnStart off leaves the pane to /stress show', { timeoutMs: 30_000, options: { openPaneOnStart: false } }, async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  expect(w.opened).toEqual([])
  await $.command.run(stress('show') as never)
  expect(w.opened).toEqual(['stress-scout'])
})

const PLAIN = "Your cache can lose saved items when many things write to it at once."
const PLAIN_FIX = 'Make the cache finish one write before it starts the next.'
const plainReport = (extra: Record<string, unknown>): string =>
  REPORT.replace(/\n```$/, '').replace('```json\n', '```json\n').replace(/\{.*\}/s, json => JSON.stringify({ ...JSON.parse(json), ...extra })) + '\n```'

for (const [name, surface] of [['terminal', 'terminal'], ['desktop', 'desktop']] as const) {
  test(`on ${name}, the band and the pane lead with the plain explanation, and fall back to the headline without one`, { timeoutMs: 30_000 }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_700_000_000_000 })
    const w = world(on)
    w.reports.push(plainReport({ plain: PLAIN, plainFix: PLAIN_FIX }))
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await toolCall($, { tool: 'Edit', file_path: `${ROOT}/src/cache.ts`, old_string: 'old', new_string: 'new' })
    w.tree = TREE_B
    await clock.advance(45_000)
    await clock.settle()

    const band = await $.ui.mount({ plugin: 'stress-scout', surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ text: PLAIN })).toBeDefined()
    expect(await band.find({ text: `Fix (tested): ${PLAIN_FIX}` })).toBeDefined()
    expect(await band.find({ text: /lost 1,214 of 10,000/ })).toBeUndefined()
    await band.unmount()

    const pane = await $.ui.mount({ plugin: 'stress-scout', surface, component: 'Pane', requestId: 'stress-scout', props: PANE })
    expect(await pane.find({ text: PLAIN })).toBeDefined()
    expect(await pane.find({ text: /lost 1,214 of 10,000/ })).toBeDefined()
    await pane.unmount()
  })

  test(`on ${name}, a finding without plain text shows the technical headline`, { timeoutMs: 30_000 }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_700_000_000_000 })
    const w = world(on)
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await toolCall($, { tool: 'Edit', file_path: `${ROOT}/src/cache.ts`, old_string: 'old', new_string: 'new' })
    w.tree = TREE_B
    await clock.advance(45_000)
    await clock.settle()

    const band = await $.ui.mount({ plugin: 'stress-scout', surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ text: /src\/cache.ts:LruCache.set: lost 1,214 of 10,000/ })).toBeDefined()
    expect(await band.find({ text: /verified fix: evict before the await/ })).toBeDefined()
    await band.unmount()
    const pane = await $.ui.mount({ plugin: 'stress-scout', surface, component: 'Pane', requestId: 'stress-scout', props: PANE })
    expect(await pane.find({ text: /lost 1,214 of 10,000/ })).toBeDefined()
    await pane.unmount()
  })
}

test('a newer unverified finding does not hold back an older verified fix', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await toolCall($, { tool: 'Edit', file_path: `${ROOT}/src/cache.ts`, old_string: 'old', new_string: 'new' })
  w.tree = TREE_B
  await clock.advance(45_000)
  await clock.settle()
  expect(w.spawned).toHaveLength(1)

  // the person starts a turn, which holds the hand-off; a focused run meanwhile finds something unverified
  await $.turn.start({ turnId: 't1' } as never)
  w.reports.push(REPORT.replace('"verified":true', '"verified":false').replace('evict before the await', 'unverified guess'))
  await $.command.run(stress('the retry loop in api/client.ts') as never)
  await clock.settle()
  expect(w.spawned).toHaveLength(2)
  await $.turn.complete({ turnId: 't1', answer: '' } as never)

  await clock.advance(30_000)
  await clock.settle()
  expect(w.submitted).toHaveLength(1)
  expect(w.submitted[0]?.text).toMatch(/^Apply stress-scout fix #1: evict before the await\n/)
})

/** A finished run's finding, waiting for a tap. */
async function foundOne($: Engine, on: On): Promise<{ w: World; clock: ReturnType<typeof mock.clock> }> {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await toolCall($, { tool: 'Edit', file_path: `${ROOT}/src/cache.ts`, old_string: 'old', new_string: 'new' })
  w.tree = TREE_B
  await clock.advance(45_000)
  await clock.settle()
  expect(w.spawned).toHaveLength(1)
  return { w, clock }
}

const handOver = async ($: Engine, clock: { settle(): Promise<unknown> }): Promise<void> => {
  await $.command.run(stress('apply 1') as never)
  await clock.settle()
}

test('a handoff from the same branch and files carries no warning, and spells out the rerun', { timeoutMs: 30_000, options: { autoApplyVerifiedFixes: false } }, async ($, on) => {
  const { w, clock } = await foundOne($, on)
  await handOver($, clock)
  const text = w.submitted.at(-1)?.text ?? ''
  expect(text.split('\n')[0]).toBe('Apply stress-scout fix #1: evict before the await')
  expect(text).not.toContain('Made against')
  expect(text).not.toContain('changed since the snapshot')
  expect(text).toMatch(/Rerun it with: cd \S+\/snapshot && timeout 120 node \.stress-scout\/race\.mjs/)
})

test('a handoff made from another branch or commit says where it was made', { timeoutMs: 30_000, options: { autoApplyVerifiedFixes: false } }, async ($, on) => {
  const { w, clock } = await foundOne($, on)
  w.project = { branch: 'feature-x', head: 'def5678' }
  await handOver($, clock)
  expect(w.submitted.at(-1)?.text.split('\n')[0]).toBe("Made against main@abc1234; you're on feature-x@def5678.")
})

test('a handoff names a patched file that changed in the project since the snapshot', { timeoutMs: 30_000, options: { autoApplyVerifiedFixes: false } }, async ($, on) => {
  const { w, clock } = await foundOne($, on)
  w.fileSha = '1'.repeat(40)
  await handOver($, clock)
  const text = w.submitted.at(-1)?.text ?? ''
  expect(text.split('\n')[0]).toBe('src/cache.ts has changed since the snapshot.')
  expect(text).not.toContain('Made against')
})

test('the pane says what the next automatic run waits on', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  const mount = () => $.ui.mount({ plugin: 'stress-scout', surface: 'desktop', component: 'Pane', requestId: 'stress-scout', props: PANE })

  let pane = await mount()
  expect(await pane.find({ text: /Next: tests the next risky edit, or sweeps untested code/ })).toBeDefined()
  await pane.unmount()

  await toolCall($, { tool: 'Edit', file_path: `${ROOT}/src/cache.ts`, old_string: 'old', new_string: 'new' })
  pane = await mount()
  expect(await pane.find({ text: /Next: scanning the change at \d\d:\d\d, once edits settle/ })).toBeDefined()
  await pane.unmount()

  w.tree = TREE_B
  await clock.advance(45_000)
  await clock.settle()
  expect(w.spawned).toHaveLength(1)

  // a second change inside the gap between runs names the time it will run
  await toolCall($, { tool: 'Edit', file_path: `${ROOT}/README.md`, old_string: 'a', new_string: 'b' })
  w.tree = TREE_C
  await clock.advance(45_000)
  await clock.settle()
  pane = await mount()
  expect(await pane.find({ text: /Next: next automatic run at \d\d:\d\d \(3-minute gap between runs\)/ })).toBeDefined()
  await pane.unmount()
  expect((await $.command.run(stress('status') as never)).text).toMatch(/Next: next automatic run at/)
})

test('with autoApplyVerifiedFixes off, a verified fix waits for a tap', { timeoutMs: 30_000, options: { autoApplyVerifiedFixes: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await toolCall($, { tool: 'Edit', file_path: `${ROOT}/src/cache.ts`, old_string: 'old', new_string: 'new' })
  w.tree = TREE_B
  await clock.advance(45_000)
  await clock.settle()
  expect(w.suggestions.at(-1)).toBe('Apply stress-scout fix #1: evict before the await')
  await clock.advance(5 * 60_000)
  await clock.settle()
  expect(w.submitted).toHaveLength(0)
})

test('by default, a verified fix goes to Claude once the session sits idle', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await toolCall($, { tool: 'Edit', file_path: `${ROOT}/src/cache.ts`, old_string: 'old', new_string: 'new' })
  w.tree = TREE_B
  await clock.advance(45_000)
  await clock.settle()
  expect(w.spawned).toHaveLength(1)
  expect(w.submitted).toHaveLength(0)

  await clock.advance(29_000)
  expect(w.submitted).toHaveLength(0)
  await clock.advance(1_000)
  await clock.settle()
  expect(w.submitted).toHaveLength(1)
  expect(w.submitted[0]?.text).toMatch(/^Apply stress-scout fix #1: evict before the await\n/)
  expect(w.toasts.at(-1)).toBe('stress-scout is handing verified fix #1 to Claude')
  expect((await $.command.run(stress('status') as never)).text).toContain('[applied]')

  // handed over once; later idle moments don't send it again
  await clock.advance(5 * 60_000)
  await clock.settle()
  expect(w.submitted).toHaveLength(1)
})

/** A verified fix waiting for a tap (autoApplyVerifiedFixes off). */
async function verifiedFix($: Parameters<NonNullable<Parameters<typeof test>[2]>>[0], on: On) {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await toolCall($, { tool: 'Edit', file_path: `${ROOT}/src/cache.ts`, old_string: 'old', new_string: 'new' })
  w.tree = TREE_B
  await clock.advance(45_000)
  await clock.settle()
  return { clock, w }
}

test('pressing Apply again while Claude is busy does not queue the prompt twice', { timeoutMs: 30_000, options: { autoApplyVerifiedFixes: false } }, async ($, on) => {
  const { clock, w } = await verifiedFix($, on)
  let release = () => {}
  w.submitGate = new Promise<void>(resolve => (release = resolve))

  const band = await $.ui.mount({ plugin: 'stress-scout', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'apply' })
  await clock.settle()
  expect(w.submitted).toHaveLength(1)
  // the submit is still pending: the finding is mid-handoff, so no button and no second copy
  expect(await band.find({ key: 'apply' })).toBeUndefined()
  await band.unmount()
  for (let i = 0; i < 3; i++) {
    const again = await $.command.run(stress('apply 1') as never)
    expect(again.text).toBe('Finding #1 is already being handed to Claude.')
  }
  await clock.settle()
  expect(w.submitted).toHaveLength(1)
  expect((await $.command.run(stress('status') as never)).text).toContain('[handing]')

  release()
  await clock.settle()
  expect(w.submitted).toHaveLength(1)
  expect((await $.command.run(stress('status') as never)).text).toContain('[applied]')
})

test('a finding left mid-handoff by a reload can be applied again', { timeoutMs: 30_000, options: { autoApplyVerifiedFixes: false } }, async ($, on) => {
  const { clock, w } = await verifiedFix($, on)
  w.submitGate = new Promise<void>(() => {})
  expect((await $.command.run(stress('apply 1') as never)).text).toBe('Handing finding #1 to Claude.')
  await clock.settle()
  expect((await $.command.run(stress('status') as never)).text).toContain('[handing]')

  // a reload runs session.start again; the old module's await never comes back
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect((await $.command.run(stress('status') as never)).text).not.toContain('[handing]')
  expect((await $.command.run(stress('apply 1') as never)).text).toBe('Handing finding #1 to Claude.')
})

test('a handoff that fails leaves the finding ready to apply again', { timeoutMs: 30_000, options: { autoApplyVerifiedFixes: false } }, async ($, on) => {
  const { clock, w } = await verifiedFix($, on)
  w.submitFailures.push('throw', 'drop')

  for (const attempt of [1, 2]) {
    const result = await $.command.run(stress('apply 1') as never)
    expect(result.text).toBe('Handing finding #1 to Claude.')
    await clock.settle()
    expect(w.submitted).toHaveLength(attempt)
    expect((await $.command.run(stress('status') as never)).text).not.toMatch(/\[(handing|applied)\]/)
  }

  expect((await $.command.run(stress('apply 1') as never)).text).toBe('Handing finding #1 to Claude.')
  await clock.settle()
  expect(w.submitted).toHaveLength(3)
  expect((await $.command.run(stress('status') as never)).text).toContain('[applied]')
})

/** The engine's types, where a plugin project keeps them. */
const TYPES = '.claude-plugin/types/claude-code/index.d.ts'
const RULE = "No test inputs the engine's types rule out: if a field is typed `string`, don't feed it a number, null or a missing value."

test('the tester is told to feed only inputs the types allow, and a plugin project points it at the engine types', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const w = world(on)
  on('fs.read', () => ({ value: 'declare module "claude-code" {}' }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run(stress('the retry loop in api/client.ts') as never)
  await clock.settle()
  const plain = w.spawned[0]?.input ?? ''
  expect(plain).toContain(RULE)
  expect(plain).toContain("Only feed inputs the code's own declared types and contracts allow.")
  expect(plain).not.toContain('PLUGIN:')

  // a Claude Code plugin: the manifest, a hooks module and the engine's types
  for (const path of [`${ROOT}/.claude-plugin/plugin.json`, `${ROOT}/hooks`, `${ROOT}/${TYPES}`]) w.existing.add(path)
  await $.command.run(stress('the prompt handler in hooks/register.tsx') as never)
  await clock.settle()
  const plugin = w.spawned[1]?.input ?? ''
  expect(plugin).toContain(RULE)
  expect(plugin).toMatch(/PLUGIN: .*\/snapshot\/\.claude-plugin\/types\/claude-code\/index\.d\.ts/)
  expect([...w.writes.keys()].some(path => path.endsWith(`/snapshot/${TYPES}`))).toBe(true)
})

test('a guard-targeted run must prove each bypass under real bash; other runs are not told to', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run(stress('checkBash in hooks/lib/policy.ts') as never)
  await clock.settle()
  const guard = w.spawned[0]?.input ?? ''
  expect(guard).toContain('GUARD METHOD')
  expect(guard).toContain("bash -c 'git(){ echo RAN; }; <case>'")

  await $.command.run(stress('the retry loop in api/client.ts') as never)
  await clock.settle()
  expect(w.spawned[1]?.input).not.toContain('GUARD METHOD')
})

describe('a landed fix is checked by rerunning the stored harness, with no new paid run', () => {
  for (const [exit, status] of [[0, 'fixed'], [1, 'regressed']] as const) {
    test(`exit ${exit}: the applied finding becomes ${status}`, { timeoutMs: 30_000 }, async ($, on) => {
      const clock = mock.clock(on, { now: 1_700_000_000_000 })
      const w = world(on)
      on('fs.read', () => ({ value: "the developer's fixed source" }))
      await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
      await toolCall($, { tool: 'Edit', file_path: `${ROOT}/src/cache.ts`, old_string: 'old', new_string: 'new' })
      w.tree = TREE_B
      await clock.advance(45_000)
      await clock.settle()
      await $.command.run(stress('apply 1') as never)
      await clock.settle()
      expect((await $.command.run(stress('status') as never)).text).toContain('[applied]')

      // the developer's session edits the file the finding targets
      const triaged = w.triagePrompts.length
      const spawned = w.spawned.length
      w.harnessExit = exit
      w.runs.length = 0
      await toolCall($, { tool: 'Edit', file_path: `${ROOT}/src/cache.ts`, old_string: 'new', new_string: 'newer' })
      await clock.settle()

      const harness = w.runs.filter(argv => argv[0] === 'sh' && argv[1] === '-c')
      expect(harness).toEqual([['sh', '-c', 'timeout 120 node .stress-scout/race.mjs']])
      const copied = [...w.writes.entries()].find(([path]) => path.endsWith('/snapshot/src/cache.ts'))
      expect(copied?.[1]).toBe("the developer's fixed source")
      // no model call, no tester
      expect(w.triagePrompts).toHaveLength(triaged)
      expect(w.spawned).toHaveLength(spawned)
      expect((await $.command.run(stress('status') as never)).text).toContain(`[${status}]`)

      // the pane shows it like any other status
      const pane = await $.ui.mount({ plugin: 'stress-scout', surface: 'desktop', component: 'Pane', requestId: 'stress-scout', props: PANE })
      expect(await pane.find({ text: new RegExp(`src/cache\\.ts:LruCache\\.set · concurrency · ${status}`) })).toBeDefined()
      await pane.unmount()
    })
  }
})

describe('the tester bills what the session bills', () => {
  const cases = [
    { name: 'on a plan login, a stray ANTHROPIC_API_KEY is blanked for it', credential: { handle: 'h', kind: 'bearer' as const }, key: '' },
    { name: 'on an API key, it keeps the key the session bills', credential: { handle: 'h', kind: 'api-key' as const }, key: undefined },
    { name: "where the engine won't say, a plan's usage window tells", credential: 'refused' as const, key: '' },
  ]
  for (const { name, credential, key } of cases) {
    test(name, { timeoutMs: 30_000 }, async ($, on) => {
      const clock = mock.clock(on, { now: 1_700_000_000_000 })
      const w = world(on)
      w.credential = credential
      w.rateLimits = [{ kind: 'five_hour', percentUsed: 12 }]
      await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
      await $.command.run(stress('the retry loop in api/client.ts') as never)
      await clock.settle()
      expect(w.spawned).toHaveLength(1)
      expect(w.spawned[0]?.env?.ANTHROPIC_API_KEY).toBe(key)
    })
  }
})

test('automatic runs wait while the weekly window is nearly used, whatever the 5-hour one says', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const w = world(on)
  w.rateLimits = [{ kind: 'five_hour', percentUsed: 12 }, { kind: 'seven_day', percentUsed: 85 }]
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await toolCall($, { tool: 'Write', file_path: `${ROOT}/src/queue.ts`, content: 'x' })
  w.tree = TREE_B
  await clock.advance(10 * 60_000)
  await clock.settle()
  expect(w.triagePrompts).toHaveLength(0)
  expect(w.spawned).toHaveLength(0)
  const pane = await $.ui.mount({ plugin: 'stress-scout', surface: 'desktop', component: 'Pane', requestId: 'stress-scout', props: PANE })
  expect(await pane.find({ text: /skipped, your weekly usage window is at or above 80%/ })).toBeDefined()
  await pane.unmount()

  // /stress still runs on request
  await $.command.run(stress('the retry loop in api/client.ts') as never)
  await clock.settle()
  expect(w.spawned).toHaveLength(1)
})

test('inside the tester process the mod is the guard alone', { timeoutMs: 30_000 }, async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  mock.env(on, {
    STRESS_SCOUT_ROLE: 'tester',
    STRESS_SCOUT_ROOTS: JSON.stringify([ROOT]),
    STRESS_SCOUT_RUN_DIRS: JSON.stringify([RUN]),
    STRESS_SCOUT_HOME: '/Users/dev',
  })
  on('fs.stat', ($, e) => ({ value: { kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false, realPath: posixOf(e.path) } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  let ran = 0
  on('tool.call', () => {
    ran += 1
    return { result: 'ok' } as never
  })
  await $.session.start({ cwd: `${RUN}/snapshot`, surface: null, isInteractive: false })

  const intoProject = await toolCall($, { tool: 'Write', file_path: `${ROOT}/src/a.ts`, content: 'x' })
  expect(JSON.stringify(intoProject)).toContain('stress-scout guard')
  const push = await toolCall($, { tool: 'Bash', command: 'git push origin main' })
  expect(JSON.stringify(push)).toContain('not on the tester allowlist')
  const secrets = await toolCall($, { tool: 'Read', file_path: '/Users/dev/.ssh/id_ed25519' })
  expect(JSON.stringify(secrets)).toContain('secrets')
  expect(ran).toBe(0)

  const harness = await toolCall($, { tool: 'Write', file_path: `${RUN}/snapshot/.stress-scout/h.py`, content: 'print(1)' })
  expect(JSON.stringify(harness)).not.toContain('stress-scout guard')
  const run = await toolCall($, { tool: 'Bash', command: 'timeout 120 python3 .stress-scout/h.py' })
  expect(JSON.stringify(run)).not.toContain('stress-scout guard')
  expect(ran).toBe(2)
})

test('a tree remembered from before the scratch folder was cleaned falls back to HEAD, so changes are still caught', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const w = world(on, { [`mem:${fnv(ROOT)}`]: { v: 1, lastTree: TREE_GONE, lastSweepAt: 0, nextId: 1, touchedAt: 0, tested: {}, dismissed: {} } })
  w.missingTrees.add(TREE_GONE)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await toolCall($, { tool: 'Edit', file_path: `${ROOT}/src/cache.ts`, old_string: 'old', new_string: 'new' })
  w.tree = TREE_B
  await clock.advance(45_000)
  await clock.settle()
  expect(w.triagePrompts).toHaveLength(1)
  expect(w.spawned).toHaveLength(1)
})

test('on Windows, snapshots link dependencies as junctions, the tester gets Git Bash paths, and no Unix tool runs', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const w = world(on, {}, WINDOWS)
  w.existing.add(`${WIN_ROOT}/node_modules`)
  await $.session.start({ cwd: WIN_ROOT, surface: 'terminal', isInteractive: true })
  expect(w.statuses.at(-1)).toMatch(/watching/)
  await toolCall($, { tool: 'Edit', file_path: `${WIN_ROOT}\\src\\cache.ts`, old_string: 'old', new_string: 'new' })
  w.tree = TREE_B
  await clock.advance(45_000)
  await clock.settle()

  // scratch lives under TEMP, not the Git Bash TMPDIR, and the tester's temp folders point into its run
  expect(w.spawned).toHaveLength(1)
  const tester = w.spawned[0]
  // (the kit runs on Linux, where `C:\\...` is relative, so it prefixes its own folder: match the end)
  expect(slashed(tester?.cwd ?? '')).toMatch(/C:\/Users\/dev\/AppData\/Local\/Temp\/stress-scout\/proj-[0-9a-f]{8}\/runs\/run-0001-\d+\/snapshot$/)
  expect(tester?.env?.TEMP).toMatch(/^C:\/Users\/dev\/AppData\/Local\/Temp\/stress-scout\/proj-[0-9a-f]{8}\/runs\/run-0001-\d+\/tmp$/)
  expect(tester?.env?.TMP).toBe(tester?.env?.TEMP)
  expect(tester?.env?.TMPDIR).toBe(tester?.env?.TEMP)
  expect(JSON.parse(tester?.env?.STRESS_SCOUT_ROOTS ?? '[]')).toEqual([WIN_ROOT])
  expect(tester?.env?.STRESS_SCOUT_HOME).toBe('C:\\Users\\dev')
  expect(tester?.input).toContain('PLATFORM: Windows')
  expect(tester?.input).toContain('REAL PROJECT (off-limits; never touch or name it): C:/work/proj')
  expect(tester?.input).toContain('- Linked from the real project')

  // git checks the snapshot out itself; node_modules is a junction made through PowerShell
  expect(w.runs.some(argv => argv.includes('checkout-index'))).toBe(true)
  const scripts = w.runs.filter(argv => argv[0] === 'powershell.exe').map(argv => decodePowerShell(argv.at(-1) ?? ''))
  const junction = scripts.find(script => script.includes('New-Item -ItemType Junction'))
  expect(junction).toContain("-Target 'C:\\work\\proj\\node_modules'")
  expect(junction).toContain('\\snapshot\\node_modules')
  expect(w.runs.some(argv => ['rm', 'ln', 'tar'].includes(argv[0] ?? ''))).toBe(false)
  expect(w.toasts.at(-1)).toMatch(/^stress-scout #1 broke/)
})

test('inside a Windows tester process the guard reads Windows and Git Bash paths', { timeoutMs: 30_000 }, async ($, on) => {
  const run = 'C:\\Users\\dev\\AppData\\Local\\Temp\\stress-scout\\proj-1234abcd\\runs\\run-0001-1700000000000'
  mock.clock(on, { now: 1_700_000_000_000 })
  mock.env(on, {
    STRESS_SCOUT_ROLE: 'tester',
    STRESS_SCOUT_ROOTS: JSON.stringify([WIN_ROOT]),
    STRESS_SCOUT_RUN_DIRS: JSON.stringify([run]),
    STRESS_SCOUT_HOME: 'C:\\Users\\dev',
  })
  on('fs.stat', ($, e) => ({ value: { kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false, realPath: fromDrive(e.path) } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  let ran = 0
  on('tool.call', () => {
    ran += 1
    return { result: 'ok' } as never
  })
  await $.session.start({ cwd: `${run}\\snapshot`, surface: null, isInteractive: false })

  const intoProject = await toolCall($, { tool: 'Write', file_path: 'C:\\work\\proj\\src\\a.ts', content: 'x' })
  expect(JSON.stringify(intoProject)).toContain('stress-scout guard')
  const throughBash = await toolCall($, { tool: 'Bash', command: 'rm -rf /c/work/proj/src' })
  expect(JSON.stringify(throughBash)).toContain('read-only for the tester')
  const secrets = await toolCall($, { tool: 'Read', file_path: 'C:\\Users\\dev\\.ssh\\id_ed25519' })
  expect(JSON.stringify(secrets)).toContain('secrets')
  const stream = await toolCall($, { tool: 'Write', file_path: `${run}\\snapshot\\notes.txt:hidden`, content: 'x' })
  expect(JSON.stringify(stream)).toContain('could not resolve')
  expect(ran).toBe(0)

  const harness = await toolCall($, { tool: 'Write', file_path: `${run}\\snapshot\\.stress-scout\\h.py`, content: 'print(1)' })
  expect(JSON.stringify(harness)).not.toContain('stress-scout guard')
  const forward = await toolCall($, { tool: 'Write', file_path: `${run.replace(/\\\\/g, '/')}/snapshot/.stress-scout/g.py`, content: 'print(2)' })
  expect(JSON.stringify(forward)).not.toContain('stress-scout guard')
  const runIt = await toolCall($, { tool: 'Bash', command: 'timeout 120 python .stress-scout/h.py' })
  expect(JSON.stringify(runIt)).not.toContain('stress-scout guard')
  expect(ran).toBe(3)
})

test('a bare /stress and a prompt with empty text pass through', { timeoutMs: 30_000 }, async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  // the engine sends args as "" when nothing follows the name, and an image-only prompt as text ""
  const bare = await $.command.run(stress('') as never)
  expect(bare.text).toContain('Stress-testing the latest change')
  const count = w.submitted.length
  await $.prompt.submit({ text: '', wait: false, origin: { kind: 'composer' } })
  expect(w.submitted).toHaveLength(count + 1)
  expect(w.submitted.at(-1)?.context ?? []).toHaveLength(0)
})

/** A risky edit, a quiet spell and a tester run in a world of the given kernel; the pane's text and the tester's env. */
async function runOffline($: Parameters<NonNullable<Parameters<typeof test>[2]>>[0], on: On, kernel: string, hasOffline: boolean, place: Place = POSIX) {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const w = world(on, {}, place)
  w.kernel = kernel
  w.hasOffline = hasOffline
  await $.session.start({ cwd: place.root, surface: 'terminal', isInteractive: true })
  await toolCall($, { tool: 'Edit', file_path: `${place.root}/src/cache.ts`, old_string: 'old', new_string: 'new' })
  w.tree = TREE_B
  await clock.advance(45_000)
  await clock.settle()
  expect(w.spawned).toHaveLength(1)
  const pane = await $.ui.mount({ plugin: 'stress-scout', surface: 'desktop', component: 'Pane', requestId: 'stress-scout', props: PANE })
  return { w, pane, mode: w.spawned[0]?.env?.STRESS_SCOUT_OFFLINE }
}

describe('the tester runs its commands without network', () => {
  test('macOS wraps them in sandbox-exec', { timeoutMs: 30_000 }, async ($, on) => {
    const { pane, mode } = await runOffline($, on, 'Darwin', true)
    expect(mode).toBe('sandbox-exec')
    expect(await pane.find({ text: /network: off \(sandbox-exec\)/ })).toBeDefined()
  })

  test('Linux wraps them in unshare', { timeoutMs: 30_000 }, async ($, on) => {
    const { pane, mode } = await runOffline($, on, 'Linux', true)
    expect(mode).toBe('unshare')
    expect(await pane.find({ text: /network: off \(unshare\)/ })).toBeDefined()
  })

  test('a failed probe leaves the guard alone', { timeoutMs: 30_000 }, async ($, on) => {
    const { pane, mode } = await runOffline($, on, 'Darwin', false)
    expect(mode).toBe('')
    expect(await pane.find({ text: /network: guard only/ })).toBeDefined()
  })

  test('on Windows nothing is probed', { timeoutMs: 30_000 }, async ($, on) => {
    const { w, pane, mode } = await runOffline($, on, 'Linux', true, WINDOWS)
    expect(mode).toBe('')
    expect(w.runs.some(argv => ['uname', 'sandbox-exec', 'unshare'].includes(argv[0] ?? ''))).toBe(false)
    expect(await pane.find({ text: /network: guard only/ })).toBeDefined()
  })

  test('testerOffline off probes nothing', { timeoutMs: 30_000, options: { testerOffline: false } }, async ($, on) => {
    const { w, mode } = await runOffline($, on, 'Darwin', true)
    expect(mode).toBe('')
    expect(w.runs.some(argv => argv[0] === 'sandbox-exec')).toBe(false)
  })

  /** A tester process told to cut commands off by `how`: the Bash commands that reach the tool, for one the guard passes and one it refuses. */
  async function testerBash($: Parameters<NonNullable<Parameters<typeof test>[2]>>[0], on: On, how: string, command: string): Promise<string[]> {
    const run = '/tmp/stress-scout/proj-1234abcd/runs/run-0001-1700000000000'
    mock.clock(on, { now: 1_700_000_000_000 })
    mock.env(on, {
      STRESS_SCOUT_ROLE: 'tester',
      STRESS_SCOUT_ROOTS: JSON.stringify([ROOT]),
      STRESS_SCOUT_RUN_DIRS: JSON.stringify([run]),
      STRESS_SCOUT_HOME: '/Users/dev',
      STRESS_SCOUT_OFFLINE: how,
    })
    on('fs.stat', ($, e) => ({ value: { kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    const seen: string[] = []
    on('tool.call', ($, e) => {
      seen.push(String((e as unknown as { command?: unknown }).command))
      return { result: 'ok' } as never
    })
    await $.session.start({ cwd: `${run}/snapshot`, surface: null, isInteractive: false })
    await toolCall($, { tool: 'Bash', command })
    await toolCall($, { tool: 'Bash', command: 'rm -rf /work/proj/src' })
    return seen
  }

  const QUOTED = "timeout 120 node -e 'console.log(1)'"
  // the same command as one single-quoted word: each inner ' closes the quote, escapes itself and reopens it
  const WRAPPED = "'timeout 120 node -e '\\''console.log(1)'\\'''"

  test('inside the tester, sandbox-exec wraps a Bash call the guard passed, and a refused one never runs', { timeoutMs: 30_000 }, async ($, on) => {
    const seen = await testerBash($, on, 'sandbox-exec', QUOTED)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/^sandbox-exec -p '\(version 1\)\(allow default\)\(deny network-outbound\)/)
    expect(seen[0]?.endsWith(` /bin/bash -c ${WRAPPED}`)).toBe(true)
  })

  test('inside the tester, unshare wraps a Bash call', { timeoutMs: 30_000 }, async ($, on) => {
    expect(await testerBash($, on, 'unshare', QUOTED)).toEqual([`unshare -rn bash -c ${WRAPPED}`])
  })

  test('inside the tester with no offline mode, the command is unchanged', { timeoutMs: 30_000 }, async ($, on) => {
    expect(await testerBash($, on, '', QUOTED)).toEqual([QUOTED])
  })
})

/** REPORT for another file and kind. */
const reportFor = (file: string, kind = 'concurrency'): string =>
  REPORT.replace('src/cache.ts:LruCache.set', `${file}:run`).replace('"kind":"concurrency"', `"kind":"${kind}"`)

/** One focused /stress run, to its finding. */
async function findOne($: { command: { run: (c: never) => Promise<unknown> } }, clock: { settle: () => Promise<void> }, focus: string): Promise<void> {
  await $.command.run(stress(focus) as never)
  await clock.settle()
}

test('/stress apply with no number hands over the newest finding that has a fix, and says so when none does', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect((await $.command.run(stress('apply') as never)).text).toBe('No finding is waiting to be applied.')

  // #3 held, with no fix and no next step, is not actionable; the newest one that is, is #2
  const held = reportFor('src/held.ts')
    .replace('"verdict":"broke"', '"verdict":"held"')
    .replace('"nextStep":"apply the patch and rerun the harness"', '"nextStep":""')
    .replace(/"fix":\{[^}]*\},/, '')
  w.reports.push(REPORT, reportFor('src/queue.ts'), held)
  await findOne($, clock, 'first thing')
  await findOne($, clock, 'second thing')
  await findOne($, clock, 'third thing')

  w.isInCommand = true
  const applied = await $.command.run(stress('apply') as never)
  w.isInCommand = false
  expect(applied.text).toBe('Handing finding #2 to Claude.')
  await clock.settle()
  expect(w.submitted.at(-1)?.text).toMatch(/^Apply stress-scout fix #2:/)

  // #2 is applied now, so the next bare apply goes back to #1
  expect((await $.command.run(stress('apply') as never)).text).toBe('Handing finding #1 to Claude.')
  await clock.settle()
  expect((await $.command.run(stress('apply') as never)).text).toBe('No finding is waiting to be applied.')
  expect((await $.command.run(stress('help') as never)).text).toContain('/stress apply [N]')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the band shows the run's cost and what is left of its budget (${surface})`, { timeoutMs: 30_000, options: { maxDollarsPerRun: 2 } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_700_000_000_000 })
    world(on)
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await findOne($, clock, 'the cache')
    const ui = await $.ui.mount({ plugin: 'stress-scout', surface, component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ text: /\$0\.42 · \$1\.58 left of \$2 per run · 0\/8 runs/ })).toBeDefined()
    await ui.unmount()
  })

  test(`the pane groups findings under their file, newest group first (${surface})`, { timeoutMs: 30_000 }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_700_000_000_000 })
    const w = world(on)
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    w.reports.push(REPORT, reportFor('src/queue.ts'), reportFor('src/cache.ts', 'edge'))
    await findOne($, clock, 'one')
    await findOne($, clock, 'two')
    await findOne($, clock, 'three')
    const pane = await $.ui.mount({ plugin: 'stress-scout', surface, component: 'Pane', requestId: 'stress-scout', props: PANE })
    const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text)
    const headers = texts.filter(t => /^src\/(cache|queue)\.ts$/.test(t))
    // #3 and #1 share the cache.ts group, newest first; #2 is alone under queue.ts
    expect(headers).toEqual(['src/cache.ts', 'src/queue.ts'])
    expect(texts.filter(t => /^#\d broke$/.test(t))).toEqual(['#3 broke', '#1 broke', '#2 broke'])
    const cards = (await pane.findAll({ type: 'Box' })).filter(b => b.props.borderStyle === 'round')
    expect(cards).toHaveLength(surface === 'terminal' ? 0 : 3)
    await pane.unmount()
  })

  test(`dismissing all of a kind in a file drops later findings of it until the file changes (${surface})`, { timeoutMs: 30_000 }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_700_000_000_000 })
    const w = world(on)
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    w.reports.push(REPORT, reportFor('src/cache.ts'))
    await findOne($, clock, 'one')
    await findOne($, clock, 'two')

    const pane = await $.ui.mount({ plugin: 'stress-scout', surface, component: 'Pane', requestId: 'stress-scout', props: PANE })
    expect(await pane.findAll({ key: 'dismiss-all-2' })).toHaveLength(0)
    await pane.press({ key: 'open-2' })
    expect(await pane.find({ text: 'Dismiss all concurrency in src/cache.ts' })).toBeDefined()
    await pane.press({ key: 'dismiss-all-2' })
    await pane.unmount()
    const status = (await $.command.run(stress('status') as never)).text
    expect(status).toMatch(/#2 broke src\/cache\.ts:run: .*\[dismissed\]/)
    expect(status).toMatch(/#1 broke src\/cache\.ts:LruCache\.set: .*\[dismissed\]/)

    // an automatic run on the same file and kind is dropped
    await toolCall($, { tool: 'Edit', file_path: `${ROOT}/src/cache.ts`, old_string: 'old', new_string: 'new' })
    w.tree = TREE_B
    await clock.advance(4 * 60_000)
    await clock.settle()
    expect(w.triagePrompts.length).toBeGreaterThan(0)
    expect(w.spawned).toHaveLength(2)

    // once the file's content changes it is raised again
    await toolCall($, { tool: 'Edit', file_path: `${ROOT}/src/cache.ts`, old_string: 'new', new_string: 'newer' })
    w.tree = TREE_C
    w.blob = '1'.repeat(40)
    await clock.advance(5 * 60_000)
    await clock.settle()
    expect(w.spawned).toHaveLength(3)

    // /stress dismiss N all does the same
    expect((await $.command.run(stress('dismiss 3 all') as never)).text).toContain('Dismissed every concurrency finding in src/cache.ts')
    expect((await $.command.run(stress('help') as never)).text).toContain('/stress dismiss N all')
  })
}

test('the status line says when the rate-limit threshold has paused automatic runs, and when they resume', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const cases = [
    { limits: [{ kind: 'five_hour', percentUsed: 82 }], text: 'stress-scout paused: 5h usage 82%' },
    { limits: [{ kind: 'five_hour', percentUsed: 12 }, { kind: 'seven_day', percentUsed: 91 }], text: 'stress-scout paused: weekly usage 91%' },
    { limits: [{ kind: 'spend_limit', percentUsed: 95 }], text: 'stress-scout paused: spend limit 95%' },
  ]
  let n = 0
  for (const { limits, text } of cases) {
    w.rateLimits = limits
    await toolCall($, { tool: 'Write', file_path: `${ROOT}/src/queue${n}.ts`, content: 'x' })
    n += 1
    w.tree = String(n).repeat(40)
    await clock.advance(10 * 60_000)
    await clock.settle()
    expect(w.statuses.at(-1)).toBe(text)
  }
  expect(w.spawned).toHaveLength(0)

  w.rateLimits = [{ kind: 'five_hour', percentUsed: 12 }]
  await toolCall($, { tool: 'Write', file_path: `${ROOT}/src/queue9.ts`, content: 'x' })
  w.tree = '8'.repeat(40)
  await clock.advance(10 * 60_000)
  await clock.settle()
  expect(w.statuses.at(-1)).not.toMatch(/paused/)
})

/** One edit that moves the tree to `tree`, then the quiet period: whatever it triaged has run. */
async function editAndSettle($: Parameters<typeof toolCall>[0],clock: ReturnType<typeof mock.clock>, w: World, tree: string): Promise<void> {
  await toolCall($, { tool: 'Edit', file_path: `${ROOT}/src/cache.ts`, old_string: 'old', new_string: 'new' })
  w.tree = tree
  await clock.advance(5 * 60_000)
  await clock.settle()
}

const TRIAGE_KEY = `triage:${fnv(ROOT)}`
const MEMORY_KEY = `mem:${fnv(ROOT)}`
const WEEK = 7 * 24 * 3_600_000
const cacheOf = (w: World): Record<string, unknown> => (w.store.get(TRIAGE_KEY) ?? {}) as Record<string, unknown>

test('triage: the same change is judged once, in this session and in a later one with the same stored data', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await editAndSettle($, clock, w, TREE_B)
  expect(w.triagePrompts).toHaveLength(1)
  expect(Object.keys(cacheOf(w))).toHaveLength(1)

  // a different change is a new question
  await editAndSettle($, clock, w, TREE_C)
  expect(w.triagePrompts).toHaveLength(2)
  expect(Object.keys(cacheOf(w))).toHaveLength(2)

  // a later session remembers nothing of what it scanned or tested, only the stored verdicts, and meets the first change again
  w.store.delete(MEMORY_KEY)
  await editAndSettle($, clock, w, TREE_B)
  expect(w.triagePrompts).toHaveLength(2)
})

test('triage: a verdict older than a week is asked again', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await editAndSettle($, clock, w, TREE_B)
  expect(w.triagePrompts).toHaveLength(1)

  // while fresh, the verdict is reused by a session that remembers nothing else
  w.store.delete(MEMORY_KEY)
  await editAndSettle($, clock, w, TREE_A)
  await editAndSettle($, clock, w, TREE_B)
  expect(w.triagePrompts).toHaveLength(2)

  // the stored verdict is now a week and a day old, and the session remembers nothing else
  const aged = Object.fromEntries(Object.entries(cacheOf(w)).map(([key, entry]) => [key, { ...(entry as object), at: 1_700_000_000_000 - WEEK - 24 * 3_600_000 }]))
  w.store.set(TRIAGE_KEY, aged)
  w.store.delete(MEMORY_KEY)
  await editAndSettle($, clock, w, TREE_A)
  await editAndSettle($, clock, w, TREE_B)
  expect(w.triagePrompts).toHaveLength(4)
})

test('triage: the cache keeps the newest 200 verdicts and drops the aged ones', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const plan = { isWorth: true, risk: 'high', target: 't', files: [], kind: 'edge', why: '', attack: '', skip: '' }
  const full: Record<string, unknown> = { aged: { at: 1_700_000_000_000 - WEEK - 1, plan } }
  for (let i = 0; i < 200; i++) full[`old${i}`] = { at: 1_700_000_000_000 - 1000 + i, plan }
  const w = world(on, { [TRIAGE_KEY]: full })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await editAndSettle($, clock, w, TREE_B)
  expect(w.triagePrompts).toHaveLength(1)
  const kept = Object.keys(cacheOf(w))
  expect(kept).toHaveLength(200)
  expect(kept).not.toContain('old0')
  expect(kept).not.toContain('aged')
})

test('an idle sweep waits until sweepMinutes after the last run of any kind', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const memory = { v: 1, lastTree: TREE_A, lastSweepAt: 0, nextId: 1, touchedAt: 0, tested: {}, dismissed: {} }
  const w = world(on, { [MEMORY_KEY]: memory })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  // a manual test runs and finishes; the session then sits idle
  await $.command.run(stress('the retry loop in api/client.ts') as never)
  await clock.settle()
  expect(w.spawned).toHaveLength(1)
  await clock.advance(19 * 60_000)
  await clock.settle()
  expect(w.triagePrompts).toHaveLength(0)
  expect(w.spawned).toHaveLength(1)

  // the gap has passed since that run finished: the sweep goes ahead
  await clock.advance(2 * 60_000)
  await clock.settle()
  expect(w.triagePrompts).toHaveLength(1)
  expect(w.triagePrompts[0]).toContain('idle sweep')
  expect(w.spawned).toHaveLength(2)
})
