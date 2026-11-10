# Architecture v2 extraction evidence

Baseline: tkarakai/toolbelt `229bd64b20599f621589e03e17d36ee72c604ff5`.
Inventory: every file under `plugins/processes` transferred into `src`, including the
complete patched Running source/package metadata/README/CHANGELOG. The manifest moved to
the repository root. All four `test/processes-*.test.ts` suites moved here. Agent SVGs and
their Lobe license/provenance moved from Toolbelt renderer assets into `assets/agents`.

`git log --all 229bd64.. -- plugins/processes test/processes*` was inspected. Main already
contains GUI-host detection and grouping/keyboard improvements. Other branch commits
are alternate/unmerged feature histories, not missing post-main fixes; none were blindly
applied. Engine source is preserved rather than replaced with legacy upstream.

Structural adaptations: imports use `@toolbelt/sdk`; engine/TUI paths point at payload;
icons use SDK namespaced asset references; managed engine config/log paths derive from
TOOLBELT_DATA_DIR; prepare/stop lifecycle closes only the owned observer child. Terminal
wrappers resolve active registry package roots across upgrades. Original standalone
Running defaults and executable/shell hook names are unchanged.

Validation on macOS arm64, Bun 1.4.2:

- `bun run typecheck`: pass.
- `bun test`: 66 pass, 0 fail, 379 assertions. Installation and login-shell probes use only
  disposable temp homes. A new launcher test promotes package versions and disables one.
- `bun run package` then `bun scripts/verify-package.ts`: pass. Archive extracted outside
  checkout, no NODE_PATH or node_modules environment, minimal environment and temp HOME;
  handshake/ready, all three screens and quick view, prepare and shutdown pass.
- `bun run terminal-archives`: bundled and Bun-embedded standalone archives produced;
  each extracted and validated for executable launch, Running 0.8.0, Bun version and init.

The clean package probe only observes the machine's process list. It sends no mutating
process/terminal actions. Real user jobs and dotfiles are never modified by these tests.

Remaining integration gates: host installer/transaction integration and real renderer
visual/keyboard tester acceptance. These are not claimed complete by the headless checks above.

The three original engine test suites were recovered from the pinned Running provenance
commit into `test/engine`: 18 passing tests (origin, fingerprint, serve). They are now
owned tests, not a build/runtime dependency on that checkout. Full current count is
66 tests / 379 assertions across eight suites, including an explicit copied-data import.
The DEV import helper requires a temporary target profile, preserves copied preferences,
kept entries and settings, refuses an existing target, and never discovers live v1 data.

SDK pin: `sdk-v0.2.0-dev.1` public release asset, SHA-256
`712610f41c9e049274985d5dbad23dfb7d59a72c4c0aaff3b7c1aca3dc6dd68e`.
Package artifact hashes are generated in `artifacts/*.sha256` and descriptor at build time;
the coordinator records immutable evaluation archive pins after final candidate publication.

Visual/keyboard acceptance and host crash/transaction/descendant integration remain
explicit gates, not satisfied by these headless extraction tests. No real terminal actions
were exercised. A schema-1 declaration means unchanged-schema upgrades are an explicit
no-op; no speculative migration of actual v1 directories occurs.
