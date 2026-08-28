/**
 * Central configuration.
 *
 * Every value has a conservative default and an environment variable override.
 * The defaults are deliberately polite: this is a public government service and
 * the exercise rewards not hammering it.
 */

import * as path from 'node:path';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got ${raw}`);
  }
  return parsed;
}

function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

const dataDir = path.resolve(envStr('OUTPUT_DIR', 'data'));

export const config = {
  /** Portal origin. */
  baseUrl: envStr('BASE_URL', 'https://pjett.trf5.jus.br'),
  /** Path of the public search view. */
  searchPath: '/pjeconsulta/ConsultaPublica/listView.seam',
  /** Path of the case detail view. */
  detailPath: '/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam',

  /** Identify the client honestly. A contact address helps the operators reach us. */
  userAgent: envStr(
    'USER_AGENT',
    'trf5-pje-scraper/1.0 (+https://github.com/hacu9/trf5-pje-scraper)',
  ),

  /** Minimum wait between two requests, in milliseconds. */
  requestDelayMs: envInt('REQUEST_DELAY_MS', 1500),
  /** Random extra wait added on top, in milliseconds. It breaks up a regular pattern. */
  requestJitterMs: envInt('REQUEST_JITTER_MS', 500),
  /** How many requests may be in flight at once. Keep this at 1 or 2. */
  concurrency: envInt('CONCURRENCY', 1),
  /** Socket timeout for a single request, in milliseconds. */
  timeoutMs: envInt('REQUEST_TIMEOUT_MS', 45_000),

  /** How many times a retryable failure is retried before the unit is recorded as failed. */
  maxRetries: envInt('MAX_RETRIES', 5),
  /** First backoff wait, in milliseconds. Each further attempt doubles it. */
  backoffBaseMs: envInt('BACKOFF_BASE_MS', 2_000),
  /** Upper bound on a single backoff wait, in milliseconds. */
  backoffMaxMs: envInt('BACKOFF_MAX_MS', 120_000),
  /**
   * After this many consecutive 429 answers the whole client pauses for
   * `coolDownMs` before it touches the site again.
   */
  coolDownAfter: envInt('COOLDOWN_AFTER', 3),
  coolDownMs: envInt('COOLDOWN_MS', 60_000),

  /** Where extracted data, PDFs, state and failures are written. */
  dataDir,
  pdfDir: path.join(dataDir, 'pdfs'),
  processesFile: path.join(dataDir, 'processes.jsonl'),
  documentsFile: path.join(dataDir, 'documents.jsonl'),
  downloadsFile: path.join(dataDir, 'downloads.jsonl'),
  failuresFile: path.join(dataDir, 'failures.jsonl'),
  stateFile: path.join(dataDir, 'state.json'),
  classesFile: path.join(dataDir, 'judicial-classes.json'),
  logFile: path.join(dataDir, 'scraper.log'),

  /** Skip a PDF whose file already exists on disk with a non zero size. */
  skipExistingPdfs: envBool('SKIP_EXISTING_PDFS', true),
  /** Refuse to write a body larger than this, in bytes. */
  maxPdfBytes: envInt('MAX_PDF_BYTES', 100 * 1024 * 1024),

  /** `debug`, `info`, `warn` or `error`. */
  logLevel: envStr('LOG_LEVEL', 'info'),

  /**
   * The server truncates any result set at this many rows and prints a banner.
   * The planner treats a truncated set as a signal to subdivide the criteria.
   */
  serverResultCap: 30,
} as const;

export type Config = typeof config;
