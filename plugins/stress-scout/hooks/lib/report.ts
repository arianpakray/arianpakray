import type { Hypothesis, Measure, Source, Verdict } from '../../types'
import { extractJson, str, strList } from './util'

export const KINDS = [
  'concurrency',
  'load',
  'fuzz',
  'edge',
  'resource',
  'fault',
  'perf',
  'security',
] as const

const VERDICTS: readonly Verdict[] = ['broke', 'degraded', 'held', 'inconclusive']

export type Fix = {
  summary: string
  explanation: string
  files: string[]
  isVerified: boolean
}

export type Report = {
  target: string
  kind: string
  verdict: Verdict
  headline: string
  plain: string
  plainFix: string
  evidence: string
  before: string
  after: string
  fix: Fix | null
  nextStep: string
  rerun: string
  confidence: 'high' | 'medium' | 'low'
}

/** What the triage model proposed beside its stress-test target; vetted by `vetIdea` before anyone sees it. */
export type IdeaDraft = {
  title: string
  why: string
  files: string[]
  size: 'S' | 'M' | 'L'
  /** feature (an addition), refinement (a change to what exists) or style (taste only: always dropped) */
  type: 'feature' | 'refinement' | 'style'
  /** 0-10: how much it would improve what the person is building right now */
  value: number
}

export type Triage = {
  isWorth: boolean
  risk: 'high' | 'medium' | 'low'
  target: string
  files: string[]
  kind: string
  why: string
  attack: string
  skip: string
  /** absent when the model gave none (an older reply, or nothing cleared its bar) */
  idea?: IdeaDraft
}

const kindOf = (value: unknown): string => {
  const kind = str(value, 20).toLowerCase()
  return (KINDS as readonly string[]).includes(kind) ? kind : 'edge'
}

const levelOf = (value: unknown, fallback: 'high' | 'medium' | 'low') => {
  const level = str(value, 10).toLowerCase()
  return level === 'high' || level === 'medium' || level === 'low' ? level : fallback
}

/** The tester's final ```json report, normalized; undefined when it wrote none. */
export function parseReport(answer: string): Report | undefined {
  const raw = extractJson(answer, value => typeof value.verdict === 'string')
  if (!raw) return undefined
  const verdict = str(raw.verdict, 20).toLowerCase() as Verdict
  const fixRaw =
    raw.fix !== null && typeof raw.fix === 'object' && !Array.isArray(raw.fix)
      ? (raw.fix as Record<string, unknown>)
      : undefined
  const fix: Fix | null =
    fixRaw && str(fixRaw.summary, 200) !== ''
      ? {
          summary: str(fixRaw.summary, 140),
          explanation: str(fixRaw.explanation, 600),
          files: strList(fixRaw.files, 20),
          isVerified: fixRaw.verified === true,
        }
      : null
  return {
    target: str(raw.target, 200),
    kind: kindOf(raw.kind),
    verdict: VERDICTS.includes(verdict) ? verdict : 'inconclusive',
    headline: str(raw.headline, 140),
    plain: str(raw.plain, 260),
    plainFix: str(raw.plainFix, 160),
    evidence: str(raw.evidence, 900),
    before: str(raw.before, 160),
    after: str(raw.after, 160),
    fix,
    nextStep: str(raw.nextStep, 300),
    rerun: str(raw.rerun, 400),
    confidence: levelOf(raw.confidence, 'medium'),
  }
}

function parseIdea(value: unknown): IdeaDraft | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const title = str(raw.title, 200)
  if (title === '') return undefined
  const size = str(raw.size, 4).toUpperCase()
  const type = str(raw.type, 20).toLowerCase()
  const score = typeof raw.value === 'number' && Number.isFinite(raw.value) ? raw.value : 0
  return {
    title,
    why: str(raw.why, 200),
    files: strList(raw.files, 6),
    size: size === 'S' || size === 'M' ? size : 'L',
    type: type === 'feature' || type === 'style' ? type : 'refinement',
    value: Math.min(10, Math.max(0, score)),
  }
}

/** What the reviewer saw in one edit: '' when it found nothing. */
export type Review = { issue: string; confidence: 'high' | 'medium' | 'low' }

/** The reviewer's JSON answer; undefined when it is unreadable. */
export function parseReview(text: string): Review | undefined {
  const raw = extractJson(text, value => typeof value.issue === 'string')
  if (!raw) return undefined
  return { issue: str(raw.issue, 300), confidence: levelOf(raw.confidence, 'low') }
}

/** The triage model's JSON answer, normalized; undefined when it is unreadable. */
export function parseTriage(text: string): Triage | undefined {
  const raw = extractJson(text, value => typeof value.worth === 'boolean')
  if (!raw) return undefined
  const target = str(raw.target, 200)
  const isWorth = raw.worth === true && target !== ''
  return {
    isWorth,
    risk: levelOf(raw.risk, 'low'),
    target,
    files: strList(raw.files, 8),
    kind: kindOf(raw.kind),
    why: str(raw.why, 240),
    attack: str(raw.attack, 300),
    skip: str(raw.skip, 200, isWorth ? '' : 'nothing worth a stress test'),
    idea: parseIdea(raw.idea),
  }
}

export const isActionable = (verdict: Verdict): boolean =>
  verdict === 'broke' || verdict === 'degraded'

/** The tester process's final `result` event: its last message, cost and tokens. */
export type TesterResult = {
  text: string
  cost: number
  tokens: number
  subtype: string
  isError: boolean
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** One line of `claude -p --output-format stream-json`: tool calls made, or the final result. */
export function parseStreamLine(line: string): { toolUses: number; result?: TesterResult } {
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return { toolUses: 0 }
  }
  if (event === null || typeof event !== 'object') return { toolUses: 0 }
  const record = event as Record<string, unknown>
  if (record.type === 'assistant') {
    const content = (record.message as { content?: unknown } | undefined)?.content
    const blocks = Array.isArray(content) ? (content as { type?: unknown }[]) : []
    return { toolUses: blocks.filter(block => block.type === 'tool_use').length }
  }
  if (record.type !== 'result') return { toolUses: 0 }
  const usage = (record.usage ?? {}) as Record<string, unknown>
  return {
    toolUses: 0,
    result: {
      text: typeof record.result === 'string' ? record.result : '',
      cost: count(record.total_cost_usd),
      tokens:
        count(usage.input_tokens) +
        count(usage.output_tokens) +
        count(usage.cache_creation_input_tokens) +
        count(usage.cache_read_input_tokens),
      subtype: typeof record.subtype === 'string' ? record.subtype : '',
      isError: record.is_error === true,
    },
  }
}

/** What a discovery run reports. The pre-registration check and the ledger are the scout's, not the tester's. */
export type DiscoveryReport = {
  question: string
  hypotheses: Hypothesis[]
  method: string
  numbers: Measure[]
  sources: Source[]
  survivor: string
  effect: string
  confidence: 'high' | 'medium' | 'low'
  wouldChange: string
  isSurprising: boolean
  headline: string
  /** the code files the answer depends on */
  files: string[]
  rerun: string
  /** the one code change the result implies, if any */
  change?: IdeaDraft
}

const objects = (value: unknown, max: number): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)).slice(0, max)
    : []

/** The discovery tester's final ```json report, normalized; undefined when it wrote none. Every string is data, clipped, never acted on. */
export function parseDiscovery(answer: string): DiscoveryReport | undefined {
  const raw = extractJson(answer, value => Array.isArray(value.hypotheses))
  if (!raw) return undefined
  const hypotheses = objects(raw.hypotheses, 4).map((h, i) => ({
    id: str(h.id, 8, `H${i + 1}`),
    statement: str(h.statement, 240),
    prediction: str(h.prediction, 240),
    kill: str(h.kill, 240),
  }))
  const numbers = objects(raw.numbers, 12).map(n => ({
    name: str(n.name, 80),
    median: str(n.median, 40),
    spread: str(n.spread, 40),
    runs: typeof n.runs === 'number' && Number.isFinite(n.runs) ? Math.max(0, Math.floor(n.runs)) : 0,
    origin: n.origin === 'source' ? ('source' as const) : ('measured' as const),
  }))
  const sources = objects(raw.sources, 12).map(src => ({ url: str(src.url, 300), date: str(src.date, 40), note: str(src.note, 160) }))
  const few = numbers.some(n => n.origin === 'measured' && n.runs < 5)
  const change = parseIdea(raw.change)
  return {
    question: str(raw.question, 300),
    hypotheses,
    method: str(raw.method, 400) + (few ? ' (a measured number has fewer than 5 runs)' : ''),
    numbers,
    sources,
    survivor: str(raw.survivor, 8),
    effect: str(raw.effect, 200),
    confidence: few ? 'low' : levelOf(raw.confidence, 'low'),
    wouldChange: str(raw.wouldChange, 240),
    isSurprising: raw.surprising === true,
    headline: str(raw.headline, 140),
    files: strList(raw.files, 12),
    rerun: str(raw.rerun, 400),
    ...(change !== undefined ? { change } : {}),
  }
}

/** The tools one stream line called, by name and what they aim at (a path or a command). */
export function parseToolUses(line: string): { name: string; target: string }[] {
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return []
  }
  if (event === null || typeof event !== 'object' || (event as { type?: unknown }).type !== 'assistant') return []
  const content = ((event as { message?: { content?: unknown } }).message?.content ?? []) as unknown
  const blocks = Array.isArray(content) ? (content as { type?: unknown; name?: unknown; input?: unknown }[]) : []
  return blocks
    .filter(block => block.type === 'tool_use')
    .map(block => {
      const input = (block.input ?? {}) as Record<string, unknown>
      return { name: String(block.name ?? ''), target: String(input.file_path ?? input.command ?? input.url ?? input.query ?? '') }
    })
}
