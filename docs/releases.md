# Processes releases

This is the manual release procedure. There is no `bun run release` command.
`build`, `package`, and `terminal-archives` write local files only. CI validates
source, workflow policy and clean packages; it does not create tags, upload assets or
publish releases. A green CI run is not a published package.

## Prerequisites and release PR

Use macOS Apple silicon (`uname -s` is `Darwin`, `uname -m` is `arm64`), Bun 1.4.2
(the CI version), Git, `gh` and `gh-axi`. Check `bun --version`, `git config user.name`,
`git config user.email` and `gh auth status`. Authentication must allow pushing tags and
writing repository releases (Contents write for a fine-grained token). Authentication
alone does not prove that permission: confirm repository access with the maintainer.
Have an authorized stable/prerelease decision, a compatible Toolbelt Plugin Tester and
space for retained build/download/verification directories. Do not replace installed
apps or use real user data for acceptance.

The pinned `@toolbelt/sdk` URL in `package.json` and `bun.lock` must already be publicly
accessible. An unpublished SDK or a sibling source checkout cannot satisfy a release.
For an SDK update, first publish/verify that SDK through Toolbelt's SDK procedure, then
update this dependency and lockfile in a PR and rerun all checks. Do not silently resolve
a different URL during the release build.

Create a release branch and PR from current `main`. In that PR:

1. Set the same new plugin version in root `package.json` and `toolbelt.json`. Use a
   never-published version, with a prerelease suffix when appropriate.
2. Move the intended `CHANGELOG.md` Unreleased entries into `## X.Y.Z — YYYY-MM-DD`.
   Keep an empty Unreleased section for later work. Review the release notes.
3. Update `bun.lock` if package metadata or dependencies require it; frozen installation
   must succeed. The engine/TUI version in `src/running/package.json` is independent of the plugin version; change it only when releasing a new engine/TUI version, and keep its dated changelog consistent.
4. The current `scripts/verify-package.ts` uses the literal archive version `0.0.1`.
   `scripts/verify-v1-import.ts` also uses that archive version and plugin-version environment value. The release PR must align these verifier references with the new version, or
   explicitly parameterize them and update CI before release. They currently accept no
   archive-path argument. Never rename a new archive to an old version to bypass this gate.
5. Run the validation commands below and obtain green required CI. Have the user merge
   the release PR; agents must not merge `main` or publish stable releases without the
   user's explicit authorization.

## Select and validate the exact source

Run from this repository, after the release PR is merged. These blocks are sequential;
use zsh (the macOS default) or bash and retain the variables in the same shell. Stop on any failed check. Do not run alongside
another session editing this checkout.

```sh
set -e
release_repo=tkarakai/toolbelt-ps
git fetch origin --tags
git switch main
git pull --ff-only origin main
test -z "$(git status --porcelain)"
release_commit=$(git rev-parse HEAD)
test "$release_commit" = "$(git rev-parse origin/main)"
release_version=$(bun -e 'console.log((await Bun.file("package.json").json()).version)')
release_tag="v$release_version"
release_archive="toolbelt-ps-${release_version}-darwin-arm64.tar.gz"
bun -e 'const p=await Bun.file("package.json").json(); const m=await Bun.file("toolbelt.json").json(); if(p.version!==m.version) throw Error("Version mismatch")'
```

Confirm the required `CI` status is green for this exact merged commit in GitHub
(the release PR's earlier head alone is insufficient). Confirm the intended tag and release do not already
exist with `git ls-remote --tags origin` and `gh-axi release list`. If either exists,
follow recovery below instead of rebuilding/recreating it.

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run package
bun scripts/verify-package.ts
bun scripts/verify-v1-import.ts
bun run terminal-archives
test -z "$(git status --porcelain)"
```

`package` invokes `build`; a separate `bun run build` is unnecessary. It produces
`dist/package` and these release assets under `artifacts/`:

- `toolbelt-ps-<version>-darwin-arm64.tar.gz`: complete ustar plugin archive.
- The archive's `.sha256` sidecar.
- `toolbelt-release.json`: `formatVersion: 1`, id `processes`, version,
  repo `tkarakai/toolbelt-ps`, full source `commit`, and one package with target
  `darwin-arm64`, exact asset filename, byte `size` and `sha256`.
- `toolbelt-<version>-macos.tar.xz`: bundled `running`, requiring Bun.
- `toolbelt-<version>-macos-arm64-standalone.tar.xz`: `running` with embedded Bun.

`terminal-archives` rebuilds local payloads, creates both terminal downloads, extracts
each and checks executable version, Bun runtime reporting and zsh `preexec` hook output.
The terminal archives are additional downloads, not entries in the plugin descriptor.
Their executable version follows `src/running/package.json`, while filenames follow the
root plugin version. Do not run the interactive TUI on real processes during validation.

The plugin archive must run without this source tree or ambient `node_modules`.
The verifier extracts it into a fresh temporary directory, supplies isolated HOME/data
and exercises handshake, readiness, every screen, quick view, preparation and shutdown.
Processes also verifies explicit copied-data import without starting saved commands.

## Freeze and verify local assets

Keep this directory until after publication and recovery checks. Its bytes, not a later
rebuild, are the release candidate. `SHA256SUMS` covers every uploaded product asset,
including the descriptor and individual archive sidecar; it does not checksum itself.

```sh
release_dir=$(mktemp -d "${TMPDIR:-/tmp}/toolbelt-ps-release.XXXXXX")
release_files=("$release_archive" "$release_archive.sha256" toolbelt-release.json "toolbelt-${release_version}-macos.tar.xz" "toolbelt-${release_version}-macos-arm64-standalone.tar.xz")
for release_file in "${release_files[@]}"; do
  cp "artifacts/$release_file" "$release_dir/$release_file"
done
(cd "$release_dir" && shasum -a 256 "${release_files[@]}" > SHA256SUMS)
(cd "$release_dir" && shasum -a 256 -c SHA256SUMS)
```

Save this verifier beside the frozen bytes (it is an operator helper, not an uploaded
asset). It checks the descriptor's source binding, target, exact size/hash and sidecar.

```sh
cat > "$release_dir/verify-assets.ts" <<'VERIFY'
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const [dir,version,commit,repo,id]=process.argv.slice(2);
const d=JSON.parse(readFileSync(join(dir,'toolbelt-release.json'),'utf8'));
if(d.formatVersion!==1||d.id!==id||d.version!==version||d.repo!==repo||d.commit!==commit||d.packages?.length!==1) throw Error('Descriptor identity/source mismatch');
const p=d.packages[0], expected=`${repo.split('/')[1]}-${version}-darwin-arm64.tar.gz`;
if(p.target!=='darwin-arm64'||p.asset!==expected) throw Error('Target/filename mismatch');
const bytes=readFileSync(join(dir,p.asset));
const hash=createHash('sha256').update(bytes).digest('hex');
if(p.size!==bytes.length||p.sha256!==hash) throw Error('Size/hash mismatch');
if(readFileSync(join(dir,p.asset+'.sha256'),'utf8')!==`${hash}  ${p.asset}\n`) throw Error('Sidecar mismatch');
console.log('Descriptor, source, target, size and SHA-256 verified');
VERIFY
bun "$release_dir/verify-assets.ts" "$release_dir" "$release_version" "$release_commit" "$release_repo" processes
release_extract=$(mktemp -d "${TMPDIR:-/tmp}/toolbelt-ps-extract.XXXXXX")
tar -xzf "$release_dir/$release_archive" -C "$release_extract"
bun -e 'const [dir,version,repo,id]=process.argv.slice(1); const m=await Bun.file(dir+"/toolbelt.json").json(); if(m.id!==id||m.version!==version||m.repo!==repo||m.formatVersion!==1||m.protocol!==1||m.entry!=="index.js"||!m.requires.platforms.includes("darwin-arm64")) throw Error("Archive manifest mismatch"); if(!await Bun.file(dir+"/index.js").exists()) throw Error("Missing entry")' "$release_extract" "$release_version" "$release_repo" processes
```

Review the extracted manifest's compatibility ranges, capability requirements, screens,
asset declarations, schema, CLI and handoff declarations against the approved source.
The clean-package verifier validates the full manifest through the public SDK parser.
Inspect the extracted files: all declared assets/payloads and both engine/TUI payloads
must exist, with executable permissions where required. NOTICE and license attribution
must remain present. Archive consumers must not need dependencies installed at runtime.

Load the frozen archive in a compatible Toolbelt Plugin Tester using a fresh isolated
profile and temporary HOME. Exercise all screens and native quick view, keyboard/search/
selection/dialogs, themes, zoom, narrow layout and packaged assets. Confirm readiness,
prepare/shutdown and update/removal data retention. Test migration/update with copied
fixture data, including retries and compatibility rejection leaving the old installation
intact. For Processes, test stop/start/focus only on disposable owned processes; install/remove the stable `running` launcher only under a temporary `TOOLBELT_PS_HOME`, confirm lease retention during a running helper and disabled/removed diagnostics. Never alter real dotfiles or user jobs.
Do not proceed with a readiness, archive, asset or renderer failure.

Copy the approved changelog section into `$release_dir/notes.md`, review it, and include
compatibility/download instructions distinguishing the Bun-required and standalone terminal archives.
Keep the candidate's source SHA, Bun version, acceptance result and local directory
location with the release operator's records. Notes must describe these exact bytes.

## Tag, create a draft and upload

Only after validation and authorization, create an annotated tag on the exact commit.
Never force-push or move a release tag. These commands intentionally require an existing
remote tag and leave the release unpublished and excluded from Latest:

```sh
test "$(git rev-parse HEAD)" = "$release_commit"
test -z "$(git status --porcelain)"
git tag -a "$release_tag" "$release_commit" -m "Release $release_version"
git push origin "refs/tags/$release_tag"
gh-axi release create "$release_tag" --verify-tag --draft --latest=false \
  --title "$release_tag" --notes-file "$release_dir/notes.md"
release_uploads=()
for release_file in "${release_files[@]}"; do
  release_uploads+=("$release_dir/$release_file")
done
gh-axi release upload "$release_tag" "${release_uploads[@]}" "$release_dir/SHA256SUMS"
```

Draft creation is separate from uploads so a partial upload cannot publish an incomplete
release. Do not add `--generate-notes` in place of reviewed changelog notes.

## Download the draft and verify again

```sh
release_download=$(mktemp -d "${TMPDIR:-/tmp}/toolbelt-ps-download.XXXXXX")
gh-axi release download "$release_tag" --dir "$release_download"
for release_file in "${release_files[@]}" SHA256SUMS; do
  cmp "$release_dir/$release_file" "$release_download/$release_file"
done
(cd "$release_download" && shasum -a 256 -c SHA256SUMS)
bun "$release_dir/verify-assets.ts" "$release_download" "$release_version" "$release_commit" "$release_repo" processes
test "$(git rev-parse "$release_tag^{commit}")" = "$release_commit"
gh release view "$release_tag" --repo "$release_repo" \
  --json tagName,isDraft,isPrerelease,targetCommitish,assets
```

Raw `gh` is used for structured metadata inspection. Require `isDraft: true`, the exact
tag, expected asset count/names/sizes, reviewed notes and the correct tagged commit.
`targetCommitish` can be a branch name; the annotated tag's peeled commit and descriptor
must match the approved full SHA. Confirm remote tag refs using `git ls-remote --tags
origin` (including its peeled `^{}` entry). No extra/stale product assets may remain.

Verify the downloaded archive through the real verifier, not only the local build.
Create a disposable checkout at the tagged source; do not build/package in this checkout:

```sh
release_verify=$(mktemp -d "${TMPDIR:-/tmp}/toolbelt-ps-verify.XXXXXX")
git clone --no-checkout "https://github.com/$release_repo.git" "$release_verify/source"
git -C "$release_verify/source" checkout --detach "$release_commit"
mkdir -p "$release_verify/source/artifacts"
for release_file in "${release_files[@]}"; do
  cp "$release_download/$release_file" "$release_verify/source/artifacts/$release_file"
done
(cd "$release_verify/source" && bun install --frozen-lockfile && bun scripts/verify-package.ts && bun scripts/verify-v1-import.ts)
```

The verifier version references must have been aligned in the release PR. Also load the
**downloaded** archive in the isolated Plugin Tester and repeat readiness and key UI/
lifecycle checks. This catches wrong draft uploads even after a correct local build.

Verify both downloaded terminal archives independently without installing a shell hook:

```sh
release_running_version=$(bun -e 'console.log((await Bun.file("src/running/package.json").json()).version)')
for release_terminal in "toolbelt-${release_version}-macos.tar.xz" "toolbelt-${release_version}-macos-arm64-standalone.tar.xz"; do
  release_terminal_dir=$(mktemp -d "${TMPDIR:-/tmp}/running-download.XXXXXX")
  tar -xJf "$release_download/$release_terminal" -C "$release_terminal_dir"
  test -x "$release_terminal_dir/running"
  test "$(env HOME="$release_terminal_dir" RUNNING_CONFIG_DIR="$release_terminal_dir/config" RUNNING_LOG_FILE="$release_terminal_dir/log" "$release_terminal_dir/running" --version)" = "$release_running_version"
  env HOME="$release_terminal_dir" RUNNING_CONFIG_DIR="$release_terminal_dir/config" RUNNING_LOG_FILE="$release_terminal_dir/log" "$release_terminal_dir/running" --help
  env HOME="$release_terminal_dir" RUNNING_CONFIG_DIR="$release_terminal_dir/config" RUNNING_LOG_FILE="$release_terminal_dir/log" "$release_terminal_dir/running" init > "$release_terminal_dir/hook.zsh"
  rg preexec "$release_terminal_dir/hook.zsh"
done
```

Require `--help` to report Bun 1.4.2 for built/running versions with the prescribed Bun
installation. Check the standalone executable also works with only system directories
on PATH, using its absolute path; the bundled script intentionally requires Bun.
`init` only prints the hook: do not source it or write it into the real shell profile.

## Publish and check installation

Select exactly one command, according to the authorized release channel:

```sh
# Stable: publish and explicitly mark Latest.
gh-axi release edit "$release_tag" --draft=false --prerelease=false --latest=true
# Prerelease: publish without changing Latest.
gh-axi release edit "$release_tag" --draft=false --prerelease=true --latest=false
```

Reinspect release metadata and public download URLs. Confirm non-draft state, intended
prerelease/Latest status and all asset names/sizes. Download into another fresh directory
from the public release (also verify public access without release credentials), compare
the frozen bytes/checksums and rerun descriptor verification. Never rebuild to perform
this check.

In an isolated real Toolbelt profile, select this repository and exact release (enable
prereleases when needed), review the version/compatibility and approve execution. Confirm
the installed version/source/hash, readiness, screens, native quick view and update from
a compatible preceding package using copied fixture data. Verify removal/retention and
restart behavior. Do not replace the user's working app/profile as a release smoke test.
For Processes, check the launcher resolves the active package after upgrade and reports
disabled/removed state clearly; exercise installation/cleanup only in a temporary home,
and `--version`, `--help`, `init` with isolated Running data. Never start saved user jobs.

## Recovery

- **Before tagging:** fix the release PR/source and obtain a clean reviewed commit and
  green CI, then discard the failed candidate and build a new candidate. Do not publish
  dirty-source descriptors or waive checks.
- **Tag exists, no release yet:** verify the tag points to the approved commit and retain
  its exact frozen bytes. Resume draft creation/upload for that tag. Never move the tag.
  If those bytes are lost or the version/tag is wrong, stop and use a new version through
  another release PR; rebuilding is not a way to recover the same version.
- **Draft or partial upload:** inspect `isDraft` first, upload missing files from the
  frozen directory, then download and verify the whole set again. To replace a wrong
  asset only while the release is still unpublished, use
  `gh release upload "$release_tag" "$release_dir/<exact-asset-name>" --clobber`.
  This raw CLI flag deletes the existing matching asset before uploading; a failure can
  leave it absent. It must use retained approved bytes, never a rebuild, and always be
  followed by complete download/size/hash/metadata/readiness verification. Remove stray
  draft assets before publication. Do not use clobber on a published release.
- **Publish request times out:** inspect the release state before retrying. A successful
  publication with a lost response must not be treated as an unpublished draft.
- **Already published:** retain tags and immutable assets. Resume verification/install
  checks against the same bytes. Any source, metadata binding or package-content fix
  requires a new version/tag/release PR; do not rebuild, retag or replace published bytes.
  Coordinate withdrawal/advisory decisions with the maintainer if a release is defective.

See [architecture](architecture.md), the [README](../README.md), and Toolbelt's
[plugin authoring and update guide](https://github.com/tkarakai/toolbelt/blob/main/docs/plugins.md)
for the runtime/update contract. These release steps do not authorize main merges,
stable publication or user-data changes by themselves.
