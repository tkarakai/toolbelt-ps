# Architecture v2 — Processes implementation handoff

Status: planning only. Branch: **feat/architecture2**. No implementation in this commit.

## Read first

The [Toolbelt architecture v2 specification](https://github.com/tkarakai/toolbelt/blob/feat/architecture2/docs/architecture2.md) is the cross-repository source of truth.
[Initial committed specification](https://github.com/tkarakai/toolbelt/blob/2ae4ff3a4ea4e5fb51dcd65480bf700cfe27f99c/docs/architecture2.md).
Read the complete specification, not only this role summary. Future approved spec changes
belong there; this file describes ownership/extraction and must remain consistent with it.

Do not merge to main, enable auto-merge, publish stable releases, overwrite the user's
installed app/data/dotfiles, or delete the legacy Running repo. The user will separately
assign implementation. Never use the no-mistakes tool/plugin/pipeline.

## Starting points and preservation

This branch starts at 1a7fe18ef135d9bb3503177babeb923d9544baae: the separate Processes repo
is bootstrap-only. It does not contain today's working Processes plugin.

The CURRENT implementation to extract is in tkarakai/toolbelt at
229bd64b20599f621589e03e17d36ee72c604ff5:
- plugins/processes/ — screens/actions, model, agent classification, paths, install/TUI
  settings, engine client, and patched running engine/TUI source.
- test/processes-*.test.ts — behavior/model/terminal installation tests.
- scripts/build-plugins.ts — engine/TUI packaging logic to move into THIS repo.
- scripts/make-terminal-archives.ts — terminal artifact production/validation to move here.
- Related package dependencies, source fixtures and release/runtime contracts.

Inventory the exact files and any newer bug fixes before copying. Preserve PR #14
GUI-hosted agent detection, all table shortcuts, terminal jumps, filter/search/grouping,
Peek/conversation, env/note editing, and existing TUI/shell integration behavior.
Record baseline acceptance checks and attribution; do not copy stale upstream Running
over the locally patched engine.

## Owned implementation after extraction

All Processes logic, UI definitions, icons/assets, process engine, TUI, CLI artifacts,
plugin-specific tests and dependency lock belong here. Legacy Running source becomes
owned maintained implementation here; remove the vendor refresh convention and fallback
to a sibling running checkout. Keep provenance and legal notices.

No runtime or build dependence on tkarakai/running or its source checkout may remain.
Do not rename the running executable, change its shell hook or data locations during
this structural move. Treat a future tb dispatcher/command rename as a separate task.

Consume a released version of the Toolbelt SDK (during development a pinned candidate
package); do not import ../../src/sdk from Toolbelt or copy SDK source.

## Package and testing responsibilities

Produce a complete ready-to-run GitHub release archive for this plugin. Include its
bundled entry, manifest, UI assets, engine/TUI/helpers in payload, required dependencies,
compatibility metadata, hashes and provenance. Toolbelt must NOT compile the engine/TUI,
install dependencies, or inspect plugin source to build its app.

Publish the bundled and standalone terminal artifacts from this repo. The host may
redistribute verified prebuilt artifacts through generic metadata to preserve current
downloads, but cannot contain Processes-specific compilation logic.

Run unit/behavior tests and lifecycle/SDK tests here. Test extracted packages without
source checkouts. Use the released Toolbelt Plugin Tester for visual and keyboard tests
of all screens, settings, dialogs, menu-bar quick view and assets.
Test installation/removal against temporary homes; process actions use disposable
processes. Never kill/restart/focus/type into the user's actual terminals/processes.

Package storage is immutable and versioned; writable plugin data is separate. Installed
CLI launchers must resolve the active payload stably across updates rather than pin an
obsolete package directory. Keep existing explicit confirmations, undo and backup
behavior when manipulating PATH or zsh hooks.

## Required implementation handoff evidence

Record exact source baseline, extracted file/test inventory, candidate artifact versions/
hashes, SDK/tester requirements, data schema/migration declarations and parity results.
Prove no dependence on the legacy Running repo, no host dependency-tree imports, and no
real-process/dotfile test side effects. Demonstrate disable/unload does not kill observed
or independently launched user terminal jobs.

Coordinate against Toolbelt's feat/architecture2 branch. Use local archives or explicit
prereleases/dev feeds only. The working main/official app must remain usable.
Implementation milestones and cross-repo artifact pins go in Toolbelt's
docs/architecture2-progress.md once implementation is actually assigned.

