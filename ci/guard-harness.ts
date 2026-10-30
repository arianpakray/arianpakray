/**
 * stress-scout's guard, against the real bash: each case is run with `git` stubbed
 * (so nothing pushes) and noted for whether the stub ran. A case that ran git but
 * that checkBash allowed is a miss. Run with `bun ci/guard-harness.ts` on a machine
 * with bash; it exits non-zero on any miss.
 */
import { spawnSync } from 'node:child_process'

import { checkBash } from '../plugins/stress-scout/hooks/lib/policy.ts'

const BOX = { roots: ['/work/proj'], runDirs: ['/tmp/run'], home: '/Users/dev' }
const P = 'git push'

/** Ways to hide a `git push` in command substitutions, quotes and comments. */
const cases = [
  `echo $(${P})`,
  `echo $((${P}))`,
  `echo $( (${P}) )`,
  `echo $((${P}) )`,
  `echo $((${P}); echo x)`,
  `echo $( (${P}); echo x )`,
  `echo $((true) && ${P})`,
  `echo $((true); ${P})`,
  `echo $(( (${P}) ))`,
  `echo "$((${P}))"`,
  `echo "$((true);${P})"`,
  `echo \`${P}\``,
  `echo "\`${P}\`"`,
  `echo "\\\`x\\\` $(${P})"`,
  `echo "a\\"$(${P})"`,
  `echo "$(echo ")"; ${P})"`,
  `echo "$(echo '"'; ${P})"`,
  `echo "$(echo \\); ${P})"`,
  `echo $(echo ')' ; ${P})`,
  `echo $(echo "(" ; ${P})`,
  `echo $(case x in x) ${P};; esac)`,
  `echo $(echo a # )\n${P})`,
  `cat <(${P})`,
  `echo > >(${P})`,
  `echo "<(${P})"`,
  `echo $(echo $(echo $(echo $(echo $(${P})))))`,
  `echo $(echo $(echo $(echo ${'`'}${P}${'`'})))`,
  `echo $(((1)) ; ${P})`,
  `echo $(( 1 )) $(${P})`,
  `echo \\$(${P})`,
  `echo '$(x)' $(${P})`,
  `echo $'\\'' $(${P})`,
  `echo "'" $(${P})`,
  `echo \`echo \\\`${P}\\\`\``,
  `x=$(${P})`,
  `echo \${x:-$(${P})}`,
  `echo "\${x:-$(${P})}"`,
  `echo $[ $(${P}) ]`,
  `echo $(( $(${P}) ))`,
  `echo $((0)) $((${P}))`,
  `echo $(<(${P}))`,
  `echo $( ${P} )`,
  `echo $(echo $'\\')'; ${P})`,
  `echo $(echo "$'" ; ${P})`,
]

/** What must stay allowed: arithmetic, and `$(` that is only text or a harmless read. */
const stayAllowed = [
  'echo $((1 + 2))',
  'echo $(( (1+2)*3 ))',
  "echo '$(git push)'",
  'x=$(cat .stress-scout/a.txt) && echo "$x"',
  'echo "$(( 2 ** 3 ))"',
]

let misses = 0
const miss = (text: string): void => {
  misses++
  console.log(`MISS ${text}`)
}

for (const text of cases) {
  const ran = spawnSync('bash', ['-c', `git(){ echo RAN; }; ${text}`], { encoding: 'utf8', timeout: 10_000 }).stdout.includes('RAN')
  const { isAllowed } = checkBash(text, BOX)
  if (ran && isAllowed) miss(`bash ran git but the guard allowed: ${JSON.stringify(text)}`)
}
for (const text of stayAllowed) {
  if (!checkBash(text, BOX).isAllowed) miss(`the guard refused: ${JSON.stringify(text)}`)
}

console.log(misses === 0 ? `all ${cases.length + stayAllowed.length} checks passed` : `${misses} miss(es)`)
process.exit(misses === 0 ? 0 : 1)
