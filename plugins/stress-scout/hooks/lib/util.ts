export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`

export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** FNV-1a, 32 bits, hex: a short stable key, not a security hash. */
export function fnv(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export const slug = (text: string): string =>
  text
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project'

export const basename = (path: string): string =>
  path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path

export const trimSlash = (path: string): string =>
  path.length > 1 ? path.replace(/[\\/]+$/, '') : path

export const isInside = (path: string, dir: string): boolean => {
  const base = trimSlash(dir)
  return path === base || path.startsWith(`${base}/`)
}

/**
 * `path` with `//`, `/./` and `x/..` folded the way the OS reads them (links
 * aside): what a spelling like `/home/u/x/../.ssh` really names. A relative
 * path keeps the `..` that climb above its start.
 */
export function normalizePath(path: string): string {
  const isAbsolute = path.startsWith('/')
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..' && parts.length > 0 && parts.at(-1) !== '..') parts.pop()
    else if (part !== '..' || !isAbsolute) parts.push(part)
  }
  const joined = parts.join('/')
  return isAbsolute ? `/${joined}` : joined === '' ? '.' : joined
}

const queues = new Map<string, Promise<unknown>>()

/**
 * Runs `task` after every earlier task of the same `key` settled: one writer
 * per key at a time. Not reentrant: a task that waits on its own key never
 * starts, so code inside one calls the unwrapped work directly.
 */
export function exclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(() => task())
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return run
}

export function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}

export function clockTime(ms: number): string {
  const date = new Date(ms)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

export function compactTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** The end of the balanced `{...}` that opens at `start`, string-aware; -1 if none. */
function closingBrace(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (char === '\\') i++
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * The last JSON object in a model's reply that `isWanted` accepts: a ```json
 * fence first, else the last top-level balanced object in the reply's tail
 * (nested objects are skipped, so a report's `fix` is never taken for it).
 */
export function extractJson(
  text: string,
  isWanted: (value: Record<string, unknown>) => boolean = () => true,
): Record<string, unknown> | undefined {
  const fences = [...text.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)```/g)]
  for (const fence of fences.reverse()) {
    const parsed = tryParse(fence[1] ?? '')
    if (parsed && isWanted(parsed)) return parsed
  }
  const tail = text.slice(-20_000)
  let found: Record<string, unknown> | undefined
  let i = tail.indexOf('{')
  while (i >= 0) {
    const end = closingBrace(tail, i)
    const parsed = end < 0 ? undefined : tryParse(tail.slice(i, end + 1))
    if (parsed && isWanted(parsed)) found = parsed
    i = tail.indexOf('{', parsed ? end + 1 : i + 1)
  }
  return found
}

function tryParse(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text.trim())
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export const str = (value: unknown, max: number, fallback = ''): string =>
  typeof value === 'string' ? clip(value.trim(), max) : fallback

export const strList = (value: unknown, maxItems: number): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').slice(0, maxItems)
    : []
