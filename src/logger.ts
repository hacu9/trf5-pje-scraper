/**
 * Small structured logger.
 *
 * It writes a human readable line to the console and the same line to
 * `data/scraper.log`, so a long unattended run leaves a trail. There is no
 * dependency behind it because a scraper does not need one.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from './config';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

function isLevel(value: string): value is LogLevel {
  return value in LEVELS;
}

const threshold = isLevel(config.logLevel) ? LEVELS[config.logLevel] : LEVELS.info;

let stream: fs.WriteStream | null = null;

function fileStream(): fs.WriteStream {
  if (stream === null) {
    fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
    stream = fs.createWriteStream(config.logFile, { flags: 'a' });
  }
  return stream;
}

function render(level: LogLevel, message: string, fields?: Record<string, unknown>): string {
  const stamp = new Date().toISOString();
  const tail =
    fields === undefined || Object.keys(fields).length === 0
      ? ''
      : ' ' +
        Object.entries(fields)
          .map(([key, value]) => `${key}=${format(value)}`)
          .join(' ');
  return `${stamp} ${level.toUpperCase().padEnd(5)} ${message}${tail}`;
}

function format(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return /\s/.test(value) ? JSON.stringify(value) : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = render(level, message, fields);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
  fileStream().write(line + '\n');
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => emit('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => emit('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit('error', message, fields),
  /** Flush and close the log file. Call it before the process exits. */
  close: (): Promise<void> =>
    new Promise((resolve) => {
      if (stream === null) return resolve();
      stream.end(() => resolve());
    }),
};
