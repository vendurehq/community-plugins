const opensearchHost = 'http://127.0.0.1';
// Host 9201 -> container 9200 so the OpenSearch service can run alongside the
// elasticsearch service (which keeps 9200). CI maps the same way via
// .github/workflows/build-and-test.yml. Override with E2E_OPENSEARCH_PORT.
const opensearchPort = +(process.env.E2E_OPENSEARCH_PORT || 9201);

module.exports = {
    opensearchHost,
    opensearchPort,
};
