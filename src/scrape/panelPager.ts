/**
 * Pagination for the panels of a case detail page.
 *
 * The parties lists page with a RichFaces datascroller. The other two panels do
 * NOT, and that difference has now caused the same defect twice, so it is worth
 * stating plainly: a panel with no `<tfoot>` and no datascroller still paginates.
 * It uses a RichFaces *Slider* labelled `pagina`, printed inline:
 *
 *     new Richfaces.Slider("j_id146:j_id561:j_id562",
 *       {'minValue':'1','maxValue':'5','sliderValue':'1', ... })
 *
 * A real case detail page carries TWO of these, and they page different panels:
 *
 * | slider              | region                          | panel               |
 * | ------------------- | ------------------------------- | ------------------- |
 * | `j_id146:j_id561:*` | `j_id146:j_id474`               | Movimentacoes       |
 * | `j_id146:j_id653:*` | `j_id146:j_id569`               | Documentos juntados |
 *
 * Both are labelled `pagina` and both look alike, so picking "the slider" by
 * position is a coin flip. On case 0001223-51.1994.4.05.8300 the movements
 * panel held 65 rows over 5 pages while the DOCUMENTS grid held 23 documents
 * over 2 pages, and reading only the delivered page kept 15 of them. Eight
 * downloadable PDFs were simply not visible to the scraper.
 *
 * So this module finds EVERY slider and pages all of them. It does not try to
 * guess which panel a slider belongs to before asking: the answer comes back in
 * the `Ajax-Update-Ids` of the first response, which is authoritative, and the
 * caller uses it to check the right total.
 *
 * Four ids drive one page request, and every one of them is an unstable
 * `j_idNNN`, so all four are read from the markup:
 *
 * | role           | example                   | source                       |
 * | -------------- | ------------------------- | ---------------------------- |
 * | slider input   | `j_id146:j_id561:j_id562` | the `Slider` constructor     |
 * | enclosing form | `j_id146:j_id561`         | `A4J.AJAX.Submit` argument 1 |
 * | trigger param  | `j_id146:j_id561:j_id563` | the `parameters` map         |
 * | ajax region    | `j_id146:j_id474`         | `containerId`                |
 *
 * The trigger parameter is the one that is easy to drop. Posting the slider
 * value alone returns 200 with the region unchanged, which reads as "page 2 is
 * the same as page 1" rather than as a failure.
 */

import * as cheerio from 'cheerio';
import { HttpClient } from '../http/client';
import { parseAjaxResponse } from '../jsf/ajaxResponse';
import { log } from '../logger';
import { DocumentRef, Movement } from '../types';
import { readDocuments, readMovements } from './detailParser';

/** Everything needed to ask one panel for one more page. */
export interface PanelPager {
  /** `j_id146:j_id561`, the form that wraps the slider. */
  formId: string;
  /** `j_id146:j_id561:j_id562`, the field carrying the page number. */
  inputId: string;
  /** `j_id146:j_id561:j_id563`, the parameter that tells the server to act. */
  triggerId: string;
  /** `j_id146:j_id474`, the region the answer re renders. */
  containerId: string;
  /** Last page number. 1 means this panel is already complete. */
  lastPage: number;
  /** Page the delivered HTML is showing, normally 1. */
  currentPage: number;
  /** `javax.faces.ViewState` for the detail view. Refreshed on every postback. */
  viewState: string;
  /** The footer count printed under this panel, when it printed one. */
  reportedTotal: number | null;
}

/** Which panel a pager turned out to drive. Learned from the first answer. */
export type PanelKind = 'movements' | 'documents' | 'unknown';

const SLIDER = /new\s+Richfaces\.Slider\(\s*"([^"]+)"\s*,\s*\{(.*?)\}\s*\)/gs;
const TOTAL = /([\d.]+)\s*resultados?\s+encontrados/gi;

/**
 * True when the markup contains a slider at all.
 *
 * This exists so the caller can tell "this record is short" apart from "this
 * record is paged and I failed to read the widget". Those are the same return
 * value from `findPanelPagers` (an empty list) and they mean opposite things:
 * the first is complete, the second is silent data loss.
 */
export function hasSlider(html: string): boolean {
  return /new\s+Richfaces\.Slider\(/.test(html);
}

/**
 * The footer count belonging to the panel a slider sits under.
 *
 * A detail page prints `resultados encontrados` once per panel, five times in
 * total, and the parties panels come first. Taking the first match reads another
 * panel's number, so this takes the LAST one before this slider.
 */
function totalBefore(html: string, sliderIndex: number): number | null {
  let found: number | null = null;
  for (const match of html.matchAll(TOTAL)) {
    if (match.index !== undefined && match.index > sliderIndex) break;
    const digits = (match[1] ?? '').replace(/\D/g, '');
    if (digits !== '') found = Number.parseInt(digits, 10);
  }
  return found;
}

/**
 * Every pageable panel on the page, in document order.
 *
 * Returns an empty list when the page carries no slider, which is the common
 * case for a short record. Pair it with `hasSlider` before concluding the record
 * is complete.
 */
export function findPanelPagers(html: string): PanelPager[] {
  const viewState = /name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/.exec(html)?.[1];
  if (viewState === undefined) return [];

  const pagers: PanelPager[] = [];

  for (const match of html.matchAll(SLIDER)) {
    const inputId = match[1];
    const raw = match[2] ?? '';
    if (inputId === undefined) continue;

    // The `onchange` value is a JavaScript string literal, so every quote inside
    // it arrives backslash escaped (`\'containerId\'`). Unescape once and read it
    // the way the browser does.
    const options = raw.replace(/\\'/g, "'");

    const submit = /A4J\.AJAX\.Submit\('([^']+)'/.exec(options);
    const trigger = /'parameters'\s*:\s*\{\s*'([^']+)'/.exec(options);
    const container = /'containerId'\s*:\s*'([^']+)'/.exec(options);
    if (submit === null || trigger === null || container === null) continue;

    const lastPage = Number.parseInt(/'maxValue'\s*:\s*'(\d+)'/.exec(options)?.[1] ?? '1', 10);
    const currentPage = Number.parseInt(/'sliderValue'\s*:\s*'(\d+)'/.exec(options)?.[1] ?? '1', 10);
    if (!Number.isFinite(lastPage) || lastPage < 1) continue;

    pagers.push({
      formId: submit[1] as string,
      inputId,
      triggerId: trigger[1] as string,
      containerId: container[1] as string,
      lastPage,
      currentPage: Number.isFinite(currentPage) ? currentPage : 1,
      viewState,
      reportedTotal: totalBefore(html, match.index ?? 0),
    });
  }

  return pagers;
}

/** The form body for one page request. */
export function pageForm(pager: PanelPager, page: number): URLSearchParams {
  const form = new URLSearchParams();
  form.set('AJAXREQUEST', pager.containerId);
  form.set(pager.formId, pager.formId);
  form.set(pager.inputId, String(page));
  form.set('autoScroll', '');
  form.set(`${pager.formId}:_link_hidden_`, '');
  form.set(`${pager.formId}:j_idcl`, '');
  form.set('javax.faces.ViewState', pager.viewState);
  // Without this the server returns the region unchanged.
  form.set(pager.triggerId, pager.triggerId);
  form.set('AJAX:EVENTS_COUNT', '1');
  return form;
}

export interface ExtraPages {
  movimentacoes: Movement[];
  documentos: DocumentRef[];
  pagesRead: number;
  pagesFailed: number;
  /** Which panel this pager drives, from the server's own `Ajax-Update-Ids`. */
  kind: PanelKind;
}

/**
 * Decide what came back.
 *
 * The server names the region it re rendered, so this reads that rather than
 * inferring the panel from what the parsers happened to find. Inferring from row
 * counts would call a genuinely empty page "unknown" and hide a real failure.
 */
function classify(updateIds: string[], $: cheerio.CheerioAPI): PanelKind {
  const ids = updateIds.join(' ');
  if (/processoEvento/i.test(ids)) return 'movements';
  if (/processoDocumento/i.test(ids)) return 'documents';
  // Fall back to the markup when the server named nothing useful.
  if ($('[id*="processoEvento:"]').length > 0) return 'movements';
  if ($('table[id$=":processoDocumentoGridTab"]').length > 0) return 'documents';
  return 'unknown';
}

/**
 * Walk pages 2..lastPage of one panel and return what they add.
 *
 * A page that fails is logged and skipped rather than aborting the case: a
 * partial record beats no record. `pagesFailed` lets the caller record the case
 * as partial instead of letting it pass for complete.
 */
export async function fetchRemainingPages(
  http: HttpClient,
  detailUrl: string,
  pager: PanelPager,
  numeroProcesso: string,
): Promise<ExtraPages> {
  const movimentacoes: Movement[] = [];
  const documentos: DocumentRef[] = [];
  let pagesRead = 0;
  let pagesFailed = 0;
  let kind: PanelKind = 'unknown';

  for (let page = pager.currentPage + 1; page <= pager.lastPage; page += 1) {
    try {
      const response = await http.requestText(detailUrl, {
        label: `panel ${pager.formId} ${numeroProcesso} p${page}/${pager.lastPage}`,
        form: pageForm(pager, page),
        headers: { Referer: detailUrl, 'X-Requested-With': 'XMLHttpRequest' },
      });

      const envelope = parseAjaxResponse(response.text);
      const $ = envelope.$ as cheerio.CheerioAPI;
      const thisKind = classify(envelope.updateIds, $);

      // An expired view answers 200 with the entry page and neither panel in it.
      // That must not be read as "this page was empty", which is how a truncated
      // record gets stamped complete.
      if (thisKind === 'unknown') {
        pagesFailed += 1;
        log.warn('panel page came back without a known panel, skipping', {
          numeroProcesso,
          page,
          updateIds: envelope.updateIds.join(','),
        });
        continue;
      }
      if (kind === 'unknown') kind = thisKind;

      movimentacoes.push(...readMovements($));
      documentos.push(...readDocuments($));
      pagesRead += 1;

      // The server hands back a fresh view state on every postback. Reusing a
      // stale one makes the next page silently return the same rows.
      if (envelope.viewState !== null) pager.viewState = envelope.viewState;
    } catch (error) {
      pagesFailed += 1;
      log.warn('panel page failed, keeping what the case already yielded', {
        numeroProcesso,
        page,
        error: (error as Error).message,
      });
    }
  }

  return { movimentacoes, documentos, pagesRead, pagesFailed, kind };
}
