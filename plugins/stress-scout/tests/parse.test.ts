import { expect, test } from 'claude-code/testing'

import { isSource, parseChurn, parseLsTree, rankCandidates } from '../hooks/lib/rank'
import { vetIdea } from '../hooks/lib/ideas'
import { parseReport, parseTriage, type IdeaDraft } from '../hooks/lib/report'
import { extractJson } from '../hooks/lib/util'

const REPORT = {
  target: 'src/cache.ts:LruCache.set',
  kind: 'concurrency',
  verdict: 'broke',
  headline: 'lost 1,214 of 10,000 writes under 64 concurrent writers',
  plain: 'Your cache can silently lose saved items when many things write to it at once.',
  plainFix: 'Make the cache finish one write before it starts the next.',
  evidence: 'set() reads size, awaits persist(), then evicts: interleaved writers evict live keys',
  before: '1,214/10,000 writes lost',
  after: '0/10,000 writes lost',
  fix: { summary: 'evict before the await, under one critical section', explanation: 'no await between check and act', files: ['src/cache.ts'], verified: true },
  nextStep: 'apply the patch, then run the harness against src/cache.ts',
  rerun: 'timeout 120 node .stress-scout/race.mjs',
  confidence: 'high',
}

test('the report is read from the last json fence', () => {
  const answer = `Done.\n\`\`\`json\n{"verdict": "held"}\n\`\`\`\nThen I fixed it.\n\`\`\`json\n${JSON.stringify(REPORT, null, 2)}\n\`\`\``
  const report = parseReport(answer)
  expect(report?.verdict).toBe('broke')
  expect(report?.fix?.isVerified).toBe(true)
  expect(report?.fix?.files).toEqual(['src/cache.ts'])
  expect(report?.confidence).toBe('high')
})

test('a bare report is found, and its nested fix is never taken for it', () => {
  const report = parseReport(`I ran it: ${JSON.stringify(REPORT)} and that is all.`)
  expect(report?.target).toBe('src/cache.ts:LruCache.set')
  expect(report?.fix?.summary).toBe('evict before the await, under one critical section')
})

test('the plain-language fields are read, and a report without them gets empty ones', () => {
  const report = parseReport(`\`\`\`json\n${JSON.stringify(REPORT)}\n\`\`\``)
  expect(report?.plain).toBe('Your cache can silently lose saved items when many things write to it at once.')
  expect(report?.plainFix).toBe('Make the cache finish one write before it starts the next.')
  const { plain: _plain, plainFix: _plainFix, ...older } = REPORT
  const bare = parseReport(`\`\`\`json\n${JSON.stringify(older)}\n\`\`\``)
  expect(bare?.verdict).toBe('broke')
  expect(bare?.plain).toBe('')
  expect(bare?.plainFix).toBe('')
})

test('odd values are normalized and a missing report is undefined', () => {
  const report = parseReport('```json\n{"verdict": "exploded", "kind": "chaos", "fix": null}\n```')
  expect(report?.verdict).toBe('inconclusive')
  expect(report?.kind).toBe('edge')
  expect(report?.fix).toBe(null)
  expect(parseReport('I could not run anything.')).toBeUndefined()
  expect(parseReport('{ not json')).toBeUndefined()
})

test('triage answers parse, and a "not worth it" carries its reason', () => {
  const plan = parseTriage('Sure!\n```json\n{"worth": true, "risk": "high", "target": "src/q.ts", "files": ["src/q.ts"], "kind": "load", "why": "unbounded queue", "attack": "1e6 enqueues"}\n```')
  expect(plan?.isWorth).toBe(true)
  expect(plan?.files).toEqual(['src/q.ts'])
  const skip = parseTriage('{"worth": false, "risk": "low", "target": "", "skip": "README only"}')
  expect(skip?.isWorth).toBe(false)
  expect(skip?.skip).toBe('README only')
  expect(parseTriage('no idea')).toBeUndefined()
})

test('extractJson survives braces inside strings', () => {
  expect(extractJson('x {"a": "}{", "b": {"c": 1}} y')).toEqual({ a: '}{', b: { c: 1 } })
})

test('sweeps rank risky source and skip tests, docs, generated and already-tested code', () => {
  const sha = (n: number) => String(n).padStart(40, '0')
  const tree = parseLsTree(
    [
      `100644 blob ${sha(1)}    9000\tsrc/payments/ledger.ts`,
      `100644 blob ${sha(2)}    9000\tsrc/ui/Button.tsx`,
      `100644 blob ${sha(3)}    9000\tsrc/cache/lru.ts`,
      `100644 blob ${sha(4)}    9000\ttests/cache.test.ts`,
      `100644 blob ${sha(5)}    9000\tdocs/guide.md`,
      `100644 blob ${sha(6)}    9000\tsrc/types.d.ts`,
      `100644 blob ${sha(7)}      50\tsrc/tiny.ts`,
      `100644 blob ${sha(8)}    9000\tsrc/api/retry.py`,
    ].join('\n'),
  )
  expect(tree).toHaveLength(8)
  const churn = parseChurn('src/api/retry.py\nsrc/api/retry.py\n\nsrc/cache/lru.ts\n')
  expect(churn.get('src/api/retry.py')).toBe(2)
  const ranked = rankCandidates(tree, churn, path => path === 'src/cache/lru.ts')
  const paths = ranked.map(c => c.path)
  expect(paths).toContain('src/payments/ledger.ts')
  expect(paths).toContain('src/api/retry.py')
  expect(paths).not.toContain('src/cache/lru.ts')
  expect(paths).not.toContain('tests/cache.test.ts')
  expect(paths).not.toContain('docs/guide.md')
  expect(paths).not.toContain('src/types.d.ts')
  expect(paths).not.toContain('src/tiny.ts')
  expect(paths.indexOf('src/payments/ledger.ts')).toBeLessThan(paths.indexOf('src/ui/Button.tsx'))
  expect(isSource('src/server.go')).toBe(true)
  expect(isSource('src/server_test.go')).toBe(false)
})

const TRIAGE = { worth: false, risk: 'low', target: 'src/a.ts', files: ['src/a.ts'], kind: 'edge' }
const IDEA = { title: 'Show the count', why: 'no visibility', files: ['src/a.ts'], size: 's', type: 'feature', value: 9 }

test('a triage answer without an idea parses as before', () => {
  const plan = parseTriage(JSON.stringify(TRIAGE))
  expect(plan?.target).toBe('src/a.ts')
  expect(plan?.idea).toBeUndefined()
  expect(parseTriage(JSON.stringify({ ...TRIAGE, idea: null }))?.idea).toBeUndefined()
  expect(parseTriage(JSON.stringify({ ...TRIAGE, idea: { why: 'no title' } }))?.idea).toBeUndefined()
})

test('an idea is read and normalized', () => {
  expect(parseTriage(JSON.stringify({ ...TRIAGE, idea: IDEA }))?.idea).toEqual({
    title: 'Show the count',
    why: 'no visibility',
    files: ['src/a.ts'],
    size: 'S',
    type: 'feature',
    value: 9,
  })
  const odd = parseTriage(JSON.stringify({ ...TRIAGE, idea: { title: 't', size: 'huge', type: 'whim', value: 99 } }))?.idea
  expect(odd).toMatchObject({ size: 'L', type: 'refinement', value: 10, files: [] })
  expect(parseTriage(JSON.stringify({ ...TRIAGE, idea: { title: 't', value: 'high' } }))?.idea?.value).toBe(0)
})

test('vetIdea keeps a small valuable idea in recent edits and drops the rest', () => {
  const draft = (patch: Partial<IdeaDraft>): IdeaDraft => ({ title: 'Show the count', why: 'no visibility', files: ['src/a.ts'], size: 'S', type: 'feature', value: 9, ...patch })
  const edits = ['src/a.ts', 'package.json']
  expect(vetIdea(draft({}), edits)).toEqual({ isOk: true })
  expect(vetIdea(draft({ size: 'M', value: 8 }), edits).isOk).toBe(true)
  expect(vetIdea(draft({ value: 7 }), edits).isOk).toBe(false)
  expect(vetIdea(draft({ size: 'L' }), edits).isOk).toBe(false)
  expect(vetIdea(draft({ type: 'style' }), edits).isOk).toBe(false)
  expect(vetIdea(draft({ files: [] }), edits).isOk).toBe(false)
  expect(vetIdea(draft({ files: ['src/b.ts'] }), edits)).toEqual({ isOk: false, reason: 'touches files outside the recent edits' })
  for (const file of ['package.json', 'web/package-lock.json', 'requirements-dev.txt', 'yarn.lock', 'Cargo.toml', 'go.sum']) {
    expect(vetIdea(draft({ files: [file] }), [file])).toEqual({ isOk: false, reason: 'adds a dependency' })
  }
  expect(vetIdea(draft({ title: 'Install lodash for the cache' }), edits).isOk).toBe(false)
  expect(vetIdea(draft({ why: 'run npm install zod first' }), edits).isOk).toBe(false)
  expect(vetIdea(draft({ title: 'Add a dependency on zod' }), edits).isOk).toBe(false)
})
