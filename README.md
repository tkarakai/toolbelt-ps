# Toolbelt Processes

The independently packaged Processes plugin for [Toolbelt](https://github.com/tkarakai/toolbelt).
Includes the complete Running engine and terminal UI as owned implementation; see
[provenance](docs/running-provenance-original.md). The command remains `running`.

## Development

Use Bun 1.4.2. `bun install --frozen-lockfile`, `bun run typecheck`, `bun test`,
`bun run package`, then `bun scripts/verify-package.ts`. SDK dependency is a versioned
candidate package; no sibling source checkout is required once its public artifact is pinned.
`bun run terminal-archives` creates and verifies bundled and standalone terminal downloads.

The package contains `index.js`, `toolbelt.json`, agent SVG assets and opaque
`payload/running-core.js` / `payload/bin/running`. Toolbelt never builds this repository.
Installation executes plugin code with the user's privileges; process isolation is not a
security sandbox. Only darwin-arm64 is advertised for this candidate.

## Data and lifecycle

Plugin id `processes`, screen ids `processes`, `kept`, `settings` and quick view are
preserved. Schema 1 is the initial managed-directory format, with engine settings/kept
commands in `data/processes/running`, command history in `data/processes/commands.log`,
and UI preferences in the managed plugin directory. Same-schema upgrade needs no migration.
No actual v1 directory is imported automatically. Test copied v1 data only in disposable
profiles. Existing standalone `running` data locations remain unchanged outside Toolbelt.

The plugin terminates its own engine on shutdown; no observed user job is terminated.
Upgrade preparation is safe because the observer has no persistent update operation.
Terminal installation/removal retains explicit confirmation, backup and undo behavior.
The installed wrapper resolves `plugins/registry.json` each invocation, so upgrades do not
pin deleted package paths. Removing the package leaves the separately installed wrapper
until the user explicitly removes it in Processes Settings; once removed/disabled the
wrapper reports a clear error. The shell hook and executable names remain unchanged.

Architecture work stays on `feat/architecture2`; no stable release or installed app change
is performed by development scripts. Acceptance evidence lives in
[docs/extraction-evidence.md](docs/extraction-evidence.md).
