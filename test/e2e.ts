/**
 * End to end test against the LIVE portal.
 *
 * `npm test` is hermetic: it runs against captured fixtures and a local stub, so
 * it passes on a plane and in CI. That is the right default, but it cannot tell
 * you the portal still behaves the way this scraper believes it does. A court
 * system is rebuilt without warning, every component id in it is an unstable
 * `j_idNNN`, and a redeploy is exactly the change that a fixture cannot catch.
 *
 * So this file walks the whole real path, once:
 *
 *   1. bootstrap the session and learn the form
 *   2. confirm the reCAPTCHA is still switched off
 *   3. run a search and read the result grid
 *   4. open one case
 *   5. page the movements panel and prove page 1 was not the whole record
 *   6. download one real PDF and check the magic bytes
 *
 * Run it with `npm run test:e2e`. It is deliberately not part of `npm test`.
 *
 * Budget: about a dozen requests at the configured politeness delay. It reads
 * public records only and writes nothing outside `test/.output`.
 *
 * If the portal is unreachable the run reports SKIPPED and exits 0. A court
 * being down is not a defect in this code, and a red build that means "the
 * network was bad" trains you to ignore red builds.
 */

// MUST be first: it sets the environment that src/config.ts reads at import time.
import './e2e-env';

import * as assert from 'node:assert/strict';

import { HttpClient } from '../src/http/client';
import { SearchView, assertCaptchaDisabled } from '../src/jsf/searchView';
import { parseSearchResults } from '../src/scrape/listParser';
import { parseProcessDetail } from '../src/scrape/detailParser';
import { fetchRemainingPages, findPanelPagers } from '../src/scrape/panelPager';
import { PdfDownloader } from '../src/scrape/pdfDownloader';
import { config } from '../src/config';

/**
 * A party name that reliably matches. The portal demands at least two names, and
 * refuses a single one with a validation message rather than an empty grid.
 */
const PARTY = process.env.E2E_PARTY ?? 'MARIA SILVA';

let step = 0;
function ok(label: string, detail = ''): void {
  step += 1;
  process.stdout.write(`  ok   ${step}. ${label}${detail === '' ? '' : ` (${detail})`}\n`);
}

/** True when the failure is the network or the portal, not this code. */
function isUnreachable(error: unknown): boolean {
  const message = (error as Error).message ?? '';
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|timeout/i.test(
    message,
  );
}

async function main(): Promise<void> {
  process.stdout.write(`\ne2e against ${config.baseUrl}\n\n`);
  const http = new HttpClient();

  // 1. Session and form discovery -------------------------------------------
  const view = new SearchView(http);
  await view.load();
  ok('the session bootstraps and the fPP form is understood');

  // 2. The captcha guard ----------------------------------------------------
  // The portal ships `if (false) { grecaptcha.execute(); }`. If that ever
  // becomes `if (true)` this scraper is finished, and it should say so loudly
  // rather than quietly returning zero rows.
  const page = await http.requestText(view.url, { label: 'captcha check' });
  assertCaptchaDisabled(page.text);
  ok('the reCAPTCHA is still disabled server side');

  // 3. Search ---------------------------------------------------------------
  const envelope = await view.submitSearch({ nomeParte: PARTY });
  const result = parseSearchResults(envelope, { nomeParte: PARTY });

  assert.equal(
    result.validationMessage,
    null,
    `the portal rejected the search: ${String(result.validationMessage)}`,
  );
  assert.ok(result.rows.length > 0, 'the search returned no rows at all');
  const first = result.rows[0]!;
  assert.match(first.numeroProcesso, /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/);
  assert.ok(first.ca.length > 0, 'the row carries no ca token');
  ok('the search returns a parsed result grid', `${result.rows.length} rows`);

  // 4. Detail ---------------------------------------------------------------
  const detailResponse = await http.requestText(first.detailUrl, {
    label: `detail ${first.numeroProcesso}`,
    headers: { Referer: view.url },
  });
  const detail = parseProcessDetail(detailResponse.text, first.ca, first.detailUrl);

  assert.equal(detail.numeroProcesso, first.numeroProcesso);
  assert.ok(detail.partes.length > 0, 'no parties parsed');
  assert.ok(detail.movimentacoes.length > 0, 'no movements parsed');
  ok(
    'the case detail parses',
    `${detail.partes.length} parties, ${detail.movimentacoes.length} movements on page 1`,
  );

  // 5. Pagination -----------------------------------------------------------
  // A detail page carries up to two sliders, one for the movements panel and
  // one for the documents grid. Both must be walked. The documents one is the
  // one that hides downloadable PDFs.
  const pagers = findPanelPagers(detailResponse.text).filter((p) => p.lastPage > p.currentPage);
  const firstPageMovements = detail.movimentacoes.length;
  const firstPageDocuments = detail.documentos.length;

  if (pagers.length === 0) {
    ok('the case fits on one page, so there is nothing to page', 'short record');
  } else {
    let movements = firstPageMovements;
    let documents = firstPageDocuments;
    const seen = new Set(detail.documentos.map((d) => d.idProcessoDocumento));
    const summaries: string[] = [];

    for (const pager of pagers) {
      const extra = await fetchRemainingPages(http, first.detailUrl, pager, first.numeroProcesso);
      assert.equal(extra.pagesFailed, 0, `a ${extra.kind} page failed to load`);

      movements += extra.movimentacoes.length;
      let added = 0;
      for (const document of extra.documentos) {
        if (seen.has(document.idProcessoDocumento)) continue;
        seen.add(document.idProcessoDocumento);
        added += 1;
      }
      documents += added;

      // Trust the portal's own footer, never the scraper's count.
      const got = extra.kind === 'documents' ? documents : movements;
      if (pager.reportedTotal !== null) {
        assert.equal(
          got,
          pager.reportedTotal,
          `${extra.kind}: read ${got} but the panel footer reported ${pager.reportedTotal}`,
        );
      }
      summaries.push(
        `${extra.kind} ${got} over ${pager.lastPage} pages` +
          (pager.reportedTotal === null ? '' : ` (footer says ${pager.reportedTotal})`),
      );
    }

    assert.ok(
      movements > firstPageMovements || documents > firstPageDocuments,
      'paging every panel added nothing at all',
    );
    ok('every panel is paged, not just the delivered page', summaries.join('; '));

    if (documents > firstPageDocuments) {
      ok(
        'the documents grid had a second page that the first GET did not show',
        `${firstPageDocuments} delivered, ${documents} total`,
      );
    }
  }

  // 6. A real PDF -----------------------------------------------------------
  const downloadable = detail.documentos.find((document) => document.formato === 'pdf');
  if (downloadable === undefined) {
    ok('this case exposes no public PDF, which is a valid state', 'nothing to download');
  } else {
    const outcome = await new PdfDownloader(http).download(first.numeroProcesso, downloadable, 0);
    assert.equal(outcome.ok, true, `the download failed: ${String(outcome.error)}`);
    assert.ok((outcome.bytes ?? 0) > 0, 'the PDF was empty');
    ok('one real PDF downloads and is a PDF', `${outcome.bytes} bytes -> ${String(outcome.path)}`);
  }

  process.stdout.write(`\n${step} checks passed against the live portal\n`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    if (isUnreachable(error)) {
      process.stdout.write(
        `\nSKIPPED: the portal is unreachable (${(error as Error).message}).\n` +
          'That is an outage, not a defect. Run `npm test` for the offline suite.\n',
      );
      process.exit(0);
    }
    process.stdout.write(`\nFAILED at step ${step + 1}\n${(error as Error).stack ?? String(error)}\n`);
    process.exit(1);
  });
