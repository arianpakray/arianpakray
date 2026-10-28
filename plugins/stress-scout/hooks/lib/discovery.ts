import type { Discovery, Hypothesis, LedgerEntry } from '../../types'
import { MANIFESTS } from './ideas'
import type { Check } from './policy'
import { clip, fnv, oneLine } from './util'

/** Where the tester writes its hypotheses, relative to the snapshot, before it runs anything. */
export const HYPOTHESES_FILE = '.stress-scout/hypotheses.md'

export const MANIFEST_FILES = (paths: readonly string[]): string[] => paths.filter(path => MANIFESTS.test(path)).slice(0, 20)

/** The same question asked in other case, spacing or punctuation. */
export const normalizeQuestion = (question: string): string => oneLine(question.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' '))

export const questionKey = (question: string): string => fnv(normalizeQuestion(question))

/** What the scout saw of the hypotheses file: when it appeared, what it held, and how many experiments had started by then. */
export type Registered = { hash: string; at: number; text: string; finalHash: string; experimentsBefore: number }

const squash = (text: string): string => normalizeQuestion(text)

/** Whether a report's hypotheses are the ones written down first. The note says why not. */
export function checkPreRegistration(hypotheses: readonly Hypothesis[], registered: Registered | undefined): { isPreRegistered: boolean; note: string } {
  const fail = (note: string) => ({ isPreRegistered: false, note: `not pre-registered: ${note}` })
  if (registered === undefined) return fail('no hypotheses file was seen')
  if (registered.experimentsBefore > 0) return fail('the file appeared after the first experiment started')
  if (registered.finalHash !== registered.hash) return fail('the file changed after it was first seen')
  if (hypotheses.length < 2) return fail('the report has fewer than two competing hypotheses')
  const written = squash(registered.text)
  const missing = hypotheses.filter(h => !written.includes(squash(h.statement)))
  if (missing.length > 0) return fail(`${missing.length} of ${hypotheses.length} reported hypotheses are not in the file`)
  return { isPreRegistered: true, note: 'pre-registered: the hypotheses file was written before the first experiment' }
}

/** One fingerprint of the files an answer depends on and every dependency manifest. */
export function fingerprintOf(shas: ReadonlyMap<string, string>, files: readonly string[]): string {
  const watched = [...new Set([...files, ...MANIFEST_FILES([...shas.keys()])])].sort()
  return fnv(watched.map(path => `${path}:${shas.get(path) ?? '-'}`).join('|'))
}

/** The entry that answers this question at this code, or undefined when it must be asked again. A partial result never answers. */
export function fromLedger(entries: readonly LedgerEntry[], key: string, fingerprintFor: (files: readonly string[]) => string): LedgerEntry | undefined {
  const entry = entries.find(e => e.key === key)
  return entry !== undefined && entry.status !== 'partial' && fingerprintFor(entry.files) === entry.fingerprint ? entry : undefined
}

export const numbersLine = (discovery: Discovery): string =>
  discovery.numbers.map(n => `${n.name} ${n.median} ±${n.spread} (${n.runs} runs, ${n.origin})`).join('; ')

/** A ledger entry as one answer in plain text. */
export function answerText(entry: LedgerEntry): string {
  const d = entry.discovery
  const lines = [`Answered from this project's discovery ledger, nothing was run (${entry.status}${entry.isSurprising ? ', surprising' : ''}):`, entry.headline]
  if (d !== null) {
    if (d.numbers.length > 0) lines.push(numbersLine(d))
    if (d.effect !== '') lines.push(`Effect: ${d.effect} · confidence ${d.confidence}`)
    if (d.wouldChange !== '') lines.push(`Would change if: ${d.wouldChange}`)
    if (!d.isPreRegistered) lines.push(d.preRegNote)
  }
  if (entry.rerun !== '') lines.push(`Rerun: ${entry.rerun}`)
  return lines.join('\n')
}

/** The ledger as `.stress-scout/discoveries.md`: one section per question, dead ends and partial results included. */
export function renderLedger(entries: readonly LedgerEntry[]): string {
  const sections = [...entries].reverse().map(entry => {
    const d = entry.discovery
    const lines = [
      `## ${clip(entry.question, 200)}`,
      `- status: ${entry.status}${entry.isSurprising ? ' (surprising)' : ''} · asked ${new Date(entry.at).toISOString()}`,
      `- result: ${entry.headline}`,
    ]
    if (d !== null) {
      for (const h of d.hypotheses) lines.push(`- ${h.id}: ${h.statement} | predicts ${h.prediction} | killed by ${h.kill}`)
      if (d.numbers.length > 0) lines.push(`- numbers: ${numbersLine(d)}`)
      if (d.effect !== '') lines.push(`- effect: ${d.effect} · confidence ${d.confidence}`)
      for (const s of d.sources) lines.push(`- source: ${s.url} (${s.date || 'undated'}) ${s.note}`.trim())
      lines.push(`- ${d.preRegNote}`)
    }
    if (entry.rerun !== '') lines.push(`- rerun: ${entry.rerun}`)
    return lines.join('\n')
  })
  return `# Discoveries\n\n${sections.join('\n\n')}\n`
}

/** A question phrased from an idea, for the Research this button and the idle pick. */
export const ideaQuestion = (idea: { title: string; why: string }): string =>
  `Does this pay off in this codebase: ${idea.title}? ${idea.why}`.trim()

/**
 * The guard for the web tools of a discovery run. They reach the web through the
 * model provider, not the sandbox, so what could leave in a request is bounded:
 * plain https, no credentials in the address, no private hosts, short queries.
 */
export function checkWeb(tool: string, input: Record<string, unknown>): Check {
  const refuse = (reason: string): Check => ({ isAllowed: false, reason: `stress-scout guard: ${reason}` })
  if (tool === 'WebSearch') {
    const query = typeof input.query === 'string' ? input.query : ''
    return query.trim() === '' || query.length > 200 ? refuse('a search query is 1 to 200 characters') : { isAllowed: true }
  }
  const raw = typeof input.url === 'string' ? input.url : ''
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return refuse('the address is not a URL')
  }
  if (raw.length > 400) return refuse('the address is too long to be a source')
  if (url.protocol !== 'https:') return refuse('sources are fetched over https only')
  if (url.username !== '' || url.password !== '') return refuse('an address with credentials is refused')
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(url.hostname) || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) {
    return refuse('only public host names are fetched')
  }
  return { isAllowed: true }
}
