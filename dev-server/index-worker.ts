import { bootstrapWorker } from '@vendure/core';

import { devConfig } from './dev-config';

bootstrapWorker(devConfig)
    .then(worker => worker.startJobQueue())
    .catch(err => {
        console.log(err);
        process.exit(1);
    });
