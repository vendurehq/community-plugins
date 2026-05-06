const { searchBackend, elasticsearchHost, elasticsearchPort } = require('./constants');

/**
 * When contributing to Vendure, developers who made changes unrelated to
 * this plugin should not be expected to set up an Elasticsearch/OpenSearch
 * instance locally just so they can get the pre-push hook to pass. So if no
 * instance is available, we skip the tests.
 */
async function checkConnection() {
    let Client;
    try {
        if (searchBackend === 'opensearch') {
            ({ Client } = require('@opensearch-project/opensearch'));
        } else {
            ({ Client } = require('@elastic/elasticsearch'));
        }
    } catch (e) {
        console.log(`Backend client for "${searchBackend}" is not installed: ${e.message}`);
        console.log(`Skipping e2e tests for ElasticsearchPlugin (${searchBackend}) backend`);
        process.env.SKIP_ELASTICSEARCH_E2E_TESTS = true;
        return 0;
    }
    const client = new Client({ node: `${elasticsearchHost}:${elasticsearchPort}` });
    try {
        await client.ping({}, { requestTimeout: 1000 });
        // If the connection is available, we exit with 1 in order to invoke the
        // actual e2e test script (since we are using the `||` operator in the "e2e" script)
        return 1;
    } catch (e) {
        console.log(
            `Could not connect to ${searchBackend} instance at "${elasticsearchHost}:${elasticsearchPort}"`,
        );
        console.log(`Skipping e2e tests for ElasticsearchPlugin (${searchBackend}) backend`);
        process.env.SKIP_ELASTICSEARCH_E2E_TESTS = true;
        // If no instance is available, we exit with 0 so that the npm script exits
        return 0;
    }
}

checkConnection().then((result) => {
    process.exit(result);
});
