/**
 * The orchestrator.
 *
 * The loop is: take a plan cell, search it, walk its rows, fetch each detail
 * page, persist it, download its PDFs, save the resume state, repeat.
 *
 * Two rules run through the whole file.
 *
 * **A failure never stops the run.** A search, a detail page or a PDF that
 * cannot be had after every retry is written to `failures.jsonl` and the loop
 * moves to the next unit. The `retry` command replays that file later.
 *
 * **The resume state is saved after every unit.** A run killed at any moment
 * restarts where it stopped instead of refetching what it already has.
 */

import { HttpClient } from '../http/client';
import { HttpFailure } from '../http/errors';
import { SearchView } from '../jsf/searchView';
import { looksLikeExpiredView } from '../jsf/ajaxResponse';
import { isAtServerCap, parseSearchResults, RESULT_TABLE_SELECTOR } from './listParser';
import { parseProcessDetail } from './detailParser';
import { fetchRemainingPages, findPanelPagers, hasSlider } from './panelPager';
import { PdfDownloader } from './pdfDownloader';
import { Planner, PlanCell, PlanOptions } from './planner';
import { Store } from '../store/persistence';
import { log } from '../logger';
import { DocumentRef, ProcessDetail, ProcessSummary, SearchResult } from '../types';

export interface CrawlOptions extends PlanOptions {
  /** Stop after this many cases. 0 means no limit. */
  maxProcesses?: number;
  /** Stop after this many search postbacks. 0 means no limit. */
  maxSearches?: number;
  /** Download at most this many PDFs per case. 0 means every one. */
  maxPdfsPerProcess?: number;
  /** Set false to extract metadata only. */
  downloadPdfs?: boolean;
}

export interface CrawlSummary {
  searches: number;
  cellsCompleted: number;
  cellsSaturated: number;
  processesSeen: number;
  processesScraped: number;
  documentsFound: number;
  pdfsDownloaded: number;
  pdfsSkipped: number;
  failures: number;
}

export class Crawler {
  private readonly downloader: PdfDownloader;
  private readonly summary: CrawlSummary = {
    searches: 0,
    cellsCompleted: 0,
    cellsSaturated: 0,
    processesSeen: 0,
    processesScraped: 0,
    documentsFound: 0,
    pdfsDownloaded: 0,
    pdfsSkipped: 0,
    failures: 0,
  };

  constructor(
    private readonly http: HttpClient,
    private readonly view: SearchView,
    private readonly store: Store,
    private readonly options: CrawlOptions,
  ) {
    this.downloader = new PdfDownloader(http);
  }

  async run(): Promise<CrawlSummary> {
    const planner = new Planner(this.options);
    const maxSearches = this.options.maxSearches ?? 0;
    const maxProcesses = this.options.maxProcesses ?? 0;

    for (;;) {
      const cell = planner.next();
      if (cell === undefined) break;
      if (maxSearches > 0 && this.summary.searches >= maxSearches) {
        log.info('reached the search budget, stopping', { maxSearches, pending: planner.pending });
        break;
      }
      if (maxProcesses > 0 && this.summary.processesScraped >= maxProcesses) {
        log.info('reached the case budget, stopping', { maxProcesses });
        break;
      }

      if (this.store.isCellDone(cell.key)) {
        log.debug('cell already finished, skipping', { cell: cell.key });
        continue;
      }

      const result = await this.searchCell(cell);
      if (result === null) continue;

      // A truncated slice is incomplete. Subdivide it and do NOT harvest its
      // rows here: the children will return them, and harvesting now would only
      // duplicate work while hiding the gap.
      if (isAtServerCap(result)) {
        if (planner.subdivide(cell)) {
          log.info('slice hit the server cap, subdividing', {
            cell: cell.key,
            depth: cell.depth,
            pending: planner.pending,
          });
          continue;
        }
        this.store.markCellSaturated(cell.key);
        this.summary.cellsSaturated += 1;
        // Nothing better is available, so keep the thirty rows we do have.
      }

      const complete = await this.harvest(result, maxProcesses);
      // A cell is only finished when EVERY row in it was handled. Marking a
      // cell done after a budget cut it short would make the resume skip it and
      // lose the rows it never reached.
      if (complete) {
        this.store.markCellDone(cell.key);
        this.summary.cellsCompleted += 1;
      }
      this.store.save();
    }

    this.summary.failures = this.store.failureCount;
    this.store.save();
    return this.summary;
  }

  /** Run one cell's search. Returns null when the search failed or was refused. */
  private async searchCell(cell: PlanCell): Promise<SearchResult | null> {
    log.info('searching', { cell: cell.key, depth: cell.depth });
    try {
      const envelope = await this.view.submitSearch(cell.criteria);
      this.summary.searches += 1;

      // Before trusting the answer, check the grid is even there. An expired
      // JSF view answers 200 with the entry page, which parses cleanly as zero
      // rows. Reading that as "no results" would mark the cell finished and
      // lose every case in it.
      if (looksLikeExpiredView(envelope, RESULT_TABLE_SELECTOR)) {
        log.warn('the answer carries no result grid, treating the view as expired', {
          cell: cell.key,
          updateIds: envelope.updateIds,
        });
        await this.rebuildView();
        return null;
      }

      const result = parseSearchResults(envelope, cell.criteria);

      if (result.validationMessage !== null) {
        log.warn('the portal refused the search', {
          cell: cell.key,
          message: result.validationMessage,
        });
        this.store.markCellDone(cell.key);
        return null;
      }

      log.info('search finished', {
        cell: cell.key,
        rows: result.rows.length,
        total: result.totalLabel,
        truncated: result.truncated,
      });
      return result;
    } catch (error) {
      const failure = error as HttpFailure;
      this.store.recordFailure({
        kind: 'search',
        key: `search:${cell.key}`,
        target: this.view.url,
        status: failure.status ?? null,
        error: failure.message,
        context: { criteria: cell.criteria, depth: cell.depth },
      });
      // A search failure can mean the JSF view expired. Rebuild it so the next
      // cell does not inherit a dead ViewState.
      await this.rebuildView();
      return null;
    }
  }

  /** Walk the rows of one search. Returns false when a budget cut the walk short. */
  private async harvest(result: SearchResult, maxProcesses: number): Promise<boolean> {
    for (const row of result.rows) {
      if (maxProcesses > 0 && this.summary.processesScraped >= maxProcesses) return false;
      this.summary.processesSeen += 1;

      if (this.store.hasProcess(row)) {
        log.debug('case already scraped, skipping', { numero: row.numeroProcesso });
        continue;
      }

      const detail = await this.fetchDetail(row);
      if (detail === null) continue;

      const documents = this.store.appendProcess(detail, row);
      // Checkpoint BEFORE the downloads. The case line is already on disk, so a
      // kill during the PDF work must not let the next run append it a second
      // time. The state file is the only thing that stops that.
      this.store.save();
      this.summary.processesScraped += 1;
      this.summary.documentsFound += documents.length;

      log.info('scraped case', {
        numero: detail.numeroProcesso,
        partes: detail.partes.length,
        movimentacoes: detail.movimentacoes.length,
        documentos: detail.documentos.length,
      });

      if (this.options.downloadPdfs !== false) {
        await this.downloadDocuments(detail);
      }

      this.store.save();
    }
    return true;
  }

  private async fetchDetail(row: ProcessSummary): Promise<ProcessDetail | null> {
    try {
      const response = await this.http.requestText(row.detailUrl, {
        label: `detail ${row.numeroProcesso}`,
        headers: { Referer: this.view.url },
      });
      const detail = parseProcessDetail(response.text, row.ca, row.detailUrl);
      await this.pageEveryPanel(detail, row, response.text);
      return detail;
    } catch (error) {
      const failure = error as HttpFailure;
      this.store.recordFailure({
        kind: 'detail',
        key: `detail:${row.ca}`,
        target: row.detailUrl,
        status: failure.status ?? null,
        error: failure.message,
        context: { numeroProcesso: row.numeroProcesso, summary: row },
      });
      return null;
    }
  }

  /**
   * Read every page of every pageable panel on the detail view.
   *
   * The delivered HTML is page one. A case detail page carries up to two
   * sliders, one for the movements panel and one for the documents grid, and
   * they must BOTH be walked: the documents grid holding a second page is how
   * eight downloadable PDFs stayed invisible on a case that looked complete.
   *
   * Completeness is asserted only on positive evidence. Every branch that cannot
   * prove the panel was read in full marks the case partial, because a record
   * that is short and says so is recoverable and one that is short and claims to
   * be whole is not.
   */
  private async pageEveryPanel(
    detail: ProcessDetail,
    row: ProcessSummary,
    html: string,
  ): Promise<void> {
    const allPagers = findPanelPagers(html);
    const pagers = allPagers.filter((pager) => pager.lastPage > pager.currentPage);

    if (pagers.length === 0) {
      // A page with no slider is a short record and is genuinely complete. A
      // page that HAS a slider we could not parse is not, and the two produce
      // the same empty list, so they are separated here rather than conflated.
      const unreadable = hasSlider(html) && allPagers.length === 0;
      if (unreadable) {
        log.warn('the detail page is paged but no slider could be read, recording partial', {
          numeroProcesso: row.numeroProcesso,
        });
      }
      detail.movimentacoesPaginas = 1;
      detail.movimentacoesPaginasLidas = 1;
      detail.movimentacoesCompleto = !unreadable;
      return;
    }

    let pagesOffered = 0;
    let pagesRead = 0;
    let pagesFailed = 0;
    let complete = true;
    // The footer total of each panel, once we know which panel a pager drives.
    let expectedMovements: number | null = null;
    let expectedDocuments: number | null = null;

    for (const pager of pagers) {
      const extra = await fetchRemainingPages(this.http, row.detailUrl, pager, row.numeroProcesso);

      detail.movimentacoes.push(...extra.movimentacoes);
      detail.documentos.push(...dedupeDocuments(detail.documentos, extra.documentos));

      pagesOffered += pager.lastPage;
      pagesRead += 1 + extra.pagesRead;
      pagesFailed += extra.pagesFailed;
      if (extra.pagesFailed > 0) complete = false;

      if (extra.kind === 'movements') expectedMovements = pager.reportedTotal;
      else if (extra.kind === 'documents') expectedDocuments = pager.reportedTotal;
    }

    // Compare against the totals the portal prints itself, in BOTH directions.
    // Reading too few means a page was lost. Reading too many means a page
    // request did not advance and rows were counted twice, which is the shape a
    // paging bug takes when the trigger parameter stops working.
    for (const [label, got, reported] of [
      ['movements', detail.movimentacoes.length, expectedMovements],
      ['documents', detail.documentos.length, expectedDocuments],
    ] as Array<[string, number, number | null]>) {
      if (reported === null || got === reported) continue;
      complete = false;
      log.warn('panel count does not match the total the portal reported', {
        numeroProcesso: row.numeroProcesso,
        panel: label,
        got,
        reported,
      });
    }

    detail.movimentacoesPaginas = pagesOffered;
    detail.movimentacoesPaginasLidas = pagesRead;
    detail.movimentacoesCompleto = complete && pagesFailed === 0;
  }

  private async downloadDocuments(detail: ProcessDetail): Promise<void> {
    const limit = this.options.maxPdfsPerProcess ?? 0;
    let taken = 0;

    for (const [index, document] of detail.documentos.entries()) {
      if (document.formato !== 'pdf') {
        this.summary.pdfsSkipped += 1;
        continue;
      }
      if (limit > 0 && taken >= limit) {
        log.debug('per case PDF limit reached', { numero: detail.numeroProcesso, limit });
        return;
      }
      if (this.store.hasDownload(document.idProcessoDocumento)) {
        this.summary.pdfsSkipped += 1;
        continue;
      }

      const outcome = await this.downloader.download(detail.numeroProcesso, document, index);
      taken += 1;

      if (outcome.ok) {
        this.store.markDownloaded(document.idProcessoDocumento);
        if (outcome.skipped) {
          this.summary.pdfsSkipped += 1;
        } else {
          this.summary.pdfsDownloaded += 1;
          this.store.appendDownload({
            idProcessoDocumento: document.idProcessoDocumento,
            numeroProcesso: detail.numeroProcesso,
            arquivoLocal: outcome.path ?? '',
            bytes: outcome.bytes,
            downloadedAt: new Date().toISOString(),
          });
        }
        this.store.clearFailure(`pdf:${document.idProcessoDocumento}`);
        continue;
      }

      if (outcome.skipped) {
        // No public binary behind this row. Not a failure, just not available.
        this.summary.pdfsSkipped += 1;
        continue;
      }

      this.store.recordFailure({
        kind: 'pdf',
        key: `pdf:${document.idProcessoDocumento}`,
        target: document.downloadUrl ?? '(no url)',
        status: null,
        error: outcome.error ?? 'unknown download error',
        context: {
          numeroProcesso: detail.numeroProcesso,
          ca: detail.ca,
          index,
          document,
        },
      });
    }
  }

  /**
   * Replay `failures.jsonl`.
   *
   * PDF failures replay straight from the recorded context. Detail failures
   * replay from the recorded row. Search failures are put back on a fresh
   * planner so their rows are harvested normally.
   */
  async retryFailures(): Promise<CrawlSummary> {
    const pending = this.store.listFailures();
    log.info('replaying recorded failures', { count: pending.length });

    for (const record of pending) {
      if (record.kind === 'pdf') {
        const context = record.context as
          | { numeroProcesso?: string; index?: number; document?: ProcessDetail['documentos'][number] }
          | undefined;
        const document = context?.document;
        if (document === undefined) {
          log.warn('a pdf failure has no replayable context, leaving it in place', {
            key: record.key,
          });
          continue;
        }
        const outcome = await this.downloader.download(
          context?.numeroProcesso ?? 'sem-numero',
          document,
          context?.index ?? 0,
        );
        if (outcome.ok) {
          this.store.markDownloaded(document.idProcessoDocumento);
          if (!outcome.skipped) {
            this.summary.pdfsDownloaded += 1;
            this.store.appendDownload({
              idProcessoDocumento: document.idProcessoDocumento,
              numeroProcesso: context?.numeroProcesso ?? '',
              arquivoLocal: outcome.path ?? '',
              bytes: outcome.bytes,
              downloadedAt: new Date().toISOString(),
            });
          }
          this.store.clearFailure(record.key);
        } else {
          this.store.recordFailure({
            kind: 'pdf',
            key: record.key,
            target: record.target,
            status: null,
            error: outcome.error ?? 'unknown download error',
            context: record.context ?? {},
          });
        }
        continue;
      }

      if (record.kind === 'detail') {
        const context = record.context as { summary?: ProcessSummary } | undefined;
        const row = context?.summary;
        if (row === undefined) {
          log.warn('a detail failure has no replayable context, leaving it in place', {
            key: record.key,
          });
          continue;
        }
        const detail = await this.fetchDetail(row);
        if (detail === null) continue;
        const documents = this.store.appendProcess(detail, row);
        this.summary.processesScraped += 1;
        this.summary.documentsFound += documents.length;
        this.store.clearFailure(record.key);
        if (this.options.downloadPdfs !== false) await this.downloadDocuments(detail);
        this.store.save();
        continue;
      }

      const context = record.context as { criteria?: PlanCell['criteria'] } | undefined;
      if (context?.criteria === undefined) {
        log.warn('a search failure has no replayable context, leaving it in place', {
          key: record.key,
        });
        continue;
      }
      const cell: PlanCell = { key: record.key.replace(/^search:/, ''), criteria: context.criteria, depth: 0 };
      const result = await this.searchCell(cell);
      if (result === null) continue;
      const complete = await this.harvest(result, this.options.maxProcesses ?? 0);
      // Clearing a failure whose rows were only half walked would drop them.
      if (complete) this.store.clearFailure(record.key);
      this.store.save();
    }

    this.summary.failures = this.store.failureCount;
    this.store.save();
    return this.summary;
  }

  /** Drop the session and load the search view again. */
  private async rebuildView(): Promise<void> {
    log.warn('rebuilding the JSF session after a failed search');
    try {
      await this.http.resetSession();
      await this.view.load();
    } catch (error) {
      log.error('could not rebuild the search view', { error: (error as Error).message });
    }
  }
}

/**
 * A document can be referenced from more than one movement, and the later pages
 * of a long record repeat one. Deduplicate on the portal's own document id so a
 * PDF is not downloaded, or counted, twice.
 */
function dedupeDocuments(existing: DocumentRef[], incoming: DocumentRef[]): DocumentRef[] {
  const byId = new Map(existing.map((document) => [document.idProcessoDocumento, document]));
  const kept: DocumentRef[] = [];

  for (const document of incoming) {
    const already = byId.get(document.idProcessoDocumento);
    if (already === undefined) {
      byId.set(document.idProcessoDocumento, document);
      kept.push(document);
      continue;
    }
    // Same document, seen twice. The panels do not always describe it equally:
    // one can offer the login gated HTML view while the other offers the real
    // PDF. Keeping whichever arrived first would throw away a downloadable file,
    // so a record that carries a download link upgrades one that does not.
    if (already.downloadUrl === null && document.downloadUrl !== null) {
      already.downloadUrl = document.downloadUrl;
      already.formato = document.formato;
      already.idBin = document.idBin ?? already.idBin;
      already.numeroDocumento = document.numeroDocumento ?? already.numeroDocumento;
      already.nomeArquivo = document.nomeArquivo ?? already.nomeArquivo;
    }
  }

  return kept;
}
