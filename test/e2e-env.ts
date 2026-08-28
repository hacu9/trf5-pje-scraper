/**
 * Environment for the live end to end run.
 *
 * Separate from `env.ts` on purpose. That file zeroes the delays so the offline
 * suite finishes fast, which is right for a local stub and WRONG for a public
 * court system. These settings are the polite ones: a real gap between requests,
 * one request in flight, and the full retry budget so a 429 is ridden out rather
 * than reported as a failure.
 *
 * It must be imported before anything that reads `src/config.ts`, because that
 * module reads `process.env` at import time.
 */

import * as path from 'node:path';

process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';
process.env.OUTPUT_DIR = process.env.OUTPUT_DIR ?? path.join(__dirname, '.output');
process.env.REQUEST_DELAY_MS = process.env.REQUEST_DELAY_MS ?? '1500';
process.env.REQUEST_JITTER_MS = process.env.REQUEST_JITTER_MS ?? '500';
process.env.CONCURRENCY = '1';

export {};
