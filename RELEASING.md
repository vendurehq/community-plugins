# Releasing

Each package is versioned and published **independently**. Cut a release one package at a time:
prepare locally, push, then trigger the publish workflow.

## 1. Prepare (local)

```bash
bun run release <package>            # e.g. bun run release mollie-plugin
```

Reads [conventional commits](https://www.conventionalcommits.org/) since the package's last
`<package>/v*` tag, picks the bump (`feat!`/`BREAKING CHANGE` → major, `feat` → minor,
`fix`/`perf`/`refactor` → patch), bumps `package.json`, writes `CHANGELOG.md`, and creates a commit
plus an annotated `<package>/v<version>` tag. **Nothing is pushed** — review with `git show HEAD`.

Flags: `--dry-run` (preview only), `--prerelease[=rc]` (e.g. `1.1.0-rc.0`), `--force` (release with
no bumping commits), `--first-release` (allow when the package has no prior tag).

## 2. Push

```bash
git push --follow-tags origin main
```

## 3. Publish

**Actions → Publish to NPM → Run workflow** → `publish_type: release`, `package: <package>`.

The workflow reads the version from `package.json`, builds, and publishes with provenance — a stable
version goes to the `latest` dist-tag, a pre-release (hyphenated) version goes to `next`.

---

## Notes

- **Baseline tags.** The tooling assumes every published version has a matching `<package>/v<version>`
  tag, so the changelog only covers commits since the last release. If a package was published without
  one, create it at its release commit first, then push it:
  ```bash
  git tag -a mollie-plugin/v1.0.0 <commit> -m "@vendure-community/mollie-plugin@1.0.0"
  ```
- **Nightly `dev` builds** publish automatically at 03:00 UTC (timestamped pre-releases on the `dev`
  dist-tag). Install with `npm install @vendure-community/<package>@dev`.
- **Trusted publishing.** Publishing uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
  (OIDC) — no tokens stored. Each package needs a GitHub Actions trusted publisher on npmjs.com
  (org `vendurehq`, repo `community-plugins`, workflow `publish.yml`). Published versions include
  provenance attestation.
