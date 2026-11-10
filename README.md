# Toolbelt Processes

Processes is a [Toolbelt](https://github.com/tkarakai/toolbelt) plugin for terminal jobs,
servers, GUI-hosted agents and kept commands. This repository owns the plugin, process
engine and `running` terminal UI. Supported packages target macOS Apple silicon.

## Install and update

In Toolbelt Settings → Plugins, enter `tkarakai/toolbelt-ps`, review the selected release
and approve execution. Enable prereleases when selecting a prerelease. Toolbelt downloads
and verifies the prebuilt package, then starts it with its supported Bun runtime.

Processes provides Processes, Kept and Settings tabs plus a menu-bar quick view. Its
Settings tab can install or remove the optional `running` command and zsh hook, with
confirmation. Remove that separate terminal setup before removing the plugin if it is no
longer wanted; the plugin manager offers a link to the cleanup screen.

Toolbelt checks for package updates and installs them only after approval. Disabling keeps
code and data; removal retains managed data by default. Plugin code runs with the user's
privileges. Process isolation does not provide a security sandbox.

## Develop and verify

Use Bun 1.4.2 and run from the repository root:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run package
bun scripts/verify-package.ts
bun scripts/verify-v1-import.ts
bun run terminal-archives
```

Open the built archive in Toolbelt Plugin Tester to exercise the production main-window
and quick-view renderer. Use isolated profiles, temporary homes and disposable processes.
Observe real processes only; never test stop, restart, focus or terminal typing on them.

`@toolbelt/sdk` is pinned to a public package asset in `package.json` and `bun.lock`.
No sibling Toolbelt or Running source checkout is needed. See
[architecture and maintenance](docs/architecture.md), the
[engine/TUI reference](src/running/README.md) and
[attribution](docs/running-provenance-original.md). The shared
[Toolbelt plugin authoring and update guide](https://github.com/tkarakai/toolbelt/blob/main/docs/plugins.md)
defines the host package, SDK and lifecycle contract.

## Build and publish packages

`bun run build` writes `dist/package`: bundled `index.js`, the runtime manifest, declared
assets, a NOTICE and `payload/running-core.js` / `payload/bin/running`.
`bun run package` builds that directory and emits these files under `artifacts/`:

- `toolbelt-ps-<version>-darwin-arm64.tar.gz`
- the archive's `.sha256` file
- `toolbelt-release.json`, binding repository, source commit, plugin version, target,
  archive filename, byte size and SHA-256

`bun run terminal-archives` creates and verifies `toolbelt-<version>-macos.tar.xz` and
`toolbelt-<version>-macos-arm64-standalone.tar.xz`. Both contain the `running` executable;
the standalone archive embeds Bun.

For an authorized release, make version/changelog changes in a release PR. Keep the root
package and manifest plugin versions consistent; the engine/TUI version is maintained in
`src/running/package.json`. Build from the intended clean committed revision, run the
checks above, then attach the archive, descriptor, checksums and terminal downloads to a
draft GitHub release. Download and verify the draft assets before publishing. Publish
prereleases with `--prerelease --latest=false`; stable publication requires the maintainer's
explicit decision. Published bytes are immutable: corrections require a new version.

To update the SDK dependency, pin the new public asset URL, verify that the lockfile
resolves that URL, and rerun the complete package checks. To change data schema, implement
a declared migration and test it against copied data in temporary profiles. Toolbelt owns
the transaction, snapshot and rollback machinery; Processes owns its data semantics.
