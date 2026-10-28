import { describe, expect, mock, test } from 'claude-code/testing'
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
  }
  mock.store(on, stored)
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
    const argv = e.argv.join(' ')
    const index = e.init?.env?.GIT_INDEX_FILE ?? ''
    if (e.argv.some(arg => w.missingTrees.has(arg.replace('^{tree}', '')))) {
      return { value: { exitCode: 128, stdout: '', stderr: 'fatal: bad object', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (argv.includes('rev-parse --path-format')) return ok(`${ROOT}/.git\n`)
    if (argv.includes('rev-parse --verify')) return ok(`${HEAD}\n`)
    if (argv.endsWith('write-tree')) return ok(`${index.endsWith('snapshot.index') ? AFTER : w.tree}\n`)
    if (argv.includes('--name-only')) return ok('src/cache.ts\n')
    if (argv.includes('--stat')) return ok(' src/cache.ts | 4 ++--\n')
    if (e.argv.includes('--diff-filter=MRD')) return ok(PATCH)
    if (e.argv.includes('--diff-filter=A')) return ok('')
    if (e.argv.includes('diff')) return ok('@@ -1 +1 @@\n-old\n+new\n')
    if (e.argv.includes('ls-tree')) return ok(`100644 blob ${BLOB}     900\tsrc/cache.ts\n`)
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
  on('prompt.submit', ($, e) => {
    if (w.isInCommand) throw new Error('prompt.submit: called from a command.run hook, it would wait on the turn this hook is holding')
    w.submitted.push({ text: e.text, context: e.context ?? [] })
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

  // /stress apply answers first: its hook holds the turn the handoff would wait on
  const count = w.submitted.length
  w.isInCommand = true
  const applied = await $.command.run(stress('apply 1') as never)
  w.isInCommand = false
  expect(applied.text).toBe('Handing finding #1 to Claude.')
  expect(w.submitted).toHaveLength(count)
  await clock.settle()
  expect(w.submitted).toHaveLength(count + 1)
  expect(w.submitted.at(-1)?.text).toMatch(/^Apply stress-scout fix #1: evict before the await\n/)
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
  expect(help.text).toContain('/stress apply N')
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
  expect(JSON.stringify(push)).toContain('git push is not allowed')
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
