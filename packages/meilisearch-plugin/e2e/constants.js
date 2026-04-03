const meilisearchHost = process.env.CI
    ? (process.env.E2E_MEILISEARCH_HOST || 'http://127.0.0.1')
    : 'http://127.0.0.1';
const meilisearchPort = process.env.CI ? +(process.env.E2E_MEILISEARCH_PORT || 7700) : 7700;
const meilisearchApiKey = process.env.MEILISEARCH_API_KEY || '';

module.exports = {
    meilisearchHost,
    meilisearchPort,
    meilisearchApiKey,
};
