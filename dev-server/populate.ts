
import { bootstrap, defaultConfig, JobQueueService, Logger, mergeConfig } from '@vendure/core';
import { populate } from '@vendure/core/cli';
import { clearAllTables, populateCustomers } from '@vendure/testing';
import path from 'path';


import { devConfig } from './dev-config';
import { initialData } from './mock-data/data-sources/initial-data';

/* eslint-disable no-console */

/**
 * A CLI script which populates the dev database with deterministic random data.
 */
if (require.main === module) {
    // Running from command line
    const populateConfig = mergeConfig(
        defaultConfig,
        mergeConfig(devConfig, {
            authOptions: {
                tokenMethod: 'bearer',
                requireVerification: false,
            },
            importExportOptions: {
                importAssetsDir: path.join(__dirname, 'mock-data/assets'),
            },
            customFields: {},
        }),
    );
    clearAllTables(populateConfig, true)
        .then(() =>
            populate(
                () =>
                    bootstrap(populateConfig).then(async app => {
                        await app.get(JobQueueService).start();
                        return app;
                    }),
                initialData,
                path.join(__dirname, 'mock-data/data-sources/products.csv'),
            ),
        )
        .then(async app => {
            console.log('populating customers...');
            await populateCustomers(app, 10, message => Logger.error(message));
            return app.close();
        })
        .then(
            () => process.exit(0),
            err => {
                console.log(err);
                process.exit(1);
            },
        );
}
