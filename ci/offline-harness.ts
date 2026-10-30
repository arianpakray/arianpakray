/**
 * stress-scout's offline mode, against the real tool: `curl` is run through `offlineCommand` and must
 * reach nothing outside the machine. Run with `bun ci/offline-harness.ts` on macOS (sandbox-exec) or
 * Linux (unshare -rn); it exits non-zero when the wrapper lets the internet through or breaks a command.
 *
 * Where the offline tool cannot run here (Ubuntu 24.04 restricts `unshare -rn` through AppArmor, say) the
 * plugin's own probe says so and the tester falls back to the guard alone: that is reported, and is a pass
 * only when the probe and a direct try of the tool agree. Loopback is reported either way: the profile on
 * macOS allows it; a fresh Linux network namespace starts with `lo` down, so a server a test starts
 * inside one command may not be reachable.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'

import { NO_NETWORK_PROFILE, offlineCommand, probeOffline } from '../plugins/stress-scout/hooks/lib/platform.ts'

const EXTERNAL = 'https://example.com/'

if (process.platform === 'win32') {
  console.log('offline mode does not exist on Windows (the plugin reports "network: on (Windows)"); nothing to check')
  process.exit(0)
}

const run = (command: string, timeoutMs = 30_000): Promise<{ code: number | null; out: string }> =>
  new Promise(resolve => {
    const child = spawn('bash', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (out += chunk))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, out: out.trim() })
    })
  })

const freePort = (): Promise<number> =>
  new Promise(resolve => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

let failures = 0
const fail = (text: string): void => {
  failures++
  console.log(`FAIL ${text}`)
}

// the plugin's own probe, with a process.run that really runs
const probe = {
  process: {
    run: async (argv: readonly string[]) => {
      const done = spawnSync(argv[0] ?? '', argv.slice(1), { encoding: 'utf8', timeout: 10_000 })
      return { exitCode: done.status ?? 1, stdout: done.stdout ?? '', stderr: done.stderr ?? '' }
    },
  },
}
const how = await probeOffline(probe as never, false)

if (how === '') {
  const kernel = process.platform === 'darwin' ? 'Darwin' : 'Linux'
  const direct = kernel === 'Darwin' ? spawnSync('sandbox-exec', ['-p', NO_NETWORK_PROFILE, '/usr/bin/true'], { encoding: 'utf8' }) : spawnSync('unshare', ['-rn', 'true'], { encoding: 'utf8' })
  console.log(`no offline tool works here (${kernel}): ${(direct.stderr || direct.error?.message || 'exit ' + direct.status).trim()}`)
  if (direct.status === 0) {
    fail('the tool runs when tried directly, but the plugin probe reported guard only')
  } else {
    console.log('the plugin would report "network: guard only" and run the tester with the guard alone: consistent')
  }
  console.log(failures === 0 ? 'fallback verified' : `${failures} failure(s)`)
  process.exit(failures === 0 ? 0 : 1)
}

console.log(`offline tool: ${how}`)

// the wrapper must still run commands
const echo = await run(offlineCommand(how, "echo 'wrapped ok'"))
if (echo.code !== 0 || !echo.out.includes('wrapped ok')) fail(`a plain command did not run through the wrapper: exit ${echo.code} ${echo.out}`)

// the internet: reachable without the wrapper (else the check proves nothing), refused with it
const curl = (url: string): string => `curl -sS -m 10 -o /dev/null -w '%{http_code}' ${url}`
const open = await run(curl(EXTERNAL))
const shut = await run(offlineCommand(how, curl(EXTERNAL)))
if (open.code !== 0) {
  console.log(`inconclusive: ${EXTERNAL} is not reachable even without the wrapper (${open.out}); the machine has no internet`)
} else if (shut.code === 0) {
  fail(`${EXTERNAL} answered ${shut.out} through the wrapper`)
} else {
  console.log(`external refused through the wrapper (curl exit ${shut.code}), reachable without it (${open.out})`)
}

// a server on the host's loopback, outside the wrapper
const hostServer = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('host') })
const viaHost = await run(offlineCommand(how, `curl -sS -m 10 http://127.0.0.1:${hostServer.port}/`))
hostServer.stop(true)
const hostOk = viaHost.code === 0 && viaHost.out === 'host'
console.log(`host loopback server: ${hostOk ? 'reachable' : `not reachable (${viaHost.out || 'exit ' + viaHost.code})`}`)
if (how === 'sandbox-exec' && !hostOk) fail('the macOS profile allows localhost, but the host loopback server was not reachable')

// a server the test itself starts inside the wrapped command: what a stress test does
const port = await freePort()
const inside = [
  `'${process.execPath}' -e 'Bun.serve({port:${port},hostname:"127.0.0.1",fetch:()=>new Response("inside")});setTimeout(()=>process.exit(0),9000)' >/dev/null 2>&1 &`,
  'pid=$!',
  'for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do',
  `  out=$(curl -s -m 2 http://127.0.0.1:${port}/) && { echo "$out"; break; }`,
  '  sleep 0.3',
  'done',
  'kill $pid 2>/dev/null',
].join('\n')
const viaInside = await run(offlineCommand(how, inside))
const insideOk = viaInside.out.endsWith('inside')
const hasIp = spawnSync('sh', ['-c', 'command -v ip'], { encoding: 'utf8' }).status === 0
console.log(`loopback inside one command: ${insideOk ? 'works' : `unavailable (lo is probably down in the new namespace; ip is ${hasIp ? 'installed, so the wrapper could run "ip link set lo up"' : 'not installed'})`}`)
if (how === 'sandbox-exec' && !insideOk) fail('the macOS profile allows localhost, but a server started inside the command was not reachable')

console.log(failures === 0 ? 'offline checks passed' : `${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
