# Release to npm

GitHub publishes the package when you publish a stable GitHub Release. Creating a tag or saving a draft does not publish the package.
The workflow checks versions, runs tests, and publishes to npm with provenance, a record that links the package to its build.

## One-time npm setup

Trusted Publishing gives GitHub short-lived permission to publish this package. It does not need an npm token in GitHub secrets.
You must configure this on npm before the first automated release.

1. Open the [package settings on npm](https://www.npmjs.com/package/pi-jev-lens/access).
2. Under **Trusted Publisher**, select **GitHub Actions**.
3. Set the organization or user to `dizk`.
4. Set the repository to `pi-jev-lens`.
5. Set the workflow filename to `publish.yml`, without its directory path.
6. Leave the environment name empty. This workflow does not use a GitHub environment.
7. Save the settings.

The workflow uses a GitHub-hosted runner, Node.js 24, and npm 11. Trusted Publishing requires npm 11.5.1 or newer.
If the package does not yet show Trusted Publisher settings, make sure that you are signed in as a package owner.

## Publish a release

1. Run `npm version <version> --no-git-tag-version` to update both package files.
2. Add release notes to `CHANGELOG.md`.
3. Commit and push the changes to `main`.
4. Open [New release on GitHub](https://github.com/dizk/pi-jev-lens/releases/new).
5. Create a tag named `v<version>` on the release commit. For version `0.4.0`, use `v0.4.0`.
6. Copy the changelog entry into the release description.
7. Publish the release without selecting the prerelease option.
8. Open [GitHub Actions](https://github.com/dizk/pi-jev-lens/actions/workflows/publish.yml) and make sure that the publish job succeeds.

The tag must match `package.json`. Both version fields in `package-lock.json` must also match.
The workflow rejects prereleases to prevent an accidental update to npm's `latest` version.

## If publication fails

If npm rejects authentication, make sure that the Trusted Publisher fields match the values above.
After you fix the settings, rerun the failed GitHub Actions job. You do not need to recreate the release.

If npm reports that the version already exists, run `npm view pi-jev-lens@<version> version` to inspect the published version.
Do not move the release tag or try to overwrite an npm version. For another publication, prepare a new version and release.
