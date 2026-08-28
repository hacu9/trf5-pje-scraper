/**
 * Parser for the search result grid.
 *
 * The grid arrives inside the RichFaces ajax fragment, so this module works on
 * the already parsed envelope rather than on a whole page.
 *
 * ## Why the cells are addressed by position and not by id
 *
 * A rendered cell id looks like `fPP:processosTable:127362:j_id257`. Only the
 * middle segment, the internal process id, is meaningful. `j_id257` is a
 * component index that a template change would renumber. So the row is read by
 * column position and the internal id is pulled out of the cell id with a
 * pattern that does not depend on the generated part.
 *
 * ## The 30 row cap
 *
 * When a query matches more than thirty cases the server prints
 *
 *     Sua consulta retornou muitos processos e somente os 30 primeiros serao
 *     exibidos. Por favor, refine sua pesquisa.
 *
 * and returns thirty rows. There is no second page: the datascroller in the
 * table footer renders empty. Verified at 1, 2, 5, 8, 9, 18, 22 and 30 rows.
 * `truncated` carries that fact up to the planner, which subdivides the
 * criteria until every slice fits under the cap.
 */

import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { AjaxEnvelope } from '../jsf/ajaxResponse';
import { ProcessSummary, SearchCriteria, SearchResult } from '../types';
import { config } from '../config';

/** The result grid. Its absence from an answer means the view expired. */
export const RESULT_TABLE_SELECTOR = 'table[id$=":processosTable"]';

const PROCESS_NUMBER = /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/;
const CAP_BANNER = /somente os \d+ primeiros/i;

export function parseSearchResults(
  envelope: AjaxEnvelope,
  criteria: SearchCriteria,
): SearchResult {
  const { $ } = envelope;

  const validationMessage =
    firstNonEmpty($('.rich-messages-label').map((_i, el) => text($, el)).get()) ?? null;

  const banner = $('.alert-danger').first().text().trim();
  const truncated = CAP_BANNER.test(banner);

  const footer = $('.rich-table-footercell').text();
  const totalMatch = /(\d+)\s+resultados?\s+encontrados/i.exec(footer);
  const totalLabel = totalMatch?.[1] === undefined ? null : Number.parseInt(totalMatch[1], 10);

  const table = $(RESULT_TABLE_SELECTOR).first();
  const rows: ProcessSummary[] = [];

  table
    .find('tbody[id$=":tb"] > tr')
    .each((_index, element) => {
      const parsed = parseRow($, element, criteria);
      if (parsed !== null) rows.push(parsed);
    });

  return { criteria, rows, totalLabel, truncated, validationMessage };
}

function parseRow(
  $: cheerio.CheerioAPI,
  element: Element,
  criteria: SearchCriteria,
): ProcessSummary | null {
  const cells = $(element).children('td');
  if (cells.length < 2) return null;

  const actionCell = cells.eq(0);
  const infoCell = cells.eq(1);
  const movementCell = cells.eq(2);

  const cellId = actionCell.attr('id') ?? infoCell.attr('id') ?? '';
  const idMatch = /processosTable:([^:]+):/.exec(cellId);
  const internalId = idMatch?.[1] ?? '';

  const detailPath = findDetailPath($, actionCell) ?? findDetailPath($, infoCell);
  if (detailPath === null) return null;
  const caMatch = /[?&]ca=([^&"']+)/.exec(detailPath);
  const ca = caMatch?.[1] ?? '';
  if (ca === '') return null;

  const link = infoCell.find('a').first();
  const titulo = text($, link.get(0));

  // The cell reads: <classe> <a><b>title</b></a> <parties>. Splitting on the
  // anchor is the only way to keep the three apart, because none of them is
  // wrapped in an element of its own.
  const infoHtml = infoCell.html() ?? '';
  const anchorStart = infoHtml.indexOf('<a');
  const anchorEnd = infoHtml.lastIndexOf('</a>');
  const classeJudicial =
    anchorStart === -1 ? '' : textOfFragment(infoHtml.slice(0, anchorStart));
  const partesResumo =
    anchorEnd === -1 ? '' : textOfFragment(infoHtml.slice(anchorEnd + '</a>'.length));

  const numeroMatch = PROCESS_NUMBER.exec(titulo) ?? PROCESS_NUMBER.exec(infoCell.text());

  return {
    internalId,
    ca,
    detailUrl: absolute(detailPath),
    numeroProcesso: numeroMatch?.[0] ?? '',
    classeJudicial,
    titulo,
    partesResumo,
    ultimaMovimentacao: movementCell.length === 0 ? '' : text($, movementCell.get(0)),
    foundBy: criteria,
  };
}

/**
 * The detail link has no href. The row calls
 * `openPopUp('Consulta publica', '/pjeconsulta/.../listView.seam?ca=...')`,
 * so the path has to come out of the onclick handler.
 */
function findDetailPath($: cheerio.CheerioAPI, cell: cheerio.Cheerio<Element>): string | null {
  let found: string | null = null;
  cell.find('a').each((_index, element) => {
    if (found !== null) return;
    const onclick = $(element).attr('onclick') ?? '';
    const match = /openPopUp\(\s*'[^']*'\s*,\s*'([^']+)'\s*\)/.exec(onclick);
    if (match?.[1] !== undefined) {
      found = match[1];
      return;
    }
    const href = $(element).attr('href') ?? '';
    if (href.includes('ca=')) found = href;
  });
  return found;
}

function absolute(path: string): string {
  return new URL(path, config.baseUrl).toString();
}

function text($: cheerio.CheerioAPI, element: Element | undefined): string {
  if (element === undefined) return '';
  return normalise($(element).text());
}

function textOfFragment(html: string): string {
  return normalise(cheerio.load(`<div>${html}</div>`)('div').text());
}

function normalise(value: string): string {
  return value.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

function firstNonEmpty(values: string[]): string | undefined {
  return values.map((value) => value.trim()).find((value) => value !== '');
}

/** True when the result set is the server truncated maximum. */
export function isAtServerCap(result: SearchResult): boolean {
  return result.truncated || result.rows.length >= config.serverResultCap;
}
