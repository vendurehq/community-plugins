import { bootstrap, JobQueueService } from '@vendure/core';

import { devConfig } from './dev-config';

bootstrap(devConfig)
    .then(app => {
        if (process.env.RUN_JOB_QUEUE === '1') {
            return app.get(JobQueueService).start();
        }
    })
    .catch(err => {
        console.log(err);
        process.exit(1);
    });
