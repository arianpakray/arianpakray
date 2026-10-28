export type Trigger = 'change' | 'idle' | 'sweep' | 'manual'

export type Verdict = 'broke' | 'degraded' | 'held' | 'inconclusive'

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
  /** Project files (relative to the root) the finding targets: what the rerun copies into the snapshot. */
  files: string[]
  snapshot: string
  confidence: string
  /** `fixed` / `regressed`: the stored harness, rerun on the edited project files, passed / failed. */
  status: 'new' | 'applied' | 'dismissed' | 'fixed' | 'regressed'
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
  files: string[]
  memoryKey: string
  hash: string
  runDir: string
  snapshot: string
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
