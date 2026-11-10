# Changelog

## Unreleased

- Processes now owns its complete engine, TUI, assets and tests and produces ready-to-run architecture v2 packages without a Toolbelt or Running source checkout.
- Installed terminal launchers follow the active Processes package across upgrades and report disabled/removed packages clearly.
- Keep running terminal helpers leased during package cleanup, and verify copied v1 kept commands, notes and environment data against the standalone package.
- Declare native terminal handoff actions through the generic SDK contract so Toolbelt preserves focus ordering without Processes-specific host logic.
