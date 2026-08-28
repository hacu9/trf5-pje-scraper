/**
 * Everything that touches disk.
 *
 * The layout is deliberately append friendly, because the run is long and can
 * be killed at any moment:
 *
 * * `processes.jsonl`  one JSON object per case, appended as it is scraped
 * * `documents.jsonl`  one JSON object per document, flattened for analysis
 * * `downloads.jsonl`  one line per PDF written to disk, joined in on export
 * * `failures.jsonl`   the retry queue, rewritten whole because it stays small
 * * `state.json`       resume state: which plan cells are finished, counters
 *
 * The download log is a separate file on purpose. A document's metadata is
 * written the moment the detail page is parsed, and its PDF arrives seconds
 * later or never. Holding the metadata back until the bytes land would lose
 * both if the run were killed in between.
 *
 * JSON Lines rather than one big JSON array: an interrupted run leaves a file
 * that is still readable line by line, and a resumed run appends instead of
 * rewriting megabytes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { config } from '../config';
import { log } from '../logger';
import { DocumentRef, FailureRecord, ProcessDetail, ProcessSummary } from '../types';

/** Resume state. Everything here is cheap to keep in memory. */
interface RunState {
  /** Plan cells already finished, so a resumed run skips them. */
  completedCells: string[];
  /**
   * Plan cells that stayed at the server cap even after the planner ran out of
   * ways to subdivide them. Coverage inside these is incomplete BY DESIGN and
   * the operator needs to know which ones they are.
   */
  saturatedCells: string[];
  /** `ca` tokens already scraped, so a resumed run does not refetch them. */
  seenProcesses: string[];
  /** Document ids whose PDF is already on disk. */
  downloadedDocuments: string[];
  startedAt: string;
  updatedAt: string;
}

const EMPTY_STATE: RunState = {
  completedCells: [],
  saturatedCells: [],
  seenProcesses: [],
  downloadedDocuments: [],
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

/** One line of `documents.jsonl`. The case fields are denormalised on purpose. */
export interface DocumentRow extends DocumentRef {
  numeroProcesso: string;
  ca: string;
  classeJudicial: string | null;
}

/** One line of `downloads.jsonl`. */
export interface DownloadRow {
  idProcessoDocumento: string;
  numeroProcesso: string;
  /** Path relative to the PDF directory. */
  arquivoLocal: string;
  bytes: number;
  downloadedAt: string;
}

export class Store {
  private state: RunState = { ...EMPTY_STATE };
  private completed = new Set<string>();
  private saturated = new Set<string>();
  private seen = new Set<string>();
  private downloaded = new Set<string>();
  private failures = new Map<string, FailureRecord>();
  private dirty = false;

  async load(): Promise<void> {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.mkdirSync(config.pdfDir, { recursive: true });

    if (fs.existsSync(config.stateFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(config.stateFile, 'utf8')) as Partial<RunState>;
        this.state = { ...EMPTY_STATE, ...parsed };
      } catch (error) {
        log.warn('state file is unreadable, starting a fresh state', {
          file: config.stateFile,
          error: (error as Error).message,
        });
      }
    }

    this.completed = new Set(this.state.completedCells);
    this.saturated = new Set(this.state.saturatedCells);
    this.seen = new Set(this.state.seenProcesses);
    this.downloaded = new Set(this.state.downloadedDocuments);

    await this.loadFailures();

    log.info('store ready', {
      dir: config.dataDir,
      knownProcesses: this.seen.size,
      completedCells: this.completed.size,
      pendingFailures: this.failures.size,
    });
  }

  // ---- resume state -------------------------------------------------------

  isCellDone(key: string): boolean {
    return this.completed.has(key);
  }

  markCellDone(key: string): void {
    if (this.completed.has(key)) return;
    this.completed.add(key);
    this.dirty = true;
  }

  markCellSaturated(key: string): void {
    if (this.saturated.has(key)) return;
    this.saturated.add(key);
    this.dirty = true;
    log.warn('search slice stayed at the server cap and cannot be subdivided further', {
      cell: key,
    });
  }

  get saturatedCells(): string[] {
    return [...this.saturated];
  }

  /**
   * Has this case already been scraped?
   *
   * Both keys are checked. The `ca` token looks deterministic per case, but it
   * is an opaque server token and nothing published guarantees that, so the case
   * number is stored alongside it. Either one matching means the case is done.
   */
  hasProcess(row: Pick<ProcessSummary, 'ca' | 'numeroProcesso'>): boolean {
    if (this.seen.has(row.ca)) return true;
    return row.numeroProcesso !== '' && this.seen.has(row.numeroProcesso);
  }

  hasDownload(idProcessoDocumento: string): boolean {
    return this.downloaded.has(idProcessoDocumento);
  }

  markDownloaded(idProcessoDocumento: string): void {
    if (this.downloaded.has(idProcessoDocumento)) return;
    this.downloaded.add(idProcessoDocumento);
    this.dirty = true;
  }

  // ---- extracted data -----------------------------------------------------

  /** Append one case and its documents. Returns the document rows written. */
  appendProcess(detail: ProcessDetail, summary: ProcessSummary | null): DocumentRow[] {
    const record = {
      ...detail,
      internalId: summary?.internalId ?? null,
      foundBy: summary?.foundBy ?? null,
      partesResumo: summary?.partesResumo ?? null,
      ultimaMovimentacao: summary?.ultimaMovimentacao ?? null,
    };
    appendLine(config.processesFile, record);

    const rows: DocumentRow[] = detail.documentos.map((document) => ({
      ...document,
      numeroProcesso: detail.numeroProcesso,
      ca: detail.ca,
      classeJudicial: detail.classeJudicial,
    }));
    for (const row of rows) appendLine(config.documentsFile, row);

    this.seen.add(detail.ca);
    if (detail.numeroProcesso !== '') this.seen.add(detail.numeroProcesso);
    this.dirty = true;
    return rows;
  }

  /** Log one PDF that reached disk. Joined into the CSV by the export command. */
  appendDownload(row: DownloadRow): void {
    appendLine(config.downloadsFile, row);
  }

  // ---- failure queue ------------------------------------------------------

  /**
   * Record a unit of work that failed, or bump the attempt counter of one that
   * already failed. This is the list the `retry` command replays.
   */
  recordFailure(record: Omit<FailureRecord, 'attempts' | 'lastAttemptAt'>): void {
    const existing = this.failures.get(record.key);
    const merged: FailureRecord = {
      ...record,
      attempts: (existing?.attempts ?? 0) + 1,
      lastAttemptAt: new Date().toISOString(),
    };
    this.failures.set(record.key, merged);
    this.flushFailures();
    log.warn('recorded a failed unit for later retry', {
      kind: record.kind,
      key: record.key,
      status: record.status,
      attempts: merged.attempts,
    });
  }

  clearFailure(key: string): void {
    if (this.failures.delete(key)) this.flushFailures();
  }

  listFailures(kind?: FailureRecord['kind']): FailureRecord[] {
    const all = [...this.failures.values()];
    return kind === undefined ? all : all.filter((record) => record.kind === kind);
  }

  get failureCount(): number {
    return this.failures.size;
  }

  // ---- flushing -----------------------------------------------------------

  /** Persist the resume state. Cheap enough to call after every unit of work. */
  save(): void {
    if (!this.dirty) return;
    this.state = {
      completedCells: [...this.completed],
      saturatedCells: [...this.saturated],
      seenProcesses: [...this.seen],
      downloadedDocuments: [...this.downloaded],
      startedAt: this.state.startedAt,
      updatedAt: new Date().toISOString(),
    };
    writeAtomic(config.stateFile, JSON.stringify(this.state, null, 2));
    this.dirty = false;
  }

  private flushFailures(): void {
    const body = [...this.failures.values()].map((record) => JSON.stringify(record)).join('\n');
    writeAtomic(config.failuresFile, body === '' ? '' : body + '\n');
  }

  private async loadFailures(): Promise<void> {
    if (!fs.existsSync(config.failuresFile)) return;
    const stream = readline.createInterface({
      input: fs.createReadStream(config.failuresFile, 'utf8'),
      crlfDelay: Infinity,
    });
    for await (const line of stream) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const record = JSON.parse(trimmed) as FailureRecord;
        this.failures.set(record.key, record);
      } catch {
        log.warn('skipping an unreadable line in the failures file');
      }
    }
  }
}

function appendLine(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + '\n', 'utf8');
}

/**
 * Write through a temporary file and rename.
 *
 * A rename is atomic on the same filesystem, so a kill in the middle leaves the
 * previous state file intact instead of a truncated one. The resume state is
 * the file that must never be half written.
 */
function writeAtomic(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, body, 'utf8');
  fs.renameSync(temporary, file);
}

/** Read a JSON Lines file back into memory. Used by the `export` command. */
export async function readJsonLines<T>(file: string): Promise<T[]> {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  const stream = readline.createInterface({
    input: fs.createReadStream(file, 'utf8'),
    crlfDelay: Infinity,
  });
  for await (const line of stream) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      log.warn('skipping an unreadable JSON line', { file });
    }
  }
  return out;
}
