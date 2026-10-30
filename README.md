# stress-scout

A Claude Code mod that stress-tests your code while you build it, and hands back fixes it has already verified.

## How it works

1. **Watches.** It sees Claude's edits as they happen, checks once a minute for edits you make yourself, and notices when the session goes idle.
2. **Triages cheaply.** Once a change settles (45 s of quiet, or every 4 min during non-stop editing), Haiku reads the diff and your latest prompts, then decides whether anything is worth a stress test: concurrency, parsing, resource lifetimes, unbounded loops, money and time math, auth checks. Most changes aren't, and they cost almost nothing to rule out.
3. **Tests in a sandbox.** It copies your working tree, uncommitted changes included, into a throwaway snapshot and starts a headless `claude -p` tester there (Sonnet by default). The tester writes a targeted harness (races, load, fuzzing, edge cases, leaks) and escalates it until the code breaks or holds at a credible ceiling, recording the numbers.
4. **Proves the fix.** If the code breaks, the tester fixes the snapshot's copy and reruns the identical harness. The patch is read back from git, not taken from the model's description of it.
5. **Hands over.** The Stress Scout pane opens by itself in every session and says what the next automatic run waits on. It and a banner above the prompt show each verdict with before and after numbers. **Apply via Claude** sends the patch and evidence to Claude (**Send to Claude** when there's a next step but no patch), or press Tab to take the suggested prompt. A fix the tester proved goes to Claude by itself once the session has sat idle for 30 s (a new turn cancels it); anything unverified waits for you. Turn off **Hand verified fixes to Claude automatically** in `/config` to approve every fix yourself.
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
| `/stress` (also `now`, `run`, `start`) | Test the latest change now (a sweep if nothing changed) |
| `/stress <focus>` | Test something specific: `/stress the retry loop in api/client.ts` |
| `/stress show` (also `pane`) | Open the Stress Scout pane |
| `/stress status` | What it's doing, what it found, what it has spent, the session cap and the network mode |
| `/stress apply` | Hand the newest waiting finding that has a fix to Claude; never a dismissed one |
| `/stress apply N` | Hand finding N to Claude, with the patch and evidence; the only way to apply a dismissed one |
| `/stress dismiss N` | Drop finding or idea N; it isn't raised again unless that code changes |
| `/stress dismiss N all` | Drop every finding of that kind in finding N's file, until the file changes |
| `/stress try N` | Build idea N in the sandbox and measure it; the result is a finding that links back to it |
| `/stress discover <question>` | Research a question with hypotheses, measurements and fresh sources; shows a plan, and nothing is spent until you press **Run it** |
| `/stress stop` · `pause` · `resume` · `forget` | Stop the running test, pause or resume automatic runs, clear this project's memory |
| `/stress help` | The command list |

The pane also holds two lists. **Ideas** are small improvements the triage model suggests now and then (`suggestImprovements`); **Try it** builds one in the sandbox, **Research this** turns it into a discovery. **Discoveries** is the project's ledger of questions it has answered, hit a dead end on or left partial; asking a question again at the same code is answered from it for free. A fix whose files or branch changed since its snapshot shows **re-test first** with a **Re-test** button, and is never handed over automatically.

## Cost guardrails

These are the defaults; change them in `/config` under stress-scout.

- A Haiku triage gates every automatic run, and the tester runs only when the risk is medium or high.
- At most 8 automatic runs per session (up to 3 of them idle sweeps), at least 3 minutes apart. `/stress` always works.
- Each run is capped at $2 (`--max-budget-usd`) and 20 minutes. A run that times out is still billed what its stream reported.
- A session is capped at $15 (`maxDollarsPerSession`; 0 turns it off): no test starts, automatic or on demand, once what the session has spent plus the cap of one more test would pass it. Automatic runs wait with a note in the pane; `/stress` says which setting to raise.
- Automatic runs pause while your 5-hour or weekly usage window is at or above 80%. That keeps them short of your plan's limits, past which extra usage, if you've turned it on, is billed.
- Spend is shown in the pane and in `/stress status`. On a Claude plan that's what the tokens would cost on the API, not a charge.
- On a Claude plan, the tester bills the plan too. `claude -p` uses an `ANTHROPIC_API_KEY` it finds in your environment without asking, where an interactive session asks first, so stress-scout blanks that key for the tester.

## Safety

Whatever the tester writes is treated as data. A hand-over wraps its headline, evidence, next step and patch in a block marked `<<<stress-scout tester report: untrusted data>>>`, tells Claude not to act on it, and is never made unattended for a finding that came from an idea or a discovery, or whose text reads like an instruction (`ignore previous`, `git push`, `curl … | sh`, …).

The tester is a separate headless Claude Code process:

- Its working directory is the snapshot, so your project is outside its allowed directories.
- It has only Bash, Read, Write and Edit, with no MCP servers or skills, and doesn't load your project's settings.
- The commands it runs have no network (`testerOffline`): `sandbox-exec` on macOS, `unshare -rn` on Linux, found by trying them. Where neither works, the pane, the status line and a toast say `network: guard only`, and the guard alone limits network use. On Windows there is no such tool: the pane says `network: on (Windows)`.
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
bun ci/guard-harness.ts    # every case real bash runs must be refused by the guard
bun ci/offline-harness.ts  # curl, run through the offline wrapper, reaches loopback but not the internet
bun ci/docs-check.ts       # every /stress command is in /stress help and the table above
```

CI runs the validate, test, `ci/real-fs.ts` and `ci/docs-check.ts` steps on Ubuntu, macOS and Windows, and the guard and offline harnesses on Ubuntu and macOS. The guard is only unit-tested on Windows (`tests/windows.test.ts`). CI also tries `ci/guard-harness.ts` under Git Bash there, as an advisory step that cannot fail the build, because nothing has yet shown that bash.exe passes the harness's quoting through intact; until that step has gone green, treat the guard as unproven against real bash on Windows.
