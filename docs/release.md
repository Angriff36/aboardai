# Release process

AboardAI desktop artifacts are built by `.github/workflows/release.yml` when a GitHub Release is published. There is no repository-provided `/release` command.

## Version source

The desktop package is `apps/ui/package.json`. Its checked-in `version` is the local development version used by Electron Builder.

For a published GitHub Release, the workflow removes an optional leading `v` from the release tag and runs:

```bash
node apps/ui/scripts/update-version.mjs <tag-version>
```

This updates the package version in the workflow checkout before building; the workflow does not commit that temporary version change back to the repository.

## Trigger

1. Confirm the intended release commit and changelog.
2. Create and publish a GitHub Release with a semantic version tag such as `v1.2.3`.
3. Publishing the release triggers the `Release Build` workflow.

Creating or pushing a git tag alone does not match the workflow trigger. The GitHub Release must reach the `published` event.

## Build matrix

The workflow runs on Ubuntu, macOS, and Windows and builds:

| Platform | Command                                            | Artifacts                   |
| -------- | -------------------------------------------------- | --------------------------- |
| macOS    | `npm run build:electron:mac --workspace=apps/ui`   | DMG and ZIP, x64 and arm64  |
| Windows  | `npm run build:electron:win --workspace=apps/ui`   | NSIS EXE, x64               |
| Linux    | `npm run build:electron:linux --workspace=apps/ui` | AppImage, DEB, and RPM, x64 |

Electron Builder writes local artifacts under `apps/ui/release/`. Its current product name is `AboardAI`, application ID is `com.aboardai.app`, and artifact pattern is `AboardAI-<version>-<arch>.<ext>`.

The workflow collects each platform’s artifacts and uploads them to the same GitHub Release with `fail_on_unmatched_files: true`.

## Pre-release checks

Run gates appropriate to the release commit before publishing:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:all
npm run build:server
npm run build:electron:dir
```

Run Playwright separately with `npm run test` when release changes affect user flows. Platform packaging should be verified on the target operating system or by the release workflow.

## Release verification

After the workflow completes:

1. Confirm every matrix job succeeded.
2. Confirm the release contains the expected macOS, Windows, and Linux files.
3. Download and smoke-test the relevant installer or archive.
4. Confirm the installed application reports the tag-derived version.
5. Verify the release notes and repository links point to `https://github.com/Angriff36/aboardai`.

Do not document a release as available until the GitHub workflow and uploaded assets have been checked.
