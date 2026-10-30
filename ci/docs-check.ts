/**
 * Every command in stress-scout's `/stress` switch is in its help text and in the README's command
 * table, so a new verb cannot ship undocumented. Run with `bun ci/docs-check.ts`; exits non-zero on any gap.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const source = readFileSync(join(root, 'plugins/stress-scout/hooks/register.tsx'), 'utf8')
const readme = readFileSync(join(root, 'README.md'), 'utf8')

const between = (text: string, from: string, to: string): string => {
  const start = text.indexOf(from)
  const end = text.indexOf(to, start + from.length)
  if (start < 0 || end < 0) throw new Error(`could not find ${from} ... ${to}`)
  return text.slice(start, end)
}

const switchBody = between(source, 'async function runCommand', 'async function onSessionStart')
const verbs = [...switchBody.matchAll(/case '([a-z]+)':/g)].map(match => match[1] ?? '')
const help = between(source, 'const HELP = [', ".join('\\n')")
const table = between(readme, '## Use', '## Cost guardrails')
  .split('\n')
  .filter(row => row.startsWith('|'))
  .join('\n')

let gaps = 0
const hasWord = (text: string, verb: string): boolean => new RegExp(`(^|[^a-z])${verb}([^a-z]|$)`).test(text)
for (const verb of verbs) {
  for (const [name, text] of [['/stress help', help], ['the README command table', table]] as const) {
    if (!hasWord(text, verb)) {
      gaps++
      console.log(`MISSING /stress ${verb} is not in ${name}`)
    }
  }
}
if (verbs.length < 10) {
  gaps++
  console.log(`only ${verbs.length} commands found in runCommand: has its shape changed?`)
}
console.log(gaps === 0 ? `all ${verbs.length} commands are documented` : `${gaps} gap(s)`)
process.exit(gaps === 0 ? 0 : 1)
