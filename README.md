# stress-scout

A Claude Code mod that stress-tests your code while you build it, and hands back fixes it has already verified.

## How it works

1. **Watches.** It sees Claude's edits as they happen, checks once a minute for edits you make yourself, and notices when the session goes idle.
2. **Triages cheaply.** Once a change settles (45 s of quiet, or every 4 min during non-stop editing), Haiku reads the diff and your latest prompts, then decides whether anything is worth a stress test: concurrency, parsing, resource lifetimes, unbounded loops, money and time math, auth checks. Most changes aren't, and they cost almost nothing to rule out.
3. **Tests in a sandbox.** It copies your working tree, uncommitted changes included, into a throwaway snapshot and starts a headless `claude -p` tester there (Sonnet by default). The tester writes a targeted harness (races, load, fuzzing, edge cases, leaks) and escalates it until the code breaks or holds at a credible ceiling, recording the numbers.
4. **Proves the fix.** If the code breaks, the tester fixes the snapshot's copy and reruns the identical harness. The patch is read back from git, not taken from the model's description of it.
5. **Hands over.** A banner above the prompt and the Stress Scout pane show the verdict with before and after numbers. **Apply via Claude** sends the patch and evidence to Claude, or press Tab to take the suggested prompt. Nothing touches your code until you say so.
6. **Remembers.** Per project and across sessions, it records what it tested (by content hash) and what you dismissed, so it doesn't repeat itself. When the session is idle and nothing has changed, it sweeps the riskiest code it hasn't tested yet.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin marketplace add arianpakray/arianpakray
/plugin install stress-scout@arianpakray
```

From a shell:

```
claude plugin marketplace add arianpakray/arianpakray
claude plugin install stress-scout@arianpakray
```

This repository is private, so the machine needs GitHub access to it (for example `gh auth login`, then `gh auth setup-git`). On Windows, the simplest way is to run this once in PowerShell. Git Credential Manager opens a browser to sign you in and remembers it:

```
git ls-remote https://github.com/arianpakray/arianpakray.git
```

It needs `git`, and runs on macOS, Linux and Windows 10 or later (with Git for Windows, which Claude Code needs there anyway). The tester is started with the running Claude Code's own binary. If a run reports that it couldn't start the tester, set **Path to the claude binary** under stress-scout in `/config`.

## Use

| Command | What it does |
| --- | --- |
| `/stress` | Test the latest change now (a sweep if nothing changed) |
| `/stress <focus>` | Test something specific: `/stress the retry loop in api/client.ts` |
| `/stress show` | Open the Stress Scout pane |
| `/stress status` | What it's doing, what it found, what it has spent |
| `/stress apply N` | Hand finding N to Claude, with the patch and evidence |
| `/stress dismiss N` | Drop finding N; it isn't raised again unless that code changes |
| `/stress stop` · `pause` · `resume` · `forget` | Stop the running test, pause or resume automatic runs, clear this project's memory |

## Cost guardrails

These are the defaults; change them in `/config` under stress-scout.

- A Haiku triage gates every automatic run, and the tester runs only when the risk is medium or high.
- At most 8 automatic runs per session (up to 3 of them idle sweeps), at least 3 minutes apart. `/stress` always works.
- Each run is capped at $2 (`--max-budget-usd`) and 20 minutes.
- Automatic runs pause while your 5-hour or weekly usage window is at or above 80%. That keeps them short of your plan's limits, past which extra usage, if you've turned it on, is billed.
- Spend is shown in the pane and in `/stress status`. On a Claude plan that's what the tokens would cost on the API, not a charge.
- On a Claude plan, the tester bills the plan too. `claude -p` uses an `ANTHROPIC_API_KEY` it finds in your environment without asking, where an interactive session asks first, so stress-scout blanks that key for the tester.

## Safety

The tester is a separate headless Claude Code process:

- Its working directory is the snapshot, so your project is outside its allowed directories.
- It has only Bash, Read, Write and Edit, with no MCP servers or skills, and doesn't load your project's settings.
- It runs with `--permission-mode dontAsk`, so any call the stress-scout guard doesn't approve is refused.
- The guard allows writes only inside the run folder and never lets the tester touch or name your real project, including through the snapshot's links to your `node_modules` or `.venv`. It also blocks reading secrets (`.env`, `~/.ssh`, credentials, however the path is spelled or globbed), network access beyond localhost, global installs, history-changing git commands and `sudo`.

The guard is a seatbelt, not a security boundary. For OS-level isolation, also turn on Claude Code's sandbox (`/sandbox`). Scratch data (snapshots and a shadow git index) lives in `$TMPDIR/stress-scout/` (`%TEMP%\stress-scout\` on Windows). Nothing in your repository's `.git` is created or changed; git only refreshes the timestamps of objects the shadow index reuses from it.

## Windows

- The tester's Bash tool is Git Bash. The guard reads every way Windows and Git Bash spell a path (`C:\Users\…`, `C:/Users/…`, `/c/Users/…`) in any letter case. Inside the sandbox, `cmd`, PowerShell and system tools such as `reg` and `schtasks` are refused.
- Dependency folders are linked into a snapshot as directory junctions, which need no admin rights. Old runs are deleted by a routine that removes a junction without entering it, so your real `node_modules` is never touched.
- Windows Defender scans each file of a new snapshot, which can make a run slow to start on a big project. If that bothers you, you can exclude `%TEMP%\stress-scout` from real-time scanning; that folder only holds copies of your own code.

## Develop

```
claude plugin validate plugins/stress-scout
claude plugin test plugins/stress-scout
claude --plugin-dir plugins/stress-scout
bun ci/real-fs.ts    # the file system and git work on this machine, links and deletes included
```

CI runs the validate, test and `ci/real-fs.ts` steps on Ubuntu and Windows.
