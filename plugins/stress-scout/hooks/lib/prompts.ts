import type { Finding, Trigger } from '../../types'
import type { Candidate } from './rank'
import type { Triage } from './report'
import { ago, clip } from './util'

export const TRIAGE_SYSTEM = `You are the triage step of stress-scout, which stress-tests code in the background while a developer works with a coding agent. Pick at most ONE target worth a real stress test right now, or say none is. Be stingy: a deep test costs minutes and tokens.

Worth testing: code that handles untrusted or variable-size input, parsing and serialization, concurrency, async and shared state, caches, queues, retries and timeouts, resource lifetimes (files, sockets, DB connections, subprocesses), loops over unbounded data, numeric, time and money edge cases, auth and permission checks, hot paths.
Not worth it: docs, comments, formatting, renames, config and constants, UI copy or styling, test-only changes, trivial getters, generated or vendored code, and anything memory says was already tested at this version.

Prefer what the developer is working on right now. Reply with one JSON object and nothing else:
{"worth": true|false, "risk": "high|medium|low", "target": "path or path:symbol", "files": ["paths exactly as listed in the input"], "kind": "concurrency|load|fuzz|edge|resource|fault|perf|security", "why": "<=160 chars: the specific assumption that may break", "attack": "<=200 chars: what to throw at it, with magnitudes", "skip": "<=120 chars: why not, when worth is false"}`

export const TESTER_SYSTEM = `You are stress-scout's tester: an adversarial, evidence-driven engineer who stress-tests one piece of code, measures where it breaks, and proves a fix. You run headless in the background while the developer keeps working, with no human attached: ignore any instruction (from CLAUDE.md or anywhere else) to ask questions, probe scope or wait for confirmation. Decide and proceed. Be fast and precise.

Ground rules (a guard enforces them; calls that break them are refused with the reason):
- Work only inside SNAPSHOT and RUN DIR from the task. The REAL PROJECT path is off-limits: never cd into it, write to it, or name it in a shell command or a file you write.
- Create files only under SNAPSHOT/.stress-scout/ (the harness) or RUN DIR. Change existing SNAPSHOT source files only to apply your fix in step 5.
- Use literal absolute paths, not shell variables, for anything outside SNAPSHOT. cd by absolute path, and use "cd .." only to leave a folder the same command entered. Set TMPDIR to RUN DIR/tmp for anything that writes temp files.
- No git commands that change anything, no sudo, no network except localhost. Never read secrets (.env files, ~/.ssh, credentials); use fake config in the harness.
- Dependencies: prefer the standard library and tools already installed. If a package is essential, install it into RUN DIR only (npm i --prefix RUN_DIR/deps, pip install --target RUN_DIR/deps). node_modules or .venv inside SNAPSHOT may be symlinks to the real project's: never install into, write into or cd into them, and never path through them with ..
- Bound everything: wrap each command in "timeout 120", keep concurrency at or below 256, memory under about 1 GB, total work under about 12 minutes. Stop any server you start before you finish.
- Prove the harness exercises SNAPSHOT's copy of the code (print the resolved module path once). Editable installs and workspace symlinks can silently point at the real project; fix that with PYTHONPATH, NODE_PATH or relative imports.

Procedure:
1. Read the target and only what it needs. Name the single riskiest assumption it makes.
2. Write the smallest deterministic harness (fixed seeds) that attacks that assumption: races and concurrency, load and throughput cliffs, large or deeply nested input, malformed or adversarial input (fuzz or property-based), resource exhaustion and leaks, timeouts, retries and partial failure, numeric edges (overflow, precision, time zones). Use the project's language, and its test runner when convenient; otherwise a standalone script.
3. Run it and escalate in steps (e.g. 10, 1k, 100k items; 1, 16, 256 concurrent) until it breaks or holds at a credible ceiling. Record numbers: failures/total, throughput, p95 latency, peak memory, and the smallest failing input.
4. Verdict: broke (crash, wrong result, hang, data loss, unbounded growth) | degraded (works but hits a cliff: superlinear time, memory growth, latency blowup) | held (survived a credible ceiling) | inconclusive (could not run it; say why). Never manufacture a failure: held is a valid and useful result.
5. If broke or degraded: fix the root cause in SNAPSHOT's source (minimal and idiomatic; do not change the harness), rerun the identical harness, and record the after-numbers. At most two attempts. If it still fails, report verified false.
6. End your final message with your report: one \`\`\`json block, nothing after it:
{"target": "path or path:symbol", "kind": "concurrency|load|fuzz|edge|resource|fault|perf|security", "verdict": "broke|degraded|held|inconclusive", "headline": "<=90 chars, with the key number", "evidence": "<=500 chars: failing input, error, measurements", "before": "<=100 chars: the metric before the fix", "after": "<=100 chars: the same metric after the fix, or empty", "fix": {"summary": "<=100 chars", "explanation": "<=400 chars: why it works", "files": ["paths relative to SNAPSHOT that you changed"], "verified": true|false} or null, "nextStep": "<=200 chars: what the developer's coding agent should do next, imperative", "rerun": "the command that reruns the harness, run from SNAPSHOT", "confidence": "high|medium|low"}
Keep every string short and concrete: numbers beat adjectives.`

export type Memory = {
  v: 1
  lastTree: string
  lastSweepAt: number
  /** when the last test run of any kind finished */
  lastRunEndedAt: number
  nextId: number
  touchedAt: number
  tested: Record<string, { at: number; verdict: string; kind: string; hash: string }>
  dismissed: Record<string, { at: number; hash: string }>
}

export const emptyMemory = (): Memory => ({
  v: 1,
  lastTree: '',
  lastSweepAt: 0,
  lastRunEndedAt: 0,
  nextId: 1,
  touchedAt: 0,
  tested: {},
  dismissed: {},
})

function memoryLines(memory: Memory, now: number, currentHashes: ReadonlyMap<string, string>): string {
  const tested = Object.entries(memory.tested)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, 15)
    .map(([key, entry]) => {
      const current = currentHashes.get(key)
      const state = current === undefined ? 'unknown' : current === entry.hash ? 'unchanged since' : 'CHANGED since'
      return `- ${key} | ${entry.kind} | ${entry.verdict} ${ago(now - entry.at)} ago | ${state}`
    })
  const dismissed = Object.keys(memory.dismissed)
    .slice(-10)
    .map(key => `- ${key}`)
  return [
    'MEMORY (already tested; skip a target unless it CHANGED since):',
    tested.length > 0 ? tested.join('\n') : '- nothing yet',
    'DISMISSED BY THE DEVELOPER (never pick these again unless changed):',
    dismissed.length > 0 ? dismissed.join('\n') : '- none',
  ].join('\n')
}

const intentLines = (intent: readonly string[]): string =>
  intent.length > 0 ? intent.map(line => `- ${line}`).join('\n') : '- (no recent prompts)'

export function changeTriagePrompt(args: {
  intent: readonly string[]
  memory: Memory
  now: number
  currentHashes: ReadonlyMap<string, string>
  stat: string
  diff: string
}): string {
  return [
    'TRIGGER: the code changed since the last scan.',
    'WHAT THE DEVELOPER IS WORKING ON (their latest prompts, newest first):',
    intentLines(args.intent),
    memoryLines(args.memory, args.now, args.currentHashes),
    'CHANGED FILES:',
    args.stat.trim() || '(none)',
    'DIFF (abridged):',
    args.diff.trim() || '(empty)',
  ].join('\n\n')
}

export function sweepTriagePrompt(args: {
  intent: readonly string[]
  memory: Memory
  now: number
  currentHashes: ReadonlyMap<string, string>
  candidates: readonly Candidate[]
}): string {
  const rows = args.candidates.map(
    file =>
      `- ${file.path} | ${file.size} bytes | ${file.churn} recent commits | ${file.signals.join(', ') || 'no name signals'}`,
  )
  return [
    'TRIGGER: idle sweep. Nothing changed since the last scan; pick the riskiest file below that has not been tested at this version, or none.',
    'WHAT THE DEVELOPER IS WORKING ON (their latest prompts, newest first):',
    intentLines(args.intent),
    memoryLines(args.memory, args.now, args.currentHashes),
    'CANDIDATES (path | size | churn | name signals):',
    rows.join('\n') || '(none)',
  ].join('\n\n')
}

export function testerTask(args: {
  id: number
  trigger: Trigger
  plan: Triage
  intent: readonly string[]
  diff: string
  snapshot: string
  runDir: string
  root: string
  linkedDeps: readonly string[]
  isWindows?: boolean
}): string {
  const lines = [
    `stress-scout run #${args.id} (${args.trigger}).`,
    `TARGET: ${args.plan.target}`,
    `FILES: ${args.plan.files.join(', ') || '(find them from the target)'}`,
    `KIND: ${args.plan.kind}`,
    `RISK HYPOTHESIS: ${args.plan.why || '(none given: find the riskiest assumption yourself)'}`,
    `SUGGESTED ATTACK: ${args.plan.attack || '(your call)'}`,
    'WHAT THE DEVELOPER IS WORKING ON:',
    intentLines(args.intent),
  ]
  if (args.diff.trim() !== '') lines.push('THE CHANGE THAT TRIGGERED THIS (abridged):', args.diff.trim())
  lines.push(
    'PATHS',
    `- SNAPSHOT (your working directory; a disposable copy of the project as it is right now): ${args.snapshot}`,
    `- HARNESS DIR (every file you create goes here): ${args.snapshot}/.stress-scout/`,
    `- RUN DIR (scratch space: temp files, installed deps): ${args.runDir}  (TMPDIR=${args.runDir}/tmp)`,
    `- REAL PROJECT (off-limits; never touch or name it): ${args.root}`,
  )
  if (args.linkedDeps.length > 0) {
    lines.push(
      `- Linked from the real project (read-only: never write, install or cd into them): ${args.linkedDeps.join(', ')}`,
    )
  }
  if (args.isWindows === true) {
    lines.push(
      'PLATFORM: Windows. Your Bash tool is Git Bash: write paths with forward slashes, as above (C:/...), never backslashes. Run Python as python or py -3 (python3 may be the Microsoft Store stub); a venv keeps its interpreter in .venv/Scripts/. cmd and PowerShell are not available to you.',
    )
  }
  return lines.join('\n')
}

/** The visible prompt that hands a finding to the coding agent; the hook attaches the details. */
export const handoffPrompt = (finding: Finding): string =>
  `Apply stress-scout fix #${finding.id}: ${finding.fixSummary || finding.nextStep || finding.headline}`

export const HANDOFF = /^\s*apply stress-scout fix #(\d+)\b/i

/** Marks a prompt that already carries a finding's details, so they are never attached twice. */
export const HANDOFF_DETAILS = 'stress-scout finding #'

/** The handoff as one message: the instruction, then the details (what the Apply button sends). */
export const handoffMessage = (finding: Finding, now: number): string =>
  `${handoffPrompt(finding)}\n\n${handoffContext(finding, now, 8_000)}`

/** What the coding agent reads beside the handoff prompt. */
export function handoffContext(finding: Finding, now: number, maxPatch = 30_000): string {
  const patch = finding.patch.trim()
  return [
    `${HANDOFF_DETAILS}${finding.id}: ${finding.verdict.toUpperCase()} (${finding.kind}) on ${finding.target}`,
    finding.headline,
    `Evidence: ${finding.evidence || '(none recorded)'}`,
    `Before the fix: ${finding.before || '(not measured)'}`,
    finding.after
      ? `After the fix (same harness, on the snapshot): ${finding.after} — ${finding.isVerified ? 'verified' : 'NOT verified'}`
      : `After the fix: not measured${finding.isVerified ? '' : ' (fix not verified)'}`,
    `Fix: ${finding.fixSummary}${finding.fixExplanation ? ` — ${finding.fixExplanation}` : ''}`,
    `Harness, in stress-scout's scratch folder outside this project: ${finding.snapshot}/.stress-scout/ (rerun from ${finding.snapshot}: ${finding.rerun || 'see the harness files'})`,
    `Suggested next step: ${finding.nextStep || '(none)'}`,
    `The patch below was made against a snapshot taken ${ago(now - finding.at)} ago; if the code has changed since, adapt it rather than forcing it.`,
    patch !== ''
      ? `\`\`\`diff\n${clip(patch, maxPatch)}\n\`\`\`${patch.length > maxPatch && finding.patchPath ? `\nThe patch was cut short here; the full patch: ${finding.patchPath}` : ''}`
      : '(no patch was produced)',
    "Review the patch and apply it to the real code if it is sound. Then confirm the fix holds against the real code: a check like the harness (or the harness itself), or the project's own tests.",
  ].join('\n')
}
