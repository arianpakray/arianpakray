import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ROOT = '/work/proj'
const TREE_A = 'a'.repeat(40)
const TREE_B = 'b'.repeat(40)
const TREE_C = 'f'.repeat(40)
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
}

const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const line = (event: unknown) => `${JSON.stringify(event)}\n`

/** The machine beneath the plugin: git, files, models and the tester process, all from memory. */
function world(on: On): World {
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
  }
  mock.store(on)
  mock.env(on, { HOME: '/Users/dev', TMPDIR: '/tmp', CLAUDE_CODE_EXECPATH: '/opt/claude/bin/claude' })
  on('session.root', () => ({ value: ROOT }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'make the LRU cache safe under concurrent writers', toolUses: [] }] }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [] } }) as never)
  on('fs.write', ($, e) => {
    w.writes.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: w.writes.has(e.path) }))
  on('fs.stat', ($, e) => ({ value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', ($, e) => {
    const argv = e.argv.join(' ')
    const index = e.init?.env?.GIT_INDEX_FILE ?? ''
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
    yield { stream: 'stdout' as const, text: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: REPORT, total_cost_usd: 0.42, usage: USAGE }) }
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
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
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

  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/cache.ts`, old_string: 'old', new_string: 'new' } as never)
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
  expect(tester?.cwd).toMatch(/^\/tmp\/stress-scout\/proj-[0-9a-f]{8}\/runs\/run-0001-\d+\/snapshot$/)
  expect(flag('--add-dir')).toBe(tester?.cwd?.replace(/\/snapshot$/, ''))
  expect(tester?.env?.STRESS_SCOUT_ROLE).toBe('tester')
  expect(JSON.parse(tester?.env?.STRESS_SCOUT_ROOTS ?? '[]')).toEqual([ROOT])
  expect(tester?.input).toContain('TARGET: src/cache.ts:LruCache.set')
  expect(tester?.input).toContain('REAL PROJECT (off-limits; never touch or name it): /work/proj')

  // the report came back: toast, suggestion, the patch read back from the snapshot by git
  expect(w.toasts.at(-1)).toMatch(/^stress-scout #1 broke: lost 1,214/)
  expect(w.suggestions.at(-1)).toBe('Apply stress-scout fix #1: evict before the await')
  const patchFile = [...w.writes.keys()].find(path => path.endsWith('/fix.patch'))
  expect(w.writes.get(patchFile ?? '')).toContain('+new')
  expect(w.statuses.at(-1)).toMatch(/watching · 1\/8 runs/)
  const status = await $.command.run(stress('status') as never)
  expect(status.text).toContain('$0.42')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'stress-scout', surface, component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ text: /stress-scout #1 broke/ })).toBeDefined()
    expect(await ui.find({ key: 'apply' })).toBeDefined()
    expect(await ui.find({ text: /verified fix: evict before the await/ })).toBeDefined()
    await ui.unmount()
  }

  // one press hands it over in full; the band then steps aside
  const band = await $.ui.mount({ plugin: 'stress-scout', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'apply' })
  await clock.settle()
  const handed = w.submitted.at(-1)
  expect(handed?.text).toMatch(/^Apply stress-scout fix #1: evict before the await\n/)
  expect(handed?.text).toContain('```diff')
  expect(handed?.text).toContain('Before the fix: 1,214/10,000 lost')
  expect(handed?.text).toContain('/fix.patch')
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
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/cache.ts`, old_string: 'old', new_string: 'new' } as never)
  w.tree = TREE_B
  await clock.advance(45_000)
  await clock.settle()
  expect(w.spawned).toHaveLength(1)

  // another edit elsewhere; the triage picks the same, unchanged file again
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/README.md`, old_string: 'a', new_string: 'b' } as never)
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

  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/queue.ts`, content: 'x' } as never)
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

test('inside the tester process the mod is the guard alone', { timeoutMs: 30_000 }, async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  mock.env(on, {
    STRESS_SCOUT_ROLE: 'tester',
    STRESS_SCOUT_ROOTS: JSON.stringify([ROOT]),
    STRESS_SCOUT_RUN_DIRS: JSON.stringify([RUN]),
    STRESS_SCOUT_HOME: '/Users/dev',
  })
  on('fs.stat', ($, e) => ({ value: { kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  let ran = 0
  on('tool.call', () => {
    ran += 1
    return { result: 'ok' } as never
  })
  await $.session.start({ cwd: `${RUN}/snapshot`, surface: null, isInteractive: false })

  const intoProject = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/a.ts`, content: 'x' } as never)
  expect(JSON.stringify(intoProject)).toContain('stress-scout guard')
  const push = await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as never)
  expect(JSON.stringify(push)).toContain('git push is not allowed')
  const secrets = await $.tool.call({ tool: 'Read', file_path: '/Users/dev/.ssh/id_ed25519' } as never)
  expect(JSON.stringify(secrets)).toContain('secrets')
  expect(ran).toBe(0)

  const harness = await $.tool.call({ tool: 'Write', file_path: `${RUN}/snapshot/.stress-scout/h.py`, content: 'print(1)' } as never)
  expect(JSON.stringify(harness)).not.toContain('stress-scout guard')
  const run = await $.tool.call({ tool: 'Bash', command: 'timeout 120 python3 .stress-scout/h.py' } as never)
  expect(JSON.stringify(run)).not.toContain('stress-scout guard')
  expect(ran).toBe(2)
})
