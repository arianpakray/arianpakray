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
  snapshot: string
  /** Absent on findings saved by an earlier version. */
  origin?: Origin
  confidence: string
  status: 'new' | 'applied' | 'dismissed'
  durationMs: number
  tokens: number
  cost: number
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
  memoryKey: string
  hash: string
  runDir: string
  snapshot: string
  branch: string
  head: string
  baseTree: string
  startedAt: number
  tokens: number
}

declare module 'claude-code' {
  interface PluginState {
    'stress-scout': {
      phase: Phase
      findings: Finding[]
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
    }
  }
}
