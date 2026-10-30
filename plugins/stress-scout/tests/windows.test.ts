import { describe, expect, test } from 'claude-code/testing'

import { extendedPath, psQuote, removeTreeScript, utf16Base64, windowsCanonical, windowsCanonicalText } from '../hooks/lib/platform'
import { checkBash, checkRead, checkWrite } from '../hooks/lib/policy'

// the same sandbox as policy.test.ts, as the engine spells it on Windows
const RUN = 'C:\\Users\\Arian\\AppData\\Local\\Temp\\stress-scout\\proj-1234abcd\\runs\\run-0001-1700000000000'
const BOX = { roots: ['C:\\Users\\Arian\\proj'], runDirs: [RUN], home: 'C:\\Users\\Arian' }
// how the tester writes it in Git Bash, and the MSYS spelling of the same folder
const FWD = RUN.replace(/\\/g, '/')
const MSYS = '/c/Users/Arian/AppData/Local/Temp/stress-scout/proj-1234abcd/runs/run-0001-1700000000000'

test('Windows paths have one spelling to compare', () => {
  expect(windowsCanonical('C:\\Users\\Arian\\proj')).toBe('/c/users/arian/proj')
  expect(windowsCanonical('C:/Users/Arian/proj')).toBe('/c/users/arian/proj')
  expect(windowsCanonical('/c/Users/Arian/proj')).toBe('/c/users/arian/proj')
  expect(windowsCanonical('/cygdrive/C/Users/Arian')).toBe('/c/users/arian')
  expect(windowsCanonical('\\\\?\\C:\\Users\\Arian')).toBe('/c/users/arian')
  expect(windowsCanonical('C:x')).toBe('c:x')
  expect(windowsCanonical('src\\a.ts')).toBe('src/a.ts')
  expect(windowsCanonicalText(`python -c "open(r'C:\\Users\\Arian\\proj\\x')"`)).toContain('/c/users/arian/proj/x')
})

test('PowerShell gets its script encoded, and literals quoted its way', () => {
  expect(utf16Base64('a')).toBe('YQA=')
  expect(utf16Base64("Remove-Tree 'C:\\x'")).toBe('UgBlAG0AbwB2AGUALQBUAHIAZQBlACAAJwBDADoAXAB4ACcA')
  expect(utf16Base64('New-Item -ItemType Junction')).toBe('TgBlAHcALQBJAHQAZQBtACAALQBJAHQAZQBtAFQAeQBwAGUAIABKAHUAbgBjAHQAaQBvAG4A')
  expect(psQuote("C:\\Users\\O'Brien")).toBe("'C:\\Users\\O''Brien'")
  expect(psQuote('C:\\a\u2019b')).toBe("'C:\\a\u2019\u2019b'")
  expect(extendedPath('C:\\Users\\a/b')).toBe('\\\\?\\C:\\Users\\a\\b')
  expect(extendedPath('\\\\server\\share\\x')).toBe('\\\\?\\UNC\\server\\share\\x')
  expect(extendedPath('\\\\?\\C:\\x')).toBe('\\\\?\\C:\\x')
})

test('a Windows delete falls back to the plain path where .NET takes no \\\\?\\ path, and checks the one it used', () => {
  const lines = removeTreeScript("C:\\Users\\O'Brien\\Temp/stress-scout/runs/run-0001-1").split('\n').slice(-4)
  expect(lines).toEqual([
    "$target = '\\\\?\\C:\\Users\\O''Brien\\Temp\\stress-scout\\runs\\run-0001-1'",
    "try { [void][IO.Path]::GetFullPath($target) } catch { $target = 'C:\\Users\\O''Brien\\Temp\\stress-scout\\runs\\run-0001-1' }",
    'Remove-Tree $target',
    'if ([IO.Directory]::Exists($target) -or [IO.File]::Exists($target)) { exit 1 }',
  ])
})

describe('on Windows the tester may do its job inside the sandbox', () => {
  const allowed = [
    `cd ${FWD}/snapshot && timeout 120 python .stress-scout/h.py`,
    `cd ${MSYS}/snapshot && py -3 .stress-scout/h.py 2>&1 | tail -20`,
    `echo ok > ${FWD}/tmp/out.txt`,
    `npm i --prefix ${FWD}/deps fast-check`,
    `${FWD}/venv/Scripts/pip.exe install hypothesis`,
    'cat C:/Users/Arian/proj/src/app.ts | head -5',
    "cat 'C:\\Users\\Arian\\proj\\src\\app.ts'",
    'rm -rf .stress-scout/out',
    'cd .stress-scout && python h.py > ../out.txt && cd ..',
    'python .stress-scout/h.py > nul',
  ]
  for (const command of allowed) {
    test(command, () => {
      expect(checkBash(command, BOX)).toEqual({ isAllowed: true })
    })
  }
})

describe('on Windows the guard refuses what could hurt the project, secrets or the machine', () => {
  const refused = [
    // the real project, however Windows and Git Bash spell it
    'rm -rf C:/Users/Arian/proj/src',
    'rm -rf /c/Users/Arian/proj/src',
    'rm -rf /C/USERS/ARIAN/PROJ/src',
    "echo x > 'C:\\Users\\Arian\\proj\\src\\a.ts'",
    'sed -i s/a/b/ "C:\\\\Users\\\\Arian\\\\proj\\\\src\\\\a.ts"',
    `python -c "open(r'C:\\Users\\Arian\\proj\\x','w')"`,
    'cd /c/Users/Arian/proj',
    // a drive-relative path lands wherever that drive last was
    'echo x > C:x',
    // links into the real project, and climbing out of the run folder
    `echo x > ${FWD}/snapshot/node_modules/left-pad/index.js`,
    `echo x > ${MSYS}/../x`,
    "rm -rf 'node_modules\\..\\src'",
    // secrets, in Windows spellings
    'cat C:/Users/Arian/.ssh/id_rsa',
    'cat ~/.ssh/id_rsa',
    'cat $USERPROFILE/.aws/credentials',
    'cat "$USERPROFILE\\.aws\\credentials"',
    'cat C:/Users/Arian/AppData/Roaming/GitHub\\ CLI/hosts.yml',
    'cat C:/Users/Arian/proj/.env',
    // Windows shells and system tools reach past the sandbox
    'cmd //c dir',
    'powershell -c Get-ChildItem',
    'cmd.exe //c "del C:\\x"',
    'reg query HKCU',
    'echo $(cmd //c dir)',
  ]
  for (const command of refused) {
    test(command, () => {
      const check = checkBash(command, BOX)
      expect(check.isAllowed).toBe(false)
      if (!check.isAllowed) expect(check.reason).toMatch(/^stress-scout guard: /)
    })
  }
})

test('on Windows, files land only inside the run folder, in any case or slash', () => {
  expect(checkWrite(`${RUN}\\snapshot\\.stress-scout\\h.py`, 'print(1)', BOX).isAllowed).toBe(true)
  expect(checkWrite(`${FWD}/snapshot/.stress-scout/h.py`, 'print(1)', BOX).isAllowed).toBe(true)
  expect(checkWrite(`${RUN.toLowerCase()}\\snapshot\\src\\a.ts`, 'x', BOX).isAllowed).toBe(true)
  expect(checkWrite('C:\\Users\\Arian\\proj\\src\\a.ts', 'x', BOX).isAllowed).toBe(false)
  expect(checkWrite(`${RUN}\\snapshot\\node_modules\\x\\index.js`, 'x', BOX).isAllowed).toBe(false)
  expect(checkWrite(`${RUN}\\snapshot\\.stress-scout\\h.py`, 'open(r"C:\\Users\\Arian\\proj\\a.ts")', BOX).isAllowed).toBe(false)
  expect(checkWrite(`${RUN}\\snapshot\\.stress-scout\\h.py`, "open('/c/users/arian/proj/a.ts')", BOX).isAllowed).toBe(false)
})

test('on Windows, reads go anywhere but secrets', () => {
  expect(checkRead('C:\\Users\\Arian\\proj\\src\\a.ts', BOX).isAllowed).toBe(true)
  expect(checkRead('C:\\Users\\Arian\\.ssh\\id_rsa', BOX).isAllowed).toBe(false)
  expect(checkRead('c:/users/arian/.AWS/credentials', BOX).isAllowed).toBe(false)
  expect(checkRead('C:\\Users\\Arian\\AppData\\Roaming\\Microsoft\\Credentials\\x', BOX).isAllowed).toBe(false)
  expect(checkRead(`${RUN}\\snapshot\\key-link`, BOX, 'C:\\Users\\Arian\\.ssh\\id_ed25519').isAllowed).toBe(false)
})
