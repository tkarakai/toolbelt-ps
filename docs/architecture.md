# Processes architecture

Processes is a declarative Toolbelt plugin. Toolbelt owns package installation, lifecycle,
renderer, settings and native surfaces. This repository owns process behavior, the engine,
terminal UI, assets and tests. Toolbelt consumes the prebuilt archive and does not build
this source or install its dependencies.

## Code ownership

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Screens, dialogs, events, preferences, polling and quick view |
| `src/core.ts` | Request/response client for the owned engine over JSON lines |
| `src/model.ts` | Classification, grouping, sorting, filtering and row construction |
| `src/agents.ts` | Agent binaries/packages, display names and colors |
| `src/conversation.ts` | Transcript parsing for conversation nodes |
| `src/cmux.ts` | CMUX identity and navigation helpers |
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

`handoffActions` declares `focus` and `focus-kept`, requiring `native.handoff`. The generic
host can dismiss its popover before delivering those events. Processes implements terminal
navigation; the host does not interpret Processes action names.

## Data and terminal integration

Managed schema 1 uses these paths beneath the selected Toolbelt config root:

- `data/processes/prefs.json`: display, filter and terminal preferences.
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

The Processes toolbar uses Your Work / All services segments. Both preserve the existing
`showAll` preference; the broader scope adds app/system listeners, not every OS process.
`src/scope.ts` defines the control and validates explicit field values. This feature requires
Toolbelt 0.3.1 or newer and public SDK 0.3.2.
