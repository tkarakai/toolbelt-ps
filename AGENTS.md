# toolbelt-ps — notes for coding agents

Toolbelt Processes: a [Toolbelt](https://github.com/tkarakai/toolbelt) plugin (and `tb ps`
command line) that reimplements [running](https://github.com/tkarakai/running). macOS only.
See `README.md`.

## Workflow (required)

- **Never commit to `main` directly.** Branch (`feat/…`, `fix/…`), open a pull request, let CI
  pass, squash-merge. The PR title becomes the commit title on `main`. The `main` ruleset
  enforces this (`.github/settings/`).
- **One agent per checkout.** If `git status` shows changes you didn't make, stop and ask —
  another session may be working here.
- Add user-visible changes to `## Unreleased` in `CHANGELOG.md` in the same PR.
- Don't bump the version in feature PRs; that happens in a release PR.
- Workflow files: pin actions to full commit SHAs, keep `permissions` minimal. Only
  GitHub-owned actions, `oven-sh/setup-bun` and `zizmorcore/zizmor-action` are allowed.
- Never kill, restart or type into the user's own processes or terminals while testing —
  start your own test processes.

## Bun

- Use `bun <file>`, `bun test`, `bun install`, `bun run <script>`, `bunx <pkg>` — not node,
  jest/vitest, npm/yarn/pnpm or npx.
