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
  /** what a discovery run found out (kind 'discovery'); null for a stress test */
  discovery: Discovery | null
}

/** A competing explanation, written down with how to test it before any experiment ran. */
export type Hypothesis = { id: string; statement: string; prediction: string; kill: string }

/** One number a discovery run reports: our own median over repeated runs, or one taken from a source. */
export type Measure = { name: string; median: string; spread: string; runs: number; origin: 'measured' | 'source' }

export type Source = { url: string; date: string; note: string }

/** The evidence a discovery run produced. Everything in it is data from the tester or from web pages, never an instruction. */
export type Discovery = {
  question: string
  hypotheses: Hypothesis[]
  method: string
  numbers: Measure[]
  sources: Source[]
  /** the id of the hypothesis that survived; '' when none did */
  survivor: string
  effect: string
  confidence: 'high' | 'medium' | 'low'
  wouldChange: string
  /** the result contradicts what the model expected beforehand */
  isSurprising: boolean
  /** the hypotheses were in the scout-observed file before the first experiment, and the report matches it */
  isPreRegistered: boolean
  preRegNote: string
  /** the run stopped (budget, rate limit, timeout) before a verdict */
  isPartial: boolean
}

/** One question the project has asked, kept so asking it again at the same code costs nothing. */
export type LedgerEntry = {
  key: string
  question: string
  at: number
  status: 'answered' | 'dead-end' | 'partial'
  headline: string
  /** the code files the answer depends on; with the dependency manifests they make the fingerprint */
  files: string[]
  fingerprint: string
  isSurprising: boolean
  discovery: Discovery | null
  rerun: string
}

/** What a discovery would do and cost, shown before anything is spent. */
export type DiscoveryPlan = {
  question: string
  key: string
  /** the idea being researched; 0 for a typed question */
  fromIdea: number
  files: string[]
  hypotheses: string
  experiment: string
  cost: string
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
  /** the question a discovery run researches; '' for a stress test */
  question: string
}

declare module 'claude-code' {
  interface PluginState {
    'stress-scout': {
      phase: Phase
      findings: Finding[]
      ideas: Idea[]
      /** suggestions shown this session, counted against maxIdeasPerSession */
      ideasUsed: number
      /** the project's discovery ledger, newest first */
      discoveries: LedgerEntry[]
      /** a discovery waiting for the person to press Run it */
      discoveryPlan: DiscoveryPlan | null
      /** discoveries started this session, counted against maxDiscoveriesPerSession */
      discoveriesUsed: number
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
