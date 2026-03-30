# Releasing

This document describes how versioning, changelogs, and publishing work for the community plugins monorepo.

## Versioning

Each package is versioned **independently** using [Conventional Commits](https://www.conventionalcommits.org/).
Version 1.0.0 of each package corresponds to the functionality extracted from Vendure core v3.5.6.

### Commit message format

Commit messages determine how versions are bumped and how changelogs are generated:

```
feat(elasticsearch-plugin): add new search filter      → minor bump (1.0.0 → 1.1.0)
fix(mollie-plugin): handle null payment response        → patch bump (1.0.0 → 1.0.1)
refactor(stripe-plugin): extract helper function        → patch bump
feat(braintree-plugin)!: change API signature           → major bump (1.0.0 → 2.0.0)
```

**The scope must match the package directory name** (e.g. `elasticsearch-plugin`, `mollie-plugin`, `stripe-plugin`).
This is how lerna attributes changes to the correct package changelog.

Commits without a scope or with a non-package scope (e.g. `chore: update deps`) will appear
in changelogs for all packages that had file changes in that commit.

## Changelogs

Per-package changelogs are maintained in each package's `CHANGELOG.md` file.
These are **automatically generated** by `lerna version` using the conventional commits preset.

### How it works

1. `lerna version` detects which packages have changed since the last tagged release
2. It reads conventional commit messages to determine the version bump type
3. It generates/updates `CHANGELOG.md` in each changed package
4. It creates a git commit and per-package git tags (e.g. `@vendure-community/mollie-plugin@1.1.0`)

## Release workflow

### Stable release

```bash
# 1. Make sure you're on main with a clean working tree
git checkout main
git pull

# 2. Run lerna version — this bumps versions, updates changelogs, and creates tags
npx lerna version

# 3. Push the commit and tags
git push && git push --tags

# 4. Create a GitHub Release from the tag(s)
#    This triggers the publish workflow which publishes to npm
```

Alternatively, you can manually trigger the publish workflow:
**Actions → Publish to NPM → Run workflow → publish_type: release**

### Pre-release / nightly

Nightly pre-release builds run automatically at 03:00 UTC via cron. They:

1. Check if there were any commits in the last 25 hours
2. If so, bump all packages to a timestamped pre-release version (e.g. `1.0.1-dev.202603300300`)
3. Publish to npm with the `dev` dist-tag

To install a nightly build:
```bash
npm install @vendure-community/elasticsearch-plugin@dev
```

You can also trigger a nightly publish manually:
**Actions → Publish to NPM → Run workflow → publish_type: nightly**

This supports per-package publishing via the `package` dropdown.

## npm trusted publishing

This repo uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC) for
authentication — no npm tokens are stored as secrets. The GitHub Actions workflow requests a
short-lived credential from npm's OIDC provider.

### Setup (one-time per package)

For each package on npmjs.com:
1. Go to **Settings → Trusted Publishers**
2. Add a GitHub Actions publisher with:
   - Organization: `vendurehq`
   - Repository: `community-plugins`
   - Workflow: `publish.yml`

### Provenance

All published packages include [provenance attestation](https://docs.npmjs.com/generating-provenance-statements/),
linking each published version to the exact workflow run and source commit that produced it.
