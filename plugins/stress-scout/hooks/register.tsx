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

import type { Discovery, DiscoveryPlan, Finding, Idea, LedgerEntry, Phase, Run, Trigger, Verdict } from '../types'
import { checkBash, checkRead, checkWrite, type Check, type Sandbox } from './lib/policy'
import {
  DISCOVERY_SYSTEM,
  HANDOFF,
  HANDOFF_DETAILS,
  IDEA_SYSTEM,
  TESTER_SYSTEM,
  TRIAGE_SYSTEM,
  changeTriagePrompt,
  discoveryTask,
  emptyMemory,
  handoffContext,
  handoffMessage,
  handoffPrompt,
  sweepTriagePrompt,
  testerTask,
  type Memory,
} from './lib/prompts'
import {
  HYPOTHESES_FILE,
  answerText,
  checkPreRegistration,
  checkWeb,
  sourcesOf,
  fingerprintOf,
  fromLedger,
  ideaQuestion,
  numbersLine,
  questionKey,
  renderLedger,
  type Registered,
} from './lib/discovery'
import { vetIdea } from './lib/ideas'
import { rankCandidates } from './lib/rank'
import {
  isActionable,
  parseDiscovery,
  parseReport,
  parseToolUses,
  parseStreamLine,
  parseTriage,
  type IdeaDraft,
  type TesterResult,
  type Triage,
} from './lib/report'
import {
  blobsOf,
  changedPaths,
  churn,
  diffStat,
  diffText,
  fingerprintOrRebuild,
  hasTree,
  headTree,
  listTree,
  makeSnapshot,
  openShadow,
  patchOf,
  type Shadow,
} from './lib/shadow'
import { homeFolder, isWindowsPath, portable, removeTree, tempRoot, windowsCanonical } from './lib/platform'
import { ago, basename, clip, clockTime, compactTokens, fnv, isInside, oneLine, slug, trimSlash } from './lib/util'

type $ = EngineInterface

const PANE = 'stress-scout'
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const TESTER_TOOLS = 'Bash,Read,Write,Edit'
const WEB_TOOLS = 'WebSearch,WebFetch'
const KEEP_RUNS = 8
const NO_CHANGE = 'no change since the last scan'

const phaseAtom = atom({ plugin: 'stress-scout', key: 'phase' } as const, { kind: 'idle', detail: '', since: 0 })
const findingsAtom = atom({ plugin: 'stress-scout', key: 'findings' } as const, [])
const ideasAtom = atom({ plugin: 'stress-scout', key: 'ideas' } as const, [])
const ideasUsedAtom = atom({ plugin: 'stress-scout', key: 'ideasUsed' } as const, 0)
const activityAtom =atom({ plugin: 'stress-scout', key: 'activity' } as const, [])
const runAtom = atom({ plugin: 'stress-scout', key: 'run' } as const, null)
const runsUsedAtom = atom({ plugin: 'stress-scout', key: 'runsUsed' } as const, 0)
const sweepsUsedAtom = atom({ plugin: 'stress-scout', key: 'sweepsUsed' } as const, 0)
const tokensAtom = atom({ plugin: 'stress-scout', key: 'tokensUsed' } as const, 0)
const dollarsAtom = atom({ plugin: 'stress-scout', key: 'dollarsUsed' } as const, 0)
const pausedAtom = atom({ plugin: 'stress-scout', key: 'paused' } as const, false)
const seenAtom = atom({ plugin: 'stress-scout', key: 'seenId' } as const, 0)
const openAtom = atom({ plugin: 'stress-scout', key: 'openId' } as const, 0)
const suggestedAtom = atom({ plugin: 'stress-scout', key: 'suggestedId' } as const, 0)
const waitingAtom = atom({ plugin: 'stress-scout', key: 'waiting' } as const, '')
const discoveriesAtom = atom({ plugin: 'stress-scout', key: 'discoveries' } as const, [])
const discoveryPlanAtom = atom({ plugin: 'stress-scout', key: 'discoveryPlan' } as const, null)
const discoveriesUsedAtom = atom({ plugin: 'stress-scout', key: 'discoveriesUsed' } as const, 0)

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
  isAutoApplying: boolean
  isOpeningPane: boolean
  maxDollarsPerRun: number
  claudePath: string
  rateLimitPct: number
  testerTimeoutMs: number
  isSuggesting: boolean
  maxIdeas: number
  isReadingSources: boolean
  isDiscoveringWhenIdle: boolean
  maxDollarsPerDiscovery: number
  maxDiscoveries: number
}

type Ctx = {
  root: string
  /** The project is on Windows: paths compare in any case, folders link as junctions. */
  isWindows: boolean
  home: string
  scratch: string
  shadow: Shadow
  projectKey: string
  rootSpellings: string[]
  scratchSpellings: string[]
}

type Plan = { plan: Triage; tokens: number; base: string }

type Outcome = { answer: string; cost: number; tokens: number; failure: string; steps: number; registered?: Registered }

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
    isAutoApplying: options.autoApplyVerifiedFixes !== false,
    isOpeningPane: options.openPaneOnStart !== false,
    maxDollarsPerRun: numberOf(options.maxDollarsPerRun, 2, 0.05, 100),
    claudePath: typeof options.claudePath === 'string' ? options.claudePath.trim() : '',
    rateLimitPct: numberOf(options.pauseAtRateLimitPercent, 80, 1, 101),
    testerTimeoutMs: numberOf(options.testerTimeoutMinutes, 20, 2, 120) * 60_000,
    isSuggesting: options.suggestImprovements !== false,
    maxIdeas: numberOf(options.maxIdeasPerSession, 5, 0, 100),
    isReadingSources: options.discoverSources !== false,
    isDiscoveringWhenIdle: options.discoverWhenIdle === true,
    maxDollarsPerDiscovery: numberOf(options.maxDollarsPerDiscovery, 5, 0.05, 100),
    maxDiscoveries: numberOf(options.maxDiscoveriesPerSession, 2, 0, 50),
  }
}

/** What this load of the module keeps between events; `$.state` holds what drawings read. */
const live = {
  role: 'scout' as 'scout' | 'tester',
  box: undefined as Sandbox | undefined,
  /** inside a discovery tester that may use the web tools */
  hasWeb: false,
  /** what this discovery tester's searches returned, and how many it made */
  web: { sources: new Set<string>(), queries: new Set<string>() },
  config: configOf({}),
  ctx: undefined as Ctx | undefined,
  ctxError: '',
  ctxTriedAt: 0,
  quietTimer: undefined as Timer | undefined,
  idleTimer: undefined as Timer | undefined,
  retryTimer: undefined as Timer | undefined,
  watchTimer: undefined as Timer | undefined,
  autoTimer: undefined as Timer | undefined,
  stopTester: undefined as (() => void) | undefined,
  /** openPaneOnStart has placed the pane once this load; closing it afterwards is the person's call. */
  isPaneShown: false,
  firstDirtyAt: 0,
  lastActivityAt: 0,
  isMainBusy: false,
  isCycling: false,
  pending: undefined as Trigger | undefined,
  pendingFocus: undefined as string | undefined,
  /** ideas the idle pick has already asked about this session */
  researched: new Set<number>(),
  /** the suggestion a queued /stress try is for */
  pendingIdea: undefined as number | undefined,
  /** files changed in scans this session, newest last: the only ones an idea may touch */
  recentEdits: [] as string[],
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
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && isAbsolutePath(v)) : []
  } catch {
    return []
  }
}

/** A snapshot folder is never a project of its own: no scout runs inside one. */
const isSnapshotPath = (path: string): boolean => /[\\/]stress-scout[\\/][^\\/]+[\\/]runs[\\/]run-\d+-\d+([\\/]|$)/.test(path)

/** An absolute path, POSIX or Windows (`C:\` or `C:/`; a `\\` network path counts too). */
const isAbsolutePath = (path: string): boolean => path.startsWith('/') || isWindowsPath(path)

/** Whether `path` is `dir` or inside it, comparing as the platform does (Windows ignores case and the separator). */
const isWithin = (path: string, dir: string, isWindows: boolean): boolean =>
  isWindows ? isInside(windowsCanonical(path), windowsCanonical(dir)) : isInside(path, dir)

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
    const home = await homeFolder($)
    const isWindows = isWindowsPath(root)
    const isRootFolder = root === '' || root === '/' || /^[A-Za-z]:[\\/]?$/.test(root)
    if (isRootFolder || (home !== '' && isWithin(home, root, isWindows))) {
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
    const tmp = await tempRoot($, isWindows)
    const projectKey = fnv(root)
    const given = `${tmp}/stress-scout/${slug(basename(root))}-${projectKey}`
    await $.fs.write(`${given}/.keep`, '')
    const scratch = trimSlash((await $.fs.stat(given, { resolve: true })).realPath ?? given)
    const rootReal = trimSlash((await $.fs.stat(root, { resolve: true })).realPath ?? root)
    if (isWithin(scratch, root, isWindows) || isWithin(scratch, rootReal, isWindows)) {
      live.ctxError = `${isWindows ? 'TEMP' : 'TMPDIR'} is inside the project; point it elsewhere`
      return undefined
    }
    const shadow = await openShadow($, root, scratch)
    live.ctx = {
      root,
      isWindows,
      home,
      scratch,
      shadow,
      projectKey,
      rootSpellings: unique([root, rootReal]),
      scratchSpellings: unique([scratch, trimSlash(given)]),
    }
    live.ctxError = ''
    await syncLedger($, live.ctx).catch(() => undefined)
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

// ---- the discovery ledger: what this project has asked, answered or given up on ---------

const ledgerKeyOf = (c: Ctx): string => `disc:${c.projectKey}`

async function loadLedger($: $, c: Ctx): Promise<LedgerEntry[]> {
  const raw = await $.store.get(ledgerKeyOf(c))
  const entries = raw !== null && typeof raw === 'object' ? (raw as { entries?: unknown }).entries : undefined
  return Array.isArray(entries) ? (entries as LedgerEntry[]) : []
}

async function syncLedger($: $, c: Ctx): Promise<void> {
  const entries = await loadLedger($, c)
  await update($, discoveriesAtom, () => entries.slice(0, 20))
}

async function saveLedger($: $, c: Ctx, entries: LedgerEntry[]): Promise<void> {
  const kept = entries.slice(0, 100)
  await $.store.set(ledgerKeyOf(c), { v: 1, entries: kept })
  await update($, discoveriesAtom, () => kept.slice(0, 20))
}

/** The sha of every file in a tree: what a ledger fingerprint is made of. */
async function shasOf($: $, c: Ctx, tree: string): Promise<Map<string, string>> {
  return new Map((await listTree($, c.shadow, tree)).map(file => [file.path, file.sha] as const))
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

const WINDOW_NAMES: Readonly<Record<string, string>> = {
  five_hour: '5-hour usage window',
  seven_day: 'weekly usage window',
  spend_limit: 'spend limit',
}

/** The usage window at or past the pause point, by name: the 5-hour, the weekly, or a gateway's spend limit. */
async function fullWindow($: $): Promise<string | undefined> {
  try {
    const { rateLimits } = await $.session.usage()
    const full = rateLimits.find(limit => limit.percentUsed >= live.config.rateLimitPct)
    return full === undefined ? undefined : (WINDOW_NAMES[full.kind] ?? full.kind.replace(/_/g, ' '))
  } catch {
    return undefined
  }
}

/**
 * Whether the session bills a Claude plan: its credential is a claude.ai
 * login's token, not an API key. Where the engine won't say, a plan's own
 * 5-hour or weekly window tells, once a reply has reported one.
 */
async function isOnPlan($: $): Promise<boolean> {
  try {
    return (await $.session.authorize())?.kind === 'bearer'
  } catch {
    const { rateLimits } = await $.session.usage().catch(() => ({ rateLimits: [] }))
    return rateLimits.some(limit => limit.kind === 'five_hour' || limit.kind === 'seven_day')
  }
}

// ---- the tester's guard (tester role) -----------------------------------------------

async function loadSandbox($: $): Promise<Sandbox | undefined> {
  const roots = listOf(await $.env.get('STRESS_SCOUT_ROOTS'))
  const runDirs = listOf(await $.env.get('STRESS_SCOUT_RUN_DIRS'))
  const home = trimSlash((await $.env.get('STRESS_SCOUT_HOME')) ?? '')
  return roots.length > 0 && runDirs.length > 0 ? { roots, runDirs, home } : undefined
}

/**
 * Where a file path lands once links resolve, walking up to the nearest folder
 * that exists. Undefined for what the spelling alone can't place: a relative
 * path, `.` or `..`, a drive-relative `C:x`, a `\\` network or device path, a
 * `file:stream` alternate data stream.
 */
async function placed($: $, path: string): Promise<string | undefined> {
  const isPlaceable =
    isAbsolutePath(path) &&
    !/^[\\/]{2}/.test(path) &&
    !/(^|[\\/])\.\.?([\\/]|$)/.test(path) &&
    !(isWindowsPath(path) && /^[A-Za-z]:[^:]*:/.test(path))
  if (!isPlaceable) return undefined
  const own = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  if (own?.realPath !== undefined) return own.realPath
  let dir = trimSlash(path)
  let rest = ''
  for (;;) {
    const cut = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'))
    if (cut < 0) return undefined
    rest = rest === '' ? dir.slice(cut + 1) : `${dir.slice(cut + 1)}/${rest}`
    dir = dir.slice(0, cut)
    // a root keeps its separator: `C:` alone is wherever drive C: last was
    const folder = dir === '' ? '/' : /^[A-Za-z]:$/.test(dir) ? `${dir}\\` : dir
    const stat = await $.fs.stat(folder, { resolve: true }).catch(() => undefined)
    if (stat?.realPath !== undefined) return `${trimSlash(stat.realPath)}/${rest}`
    if (folder === '/' || /^[A-Za-z]:\\$/.test(folder)) return undefined
  }
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
    case 'Read': {
      const path = text('file_path')
      const real = isAbsolutePath(path) ? (await $.fs.stat(path, { resolve: true }).catch(() => undefined))?.realPath : undefined
      return checkRead(path, box, real)
    }
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
    case 'WebSearch':
    case 'WebFetch':
      return live.hasWeb ? checkWeb(tool, input, live.web) : refuse(`${tool} is only for a discovery run with fresh sources on`)
    default:
      return refuse(`${tool} is not part of the tester's toolkit`)
  }
}

// ---- the cycle: fingerprint, triage, test (scout role) -------------------------------

async function triage(
  $: $,
  prompt: string,
  isAskingIdea = false,
): Promise<{ plan?: Triage; tokens: number; error?: string }> {
  const reply = await $.model.complete({
    model: live.config.triageModel,
    system: isAskingIdea ? `${TRIAGE_SYSTEM}\n\n${IDEA_SYSTEM}` : TRIAGE_SYSTEM,
    prompt,
    maxTokens: isAskingIdea ? 900 : 700,
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

/** The project's tree as it stands, through a shadow that is rebuilt when damaged. */
async function currentTree($: $, c: Ctx): Promise<string> {
  const { shadow, tree } = await fingerprintOrRebuild($, c.shadow)
  c.shadow = shadow
  return tree
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

  // a shadow rebuilt since the last session (its scratch folder cleaned) no longer holds the tree remembered then
  const remembered = memory.lastTree !== '' && (await hasTree($, c.shadow, memory.lastTree)) ? memory.lastTree : ''
  const base = remembered !== '' ? remembered : await headTree($, c.shadow)
  if (base !== '' && base !== tree) {
    const paths = await changedPaths($, c.shadow, base, tree)
    if (paths.length > 0) {
      const stat = await diffStat($, c.shadow, base, tree)
      const diff = await diffText($, c.shadow, base, tree, [], 24_000)
      live.recentEdits = unique([...live.recentEdits, ...paths]).slice(-40)
      const edits = config.isSuggesting ? live.recentEdits : undefined
      const result = await triage($, changeTriagePrompt({ intent, memory, now, currentHashes, stat, diff, edits }), edits !== undefined)
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

const tempEnv = (dir: string, isWindows: boolean): Record<string, string> =>
  isWindows ? { TMPDIR: dir, TEMP: dir, TMP: dir } : { TMPDIR: dir }

/** The headless tester's command line: few tools, no MCP, no skills, a budget, the guard loaded. */
function testerArgv($: $, exec: string, run: Run): string[] {
  const { testerModel, isReadingSources } = live.config
  const isDiscovery = run.question !== ''
  const maxDollars = isDiscovery ? live.config.maxDollarsPerDiscovery : live.config.maxDollarsPerRun
  return [
    exec,
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    ...(testerModel === 'inherit' ? [] : ['--model', testerModel]),
    ...(testerModel === 'haiku' ? [] : ['--effort', 'medium']),
    '--permission-mode', 'dontAsk',
    '--tools', isDiscovery && isReadingSources ? `${TESTER_TOOLS},${WEB_TOOLS}` : TESTER_TOOLS,
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--setting-sources', 'user',
    '--max-turns', isDiscovery ? '90' : '60',
    '--max-budget-usd', String(maxDollars),
    '--add-dir', run.runDir,
    '--plugin-dir', $.plugin.root,
    '--append-system-prompt', isDiscovery ? DISCOVERY_SYSTEM : TESTER_SYSTEM,
  ]
}

/** Runs the tester process to its end (or the deadline, or a Stop), then files what it found. */
async function superviseTester($: $, c: Ctx, run: Run, prompt: string): Promise<void> {
  const { config } = live
  const exec = config.claudePath !== '' ? config.claudePath : ((await $.env.get('CLAUDE_CODE_EXECPATH')) ?? '') || 'claude'
  const box = sandboxOf(c, run)
  const isPlan = await isOnPlan($)
  const isDiscovery = run.question !== ''
  const env = {
    STRESS_SCOUT_ROLE: 'tester',
    STRESS_SCOUT_ROOTS: JSON.stringify(box.roots),
    STRESS_SCOUT_RUN_DIRS: JSON.stringify(box.runDirs),
    STRESS_SCOUT_HOME: box.home,
    ...(isDiscovery && config.isReadingSources ? { STRESS_SCOUT_WEB: '1' } : {}),
    // Windows programs read TEMP and TMP; Git Bash and the rest read TMPDIR
    ...tempEnv(c.isWindows ? portable(`${run.runDir}/tmp`) : `${run.runDir}/tmp`, c.isWindows),
    // claude -p bills an ANTHROPIC_API_KEY it finds in the environment without asking, where a session
    // asks first: on a plan login an empty one keeps the tester billing the plan, as the session does
    ...(isPlan ? { ANTHROPIC_API_KEY: '' } : {}),
  }
  let result: TesterResult | undefined
  let steps = 0
  let stderrTail = ''
  let failure = ''
  let isStopped = false
  // a discovery run's hypotheses file: what the scout saw of it, and how many experiments had begun when it appeared
  const hypothesesPath = `${run.snapshot}/${HYPOTHESES_FILE}`
  let seen: Omit<Registered, 'finalHash'> | undefined
  let experiments = 0
  let stopReason = ''
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
      if (isDiscovery) {
        if (seen === undefined && (await $.fs.exists(hypothesesPath).catch(() => false))) {
          const text = await $.fs.read(hypothesesPath).catch(() => '')
          seen = { hash: fnv(text), at: await $.clock.now(), text: clip(text, 20_000), experimentsBefore: experiments }
          await log($, `#${run.id}: hypotheses registered (${seen.hash}) after ${experiments} experiments`)
        }
        for (const use of parseToolUses(line)) {
          if (use.name === 'Bash' || (EDIT_TOOLS.has(use.name) && !use.target.endsWith(HYPOTHESES_FILE))) experiments += 1
        }
      }
      const event = parseStreamLine(line)
      if (event.result !== undefined) result = event.result
      if (event.toolUses === 0) return
      const before = steps
      steps += event.toolUses
      if (Math.floor(steps / 5) > Math.floor(before / 5)) {
        await setPhase($, 'test', `${clip(run.target, 50)} (${run.kind}) · step ${steps}`)
        // a discovery spends the longest: it also stops where the automatic runs pause
        const full = isDiscovery ? await fullWindow($) : undefined
        if (full !== undefined) {
          stopReason = `stopped: your ${full} reached ${config.rateLimitPct}%`
          endEarly('deadline')
        }
      }
    }
    for (;;) {
      const step = await Promise.race([stream.next(), early])
      if (step === 'deadline') {
        failure = stopReason || (isStopped ? 'stopped before it finished' : `timed out after ${ago(config.testerTimeoutMs)}`)
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
        ? `stopped at the ${dollars(isDiscovery ? config.maxDollarsPerDiscovery : config.maxDollarsPerRun)} budget for one ${isDiscovery ? 'discovery' : 'run'}`
        : result.subtype === 'error_max_turns'
          ? 'ran out of turns before finishing'
          : `ended with ${result.subtype || 'an error'}`
  }
  let registered: Registered | undefined
  if (seen !== undefined) {
    const last = await $.fs.read(hypothesesPath).catch(() => seen?.text ?? '')
    registered = { ...seen, finalHash: fnv(last) }
  }
  await finishRun($, run, { answer: result?.text ?? '', cost: result?.cost ?? 0, tokens: result?.tokens ?? 0, failure, steps, registered })
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
  /** the suggestion this run builds (`/stress try N`), or the one a discovery researches */
  idea?: Idea
  /** set for a discovery run: the question it researches */
  question?: string
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
    fromIdea: args.idea?.id ?? 0,
    question: args.question ?? '',
  }
  await update($, runAtom, () => run)
  await update($, tokensAtom, n => n + args.tokens)
  // a tried idea counts toward the cap like an automatic run, though the person asked for it
  if (args.question === undefined && (args.trigger !== 'manual' || args.idea !== undefined)) {
    await update($, runsUsedAtom, n => n + 1)
    if (args.trigger === 'sweep') await update($, sweepsUsedAtom, n => n + 1)
  }
  live.lastRunStartedAt = startedAt
  await setPhase($, 'test', `${clip(args.plan.target, 50)} (${args.plan.kind})`)
  await log($, `#${args.id} ${args.trigger}: testing ${args.plan.target} (${args.plan.kind}): ${args.plan.why}`)
  const paths = {
    snapshot: c.isWindows ? portable(snapshot) : snapshot,
    runDir: c.isWindows ? portable(runDir) : runDir,
    root: c.isWindows ? portable(c.root) : c.root,
    linkedDeps: linked,
    isWindows: c.isWindows,
  }
  const prompt =
    args.question !== undefined
      ? discoveryTask({
          ...paths,
          id: args.id,
          question: args.question,
          files: args.plan.files,
          intent: args.intent,
          hasSources: live.config.isReadingSources,
          idea: args.idea,
        })
      : testerTask({
          ...paths,
          id: args.id,
          trigger: args.trigger,
          plan: args.plan,
          intent: args.intent,
          diff: args.diff,
          idea: args.idea,
        })
  void superviseTester($, c, run, prompt)
}

/** The tester's brief for `/stress try N`: build the suggestion in the sandbox, targeting its files. */
const ideaPlan = (idea: Idea): Plan => ({
  plan: {
    isWorth: true,
    risk: 'high',
    target: idea.title,
    files: idea.files,
    kind: 'edge',
    why: idea.why,
    attack: '',
    skip: '',
  },
  tokens: 0,
  base: '',
})

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

async function setIdeaStatus($: $, id: number, status: Idea['status'], from?: Idea['status']): Promise<void> {
  await update($, ideasAtom, list => list.map(i => (i.id === id && (from === undefined || i.status === from) ? { ...i, status } : i)))
}

/** Files the triage model's idea when it clears the guardrails, the session cap and what was dismissed before. */
async function offerIdea($: $, c: Ctx, tree: string, memory: Memory, draft: IdeaDraft | undefined): Promise<void> {
  const { config } = live
  if (!config.isSuggesting || draft === undefined || !vetIdea(draft, live.recentEdits).isOk) return
  if ((await read($, ideasUsedAtom)) >= config.maxIdeas) return
  await fileIdea($, c, tree, memory, draft)
}

/** Adds an idea that cleared its guardrails to the list, unless the same code already has it or it was dismissed. */
async function fileIdea($: $, c: Ctx, tree: string, memory: Memory, draft: IdeaDraft): Promise<boolean> {
  const files = unique(draft.files).sort()
  const blobs = await blobsOf($, c.shadow, tree, files)
  if (!files.every(file => blobs.has(file))) return false
  const memoryKey = files.join(',')
  const hash = fnv(files.map(file => `${file}:${blobs.get(file) ?? ''}`).join('|'))
  if (memory.dismissed[`${memoryKey}|idea`]?.hash === hash) return false
  if ((await read($, ideasAtom)).some(i => i.memoryKey === memoryKey && i.hash === hash)) return false
  const idea: Idea = {
    id: memory.nextId,
    at: await $.clock.now(),
    title: draft.title,
    why: draft.why,
    files,
    size: draft.size === 'M' ? 'M' : 'S',
    status: 'new',
    memoryKey,
    hash,
  }
  memory.nextId += 1
  await update($, ideasAtom, list => [idea, ...list].slice(0, 12))
  await update($, ideasUsedAtom, n => n + 1)
  await log($, `idea #${idea.id} (${idea.size}): ${idea.title}`)
  return true
}

async function tryIdea($: $, id: number): Promise<string> {
  const idea = (await read($, ideasAtom)).find(i => i.id === id)
  if (idea === undefined) return `No idea #${id}.`
  if (idea.status === 'dismissed') return `Idea #${id} was dismissed.`
  if (idea.status === 'trying') return `Idea #${id} is already being tried.`
  await setIdeaStatus($, id, 'trying')
  await update($, seenAtom, seen => Math.max(seen, id))
  $.clock.after(0, () => void kick($, 'manual', idea.title, id))
  const run = await read($, runAtom)
  return run !== null
    ? `Trying idea #${id} after the test of ${run.target} (#${run.id}).`
    : `Trying idea #${id} in the sandbox. The result lands in /stress show.`
}

async function cycle($: $, trigger: Trigger, focus?: string, ideaId?: number): Promise<void> {
  const { config } = live
  const isManual = trigger === 'manual'
  if (!isManual) {
    if (await read($, pausedAtom)) return
    if ((await read($, runsUsedAtom)) >= config.maxRuns) return
    const full = await fullWindow($)
    if (full !== undefined) {
      await log($, `${trigger}: skipped, your ${full} is at or above ${config.rateLimitPct}%`)
      await update($, waitingAtom, () => `your ${full} is at or above ${config.rateLimitPct}%; automatic runs resume below it`)
      return
    }
    const now = await $.clock.now()
    const gapLeft = live.lastRunStartedAt + config.minGapMs - now
    if (live.lastRunStartedAt > 0 && gapLeft > 0) {
      live.retryTimer?.cancel()
      live.retryTimer = $.clock.after(gapLeft + 1000, () => void kick($, trigger))
      const gap = `${Math.round(config.minGapMs / 60_000)}-minute gap between runs`
      await update($, waitingAtom, () => `next automatic run at ${clockTime(now + gapLeft + 1000)} (${gap})`)
      return
    }
  }
  await update($, waitingAtom, () => '')
  const c = await ensureCtx($)
  if (c === undefined) {
    await setPhase($, 'off', live.ctxError)
    return
  }
  await setPhase($, 'triage', focus !== undefined ? clip(focus, 60) : trigger)
  const tree = await currentTree($, c)
  live.seenTree = tree
  const memory = await loadMemory($, c)
  const intent = await recentIntent($)

  const idea = ideaId !== undefined ? (await read($, ideasAtom)).find(i => i.id === ideaId) : undefined
  let chosen: Plan | undefined
  let kind: Trigger = trigger
  if (idea !== undefined) {
    chosen = ideaPlan(idea)
  } else if (focus !== undefined && focus.trim() !== '') {
    chosen = manualPlan(focus)
  } else {
    const result = await choose($, c, trigger, tree, memory, intent)
    chosen = result.chosen
    kind = isManual ? 'manual' : result.kind
    if (chosen !== undefined && result.kind === 'change') await offerIdea($, c, tree, memory, chosen.plan.idea)
    if (chosen === undefined) {
      await saveMemory($, c, memory)
      if (!isManual && (kind === 'idle' || kind === 'sweep') && (await idleDiscovery($))) return
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
  const targetKey = sorted.length > 0 ? sorted.join(',') : clip(plan.target, 200)
  // a tried idea has its own memory: it must not mark the files tested, or hide them from the next scan
  const memoryKey = idea !== undefined ? clip(`idea:${targetKey}`, 200) : targetKey
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
  await startRun($, c, { id, trigger: kind, plan, tokens, intent, tree, diff, memoryKey, hash, idea })
}

async function kick($: $, trigger: Trigger, focus?: string, ideaId?: number): Promise<void> {
  if (live.isCycling || (await read($, runAtom)) !== null) {
    if (live.pending === undefined || PRIORITY[trigger] > PRIORITY[live.pending]) live.pending = trigger
    if (focus !== undefined) {
      live.pendingFocus = focus
      live.pendingIdea = ideaId
    }
    return
  }
  live.isCycling = true
  try {
    await cycle($, trigger, focus, ideaId)
  } catch (error) {
    await log($, `${trigger}: ${messageOf(error)}`)
    await setPhase($, 'idle')
  } finally {
    // an idea that never reached a tester goes back to waiting for another try
    if (ideaId !== undefined && (await read($, runAtom)) === null) await setIdeaStatus($, ideaId, 'new', 'trying')
    live.isCycling = false
    void drainPending($)
  }
}

async function drainPending($: $): Promise<void> {
  if (live.pending === undefined || live.isCycling || (await read($, runAtom)) !== null) return
  const trigger = live.pending
  const focus = live.pendingFocus
  const ideaId = live.pendingIdea
  live.pending = undefined
  live.pendingFocus = undefined
  live.pendingIdea = undefined
  $.clock.after(2000, () => void kick($, trigger, focus, ideaId))
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
    if (active?.runDir !== path) await removeTree($, path, c.isWindows, 120_000).catch(() => undefined)
  }
}

async function maybeSuggest($: $): Promise<void> {
  if (live.isMainBusy) return
  const [findings, suggested] = await Promise.all([read($, findingsAtom), read($, suggestedAtom)])
  const pending = findings.filter(f => f.status === 'new' && isActionable(f.verdict) && f.patch !== '')
  // a verified fix is handed over even when a newer, unverified one waits for approval
  const verified = pending.find(f => f.isVerified)
  if (live.config.isAutoApplying && verified !== undefined) armAutoApply($, verified.id)
  // the suggestion still shows while an automatic hand-off waits, so the person sees what is coming
  const finding = pending[0]
  if (finding === undefined || finding.id === suggested) return
  const shown = await $.prompt.suggest({ text: handoffPrompt(finding) }).catch(() => ({ isShown: false }))
  if (shown.isShown) await update($, suggestedAtom, () => finding.id)
}

/** autoApplyVerifiedFixes: hand a verified fix over once the session has sat idle; a new turn cancels it. */
function armAutoApply($: $, id: number): void {
  live.autoTimer?.cancel()
  live.autoTimer = $.clock.after(live.config.idleMs, () => {
    live.autoTimer = undefined
    void autoApply($, id)
  })
}

async function autoApply($: $, id: number): Promise<void> {
  if (live.isMainBusy || (await read($, pausedAtom))) return
  const finding = (await read($, findingsAtom)).find(f => f.id === id)
  if (finding === undefined || finding.status !== 'new') return
  await log($, `#${id}: verified fix handed to Claude automatically`)
  $.ui.toast(`stress-scout is handing verified fix #${id} to Claude`, { timeoutMs: 8000 })
  await handOff($, finding)
}

/** A finding Claude can act on: a fix to apply, or a next step for a real problem. */
const canHandOver = (f: Finding): boolean => f.patch !== '' || (isActionable(f.verdict) && f.nextStep !== '')

const handOverLabel = (f: Finding): string => (f.patch !== '' ? 'Apply via Claude' : 'Send to Claude')

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
  fromIdea: run.fromIdea,
  discovery: null,
})

async function finishRun($: $, run: Run, outcome: Outcome): Promise<void> {
  if (run.question !== '') return finishDiscovery($, run, outcome)
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
  if (run.fromIdea > 0) await setIdeaStatus($, run.fromIdea, 'tried', 'trying')
  if (isActionable(finding.verdict)) {
    $.ui.toast(`stress-scout #${run.id} ${finding.verdict}: ${clip(finding.headline, 120)}`, { timeoutMs: 8000 })
    await maybeSuggest($)
  } else if (run.fromIdea > 0) {
    $.ui.toast(`stress-scout tried idea #${run.fromIdea} (#${run.id} ${finding.verdict}): ${clip(finding.headline, 120)}`, { timeoutMs: 8000 })
  }
  await setPhase($, 'idle')
  if (c !== undefined) await cleanupRuns($, c)
  void drainPending($)
}

// ---- discovery: a question answered with evidence from this codebase ----------------------

const DISCOVERY_HYPOTHESES = 'to be written first: 2 to 4 competing ones, each with a prediction and a kill criterion, saved before any experiment runs'
const DISCOVERY_EXPERIMENT = 'the smallest harness in the sandbox that tells them apart, repeated at least 5 times, with median and spread'

const discoveryTriage = (plan: DiscoveryPlan): Triage => ({
  isWorth: true,
  risk: 'high',
  target: clip(plan.question, 200),
  files: plan.files,
  kind: 'discovery',
  why: '',
  attack: '',
  skip: '',
})

/** Code files the question names, and an idea's own: hints for the tester, not a limit. */
function hintFiles(question: string, shas: ReadonlyMap<string, string>, idea?: Idea): string[] {
  const named = [...shas.keys()].filter(path => question.includes(path) || (basename(path).length >= 5 && question.includes(basename(path))))
  return unique([...(idea?.files ?? []), ...named]).slice(0, 8)
}

/**
 * Turns a question into a plan. A question the ledger already answers at this code is answered
 * from it, with nothing run. Otherwise the plan waits in the pane for Run it, unless discoverWhenIdle is on.
 */
async function proposeDiscovery($: $, question: string, idea?: Idea, isHeld = false): Promise<string> {
  const { config } = live
  const text = clip(oneLine(question), 300)
  if (text === '') return 'Usage: /stress discover <question>'
  if (config.maxDiscoveries === 0) return 'Discovery is off: maxDiscoveriesPerSession is 0.'
  const c = await ensureCtx($)
  if (c === undefined) return `stress-scout is off: ${live.ctxError}`
  const key = questionKey(text)
  const shas = await shasOf($, c, await currentTree($, c))
  const known = fromLedger(await loadLedger($, c), key, files => fingerprintOf(shas, files))
  if (known !== undefined) return answerText(known)
  const used = await read($, discoveriesUsedAtom)
  if (used >= config.maxDiscoveries) return `This session's discovery cap is reached (${used}/${config.maxDiscoveries}).`
  const plan: DiscoveryPlan = {
    question: text,
    key,
    fromIdea: idea?.id ?? 0,
    files: hintFiles(text, shas, idea),
    hypotheses: DISCOVERY_HYPOTHESES,
    experiment: DISCOVERY_EXPERIMENT,
    cost: `up to ${dollars(config.maxDollarsPerDiscovery)} (the cap); most runs use a fraction of it`,
  }
  if (config.isDiscoveringWhenIdle) return runDiscovery($, plan, isHeld)
  await update($, discoveryPlanAtom, () => plan)
  await $.ui.open({ id: PANE, title: 'Stress Scout' }).catch(() => undefined)
  return [
    `Discovery plan for: ${text}`,
    `Hypotheses: ${plan.hypotheses}.`,
    `Experiment: ${plan.experiment}.`,
    `Cost: ${plan.cost}.`,
    `${config.isReadingSources ? 'It may read fresh sources on the web.' : 'It reads no web sources.'} Nothing runs until you press Run it in the pane.`,
  ].join('\n')
}

/** Starts a discovery that was approved (the press, or discoverWhenIdle). `isHeld`: the caller is already inside a cycle. */
async function runDiscovery($: $, plan: DiscoveryPlan, isHeld = false): Promise<string> {
  const { config } = live
  if (!isHeld && (live.isCycling || (await read($, runAtom)) !== null)) {
    await update($, discoveryPlanAtom, () => plan)
    return 'A test is running. Press Run it again when it has finished; the plan is kept.'
  }
  const used = await read($, discoveriesUsedAtom)
  if (used >= config.maxDiscoveries) return `This session's discovery cap is reached (${used}/${config.maxDiscoveries}).`
  const full = await fullWindow($)
  if (full !== undefined) return `Your ${full} is at or above ${config.rateLimitPct}%, so the discovery waits.`
  if (!isHeld) live.isCycling = true
  try {
    const c = await ensureCtx($)
    if (c === undefined) return `stress-scout is off: ${live.ctxError}`
    const tree = await currentTree($, c)
    const memory = await loadMemory($, c)
    const id = memory.nextId
    memory.nextId += 1
    await saveMemory($, c, memory)
    const idea = (await read($, ideasAtom)).find(i => i.id === plan.fromIdea)
    await update($, discoveryPlanAtom, () => null)
    await update($, discoveriesUsedAtom, n => n + 1)
    await setPhase($, 'triage', clip(plan.question, 60))
    await startRun($, c, {
      id,
      trigger: 'manual',
      plan: discoveryTriage(plan),
      tokens: 0,
      intent: await recentIntent($),
      tree,
      diff: '',
      memoryKey: `disc:${plan.key}`,
      hash: plan.key,
      idea,
      question: plan.question,
    })
    return `Researching "${clip(plan.question, 120)}" (#${id}). The result lands in /stress show.`
  } finally {
    if (!isHeld) {
      live.isCycling = false
      void drainPending($)
    }
  }
}

async function pressRunIt($: $): Promise<string> {
  const plan = await read($, discoveryPlanAtom)
  return plan === null ? 'No discovery plan is waiting.' : runDiscovery($, plan)
}

async function cancelPlan($: $): Promise<void> {
  await update($, discoveryPlanAtom, () => null)
}

/** discoverWhenIdle: with nothing else due, research the newest idea not asked about yet. True when a run started. */
async function idleDiscovery($: $): Promise<boolean> {
  const { config } = live
  if (!config.isDiscoveringWhenIdle || config.maxDiscoveries === 0) return false
  const idea = (await read($, ideasAtom)).find(i => i.status === 'new' && !live.researched.has(i.id))
  if (idea === undefined) return false
  live.researched.add(idea.id)
  await proposeDiscovery($, ideaQuestion(idea), idea, true)
  return (await read($, runAtom)) !== null
}

async function researchIdea($: $, id: number): Promise<string> {
  const idea = (await read($, ideasAtom)).find(i => i.id === id)
  return idea === undefined ? `No idea #${id}.` : proposeDiscovery($, ideaQuestion(idea), idea)
}

/** Files what a discovery run found: a `discovery` finding, a ledger entry, and at most one idea. */
async function finishDiscovery($: $, run: Run, outcome: Outcome): Promise<void> {
  const c = await ensureCtx($)
  const now = await $.clock.now()
  const report = parseDiscovery(outcome.answer)
  const registered = outcome.registered
  const reg =
    report !== undefined
      ? checkPreRegistration(report.hypotheses, registered)
      : {
          isPreRegistered: false,
          note:
            registered !== undefined
              ? 'a hypotheses file was seen, but the run ended without a report to compare it with'
              : 'not pre-registered: no hypotheses file was seen',
        }
  const isPartial = outcome.failure !== '' || report === undefined
  const survivor = report?.survivor ?? ''
  const discovery: Discovery = {
    question: run.question,
    hypotheses: report?.hypotheses ?? [],
    method: report?.method ?? '',
    numbers: report?.numbers ?? [],
    sources: report?.sources ?? [],
    survivor,
    effect: report?.effect ?? '',
    confidence: isPartial ? 'low' : (report?.confidence ?? 'low'),
    wouldChange: report?.wouldChange ?? '',
    isSurprising: report?.isSurprising === true && !isPartial,
    isPreRegistered: reg.isPreRegistered,
    preRegNote: reg.note,
    isPartial,
  }
  const said = report?.headline ?? ''
  const headline = isPartial
    ? `partial: ${outcome.failure || 'the tester finished without a report'}${said !== '' ? ` · ${said}` : ''}`
    : said || (survivor === '' ? 'no hypothesis survived' : `${survivor} survived`)
  const leftovers = report === undefined ? clip(oneLine(outcome.answer || outcome.failure), 300) : ''
  const written = report === undefined && registered !== undefined ? `hypotheses file: ${clip(oneLine(registered.text), 400)}` : ''
  const finding: Finding = {
    ...blankFinding(run, now),
    target: clip(run.question, 200),
    kind: 'discovery',
    verdict: isPartial ? 'inconclusive' : 'held',
    headline: clip(headline, 220),
    evidence: clip([numbersLine(discovery), written, leftovers].filter(part => part !== '').join(' · '), 900),
    rerun: report?.rerun ?? '',
    confidence: discovery.confidence,
    tokens: run.tokens + outcome.tokens,
    cost: outcome.cost,
    discovery,
  }
  await update($, findingsAtom, list => [finding, ...list.filter(f => f.id !== finding.id)].slice(0, 25))
  await update($, tokensAtom, n => n + outcome.tokens)
  await update($, dollarsAtom, n => n + outcome.cost)
  await update($, runAtom, () => null)
  let isIdeaFiled = false
  if (c !== undefined) {
    const tree = (await hasTree($, c.shadow, run.baseTree).catch(() => false)) ? run.baseTree : await currentTree($, c)
    const shas = await shasOf($, c, tree)
    const files = (report?.files ?? []).filter(file => shas.has(file))
    const entry: LedgerEntry = {
      key: run.hash,
      question: run.question,
      at: now,
      status: isPartial ? 'partial' : survivor === '' ? 'dead-end' : 'answered',
      headline: finding.headline,
      files,
      fingerprint: fingerprintOf(shas, files),
      isSurprising: discovery.isSurprising,
      discovery,
      rerun: finding.rerun,
    }
    const entries = [entry, ...(await loadLedger($, c)).filter(e => e.key !== entry.key)]
    await saveLedger($, c, entries)
    await $.fs.write(`${run.snapshot}/.stress-scout/discoveries.md`, renderLedger(entries)).catch(() => undefined)
    // a result that implies a change becomes one idea, which /stress try can build and measure
    if (report?.change !== undefined && !isPartial) {
      const draft: IdeaDraft = { ...report.change, value: 10, type: report.change.type === 'feature' ? 'feature' : 'refinement' }
      if (vetIdea(draft, draft.files).isOk) {
        const memory = await loadMemory($, c)
        isIdeaFiled = await fileIdea($, c, tree, memory, draft)
        await saveMemory($, c, memory)
      }
    }
  }
  const spent = outcome.cost > 0 ? `, ${dollars(outcome.cost)}` : ''
  await log($, `#${run.id} discovery${discovery.isSurprising ? ' (surprising)' : ''}: ${finding.headline} (${ago(finding.durationMs)}${spent})${isIdeaFiled ? ' · idea filed' : ''}`)
  $.ui.toast(`stress-scout discovery #${run.id}${discovery.isSurprising ? ' (surprising)' : ''}: ${clip(finding.headline, 120)}`, { timeoutMs: 8000 })
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
  await update($, waitingAtom, () => `scanning the change at ${clockTime(now + wait)}, once edits settle`)
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
  const tree = await currentTree($, c).catch(() => '')
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
  if (finding === undefined) {
    const isIdea = (await read($, ideasAtom)).some(i => i.id === id)
    return isIdea ? `Idea #${id} is untested: /stress try ${id} builds and checks it first.` : `No finding #${id}.`
  }
  if (finding.patch === '' && finding.nextStep === '') return `Finding #${id} has no fix to hand over.`
  // /stress apply's hook holds the turn a submitted prompt waits on: hand over once the command has answered
  $.clock.after(0, () => void handOff($, finding))
  return `Handing finding #${id} to Claude.`
}

/** Submits the handoff as the person's prompt; the finding counts as applied once it entered. */
async function handOff($: $, finding: Finding): Promise<void> {
  try {
    const entered = await $.prompt.submit({ text: handoffMessage(finding, await $.clock.now()), asUser: true })
    if (entered.drop !== undefined) {
      await log($, `#${finding.id} was not handed over: ${entered.drop}`)
      return
    }
    await update($, findingsAtom, list => list.map(f => (f.id === finding.id ? { ...f, status: 'applied' as const } : f)))
    await update($, seenAtom, seen => Math.max(seen, finding.id))
  } catch (error) {
    await log($, `#${finding.id} was not handed over: ${messageOf(error)}`)
    $.ui.toast(`stress-scout could not hand #${finding.id} to Claude: ${clip(messageOf(error), 120)}`, { timeoutMs: 8000 })
  }
}

async function dismissIdea($: $, idea: Idea): Promise<string> {
  await setIdeaStatus($, idea.id, 'dismissed')
  await update($, seenAtom, seen => Math.max(seen, idea.id))
  const c = await ensureCtx($)
  if (c !== undefined) {
    const memory = await loadMemory($, c)
    memory.dismissed[`${idea.memoryKey}|idea`] = { at: await $.clock.now(), hash: idea.hash }
    await saveMemory($, c, memory)
  }
  return `Dismissed idea #${idea.id}; it won't be suggested again unless that code changes.`
}

async function dismiss($: $, id: number): Promise<string> {
  const finding = (await read($, findingsAtom)).find(f => f.id === id)
  if (finding === undefined) {
    const idea = (await read($, ideasAtom)).find(i => i.id === id)
    return idea !== undefined ? dismissIdea($, idea) : `No finding #${id}.`
  }
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

/** openPaneOnStart: a session with no surface yet (the app, the SDK) is tried again when its first turn starts. */
async function autoOpenPane($: $): Promise<void> {
  if (!live.config.isOpeningPane || live.isPaneShown) return
  // with nothing attached (a -p run, an SDK host) ui.open has nowhere to place it and the engine logs an error
  if ((await $.session.surfaces()).length === 0) return
  const opened = await $.ui.open({ id: PANE, title: 'Stress Scout' }).catch(() => ({ isPlaced: false }))
  live.isPaneShown = opened.isPlaced
}

async function openPane($: $): Promise<string> {
  await $.ui.open({ id: PANE, title: 'Stress Scout' })
  return 'Stress Scout pane opened.'
}

/** What the next automatic run waits on, in words. */
function nextText(waiting: string, runsUsed: number): string {
  const { config } = live
  if (runsUsed >= config.maxRuns) return `the automatic cap (${runsUsed}/${config.maxRuns}) is reached; Run now still works`
  if (waiting !== '') return waiting
  return config.isSweeping
    ? 'tests the next risky edit, or sweeps untested code when the session goes idle'
    : 'tests the next risky edit'
}

async function statusText($: $): Promise<string> {
  const { config } = live
  const [phase, findings, ideas, runsUsed, tokens, spent, paused, run, waiting, plan, discoveries] = await Promise.all([
    read($, phaseAtom),
    read($, findingsAtom),
    read($, ideasAtom),
    read($, runsUsedAtom),
    read($, tokensAtom),
    read($, dollarsAtom),
    read($, pausedAtom),
    read($, runAtom),
    read($, waitingAtom),
    read($, discoveryPlanAtom),
    read($, discoveriesAtom),
  ])
  const now = await $.clock.now()
  const state =
    run !== null
      ? `Testing ${run.target} for ${ago(now - run.startedAt)}.`
      : paused
        ? 'Paused.'
        : phase.kind === 'off'
          ? `Off: ${phase.detail}.`
          : `Watching. Next: ${nextText(waiting, runsUsed)}.`
  const lines = [
    state,
    `automatic runs ${runsUsed}/${config.maxRuns} · ${dollars(spent)} and ${compactTokens(tokens)} tokens this session · triage ${config.triageModel}, tester ${config.testerModel}`,
  ]
  for (const f of findings.slice(0, 6)) {
    const flags = `${f.isVerified ? ' (fix verified)' : ''}${f.fromIdea > 0 ? ` (from idea #${f.fromIdea})` : ''}${f.status !== 'new' ? ` [${f.status}]` : ''}`
    lines.push(`#${f.id} ${f.verdict} ${f.target}: ${f.headline}${flags}`)
  }
  if (findings.length === 0) lines.push('No findings yet.')
  for (const idea of ideas.filter(i => i.status !== 'dismissed').slice(0, 3)) {
    lines.push(`idea #${idea.id} (${idea.size}) ${idea.title}${idea.status !== 'new' ? ` [${idea.status}]` : ''}`)
  }
  if (plan !== null) lines.push(`discovery plan waiting for Run it: ${clip(plan.question, 120)} (${plan.cost})`)
  for (const entry of discoveries.slice(0, 3)) {
    lines.push(`discovery [${entry.status}${entry.isSurprising ? ', surprising' : ''}] ${clip(entry.question, 80)}: ${entry.headline}`)
  }
  return lines.join('\n')
}

const HELP = [
  '/stress            stress-test the latest change now (a sweep when nothing changed; also /stress run or start)',
  '/stress <focus>    stress-test something specific, e.g. /stress the retry logic in api/client.ts',
  '/stress show       open the Stress Scout pane',
  '/stress status     what it is doing and what it found',
  '/stress apply N    hand finding N to Claude (patch and evidence attached)',
  '/stress dismiss N  drop finding or idea N; it is not raised again unless the code changes',
  '/stress try N      build idea N in the sandbox and measure it; the result is a finding that links back to it',
  '/stress discover Q research a question with hypotheses, measurements and fresh sources; shows a plan, you press Run it',
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
    case 'start':
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
      return Number.isInteger(n) && n > 0 ? dismiss($, n) : 'Usage: /stress dismiss <finding or idea number>'
    case 'try':
      return Number.isInteger(n) && n > 0 ? tryIdea($, n) : 'Usage: /stress try <idea number>'
    case 'discover':
      return proposeDiscovery($, args.slice(verb.length))
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
    live.hasWeb = (await $.env.get('STRESS_SCOUT_WEB')) === '1'
    live.web = { sources: new Set(), queries: new Set() }
    live.box = await loadSandbox($)
    return
  }
  await $.command.register({
    name: 'stress',
    description: 'stress-scout: stress-test the latest changes now (or a focus you name); show, status, stop, pause, resume, discover a question',
    argumentHint: '[focus | show | status | stop | pause | resume | apply N | try N | dismiss N | discover question | forget]',
  })
  const stale = await read($, runAtom)
  if (stale !== null) {
    // the tester process ended with the module it belonged to
    await finishRun($, stale, { answer: '', cost: 0, tokens: 0, failure: 'interrupted: stress-scout reloaded while it ran', steps: 0 })
  }
  live.watchTimer?.cancel()
  live.watchTimer = $.clock.every(60_000, () => void heartbeat($))
  await setPhase($, 'idle')
  await autoOpenPane($)
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
    for (const timer of [live.quietTimer, live.idleTimer, live.retryTimer, live.watchTimer, live.autoTimer]) timer?.cancel()
    live.stopTester?.()
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (live.role === 'scout' && e.agentId === undefined) {
      live.isMainBusy = true
      live.idleTimer?.cancel()
      live.idleTimer = undefined
      live.autoTimer?.cancel()
      live.autoTimer = undefined
      void autoOpenPane($)
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
      if (!check.isAllowed) return { deny: check.reason }
      if (e.tool !== 'WebSearch') return next(e)
      live.web.queries.add(String(e.query))
      const searched = await next(e)
      for (const source of sourcesOf(searched.result)) live.web.sources.add(source)
      return searched
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
    const [findings, ideas, seenId, plan] = await Promise.all([
      read($, findingsAtom),
      read($, ideasAtom),
      read($, seenAtom),
      read($, discoveryPlanAtom),
    ])
    const finding = findings.find(f => f.status === 'new' && isActionable(f.verdict) && f.id > seenId)
    const { Box, Text, Button } = $.ui.resolve(e)
    const isGraphical = e.surface !== 'terminal'
    if (finding === undefined && plan !== null) {
      // a discovery plan waits for a press before anything is spent
      return (
        <Box flexDirection="row" gap={isGraphical ? 'sm' : 1}>
          <Text wrap="truncate-end" size={isGraphical ? 'footnote' : undefined}>
            {`stress-scout discovery plan: ${plan.question} · ${plan.cost}`}
          </Text>
          <Button key="run-discovery" label="Run it" variant="primary" hotkey="r" onPress={() => void pressRunIt($)} />
          <Button key="cancel-discovery" label="Cancel" hotkey="c" onPress={() => void cancelPlan($)} />
        </Box>
      )
    }
    if (finding === undefined) {
      // an idea gets one quiet line, only while no broke/degraded finding waits and until it is seen
      const idea = ideas.find(i => i.status === 'new' && i.id > seenId)
      if (idea === undefined || findings.some(f => f.status === 'new' && isActionable(f.verdict))) return next(e)
      return (
        <Box flexDirection="row" gap={isGraphical ? 'sm' : 1}>
          <Text dimColor wrap="truncate-end" size={isGraphical ? 'footnote' : undefined}>
            {`stress-scout idea #${idea.id} (${idea.size}): ${idea.title}`}
          </Text>
          <Button key="try" label="Try it" hotkey="t" onPress={() => void tryIdea($, idea.id)} />
          <Button key="dismiss" label="Dismiss" hotkey="x" onPress={() => void dismiss($, idea.id)} />
        </Box>
      )
    }
    const delta = finding.before !== '' && finding.after !== '' ? ` (${finding.before} → ${finding.after})` : ''
    // a graphical surface draws the band as a card edged in the verdict's theme color
    const card = isGraphical
      ? { borderStyle: 'round', borderColor: verdictColor(finding.verdict), paddingX: 'sm' as const, paddingY: 'xs' as const, gap: 'xs' as const }
      : {}
    return (
      <Box flexDirection="column" {...card}>
        <Box flexDirection="row" gap={isGraphical ? 'sm' : 1}>
          <Text color={verdictColor(finding.verdict)} bold weight="semibold">
            {`stress-scout #${finding.id} ${finding.verdict}`}
          </Text>
          <Text wrap="truncate-end" mono={isGraphical}>{`${finding.target}: ${finding.headline}`}</Text>
        </Box>
        {finding.fixSummary !== '' && (
          <Text dimColor wrap="truncate-end" size="footnote">
            {`${finding.isVerified ? 'verified fix' : 'unverified fix'}: ${finding.fixSummary}${delta}`}
          </Text>
        )}
        <Box flexDirection="row" gap={isGraphical ? 'xs' : 1}>
          {canHandOver(finding) && (
            <Button key="apply" label={handOverLabel(finding)} variant="primary" hotkey="a" onPress={() => void apply($, finding.id)} />
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
    // the terminal keeps its compact rows; a graphical surface (the app, an editor, a phone) gets cards
    const isGraphical = e.surface !== 'terminal'
    const [phase, findings, ideas, activity, runsUsed, tokens, spent, paused, openId, run, waiting, plan, discoveries, discoveriesUsed] = await Promise.all([
      read($, phaseAtom),
      read($, findingsAtom),
      read($, ideasAtom),
      read($, activityAtom),
      read($, runsUsedAtom),
      read($, tokensAtom),
      read($, dollarsAtom),
      read($, pausedAtom),
      read($, openAtom),
      read($, runAtom),
      read($, waitingAtom),
      read($, discoveryPlanAtom),
      read($, discoveriesAtom),
      read($, discoveriesUsedAtom),
    ])
    const next = phase.kind === 'idle' && !paused ? nextText(waiting, runsUsed) : ''
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
    const stateColor =
      phase.kind === 'off' ? 'error' : phase.kind === 'test' ? 'claude' : paused ? 'subtle' : phase.kind === 'triage' ? 'suggestion' : 'success'
    const mode = config.isSweeping ? 'changes + idle sweeps' : 'changes only'
    const row = isGraphical ? ('xs' as const) : 1
    const section = isGraphical ? ('md' as const) : 1
    const detail = (key: string, label: string, value: string) =>
      isGraphical ? (
        <Box key={key} flexDirection="column">
          <Text size="caption" weight="semibold" dimColor>
            {label}
          </Text>
          <Text>{value}</Text>
        </Box>
      ) : (
        <Text key={key}>{`${label}: ${value}`}</Text>
      )
    // what an open discovery card adds to the usual evidence rows
    const discoveryRows = (d: Discovery) => [
      d.hypotheses.length > 0 &&
        detail('hypotheses', 'Hypotheses', d.hypotheses.map(h => `${h.id}: ${h.statement} (predicts ${h.prediction}; killed by ${h.kill})`).join('\n')),
      d.method !== '' && detail('method', 'Method', d.method),
      d.numbers.length > 0 &&
        detail('numbers', 'Numbers', d.numbers.map(n => `${n.name}: ${n.median} (${n.spread}, ${n.runs} runs, ${n.origin === 'source' ? 'from a source' : 'measured here'})`).join('\n')),
      detail('verdict', 'Verdict', `${d.survivor !== '' ? `${d.survivor} survived` : 'no hypothesis survived'}${d.effect !== '' ? ` · ${d.effect}` : ''} · confidence ${d.confidence}`),
      d.wouldChange !== '' && detail('change', 'Would change if', d.wouldChange),
      d.sources.length > 0 && detail('sources', 'Sources checked', d.sources.map(src => `${src.url} (${src.date || 'undated'}) ${src.note}`.trim()).join('\n')),
      detail('prereg', 'Pre-registration', d.preRegNote),
    ]
    return (
      <Box flexDirection="column" gap={section}>
        <Box flexDirection="column" gap={isGraphical ? 'xs' : 0}>
          <Text bold weight="semibold" size="heading" color={isGraphical ? stateColor : undefined} wrap="truncate-end">
            {`stress-scout · ${state}`}
          </Text>
          <Text dimColor size="footnote" tabular wrap="truncate-end">
            {`automatic runs ${runsUsed}/${config.maxRuns} · ${dollars(spent)} · ${compactTokens(tokens)} tokens · ${mode}`}
          </Text>
          {next !== '' && (
            <Text key="next" dimColor size="footnote" wrap="wrap">
              {`Next: ${next}`}
            </Text>
          )}
        </Box>
        <Box flexDirection="row" gap={row}>
          {run !== null ? (
            <Button key="stop" label="Stop test" onPress={() => void stopTester($)} />
          ) : (
            <Button key="run" label="Run now" variant={isGraphical ? 'primary' : undefined} onPress={() => void runNow($)} />
          )}
          <Button key="pause" label={paused ? 'Resume' : 'Pause'} onPress={() => void togglePause($, !paused)} />
        </Box>
        {plan !== null && (
          <Box
            key="discovery-plan"
            flexDirection="column"
            gap="xs"
            {...(isGraphical ? { borderStyle: 'round', borderColor: 'claude', padding: 'sm' as const } : {})}
          >
            <Text bold weight="semibold">Discovery plan</Text>
            <Text wrap="wrap">{plan.question}</Text>
            <Text dimColor size="footnote" wrap="wrap">{`Hypotheses: ${plan.hypotheses}.`}</Text>
            <Text dimColor size="footnote" wrap="wrap">{`Experiment: ${plan.experiment}.`}</Text>
            <Text dimColor size="footnote" wrap="wrap">{`Cost: ${plan.cost}. ${config.isReadingSources ? 'May read fresh sources on the web.' : 'Reads no web sources.'} ${discoveriesUsed}/${config.maxDiscoveries} discoveries this session.`}</Text>
            <Box flexDirection="row" gap={row}>
              <Button key="run-discovery" label="Run it" variant="primary" onPress={() => void pressRunIt($)} />
              <Button key="cancel-discovery" label="Cancel" onPress={() => void cancelPlan($)} />
            </Box>
          </Box>
        )}
        {findings.length === 0 && (
          <Text dimColor>
            No findings yet, and nothing for you to do: stress-scout tests each risky change once edits settle, sweeps
            untested code while the session is idle, and puts what it finds here. Run now skips the wait.
          </Text>
        )}
        {[...findings]
          .sort((a, b) => Number(b.discovery?.isSurprising === true) - Number(a.discovery?.isSurprising === true))
          .slice(0, 12)
          .map(f => {
          const isOpen = openId === f.id
          const isNew = f.status === 'new'
          const delta = f.before !== '' && f.after !== '' ? ` (${f.before} → ${f.after})` : ''
          const cost = f.cost > 0 ? ` · ${dollars(f.cost)}` : ''
          const card = isGraphical
            ? {
                borderStyle: 'round',
                borderColor: isNew ? verdictColor(f.verdict) : 'subtle',
                borderDimColor: !isNew,
                padding: 'sm' as const,
                gap: 'xs' as const,
              }
            : {}
          return (
            <Box key={`finding-${f.id}`} flexDirection="column" {...card}>
              <Box flexDirection="row" gap={row}>
                <Text color={verdictColor(f.verdict)} bold weight="semibold">
                  {f.discovery !== null ? `#${f.id} discovery${f.discovery.isSurprising ? ' · surprising' : ''}${f.discovery.isPartial ? ' · partial' : ''}` : `#${f.id} ${f.verdict}`}
                </Text>
                <Text wrap="truncate-end" dimColor={!isNew} mono={isGraphical}>
                  {`${f.target} · ${f.kind}${f.fromIdea > 0 ? ` · idea #${f.fromIdea}` : ''}${!isNew ? ` · ${f.status}` : ''}`}
                </Text>
              </Box>
              <Text wrap={isOpen ? 'wrap' : 'truncate-end'} dimColor={isGraphical && !isNew}>
                {f.headline}
              </Text>
              {f.fixSummary !== '' && (
                <Text dimColor size="footnote" wrap={isOpen ? 'wrap' : 'truncate-end'}>
                  {`${f.isVerified ? 'verified fix' : 'unverified fix'}: ${f.fixSummary}${delta}`}
                </Text>
              )}
              {isOpen && (
                <Box flexDirection="column" gap={row}>
                  {f.discovery !== null && discoveryRows(f.discovery)}
                  {f.evidence !== '' && detail('evidence', 'Evidence', f.evidence)}
                  {f.before !== '' && detail('before', 'Before', f.before)}
                  {f.after !== '' && detail('after', 'After', f.after)}
                  {f.fixExplanation !== '' && detail('why', 'Why it works', f.fixExplanation)}
                  {f.nextStep !== '' && detail('next', 'Next step', f.nextStep)}
                  <Text dimColor size="footnote" mono={isGraphical}>
                    {`Harness: ${f.snapshot}/.stress-scout/${f.rerun !== '' ? `  ·  rerun: ${f.rerun}` : ''}`}
                  </Text>
                  <Text dimColor size="footnote" tabular>
                    {`Took ${ago(f.durationMs)} · ${compactTokens(f.tokens)} tokens${cost} · confidence ${f.confidence}`}
                  </Text>
                  {f.patch !== '' && <Code source={clip(f.patch, 12_000)} format="diff" language="diff" />}
                </Box>
              )}
              <Box flexDirection="row" gap={row}>
                {isNew && canHandOver(f) && (
                  <Button key={`apply-${f.id}`} label={handOverLabel(f)} variant="primary" onPress={() => void apply($, f.id)} />
                )}
                <Button key={`open-${f.id}`} label={isOpen ? 'Less' : 'Details'} onPress={() => void showPane($, f.id)} />
                {isNew && <Button key={`dismiss-${f.id}`} label="Dismiss" onPress={() => void dismiss($, f.id)} />}
              </Box>
            </Box>
          )
        })}
        {ideas.some(i => i.status !== 'dismissed') && (
          <Box flexDirection="column" gap={row}>
            <Text bold weight="semibold" size={isGraphical ? 'caption' : undefined} dimColor={isGraphical}>
              Ideas
            </Text>
            {ideas
              .filter(i => i.status !== 'dismissed')
              .slice(0, 5)
              .map(i => {
                const card = isGraphical
                  ? { borderStyle: 'round', borderColor: 'subtle', borderDimColor: true, padding: 'sm' as const, gap: 'xs' as const }
                  : {}
                return (
                  <Box key={`idea-${i.id}`} flexDirection="column" {...card}>
                    <Text dimColor wrap="truncate-end" mono={isGraphical}>
                      {`#${i.id} idea · ${i.size} · ${i.files.join(', ')}${i.status !== 'new' ? ` · ${i.status}` : ''}`}
                    </Text>
                    <Text dimColor wrap="wrap">
                      {i.title}
                    </Text>
                    {i.why !== '' && (
                      <Text dimColor size="footnote" wrap="wrap">
                        {i.why}
                      </Text>
                    )}
                    {i.status !== 'trying' && (
                      <Box flexDirection="row" gap={row}>
                        <Button key={`try-${i.id}`} label={i.status === 'tried' ? 'Try again' : 'Try it'} onPress={() => void tryIdea($, i.id)} />
                        {config.maxDiscoveries > 0 && (
                          <Button key={`research-${i.id}`} label="Research this" onPress={() => void researchIdea($, i.id)} />
                        )}
                        <Button key={`dismiss-${i.id}`} label="Dismiss" onPress={() => void dismiss($, i.id)} />
                      </Box>
                    )}
                  </Box>
                )
              })}
          </Box>
        )}
        {discoveries.length > 0 && (
          <Box flexDirection="column" gap={row}>
            <Text bold weight="semibold" size={isGraphical ? 'caption' : undefined} dimColor={isGraphical}>
              Discoveries
            </Text>
            {[...discoveries]
              .sort((a, b) => Number(b.isSurprising) - Number(a.isSurprising))
              .slice(0, 6)
              .map(entry => (
                <Box
                  key={`discovery-${entry.key}`}
                  flexDirection="column"
                  {...(isGraphical ? { borderStyle: 'round', borderColor: entry.isSurprising ? 'warning' : 'subtle', borderDimColor: !entry.isSurprising, padding: 'sm' as const, gap: 'xs' as const } : {})}
                >
                  <Text wrap="wrap" bold={entry.isSurprising} weight={entry.isSurprising ? 'semibold' : undefined}>
                    {`${entry.isSurprising ? 'surprising · ' : ''}${entry.status} · ${entry.question}`}
                  </Text>
                  <Text dimColor size="footnote" wrap="wrap">
                    {entry.headline}
                  </Text>
                </Box>
              ))}
          </Box>
        )}
        {activity.length > 0 && (
          <Box flexDirection="column" gap={isGraphical ? 'xs' : 0}>
            <Text bold weight="semibold" size={isGraphical ? 'caption' : undefined} dimColor={isGraphical}>
              Activity
            </Text>
            {activity.slice(0, 10).map((item, i) => (
              <Text key={`activity-${i}`} dimColor size="footnote" tabular wrap="truncate-end">
                {`${clockTime(item.at)} ${item.text}`}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
