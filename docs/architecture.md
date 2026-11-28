# Processes architecture

Processes is a declarative Toolbelt plugin. Toolbelt owns package installation, lifecycle,
renderer, settings and native surfaces. This repository owns process behavior, the engine,
terminal UI, assets and tests. Toolbelt consumes the prebuilt archive and does not build
this source or install its dependencies.

## Code ownership

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | The package entry: runs the plugin definition over ToolBelt's transport |
| `src/plugin.ts` | Declarations, screens, dialogs, events, preferences, polling and quick view |
| `src/core.ts` | Request/response client for the owned engine over JSON lines |
| `src/model.ts` | Classification, grouping, sorting, filtering and row construction |
| `src/scope.ts` | Scope and layout controls, the Processes view declaration and how a view reads |
| `src/agents.ts` | Agent binaries/packages, display names and colors |
| `src/conversation.ts` | Transcript parsing for conversation nodes |
| `src/cmux.ts` | CMUX identity and navigation helpers |
| `src/t3code.ts` | Read-only T3 Code thread lookup: titles, states, process-less threads |
| `src/paths.ts` | Resolve packaged engine/TUI or repository-local development source |
| `src/install.ts`, `src/tui.ts` | Confirmed terminal installation, backup/removal and status |
| `src/running/src/` | Process collection, native macOS calls, command storage, actions and Ink TUI |
| `assets/agents/` | Declared agent icons and their attribution |
| `scripts/` | Bundle, package, terminal archives and clean-package checks |
| `test/` | Plugin, engine, installer, conversation and copied-data fixtures/tests |

The engine and TUI are maintained here. Their attribution is retained in
[running-provenance-original.md](running-provenance-original.md), which the build includes
as the package NOTICE. Asset notices remain in `assets/agents/`.

## SDK, manifest and runtime

The plugin depends on the public `@toolbelt/sdk` package pinned by URL and lockfile.
`definePlugin` supplies rendering/events, startup, preparation and shutdown callbacks.
It also supplies managed data, package/payload paths and namespaced asset references.

`toolbelt.json` declares stable id `processes`, the Processes/Kept/Settings screens,
shortcuts, quick view, compatibility ranges, required capabilities, schema and asset map.
The source entry is `index.ts`; the build writes an archive manifest with `index.js`.
Package format version, protocol version, plugin version and SDK diagnostic version are
separate values.

Toolbelt validates metadata before execution. The supported Bun runtime starts each plugin
as a separate child with its package root and writable managed data directory. The SDK
performs the protocol handshake and reports explicit readiness after startup. Only valid
messages/trees reach the host renderer. A plugin process boundary isolates dependencies
and failures, while still allowing user-level filesystem/process/network access.

Processes starts `payload/running-core.js` as its owned observer. The bridge exchanges
request ids and JSON-line results; snapshots feed model functions and declarative trees.
The host renders all screens and quick view with its shared components. The engine is
also the implementation behind `payload/bin/running`.

Startup reads preferences, starts the observer, discovers terminals and refreshes data.
Preparation reports readiness; SDK event handling is serialized around completed actions.
Shutdown clears polling and stops the owned observer. It does not stop the user jobs the
observer lists. The host owns plugin/helper process-group termination and startup probes.
A probe starts the package against staged managed data and waits for readiness before the
host promotes an installation or update.

Processes speaks protocol 3 (ToolBelt 0.10.0 or newer, public SDK 0.7.0). The Processes screen
declares a view (`processesView` in `src/scope.ts`): search, the Agent and State filters, and the
`process-scope` and `process-view` controls. The SDK applies their events, so they never reach
`onEvent`, and each open instance renders from its own `View` (`readView`). Every person's screen
shares the `person` instance; Toolbelt saves its view and sends it back when the screen opens, so
Processes saves none of it. Agent instances would get their own views, but the manifest's
`agent.access: none` keeps agents away, because rows show command lines and environment values.
The declared defaults come from the `showAll`, `filters` and `view` values earlier versions saved
in `prefs.json`. Those values are read only and written back unchanged, so the defaults don't move
and people keep what they had chosen. The badge follows the person's scope, as last rendered.

Sort is not part of the view. running-core keeps one sort for everyone (`setSort`, stored in
`running/settings.json` and shared with the `running` TUI), and the plugin's own App, Folder, Branch
and Ports sort (`prefs.flatSort`) comes with it. A per-instance sort would mean sorting in the plugin
instead of the engine. With no agent instances there is only one viewer, so `sort` events still
reach `onEvent`. Dialogs (Peek, Keep, Edit) belong to the person: only events from the `person`
instance open or use one, only that instance renders it, and closing the person's Processes or Kept
screen closes it (`onClose` fires for every instance).

`ACTIONS` and `FORMS` in `src/plugin.ts` declare every action id the trees and toasts use, and
every form, with its effect. ToolBelt rejects a render that uses anything undeclared, and journals
`write`, `external` and `destructive` events. Opening apps, terminals, browsers and Finder,
starting kept commands, restarting and installing the TUI are `external`; stop, force stop,
forget and removing the TUI are `destructive`; saving, reordering and Undo are `write`; dialogs,
Peek, copying and checks are `view`. The Keep dialog and Peek's output source are `view` forms
(drafts in the person's instance); Settings is a `write` form. `onEvent` returns `false` for an
event it doesn't know or whose row, kept command or dialog is gone, and a failure is shown as a
toast and reported as the event's error. `test/processes-protocol.test.ts` runs the plugin through
the SDK's `fakeHost`, which checks renders and messages as ToolBelt does.

`handoffActions` declares `focus` and `focus-kept`, requiring `native.handoff`. The generic
host can dismiss its popover before delivering those events. Processes implements terminal
navigation; the host does not interpret Processes action names.

## Data and terminal integration

Managed schema 1 uses these paths beneath the selected Toolbelt config root:

- `data/processes/prefs.json`: the default terminal and the plugin's own sort, plus the scope,
  layout and filters that earlier versions saved, read as the view's defaults.
- `data/processes/running/kept.yaml`: kept commands, directories, environment and notes.
- `data/processes/running/settings.json`: engine sort settings.
- `data/processes/commands.log`: the managed command log.

`TOOLBELT_DATA_DIR` determines the plugin directory; the engine receives matching
`RUNNING_CONFIG_DIR` and `RUNNING_LOG_FILE`. A standalone TUI uses its normal Running data
locations unless those variables are supplied. Same-schema upgrades need no migration.
The explicit import helper accepts an already copied snapshot and an empty temporary
profile; it never discovers or modifies an installed profile automatically.

The optional installer derives every path from `TOOLBELT_PS_HOME`, or the process home.
It writes a marked `~/.local/bin/running` wrapper and marked PATH/hook lines in `~/.zshrc`.
Foreign commands are backed up, and explicit removal restores the backup and removes only
Toolbelt-marked additions. Tests use temporary homes.

The installed wrapper resolves `plugins/registry.json` on every invocation and chooses
the enabled Processes package's TUI. It reports disabled/removed/unavailable packages
clearly. It records a provisional parent lease, transfers it to the spawned TUI child PID
and releases the lease after exit. `plugins/leases/processes/<pid>.json` binds that live
helper to its immutable package root, letting host cleanup retain code still in use.

The manifest's `cli.cleanupScreen: settings` lets the manager offer cleanup while the
plugin is available. Cleanup navigates to the existing Settings screen; it must not invoke
`tui-remove` directly and bypass the user's confirmation.

## Packaging and maintenance

The build bundles ordinary JS dependencies, engine and TUI without source-checkout
fallbacks in the release archive. Display assets are declared in the manifest; payload
files are opaque to the host installer. Archives use ustar with macOS metadata disabled.
The release descriptor and checksum bind the exact bytes to a source revision and target.

Keep plugin-specific behavior and regression tests here. Use typecheck/unit tests for
changes, then build and launch the extracted package in a clean temporary environment.
`verify-package.ts` covers handshake, readiness, all screens/quick view and preparation/
shutdown. `verify-v1-import.ts` checks copied-data preferences, commands, notes and secret
flags without starting a command. Terminal archive checks extract both formats and verify
executable permissions, version, Bun runtime information and shell hook output.

Use the real Plugin Tester for keyboard, theme, narrow-layout, dialog, asset and quick-view
work. Dangerous actions target only disposable fixtures. Preserve stable ids, screen ids,
command names and storage formats when maintaining behavior. Update the public SDK pin
when using a new contract, and declare the required or optional capability accordingly.

## Releases

Follow the [release procedure](releases.md). Local builds create files only; merging a validated release PR authorizes CI publication. Published bytes are immutable; corrections require a new version.

Group memory summaries bind to the `mem` table column. The host aligns their values with
process memory values and hides them when the Memory column is hidden. Toolbelt 0.2.2
or newer is required for this layout. Group totals and sorting semantics are unchanged.

The Processes toolbar uses Your Work / All services segments (the `process-scope` view control,
starting from the saved `showAll`); the broader scope adds app/system listeners, not every OS process.
`src/scope.ts` defines the control; unknown values read as Your Work. This feature requires
Toolbelt 0.3.1 or newer and public SDK 0.3.2.

The Processes table declares default column widths: Process grows with the window (minimum
280px) and the other columns are fixed. When the window is too narrow, Toolbelt hides columns
from the right in the person's displayed order. It also stores resized widths and dragged
column order. This requires Toolbelt 0.3.5 or newer and public SDK 0.3.3.

A Grouped / Flat segment beside the scope sets the table layout (the `process-view` view
control, starting from the saved `prefs.view`, else grouped). Grouped keeps section and folder headers. Flat drops them and shows App, Folder and
Branch as columns. Jobs started from a job, and a job's own processes, stay nested under it.
The two layouts use different table ids (`processes`, `processes-flat`), so each keeps its own
widths and order. Rows keep their pid ids, so selection carries over. Running sorts Process,
CPU, Memory and Up as before. The plugin sorts App, Folder and Branch itself (`prefs.flatSort`;
rows without a branch go last), and choosing a running column clears that sort. The Folder
cell leads with the project part of the path, with its location below, so narrow columns cut
the location first. Narrow windows drop Up, Ports, Branch, App, Memory and then CPU, keeping
Folder longest. No host or SDK change is needed.

The Ports column sorts in both layouts, and the plugin does this sorting itself (stored in
`prefs.flatSort`, the name kept for compatibility). Ascending uses each job's lowest port and
descending its highest. Rows without a port go last. In the grouped layout, sections and folders
are ordered by the same port rule. App, Folder and Branch sorts apply only to the flat layout.

T3 Code runs an agent process for a thread only while that thread is active. `src/t3code.ts`
reads T3 Code's database (`$T3CODE_HOME/userdata/statev2.sqlite`, default `~/.t3`) read-only.
It reads the file again only after it changes. A live agent matches a thread by its session ID,
or by its folder when T3 Code started it. The agent then shows the thread's title, and T3 Code's
pending questions mark it as waiting for you. Open threads (not archived, settled or a subagent)
with no process become `t3:<thread>` rows in T3 Code's section, under their worktree folder.
In the flat layout they come at the end. The State filter calls them "Agent not running". Their
actions are Open T3 Code and, for Claude Code threads, Peek at the transcript. Jump on a live
T3 Code agent brings T3 Code to the front. T3 Code has no link to a specific thread. An unreadable or changed
database means no T3 information. Nothing is written.

Toolbelt rejects any message with more than `LIMITS.nodes` (50,000) JSON values and reports
the plugin as crashed. Each sparkline goes only in its CPU or Memory cell, never repeated in
row stats, and carries the latest 16 samples. `fitRows` in `src/model.ts` keeps the table
within what the rest of the page leaves. When it trims, it leaves out sparklines, then nested
rows' details, then all details, and only after that drops rows from the end. The summary
says whenever it trims.
