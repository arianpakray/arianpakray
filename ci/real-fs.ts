/**
 * stress-scout's file system and git work, on the real machine: the parts the
 * plugin tests can only fake. Run with `bun ci/real-fs.ts` on Linux, macOS
 * and Windows; it exits non-zero on the first broken promise.
 */
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { linkFolder, removeTree } from '../plugins/stress-scout/hooks/lib/platform.ts'
import { fingerprintOrRebuild, makeSnapshot, openShadow, patchOf, ShadowLocked } from '../plugins/stress-scout/hooks/lib/shadow.ts'

const isWindows = process.platform === 'win32'

type RunInit = { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }

/** The engine calls the plugin makes, answered by the real machine. */
const $ = {
  process: {
    run: (argv: readonly string[], init: RunInit = {}) =>
      new Promise<{ exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }>(
        (resolve, reject) => {
          const child = spawn(argv[0] ?? '', argv.slice(1), { cwd: init.cwd, env: { ...process.env, ...init.env }, windowsHide: true })
          let stdout = ''
          let stderr = ''
          child.stdout.on('data', chunk => (stdout += chunk))
          child.stderr.on('data', chunk => (stderr += chunk))
          child.on('error', reject)
          const timer = setTimeout(() => child.kill(), init.timeoutMs ?? 30_000)
          child.on('close', code => {
            clearTimeout(timer)
            resolve({ exitCode: code ?? 1, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })
          })
          child.stdin.end(init.stdin ?? '')
        },
      ),
  },
  fs: {
    write: async (path: string, text: string) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    },
    exists: async (path: string) => existsSync(path),
    stat: async (path: string, options?: { resolve?: boolean }) => {
      const stat = statSync(path)
      return {
        kind: stat.isDirectory() ? 'dir' : 'file',
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        isLink: lstatSync(path).isSymbolicLink(),
        ...(options?.resolve === true ? { realPath: realpathSync.native(path) } : {}),
      }
    },
    list: async (path: string) => readdirSync(path, { withFileTypes: true }).map(entry => ({ name: entry.name, kind: entry.isDirectory() ? 'dir' : 'file' })),
  },
  clock: { now: async () => Date.now(), sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) },
  env: { get: async (name: string) => process.env[name] },
} as never

let failures = 0
function check(what: string, isTrue: boolean, detail = ''): void {
  console.log(`${isTrue ? 'ok  ' : 'FAIL'}  ${what}${detail === '' ? '' : `  (${detail})`}`)
  if (!isTrue) failures++
}

function sh(argv: string[], cwd: string): void {
  const result = Bun.spawnSync(argv, { cwd })
  if (result.exitCode !== 0) throw new Error(`${argv.join(' ')} failed: ${result.stderr.toString()}`)
}

const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ss-ci-')))
const root = join(base, 'proj')
const scratch = join(base, 'scratch')
mkdirSync(scratch, { recursive: true })
console.log(`${process.platform}: project ${root}`)

// a small project: committed code, an uncommitted change, and an ignored node_modules
write(join(root, 'src', 'app.js'), 'export const add = (a, b) => a + b\n')
write(join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 42\n')
write(join(root, '.gitignore'), 'node_modules\n')
sh(['git', 'init', '-q', '.'], root)
sh(['git', '-c', 'user.name=ci', '-c', 'user.email=ci@example.com', 'add', '-A'], root)
sh(['git', '-c', 'user.name=ci', '-c', 'user.email=ci@example.com', 'commit', '-qm', 'init'], root)
write(join(root, 'src', 'app.js'), 'export const add = (a, b) => a - b\n')
const realDep = join(root, 'node_modules', 'dep', 'index.js')

// fingerprint and snapshot
let shadow = await openShadow($, root, scratch)
const first = await fingerprintOrRebuild($, shadow)
shadow = first.shadow
check('the working tree fingerprints', /^[0-9a-f]{40}$/.test(first.tree), first.tree)
const runDir = join(scratch, 'runs', 'run-0001-1')
const { snapshot, linked } = await makeSnapshot($, shadow, first.tree, runDir)
check('the snapshot holds the uncommitted change', readFileSync(join(snapshot, 'src', 'app.js'), 'utf8').includes('a - b'))
check('node_modules is linked into the snapshot', linked.includes('node_modules') && lstatSync(join(snapshot, 'node_modules')).isSymbolicLink())
check('the link reaches the real dependency', readFileSync(join(snapshot, 'node_modules', 'dep', 'index.js'), 'utf8').includes('42'))

// the tester's fix comes back as a patch, its harness left out
write(join(snapshot, 'src', 'app.js'), 'export const add = (a, b) => a + b\n')
write(join(snapshot, '.stress-scout', 'h.js'), 'console.log("harness")\n')
const patch = await patchOf($, shadow, first.tree, snapshot, runDir, [])
check('the fix is read back from git', patch.includes('+export const add = (a, b) => a + b'), `${patch.length} chars`)
check('the harness stays out of the patch', !patch.includes('.stress-scout'))

// deleting a run never follows its link into the real project
check('the run folder deletes', await removeTree($, runDir, isWindows))
check('the run folder is gone', !existsSync(runDir))
check('the real node_modules survives it', existsSync(realDep) && readFileSync(realDep, 'utf8').includes('42'))

// a lock left by a git killed mid-write is cleared; a live one is respected
const lock = join(scratch, 'shadow.index.lock')
write(lock, '')
const old = (Date.now() - 20 * 60_000) / 1000
utimesSync(lock, old, old)
const afterStale = await fingerprintOrRebuild($, shadow)
check('a stale index lock is cleared', afterStale.tree === first.tree && !existsSync(lock))
write(lock, '')
let isLocked = false
try {
  await fingerprintOrRebuild($, shadow)
} catch (error) {
  isLocked = error instanceof ShadowLocked
}
check('a live index lock is respected', isLocked && existsSync(lock))
rmSync(lock)

// a damaged shadow is rebuilt
rmSync(join(scratch, 'shadow.git', 'objects'), { recursive: true, force: true })
const rebuilt = await fingerprintOrRebuild($, shadow)
shadow = rebuilt.shadow
check('a damaged shadow is rebuilt to the same tree', rebuilt.tree === first.tree)

// deep paths: past Windows' 260-character limit inside the snapshot
const deep = join(root, ...Array.from({ length: 10 }, (_, i) => `a-rather-long-folder-name-${i}`), 'deep.txt')
write(deep, 'deep\n')
const deepTree = (await fingerprintOrRebuild($, shadow)).tree
const deepRun = join(scratch, 'runs', 'run-0002-1')
const deepSnapshot = (await makeSnapshot($, shadow, deepTree, deepRun)).snapshot
const deepCopy = join(deepSnapshot, deep.slice(root.length + 1))
check('a deep file is snapshotted', existsSync(deepCopy), `${deepCopy.length} chars`)
check('a deep run folder deletes', (await removeTree($, deepRun, isWindows)) && !existsSync(deepRun))

// a folder named with a quote, linked and deleted
const odd = join(base, "O'Brien's run")
mkdirSync(odd, { recursive: true })
check('a folder with a quote in its name links', await linkFolder($, join(root, 'node_modules'), join(odd, 'node_modules'), isWindows))
check('the quoted link reaches its target', existsSync(join(odd, 'node_modules', 'dep', 'index.js')))
check('the quoted folder deletes, link and all', (await removeTree($, odd, isWindows)) && !existsSync(odd))
check('the real node_modules survives that too', existsSync(realDep))

// a read-only file (git's own objects are read-only on Windows) deletes
const readOnly = join(base, 'ro', 'object')
write(readOnly, 'x')
Bun.spawnSync(isWindows ? ['attrib', '+R', readOnly] : ['chmod', '444', readOnly])
check('a tree holding a read-only file deletes', (await removeTree($, join(base, 'ro'), isWindows)) && !existsSync(join(base, 'ro')))

// a path that starts with '-' is deleted, not read as an option
const here = process.cwd()
process.chdir(base)
for (const name of ['-rf', '-d']) {
  write(join(base, name, 'x'), 'x')
  check(`a folder named ${name} deletes`, (await removeTree($, name, isWindows)) && !existsSync(join(base, name)))
}
process.chdir(here)

// linking over an existing link fails, rather than nesting a link inside its target
const linkTarget = join(base, 'real')
write(join(linkTarget, 'f'), 'x')
const relink = join(base, 'relink')
check('a folder links', await linkFolder($, linkTarget, relink, isWindows))
check('linking it again is refused', !(await linkFolder($, linkTarget, relink, isWindows)))
check('and leaves its target untouched', readdirSync(linkTarget).join(',') === 'f', readdirSync(linkTarget).join(','))

rmSync(base, { recursive: true, force: true })
console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
