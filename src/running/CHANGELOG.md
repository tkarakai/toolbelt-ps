# Changelog

All notable changes to `running`. Versions follow [semver](https://semver.org);
the version is in `package.json` and shown in the TUI header and by `running --version`.

## 0.8.0 — 2026-11-09

### Added
- Running.app **updates itself** from GitHub releases. It checks at launch and every 6 hours
  (counting time asleep), and Settings → About shows where things stand — up to date or not,
  when it last checked, a **Check for Updates** button and, when there is one, the update. When a new
  version is out, the menu bar icon and the Settings gear show a red **!**, and the panel,
  the gear menu and Settings offer **Update app: vX → vY**. One click shows what's new, then
  downloads the disk image (with progress), checks it against GitHub's SHA-256, its code
  signature and version, swaps the app in place and reopens it. Nothing changes if any step
  fails. (Updating to this version is the last manual install.)
- Running.app: **⌘W** closes the window (or the panel); **⇧⌃⌥R** opens the window from any
  app. The keyboard shortcuts list starts with the shortcuts that work from any app.

### Changed
- Running.app: while its window is open, the app is in the Dock and ⌘-Tab (with its own
  menu bar), so the window is easy to get back to after switching away. Closing the window
  puts it back to menu bar only.
- Running.app: the menu bar icon is just the icon — no job count next to it.
- Running.app: only one copy runs at a time; opening another (a new version, a second copy)
  quits the one that was running.

### Development
- `bun run install-app` builds **Running Dev.app** from the checkout: its own bundle id,
  an amber icon, ⌘ added to its global shortcuts (⌃⌥⌘R, ⇧⌃⌥⌘R), never updates itself. It runs
  next to the official app, one instance of each. Installing the official app from a local
  build needs `--official`.
- `bun run build:app` builds into `dist/app.noindex/` and unregisters it, so build copies no
  longer show up in Spotlight, Launchpad or "Open With" next to the installed app.

## 0.7.0 — 2026-11-09

### Added
- **Running.app**, a desktop twin of the TUI for Apple silicon Macs on macOS 26 (Tahoe) or
  later: a menu bar app (no Dock icon) with a quick panel (**⌃⌥R** from anywhere) and a
  resizable window — sidebar, grouped process list, inspector with details, live output,
  CPU/memory sparklines and agent stats. Everything the TUI does: keep, edit, forget (with
  undo), start, restart, stop / force-kill, focus a terminal, open web pages, peek at output,
  sort, filter, show app servers. TUI keys work in the list, plus Mac shortcuts, right-click
  menus and buttons. It shares the kept list, sort order and command log with the TUI.
  Released as `Running-X.Y.Z-arm64.dmg` alongside the terminal builds.
- Kept processes can be started in a new Ghostty, iTerm2, Terminal or tmux window (the app;
  the command is typed into the new shell, so it's in your history and the command log).
- Focus (`f`) switches to the right Ghostty tab, matched by its tty (it used to only bring
  Ghostty to the front).

### Fixed
- A refresh could hang while something was kept and a sandboxed app extension (Tailscale's
  network extension) was running: comparing directories resolved paths inside other apps'
  containers, which macOS can block on. Those are never looked into now.

### Development
- `src/serve.ts`: the engine behind a JSON-lines protocol, for the app (`running-core`).
- `mac/`: the Swift package; `bun run build:app` (`--dmg`), `bun run install-app`,
  `bun run test:app`. CI builds and tests the app; `bun run release` attaches the disk image.

## 0.6.0 — 2026-11-08

### Added
- Releases come with two downloads (macOS, xz-compressed): a 0.7 MB bundle that runs with
  your Bun, and a self-contained Apple-silicon binary with Bun embedded. The release notes
  say which Bun version the bundle was built with, and how to get past Gatekeeper for the
  unsigned standalone binary.
- `running --help` shows the Bun version it was built with and the one it runs on; a
  mismatch prints a warning (`--version` too, on stderr).
- Release uploads retry, and the release stays a draft until both files are uploaded.

### Changed
- `running` is installed as a 0.7 MB bundled script run by your Bun (`#!/usr/bin/env bun`)
  instead of a 90 MB compiled binary — the compiled one was 99% a copy of the Bun runtime.
  Requires `bun` on your PATH.
- Upgraded Ink (the terminal UI library) from 6 to 8; terminal size now comes from Ink's
  `useWindowSize`.

### Fixed
- Leading/trailing spaces typed into the keep / edit form are trimmed before saving.

### Development
- Hosted on GitHub (private): pull-request workflow, CI on macOS (typecheck, tests, binary
  build) plus secret scanning and workflow linting, Dependabot, and `bun run release` for
  tagged GitHub releases.

## 0.5.1 — 2026-11-08

### Changed
- Sorting is a menu instead of cycling: `s` shows the options in the footer, then `t` started,
  `m` memory, `c` CPU, `n` name, `r` reverse the current order, `esc` cancel. `S` is gone.

### Fixed
- `bun run install-bin` could leave a binary that macOS kills on launch (exit 137): it copied
  over the old file in place, and macOS keeps a cached code signature per file. It now
  removes the old binary first.

## 0.5.0 — 2026-11-08

### Added
- **Sorting** — `s` cycles started / memory / CPU / name, `S` flips the direction. Applied at
  every level: app sections and directories by their totals, jobs, and the processes inside an
  expanded job. Shown in the header; remembered in `~/.config/running/settings.json`.
- **`X` — kill -9 now** (on a job or a single process), with a warning that it can't clean up.
- Processes that survive kill -9 are explained: zombie (dead, waiting for its parent — named)
  or stuck in the kernel. Rows flag `zombie`, `paused` (Ctrl-Z) and `D-wait` states.

### Fixed
- `x` on a paused (Ctrl-Z) process did nothing until it was resumed: SIGTERM is now followed
  by SIGCONT.
- README: explains what `eval "$(command running init)"` does.

## 0.4.2 — 2026-11-08

### Fixed
- Starting a kept process (`⏎`) from a terminal where the `running` shell function isn't
  loaded (a shell older than the `.zshrc` line, or `bun dev` in this repo) exited without
  visible effect. Now: in Orca or tmux, `cd … && command` is typed into that same terminal
  (no Enter — you review it); elsewhere it's copied and printed. The Kept tab says which of
  these `⏎` will do, and warns when the shell function is missing.
- Messages printed after the TUI closed could be wiped by the alternate-screen switch.

## 0.4.1 — 2026-11-08

### Fixed
- Kept entries didn't link back to their running process when the launcher added flags: a
  kept `codex resume <id>` never matched the Orca-started `codex --no-daemon -c … resume <id>`,
  so it showed as not kept and could be kept again and again. Matching now uses a
  fingerprint (`src/fingerprint.ts`): agent session id first (stored as `session:` for new
  entries), otherwise same directory (resolved paths) and the same parsed command — options
  added by launchers, `bun dev`/`bun run dev`, full program paths and env prefixes no longer
  break the link.
- Keeping something already kept is refused; duplicate entries in `kept.yaml` are removed
  on load.

## 0.4.0 — 2026-11-08

### Changed
- **Jobs are trees.** A job's processes are listed under it as indented rows (`→` show,
  `←` hide / back to the job) with their own ports, uptime, memory and working directory
  (relative to the job's). Each can be opened (`o`), peeked at (`p` — its own log file) and
  stopped (`x`, just that process and what's below it); keep and restart stay job-level.
- `o` on a job with several web pages now expands it and puts the cursor on the first page,
  instead of opening a numbered chooser (removed).
- **Grouped by directory** within each app section: a full-width header per starting
  directory with its git branch (`⎇`), jobs indented below. The per-row directory column is
  gone, leaving the command more room.
- Details pane summarizes a job's web pages instead of listing every URL.

## 0.3.0 — 2026-11-08

### Added
- **Restart** (`R`): stop a job and run its command again — typed into the same tmux pane or
  Orca terminal when its shell is still there, otherwise in a new tmux window or at your
  prompt. Works for kept entries, typed commands, package scripts and agents.
- **AI agents** (codex, claude, pi): rows show the conversation title, working/idle state and
  time since last activity; details show model, tokens, cost (pi), git branch and session.
  Read from the harnesses' own local files.
- Agent **conversation view**: `p` then `←→` reads the recent conversation and tool calls.
- Keeping an agent saves a clean **resume command** (`codex resume <id>`, `claude --resume <id>`,
  `pi --session <id>`); restarting an agent resumes the same conversation.
- Version shown in the header; `running --version`; this changelog; unit tests (`bun test`).

### Fixed
- A job whose launcher exited could be named after an unrelated command typed in another
  terminal (`claude` instead of `bun dev`). Package-script jobs are now identified from the
  `npm_lifecycle_event`/`npm_execpath` variables their processes carry, and a shell-history
  guess is only used when it names a program that is actually among the processes.
- Port probes no longer leave idle keep-alive connections open to local servers.

## 0.2.0 — 2026-11-08

### Added
- Jobs grouped by **process group**: a command that exited but left processes running
  (`bun dev` → detached dev servers) is one row, `⤷ N left running`.
- zsh **command log** (`preexec` hook, installed by `running init`): the exact typed command,
  directory and terminal identity — used to name and locate processes.
- Web page detection on listening ports (`↗`), `o` to open (chooser for several).
- `f` focus the process's terminal (tmux, Orca, Terminal.app, iTerm2, WezTerm, kitty).
- `p` peek at recent output (terminal scrollback or the log files a process writes to).
- `c` copy `cd dir && command`; `?` help.
- Active tab highlighted; app & system rows dimmed in the "all" view.

### Fixed
- Scripts (`bash ./dev-start.sh`) were treated as interactive shells.
- User-installed language runtimes (Python.framework) were treated as system binaries.
- tmux pane lookup broken by tmux ≥3.5 rewriting tabs in format output.
- Typed-command matching uses microsecond process start times.

## 0.1.0 — 2026-11-08

First version: process list grouped by where it runs (terminal / tmux / detached / apps),
keep processes to `~/.config/running/kept.yaml` with optional environment variables, kill,
start a kept process at your prompt or in a new tmux window.
