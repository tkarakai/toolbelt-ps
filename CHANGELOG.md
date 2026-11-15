# Changelog

## Unreleased

## 0.1.4 — 2026-11-15
- Add a Grouped / Flat switch beside the scope. Flat lists every job in one table with App, Folder and Branch columns that can be sorted, resized and reordered like the others. Each layout remembers its own columns, and the selected row stays selected when you switch.
- Build with public SDK 0.3.4. No change in required Toolbelt version.

## 0.1.3 — 2026-11-14
- Show listening ports in the Processes table again. Toolbelt hides cell chips in narrow columns, so ports are now plain monospace text (first two, then +N), and the row details list every port under Network.
- Adopt Toolbelt column layout: Process follows the window width while Ports, CPU, Memory and Up keep fixed default widths. Columns can be resized (double-click a divider to reset) and reordered by dragging; Toolbelt remembers both. Requires Toolbelt 0.3.5 or newer and public SDK 0.3.3.

## 0.1.2 — 2026-11-12
- Require Toolbelt 0.3.1 for explained toolbar controls and adopt source-pinned release retries with serialized publication.

- Replace Show apps with Your Work / All services scope segments and explanations on hover or keyboard focus.

## 0.1.1 — 2026-11-11
- Align section and folder memory totals with the Memory column in the Processes table. Requires Toolbelt 0.2.2 or newer.

## 0.1.0 — 2026-11-11
- Non-interactive release PR preparation and verified CI publication through the shared SDK release tooling.

- Self-contained Processes packages include the engine, TUI, assets and SDK runtime without requiring sibling source checkouts.
- Installed terminal launchers follow the active Processes package and report disabled or removed packages clearly.
- Live terminal helper leases retain in-use package payloads during cleanup.
- Saved commands, notes, environment settings and preferences use managed plugin data; explicit snapshot import supports disposable profiles.
- Declared SDK handoff actions preserve native terminal focus ordering through the generic host.
