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
  snapshot: string
  confidence: string
  status: 'new' | 'applied' | 'dismissed'
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
  memoryKey: string
  hash: string
  runDir: string
  snapshot: string
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
    }
  }
}
