/**
 * Parser for `DetalheProcessoConsultaPublica/listView.seam?ca=<token>`.
 *
 * The detail view is a plain GET. No postback, no ViewState, no conversation
 * id. It renders five panels.
 *
 * Movements and documents ARE paginated, and the widget is easy to miss. The
 * movements panel carries no `tfoot` and no datascroller, which is what the
 * parties lists use. It uses a RichFaces *Slider* labelled `pagina` instead:
 *
 *     new Richfaces.Slider("j_id146:j_id561:j_id562",
 *         {'minValue':'1','maxValue':'5','sliderValue':'1', ... })
 *
 * A case that renders 15 movements on the first page reported
 * `65 resultados encontrados` over 5 slider pages, so a parser that reads only
 * the delivered HTML keeps about a quarter of the record and silently drops the
 * documents that hang off the later pages. `movementPager.ts` drives the
 * slider; this module parses one page at a time.
 *
 * Panels:
 *
 * * Dados do Processo, a set of `.propertyView` label to value pairs
 * * Polo ativo, Polo Passivo, Outros interessados
 * * Movimentacoes do Processo
 * * Documentos juntados ao processo
 *
 * Every table id ends in a stable suffix (`processoEvento`,
 * `processoDocumentoGridTab`, `...ResumidoList`) behind an unstable `j_idNNN`
 * prefix, so selectors match on the suffix.
 */

import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { config } from '../config';
import { DocumentRef, Movement, Party, ProcessDetail } from '../types';

const PROCESS_NUMBER = /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/;
const TIMESTAMP = /^(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2}:\d{2})?)\s*[-–]\s*(.*)$/s;

export function parseProcessDetail(html: string, ca: string, detailUrl: string): ProcessDetail {
  const $ = cheerio.load(html);

  const dadosProcesso = readPropertyViews($);
  const partes = [
    ...readParties($, 'processoPartesPoloAtivoResumidoList', 'ativo'),
    ...readParties($, 'processoPartesPoloPassivoResumidoList', 'passivo'),
    ...readParties($, 'processoParteOutrosInteressadosResumidoList', 'outros'),
  ];

  const numeroProcesso =
    pick(dadosProcesso, 'Numero Processo', 'Numero do Processo') ??
    PROCESS_NUMBER.exec($('body').text())?.[0] ??
    '';

  return {
    numeroProcesso,
    ca,
    detailUrl,
    dadosProcesso,
    dataDistribuicao: pick(dadosProcesso, 'Data da Distribuicao'),
    classeJudicial: pick(dadosProcesso, 'Classe Judicial'),
    assunto: pick(dadosProcesso, 'Assunto'),
    jurisdicao: pick(dadosProcesso, 'Jurisdicao'),
    orgaoJulgador: pickContaining(dadosProcesso, 'Orgao Julgador'),
    orgaoJulgadorColegiado: pickContaining(dadosProcesso, 'Orgao Julgador Colegiado'),
    segredoJustica: /segredo de justi/i.test($('body').text()),
    partes,
    movimentacoes: readMovements($),
    documentos: readDocuments($),
    scrapedAt: new Date().toISOString(),
  };
}

/**
 * `Dados do Processo` renders as repeated
 * `<div class="propertyView"><div class="name"><label>X</label></div>
 *  <div class="value">Y</div></div>` blocks.
 *
 * Some blocks have an EMPTY label and put the field name in a `<b>` inside the
 * value, which is how `Orgao Julgador Colegiado` and `Endereco` arrive. Those
 * are unpacked separately so they do not collapse into one anonymous entry.
 */
function readPropertyViews($: cheerio.CheerioAPI): Record<string, string> {
  const out: Record<string, string> = {};

  $('.propertyView').each((_index, element) => {
    const block = $(element);
    // Only take the innermost blocks, otherwise a nested one is counted twice.
    if (block.find('.propertyView').length > 0) return;

    const label = clean(block.find('.name label').first().text());
    const valueNode = block.find('.value').first();
    const value = clean(valueNode.text());

    if (label !== '') {
      // A field the portal PRINTS but leaves blank is still a published field.
      // Keeping it lets a consumer tell "empty" from "the panel never had it".
      // A later empty never overwrites an earlier value for the same label.
      const key = deaccent(label);
      if (value !== '' || out[key] === undefined) out[key] = value;
      return;
    }

    // Anonymous block: split it on its own <b> headings.
    const html = valueNode.html() ?? '';
    const parts = html.split(/<b>/i).slice(1);
    for (const part of parts) {
      const end = part.toLowerCase().indexOf('</b>');
      if (end === -1) continue;
      const heading = clean(cheerio.load(`<i>${part.slice(0, end)}</i>`)('i').text());
      const body = clean(
        cheerio.load(`<i>${part.slice(end + 4).split(/<b>/i)[0] ?? ''}</i>`)('i').text(),
      );
      if (heading !== '' && body !== '') out[deaccent(heading)] = body;
    }
  });

  return out;
}

function readParties(
  $: cheerio.CheerioAPI,
  tableSuffix: string,
  polo: Party['polo'],
): Party[] {
  const parties: Party[] = [];
  $(`table[id$=":${tableSuffix}"]`)
    .first()
    .find('tbody[id$=":tb"] > tr')
    .each((_index, element) => {
      const cells = $(element).children('td');
      if (cells.length === 0) return;

      const main = cells.eq(0);
      const headline = clean(main.find('.text-bold').first().text()) || clean(main.text());
      if (headline === '') return;

      const representantes: string[] = [];
      main.find('ul.tree li').each((_i, node) => {
        const value = clean($(node).text());
        if (value !== '') representantes.push(value);
      });

      const roleMatch = /\(([^()]+)\)\s*$/.exec(headline);
      const docMatch = /\b(CPF|CNPJ)\s*:\s*([\d./-]+)/i.exec(headline);

      parties.push({
        polo,
        nome: headline,
        documento: docMatch?.[2] ?? null,
        papel: roleMatch?.[1] ?? null,
        situacao: cells.length > 1 ? clean(cells.eq(1).text()) || null : null,
        representantes,
      });
    });
  return parties;
}

export function readMovements($: cheerio.CheerioAPI): Movement[] {
  const movements: Movement[] = [];
  $('table[id$=":processoEvento"]')
    .first()
    .find('tbody[id$=":tb"] > tr')
    .each((_index, element) => {
      const cells = $(element).children('td');
      if (cells.length === 0) return;
      const raw = clean(cells.eq(0).text());
      if (raw === '') return;

      const parsed = TIMESTAMP.exec(raw);
      const docCell = cells.length > 1 ? cells.eq(1) : null;
      const docLink = docCell === null ? null : docCell.find('a').first();
      if (docLink !== null) docLink.find('.sr-only').remove();

      movements.push({
        data: parsed?.[1] ?? null,
        descricao: parsed?.[2] ?? raw,
        documento: docLink === null || docLink.length === 0 ? null : clean(docLink.text()) || null,
        documentoUrl:
          docLink === null || docLink.length === 0 ? null : popupUrl(docLink) ?? null,
      });
    });
  return movements;
}

/**
 * Build one document from its anchor.
 *
 * `fallbackLabel` is used when the anchor itself has no text, which is how the
 * movements column renders: the cell holds a bare icon link and the human
 * readable text sits in the sibling movement cell.
 */
function documentFromAnchor(
  anchor: cheerio.Cheerio<Element>,
  fallbackLabel: string,
): DocumentRef | null {
  // The anchor carries a screen reader span ("Visualizar documentos") that is
  // invisible on the page but sits in front of the real label. Left in, it
  // corrupts the label and stops the timestamp pattern from anchoring.
  anchor.find('.sr-only').remove();

  const anchorText = clean(anchor.text());
  const rotulo = anchorText === '' ? fallbackLabel : anchorText;
  const title = clean(anchor.attr('title') ?? '');
  const href = anchor.attr('href') ?? '';

  const isPdf = href.includes('idBin=') && href.includes('actionMethod=');
  const popup = popupUrl(anchor);

  const source = isPdf ? href : (popup ?? '');
  const query = (name: string): string | null => queryParam(source, name);

  const idProcessoDocumento = query('idProcessoDocumento') ?? query('idProcessoDoc') ?? '';
  if (idProcessoDocumento === '') return null;

  const parsed = TIMESTAMP.exec(rotulo);
  const typeMatch = /\(([^()]+)\)\s*$/.exec(rotulo);
  const sizeMatch = /\(([\d.,]+\s*[KMG]?b)\)\s*$/i.exec(title);

  return {
    idProcessoDocumento,
    idBin: query('idBin'),
    numeroDocumento: query('numeroDocumento'),
    nomeArquivo: query('nomeArqProcDocBin'),
    rotulo,
    data: parsed?.[1] ?? null,
    tipo: typeMatch?.[1] ?? null,
    tamanhoTexto: sizeMatch?.[1] ?? null,
    formato: isPdf ? 'pdf' : 'html',
    downloadUrl: isPdf ? new URL(href, config.baseUrl).toString() : null,
    htmlViewUrl: popup === null ? null : new URL(popup, config.baseUrl).toString(),
  };
}

/**
 * Every document the markup offers, from both places the portal puts them.
 *
 * 1. `Documentos juntados ao processo`, the grid. Richest labels: the row text
 *    carries the timestamp, the document type and the size.
 * 2. The `Documento` column of the movements table, one link per movement.
 *
 * The grid is read first so its better labels win the deduplication. The second
 * pass is not redundant: a paged fragment re renders `processoEventoPanel` ONLY,
 * so the grid is absent from it entirely. Reading the grid alone kept the
 * documents of page 1 and silently dropped every PDF attached to a movement on
 * pages 2..N.
 */
export function readDocuments($: cheerio.CheerioAPI): DocumentRef[] {
  const documents: DocumentRef[] = [];
  const seen = new Set<string>();

  const add = (anchor: cheerio.Cheerio<Element>, fallbackLabel: string): void => {
    if (anchor.length === 0) return;
    const document = documentFromAnchor(anchor, fallbackLabel);
    if (document === null || seen.has(document.idProcessoDocumento)) return;
    seen.add(document.idProcessoDocumento);
    documents.push(document);
  };

  $('table[id$=":processoDocumentoGridTab"]')
    .first()
    .find('tbody[id$=":tb"] > tr')
    .each((_index, element) => {
      const cells = $(element).children('td');
      if (cells.length === 0) return;
      add(cells.eq(0).find('a').first(), '');
    });

  // Pass 2: the movements column. On the full page this mostly re finds what
  // the grid already gave; on a fragment it is the only source there is.
  $('a[href*="idBin="]').each((_index, element) => {
    const anchor = $(element);
    // The movement description sits in the sibling cell of the same row.
    const rowLabel = clean(anchor.closest('tr').children('td').first().text());
    add(anchor, rowLabel);
  });

  return documents;
}

/**
 * Read one query parameter, decoding it correctly.
 *
 * `URLSearchParams` always decodes a percent escape as UTF-8. The portal builds
 * these links in ISO-8859-1, so `nomeArqProcDocBin=Decis%E3o` comes back as
 * `Decis\uFFFDo` through the standard API. `%E3` is a single byte, and in
 * Latin-1 that byte is the correct character.
 *
 * So the value is percent decoded to raw BYTES first. UTF-8 is tried, and
 * Latin-1 is used when UTF-8 produced a replacement character. That order is
 * right because a valid UTF-8 sequence is almost never valid Latin-1 text a
 * human would write, while the reverse mistake is exactly what we are fixing.
 */
export function queryParam(url: string, name: string): string | null {
  const start = url.indexOf('?');
  if (start === -1) return null;
  const query = url.slice(start + 1).split('#')[0] ?? '';

  for (const pair of query.split('&')) {
    if (pair === '') continue;
    const equals = pair.indexOf('=');
    const rawKey = equals === -1 ? pair : pair.slice(0, equals);
    if (safeDecode(rawKey) !== name) continue;
    const rawValue = equals === -1 ? '' : pair.slice(equals + 1);
    const bytes = percentDecodeToBytes(rawValue.replace(/\+/g, ' '));
    const utf8 = bytes.toString('utf8');
    return utf8.includes('\uFFFD') ? bytes.toString('latin1') : utf8;
  }
  return null;
}

function percentDecodeToBytes(value: string): Buffer {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === undefined) break;
    if (character === '%' && index + 2 < value.length) {
      const hex = value.slice(index + 1, index + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        index += 2;
        continue;
      }
    }
    bytes.push(...Buffer.from(character, 'utf8'));
  }
  return Buffer.from(bytes);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Many links carry no href and open through `openPopUp('name', 'url')`. */
function popupUrl(anchor: cheerio.Cheerio<Element>): string | null {
  const onclick = anchor.attr('onclick') ?? '';
  const match = /openPopUp\(\s*'[^']*'\s*,\s*'([^']+)'\s*\)/.exec(onclick);
  const url = match?.[1];
  if (url === undefined || url === 'about:blank') return null;
  return url.replace(/&amp;/g, '&');
}

function clean(value: string): string {
  return value.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/** Strip accents so a lookup key survives the portal's mixed encodings. */
function deaccent(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function pick(source: Record<string, string>, ...labels: string[]): string | null {
  for (const label of labels) {
    const value = source[label];
    if (value !== undefined) return value;
  }
  return null;
}

function pickContaining(source: Record<string, string>, needle: string): string | null {
  const exact = source[needle];
  if (exact !== undefined) return exact;
  const key = Object.keys(source).find((candidate) => candidate.startsWith(needle));
  return key === undefined ? null : (source[key] ?? null);
}

/** Turn a document label into something usable inside a filename. */
export function documentSlug(document: DocumentRef): string {
  return slugify(document.nomeArquivo ?? document.tipo ?? document.rotulo);
}

export function slugify(value: string): string {
  return (
    deaccent(value)
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
      .toLowerCase() || 'documento'
  );
}
