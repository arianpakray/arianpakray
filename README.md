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
/plugin install stress-scout --marketplace arianpakray/arianpakray
```

From a shell:

```
claude plugin install stress-scout --marketplace arianpakray/arianpakray
```

This repository is private, so the machine needs GitHub access to it (for example `gh auth login`, then `gh auth setup-git`).

It needs `git` and runs on macOS and Linux; Windows is untested. The tester is started with the running Claude Code's own binary. If a run reports that it couldn't start the tester, set **Path to the claude binary** under stress-scout in `/config`.

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
- Automatic runs pause while your 5-hour usage window is at or above 80%.
- Spend is shown in the pane and in `/stress status`.

## Safety

The tester is a separate headless Claude Code process:

- Its working directory is the snapshot, so your project is outside its allowed directories.
- It has only Bash, Read, Write and Edit, with no MCP servers or skills, and doesn't load your project's settings.
- It runs with `--permission-mode dontAsk`, so any call the stress-scout guard doesn't approve is refused.
- The guard allows writes only inside the run folder and never lets the tester touch or name your real project. It also blocks reading secrets (`.env`, `~/.ssh`, credentials), network access beyond localhost, global installs, history-changing git commands and `sudo`.

The guard is a seatbelt, not a security boundary. For OS-level isolation, also turn on Claude Code's sandbox (`/sandbox`). Scratch data (snapshots and a shadow git index) lives in `$TMPDIR/stress-scout/`, and your repository's `.git` is never written to.

## Develop

```
claude plugin validate plugins/stress-scout
claude plugin test plugins/stress-scout
claude --plugin-dir plugins/stress-scout
```
