/**
 * Pagination for the `Movimentacoes do Processo` panel.
 *
 * The parties lists page with a RichFaces datascroller. The movements panel
 * does not, and that difference is what makes this easy to get wrong: a parser
 * that looks for a datascroller concludes the panel is complete and keeps only
 * the first page. On a real case the first page held 15 movements while the
 * footer read `65 resultados encontrados`, so four fifths of the record, and
 * every PDF hanging off it, stayed on the server.
 *
 * The widget is a RichFaces *Slider* labelled `pagina`. The detail page prints
 * it inline:
 *
 *     new Richfaces.Slider("j_id146:j_id561:j_id562",
 *       {'minValue':'1','maxValue':'5','sliderValue':'1','width':'250px',
 *        'onchange':'A4J.AJAX.Submit(\'j_id146:j_id561\',event,
 *            {\'similarityGroupingId\':\'j_id146:j_id561:j_id563\',
 *             \'actionUrl\':\'...listView.seam\',
 *             \'containerId\':\'j_id146:j_id474\',
 *             \'parameters\':{\'j_id146:j_id561:j_id563\':\'j_id146:j_id561:j_id563\'}})'})
 *
 * Four ids matter and every one of them is an unstable `j_idNNN`, so all four
 * are read off the page rather than hard coded:
 *
 * | role            | example                    | where it comes from        |
 * | --------------- | -------------------------- | -------------------------- |
 * | slider input    | `j_id146:j_id561:j_id562`  | the `Slider` constructor    |
 * | enclosing form  | `j_id146:j_id561`          | the `A4J.AJAX.Submit` arg 1 |
 * | trigger param   | `j_id146:j_id561:j_id563`  | the `parameters` map        |
 * | ajax region     | `j_id146:j_id474`          | `containerId`               |
 *
 * The postback is an ordinary form POST, per the RichFaces 3.3 protocol
 * documented in `jsf/ajaxResponse.ts`. Sending the slider value alone is not
 * enough: without the trigger parameter the server answers 200 with an
 * unchanged region, which is why the value and the trigger both go on the wire.
 */

import * as cheerio from 'cheerio';
import { HttpClient } from '../http/client';
import { parseAjaxResponse } from '../jsf/ajaxResponse';
import { log } from '../logger';
import { DocumentRef, Movement } from '../types';
import { readDocuments, readMovements } from './detailParser';

/** Everything needed to ask for one more page of movements. */
export interface MovementPager {
  /** `j_id146:j_id561`, the form that wraps the slider. */
  formId: string;
  /** `j_id146:j_id561:j_id562`, the field carrying the page number. */
  inputId: string;
  /** `j_id146:j_id561:j_id563`, the parameter that tells the server to act. */
  triggerId: string;
  /** `j_id146:j_id474`, the region the answer re renders. */
  containerId: string;
  /** Last page number. 1 means the panel is already complete. */
  lastPage: number;
  /** Page the delivered HTML is showing, normally 1. */
  currentPage: number;
  /** `javax.faces.ViewState` for the detail view. */
  viewState: string;
  /** Footer count, when the panel printed one. Used only to check the result. */
  reportedTotal: number | null;
}

const SLIDER = /new\s+Richfaces\.Slider\(\s*"([^"]+)"\s*,\s*\{(.*?)\}\s*\)/gs;
const TOTAL = /([\d.]+)\s*resultados?\s+encontrados/gi;

/**
 * The footer count that belongs to the movements panel.
 *
 * A detail page prints `resultados encontrados` five times, once per panel, and
 * the parties panels come first. Taking the first match reads another panel's
 * count, so this takes the LAST one before the slider, which is the footer the
 * slider sits under.
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
 * Read the movements slider off a detail page.
 *
 * Returns null when the page has no slider, which is the common case: a short
 * record fits on one page and the portal omits the widget entirely. Null means
 * "already complete", never "failed".
 */
export function findMovementPager(html: string): MovementPager | null {
  const viewState = /name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/.exec(html)?.[1];
  if (viewState === undefined) return null;

  for (const match of html.matchAll(SLIDER)) {
    const inputId = match[1];
    const raw = match[2] ?? '';
    if (inputId === undefined) continue;

    // The `onchange` value is a JavaScript string literal, so every quote
    // inside it arrives backslash escaped (`\'containerId\'`). Unescape once
    // and then read it the way the browser does, rather than teaching each
    // pattern below to tolerate an optional backslash on both sides.
    const options = raw.replace(/\\'/g, "'");

    // The parties lists also use sliders in some skins. Keep only the slider
    // whose onchange drives an A4J postback, which is the paging one.
    const submit = /A4J\.AJAX\.Submit\('([^']+)'/.exec(options);
    const trigger = /'parameters'\s*:\s*\{\s*'([^']+)'/.exec(options);
    const container = /'containerId'\s*:\s*'([^']+)'/.exec(options);
    if (submit === null || trigger === null || container === null) continue;

    const lastPage = Number.parseInt(/'maxValue'\s*:\s*'(\d+)'/.exec(options)?.[1] ?? '1', 10);
    const currentPage = Number.parseInt(/'sliderValue'\s*:\s*'(\d+)'/.exec(options)?.[1] ?? '1', 10);
    if (!Number.isFinite(lastPage) || lastPage < 1) continue;

    return {
      formId: submit[1] as string,
      inputId,
      triggerId: trigger[1] as string,
      containerId: container[1] as string,
      lastPage,
      currentPage: Number.isFinite(currentPage) ? currentPage : 1,
      viewState,
      reportedTotal: totalBefore(html, match.index ?? 0),
    };
  }

  return null;
}

/** The form body for one page request. */
export function pageForm(pager: MovementPager, page: number): URLSearchParams {
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
}

/**
 * Walk pages 2..lastPage and return what they add.
 *
 * A page that fails is logged and skipped rather than aborting the case: a
 * partial record beats no record, and the counts in the result let the caller
 * report the loss honestly instead of implying the case is complete.
 */
export async function fetchRemainingPages(
  http: HttpClient,
  detailUrl: string,
  pager: MovementPager,
  numeroProcesso: string,
): Promise<ExtraPages> {
  const movimentacoes: Movement[] = [];
  const documentos: DocumentRef[] = [];
  let pagesRead = 0;
  let pagesFailed = 0;

  for (let page = pager.currentPage + 1; page <= pager.lastPage; page += 1) {
    try {
      const response = await http.requestText(detailUrl, {
        label: `movements ${numeroProcesso} p${page}/${pager.lastPage}`,
        form: pageForm(pager, page),
        headers: { Referer: detailUrl, 'X-Requested-With': 'XMLHttpRequest' },
      });

      const envelope = parseAjaxResponse(response.text);
      const $ = envelope.$ as cheerio.CheerioAPI;

      // An expired view answers 200 with the entry page and no events table.
      // That must not be read as "this page was empty".
      if ($('[id$="processoEvento"], [id*="processoEvento:"]').length === 0) {
        pagesFailed += 1;
        log.warn('movements page came back without an events table, skipping', {
          numeroProcesso,
          page,
        });
        continue;
      }

      movimentacoes.push(...readMovements($));
      documentos.push(...readDocuments($));
      pagesRead += 1;

      // The server hands back a fresh view state on every postback. Reusing a
      // stale one makes the next page silently return the same rows.
      if (envelope.viewState !== null) pager.viewState = envelope.viewState;
    } catch (error) {
      pagesFailed += 1;
      log.warn('movements page failed, keeping what the case already yielded', {
        numeroProcesso,
        page,
        error: (error as Error).message,
      });
    }
  }

  return { movimentacoes, documentos, pagesRead, pagesFailed };
}
