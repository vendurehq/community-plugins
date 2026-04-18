const opensearchHost = 'http://127.0.0.1';
// Local docker-compose maps host 9201 -> container 9200 so OpenSearch can run
// alongside the elasticsearch service (which keeps 9200). In CI you can override
// either of these via the E2E_OPENSEARCH_PORT env var.
const opensearchPort = process.env.CI ? +(process.env.E2E_OPENSEARCH_PORT || 9200) : 9201;

module.exports = {
    opensearchHost,
    opensearchPort,
};
