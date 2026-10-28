export type Trigger = 'change' | 'idle' | 'sweep' | 'manual'

export type Verdict = 'broke' | 'degraded' | 'held' | 'inconclusive'

/** Where the project stood when a finding's snapshot was taken (branch and head are empty outside git). */
export type Origin = {
  branch: string
  head: string
  /** Blob id of each file the fix targets, as the snapshot held it. */
  files: Record<string, string>
}

export type Finding = {
  id: number
  at: number
  trigger: Trigger
  target: string
  kind: string
  verdict: Verdict
  headline: string
  /** What went wrong, in everyday words; empty on findings from before the tester wrote one */
  plain: string
  /** The fix, in everyday words */
  plainFix: string
  evidence: string
  before: string
  after: string
  fixSummary: string
  fixExplanation: string
  patch: string
  patchPath: string
  isVerified: boolean
  nextStep: string
  rerun: string
  /** Project files (relative to the root) the finding targets: what the rerun copies into the snapshot. */
  files: string[]
  snapshot: string
  /** Absent on findings saved by an earlier version. */
  origin?: Origin
  confidence: string
  /** `fixed` / `regressed`: the stored harness, rerun on the edited project files, passed / failed. */
  status: 'new' | 'handing' | 'applied' | 'dismissed' | 'fixed' | 'regressed'
  durationMs: number
  tokens: number
  cost: number
  memoryKey: string
  hash: string
  /** the id of the suggestion this finding is the result of trying; 0 when it came from a normal run */
  fromIdea: number
}

/** A suggested small improvement: not a verdict, no tester run and no patch until the person tries it. */
export type Idea = {
  id: number
  at: number
  /** what to add or change */
  title: string
  /** why, in one line */
  why: string
  files: string[]
  size: 'S' | 'M'
  status: 'new' | 'trying' | 'tried' | 'dismissed'
  memoryKey: string
  hash: string
}

export type Phase = {
  kind: 'idle' | 'triage' | 'test' | 'paused' | 'off'
  detail: string
  since: number
}

export type Activity = { at: number; text: string }

/** A tester run in flight: a headless Claude Code process working in a snapshot. */
export type Run = {
  id: number
  trigger: Trigger
  target: string
  kind: string
  files: string[]
  memoryKey: string
  hash: string
  runDir: string
  snapshot: string
  branch: string
  head: string
  baseTree: string
  startedAt: number
  tokens: number
  /** the suggestion this run builds; 0 for a normal run */
  fromIdea: number
}

declare module 'claude-code' {
  interface PluginState {
    'stress-scout': {
      phase: Phase
      findings: Finding[]
      ideas: Idea[]
      /** suggestions shown this session, counted against maxIdeasPerSession */
      ideasUsed: number
      activity: Activity[]
      run: Run | null
      runsUsed: number
      sweepsUsed: number
      tokensUsed: number
      dollarsUsed: number
      paused: boolean
      seenId: number
      openId: number
      suggestedId: number
      /** What the next automatic run waits on, when that is a time or a limit; '' when it just waits for an edit. */
      waiting: string
      rateHold: string
    }
  }
}
