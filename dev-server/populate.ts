import { bootstrap, defaultConfig, JobQueueService, Logger, mergeConfig } from '@vendure/core';
import { populate } from '@vendure/core/cli';
import { clearAllTables, populateCustomers } from '@vendure/testing';
import path from 'path';

import { devConfig } from './dev-config';
import { initialData } from '../e2e-common/e2e-initial-data';

/**
 * Populates the dev database with test data.
 */
const populateConfig = mergeConfig(
    defaultConfig,
    mergeConfig(devConfig, {
        authOptions: {
            tokenMethod: 'bearer',
            requireVerification: false,
        },
        importExportOptions: {
            importAssetsDir: path.join(__dirname, 'import-assets'),
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
        ),
    )
    .then(async app => {
        console.log('Populating customers...');
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
