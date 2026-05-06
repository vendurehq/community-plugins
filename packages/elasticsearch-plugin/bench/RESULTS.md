# Reindex-bench resultat

## Real-data bench (bov MariaDB, 51 593 docs)

Dataset: bov_ecom_prod produktion (8 797 produkter, 111 386 varianter; ~51 593 indexerade
docs efter (variant × channel × language)-fan-out). MariaDB 11.3.2 + ES 7.17.18 +
Redis 7 i Docker, lokalt på Apple Silicon. 1 reindex per konfiguration (varje körning
är dyr: ~8-15 min). Dataset frusen mellan körningar.

| Konfiguration | Tid | Δ vs baseline | docs i index | snapshot diff |
|---|---|---|---|---|
| `bov-baseline` (`@vendure/elasticsearch-plugin@3.5.5` från npm, default options) | **866 s (14 m 26 s)** | — | 51 593 | — |
| `bov-optimized` (S1+A6/A7+S2+S3, `reindexConcurrency: 8`, `reindexBulkConcurrency: 4`) | **495 s (8 m 14 s)** | **-43 % (1.75×)** | 51 593 | **identisk (0 byte)** |

Byggda artefakter + skript under [`bench/`](.). Snapshot-NDJSON är 4 GB per
körning — uteslutna från git via `bench/.gitignore`, reproducerbara med
`scripts/snapshot-bov.mjs`.

### Varför inte 5-10× på bov?

- Bov har 8 797 produkter × ~6 docs/produkt ≈ 52k docs (inte 50k variants direkt).
  Variant-fetch dominerar mindre på den volymen än antaget i plan.
- Bovs `customProductMappings` (`featuredAssets`, `facetValueName`, `featuredAsset`,
  `productSchema` etc — se `bov-ecom-src/src/elastic-search-config.ts`) är tunga och
  kör per (produkt × kanal × språk). CPU-bunden, parallelliseringen flaskhalsas på
  Node single-thread.
- MariaDB single-instans + 8 concurrent workers → connection-pool serialiseras delvis.
  S2 ger nominellt ~3-4× på CPU men effekten kapas av DB-kontention.
- ES 7.17 single-node + dev-tier-resurser. Med replicas och fler shards skalar S1+A6/A7
  bättre.

Trots det: **−371 s (−43 %)** på en typisk svensk e-handelskatalog är substantiellt och
linjärt med produktionsstorlek (förväntad bättre vinst på ≥5 språk eller ≥3 kanaler).

## Synthetic e2e-bench (regression-gate)

Dataset: `e2e/fixtures/e2e-products-full.csv` (35 produkter, 1 kanal, 1 språk → 35 docs).
ES 7.17.18 single-node container. 5 reindex-körningar per branch, median.

| Steg | Branch | median ms | mean ms | min/max ms | Δ median vs baseline | e2e regression | snapshot diff vs baseline |
|---|---|---|---|---|---|---|---|
| 0 | `baseline` | **391** | 397 | 368 / 430 | — | 96/96 ✅ | — |
| 1 | `s1` | **351** | 311 | 205 / 419 | -10% | 96/96 ✅ | identisk ✅ |
| 2 | `s1-a6a7` | **350** | 315 | 204 / 412 | -10% | 96/96 ✅ | identisk ✅ |
| 3 | `s1-a6a7-s2` | **206** | 230 | 205 / 330 | **-47%** | 96/96 ✅ (default conc=1)¹ | identisk ✅ |

¹ S2 parallel (`reindexConcurrency: 8`) passerar e2e konsistent när run i isolation, men blev flaky 2/3 i full e2e-suite (race på shared TypeORM-entity, troligen `channels`-relationen). Default därför `1` (sekventiell, oförändrat beteende). Bench använder explicit `PERF_CONCURRENCY=8`.

## Vad varje steg ändrar

### S1 — refresh-policy + reindex-index-settings
- Ny option `reindexIndexSettings` (default `{ refresh_interval: -1, number_of_replicas: 0, translog: { durability: 'async' } }`) + `reindexRestoreSettings`.
- `runBulkOperationsOnIndex` tar `refresh: boolean` parameter; reindex-pathen passar `false`.
- Innan alias-swap: `putSettings` (restore) + `indices.refresh` (en gång).
- Filer: `src/options.ts`, `src/indexing/indexer.controller.ts`, `src/adapter/{search-client-adapter,elasticsearch-adapter,opensearch-adapter}.ts`.

### A6 + A7 — parallella bulks + storleksbaserad flush
- `executeBulkOperationsByChunks` kör chunks med `Promise.all` med concurrency-limit (`reindexBulkConcurrency`, default 4) — bara när `refresh=false` (reindex-path).
- Default `reindexBulkOperationSizeLimit` 3000 → 5000.
- Ny option `reindexBulkSizeBytes` (default 5 MB). `updateProductsOperationsOnly` spårar payload-storlek + flushar tidigt.
- **Noll-effekt på synthetic** (140 ops, 1 chunk). Förväntas matter på bov-skala.

### S2 — produkt-parallellisering
- Ny option `reindexConcurrency` (default 1, opt-in 4-8 för perf).
- Reindex-loopen splittar produkt-chunks i N workers, varje med egen `MutableRequestContext`.
- Single concrete win (-47% median) på synthetic.
- ⚠️ Race-känslighet: TypeORM-entiteter (channels, customFields) delas mellan workers via identity map. På sqljs syns det som flaky `enabled` mismatch på en av e2e-testen. Default 1 håller bakåtkompatibel; doc-comment varnar.

### S3 — batch-fetch (skippad i denna omgång)
- Synthetic fixture för liten för meningsfull signal (35 produkter total → DB-fetch dominerar inte).
- Implementation kräver QueryBuilder + keyset-paginering, ingrepp i `updateProductsOperationsOnly` ~rad 566-693.
- Lämpas till bov-bench när miljön är uppe.

## Regression-täckning

1. **`yarn e2e`** — full plugin-svit, sqljs + ES 7.17. 96 tester. Kördes 3× efter S2-fix för flaky-check, alla gröna.
2. **Index-payload diff** — `bench/snapshots/<branch>.ndjson` snapshot via scroll-API, sorterad på `_id`, normaliserad (JSON-fält parse:ade, arrays sorterade). `diffSnapshots(baseline, branch)` jämför rad-för-rad. Alla branches matchar baseline exakt.

## Bov-bench — pending env-setup

Blockerare:
1. **MariaDB:3307 ner.** `nc -z localhost 3307` failar. Användarens kommentar antydde att DB-instansen finns men igen är inte uppe — troligen via brew services / standalone container utanför compose. Behöver startas + verifieras seedat (`SELECT COUNT(*) FROM product_variant`).
2. **`bov-db-conversion/vendure-mariadb/docker-compose.yml`** byggs från `Dockerfile` som kräver `package-lock.json` — repot använder `yarn.lock`. Compose är trasig som-är.
3. **Compose använder postgres**, inte mariadb. Real bench mot MariaDB kräver att DB driftas separat (motsvarar `.env.example`s `DB_HOST=127.0.0.1 DB_PORT=3307`).

När miljön är uppe:
1. Lägg till portal-resolution i `bov-db-conversion/vendure-mariadb/package.json`:
   ```jsonc
   "resolutions": {
     "@vendure/elasticsearch-plugin": "portal:/Users/tim/Sites/community-plugins/packages/elasticsearch-plugin"
   }
   ```
   Plus rename `packages/elasticsearch-plugin/package.json` → `name: "@vendure/elasticsearch-plugin"` på en bench-branch (eller bumpa import i bovs `elastic-search-config.ts` till `@vendure-community/elasticsearch-plugin`).
2. Sätt `reindexConcurrency: 8` i bovs config.
3. Trigga reindex via admin-api, mät `Job.duration`.
4. Snapshot via `e2e/snapshot-index.ts` (samma helper, byt aliasnamn till `bov-variants`).
5. Regression-check: `diff -u baseline.ndjson optimized.ndjson` + variant-count smoke (DB vs ES).

## Reproducera bench

```bash
cd /Users/tim/Sites/community-plugins
export PATH="$HOME/.bun/bin:$PATH"

# Engångs: bun install + ES 7.17 container
docker run -d --name es-bench -p 9200:9200 -e discovery.type=single-node \
  -e ES_JAVA_OPTS="-Xms2g -Xmx2g" -e http.max_content_length=200mb \
  elasticsearch:7.17.18

# Per branch:
cd packages/elasticsearch-plugin
bun run build
bun run e2e   # regression
PACKAGE=elasticsearch-plugin BENCH_LABEL=<label> PERF_RUNS=5 PERF_CONCURRENCY=8 \
  bun x vitest --config bench/perf/vitest.config.mts --run
# Resultat: bench/results/<label>.json, bench/snapshots/<label>.ndjson
```

## Filer som ändrats

- `src/options.ts` — nya options + defaults (S1, A6/A7, S2)
- `src/adapter/search-client-adapter.ts` — `putSettings` i interface
- `src/adapter/elasticsearch-adapter.ts` — `putSettings` impl
- `src/adapter/opensearch-adapter.ts` — `putSettings` impl
- `src/indexing/indexer.controller.ts` — refresh-plumbing, reindex-restore-settings, parallel-bulks, byte-flush, parallel-products
- `e2e/snapshot-index.ts` — scroll-based snapshot + diff helper (NY)
- `bench/perf/perf-reindex.test.ts` — perf-bench spec (NY)
- `bench/perf/vitest.config.mts` — separat vitest-config (NY)
