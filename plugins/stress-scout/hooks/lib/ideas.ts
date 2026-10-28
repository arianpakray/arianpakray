import type { IdeaDraft } from './report'

/** The value (0-10) an idea must reach; the prompt tells the model most moments deserve under 5. */
export const IDEA_MIN_VALUE = 8

const MANIFESTS =
  /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|requirements[^/]*\.(txt|in)|Pipfile(\.lock)?|poetry\.lock|pyproject\.toml|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?|composer\.(json|lock))$/i

const INSTALLS =
  /\b(add|adding|introduce|introducing)\b[^.]{0,30}\b(dependenc\w*|package|librar\w*)|\binstall\w*\b|\b(npm|pnpm|yarn|pip3?|cargo|gem)\s+(add|i)\b/i

export type Vetted = { isOk: true } | { isOk: false; reason: string }

/** Whether an idea may be shown: worth a look, small, not taste, no new dependency, and only in files already being edited. */
export function vetIdea(idea: IdeaDraft, recentEdits: readonly string[]): Vetted {
  if (idea.value < IDEA_MIN_VALUE) return { isOk: false, reason: 'below the value threshold' }
  if (idea.size === 'L') return { isOk: false, reason: 'bigger than a small change' }
  if (idea.type === 'style') return { isOk: false, reason: 'only a style preference' }
  if (idea.files.length === 0) return { isOk: false, reason: 'names no files' }
  if (idea.files.some(file => MANIFESTS.test(file)) || INSTALLS.test(`${idea.title} ${idea.why}`)) {
    return { isOk: false, reason: 'adds a dependency' }
  }
  if (idea.files.some(file => !recentEdits.includes(file))) return { isOk: false, reason: 'touches files outside the recent edits' }
  return { isOk: true }
}
