/**
 * What differs on Windows: how paths are spelled, where temp and home are,
 * and the two file operations the mod needs that Windows has no Unix command
 * for, deleting a tree and linking a folder. Everything else is git, which
 * runs the same everywhere.
 */
import type { EngineInterface } from 'claude-code'

import { trimSlash } from './util'

/** A Windows path: on a drive (`C:\`, `C:/`), or a network or device path (`\\server`, `\\?\C:`). */
export const isWindowsPath = (path: string): boolean => /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path)

/** `path` with forward slashes, which Windows, git and Git Bash all accept; other paths as they are. */
export const portable = (path: string): string => (isWindowsPath(path) ? path.replace(/\\/g, '/') : path)

/**
 * One spelling per Windows path, for comparing them: `C:\Users\a`, `C:/Users/a`,
 * Git Bash's `/c/Users/a`, `/cygdrive/c/Users/a` and `\\?\C:\Users\a` all read
 * `/c/users/a`, in lower case since Windows file systems ignore case. A
 * drive-relative `C:x` stays relative.
 */
export function windowsCanonical(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\/\/[?.]\/unc\//i, '//')
    .replace(/^\/\/[?.]\/(?=[A-Za-z]:\/)/, '')
    .replace(/^\/cygdrive\/([A-Za-z])(?=\/|$)/i, '/$1')
    .replace(/^([A-Za-z]):(?=\/)/, '/$1')
    .toLowerCase()
}

/** `text` with the Windows path spellings inside it written canonically, to spot paths embedded in code. */
export const windowsCanonicalText = (text: string): string =>
  text
    .replace(/\\/g, '/')
    .replace(/(^|[^A-Za-z0-9])([A-Za-z]):\//g, (_, before: string, drive: string) => `${before}/${drive}/`)
    .replace(/\/cygdrive\/([A-Za-z])\//gi, '/$1/')
    .toLowerCase()

/** Where temp files go: TEMP on Windows (a Git Bash TMPDIR may be `/tmp`), TMPDIR elsewhere. */
export async function tempRoot($: EngineInterface, isWindows: boolean): Promise<string> {
  const candidates = isWindows
    ? [await $.env.get('TEMP'), await $.env.get('TMP'), await $.env.get('TMPDIR')]
    : [await $.env.get('TMPDIR')]
  for (const value of candidates) {
    if (value !== undefined && value !== '' && (!isWindows || isWindowsPath(value))) return trimSlash(value)
  }
  return '/tmp'
}

/** The person's home folder: HOME, or USERPROFILE on Windows; '' when neither is set. */
export async function homeFolder($: EngineInterface): Promise<string> {
  return trimSlash((await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '')
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** `text` as UTF-16LE bytes in base64: what PowerShell's -EncodedCommand reads. */
export function utf16Base64(text: string): string {
  const bytes: number[] = []
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    bytes.push(unit & 0xff, unit >> 8)
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += BASE64[(n >> 18) & 63]
    out += BASE64[(n >> 12) & 63]
    out += i + 1 < bytes.length ? BASE64[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? BASE64[n & 63] : '='
  }
  return out
}

/** `text` as a PowerShell literal string; PowerShell also ends one at a typographic quote. */
export const psQuote = (text: string): string => `'${text.replace(/['\u2018\u2019\u201A\u201B]/g, quote => quote + quote)}'`

/** Runs a PowerShell script, passed encoded so no quoting in it can break. */
function powershell($: EngineInterface, script: string, timeoutMs: number) {
  return $.process.run(
    ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', utf16Base64(script)],
    { timeoutMs },
  )
}

/** A Windows path in its `\\?\` form, which lifts the 260-character limit off the .NET calls below. */
export function extendedPath(path: string): string {
  const native = path.replace(/\//g, '\\')
  if (native.startsWith('\\\\?\\')) return native
  return native.startsWith('\\\\') ? `\\\\?\\UNC\\${native.slice(2)}` : `\\\\?\\${native}`
}

/**
 * Deletes a tree without following links. Windows PowerShell's own recursive
 * Remove-Item can walk into a junction and empty its target, which for a
 * snapshot's node_modules is the real project's, so links are unlinked
 * where they stand and only real folders are entered. Plain .NET calls on
 * `\\?\` paths where .NET takes them, so deep trees delete too; a file that
 * won't go (one held open) is passed over, and the caller hears whether the
 * tree is gone.
 */
const REMOVE_TREE = `
function Remove-Tree([string]$Path) {
  try { $attributes = [IO.File]::GetAttributes($Path) } catch { return }
  try {
    if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
      if ($attributes -band [IO.FileAttributes]::Directory) { [IO.Directory]::Delete($Path) } else { [IO.File]::Delete($Path) }
    } elseif ($attributes -band [IO.FileAttributes]::Directory) {
      foreach ($child in [IO.Directory]::GetFileSystemEntries($Path)) { Remove-Tree $child }
      [IO.Directory]::Delete($Path)
    } else {
      [IO.File]::SetAttributes($Path, [IO.FileAttributes]::Normal)
      [IO.File]::Delete($Path)
    }
  } catch { }
}`

/**
 * The PowerShell that deletes `path` and exits 1 unless it is gone. .NET's
 * older path handling, which Windows PowerShell can run with, takes no `\\?\`
 * path: there every call on one fails, and `Exists` answers false, so the
 * plain path is used instead. A tree past 260 characters then stays, and is
 * reported as still there.
 */
export function removeTreeScript(path: string): string {
  return [
    REMOVE_TREE,
    `$target = ${psQuote(extendedPath(path))}`,
    `try { [void][IO.Path]::GetFullPath($target) } catch { $target = ${psQuote(path.replace(/\//g, '\\'))} }`,
    'Remove-Tree $target',
    'if ([IO.Directory]::Exists($target) -or [IO.File]::Exists($target)) { exit 1 }',
  ].join('\n')
}

/** Deletes a file or a folder tree, never through a link; true when it is gone. */
export async function removeTree($: EngineInterface, path: string, isWindows: boolean, timeoutMs = 120_000): Promise<boolean> {
  if (!isWindows) return (await $.process.run(['rm', '-rf', path], { timeoutMs })).exitCode === 0
  return (await powershell($, removeTreeScript(path), timeoutMs)).exitCode === 0
}

/** Links folder `link` to `target`: a symbolic link, or on Windows a junction (no admin rights needed). */
export async function linkFolder($: EngineInterface, target: string, link: string, isWindows: boolean): Promise<boolean> {
  if (!isWindows) return (await $.process.run(['ln', '-s', target, link])).exitCode === 0
  const script = `New-Item -ItemType Junction -Path ${psQuote(link.replace(/\//g, '\\'))} -Target ${psQuote(target.replace(/\//g, '\\'))} -ErrorAction Stop | Out-Null`
  return (await powershell($, script, 60_000)).exitCode === 0
}
