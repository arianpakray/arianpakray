/**
 * A shadow git repository in stress-scout's scratch folder that tracks the
 * project's working tree, untracked files included, without touching the
 * project's own .git: `git add -A` into a private index gives a fingerprint
 * (a tree id) of the code as it stands, two trees diff into "what changed",
 * and a tree archives into a disposable snapshot. Where the project is a git
 * repository its objects are borrowed as alternates, so HEAD diffs too and
 * unchanged files are never stored twice.
 */
import type { EngineInterface, ProcessRunResult } from 'claude-code'

import { parseChurn, parseLsTree, type TreeFile } from './rank'
import { exclusive } from './util'

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** Heavy or generated paths no stress test needs; the project's .gitignore applies too. */
const EXCLUDES = [
  '.stress-scout',
  '.claude/worktrees',
  'node_modules',
  'bower_components',
  'jspm_packages',
  '.venv',
  'venv',
  '.tox',
  '.nox',
  '__pycache__',
  '*.pyc',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.hypothesis',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.cache',
  'coverage',
  '.nyc_output',
  '.gradle',
  '.idea',
  '.vscode',
  'Pods',
  'DerivedData',
  '.terraform',
  '.DS_Store',
  '*.log',
  '*.zip',
  '*.tar',
  '*.tgz',
  '*.gz',
  '*.7z',
  '*.rar',
  '*.dmg',
  '*.iso',
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.webp',
  '*.ico',
  '*.mp3',
  '*.mp4',
  '*.mov',
  '*.wav',
  '*.pdf',
  '*.psd',
  '*.sqlite',
  '*.sqlite3',
  '*.db',
  '*.parquet',
  '*.pkl',
  '*.pt',
  '*.pth',
  '*.onnx',
  '*.safetensors',
  '*.ckpt',
  '*.h5',
  '*.bin',
  '*.so',
  '*.dylib',
  '*.dll',
  '*.exe',
  '*.class',
  '*.jar',
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.keystore',
  '*.jks',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
]

/** Dependency folders an ignored install lives in: linked, not copied, into a snapshot. */
export const DEP_DIRS = ['node_modules', '.venv', 'venv', 'vendor', 'bower_components']

/** Where a run's snapshot lives inside its run folder. */
export const snapshotOf = (runDir: string): string => `${runDir.replace(/\/+$/, '')}/snapshot`

/** Older than any write of ours (each is killed at 3 minutes): a lock a git left when it died mid-write. */
const STALE_LOCK_MS = 10 * 60_000

/** Lockfiles and other diff noise left out of the triage diff. */
const DIFF_NOISE = [
  ':(exclude,glob)**/package-lock.json',
  ':(exclude,glob)**/yarn.lock',
  ':(exclude,glob)**/pnpm-lock.yaml',
  ':(exclude,glob)**/bun.lockb',
  ':(exclude,glob)**/Cargo.lock',
  ':(exclude,glob)**/poetry.lock',
  ':(exclude,glob)**/uv.lock',
  ':(exclude,glob)**/go.sum',
  ':(exclude,glob)**/Gemfile.lock',
  ':(exclude,glob)**/composer.lock',
  ':(exclude,glob)**/*.min.*',
  ':(exclude,glob)**/*.map',
  ':(exclude,glob)**/*.snap',
  ':(exclude,glob)**/*.svg',
]

export type Shadow = {
  /** The project's root: the shadow's work tree. */
  root: string
  /** stress-scout's scratch folder for this project. */
  scratch: string
  gitDir: string
  index: string
  /** Whether the project is itself a git repository (its objects are alternates). */
  isProjectGit: boolean
}

type GitOptions = { workTree?: string; index?: string; timeoutMs?: number; isTolerant?: boolean }

export class GitError extends Error {}

/** Another git process holds the shadow index: try again later rather than rebuild under it. */
export class ShadowLocked extends GitError {}

/** Git against the shadow repository, the project (or a snapshot) as its work tree. */
async function git(
  $: EngineInterface,
  shadow: Shadow,
  args: readonly string[],
  options: GitOptions = {},
): Promise<ProcessRunResult> {
  const result = await $.process.run(
    [
      'git',
      '-c', 'core.quotepath=off',
      '-c', 'core.autocrlf=false',
      '-c', 'core.safecrlf=false',
      '-c', 'advice.addEmbeddedRepo=false',
      '-c', 'gc.auto=0',
      ...args,
    ],
    {
      cwd: options.workTree ?? shadow.root,
      env: {
        GIT_DIR: shadow.gitDir,
        GIT_WORK_TREE: options.workTree ?? shadow.root,
        GIT_INDEX_FILE: options.index ?? shadow.index,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
      },
      timeoutMs: options.timeoutMs ?? 60_000,
    },
  )
  if (result.exitCode !== 0 && options.isTolerant !== true) {
    throw new GitError(`git ${args[0] ?? ''} failed: ${result.stderr.trim().slice(0, 300)}`)
  }
  return result
}

/** The project's own git, as the developer has it (no shadow environment). */
async function projectGit($: EngineInterface, root: string, args: readonly string[]): Promise<ProcessRunResult> {
  return $.process.run(['git', '-C', root, ...args], {
    env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    timeoutMs: 30_000,
  })
}

/**
 * Opens (creating on first use) the shadow repository for `root` under `scratch`.
 * Like every write to the shadow, it waits for the one before it on that scratch:
 * the shadow index admits a single writer, and a heartbeat can meet a cycle.
 */
export function openShadow($: EngineInterface, root: string, scratch: string): Promise<Shadow> {
  return exclusive(scratch, () => openShadowNow($, root, scratch))
}

async function openShadowNow($: EngineInterface, root: string, scratch: string): Promise<Shadow> {
  const gitDir = `${scratch}/shadow.git`
  const common = await projectGit($, root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const isProjectGit = common.exitCode === 0 && common.stdout.trim() !== ''
  const shadow: Shadow = { root, scratch, gitDir, index: `${scratch}/shadow.index`, isProjectGit }
  if (!(await $.fs.exists(`${gitDir}/HEAD`))) {
    const init = await $.process.run(['git', 'init', '-q', '--bare', gitDir], { timeoutMs: 30_000 })
    if (init.exitCode !== 0) throw new GitError(`git init failed: ${init.stderr.trim().slice(0, 300)}`)
  }
  await $.fs.write(`${gitDir}/info/exclude`, `${EXCLUDES.join('\n')}\n`)
  await $.fs.write(`${gitDir}/objects/info/alternates`, isProjectGit ? `${common.stdout.trim()}/objects\n` : '')
  return shadow
}

/** Forgets the shadow's index, its lock and its objects, for when they no longer match the project. */
async function resetShadowNow($: EngineInterface, shadow: Shadow): Promise<void> {
  for (const path of [shadow.gitDir, shadow.index, `${shadow.index}.lock`]) {
    if (path.startsWith(`${shadow.scratch}/`)) await $.process.run(['rm', '-rf', path], { timeoutMs: 60_000 })
  }
}

/**
 * The tree id of the working tree as it stands (equal ids mean nothing
 * changed), and the shadow it was read through: rebuilt from scratch first
 * when it is damaged (its scratch folder cleaned, a git killed mid-write).
 * One exclusive section, so no other writer meets the shadow half rebuilt.
 */
export function fingerprintOrRebuild($: EngineInterface, shadow: Shadow): Promise<{ shadow: Shadow; tree: string }> {
  return exclusive(shadow.scratch, async () => {
    try {
      return { shadow, tree: await fingerprintNow($, shadow) }
    } catch (error) {
      if (error instanceof ShadowLocked) throw error
      await resetShadowNow($, shadow)
      const rebuilt = await openShadowNow($, shadow.root, shadow.scratch)
      return { shadow: rebuilt, tree: await fingerprintNow($, rebuilt) }
    }
  })
}

async function fingerprintNow($: EngineInterface, shadow: Shadow): Promise<string> {
  // a second session in this project may hold the index for a moment; a git killed mid-write holds it for good
  for (let attempt = 1; ; attempt++) {
    const added = await git($, shadow, ['add', '-A', '--ignore-errors', '--', '.'], { timeoutMs: 180_000, isTolerant: true })
    if (!added.stderr.includes('index.lock')) break
    if (attempt === 4) throw new ShadowLocked('the shadow index is locked by another git process (index.lock)')
    if (!(await removeStaleLock($, shadow))) await $.clock.sleep(250 * 2 ** attempt)
  }
  const tree = (await git($, shadow, ['write-tree'])).stdout.trim()
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new GitError('git write-tree gave no tree')
  return tree
}

/** Removes the shadow index's lock when no live git can still own it; true when it did. */
async function removeStaleLock($: EngineInterface, shadow: Shadow): Promise<boolean> {
  const lock = `${shadow.index}.lock`
  const stat = await $.fs.stat(lock).catch(() => undefined)
  if (stat === undefined || (await $.clock.now()) - stat.mtimeMs < STALE_LOCK_MS) return false
  return (await $.process.run(['rm', '-f', lock])).exitCode === 0
}

/** Whether the shadow holds `tree`; one remembered from before the shadow was rebuilt is gone. */
export async function hasTree($: EngineInterface, shadow: Shadow, tree: string): Promise<boolean> {
  return (await git($, shadow, ['cat-file', '-e', `${tree}^{tree}`], { isTolerant: true })).exitCode === 0
}

/** The project's HEAD tree, when it has one; the shadow reads it through the alternates. */
export async function headTree($: EngineInterface, shadow: Shadow): Promise<string> {
  if (!shadow.isProjectGit) return ''
  const head = await projectGit($, shadow.root, ['rev-parse', '--verify', '-q', 'HEAD^{tree}'])
  return head.exitCode === 0 ? head.stdout.trim() : ''
}

export async function diffStat($: EngineInterface, shadow: Shadow, from: string, to: string): Promise<string> {
  return (await git($, shadow, ['diff', '--no-color', '--stat=160', '--stat-count=60', from, to, '--', '.', ...DIFF_NOISE])).stdout
}

export async function changedPaths($: EngineInterface, shadow: Shadow, from: string, to: string): Promise<string[]> {
  const out = (await git($, shadow, ['diff', '--no-color', '--name-only', '--diff-filter=AMR', from, to, '--', '.', ...DIFF_NOISE])).stdout
  return out.split('\n').map(line => line.trim()).filter(line => line !== '')
}

export async function diffText(
  $: EngineInterface,
  shadow: Shadow,
  from: string,
  to: string,
  paths: readonly string[],
  maxChars: number,
): Promise<string> {
  const spec = paths.length > 0 ? paths : ['.', ...DIFF_NOISE]
  const out = (await git($, shadow, ['diff', '--no-color', '-U3', '--diff-filter=AMR', from, to, '--', ...spec])).stdout
  return out.length <= maxChars ? out : `${out.slice(0, maxChars)}\n… (diff cut at ${maxChars} characters)`
}

export async function listTree($: EngineInterface, shadow: Shadow, tree: string): Promise<TreeFile[]> {
  return parseLsTree((await git($, shadow, ['ls-tree', '-r', '-l', '--full-tree', tree], { timeoutMs: 60_000 })).stdout)
}

/** How often each path changed in the project's recent commits; empty without git history. */
export async function churn($: EngineInterface, shadow: Shadow): Promise<Map<string, number>> {
  if (!shadow.isProjectGit) return new Map()
  const log = await projectGit($, shadow.root, ['log', '--since=120.days', '-n', '400', '--name-only', '--format='])
  return log.exitCode === 0 ? parseChurn(log.stdout) : new Map()
}

/** Writes `tree` out as a disposable copy under `runDir`, its ignored dependency folders linked. */
export async function makeSnapshot(
  $: EngineInterface,
  shadow: Shadow,
  tree: string,
  runDir: string,
): Promise<{ snapshot: string; linked: string[] }> {
  const snapshot = snapshotOf(runDir)
  const tar = `${runDir}/snapshot.tar`
  await $.fs.write(`${runDir}/tmp/.keep`, '')
  await $.fs.write(`${snapshot}/.stress-scout/.keep`, '')
  await git($, shadow, ['archive', '--format=tar', '-o', tar, tree], { timeoutMs: 180_000 })
  const untar = await $.process.run(['tar', '-xf', tar, '-C', snapshot], { timeoutMs: 180_000 })
  if (untar.exitCode !== 0) throw new GitError(`tar failed: ${untar.stderr.trim().slice(0, 300)}`)
  await $.process.run(['rm', '-f', tar])
  const linked: string[] = []
  for (const dir of DEP_DIRS) {
    if ((await $.fs.exists(`${shadow.root}/${dir}`)) && !(await $.fs.exists(`${snapshot}/${dir}`))) {
      const link = await $.process.run(['ln', '-s', `${shadow.root}/${dir}`, `${snapshot}/${dir}`])
      if (link.exitCode === 0) linked.push(dir)
    }
  }
  return { snapshot, linked }
}

/**
 * The tester's fix as a unified diff: the snapshot as it was left, against
 * the tree it was made from, harness and new files excluded unless the
 * report names them. Ground truth from git, not the model's own account.
 */
export async function patchOf(
  $: EngineInterface,
  shadow: Shadow,
  baseTree: string,
  snapshot: string,
  runDir: string,
  addedFiles: readonly string[],
): Promise<string> {
  const options = { workTree: snapshot, index: `${runDir}/snapshot.index`, timeoutMs: 180_000 }
  await git($, shadow, ['add', '-A', '--ignore-errors', '--', '.'], { ...options, isTolerant: true })
  const after = (await git($, shadow, ['write-tree'], options)).stdout.trim()
  if (!/^[0-9a-f]{40,64}$/.test(after) || after === baseTree) return ''
  const changed = (await git($, shadow, ['diff', '--no-color', '-M', '--diff-filter=MRD', baseTree, after, '--', '.', ':(exclude).stress-scout'], options)).stdout
  const safeAdded = addedFiles.filter(path => !path.startsWith('/') && !path.includes('..') && !path.startsWith('.stress-scout'))
  const added =
    safeAdded.length > 0
      ? (await git($, shadow, ['diff', '--no-color', '--diff-filter=A', baseTree, after, '--', ...safeAdded], options)).stdout
      : ''
  return `${changed}${added}`.trim()
}

/** Blob ids of `paths` in `tree`, joined: equal strings mean the files are unchanged. */
export async function blobsOf($: EngineInterface, shadow: Shadow, tree: string, paths: readonly string[]): Promise<Map<string, string>> {
  const blobs = new Map<string, string>()
  if (paths.length === 0) return blobs
  const out = await git($, shadow, ['ls-tree', '-r', '-l', '--full-tree', tree, '--', ...paths], { isTolerant: true })
  for (const file of parseLsTree(out.stdout)) blobs.set(file.path, file.sha)
  return blobs
}
