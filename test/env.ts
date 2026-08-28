/**
 * Test environment.
 *
 * `src/config.ts` reads `process.env` at import time, and an ES import is
 * evaluated before the body of the module that declares it. So the overrides
 * cannot live inside `run.ts`: they have to be in a module that `run.ts`
 * imports FIRST. That is the whole reason this file exists.
 */

import * as path from 'node:path';

process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
process.env.OUTPUT_DIR = process.env.OUTPUT_DIR ?? path.join(__dirname, '.output');
process.env.REQUEST_DELAY_MS = '0';
process.env.REQUEST_JITTER_MS = '0';
process.env.BACKOFF_BASE_MS = '10';
process.env.BACKOFF_MAX_MS = '40';
process.env.MAX_RETRIES = '3';
process.env.COOLDOWN_AFTER = '3';
process.env.COOLDOWN_MS = '50';
process.env.REQUEST_TIMEOUT_MS = '5000';

export {};
