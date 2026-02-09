# Vendure Community Plugins

[![Build & Test](https://github.com/vendurehq/community-plugins/actions/workflows/build-and-test.yml/badge.svg)](https://github.com/vendurehq/community-plugins/actions/workflows/build-and-test.yml)

Community-maintained plugins for the [Vendure](https://www.vendure.io/) e-commerce framework.

## Packages

| Package                                                                    | Description                                      | npm                                                                                                                                                   |
|----------------------------------------------------------------------------|--------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
| [`@vendure-community/elasticsearch-plugin`](packages/elasticsearch-plugin) | Elasticsearch-based search for Vendure           | [![npm](https://img.shields.io/npm/v/@vendure-community/elasticsearch-plugin)](https://www.npmjs.com/package/@vendure-community/elasticsearch-plugin) |
| [`@vendure-community/payments-plugin`](packages/payments-plugin)           | Payment integrations (Stripe, Mollie, Braintree) | [![npm](https://img.shields.io/npm/v/@vendure-community/payments-plugin)](https://www.npmjs.com/package/@vendure-community/payments-plugin)           |
| [`@vendure-community/sentry-plugin`](packages/sentry-plugin)               | Sentry error tracking integration                | [![npm](https://img.shields.io/npm/v/@vendure-community/sentry-plugin)](https://www.npmjs.com/package/@vendure-community/sentry-plugin)               |
| [`@vendure-community/stellate-plugin`](packages/stellate-plugin)           | Stellate CDN cache purging                       | [![npm](https://img.shields.io/npm/v/@vendure-community/stellate-plugin)](https://www.npmjs.com/package/@vendure-community/stellate-plugin)           |
| [`@vendure-community/pub-sub-plugin`](packages/pub-sub-plugin)             | Google Cloud Pub/Sub job queue strategy          | [![npm](https://img.shields.io/npm/v/@vendure-community/pub-sub-plugin)](https://www.npmjs.com/package/@vendure-community/pub-sub-plugin)             |

## Migration from `@vendure/*`

These packages were extracted from the main [vendurehq/vendure](https://github.com/vendurehq/vendure) monorepo. To migrate, update your package imports:

```diff
- import { ElasticsearchPlugin } from '@vendure/elasticsearch-plugin';
+ import { ElasticsearchPlugin } from '@vendure-community/elasticsearch-plugin';

- import { StripePlugin } from '@vendure/payments-plugin/package/stripe';
+ import { StripePlugin } from '@vendure-community/payments-plugin/package/stripe';

- import { SentryPlugin } from '@vendure/sentry-plugin';
+ import { SentryPlugin } from '@vendure-community/sentry-plugin';

- import { StellatePlugin } from '@vendure/stellate-plugin';
+ import { StellatePlugin } from '@vendure-community/stellate-plugin';

- import { PubSubPlugin } from '@vendure/job-queue-plugin/package/pub-sub';
+ import { PubSubPlugin } from '@vendure-community/pub-sub-plugin';
```

## Development

### Prerequisites

- Node.js >= 20
- Docker (for Elasticsearch and Redis in e2e tests)

### Setup

```bash
npm install
npm run build
```

### Linting

```bash
# Check for lint issues
npm run lint

# Auto-fix lint issues
npx eslint --fix .
```

### Running tests

```bash
# Start services
docker compose up -d

# Run all unit tests
npm run test

# Run all e2e tests
npm run e2e

# Run e2e for a specific package
cd packages/elasticsearch-plugin && npm run e2e
```

## Releasing

This repo uses [conventional commits](https://www.conventionalcommits.org/) and
[lerna](https://lerna.js.org/) with independent versioning — each package has its own version and
changelog.

### Step-by-step release process

#### 1. Write conventional commit messages

Use the conventional commit format for all changes so that version bumps and changelogs are
generated automatically:

- `fix: ...` — patch release (1.0.0 → 1.0.1)
- `feat: ...` — minor release (1.0.0 → 1.1.0)
- `feat!: ...` or `BREAKING CHANGE:` in the footer — major release (1.0.0 → 2.0.0)

#### 2. Version the packages

When you're ready to release, run from the repo root:

```bash
npx lerna version --conventional-commits
```

This will:

- Detect which packages have changed since their last release
- Determine the version bump for each based on commit types
- Update each package's `package.json` version
- Generate/update each package's `CHANGELOG.md`
- Create a single commit and per-package git tags (e.g. `@vendure-community/sentry-plugin@1.1.0`)

> **Note:** The commit and tags are created locally — `push` is disabled in `lerna.json` so you
> have a chance to review before pushing.

#### 3. Push to remote

```bash
git push && git push --tags
```

#### 4. Publish to npm

Go to **Actions → Publish to npm → Run workflow** and select:

| Input       | Description                                                                    |
|-------------|--------------------------------------------------------------------------------|
| **package** | Which package to publish, or `all` to publish every package with a new version |
| **dist-tag** | `latest` for stable releases, `next` or `dev` for pre-releases               |
| **dry-run** | Check what would be published without actually publishing                      |

- **Single package**: Uses `npm publish` directly for the selected package.
- **All + latest**: Uses `lerna publish from-package` which compares local versions to the npm
  registry and only publishes packages with unpublished versions.
- **All + next/dev**: Publishes all packages with auto-bumped pre-release versions.

### Pre-releases

Pre-release versions are handled entirely by the workflow — no local versioning needed. Just trigger
the workflow with dist-tag `next` or `dev` and it will automatically bump each selected package to a
timestamped pre-release version (e.g. `1.0.1-dev.202602091234`) and publish it under that dist-tag.

This means `npm install @vendure-community/some-plugin` always gets the latest stable version, while
`npm install @vendure-community/some-plugin@dev` gets the pre-release.

### Requirements

- An `NPM_TOKEN` secret must be configured in the repository settings with publish access to the
  `@vendure-community` npm org.

## License

GPL-3.0-or-later. See [LICENSE.md](LICENSE.md).
