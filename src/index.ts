#!/usr/bin/env node
/**
 * Command line entry point.
 *
 * Commands
 *
 *   probe    Load the search view and print what was discovered about it.
 *            Run this first. It proves the session works and shows the
 *            generated component ids the scraper resolved.
 *
 *   classes  Read the classe judicial catalogue and cache it in
 *            data/judicial-classes.json. The crawler uses it to subdivide a
 *            search slice that the server truncated.
 *
 *   crawl    The real run. Search, walk every case, extract, download PDFs.
 *
 *   retry    Replay everything in data/failures.jsonl.
 *
 *   export   Turn the JSON Lines output into CSV.
 */

import { HttpClient } from './http/client';
import { SearchView } from './jsf/searchView';
import { Crawler, CrawlOptions, CrawlSummary } from './scrape/crawler';
import { Store } from './store/persistence';
import { fetchJudicialClasses, loadJudicialClasses, saveJudicialClasses } from './scrape/judicialClasses';
import { parseSearchResults } from './scrape/listParser';
import { exportCsv } from './cli/exporter';
import { bool, int, parseArgs, str, ParsedArgs } from './cli/args';
import { config } from './config';
import { log } from './logger';

const USAGE = `
trf5-pje-scraper

  npm run dev -- <command> [flags]
  node dist/index.js <command> [flags]

Commands
  probe                     Load the search view and report what was discovered
  classes                   Fetch and cache the classe judicial catalogue
  crawl                     Search, extract every case, download the PDFs
  retry                     Replay data/failures.jsonl
  export                    Write processes.csv and documents.csv
  help                      This text

Search criteria (at least one is required for crawl)
  --parte "JOSE SILVA"      Party name. The portal demands at least two names.
  --advogado "NAME"         Lawyer name
  --classe "APELACAO CIVEL" Case class, exact name from the catalogue
  --numero 0000000-00.0000.0.00.0000
  --from 01/08/2026         Filing date, start of the window, dd/MM/yyyy
  --to   05/08/2026         Filing date, end of the window, dd/MM/yyyy

Budgets, useful for a first test run
  --max-processes 5         Stop after this many cases (0 means no limit)
  --max-searches 20         Stop after this many search postbacks
  --max-pdfs-per-process 2  Cap the PDFs taken from one case
  --no-pdfs                 Extract metadata only
  --no-classes              Do not use the class catalogue to subdivide

Environment
  REQUEST_DELAY_MS (${config.requestDelayMs})  CONCURRENCY (${config.concurrency})
  MAX_RETRIES (${config.maxRetries})           BACKOFF_BASE_MS (${config.backoffBaseMs})
  OUTPUT_DIR (${config.dataDir})
  LOG_LEVEL (${config.logLevel})
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'probe':
      return probe();
    case 'classes':
      return classes();
    case 'crawl':
      return crawl(args);
    case 'retry':
      return retry(args);
    case 'export':
      await exportCsv();
      return 0;
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`unknown command: ${args.command}\n${USAGE}`);
      return 2;
  }
}

async function probe(): Promise<number> {
  const http = new HttpClient();
  const view = new SearchView(http);
  await view.load();

  log.info('probe: submitting a narrow test search');
  const envelope = await view.submitSearch({ nomeParte: 'GERALDA PEREIRA' });
  const result = parseSearchResults(envelope, { nomeParte: 'GERALDA PEREIRA' });

  process.stdout.write(
    JSON.stringify(
      {
        searchUrl: view.url,
        viewState: view.currentViewState,
        submitParameter: view.submitParameter,
        resolvedFields: {
          nomeParte: view.fieldName('nomeParte'),
          classeJudicial: view.fieldName('classeJudicial'),
          dataInicio: view.fieldName('dataInicio'),
          dataFim: view.fieldName('dataFim'),
        },
        ajaxResponse: { isAjax: envelope.isAjax, updateIds: envelope.updateIds },
        rows: result.rows.length,
        totalLabel: result.totalLabel,
        truncated: result.truncated,
        firstRow: result.rows[0] ?? null,
        http: http.stats,
      },
      null,
      2,
    ) + '\n',
  );
  return 0;
}

async function classes(): Promise<number> {
  const http = new HttpClient();
  const view = new SearchView(http);
  await view.load();
  const catalogue = await fetchJudicialClasses(view);
  saveJudicialClasses(catalogue);
  process.stdout.write(`${catalogue.length} case classes cached in ${config.classesFile}\n`);
  return 0;
}

function crawlOptions(args: ParsedArgs): CrawlOptions {
  const options: CrawlOptions = {
    maxProcesses: int(args, 'max-processes', 0),
    maxSearches: int(args, 'max-searches', 0),
    maxPdfsPerProcess: int(args, 'max-pdfs-per-process', 0),
    downloadPdfs: !bool(args, 'no-pdfs', false),
  };
  const parte = str(args, 'parte');
  const advogado = str(args, 'advogado');
  const classe = str(args, 'classe');
  const numero = str(args, 'numero');
  const from = str(args, 'from');
  const to = str(args, 'to');
  if (parte !== undefined) options.nomeParte = parte;
  if (advogado !== undefined) options.nomeAdvogado = advogado;
  if (classe !== undefined) options.classeJudicial = classe;
  if (numero !== undefined) options.numeroProcesso = numero;
  if (from !== undefined) options.dataInicio = from;
  if (to !== undefined) options.dataFim = to;
  if (!bool(args, 'no-classes', false)) options.classes = loadJudicialClasses();
  return options;
}

async function crawl(args: ParsedArgs): Promise<number> {
  const options = crawlOptions(args);
  const http = new HttpClient();
  const view = new SearchView(http);
  const store = new Store();

  await store.load();
  await view.load();

  const crawler = new Crawler(http, view, store, options);
  const summary = await crawler.run();

  report(summary, http, store);
  return summary.failures > 0 ? 1 : 0;
}

async function retry(args: ParsedArgs): Promise<number> {
  const options = crawlOptions(args);
  const http = new HttpClient();
  const view = new SearchView(http);
  const store = new Store();

  await store.load();
  if (store.failureCount === 0) {
    process.stdout.write('nothing to retry\n');
    return 0;
  }
  await view.load();

  const crawler = new Crawler(http, view, store, options);
  const summary = await crawler.retryFailures();

  report(summary, http, store);
  return summary.failures > 0 ? 1 : 0;
}

function report(summary: CrawlSummary, http: HttpClient, store: Store): void {
  const saturated = store.saturatedCells;
  process.stdout.write(
    '\n' +
      JSON.stringify(
        {
          summary,
          http: http.stats,
          saturatedCells: saturated.length,
          output: {
            processes: config.processesFile,
            documents: config.documentsFile,
            downloads: config.downloadsFile,
            pdfs: config.pdfDir,
            failures: config.failuresFile,
            state: config.stateFile,
            log: config.logFile,
          },
        },
        null,
        2,
      ) +
      '\n',
  );
  if (saturated.length > 0) {
    process.stdout.write(
      `\nWARNING: ${saturated.length} search slices stayed at the ${config.serverResultCap} row ` +
        'server cap and could not be subdivided. Coverage inside them is incomplete. ' +
        `They are listed under saturatedCells in ${config.stateFile}.\n`,
    );
  }
}

main()
  .then(async (code) => {
    await log.close();
    process.exitCode = code;
  })
  .catch(async (error: unknown) => {
    log.error('fatal', { error: (error as Error).message, stack: (error as Error).stack });
    await log.close();
    process.exitCode = 1;
  });
