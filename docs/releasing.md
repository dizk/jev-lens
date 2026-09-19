# Release to npm

GitHub publishes the two npm packages, `jev-lens` (the core) and `pi-jev-lens` (the pi extension), when you publish
a stable GitHub Release. Creating a tag or saving a draft does not publish. The workflow checks versions, builds,
runs tests, and publishes with provenance, a record that links each package to its build. The Claude Code plugin is
not on npm: Claude Code installs it from this repository through the marketplace file `.claude-plugin/marketplace.json`.

## One-time npm setup

Trusted Publishing gives GitHub short-lived permission to publish. It does not need an npm token in GitHub secrets.
Configure it for both packages before the first automated release.

1. Open the package settings on npm: [jev-lens](https://www.npmjs.com/package/jev-lens/access) and
   [pi-jev-lens](https://www.npmjs.com/package/pi-jev-lens/access). A package that has never been published has no
   settings page yet; publish its first version by hand (`npm publish --workspace jev-lens --access public`) and
   then configure it.
2. Under **Trusted Publisher**, select **GitHub Actions**.
3. Set the organization or user to `dizk`.
4. Set the repository to `jev-lens`.
5. Set the workflow filename to `publish.yml`, without its directory path.
6. Leave the environment name empty. This workflow does not use a GitHub environment.
7. Save the settings.

The workflow uses a GitHub-hosted runner, Node.js 24, and npm 11. Trusted Publishing requires npm 11.5.1 or newer.

## Publish a release

All three packages and the root share one version.

1. Run `npm version <version> --no-git-tag-version --workspaces --include-workspace-root` to update every
   `package.json`, then `npm install --package-lock-only` to update the lockfile. Update `version` in
   `packages/claude-code/.claude-plugin/plugin.json` and in `.claude-plugin/marketplace.json` (both entries), and the
   `VERSION` constant in `packages/claude-code/src/mcp.ts`.
2. Add release notes to `CHANGELOG.md`.
3. Run `scripts/plugin-lock.sh` to refresh `packages/claude-code/package-lock.json`. Claude Code installs the plugin's
   dependency on the published `jev-lens` core with `npm ci` from that lockfile, so it must be regenerated after the
   core is on npm at the new version (run it again after step 8 when the core version changed; commit the result).
4. Commit and push the changes to `main`.
5. Open [New release on GitHub](https://github.com/dizk/jev-lens/releases/new).
6. Create a tag named `v<version>` on the release commit. For version `0.5.0`, use `v0.5.0`.
7. Copy the changelog entry into the release description.
8. Publish the release without selecting the prerelease option, then check
   [GitHub Actions](https://github.com/dizk/jev-lens/actions/workflows/publish.yml).

The tag must match the version in `packages/core/package.json` and `packages/pi/package.json`. The workflow rejects
prereleases to prevent an accidental update to npm's `latest` version.

## If publication fails

If npm rejects authentication, make sure that the Trusted Publisher fields match the values above, then rerun the
failed job. You do not need to recreate the release.

If npm reports that the version already exists, run `npm view <package>@<version> version` to inspect what is
published. Do not move the release tag or try to overwrite an npm version. For another publication, prepare a new
version and release. The workflow publishes the core first; if it succeeded and the pi extension failed, rerunning
the job skips the core (npm reports it as already published) and publishes the extension.
