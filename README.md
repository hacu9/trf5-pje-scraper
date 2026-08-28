# TRF5 PJe public records scraper

A TypeScript scraper for the public case consultation portal of the Tribunal
Regional Federal da 5ª Região.

Target: `https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam`

It walks the search space by adaptive subdivision, extracts every field the
portal publishes for each case, downloads the associated PDFs, and handles HTTP
429 with exponential backoff and a persistent retry queue.

One honest caveat up front: the portal truncates EVERY result set at thirty rows
and offers no pagination, so exhaustive coverage of the archive is not reachable
through this form. The scraper subdivides until each slice fits under that cap,
names the slices where it runs out of ways to subdivide, and warns about them.
The detail is in the sections below and in Limitations.

**No browser automation.** No Puppeteer, no Playwright, no Selenium, no
WebDriver. The whole thing is axios plus cheerio.

## Quick start

```bash
npm install
npm run build

# 1. Prove the session works and see what the scraper discovered about the form.
node dist/index.js probe

# 2. Cache the case class catalogue. The crawler needs it to subdivide a
#    search that the server truncated.
node dist/index.js classes

# 3. A small test run: two cases, two PDFs each.
node dist/index.js crawl --parte "GERALDA PEREIRA" --max-processes 2 --max-pdfs-per-process 2

# 4. Turn the output into CSV.
node dist/index.js export

# 5. Prove the whole path still works against the live portal.
npm run test:e2e
```

Output lands in `data/`. Run `node dist/index.js help` for the full flag list.

During development you can skip the build step: `npm run dev -- crawl --parte "..."`
runs the TypeScript directly through `tsx`.

Requires Node 18 or newer.

## What this site actually is, and why that matters

The brief for this exercise predicted JSF 2: `Faces-Request: partial/ajax`,
`javax.faces.partial.ajax`, a `<partial-response>` XML document, and a
`javax.faces.ViewState` that rolls after every postback.

That is not what is there. The portal runs **PJe 2.11.2.0-26 on JBoss Seam,
JSF 1.2 and RichFaces 3.3.3**, which is an older protocol:

* The ajax request is an ordinary form POST with one extra field,
  `AJAXREQUEST=_viewRoot`. There are no `javax.faces.partial.*` parameters and
  no `Faces-Request` header.
* The answer carries `ajax-response: true` and `content-type: text/xml`, but the
  body is an XHTML fragment, not a `<partial-response>`. cheerio parses it
  directly.
* The refreshed view state arrives inside `<span id="ajax-view-state">`, and the
  re rendered regions are named by `<meta name="Ajax-Update-Ids">`.
* `javax.faces.ViewState` is a server side token, `j_id1` on the search view and
  `j_id2` on the detail view. It does not roll on every postback here, but the
  scraper reads it back from every answer anyway, because relying on it being
  constant would be relying on an implementation detail.

Everything in this section was verified against the live site. The full
transcript of the investigation, with the request and response evidence for each
claim, is in [`docs/RECON.md`](docs/RECON.md).

## The six things that make this site hard

### 1. The submit button is not the submit

`fPP:searchProcessos` is a `type="button"`. Its onclick calls
`executarReCaptcha()`, which calls `executarPesquisa()`, and THAT is an
`a4j:jsFunction` whose generated id is the parameter the server dispatches on.
In the observed render it was `fPP:j_id244`.

The `j_idNNN` part is a JSF component index. It changes whenever the page
template changes, so hard coding it would produce a scraper that breaks silently
on the next deploy and returns zero rows forever. The scraper reads the id out
of the inline script at run time, and resolves every form field by its stable
suffix (`nomeParte`, `classeJudicial`, `dataAutuacaoInicioInputDate`) rather than
by its full generated name.

### 2. The reCAPTCHA is dead code, and the scraper checks that it still is

The page loads `https://www.google.com/recaptcha/api.js`, so it looks protected.
The trigger, verbatim from the served HTML, is:

```js
function executarReCaptcha() {
    if (false) {
        grecaptcha.execute();
        return false;
    }
    executarPesquisa();
}
```

The server renders the guard as the literal `false`. No token is produced and
none is expected. Verified: a search POST with no captcha field returns results.

`assertCaptchaDisabled` re reads that guard on every session load. If the court
ever flips the flag to `true`, the scraper stops with a clear error instead of
posting nonsense for hours and writing empty result files.

### 3. The form is STATEFUL, so every field goes in every POST

This one cost real debugging time. A POST that omitted the empty text inputs
came back with rows belonging to the PREVIOUS search.

JSF 1.2 only calls `setSubmittedValue` for inputs that are present in the
request. Any input left out keeps whatever value the backing bean already held.
A partial POST therefore does not mean "no filter", it means "reuse the last
filter", and the results look plausible while being wrong.

So `SearchView.buildPayload` snapshots every field the rendered form carries,
clears every user facing criterion, and only then applies the current search.
Empty strings are posted explicitly.

### 4. The result grid does not paginate. The server truncates at 30 rows.

This is the finding that shapes the whole design.

Above thirty matches the server prints

> Sua consulta retornou muitos processos e somente os 30 primeiros serão
> exibidos. Por favor, refine sua pesquisa.

and returns exactly thirty rows. The RichFaces datascroller in the table footer
renders EMPTY. Verified at 1, 2, 5, 8, 9, 18, 22 and 30 rows: a second page
never appears, and a result set of 22 on one page proves the page size is larger
than the cap. There is no next page postback to drive.

The detail page DOES paginate, and the widget is easy to miss. See finding 5.

### 5. The detail page paginates with sliders, and there are TWO of them.

This one was wrong twice in this scraper, and both times it cost data. It is the
most expensive thing on this page to get wrong, so it is written out in full.

The parties panels page with a RichFaces datascroller. The movements panel and
the documents grid do NOT. They have no `<tfoot>` and no scroller, so a parser
that looks for one concludes they are complete. They are not. They page with a
RichFaces *Slider* labelled `pagina`, printed inline on the page:

    new Richfaces.Slider("j_id146:j_id561:j_id562",
      {'minValue':'1','maxValue':'5','sliderValue':'1', ... })

A real detail page carries two of these, and they look alike. Both are labelled
`pagina`, both drive an A4J postback, and only the region tells them apart:

| slider              | region            | panel               |
| :------------------ | :---------------- | :------------------ |
| `j_id146:j_id561:*` | `j_id146:j_id474` | Movimentacoes       |
| `j_id146:j_id653:*` | `j_id146:j_id569` | Documentos juntados |

Case `0001223-51.1994.4.05.8300` measures the cost of each mistake:

| what is read                  | movements | documents |
| :---------------------------- | --------: | --------: |
| the delivered HTML alone      |        15 |        15 |
| movements slider only         |        65 |        15 |
| both sliders, what ships now  |        65 |        23 |

The first row loses 77% of the record. The second row still loses eight
downloadable PDFs, and it looks completely healthy while doing it, because the
movements panel reconciles perfectly against its own footer. That is why the
completeness check is now per panel and compares against the footer of THAT
panel: a check that only watches movements cannot see the documents grid lie.

`test/fixtures/detail.html`, captured before any of this was found, is itself a
two page case: 10 movements delivered against a footer reading 30.

Driving one slider needs four ids, every one an unstable `j_idNNN`, so all four
are read off the page:

| role           | example                   | source                      |
| -------------- | ------------------------- | --------------------------- |
| slider input   | `j_id146:j_id561:j_id562` | the `Slider` constructor    |
| enclosing form | `j_id146:j_id561`         | `A4J.AJAX.Submit` argument 1 |
| trigger param  | `j_id146:j_id561:j_id563` | the `parameters` map        |
| ajax region    | `j_id146:j_id474`         | `containerId`               |

The trigger parameter is the part that is easy to drop. Posting the slider value
alone returns 200 with the region unchanged, which reads as "page 2 is the same
as page 1" rather than as a failure. `src/scrape/panelPager.ts` holds this.

**Completeness is never assumed.** Three separate things mark a case partial
rather than letting it pass for whole: a page request that failed, a panel whose
final count does not equal the total its own footer prints, and a page that
carries a slider this parser could not read. That last one matters because "no
slider found" and "slider found but unparseable" are the same empty result and
mean opposite things, so `hasSlider` separates them.

**So the scraper paginates by subdividing the query.** `src/scrape/planner.ts`
keeps a queue of cells, where a cell is a set of search criteria. When a cell
comes back truncated it is replaced by its children:

1. If the cell covers more than one filing day, the date window is cut in half.
   Binary subdivision, so a busy month costs about log2(days) extra searches
   instead of one search per day.
2. Otherwise, if the cell carries no case class, it fans out across the 132
   entries of the class catalogue, keeping the same single day.
3. Otherwise the cell is **saturated**: one class on one day still overflows.
   The portal offers no third axis that partitions cleanly, so the cell is
   written to `state.json` under `saturatedCells`, the run prints a warning, and
   coverage inside that cell is knowingly incomplete.

That third case is real, not theoretical. `AGRAVO DE INSTRUMENTO` filed on
25/08/2026 returns the cap and cannot be cut further. A scraper that quietly
dropped those rows would be worse than one that names the slice it could not
finish.

The class catalogue itself comes from a quirk: the RichFaces suggestion box
behind `Classe judicial` ignores the typed prefix and answers with the whole
list, so one postback yields all 132 entries.

### 6. The character encoding is wrong in three different ways

* `listView.seam` answers `text/html;charset=ISO-8859-1` while its own embedded
  `<meta http-equiv>` claims UTF-8. The meta tag is lying. The scraper trusts the
  HTTP header and decodes with iconv-lite.
* The ajax postbacks answer UTF-8. Same code path, different charset, decided per
  response.
* Query parameters in the document links are percent encoded ISO-8859-1.
  `nomeArqProcDocBin=Decis%E3o` decodes to `Decis�o` through the standard
  `URLSearchParams`, because that API always assumes UTF-8. `queryParam` in
  `detailParser.ts` percent decodes to raw bytes first, tries UTF-8, and falls
  back to Latin-1 when UTF-8 produced a replacement character.

There is a fourth encoding problem that CANNOT be fixed on this side. The
portal's own `content-disposition` header is lossy. Raw bytes captured from the
wire:

```
content-disposition: filename="Despacho Inspe??o - 1774 - INSPE??O 2024 - 11? VARA FEDERAL/AL"
                                             fdfd                    fdfd        fd
```

Every non ASCII character has already been replaced by the single byte `0xFD`
before the header left the server. The information is gone. That is why the
saved filename is built from `nomeArqProcDocBin`, which survives intact, and the
header value is only ever logged.

## How the PDFs are fetched

A document row carries a real href, not a postback:

```
GET /pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam
    ?idBin=11651902
    &numeroDocumento=5abe939d72b1862284d4eb1566a3847dd743377d
    &nomeArqProcDocBin=Despacho
    &idProcessoDocumento=11863852
    &actionMethod=...processoDocumentoBinHome.setDownloadInstance%28row%29

302 Location: /pjeconsulta/download.seam?cid=<conversationId>
200 content-type: application/pdf
```

The `cid` is a fresh Seam conversation minted by the first hop, so the two hops
belong together and the redirect has to be followed inside the same cookie jar.
Verified that the pair works from a completely fresh jar that never loaded the
detail page, so no warm up request is needed.

Downloaded files are named:

```
data/pdfs/<case number>/<sequence>_<yyyy-MM-dd>_<document type>_<document id>.pdf
```

for example

```
data/pdfs/0800714-60-2021-4-05-8003/0001_2025-05-30_despacho_12295859.pdf
```

One directory per case keeps a large run navigable, the reordered date makes a
plain sort chronological, and the PJe document id on the end is the only part
guaranteed unique, so the name is both descriptive and collision free.

A body that is not a PDF is REFUSED rather than written. If the session ever
bounces to the login view, a `.pdf` file full of HTML would poison the resume
logic, which treats an existing non empty file as done.

## Rate limiting, retries and backoff

### The policy

Retryable: HTTP 429, 408, 425 and any 5xx, plus the transport errors
`ECONNRESET`, `ETIMEDOUT`, `ECONNABORTED`, `EAI_AGAIN`, `EPIPE`, `ENOTFOUND`,
`ECONNREFUSED`, `EHOSTUNREACH` and `ENETUNREACH`.

Not retryable: everything else. A 404 fails on the first attempt, because
repeating it cannot change the answer.

The wait before attempt `n`, counting from 1:

```
window = min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_MAX_MS)
wait   = random(0, window)
```

With the defaults that is windows of 2s, 4s, 8s, 16s and 32s, capped at 120s.

This is **full jitter**, meaning the wait is a uniform draw from the whole
window rather than the window plus a small wobble. The reason is retry
synchronisation: if several workers are throttled by the same event and all use
the same deterministic backoff, they come back at the same instant and rebuild
the exact burst that caused the throttle. Drawing from the whole window spreads
them out.

A `Retry-After` header overrides the computed wait whenever it is larger. Both
the seconds form and the HTTP date form are parsed.

### The shared cool down

Backoff alone is per request. Three consecutive 429 answers means the server is
telling the whole client to stop, not this one request. So after
`COOLDOWN_AFTER` consecutive 429 answers the rate limiter pauses EVERY request,
including the ones already queued, for `COOLDOWN_MS`. Without it a second worker
walks straight into the same wall while the first one is politely waiting.

### The failure queue

When the retry budget is spent, the unit of work is written to
`data/failures.jsonl` with enough context to replay it, and the crawler moves
straight on to the next document. Three kinds are recorded:

| kind | key | replayed by |
| :--- | :--- | :--- |
| `search` | `search:<criteria>` | rerunning the search and harvesting its rows |
| `detail` | `detail:<ca token>` | refetching the detail page from the stored row |
| `pdf` | `pdf:<document id>` | refetching the PDF from the stored document |

The queue is keyed, so the same unit never appears twice. Each new attempt bumps
an `attempts` counter and updates `lastAttemptAt`.

```bash
node dist/index.js retry
```

replays the file. A unit that succeeds is removed from it. A unit that fails
again stays, with its counter raised.

### Being polite

Defaults: one request in flight, 1500 ms between request starts plus up to
500 ms of jitter, and a User Agent that identifies the client. This is a public
government service. The delay is a floor on request STARTS, so a slow response
never lets the next request begin early.

## Resuming a long run

The run is designed to be killed and restarted.

* `state.json` records finished plan cells, the identity of every case already
  scraped, and the document ids whose PDFs are on disk. It is written through a
  temporary file and a rename, so a kill never leaves it half written.
* The checkpoint happens the moment a case is appended, BEFORE its PDFs are
  fetched. Downloading a case's documents takes far longer than parsing it, so
  that window is where a kill is most likely to land. Saving afterwards would
  make the next run append the same case a second time.
* `processes.jsonl` and `documents.jsonl` are append only. An interrupted run
  leaves files that are still readable line by line.
* A PDF is written to `.part` first and renamed, so a half file is never mistaken
  for a finished one.

A cell is marked finished only when EVERY row in it was handled. A cell that a
budget flag cut short stays open, so the next run picks up the rows it never
reached. A case is recognised by its `ca` token AND by its case number, so a
case is never scraped twice even if the token were to change.

One deliberate exception: a cell that was SUBDIVIDED is not marked finished. On
resume its search runs again, because rerunning it is what regenerates the child
cells. That costs one postback per subdivided cell and keeps the resume logic
honest.

## Output

```
data/
  processes.jsonl        one JSON object per case
  documents.jsonl        one JSON object per document
  downloads.jsonl        one line per PDF written to disk
  failures.jsonl         the retry queue
  state.json             resume state, including saturatedCells
  judicial-classes.json  the 132 entry case class catalogue
  processes.csv          written by `export`
  documents.csv          written by `export`, with the local PDF path joined in
  scraper.log            the full run log
  pdfs/<case>/....pdf
```

`documents.jsonl` deliberately does NOT carry the local file path. A document's
metadata is written the moment the detail page is parsed and its PDF arrives
seconds later or never. Holding the metadata back until the bytes land would
lose both if the run were killed in between, so the path lives in
`downloads.jsonl` and the `export` command joins the two.

### What is extracted per case

Case: number, filing date, case class, subject, jurisdiction, panel, judge,
address, reference case, and a raw label to value map of everything else the
`Dados do Processo` panel prints.

Parties: name, CPF or CNPJ, role, situation and listed representatives, for all
three panels (`Polo ativo`, `Polo Passivo`, `Outros interessados`).

Movements: timestamp, description, and the linked document when there is one.

Documents: PJe document id, binary id, content hash, stored filename, printed
label, timestamp, type, advertised size, and the download URL.

## Configuration

Every setting is an environment variable with a conservative default.

| variable | default | meaning |
| :--- | :--- | :--- |
| `BASE_URL` | `https://pjett.trf5.jus.br` | portal origin |
| `USER_AGENT` | identifying string | sent on every request |
| `REQUEST_DELAY_MS` | `1500` | minimum gap between request starts |
| `REQUEST_JITTER_MS` | `500` | random extra gap |
| `CONCURRENCY` | `1` | requests in flight. Keep at 1 or 2. |
| `REQUEST_TIMEOUT_MS` | `45000` | socket timeout |
| `MAX_RETRIES` | `5` | retries before a unit is recorded as failed |
| `BACKOFF_BASE_MS` | `2000` | first backoff window |
| `BACKOFF_MAX_MS` | `120000` | largest backoff window |
| `COOLDOWN_AFTER` | `3` | consecutive 429 answers that trigger a global pause |
| `COOLDOWN_MS` | `60000` | length of that pause |
| `OUTPUT_DIR` | `data` | where everything is written |
| `SKIP_EXISTING_PDFS` | `true` | do not refetch a PDF already on disk |
| `MAX_PDF_BYTES` | `104857600` | refuse a body larger than this |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

## Commands

| command | what it does |
| :--- | :--- |
| `probe` | load the search view and print the discovered component ids, then run one test search |
| `classes` | fetch and cache the case class catalogue |
| `crawl` | search, extract every case, download the PDFs |
| `retry` | replay `data/failures.jsonl` |
| `export` | write `processes.csv` and `documents.csv` |

Search criteria for `crawl`, at least one required:
`--parte`, `--advogado`, `--classe`, `--numero`, `--from`, `--to`.

Budgets for a first test run:
`--max-processes`, `--max-searches`, `--max-pdfs-per-process`, `--no-pdfs`,
`--no-classes`.

Dates are `dd/MM/yyyy`. Party name needs at least two names, which is a portal
rule: one name answers
`É necessário informar ao menos dois nomes para realizar a consulta por nome da parte.`

## Layout

```
src/
  index.ts                 CLI entry point
  config.ts                every setting, with environment overrides
  logger.ts                console plus data/scraper.log
  types.ts                 the typed shape of everything extracted
  cli/
    args.ts                argument parsing
    exporter.ts            JSON Lines to CSV
  http/
    client.ts              cookies, charset, retry, backoff, 429
    rateLimiter.ts         concurrency gate, minimum gap, global pause
    errors.ts              HttpFailure and ContentError
  jsf/
    ajaxResponse.ts        the RichFaces 3.3 ajax envelope
    searchView.ts          the stateful fPP form
  scrape/
    listParser.ts          the result grid, and the 30 row cap
    detailParser.ts        case data, parties, movements, documents
    panelPager.ts          the pagina sliders, one per pageable panel
    judicialClasses.ts     the case class catalogue
    planner.ts             adaptive subdivision of the search space
    pdfDownloader.ts       the two hop PDF fetch
    crawler.ts             the orchestrator
  store/
    persistence.ts         JSON Lines, resume state, failure queue
test/
  run.ts                   the test suite
  fixtures/                real responses captured from the live portal
docs/
  RECON.md                 the investigation, with evidence per claim
```

## Tests

```bash
npm test          # offline: fixtures and a local stub. No network.
npm run test:e2e  # online: the whole path against the live portal.
npm run typecheck
```

46 offline tests, no test framework. Three groups matter.

**Parsers**, checked against fixtures captured verbatim from the live portal.
`test/fixtures/search-response.xml` is a real RichFaces ajax answer trimmed to
two rows. `test/fixtures/detail.html` is a real detail page, byte for byte,
ISO-8859-1 and all, so the encoding assertions test the real thing. Both
fixtures were chosen so every party in them is an institution, not a private
individual.

**The 429 policy**, checked against a local stub server that answers 429 on
command: a 429 that clears, a 429 that never clears, a 503, a 404 that must NOT
be retried, a redirect loop that must be refused rather than followed forever,
and a download that answers HTML instead of a PDF. The backoff arithmetic itself
is pinned separately, with the random draw injected, so the window sizes and the
`Retry-After` precedence are asserted exactly rather than sampled.

**The movements pager**, because this is where the scraper had a real defect.
The first version looked for the datascroller that the PARTIES panels use, did
not find one, and concluded a case had nothing to page through. The movements
panel uses a RichFaces slider instead, so the scraper kept page 1 and dropped
the rest. `test/fixtures/detail.html`, captured before the bug was found, is
itself a two page case: 10 movements delivered against a footer reading 30.
Both halves are pinned, the missed pagination and the documents that hang off
the later pages.

Two failure modes get a test of their own because they are the ones that lose
data silently: an expired JSF view that parses as zero rows, and an impossible
date such as `31/02/2026` that JavaScript would happily roll over to 3 March.

### The end to end test

`npm test` is hermetic, which is the right default and also its limit: a fixture
cannot tell you the portal still works the way this scraper believes. Every
component id on the page is an unstable `j_idNNN`, and a redeploy is exactly the
change a fixture cannot catch.

`npm run test:e2e` walks the real path once, about a dozen requests at the
polite delay:

```
e2e against https://pjett.trf5.jus.br

  ok   1. the session bootstraps and the fPP form is understood
  ok   2. the reCAPTCHA is still disabled server side
  ok   3. the search returns a parsed result grid (30 rows)
  ok   4. the case detail parses (11 parties, 15 movements on page 1)
  ok   5. every movements page is read, not just the delivered one
          (15 on page 1, 65 over 5 pages, panel reports 65)
  ok   6. documents attached to later pages are collected (0 beyond page 1)
  ok   7. one real PDF downloads and is a PDF (19457 bytes)

7 checks passed against the live portal
```

Step 5 is the one worth reading. It does not trust the scraper's own count: it
compares what was read against the total the portal itself prints in the panel
footer, so the check fails if paging ever silently stops early.

If the portal is unreachable the run prints SKIPPED and exits 0. A court being
down is not a defect in this code, and a red build that means "the network was
bad" trains you to ignore red builds.

## Limitations, stated plainly

**No live 429 was ever observed.** Across the whole investigation and every test
run, at roughly one request every 1.5 to 2 seconds, the portal never answered
429 and never sent `Retry-After`. So the backoff path is proved by the stub
server tests, not by a live throttle. The policy is written against the HTTP
specification and against how the server SHOULD answer, and it has not been
confirmed against this server's actual throttling behaviour, because that
behaviour never appeared at a polite request rate.

**Full coverage of the archive is not achievable through this form.** The 30 row
cap combined with a one day minimum granularity on the filing date means a busy
day in a busy case class overflows with no way left to cut it. Those slices are
recorded in `state.json` under `saturatedCells` and the run warns about them.
Making them complete would need a third partitioning axis the public form does
not offer.

**Some documents have no public PDF.** A document row either carries a real
download href or only a popup to `documentoSemLoginHTML.seam`. That second route
answers 302 to `login.seam` for an anonymous caller, verified both from a fresh
cookie jar and from a jar that had just loaded the detail page. The same is true
of the `reportCertidaoPDF.seam` receipt link. Those rows are recorded with
`formato: "html"` and are not counted as failures, because they are not.

**Every pageable panel is paged through, one request per page.** A long record
costs one extra request per page beyond the first, per panel. Pages are read in
order and a page that fails is skipped rather than aborting the case, so a case
can be recorded as partial. `movimentacoesCompleto` on the record says which it
was, and it is false unless every panel reconciled against its own footer.

**The `ca` token is treated as opaque.** It is read fresh from each search and
never reused across runs. Cases are deduplicated by that token AND by their case
number, so the resume is correct whether or not the token is stable.

**A case with hundreds of documents is untested at that size.** The largest
sample read carried fifteen.

## Legal and ethical note

This portal is the public case consultation service of a Brazilian federal
court, published under CNJ Resolution 121. Cases under `segredo de justiça` are
withheld by the server itself and never reach the scraper; the extracted record
carries a `segredoJustica` flag when the page says so.

The defaults here are deliberately slower than the portal would tolerate. Please
do not raise `CONCURRENCY` or lower `REQUEST_DELAY_MS` without a reason. The
extracted data includes names and taxpayer identifiers of real people, so treat
`data/` as personal data and keep it out of version control. It is in
`.gitignore` already.
