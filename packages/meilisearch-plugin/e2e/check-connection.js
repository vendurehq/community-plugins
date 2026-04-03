const { MeiliSearch } = require('meilisearch');
const { meilisearchHost, meilisearchPort, meilisearchApiKey } = require('./constants');

const client = new MeiliSearch({
    host: `${meilisearchHost}:${meilisearchPort}`,
    apiKey: meilisearchApiKey,
});

/**
 * When contributing to Vendure, developers who made changes unrelated to
 * this plugin should not be expected to set up a Meilisearch instance
 * locally just so they can get the pre-push hook to pass. So if no
 * instance is available, we skip the tests.
 */
async function checkConnection() {
    try {
        await client.health();
        // If the connection is available, we exit with 1 in order to invoke the
        // actual e2e test script (since we are using the `||` operator in the "e2e" script)
        return 1;
    } catch (e) {
        console.log(
            `Could not connect to Meilisearch instance at "${meilisearchHost}:${meilisearchPort}"`,
        );
        console.log(`Skipping e2e tests for MeilisearchPlugin`);
        process.env.SKIP_MEILISEARCH_E2E_TESTS = true;
        // If no meilisearch available, we exit with 0 so that the npm script
        // exits
        return 0;
    }
}

checkConnection().then((result) => {
    process.exit(result);
});
