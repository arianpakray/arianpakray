import type { Verdict } from '../../types'
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
  evidence: string
  before: string
  after: string
  fix: Fix | null
  nextStep: string
  rerun: string
  confidence: 'high' | 'medium' | 'low'
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
    evidence: str(raw.evidence, 900),
    before: str(raw.before, 160),
    after: str(raw.after, 160),
    fix,
    nextStep: str(raw.nextStep, 300),
    rerun: str(raw.rerun, 400),
    confidence: levelOf(raw.confidence, 'medium'),
  }
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
