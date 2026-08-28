/**
 * Test suite.
 *
 * No test framework on purpose: the assertions below need `node:assert` and a
 * real HTTP server, and adding a runner would be the largest dependency in the
 * project. Run it with `npm test`.
 *
 * The two groups that matter:
 *
 * * PARSERS, checked against fixtures captured verbatim from the live portal.
 *   `search-response.xml` is a real RichFaces ajax answer trimmed to two rows.
 *   `detail.html` is a real detail page, byte for byte, ISO-8859-1 and all.
 *
 * * THE 429 POLICY, checked against a local stub server that answers 429 on
 *   command. The live portal never answered 429 during development, so the
 *   retry path is proved here rather than claimed.
 */

// MUST be first: it sets the environment that src/config.ts reads at import time.
import './env';

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';

import {
  backoffWait,
  backoffWindow,
  decodeBody,
  parseContentDisposition,
  parseRetryAfter,
  HttpClient,
} from '../src/http/client';
import { HttpFailure } from '../src/http/errors';
import { RateLimiter } from '../src/http/rateLimiter';
import { looksLikeExpiredView, parseAjaxResponse } from '../src/jsf/ajaxResponse';
import { assertCaptchaDisabled, extractJsFunctionId } from '../src/jsf/searchView';
import { parseSearchResults, RESULT_TABLE_SELECTOR } from '../src/scrape/listParser';
import { parseProcessDetail, queryParam, readDocuments, slugify } from '../src/scrape/detailParser';
import { findPanelPagers, hasSlider, pageForm } from '../src/scrape/panelPager';
import { cellKey, formatDate, parseDate, splitRange, Planner } from '../src/scrape/planner';
import { PdfDownloader } from '../src/scrape/pdfDownloader';
import { Store } from '../src/store/persistence';
import { config } from '../src/config';

type Test = { name: string; run: () => void | Promise<void> };
const tests: Test[] = [];
function test(name: string, run: () => void | Promise<void>): void {
  tests.push({ name, run });
}

const fixture = (name: string): Buffer => fs.readFileSync(path.join(__dirname, 'fixtures', name));

// ---------------------------------------------------------------- http utils

test('parseRetryAfter reads the seconds form', () => {
  assert.equal(parseRetryAfter('30'), 30_000);
  assert.equal(parseRetryAfter(' 5 '), 5_000);
});

test('parseRetryAfter reads the HTTP date form', () => {
  const future = new Date(Date.now() + 20_000).toUTCString();
  const value = parseRetryAfter(future);
  assert.ok(value !== null && value > 15_000 && value <= 20_000, `got ${String(value)}`);
});

test('parseRetryAfter returns null for junk', () => {
  assert.equal(parseRetryAfter(undefined), null);
  assert.equal(parseRetryAfter('soon please'), null);
});

test('decodeBody honours the declared charset instead of guessing', () => {
  const latin1 = Buffer.from([0x4c, 0x69, 0x71, 0x75, 0x69, 0x64, 0x61, 0xe7, 0xe3, 0x6f]);
  assert.equal(decodeBody(latin1, 'text/html;charset=ISO-8859-1'), 'Liquidação');
  // The same bytes read as UTF-8 are broken. This is the trap the portal sets:
  // its own meta tag claims UTF-8 while the header says ISO-8859-1.
  assert.ok(decodeBody(latin1, 'text/html;charset=UTF-8').includes('�'));
});

test('parseContentDisposition handles both filename forms', () => {
  assert.equal(parseContentDisposition('filename="Despacho"'), 'Despacho');
  assert.equal(parseContentDisposition('attachment; filename=Inteiro Teor.pdf'), 'Inteiro Teor.pdf');
  assert.equal(parseContentDisposition("attachment; filename*=UTF-8''Decis%C3%A3o"), 'Decisão');
  assert.equal(parseContentDisposition(null), null);
  // Node decodes header bytes as Latin-1, but the portal writes UTF-8 into the
  // header. Simulate that round trip and check the repair pass undoes it.
  const asNodeSeesIt = Buffer.from('filename="Inspeção"', 'utf8').toString('latin1');
  assert.equal(parseContentDisposition(asNodeSeesIt), 'Inspeção');
});

test('the rate limiter keeps a minimum gap between request starts', async () => {
  const limiter = new RateLimiter(1, 40, 0);
  const stamps: number[] = [];
  await Promise.all(
    [0, 1, 2].map(() =>
      limiter.run(async () => {
        stamps.push(Date.now());
      }),
    ),
  );
  stamps.sort((a, b) => a - b);
  assert.ok((stamps[1] ?? 0) - (stamps[0] ?? 0) >= 35, 'second start came too early');
  assert.ok((stamps[2] ?? 0) - (stamps[1] ?? 0) >= 35, 'third start came too early');
});

test('two workers still respect the minimum gap between request starts', async () => {
  // The naive version of this gate reads lastStart, computes a target and only
  // then writes it back, so two callers pick the SAME target and start together.
  // The slot must be reserved before the wait.
  const limiter = new RateLimiter(2, 40, 0);
  const stamps: number[] = [];
  await Promise.all(
    [0, 1, 2, 3].map(() =>
      limiter.run(async () => {
        stamps.push(Date.now());
      }),
    ),
  );
  stamps.sort((a, b) => a - b);
  for (let index = 1; index < stamps.length; index += 1) {
    const gap = (stamps[index] ?? 0) - (stamps[index - 1] ?? 0);
    assert.ok(gap >= 30, `starts ${index - 1} and ${index} were only ${gap} ms apart`);
  }
});

test('a global pause blocks every waiter', async () => {
  const limiter = new RateLimiter(2, 0, 0);
  const started = Date.now();
  limiter.pause(60);
  await limiter.run(async () => undefined);
  assert.ok(Date.now() - started >= 55, 'the pause was not honoured');
});

// -------------------------------------------------------------- 429 handling

/** A stub that answers 429 a fixed number of times and then succeeds. */
function stubServer(
  plan: Array<{ status: number; headers?: Record<string, string>; body?: string | Buffer }>,
): Promise<{ url: string; hits: number[]; close: () => Promise<void> }> {
  const hits: number[] = [];
  let index = 0;
  const server = http.createServer((request, response) => {
    void request;
    const step = plan[Math.min(index, plan.length - 1)];
    index += 1;
    hits.push(Date.now());
    response.writeHead(step?.status ?? 200, step?.headers ?? {});
    response.end(step?.body ?? 'ok');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        hits,
        close: () =>
          new Promise<void>((done) => {
            // The client sends `Connection: keep-alive`, so an open socket would
            // keep `close` pending forever. Drop them first.
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

test('a 429 is retried with backoff and the request eventually succeeds', async () => {
  const stub = await stubServer([
    { status: 429, headers: { 'retry-after': '0' } },
    { status: 429, headers: { 'retry-after': '0' } },
    { status: 200, headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: 'recovered' },
  ]);
  try {
    const client = new HttpClient();
    const response = await client.requestText(stub.url, { label: 'stub' });
    assert.equal(response.status, 200);
    assert.equal(response.text, 'recovered');
    assert.equal(stub.hits.length, 3, 'the client should have made three attempts');
    assert.equal(client.stats.rateLimited, 2);
    assert.equal(client.stats.retries, 2);
  } finally {
    await stub.close();
  }
});

test('the backoff window doubles per attempt and is capped', () => {
  // test/env.ts sets BACKOFF_BASE_MS=10 and BACKOFF_MAX_MS=40.
  assert.equal(backoffWindow(1), 10);
  assert.equal(backoffWindow(2), 20);
  assert.equal(backoffWindow(3), 40);
  assert.equal(backoffWindow(4), 40, 'the window must stop at the cap');
  assert.equal(backoffWindow(10), 40);
});

test('the backoff wait is a full jitter draw from inside its own window', () => {
  // Drive the randomness rather than sampling it, so the policy is pinned
  // exactly rather than checked against a loose bound.
  assert.equal(backoffWait(3, null, () => 0), 0, 'the draw must be able to reach zero');
  assert.equal(backoffWait(3, null, () => 0.999), 39, 'the draw must stay under the window');
  assert.equal(backoffWait(1, null, () => 0.5), 5);
  assert.equal(backoffWait(2, null, () => 0.5), 10, 'attempt 2 draws from twice the window');
});

test('Retry-After beats the computed backoff when it is longer, and loses when shorter', () => {
  assert.equal(backoffWait(1, 30_000, () => 0.999), 30_000, 'the server named a longer wait');
  assert.equal(backoffWait(3, 5, () => 0.999), 39, 'our own wait was already longer');
});

test('the backoff wait grows between attempts', async () => {
  // BACKOFF_BASE_MS is 10 and the policy uses full jitter, so a single sample
  // proves nothing. Assert the property that always holds: every wait sits
  // inside its own window, and the windows double.
  const stub = await stubServer([
    { status: 429 },
    { status: 429 },
    { status: 429 },
    { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' },
  ]);
  try {
    const client = new HttpClient();
    await client.requestText(stub.url, { label: 'stub' });
    assert.equal(stub.hits.length, 4);
    const gaps = stub.hits.slice(1).map((value, index) => value - (stub.hits[index] ?? value));
    // Windows are 10, 20 and 40 ms. Allow generous slack for timer jitter.
    assert.ok((gaps[0] ?? 0) <= 200, `first gap ${String(gaps[0])} is outside its window`);
    assert.ok((gaps[1] ?? 0) <= 300, `second gap ${String(gaps[1])} is outside its window`);
    assert.ok((gaps[2] ?? 0) <= 400, `third gap ${String(gaps[2])} is outside its window`);
  } finally {
    await stub.close();
  }
});

test('a 429 that never clears throws HttpFailure after the retry budget', async () => {
  const stub = await stubServer([{ status: 429 }]);
  try {
    const client = new HttpClient();
    await assert.rejects(
      () => client.requestText(stub.url, { label: 'stub' }),
      (error: unknown) => {
        assert.ok(error instanceof HttpFailure);
        assert.equal(error.status, 429);
        assert.ok(error.retryable);
        return true;
      },
    );
    // MAX_RETRIES is 3, so four attempts in total.
    assert.equal(stub.hits.length, 4);
  } finally {
    await stub.close();
  }
});

test('a redirect loop is refused instead of recursing forever', async () => {
  // Every hop answers 302 back to itself. Without a hop limit each redirect
  // restarts the retry budget, so the request never ends.
  const stub = await stubServer([{ status: 302, headers: { location: '/again' } }]);
  try {
    const client = new HttpClient();
    await assert.rejects(
      () => client.requestText(stub.url, { label: 'stub' }),
      (error: unknown) => {
        assert.ok(error instanceof HttpFailure);
        assert.match(error.message, /redirect loop/);
        return true;
      },
    );
    assert.ok(stub.hits.length <= 7, `followed ${stub.hits.length} hops, expected a small cap`);
  } finally {
    await stub.close();
  }
});

test('a 404 is not retried, because repeating it cannot change the answer', async () => {
  const stub = await stubServer([{ status: 404 }]);
  try {
    const client = new HttpClient();
    await assert.rejects(() => client.requestText(stub.url, { label: 'stub' }));
    assert.equal(stub.hits.length, 1, 'a 404 must be fatal on the first attempt');
  } finally {
    await stub.close();
  }
});

test('a 503 is retried like a 429', async () => {
  const stub = await stubServer([
    { status: 503 },
    { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' },
  ]);
  try {
    const client = new HttpClient();
    const response = await client.requestText(stub.url, { label: 'stub' });
    assert.equal(response.status, 200);
    assert.equal(stub.hits.length, 2);
  } finally {
    await stub.close();
  }
});

test('a download that answers HTML instead of a PDF is refused, not written to disk', async () => {
  const stub = await stubServer([
    { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>login</html>' },
  ]);
  try {
    const client = new HttpClient();
    const downloader = new PdfDownloader(client);
    const outcome = await downloader.download(
      '0000000-00.0000.0.00.0000',
      {
        idProcessoDocumento: '1',
        idBin: '2',
        numeroDocumento: 'abc',
        nomeArquivo: 'Despacho',
        rotulo: '01/01/2026 10:00:00 - Despacho (Despacho)',
        data: '01/01/2026 10:00:00',
        tipo: 'Despacho',
        tamanhoTexto: null,
        formato: 'pdf',
        downloadUrl: stub.url,
        htmlViewUrl: null,
      },
      0,
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.skipped, false);
    assert.match(outcome.error ?? '', /expected a PDF/);
  } finally {
    await stub.close();
  }
});

// ------------------------------------------------------------------ JSF layer

test('the a4j parameter id is read out of the inline script, never hard coded', () => {
  const script =
    "executarPesquisa=function(){A4J.AJAX.Submit('fPP',null,{'similarityGroupingId':'fPP:j_id244'," +
    "'actionUrl':'/x','parameters':{'fPP:j_id244':'fPP:j_id244'} } )};";
  assert.equal(extractJsFunctionId(script, 'executarPesquisa'), 'fPP:j_id244');
  assert.throws(() => extractJsFunctionId(script, 'naoExiste'));
});

test('the captcha guard is read, so the scraper stops if the portal turns it on', () => {
  const off = 'function executarReCaptcha() { if (false) { grecaptcha.execute(); return false; } }';
  const on = 'function executarReCaptcha() { if (true) { grecaptcha.execute(); return false; } }';
  assert.doesNotThrow(() => assertCaptchaDisabled(off));
  assert.throws(() => assertCaptchaDisabled(on), /reCAPTCHA/);
});

test('the ajax envelope yields the refreshed view state and the updated ids', () => {
  const body = fixture('search-response.xml').toString('utf8');
  const envelope = parseAjaxResponse(body);
  assert.equal(envelope.isAjax, true);
  assert.deepEqual(envelope.updateIds, ['fPP:processosGridPanel']);
  assert.equal(envelope.viewState, 'j_id1');
});

// ------------------------------------------------------------------- parsers

test('the result grid parses into typed rows', () => {
  const envelope = parseAjaxResponse(fixture('search-response.xml').toString('utf8'));
  const result = parseSearchResults(envelope, { dataInicio: '01/08/2026', dataFim: '05/08/2026' });

  assert.equal(result.rows.length, 2);
  const first = result.rows[0];
  assert.ok(first !== undefined);
  assert.equal(first.numeroProcesso, '0006388-48.1986.4.05.8401');
  assert.equal(first.internalId, '127362');
  assert.equal(first.ca, 'fb64232b07e45ec42c8d5096cb3a4322f3d19a12e7c30f6e');
  assert.equal(first.classeJudicial, 'APELAÇÃO CÍVEL');
  assert.match(first.detailUrl, /DetalheProcessoConsultaPublica\/listView\.seam\?ca=/);
  assert.match(first.partesResumo, /^ESTADO DO RIO GRANDE DO NORTE X /);
  assert.match(first.ultimaMovimentacao, /^Juntada de Certidão \(24\/08\/2026/);
});

test('the 30 row cap is detected and reported as truncated', () => {
  const envelope = parseAjaxResponse(fixture('search-response.xml').toString('utf8'));
  const result = parseSearchResults(envelope, {});
  assert.equal(result.truncated, true, 'the fixture carries the cap banner');
  assert.equal(result.totalLabel, 30);
});

test('a validation message is surfaced instead of being read as zero results', () => {
  const body =
    '<html><body><dl class="rich-messages"><dt><span class="rich-messages-label">' +
    'Pelo menos um dos critérios de pesquisa deve ser informado.</span></dt></dl>' +
    '<table id="fPP:processosTable"><tbody id="fPP:processosTable:tb"></tbody></table></body></html>';
  const result = parseSearchResults(parseAjaxResponse(body), {});
  assert.equal(result.rows.length, 0);
  assert.match(result.validationMessage ?? '', /Pelo menos um dos crit/);
});

test('the detail page yields case data, parties, movements and documents', () => {
  // The fixture is ISO-8859-1, exactly as the portal serves it.
  const html = decodeBody(fixture('detail.html'), 'text/html;charset=ISO-8859-1');
  const detail = parseProcessDetail(html, 'fb64232b', 'https://example.invalid/detail');

  assert.equal(detail.numeroProcesso, '0006388-48.1986.4.05.8401');
  assert.equal(detail.classeJudicial, 'APELAÇÃO CÍVEL (198)');
  assert.equal(detail.dataDistribuicao, '19/08/2026');
  assert.equal(detail.jurisdicao, 'TRF5');
  assert.equal(detail.orgaoJulgadorColegiado, '2ª Turma');
  assert.match(detail.orgaoJulgador ?? '', /Gab 7/);
  // Accented text survived the ISO-8859-1 decode. This is the assertion that
  // fails first if the charset handling regresses.
  assert.match(detail.assunto ?? '', /Liquidação \/ Cumprimento \/ Execução/);

  const ativo = detail.partes.filter((party) => party.polo === 'ativo');
  assert.equal(ativo.length, 1);
  assert.equal(ativo[0]?.documento, '08.241.739/0001-05');
  assert.equal(ativo[0]?.papel, 'APELANTE');
  assert.equal(ativo[0]?.situacao, 'Ativo');
  assert.equal(ativo[0]?.representantes.length, 1);

  assert.ok(detail.partes.some((party) => party.polo === 'passivo'));
  assert.ok(detail.partes.some((party) => party.polo === 'outros'));

  assert.ok(detail.movimentacoes.length >= 10, `got ${detail.movimentacoes.length} movements`);
  assert.equal(detail.movimentacoes[0]?.data, '24/08/2026 14:46:39');
  assert.equal(detail.movimentacoes[0]?.descricao, 'Juntada de Certidão');

  assert.ok(detail.documentos.length >= 12, `got ${detail.documentos.length} documents`);
  const pdfs = detail.documentos.filter((document) => document.formato === 'pdf');
  assert.ok(pdfs.length > 0);
  assert.match(pdfs[0]?.downloadUrl ?? '', /idBin=\d+/);
  assert.match(pdfs[0]?.downloadUrl ?? '', /setDownloadInstance/);

  // Rows that only offer the login gated HTML view are recorded, not faked.
  const htmlOnly = detail.documentos.filter((document) => document.formato === 'html');
  for (const document of htmlOnly) {
    assert.equal(document.downloadUrl, null);
    assert.match(document.htmlViewUrl ?? '', /documentoSemLoginHTML\.seam/);
  }
});

test('screen reader text is stripped from a document label', () => {
  // An html only row wraps its label after a visually hidden span. Left in, the
  // label reads "Visualizar documentos16/06/2026 ..." and the timestamp is lost.
  const html =
    '<html><body><table id="x:processoDocumentoGridTab"><tbody id="x:processoDocumentoGridTab:tb">' +
    '<tr><td><a href="#" onclick="openPopUp(\'p\', ' +
    '\'/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/documentoSemLoginHTML.seam' +
    '?ca=abc&idProcessoDoc=555\')" title="Sentença">' +
    '<i class="fa"></i> <span class="sr-only">Visualizar documentos</span>' +
    '16/06/2026 13:13:06 - Sentença (Sentença)</a></td><td></td></tr>' +
    '</tbody></table></body></html>';
  const detail = parseProcessDetail(html, 'abc', 'https://example.invalid/detail');
  assert.equal(detail.documentos.length, 1);
  const document = detail.documentos[0];
  assert.equal(document?.rotulo, '16/06/2026 13:13:06 - Sentença (Sentença)');
  assert.equal(document?.data, '16/06/2026 13:13:06');
  assert.equal(document?.tipo, 'Sentença');
  assert.equal(document?.formato, 'html');
  assert.equal(document?.downloadUrl, null);
  assert.equal(document?.idProcessoDocumento, '555');
});

test('a Latin-1 percent escape in the query string decodes to the right character', () => {
  const url = 'https://x/listView.seam?nomeArqProcDocBin=Decis%E3o&idProcessoDocumento=99';
  assert.equal(queryParam(url, 'nomeArqProcDocBin'), 'Decisão');
  assert.equal(queryParam(url, 'idProcessoDocumento'), '99');
  // A genuine UTF-8 escape still decodes as UTF-8.
  assert.equal(queryParam('https://x/?n=Decis%C3%A3o', 'n'), 'Decisão');
  assert.equal(queryParam('https://x/?n=Inteiro+Teor', 'n'), 'Inteiro Teor');
  assert.equal(queryParam('https://x/no-query', 'n'), null);
});

test('slugify strips accents and keeps a filename safe', () => {
  assert.equal(slugify('Decisão'), 'decisao');
  assert.equal(slugify('Inteiro Teor (Acórdão)'), 'inteiro-teor-acordao');
  assert.equal(slugify('///'), 'documento');
});

test('the PDF path is descriptive, chronologically sortable and collision free', () => {
  const downloader = new PdfDownloader(new HttpClient());
  const relative = downloader.relativePath(
    '0006388-48.1986.4.05.8401',
    {
      idProcessoDocumento: '11863852',
      idBin: '11651902',
      numeroDocumento: 'abc',
      nomeArquivo: 'Despacho',
      rotulo: '13/08/2025 12:24:21 - Despacho (Despacho)',
      data: '13/08/2025 12:24:21',
      tipo: 'Despacho',
      tamanhoTexto: '4,62 Kb',
      formato: 'pdf',
      downloadUrl: 'https://example.invalid',
      htmlViewUrl: null,
    },
    2,
  );
  assert.equal(
    relative,
    path.join('0006388-48-1986-4-05-8401', '0003_2025-08-13_despacho_11863852.pdf'),
  );
});

// ------------------------------------------------------------------- planner

test('dates round trip through the UTC helpers', () => {
  assert.equal(formatDate(parseDate('01/08/2026')), '01/08/2026');
  assert.equal(formatDate(parseDate('31/12/1999')), '31/12/1999');
  assert.throws(() => parseDate('2026-08-01'));
});

test('a date window bisects until it is a single day', () => {
  assert.deepEqual(splitRange('01/08/2026', '04/08/2026'), [
    ['01/08/2026', '02/08/2026'],
    ['03/08/2026', '04/08/2026'],
  ]);
  assert.deepEqual(splitRange('01/08/2026', '02/08/2026'), [
    ['01/08/2026', '01/08/2026'],
    ['02/08/2026', '02/08/2026'],
  ]);
  assert.equal(splitRange('01/08/2026', '01/08/2026'), null);
});

test('the planner subdivides by date first and by case class second', () => {
  const classes = [
    { codigo: '1', nome: 'A' },
    { codigo: '2', nome: 'B' },
  ];
  const planner = new Planner({ dataInicio: '01/08/2026', dataFim: '02/08/2026', classes });

  const root = planner.next();
  assert.ok(root !== undefined);
  assert.equal(planner.subdivide(root), true);
  assert.equal(planner.pending, 2, 'the date window should split in two');

  const firstDay = planner.next();
  assert.ok(firstDay !== undefined);
  assert.equal(firstDay.criteria.dataInicio, '01/08/2026');
  assert.equal(firstDay.criteria.dataFim, '01/08/2026');

  // A single day cannot split again, so the next axis is the class catalogue.
  assert.equal(planner.subdivide(firstDay), true);
  const byClass = planner.next();
  assert.equal(byClass?.criteria.classeJudicial, 'A');

  // One class on one day is the end of the road.
  assert.equal(planner.subdivide(byClass!), false);
});

test('an impossible date is rejected instead of rolling over to another day', () => {
  // Date.UTC(2026, 1, 31) does not fail, it becomes 3 March. A typo in a date
  // flag would then search the wrong window and look like it worked.
  assert.throws(() => parseDate('31/02/2026'), /not a real date/);
  assert.throws(() => parseDate('32/01/2026'), /not a real date/);
  assert.throws(() => parseDate('01/13/2026'), /not a real date/);
  assert.equal(formatDate(parseDate('29/02/2024')), '29/02/2024', 'a real leap day is fine');
  assert.throws(() => parseDate('29/02/2026'), /not a real date/);
});

test('an answer with no result grid is recognised as an expired view', () => {
  // An expired JSF view answers 200 with the entry page. It parses cleanly and
  // has zero rows, which is indistinguishable from an empty result set unless
  // the grid element itself is checked for.
  const expired = parseAjaxResponse('<html><body><div>login</div></body></html>');
  assert.equal(looksLikeExpiredView(expired, RESULT_TABLE_SELECTOR), true);

  // A genuinely empty result set still renders its own table.
  const empty = parseAjaxResponse(
    '<html><body><table id="fPP:processosTable"><tbody id="fPP:processosTable:tb">' +
      '</tbody></table></body></html>',
  );
  assert.equal(looksLikeExpiredView(empty, RESULT_TABLE_SELECTOR), false);
  assert.equal(parseSearchResults(empty, {}).rows.length, 0);
});

test('a field the portal prints but leaves blank is kept, not dropped', () => {
  const html =
    '<html><body>' +
    '<div class="propertyView"><div class="name"><label>Assunto</label></div>' +
    '<div class="value"></div></div>' +
    '<div class="propertyView"><div class="name"><label>Jurisdicao</label></div>' +
    '<div class="value">TRF5</div></div>' +
    '</body></html>';
  const detail = parseProcessDetail(html, 'abc', 'https://example.invalid/detail');
  assert.equal(detail.dadosProcesso['Assunto'], '', 'an empty printed field must survive');
  assert.equal(detail.dadosProcesso['Jurisdicao'], 'TRF5');
  assert.ok(!('Nao existe' in detail.dadosProcesso), 'an absent field must stay absent');
});

test('the planner refuses an empty search, which the portal rejects anyway', () => {
  assert.throws(() => new Planner({}), /at least one search criterion/);
});

test('a cell key is stable whatever order the criteria were written in', () => {
  assert.equal(
    cellKey({ dataFim: '02/08/2026', dataInicio: '01/08/2026' }),
    cellKey({ dataInicio: '01/08/2026', dataFim: '02/08/2026' }),
  );
  assert.equal(cellKey({}), '(empty)');
});

// --------------------------------------------------------------- persistence

test('the failure queue survives a restart and deduplicates by key', async () => {
  // test/env.ts points OUTPUT_DIR at test/.output, so this writes there.
  if (fs.existsSync(config.failuresFile)) fs.rmSync(config.failuresFile);

  const first = new Store();
  await first.load();
  first.recordFailure({
    kind: 'pdf',
    key: 'pdf:123',
    target: 'https://example.invalid/a',
    status: null,
    error: 'boom',
  });
  first.recordFailure({
    kind: 'pdf',
    key: 'pdf:123',
    target: 'https://example.invalid/a',
    status: null,
    error: 'boom again',
  });
  assert.equal(first.failureCount, 1, 'the same key must not queue twice');
  assert.equal(first.listFailures()[0]?.attempts, 2, 'the attempt counter must climb');
  assert.equal(first.listFailures()[0]?.error, 'boom again', 'the latest error must win');

  // A second Store reads the file back from disk. That is what `retry` does.
  const second = new Store();
  await second.load();
  assert.equal(second.failureCount, 1);
  assert.equal(second.listFailures('pdf').length, 1);
  assert.equal(second.listFailures('search').length, 0);

  second.clearFailure('pdf:123');
  assert.equal(second.failureCount, 0);
  assert.equal(fs.readFileSync(config.failuresFile, 'utf8').trim(), '');
});

// ---------------------------------------------------------------------- main

// ---------------------------------------------------------------------------
// The movements pager.
//
// These exist because the first version of the parser declared that a case had
// nothing to page through. It looked for the datascroller that the PARTIES
// panels use. The movements panel pages with a RichFaces Slider labelled
// `pagina` instead, so the scraper kept the first page and dropped the rest,
// and `detail.html` in this very fixtures folder was already a two page case.
// ---------------------------------------------------------------------------

test('the panels are paginated, which the datascroller check missed', () => {
  const html = decodeBody(fixture('detail.html'), 'text/html;charset=ISO-8859-1');

  const pagers = findPanelPagers(html);
  assert.ok(pagers.length > 0, 'a slider must be found');
  assert.equal(pagers[0]?.lastPage, 2);
  assert.equal(pagers[0]?.currentPage, 1);
});

test('EVERY slider is returned, not just the first one', () => {
  // A real detail page carries two: one for the movements panel and one for the
  // documents grid. Returning only the first is how a second page of DOCUMENTS
  // stayed invisible while the case looked complete.
  const html = decodeBody(fixture('detail-two-sliders.html'), 'text/html;charset=ISO-8859-1');
  const pagers = findPanelPagers(html);

  assert.equal(pagers.length, 2);
  // Distinct widgets driving distinct regions.
  assert.notEqual(pagers[0]?.formId, pagers[1]?.formId);
  assert.notEqual(pagers[0]?.containerId, pagers[1]?.containerId);
  // Both are genuinely multi page, so both must be walked.
  assert.ok((pagers[0]?.lastPage ?? 0) > 1);
  assert.ok((pagers[1]?.lastPage ?? 0) > 1);
});

test('every pager id is read off the page, never hard coded', () => {
  const html = decodeBody(fixture('detail.html'), 'text/html;charset=ISO-8859-1');
  const pager = findPanelPagers(html)[0];

  // All four ids are unstable `j_idNNN` values that move when the portal is
  // rebuilt, so each one must come from the markup.
  for (const id of [pager?.formId, pager?.inputId, pager?.triggerId, pager?.containerId]) {
    assert.match(id ?? '', /^j_id\d+/);
    assert.equal(html.includes(id ?? ' '), true);
  }
  assert.equal(pager?.inputId.startsWith(`${pager?.formId}:`), true);
});

test('the reported total is the panel footer, not another panel', () => {
  const html = decodeBody(fixture('detail.html'), 'text/html;charset=ISO-8859-1');
  const pager = findPanelPagers(html)[0];

  // The page prints "resultados encontrados" once per panel and the parties
  // panels come first. Reading the first match yields 1, which would make the
  // completeness check pass while the record is short.
  assert.equal(/1 resultados encontrados/.test(html), true);
  assert.equal(pager?.reportedTotal, 30);
});

test('the first page alone is short of the total the portal reports', () => {
  const html = decodeBody(fixture('detail.html'), 'text/html;charset=ISO-8859-1');
  const detail = parseProcessDetail(html, 'ca', 'https://example.invalid/detail');
  const pager = findPanelPagers(html)[0];

  // This is the defect, pinned. The delivered HTML carries one page; the panel
  // says there are more. A parser that stops here loses the difference.
  assert.equal(detail.movimentacoes.length < (pager?.reportedTotal ?? 0), true);
  assert.equal(detail.movimentacoes.length, 10);
});

test('a page request carries the slider value AND the trigger parameter', () => {
  const html = decodeBody(fixture('detail.html'), 'text/html;charset=ISO-8859-1');
  const pager = findPanelPagers(html)[0];
  assert.notEqual(pager, undefined);
  const form = pageForm(pager!, 2);

  assert.equal(form.get(pager!.inputId), '2');
  // Without the trigger the server answers 200 and re renders nothing, which
  // reads as "page 2 equals page 1" rather than as a failure.
  assert.equal(form.get(pager!.triggerId), pager!.triggerId);
  assert.equal(form.get('AJAXREQUEST'), pager!.containerId);
  assert.equal(form.get('javax.faces.ViewState'), pager!.viewState);
});

test('a page with no slider is complete, a page with an unreadable one is not', () => {
  // These two produce the SAME empty list and mean opposite things. The caller
  // can only tell them apart with hasSlider, so both halves are pinned here.
  const short = '<html><body><input name="javax.faces.ViewState" value="j_id9" /></body></html>';
  assert.deepEqual(findPanelPagers(short), []);
  assert.equal(hasSlider(short), false);

  // A slider whose options this parser cannot read. Silently calling this case
  // "complete" is exactly the data loss this module exists to prevent.
  const broken =
    '<html><body><input name="javax.faces.ViewState" value="j_id9" />' +
    '<script>new Richfaces.Slider("j_id1:j_id2",{\'minValue\':\'1\'} )</script></body></html>';
  assert.deepEqual(findPanelPagers(broken), []);
  assert.equal(hasSlider(broken), true);
});


// ---------------------------------------------------------------------------
// Documents on a paged fragment.
//
// The second half of the same defect. Paging the movements panel recovered the
// MOVEMENTS but still dropped their PDFs, because a paged answer re renders
// `processoEventoPanel` only: the `Documentos juntados` grid is not in it, and
// the document hangs off the movement row's own `Documento` column instead.
// The fixture is a real page 3 answer for case 0002583-95.1997.4.05.8500.
// ---------------------------------------------------------------------------

test('a paged fragment carries no document grid at all', () => {
  const fragment = fixture('movements-page3.xml').toString('utf8');

  // This is why reading only the grid returned nothing.
  assert.equal(fragment.includes('processoDocumentoGridTab'), false);
  assert.equal(/Ajax-Update-Ids" content="[^"]*processoEventoPanel/.test(fragment), true);
  // And this is what was there to be found.
  assert.equal(fragment.includes('idBin=7893113'), true);
});

test('a document attached to a movement on a later page is still found', () => {
  const fragment = fixture('movements-page3.xml').toString('utf8');
  const documents = readDocuments(parseAjaxResponse(fragment).$);

  assert.equal(documents.length, 1);
  const [document] = documents;
  assert.equal(document?.idBin, '7893113');
  assert.equal(document?.formato, 'pdf');
  assert.equal(typeof document?.downloadUrl, 'string');
  // The anchor is a bare icon, so the label falls back to the row text. That
  // row still carries the timestamp and the type, so the record is not poorer
  // than one taken from the grid.
  assert.equal(document?.data, '03/09/2023 21:01:12');
  assert.equal(document?.tipo, 'Decisão');
  // Latin-1 percent escape in the query string, decoded correctly.
  assert.equal(document?.nomeArquivo, 'Decisão');
});

async function main(): Promise<void> {
  let passed = 0;
  const failed: Array<{ name: string; error: Error }> = [];

  for (const item of tests) {
    try {
      await item.run();
      passed += 1;
      process.stdout.write(`  ok   ${item.name}\n`);
    } catch (error) {
      failed.push({ name: item.name, error: error as Error });
      process.stdout.write(`  FAIL ${item.name}\n`);
    }
  }

  process.stdout.write(`\n${passed} passed, ${failed.length} failed\n`);
  for (const item of failed) {
    process.stdout.write(`\n--- ${item.name}\n${item.error.stack ?? item.error.message}\n`);
  }
  // axios keeps sockets warm, so ask for an explicit exit rather than waiting
  // for the event loop to drain.
  process.exit(failed.length > 0 ? 1 : 0);
}

void main();
