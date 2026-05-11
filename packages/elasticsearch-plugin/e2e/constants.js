// Backend selection for the e2e suite. One of: 'elasticsearch' | 'opensearch'.
// The CI runs each suite against both backends by setting SEARCH_BACKEND.
const searchBackend = (process.env.SEARCH_BACKEND || 'elasticsearch').toLowerCase();

const defaultPorts = {
    elasticsearch: 9200,
    opensearch: 9201,
};

const elasticsearchHost = 'http://elastic';
const elasticsearchPort = process.env.CI
    ? +(process.env.E2E_ELASTIC_PORT ||
        (searchBackend === 'opensearch'
            ? process.env.E2E_OPENSEARCH_PORT || defaultPorts.opensearch
            : defaultPorts.elasticsearch))
    : defaultPorts[searchBackend] || defaultPorts.elasticsearch;

module.exports = {
    searchBackend,
    elasticsearchHost,
    elasticsearchPort,
};
