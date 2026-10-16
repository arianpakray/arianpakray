/**
 * stress-scout. One module, two roles:
 *
 * - scout (your session): watches the working tree, triages what changed with
 *   a cheap model, snapshots the code and runs a tester on it, then shows what
 *   it found and hands a verified fix to Claude on request.
 * - tester (a headless `claude -p` the scout starts in the snapshot, marked by
 *   STRESS_SCOUT_ROLE=tester): the sandbox guard alone, approving or refusing
 *   each of the tester's tool calls.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, PluginOptions, Register, Timer } from 'claude-code'

import type { Finding, Phase, Run, Trigger, Verdict } from '../types'
import { checkBash, checkRead, checkWrite, type Check, type Sandbox } from './lib/policy'
import {
  HANDOFF,
  HANDOFF_DETAILS,
  TESTER_SYSTEM,
  TRIAGE_SYSTEM,
  changeTriagePrompt,
  emptyMemory,
  handoffContext,
  handoffMessage,
  handoffPrompt,
  sweepTriagePrompt,
  testerTask,
  type Memory,
} from './lib/prompts'
import { rankCandidates } from './lib/rank'
import { isActionable, parseReport, parseStreamLine, parseTriage, type TesterResult, type Triage } from './lib/report'
import {
  blobsOf,
  changedPaths,
  churn,
  diffStat,
  diffText,
  fingerprint,
  headTree,
  listTree,
  makeSnapshot,
  openShadow,
  patchOf,
  resetShadow,
  type Shadow,
} from './lib/shadow'
import { ago, basename, clip, clockTime, compactTokens, fnv, isInside, oneLine, slug, trimSlash } from './lib/util'

type $ = EngineInterface

const PANE = 'stress-scout'
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const TESTER_TOOLS = 'Bash,Read,Write,Edit'
const KEEP_RUNS = 8
const NO_CHANGE = 'no change since the last scan'

const phaseAtom = atom({ plugin: 'stress-scout', key: 'phase' } as const, { kind: 'idle', detail: '', since: 0 })
const findingsAtom = atom({ plugin: 'stress-scout', key: 'findings' } as const, [])
const activityAtom = atom({ plugin: 'stress-scout', key: 'activity' } as const, [])
const runAtom = atom({ plugin: 'stress-scout', key: 'run' } as const, null)
const runsUsedAtom = atom({ plugin: 'stress-scout', key: 'runsUsed' } as const, 0)
const sweepsUsedAtom = atom({ plugin: 'stress-scout', key: 'sweepsUsed' } as const, 0)
const tokensAtom = atom({ plugin: 'stress-scout', key: 'tokensUsed' } as const, 0)
const dollarsAtom = atom({ plugin: 'stress-scout', key: 'dollarsUsed' } as const, 0)
const pausedAtom = atom({ plugin: 'stress-scout', key: 'paused' } as const, false)
const seenAtom = atom({ plugin: 'stress-scout', key: 'seenId' } as const, 0)
const openAtom = atom({ plugin: 'stress-scout', key: 'openId' } as const, 0)
const suggestedAtom = atom({ plugin: 'stress-scout', key: 'suggestedId' } as const, 0)

type Config = {
  triageModel: string
  testerModel: string
  maxRuns: number
  maxSweeps: number
  minGapMs: number
  quietMs: number
  maxWaitMs: number
  idleMs: number
  isSweeping: boolean
  sweepGapMs: number
  maxDollarsPerRun: number
  claudePath: string
  rateLimitPct: number
  testerTimeoutMs: number
}

type Ctx = {
  root: string
  home: string
  scratch: string
  shadow: Shadow
  projectKey: string
  rootSpellings: string[]
  scratchSpellings: string[]
}

type Plan = { plan: Triage; tokens: number; base: string }

type Outcome = { answer: string; cost: number; tokens: number; failure: string; steps: number }

const numberOf = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

export function configOf(options: PluginOptions): Config {
  return {
    triageModel: typeof options.triageModel === 'string' ? options.triageModel : 'haiku',
    testerModel: typeof options.testerModel === 'string' ? options.testerModel : 'sonnet',
    maxRuns: numberOf(options.maxRunsPerSession, 8, 0, 200),
    maxSweeps: numberOf(options.maxSweepsPerSession, 3, 0, 200),
    minGapMs: numberOf(options.minMinutesBetweenRuns, 3, 0, 240) * 60_000,
    quietMs: numberOf(options.quietSeconds, 45, 1, 3600) * 1000,
    maxWaitMs: numberOf(options.maxWaitSeconds, 240, 10, 7200) * 1000,
    idleMs: numberOf(options.idleSeconds, 30, 1, 3600) * 1000,
    isSweeping: options.sweepWhenIdle !== false,
    sweepGapMs: numberOf(options.sweepMinutes, 20, 1, 1440) * 60_000,
    maxDollarsPerRun: numberOf(options.maxDollarsPerRun, 2, 0.05, 100),
    claudePath: typeof options.claudePath === 'string' ? options.claudePath.trim() : '',
    rateLimitPct: numberOf(options.pauseAtRateLimitPercent, 80, 1, 101),
    testerTimeoutMs: numberOf(options.testerTimeoutMinutes, 20, 2, 120) * 60_000,
  }
}

/** What this load of the module keeps between events; `$.state` holds what drawings read. */
const live = {
  role: 'scout' as 'scout' | 'tester',
  box: undefined as Sandbox | undefined,
  config: configOf({}),
  ctx: undefined as Ctx | undefined,
  ctxError: '',
  ctxTriedAt: 0,
  quietTimer: undefined as Timer | undefined,
  idleTimer: undefined as Timer | undefined,
  retryTimer: undefined as Timer | undefined,
  watchTimer: undefined as Timer | undefined,
  stopTester: undefined as (() => void) | undefined,
  firstDirtyAt: 0,
  lastActivityAt: 0,
  isMainBusy: false,
  isCycling: false,
  pending: undefined as Trigger | undefined,
  pendingFocus: undefined as string | undefined,
  lastRunStartedAt: 0,
  seenTree: '',
  seenTreeAt: 0,
}

const PRIORITY: Record<Trigger, number> = { manual: 4, change: 3, idle: 2, sweep: 1 }

const unique = (values: readonly string[]): string[] => [...new Set(values.filter(value => value !== ''))]

const messageOf = (error: unknown): string =>
  clip(oneLine(error instanceof Error ? error.message : String(error)), 240)

const tokensOf = (usage: ModelUsage | undefined): number =>
  usage === undefined
    ? 0
    : usage.input_tokens + usage.output_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens

const dollars = (n: number): string => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`

const isMemory = (value: unknown): value is Memory =>
  value !== null && typeof value === 'object' && (value as { v?: unknown }).v === 1

const verdictColor = (verdict: Verdict): string =>
  verdict === 'broke' ? 'error' : verdict === 'degraded' ? 'warning' : verdict === 'held' ? 'success' : 'subtle'

const memoryKeyOf = (c: Ctx): string => `mem:${c.projectKey}`

const listOf = (json: string | undefined): string[] => {
  try {
    const value: unknown = JSON.parse(json ?? '[]')
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.startsWith('/')) : []
  } catch {
    return []
  }
}

/** A snapshot folder is never a project of its own: no scout runs inside one. */
const isSnapshotPath = (path: string): boolean => /\/stress-scout\/[^/]+\/runs\/run-\d+-\d+(\/|$)/.test(path)

// ---- bookkeeping ---------------------------------------------------------------

async function log($: $, text: string): Promise<void> {
  const at = await $.clock.now()
  await update($, activityAtom, list => [{ at, text: clip(oneLine(text), 300) }, ...list].slice(0, 40))
}

async function refreshStatus($: $): Promise<void> {
  const [phase, paused, runsUsed] = await Promise.all([read($, phaseAtom), read($, pausedAtom), read($, runsUsedAtom)])
  const { maxRuns } = live.config
  const text =
    phase.kind === 'off'
      ? `stress-scout off: ${clip(phase.detail, 60)}`
      : phase.kind === 'test'
        ? `stress-scout ▶ testing ${clip(phase.detail, 60)}`
        : paused
          ? 'stress-scout paused (/stress resume)'
          : phase.kind === 'triage'
            ? 'stress-scout … triaging'
            : runsUsed >= maxRuns
              ? `stress-scout ✓ watching · run cap ${runsUsed}/${maxRuns} reached (/stress still works)`
              : `stress-scout ✓ watching · ${runsUsed}/${maxRuns} runs`
  $.ui.status(text)
}

async function setPhase($: $, kind: Phase['kind'], detail = ''): Promise<void> {
  const since = await $.clock.now()
  await update($, phaseAtom, () => ({ kind, detail, since }))
  await refreshStatus($)
}

async function ensureCtx($: $): Promise<Ctx | undefined> {
  const now = await $.clock.now()
  const root = trimSlash(await $.session.root())
  if (live.ctx !== undefined) {
    if (root === live.ctx.root) return live.ctx
    live.ctx = undefined
  }
  if (live.ctxError !== '' && now - live.ctxTriedAt < 10 * 60_000) return undefined
  live.ctxTriedAt = now
  try {
    const home = trimSlash((await $.env.get('HOME')) ?? '')
    if (root === '/' || root === '' || root === home) {
      live.ctxError = 'this session runs in your home folder; start Claude Code in a project'
      return undefined
    }
    if (isSnapshotPath(root)) {
      live.ctxError = 'this folder is a stress-scout snapshot'
      return undefined
    }
    const gitVersion = await $.process.run(['git', '--version']).catch(() => undefined)
    if (gitVersion === undefined || gitVersion.exitCode !== 0) {
      live.ctxError = 'git is not installed'
      return undefined
    }
    const tmp = trimSlash((await $.env.get('TMPDIR')) || '/tmp')
    const projectKey = fnv(root)
    const given = `${tmp}/stress-scout/${slug(basename(root))}-${projectKey}`
    await $.fs.write(`${given}/.keep`, '')
    const scratch = trimSlash((await $.fs.stat(given, { resolve: true })).realPath ?? given)
    const rootReal = trimSlash((await $.fs.stat(root, { resolve: true })).realPath ?? root)
    if (isInside(scratch, root) || isInside(scratch, rootReal)) {
      live.ctxError = 'TMPDIR is inside the project; point TMPDIR elsewhere'
      return undefined
    }
    const shadow = await openShadow($, root, scratch)
    live.ctx = {
      root,
      home,
      scratch,
      shadow,
      projectKey,
      rootSpellings: unique([root, rootReal]),
      scratchSpellings: unique([scratch, trimSlash(given)]),
    }
    live.ctxError = ''
    return live.ctx
  } catch (error) {
    live.ctxError = `setup failed: ${messageOf(error)}`
    return undefined
  }
}

async function loadMemory($: $, c: Ctx): Promise<Memory> {
  const raw = await $.store.get(memoryKeyOf(c))
  return isMemory(raw) ? raw : emptyMemory()
}

const newest = <T extends { at: number }>(record: Record<string, T>, n: number): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([, a], [, b]) => b.at - a.at).slice(0, n))

async function saveMemory($: $, c: Ctx, memory: Memory): Promise<void> {
  const touchedAt = await $.clock.now()
  await $.store.set(memoryKeyOf(c), {
    ...memory,
    touchedAt,
    tested: newest(memory.tested, 200),
    dismissed: newest(memory.dismissed, 200),
  })
  const keys = (await $.store.keys()).filter(key => key.startsWith('mem:'))
  if (keys.length <= 40) return
  const ages: { key: string; at: number }[] = []
  for (const key of keys) {
    const value = await $.store.get(key)
    ages.push({ key, at: isMemory(value) ? value.touchedAt : 0 })
  }
  for (const { key } of ages.sort((a, b) => a.at - b.at).slice(0, keys.length - 40)) await $.store.delete(key)
}

async function recentIntent($: $): Promise<string[]> {
  const messages: unknown = await $.session.messages().catch(() => [])
  if (!Array.isArray(messages)) return []
  return (messages as { role: string; text: string; toolResults?: unknown[] }[])
    .filter(m => m.role === 'user' && m.text.trim() !== '' && !m.text.trimStart().startsWith('<'))
    .filter(m => (m.toolResults?.length ?? 0) === 0 && !HANDOFF.test(m.text))
    .slice(-3)
    .reverse()
    .map(m => clip(oneLine(m.text), 400))
}

async function isRateLimited($: $): Promise<boolean> {
  try {
    const { rateLimits } = await $.session.usage()
    return rateLimits.some(limit => limit.kind === 'five_hour' && limit.percentUsed >= live.config.rateLimitPct)
  } catch {
    return false
  }
}

// ---- the tester's guard (tester role) -----------------------------------------------

async function loadSandbox($: $): Promise<Sandbox | undefined> {
  const roots = listOf(await $.env.get('STRESS_SCOUT_ROOTS'))
  const runDirs = listOf(await $.env.get('STRESS_SCOUT_RUN_DIRS'))
  const home = trimSlash((await $.env.get('STRESS_SCOUT_HOME')) ?? '')
  return roots.length > 0 && runDirs.length > 0 ? { roots, runDirs, home } : undefined
}

/** Where a file path lands once links resolve, walking up to the nearest folder that exists. */
async function placed($: $, path: string): Promise<string | undefined> {
  if (!path.startsWith('/') || /(^|\/)\.\.?(\/|$)/.test(path)) return undefined
  const own = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  if (own?.realPath !== undefined) return own.realPath
  let dir = trimSlash(path)
  let rest = ''
  while (dir.includes('/')) {
    const cut = dir.lastIndexOf('/')
    rest = rest === '' ? dir.slice(cut + 1) : `${dir.slice(cut + 1)}/${rest}`
    dir = dir.slice(0, cut)
    const stat = await $.fs.stat(dir === '' ? '/' : dir, { resolve: true }).catch(() => undefined)
    if (stat?.realPath !== undefined) return `${trimSlash(stat.realPath)}/${rest}`
  }
  return undefined
}

/** The guard's verdict on one of the tester's calls, by tool. */
async function testerCheck($: $, tool: string, input: Record<string, unknown>): Promise<Check> {
  const refuse = (reason: string): Check => ({ isAllowed: false, reason: `stress-scout guard: ${reason}` })
  const box = live.box
  if (box === undefined) return refuse('the sandbox is not configured, so every call is refused')
  if (typeof input._host === 'string' && input._host !== '') return refuse('the tester runs on this machine only')
  const text = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '')
  switch (tool) {
    case 'Bash':
      if (input.run_in_background === true) return refuse('run commands in the foreground, wrapped in timeout')
      if (input.dangerouslyDisableSandbox === true) return refuse('the sandbox stays on')
      return checkBash(text('command'), box)
    case 'Read':
    case 'Glob':
    case 'Grep':
      return checkRead(text('file_path') || text('path'), box)
    case 'Write':
      return checkWrite(await placed($, text('file_path')), text('content'), box)
    case 'Edit':
      return checkWrite(await placed($, text('file_path')), text('new_string'), box)
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? (input.edits as { new_string?: unknown }[]) : []
      return checkWrite(await placed($, text('file_path')), edits.map(edit => String(edit.new_string ?? '')).join('\n'), box)
    }
    case 'NotebookEdit':
      return checkWrite(await placed($, text('notebook_path')), text('new_source'), box)
    default:
      return refuse(`${tool} is not part of the tester's toolkit`)
  }
}

// ---- the cycle: fingerprint, triage, test (scout role) -------------------------------

async function triage($: $, prompt: string): Promise<{ plan?: Triage; tokens: number; error?: string }> {
  const reply = await $.model.complete({
    model: live.config.triageModel,
    system: TRIAGE_SYSTEM,
    prompt,
    maxTokens: 700,
    timeoutMs: 90_000,
  })
  const tokens = tokensOf(reply.usage)
  if (!reply.isAnswered) {
    const why = reply.reason === 'api-error' ? `triage API error ${reply.status ?? ''}`.trim() : `triage ${reply.reason}`
    return { tokens, error: why }
  }
  const plan = parseTriage(reply.text)
  return plan === undefined ? { tokens, error: 'triage reply was unreadable' } : { plan, tokens }
}

async function fingerprintOrReset($: $, c: Ctx): Promise<string> {
  try {
    return await fingerprint($, c.shadow)
  } catch (error) {
    if (messageOf(error).includes('.lock')) throw error
    await resetShadow($, c.shadow)
    c.shadow = await openShadow($, c.root, c.scratch)
    return fingerprint($, c.shadow)
  }
}

async function hashesOf($: $, c: Ctx, tree: string, keys: readonly string[]): Promise<Map<string, string>> {
  const files = unique(keys.flatMap(key => key.split(',')))
  const blobs = await blobsOf($, c.shadow, tree, files)
  const hashes = new Map<string, string>()
  for (const key of keys) {
    const parts = key.split(',')
    if (parts.every(part => blobs.has(part))) {
      hashes.set(key, fnv(parts.sort().map(part => `${part}:${blobs.get(part) ?? ''}`).join('|')))
    }
  }
  return hashes
}

/** What to test now, or why nothing: a change since the last scan first, else a sweep. */
async function choose(
  $: $,
  c: Ctx,
  trigger: Trigger,
  tree: string,
  memory: Memory,
  intent: string[],
): Promise<{ chosen?: Plan; kind: Trigger; note: string }> {
  const { config } = live
  const now = await $.clock.now()
  const recentKeys = Object.entries(memory.tested)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, 15)
    .map(([key]) => key)
  const currentHashes = await hashesOf($, c, tree, recentKeys)

  const base = memory.lastTree !== '' ? memory.lastTree : await headTree($, c.shadow)
  if (base !== '' && base !== tree) {
    const paths = await changedPaths($, c.shadow, base, tree)
    if (paths.length > 0) {
      const stat = await diffStat($, c.shadow, base, tree)
      const diff = await diffText($, c.shadow, base, tree, [], 24_000)
      const result = await triage($, changeTriagePrompt({ intent, memory, now, currentHashes, stat, diff }))
      if (result.plan === undefined) return { kind: 'change', note: result.error ?? 'triage failed' }
      memory.lastTree = tree
      return { chosen: { plan: result.plan, tokens: result.tokens, base }, kind: 'change', note: '' }
    }
  }
  memory.lastTree = tree

  const sweepsUsed = await read($, sweepsUsedAtom)
  const isSweepDue =
    trigger === 'manual' ||
    ((trigger === 'idle' || trigger === 'sweep') &&
      config.isSweeping &&
      sweepsUsed < config.maxSweeps &&
      now - memory.lastSweepAt >= config.sweepGapMs)
  if (!isSweepDue) return { kind: trigger, note: NO_CHANGE }

  memory.lastSweepAt = now
  const files = await listTree($, c.shadow, tree)
  const history = await churn($, c.shadow)
  const testedFiles = new Map(
    Object.entries(memory.tested)
      .filter(([key]) => !key.includes(','))
      .map(([key, entry]) => [key, entry.hash] as const),
  )
  const isTestedNow = (path: string, sha: string): boolean => testedFiles.get(path) === fnv(`${path}:${sha}`)
  const candidates = rankCandidates(files, history, isTestedNow)
  if (candidates.length === 0) return { kind: 'sweep', note: 'nothing untested left to sweep' }
  const result = await triage($, sweepTriagePrompt({ intent, memory, now, currentHashes, candidates }))
  if (result.plan === undefined) return { kind: 'sweep', note: result.error ?? 'triage failed' }
  return { chosen: { plan: result.plan, tokens: result.tokens, base: '' }, kind: 'sweep', note: '' }
}

const sandboxOf = (c: Ctx, run: Run): Sandbox => ({
  roots: c.rootSpellings,
  runDirs: unique([run.runDir, ...c.scratchSpellings.map(dir => `${dir}/runs/${basename(run.runDir)}`)]),
  home: c.home,
})

/** The headless tester's command line: few tools, no MCP, no skills, a budget, the guard loaded. */
function testerArgv($: $, exec: string, run: Run): string[] {
  const { testerModel, maxDollarsPerRun } = live.config
  return [
    exec,
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    ...(testerModel === 'inherit' ? [] : ['--model', testerModel]),
    ...(testerModel === 'haiku' ? [] : ['--effort', 'medium']),
    '--permission-mode', 'dontAsk',
    '--tools', TESTER_TOOLS,
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--setting-sources', 'user',
    '--max-turns', '60',
    '--max-budget-usd', String(maxDollarsPerRun),
    '--add-dir', run.runDir,
    '--plugin-dir', $.plugin.root,
    '--append-system-prompt', TESTER_SYSTEM,
  ]
}

/** Runs the tester process to its end (or the deadline, or a Stop), then files what it found. */
async function superviseTester($: $, c: Ctx, run: Run, prompt: string): Promise<void> {
  const { config } = live
  const exec = config.claudePath !== '' ? config.claudePath : ((await $.env.get('CLAUDE_CODE_EXECPATH')) ?? '') || 'claude'
  const box = sandboxOf(c, run)
  const env = {
    STRESS_SCOUT_ROLE: 'tester',
    STRESS_SCOUT_ROOTS: JSON.stringify(box.roots),
    STRESS_SCOUT_RUN_DIRS: JSON.stringify(box.runDirs),
    STRESS_SCOUT_HOME: box.home,
    TMPDIR: `${run.runDir}/tmp`,
  }
  let result: TesterResult | undefined
  let steps = 0
  let stderrTail = ''
  let failure = ''
  let isStopped = false
  let endEarly: (reason: 'deadline') => void = () => undefined
  const early = new Promise<'deadline'>(resolve => {
    endEarly = resolve
  })
  const timer = $.clock.after(config.testerTimeoutMs, () => endEarly('deadline'))
  live.stopTester = () => {
    isStopped = true
    endEarly('deadline')
  }
  try {
    const stream = $.process.spawn({ argv: testerArgv($, exec, run), cwd: run.snapshot, env, input: prompt })
    let pendingText = ''
    const take = async (line: string): Promise<void> => {
      const event = parseStreamLine(line)
      if (event.result !== undefined) result = event.result
      if (event.toolUses === 0) return
      const before = steps
      steps += event.toolUses
      if (Math.floor(steps / 5) > Math.floor(before / 5)) {
        await setPhase($, 'test', `${clip(run.target, 50)} (${run.kind}) · step ${steps}`)
      }
    }
    for (;;) {
      const step = await Promise.race([stream.next(), early])
      if (step === 'deadline') {
        failure = isStopped ? 'stopped before it finished' : `timed out after ${ago(config.testerTimeoutMs)}`
        void stream.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined)
        break
      }
      if (step.done === true) {
        if (pendingText.trim() !== '') await take(pendingText)
        if (result === undefined) {
          const how = step.value.code ?? step.value.signal ?? 'unknown'
          failure = `the tester exited (${how}) without a result: ${clip(oneLine(stderrTail), 300) || 'no output'}`
        }
        break
      }
      if (step.value.stream === 'stderr') {
        stderrTail = `${stderrTail}${step.value.text}`.slice(-2000)
        continue
      }
      pendingText += step.value.text
      for (let nl = pendingText.indexOf('\n'); nl >= 0; nl = pendingText.indexOf('\n')) {
        const line = pendingText.slice(0, nl)
        pendingText = pendingText.slice(nl + 1)
        await take(line)
      }
    }
  } catch (error) {
    failure = `could not run the tester (${exec}): ${messageOf(error)}`
  } finally {
    timer.cancel()
    live.stopTester = undefined
  }
  if (result?.isError === true && failure === '') {
    failure =
      result.subtype === 'error_max_budget_usd'
        ? `stopped at the ${dollars(config.maxDollarsPerRun)} budget for one run`
        : result.subtype === 'error_max_turns'
          ? 'ran out of turns before finishing'
          : `ended with ${result.subtype || 'an error'}`
  }
  await finishRun($, run, { answer: result?.text ?? '', cost: result?.cost ?? 0, tokens: result?.tokens ?? 0, failure, steps })
}

type StartArgs = {
  id: number
  trigger: Trigger
  plan: Triage
  tokens: number
  intent: string[]
  tree: string
  diff: string
  memoryKey: string
  hash: string
}

async function startRun($: $, c: Ctx, args: StartArgs): Promise<void> {
  const startedAt = await $.clock.now()
  const runDir = `${c.scratch}/runs/run-${String(args.id).padStart(4, '0')}-${startedAt}`
  const { snapshot, linked } = await makeSnapshot($, c.shadow, args.tree, runDir)
  const run: Run = {
    id: args.id,
    trigger: args.trigger,
    target: args.plan.target,
    kind: args.plan.kind,
    memoryKey: args.memoryKey,
    hash: args.hash,
    runDir,
    snapshot,
    baseTree: args.tree,
    startedAt,
    tokens: args.tokens,
  }
  await update($, runAtom, () => run)
  await update($, tokensAtom, n => n + args.tokens)
  if (args.trigger !== 'manual') {
    await update($, runsUsedAtom, n => n + 1)
    if (args.trigger === 'sweep') await update($, sweepsUsedAtom, n => n + 1)
  }
  live.lastRunStartedAt = startedAt
  await setPhase($, 'test', `${clip(args.plan.target, 50)} (${args.plan.kind})`)
  await log($, `#${args.id} ${args.trigger}: testing ${args.plan.target} (${args.plan.kind}): ${args.plan.why}`)
  const prompt = testerTask({
    id: args.id,
    trigger: args.trigger,
    plan: args.plan,
    intent: args.intent,
    diff: args.diff,
    snapshot,
    runDir,
    root: c.root,
    linkedDeps: linked,
  })
  void superviseTester($, c, run, prompt)
}

const manualPlan = (focus: string): Plan => ({
  plan: {
    isWorth: true,
    risk: 'high',
    target: clip(focus.trim(), 200),
    files: [],
    kind: 'edge',
    why: 'requested by the developer; find the riskiest assumption yourself',
    attack: 'your call: pick the stress that fits the target best',
    skip: '',
  },
  tokens: 0,
  base: '',
})

async function cycle($: $, trigger: Trigger, focus?: string): Promise<void> {
  const { config } = live
  const isManual = trigger === 'manual'
  if (!isManual) {
    if (await read($, pausedAtom)) return
    if ((await read($, runsUsedAtom)) >= config.maxRuns) return
    if (await isRateLimited($)) {
      await log($, `${trigger}: skipped, your 5-hour usage window is above ${config.rateLimitPct}%`)
      return
    }
    const now = await $.clock.now()
    const gapLeft = live.lastRunStartedAt + config.minGapMs - now
    if (live.lastRunStartedAt > 0 && gapLeft > 0) {
      live.retryTimer?.cancel()
      live.retryTimer = $.clock.after(gapLeft + 1000, () => void kick($, trigger))
      return
    }
  }
  const c = await ensureCtx($)
  if (c === undefined) {
    await setPhase($, 'off', live.ctxError)
    return
  }
  await setPhase($, 'triage', focus !== undefined ? clip(focus, 60) : trigger)
  const tree = await fingerprintOrReset($, c)
  live.seenTree = tree
  const memory = await loadMemory($, c)
  const intent = await recentIntent($)

  let chosen: Plan | undefined
  let kind: Trigger = trigger
  if (focus !== undefined && focus.trim() !== '') {
    chosen = manualPlan(focus)
  } else {
    const result = await choose($, c, trigger, tree, memory, intent)
    chosen = result.chosen
    kind = isManual ? 'manual' : result.kind
    if (chosen === undefined) {
      await saveMemory($, c, memory)
      if (result.note !== NO_CHANGE || isManual) await log($, `${kind}: ${result.note}`)
      await setPhase($, 'idle')
      return
    }
  }

  const { plan, tokens } = chosen
  if (!plan.isWorth || (plan.risk === 'low' && !isManual)) {
    await saveMemory($, c, memory)
    await update($, tokensAtom, n => n + tokens)
    await log($, `${kind}: skipped, ${plan.skip || 'low risk'}`)
    await setPhase($, 'idle')
    return
  }

  const blobs = await blobsOf($, c.shadow, tree, plan.files)
  plan.files = plan.files.filter(file => blobs.has(file))
  const sorted = [...plan.files].sort()
  const memoryKey = sorted.length > 0 ? sorted.join(',') : clip(plan.target, 200)
  const hash =
    sorted.length > 0 ? fnv(sorted.map(file => `${file}:${blobs.get(file) ?? ''}`).join('|')) : fnv(`${plan.target}:${tree}`)
  if (!isManual) {
    const tested = memory.tested[memoryKey]
    const dismissed = memory.dismissed[`${memoryKey}|${plan.kind}`]
    if (tested?.hash === hash || dismissed?.hash === hash) {
      await saveMemory($, c, memory)
      const why = tested?.hash === hash ? `tested (${tested.verdict})` : 'dismissed'
      await log($, `${kind}: ${memoryKey} was already ${why} at this version`)
      await setPhase($, 'idle')
      return
    }
  }

  const diff = chosen.base !== '' && sorted.length > 0 ? await diffText($, c.shadow, chosen.base, tree, sorted, 8000) : ''
  const id = memory.nextId
  memory.nextId += 1
  await saveMemory($, c, memory)
  await startRun($, c, { id, trigger: kind, plan, tokens, intent, tree, diff, memoryKey, hash })
}

async function kick($: $, trigger: Trigger, focus?: string): Promise<void> {
  if (live.isCycling || (await read($, runAtom)) !== null) {
    if (live.pending === undefined || PRIORITY[trigger] > PRIORITY[live.pending]) live.pending = trigger
    if (focus !== undefined) live.pendingFocus = focus
    return
  }
  live.isCycling = true
  try {
    await cycle($, trigger, focus)
  } catch (error) {
    await log($, `${trigger}: ${messageOf(error)}`)
    await setPhase($, 'idle')
  } finally {
    live.isCycling = false
    void drainPending($)
  }
}

async function drainPending($: $): Promise<void> {
  if (live.pending === undefined || live.isCycling || (await read($, runAtom)) !== null) return
  const trigger = live.pending
  const focus = live.pendingFocus
  live.pending = undefined
  live.pendingFocus = undefined
  $.clock.after(2000, () => void kick($, trigger, focus))
}

async function cleanupRuns($: $, c: Ctx): Promise<void> {
  const dir = `${c.scratch}/runs`
  const entries = await $.fs.list(dir).catch(() => [])
  const active = await read($, runAtom)
  const names = entries
    .filter(entry => entry.kind === 'dir' && /^run-\d+-\d+$/.test(entry.name))
    .map(entry => entry.name)
    .sort()
    .reverse()
  for (const name of names.slice(KEEP_RUNS)) {
    const path = `${dir}/${name}`
    if (active?.runDir !== path) await $.process.run(['rm', '-rf', path], { timeoutMs: 120_000 }).catch(() => undefined)
  }
}

async function maybeSuggest($: $): Promise<void> {
  if (live.isMainBusy) return
  const [findings, suggested] = await Promise.all([read($, findingsAtom), read($, suggestedAtom)])
  const finding = findings.find(f => f.status === 'new' && isActionable(f.verdict) && f.patch !== '')
  if (finding === undefined || finding.id === suggested) return
  const shown = await $.prompt.suggest({ text: handoffPrompt(finding) }).catch(() => ({ isShown: false }))
  if (shown.isShown) await update($, suggestedAtom, () => finding.id)
}

const blankFinding = (run: Run, at: number): Finding => ({
  id: run.id,
  at,
  trigger: run.trigger,
  target: run.target,
  kind: run.kind,
  verdict: 'inconclusive',
  headline: '',
  evidence: '',
  before: '',
  after: '',
  fixSummary: '',
  fixExplanation: '',
  patch: '',
  patchPath: '',
  isVerified: false,
  nextStep: '',
  rerun: '',
  snapshot: run.snapshot,
  confidence: 'low',
  status: 'new',
  durationMs: at - run.startedAt,
  tokens: run.tokens,
  cost: 0,
  memoryKey: run.memoryKey,
  hash: run.hash,
})

async function finishRun($: $, run: Run, outcome: Outcome): Promise<void> {
  const c = await ensureCtx($)
  const now = await $.clock.now()
  const report = parseReport(outcome.answer)
  let patch = ''
  if (c !== undefined && report?.fix) {
    try {
      patch = await patchOf($, c.shadow, run.baseTree, run.snapshot, run.runDir, report.fix.files)
    } catch (error) {
      await log($, `#${run.id}: could not read the fix back: ${messageOf(error)}`)
    }
  }
  const patchPath = patch !== '' ? `${run.runDir}/fix.patch` : ''
  if (patchPath !== '') await $.fs.write(patchPath, `${patch}\n`)
  const finding: Finding = {
    ...blankFinding(run, now),
    target: report?.target || run.target,
    kind: report?.kind || run.kind,
    verdict: report?.verdict ?? 'inconclusive',
    headline: report?.headline || outcome.failure || 'the tester finished without a report',
    evidence: report?.evidence ?? clip(oneLine(outcome.answer || outcome.failure), 600),
    before: report?.before ?? '',
    after: report?.after ?? '',
    fixSummary: report?.fix?.summary ?? '',
    fixExplanation: report?.fix?.explanation ?? '',
    patch: clip(patch, 40_000),
    patchPath,
    isVerified: report?.fix?.isVerified === true && patch !== '',
    nextStep: report?.nextStep ?? '',
    rerun: report?.rerun ?? '',
    confidence: report?.confidence ?? 'low',
    tokens: run.tokens + outcome.tokens,
    cost: outcome.cost,
  }
  await update($, findingsAtom, list => [finding, ...list.filter(f => f.id !== finding.id)].slice(0, 25))
  await update($, tokensAtom, n => n + outcome.tokens)
  await update($, dollarsAtom, n => n + outcome.cost)
  await update($, runAtom, () => null)
  if (c !== undefined && (report !== undefined || outcome.cost > 0)) {
    const memory = await loadMemory($, c)
    memory.tested[run.memoryKey] = { at: now, verdict: finding.verdict, kind: finding.kind, hash: run.hash }
    await saveMemory($, c, memory)
  }
  const verified = finding.isVerified ? ' · fix verified' : ''
  const spent = outcome.cost > 0 ? `, ${dollars(outcome.cost)}` : ''
  await log($, `#${run.id} ${finding.verdict}: ${finding.headline}${verified} (${ago(finding.durationMs)}${spent})`)
  if (isActionable(finding.verdict)) {
    $.ui.toast(`stress-scout #${run.id} ${finding.verdict}: ${clip(finding.headline, 120)}`, { timeoutMs: 8000 })
    await maybeSuggest($)
  }
  await setPhase($, 'idle')
  if (c !== undefined) await cleanupRuns($, c)
  void drainPending($)
}

// ---- triggers ----------------------------------------------------------------------

async function noteEdit($: $): Promise<void> {
  const { quietMs, maxWaitMs } = live.config
  const now = await $.clock.now()
  live.lastActivityAt = now
  if (live.firstDirtyAt === 0) live.firstDirtyAt = now
  const wait = Math.max(0, Math.min(quietMs, live.firstDirtyAt + maxWaitMs - now))
  live.quietTimer?.cancel()
  live.quietTimer = $.clock.after(wait, () => {
    live.firstDirtyAt = 0
    live.quietTimer = undefined
    void kick($, 'change')
  })
}

function armIdle($: $): void {
  live.idleTimer?.cancel()
  live.idleTimer = $.clock.after(live.config.idleMs, () => {
    live.idleTimer = undefined
    void kick($, 'idle')
  })
}

/** Once a minute: notice edits made outside Claude (your editor), and sweep when idle. */
async function heartbeat($: $): Promise<void> {
  const { config } = live
  if (live.isCycling || live.quietTimer !== undefined) return
  if ((await read($, runAtom)) !== null || (await read($, pausedAtom))) return
  const c = await ensureCtx($)
  if (c === undefined) {
    if ((await read($, phaseAtom)).kind !== 'off') await setPhase($, 'off', live.ctxError)
    return
  }
  const tree = await fingerprintOrReset($, c).catch(() => '')
  if (tree === '') return
  const now = await $.clock.now()
  if (tree !== live.seenTree) {
    live.seenTree = tree
    live.seenTreeAt = now
    live.lastActivityAt = Math.max(live.lastActivityAt, now)
    return
  }
  const memory = await loadMemory($, c)
  if (tree !== memory.lastTree && now - live.seenTreeAt >= config.quietMs) {
    void kick($, 'change')
    return
  }
  const isIdle = !live.isMainBusy && now - live.lastActivityAt >= config.idleMs
  if (isIdle && config.isSweeping && now - memory.lastSweepAt >= config.sweepGapMs) void kick($, 'sweep')
}

// ---- actions behind the buttons and /stress -------------------------------------------

async function showPane($: $, id: number): Promise<void> {
  await update($, openAtom, current => (current === id ? 0 : id))
  await update($, seenAtom, seen => Math.max(seen, id))
  await $.ui.open({ id: PANE, title: 'Stress Scout' })
}

async function apply($: $, id: number): Promise<string> {
  const finding = (await read($, findingsAtom)).find(f => f.id === id)
  if (finding === undefined) return `No finding #${id}.`
  if (finding.patch === '' && finding.nextStep === '') return `Finding #${id} has no fix to hand over.`
  await update($, findingsAtom, list => list.map(f => (f.id === id ? { ...f, status: 'applied' as const } : f)))
  await update($, seenAtom, seen => Math.max(seen, id))
  await $.prompt.submit({ text: handoffMessage(finding, await $.clock.now()), asUser: true })
  return `Handed finding #${id} to Claude.`
}

async function dismiss($: $, id: number): Promise<string> {
  const finding = (await read($, findingsAtom)).find(f => f.id === id)
  if (finding === undefined) return `No finding #${id}.`
  await update($, findingsAtom, list => list.map(f => (f.id === id ? { ...f, status: 'dismissed' as const } : f)))
  await update($, seenAtom, seen => Math.max(seen, id))
  const c = await ensureCtx($)
  if (c !== undefined) {
    const memory = await loadMemory($, c)
    memory.dismissed[`${finding.memoryKey}|${finding.kind}`] = { at: await $.clock.now(), hash: finding.hash }
    await saveMemory($, c, memory)
  }
  return `Dismissed #${id}; it won't be raised again unless that code changes.`
}

async function togglePause($: $, isPaused: boolean): Promise<string> {
  await update($, pausedAtom, () => isPaused)
  await log($, isPaused ? 'paused' : 'resumed')
  await refreshStatus($)
  return isPaused ? 'Paused. /stress resume to continue.' : 'Resumed.'
}

async function stopTester($: $): Promise<string> {
  const run = await read($, runAtom)
  if (run === null || live.stopTester === undefined) return 'No stress test is running.'
  live.stopTester()
  return `Stopping the test of ${run.target} (#${run.id}).`
}

async function forget($: $): Promise<string> {
  const c = await ensureCtx($)
  if (c !== undefined) await $.store.delete(memoryKeyOf(c))
  return 'Forgot what was tested in this project.'
}

async function runNow($: $, focus?: string): Promise<string> {
  const run = await read($, runAtom)
  $.clock.after(0, () => void kick($, 'manual', focus))
  if (run !== null) {
    const age = ago((await $.clock.now()) - run.startedAt)
    return `Already testing ${run.target} (#${run.id}, ${age}); yours is queued after it.`
  }
  return focus !== undefined
    ? `Stress-testing "${clip(focus, 120)}". Results land in /stress show.`
    : 'Stress-testing the latest change (or the riskiest untested code if nothing changed). Results land in /stress show.'
}

async function openPane($: $): Promise<string> {
  await $.ui.open({ id: PANE, title: 'Stress Scout' })
  return 'Stress Scout pane opened.'
}

async function statusText($: $): Promise<string> {
  const { config } = live
  const [phase, findings, runsUsed, tokens, spent, paused, run] = await Promise.all([
    read($, phaseAtom),
    read($, findingsAtom),
    read($, runsUsedAtom),
    read($, tokensAtom),
    read($, dollarsAtom),
    read($, pausedAtom),
    read($, runAtom),
  ])
  const now = await $.clock.now()
  const state =
    run !== null
      ? `Testing ${run.target} for ${ago(now - run.startedAt)}.`
      : paused
        ? 'Paused.'
        : phase.kind === 'off'
          ? `Off: ${phase.detail}.`
          : 'Watching.'
  const lines = [
    state,
    `automatic runs ${runsUsed}/${config.maxRuns} · ${dollars(spent)} and ${compactTokens(tokens)} tokens this session · triage ${config.triageModel}, tester ${config.testerModel}`,
  ]
  for (const f of findings.slice(0, 6)) {
    const flags = `${f.isVerified ? ' (fix verified)' : ''}${f.status !== 'new' ? ` [${f.status}]` : ''}`
    lines.push(`#${f.id} ${f.verdict} ${f.target}: ${f.headline}${flags}`)
  }
  if (findings.length === 0) lines.push('No findings yet.')
  return lines.join('\n')
}

const HELP = [
  '/stress            stress-test the latest change now (a sweep when nothing changed)',
  '/stress <focus>    stress-test something specific, e.g. /stress the retry logic in api/client.ts',
  '/stress show       open the Stress Scout pane',
  '/stress status     what it is doing and what it found',
  '/stress apply N    hand finding N to Claude (patch and evidence attached)',
  '/stress dismiss N  drop finding N; it is not raised again unless the code changes',
  '/stress stop       stop the running test',
  '/stress pause | resume | forget',
].join('\n')

async function runCommand($: $, args: string): Promise<string> {
  const [verb = '', ...rest] = args.split(/\s+/)
  const n = Number((rest[0] ?? '').replace('#', ''))
  switch (verb.toLowerCase()) {
    case '':
    case 'now':
    case 'run':
      return runNow($)
    case 'show':
    case 'pane':
      return openPane($)
    case 'status':
      return statusText($)
    case 'pause':
      return togglePause($, true)
    case 'resume':
      return togglePause($, false)
    case 'stop':
      return stopTester($)
    case 'apply':
      return Number.isInteger(n) && n > 0 ? apply($, n) : 'Usage: /stress apply <finding number>'
    case 'dismiss':
      return Number.isInteger(n) && n > 0 ? dismiss($, n) : 'Usage: /stress dismiss <finding number>'
    case 'forget':
      return forget($)
    case 'help':
      return HELP
    default:
      return runNow($, args)
  }
}

async function onSessionStart($: $): Promise<void> {
  if ((await $.env.get('STRESS_SCOUT_ROLE')) === 'tester') {
    live.role = 'tester'
    live.box = await loadSandbox($)
    return
  }
  await $.command.register({
    name: 'stress',
    description: 'stress-scout: stress-test the latest changes now (or a focus you name); show, status, stop, pause, resume',
    argumentHint: '[focus | show | status | stop | pause | resume | apply N | dismiss N | forget]',
  })
  const stale = await read($, runAtom)
  if (stale !== null) {
    // the tester process ended with the module it belonged to
    await finishRun($, stale, { answer: '', cost: 0, tokens: 0, failure: 'interrupted: stress-scout reloaded while it ran', steps: 0 })
  }
  live.watchTimer?.cancel()
  live.watchTimer = $.clock.every(60_000, () => void heartbeat($))
  await setPhase($, 'idle')
}

async function onMainTurnEnd($: $): Promise<void> {
  live.isMainBusy = false
  live.lastActivityAt = await $.clock.now()
  armIdle($)
  await maybeSuggest($)
}

async function handoff($: $, id: number): Promise<string | undefined> {
  const finding = (await read($, findingsAtom)).find(f => f.id === id)
  if (finding === undefined) return undefined
  await update($, findingsAtom, list => list.map(f => (f.id === id ? { ...f, status: 'applied' as const } : f)))
  await update($, seenAtom, seen => Math.max(seen, id))
  return handoffContext(finding, await $.clock.now())
}

// ---- the hooks -------------------------------------------------------------------------

export const register: Register = (on, options) => {
  live.config = configOf(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await onSessionStart($)
    return started
  })

  on('session.end', ($, e, next) => {
    for (const timer of [live.quietTimer, live.idleTimer, live.retryTimer, live.watchTimer]) timer?.cancel()
    live.stopTester?.()
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (live.role === 'scout' && e.agentId === undefined) {
      live.isMainBusy = true
      live.idleTimer?.cancel()
      live.idleTimer = undefined
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (live.role === 'scout' && e.agentId === undefined) await onMainTurnEnd($)
    return result
  })

  on('tool.call', async ($, e, next) => {
    if (live.role === 'tester') {
      const check = await testerCheck($, String(e.tool), e as unknown as Record<string, unknown>)
      return check.isAllowed ? next(e) : { deny: check.reason }
    }
    const ran = await next(e)
    if (EDIT_TOOLS.has(String(e.tool)) && ran.deny === undefined && ran.isError !== true) await noteEdit($)
    return ran
  }).catch(($, e, next) =>
    next.called
      ? next(e)
      : live.role === 'tester'
        ? { deny: 'stress-scout guard: the check failed, so the call is refused' }
        : next(e),
  )

  on('tool.check', async ($, e, next) => {
    if (live.role !== 'tester' || e.tool_use_id === undefined) return next(e)
    const input = e.input !== null && typeof e.input === 'object' ? (e.input as Record<string, unknown>) : {}
    const check = await testerCheck($, e.tool, input)
    return check.isAllowed
      ? { decision: 'allow', reason: 'stress-scout: inside the tester sandbox' }
      : { decision: 'deny', reason: check.reason }
  }).catch(($, e, next) =>
    live.role === 'tester'
      ? { decision: 'deny', reason: 'stress-scout guard: the check failed, so the call is refused' }
      : next(e),
  )

  on('prompt.submit', async ($, e, next) => {
    if (live.role === 'tester') return next(e)
    const match = e.command || e.text.includes(HANDOFF_DETAILS) ? null : HANDOFF.exec(e.text)
    const context = match !== null ? await handoff($, Number(match[1])) : undefined
    return context === undefined ? next(e) : next({ ...e, context: [...(e.context ?? []), context] })
  })

  on('command.run', { command: 'stress' }, async ($, e) => ({ text: await runCommand($, e.args.trim()) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (live.role === 'tester' || e.props.hasSurvey) return next(e)
    const [findings, seenId] = await Promise.all([read($, findingsAtom), read($, seenAtom)])
    const finding = findings.find(f => f.status === 'new' && isActionable(f.verdict) && f.id > seenId)
    if (finding === undefined) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const delta = finding.before !== '' && finding.after !== '' ? ` (${finding.before} → ${finding.after})` : ''
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={verdictColor(finding.verdict)} bold>
            {`stress-scout #${finding.id} ${finding.verdict}`}
          </Text>
          <Text wrap="truncate-end">{`${finding.target}: ${finding.headline}`}</Text>
        </Box>
        {finding.fixSummary !== '' && (
          <Text dimColor wrap="truncate-end">
            {`${finding.isVerified ? 'verified fix' : 'unverified fix'}: ${finding.fixSummary}${delta}`}
          </Text>
        )}
        <Box flexDirection="row" gap={1}>
          {finding.patch !== '' && (
            <Button key="apply" label="Apply via Claude" variant="primary" hotkey="a" onPress={() => void apply($, finding.id)} />
          )}
          <Button key="details" label="Details" hotkey="d" onPress={() => void showPane($, finding.id)} />
          <Button key="dismiss" label="Dismiss" hotkey="x" onPress={() => void dismiss($, finding.id)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const { config } = live
    const [phase, findings, activity, runsUsed, tokens, spent, paused, openId, run] = await Promise.all([
      read($, phaseAtom),
      read($, findingsAtom),
      read($, activityAtom),
      read($, runsUsedAtom),
      read($, tokensAtom),
      read($, dollarsAtom),
      read($, pausedAtom),
      read($, openAtom),
      read($, runAtom),
    ])
    const state =
      phase.kind === 'off'
        ? `off: ${phase.detail}`
        : phase.kind === 'test'
          ? `testing ${phase.detail} (since ${clockTime(run?.startedAt ?? phase.since)})`
          : paused
            ? 'paused'
            : phase.kind === 'triage'
              ? 'triaging the latest change'
              : 'watching'
    const mode = config.isSweeping ? 'changes + idle sweeps' : 'changes only'
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold wrap="truncate-end">{`stress-scout · ${state}`}</Text>
          <Text dimColor wrap="truncate-end">
            {`automatic runs ${runsUsed}/${config.maxRuns} · ${dollars(spent)} · ${compactTokens(tokens)} tokens · ${mode}`}
          </Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          {run !== null ? (
            <Button key="stop" label="Stop test" onPress={() => void stopTester($)} />
          ) : (
            <Button key="run" label="Run now" onPress={() => void runNow($)} />
          )}
          <Button key="pause" label={paused ? 'Resume' : 'Pause'} onPress={() => void togglePause($, !paused)} />
        </Box>
        {findings.length === 0 && (
          <Text dimColor>
            No findings yet. stress-scout tests risky changes as they land and sweeps untested code while the session is
            idle. Type /stress to run one now.
          </Text>
        )}
        {findings.slice(0, 12).map(f => {
          const isOpen = openId === f.id
          const delta = f.before !== '' && f.after !== '' ? ` (${f.before} → ${f.after})` : ''
          const cost = f.cost > 0 ? ` · ${dollars(f.cost)}` : ''
          return (
            <Box key={`finding-${f.id}`} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Text color={verdictColor(f.verdict)} bold>{`#${f.id} ${f.verdict}`}</Text>
                <Text wrap="truncate-end" dimColor={f.status !== 'new'}>
                  {`${f.target} · ${f.kind}${f.status !== 'new' ? ` · ${f.status}` : ''}`}
                </Text>
              </Box>
              <Text wrap={isOpen ? 'wrap' : 'truncate-end'}>{f.headline}</Text>
              {f.fixSummary !== '' && (
                <Text dimColor wrap={isOpen ? 'wrap' : 'truncate-end'}>
                  {`${f.isVerified ? 'verified fix' : 'unverified fix'}: ${f.fixSummary}${delta}`}
                </Text>
              )}
              {isOpen && (
                <Box flexDirection="column">
                  {f.evidence !== '' && <Text>{`Evidence: ${f.evidence}`}</Text>}
                  {f.before !== '' && <Text>{`Before: ${f.before}`}</Text>}
                  {f.after !== '' && <Text>{`After: ${f.after}`}</Text>}
                  {f.fixExplanation !== '' && <Text>{`Why it works: ${f.fixExplanation}`}</Text>}
                  {f.nextStep !== '' && <Text>{`Next step: ${f.nextStep}`}</Text>}
                  <Text dimColor>{`Harness: ${f.snapshot}/.stress-scout/${f.rerun !== '' ? `  ·  rerun: ${f.rerun}` : ''}`}</Text>
                  <Text dimColor>{`Took ${ago(f.durationMs)} · ${compactTokens(f.tokens)} tokens${cost} · confidence ${f.confidence}`}</Text>
                  {f.patch !== '' && <Code source={clip(f.patch, 12_000)} format="diff" language="diff" />}
                </Box>
              )}
              <Box flexDirection="row" gap={1}>
                {f.status === 'new' && f.patch !== '' && (
                  <Button key={`apply-${f.id}`} label="Apply via Claude" variant="primary" onPress={() => void apply($, f.id)} />
                )}
                <Button key={`open-${f.id}`} label={isOpen ? 'Less' : 'Details'} onPress={() => void showPane($, f.id)} />
                {f.status === 'new' && (
                  <Button key={`dismiss-${f.id}`} label="Dismiss" onPress={() => void dismiss($, f.id)} />
                )}
              </Box>
            </Box>
          )
        })}
        {activity.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Activity</Text>
            {activity.slice(0, 10).map(item => (
              <Text dimColor wrap="truncate-end">{`${clockTime(item.at)} ${item.text}`}</Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
