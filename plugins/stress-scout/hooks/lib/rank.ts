/** Ranking the project's files for an idle sweep: cheap path and size signals, no reads. */

export type TreeFile = { path: string; size: number; sha: string }

export type Candidate = TreeFile & { churn: number; score: number; signals: string[] }

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|scala|rb|php|cs|fs|cpp|cc|cxx|c|h|hpp|swift|m|mm|ex|exs|erl|clj|cljs|lua|dart|zig|nim|sql|sh)$/i

const EXCLUDED = [
  /(^|\/)(tests?|__tests__|specs?|e2e|fixtures?|mocks?|__mocks__|examples?|docs?|stories|storybook|benchmarks?|migrations?|vendor|third_party|generated|gen)\//i,
  /\.(test|spec|stories|e2e|bench)\.[a-z]+$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /_test\.(go|py|rb|exs)$/i,
  /\.d\.ts$/i,
  /\.min\.[a-z]+$/i,
  /(\.pb\.|_pb2\.py$|\.generated\.|\.g\.dart$)/i,
  /(^|\/)(webpack|vite|vitest|rollup|babel|jest|eslint|prettier|tailwind|postcss|next|nuxt|svelte|astro|playwright|karma)\.config\.[a-z]+$/i,
  /(^|\/)(setup|conftest|manage|wsgi|asgi)\.py$/i,
]

const SIGNALS: readonly (readonly [string, RegExp])[] = [
  ['parsing', /(pars|lex|token|serial|codec|decod|encod|json|yaml|xml|csv|markdown|template|format)/i],
  ['cache', /(cache|lru|memo)/i],
  ['concurrency', /(queue|worker|job|pool|schedul|cron|async|concurr|lock|mutex|sync|thread|event|pubsub|broker)/i],
  ['auth', /(auth|login|session|permission|acl|jwt|oauth|crypto|password|secret|sign)/i],
  ['io', /(api|server|handler|route|controller|http|socket|ws|grpc|client|webhook|middleware)/i],
  ['data', /(db|sql|query|repo|model|orm|store|storage|persist|index|search)/i],
  ['money', /(payment|price|money|order|invoice|billing|ledger|currency|tax|cart|checkout|trade|wallet)/i],
  ['resilience', /(retry|backoff|timeout|rate|limit|throttl|circuit|debounce)/i],
  ['resource', /(upload|stream|buffer|file|fs|blob|image|download|import|export)/i],
  ['time', /(date|time|tz|calendar|duration|clock)/i],
]

/** `git ls-tree -r -l` lines: `<mode> <type> <sha> <size>\t<path>`. */
export function parseLsTree(stdout: string): TreeFile[] {
  const files: TreeFile[] = []
  for (const line of stdout.split('\n')) {
    const match = /^\d+ blob ([0-9a-f]{40,64}) +(\d+)\t(.+)$/.exec(line)
    if (match) files.push({ sha: match[1] ?? '', size: Number(match[2]), path: match[3] ?? '' })
  }
  return files
}

/** `git log --name-only --format=` output: how often each path changed. */
export function parseChurn(stdout: string): Map<string, number> {
  const churn = new Map<string, number>()
  for (const line of stdout.split('\n')) {
    const path = line.trim()
    if (path !== '') churn.set(path, (churn.get(path) ?? 0) + 1)
  }
  return churn
}

export const isSource = (path: string): boolean =>
  SOURCE.test(path) && !EXCLUDED.some(pattern => pattern.test(path))

/**
 * The files most worth a sweep: source code with risky-sounding names, size
 * and recent churn, leaving out what memory says was tested at this content.
 */
export function rankCandidates(
  files: readonly TreeFile[],
  churn: ReadonlyMap<string, number>,
  isTested: (path: string, sha: string) => boolean,
  limit = 25,
): Candidate[] {
  const candidates: Candidate[] = []
  for (const file of files) {
    if (!isSource(file.path) || file.size < 200 || file.size > 400_000) continue
    if (isTested(file.path, file.sha)) continue
    const signals = SIGNALS.filter(([, pattern]) => pattern.test(file.path)).map(([name]) => name)
    const changes = churn.get(file.path) ?? 0
    const score = signals.length * 2 + Math.log2(1 + file.size / 2048) + Math.min(changes, 20) * 0.5
    candidates.push({ ...file, churn: changes, score, signals })
  }
  return candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit)
}
