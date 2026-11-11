# toolbelt-ps — notes for coding agents

Read [README.md](README.md) and [docs/architecture.md](docs/architecture.md). This repository
owns the Processes plugin, process engine and `running` TUI. Use the public SDK dependency;
do not import host source or depend on a sibling checkout.

## Workflow

- Never use the no-mistakes tool, plugin, skill or pipeline. Implement, review, validate
  and perform Git/CI operations directly.
- One agent per checkout. If unexpected edits appear, stop and ask before changing them.
- Work on the assigned feature branch. Never commit directly to `main`; use a PR and let
  CI pass. The user owns main merges; merging a validated release PR authorizes its CI publication. Changes to installed apps/data need explicit authorization. Do not enable auto-merge unasked.
- Add user-visible changes to `## Unreleased` in `CHANGELOG.md`. Do not bump versions in
  feature PRs; use a release PR.
- Preserve source/asset notices and [attribution](docs/running-provenance-original.md).
- Pin workflow actions to full SHAs and keep permissions minimal. Allowed actions are
  GitHub-owned actions, `oven-sh/setup-bun` and `zizmorcore/zizmor-action`.

## Implementation and validation

- Use Bun commands: `bun install`, `bun run`, `bun test`, `bunx`; not npm/yarn/pnpm, node
  or alternate test runners.
- Preserve plugin/screen ids, the `running` executable and shell-hook behavior.
- Keep behavior tests here. Toolbelt tests generic package/runtime contracts.
- Run `bun run typecheck`, `bun test`, `bun run package`,
  `bun scripts/verify-package.ts`, `bun scripts/verify-v1-import.ts` and relevant terminal
  archive checks. Use Toolbelt Plugin Tester for renderer/native-surface work.
- Installer tests must set `TOOLBELT_PS_HOME` or use temporary process homes. Never alter
  actual user dotfiles while testing.
- Never kill, restart, focus or type into the user's processes/terminals. Use disposable
  processes for actions; observing the real list is read-only.
- Keep SDK/package/manifest changes consistent. Release archives must run after extraction
  without source checkouts or ambient dependency directories.

Follow the [release procedure](docs/releases.md). Local builds create files only; merging a validated release PR authorizes CI publication. Published bytes are immutable; corrections require a new version.
