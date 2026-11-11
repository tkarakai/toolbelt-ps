# Running engine and terminal UI

This directory contains the process engine and Ink terminal UI maintained by Toolbelt
Processes. Use the repository-root [README](../../README.md) for installation, build,
packaging and release commands, and [architecture](../../docs/architecture.md) for the
plugin/host boundary. [Attribution](../../docs/running-provenance-original.md) is included
in packaged NOTICE files. The [changelog](CHANGELOG.md) retains the engine's release history.

## Behavior

`running` lists terminal jobs, process groups, listening servers, detached user processes
and GUI-hosted agents. Rows group by terminal and working directory. Kept commands include
their directory, environment and note. The TUI can inspect output, keep/edit/forget
commands and explicitly start/restart/stop jobs. `running --help` describes command-line
options; the TUI's `?` view shows its keys.

`running init` prints the zsh integration for `eval "$(command running init)"`. It supplies
the shell function used for prompt handoff and records typed commands for process naming
and terminal lookup. Standalone defaults are `~/.config/running/kept.yaml`,
`~/.config/running/settings.json` and `~/.local/state/running/commands.log`.
`RUNNING_CONFIG_DIR` and `RUNNING_LOG_FILE` override those locations. Toolbelt supplies
managed profile paths when it starts the engine or its installed terminal wrapper.

## Source map

- `src/native.ts`: macOS process arguments, environment, paths, directories and start times.
- `src/procs.ts`: collection, process-group classification and snapshots.
- `src/agents.ts`, `src/codex-server.ts`: agent/session metadata.
- `src/hook.ts`, `src/init.zsh`: command log and zsh integration.
- `src/actions.ts`, `src/terminals.ts`: output inspection and explicit terminal navigation.
- `src/store.ts`, `src/settings.ts`: kept-command and engine settings persistence.
- `src/launch.ts`, `src/restart.ts`: command launch/restart behavior.
- `src/serve.ts`: JSON-lines engine entry used by the plugin.
- `src/main.tsx`, `src/ui/`: terminal entry and Ink components.

The root build bundles `src/serve.ts` into `payload/running-core.js` and `src/main.tsx` into
`payload/bin/running`. Run maintained build/test scripts from the repository root;
`package.json` here also supplies the engine/TUI version embedded in those outputs.

Test actions only with disposable processes and temporary homes. The engine observes real
processes, so running it does not authorize stopping or navigating the user's jobs.
