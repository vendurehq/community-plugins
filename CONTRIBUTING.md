# Contributing to Vendure Community Plugins

Thanks for your interest in contributing! This document covers everything you need to get set up and run tests. For publishing new versions, see [RELEASING.md](./RELEASING.md).

## Contributor License Agreement

Before your first contribution can be merged, you'll be asked to sign our [Contributor License Agreement](https://github.com/vendurehq/vendure/blob/master/license/CLA.md). When you open a pull request, the CLA Assistant bot will comment with instructions — just reply with the requested signature line and you're done. Signatures are stored centrally in the [main Vendure repo](https://github.com/vendurehq/vendure), so you only need to sign once across all Vendure open-source projects.

## Prerequisites

- Node.js >= 20
- Docker (for Elasticsearch and Redis in e2e tests)

## Setup

```bash
bun install
bun run build
```

## Linting

```bash
# Check for lint issues
bun run lint

# Auto-fix lint issues
npx eslint --fix .
```

## Running tests

```bash
# Start services
docker compose up -d

# Run all unit tests
bun run test

# Run all e2e tests
bun run e2e

# Run e2e for a specific package
cd packages/elasticsearch-plugin && bun run e2e
```

## Commit messages

This repo uses [conventional commits](https://www.conventionalcommits.org/) — the type and scope
drive version bumps and changelogs. **Scope each commit to the package directory name** so changes
are attributed to the right package:

- `fix(mollie-plugin): ...` — patch (1.0.0 → 1.0.1)
- `feat(mollie-plugin): ...` — minor (1.0.0 → 1.1.0)
- `feat(mollie-plugin)!: ...` or `BREAKING CHANGE:` in the footer — major (1.0.0 → 2.0.0)

## Releasing

Publishing new versions is a maintainer task — see **[RELEASING.md](./RELEASING.md)**.
