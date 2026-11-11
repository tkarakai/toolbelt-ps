# Changelog

## Unreleased

- Align section and folder memory totals with the Memory column in the Processes table. Requires Toolbelt 0.2.2 or newer.

## 0.1.0 — 2026-11-11
- Non-interactive release PR preparation and verified CI publication through the shared SDK release tooling.

- Self-contained Processes packages include the engine, TUI, assets and SDK runtime without requiring sibling source checkouts.
- Installed terminal launchers follow the active Processes package and report disabled or removed packages clearly.
- Live terminal helper leases retain in-use package payloads during cleanup.
- Saved commands, notes, environment settings and preferences use managed plugin data; explicit snapshot import supports disposable profiles.
- Declared SDK handoff actions preserve native terminal focus ordering through the generic host.
