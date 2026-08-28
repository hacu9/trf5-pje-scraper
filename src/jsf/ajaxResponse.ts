/**
 * RichFaces 3.3 ajax envelope.
 *
 * The brief for this exercise expected JSF 2 partial responses
 * (`javax.faces.partial.ajax`, a `<partial-response>` document). This portal is
 * older than that. It runs JSF 1.2 with RichFaces 3.3.3, whose ajax protocol is
 * different in three ways that matter:
 *
 * 1. The request is an ordinary form POST with an extra `AJAXREQUEST` field.
 *    There are no `javax.faces.partial.*` parameters and no `Faces-Request`
 *    header.
 * 2. The answer carries `content-type: text/xml` and the header
 *    `ajax-response: true`, but the body is an XHTML document, not a
 *    `<partial-response>`. cheerio parses it directly.
 * 3. The updated regions are named by `<meta name="Ajax-Update-Ids">` and the
 *    refreshed view state arrives inside `<span id="ajax-view-state">`.
 *
 * A verbatim tail of a real answer:
 *
 *     <meta name="Ajax-Update-Ids" content="fPP:processosGridPanel" />
 *     <span id="ajax-view-state">
 *       <input type="hidden" name="javax.faces.ViewState" value="j_id1" />
 *     </span>
 *     <meta id="Ajax-Response" name="Ajax-Response" content="true" />
 */

import * as cheerio from 'cheerio';

export interface AjaxEnvelope {
  /** The parsed document. Query it like any page. */
  $: cheerio.CheerioAPI;
  /** True when the server marked the answer as an ajax response. */
  isAjax: boolean;
  /** Component ids the server says it re rendered. */
  updateIds: string[];
  /** Fresh `javax.faces.ViewState`, or null when the answer did not carry one. */
  viewState: string | null;
}

export function parseAjaxResponse(body: string): AjaxEnvelope {
  const $ = cheerio.load(body);

  const isAjax =
    $('meta[name="Ajax-Response"]').attr('content') === 'true' || body.includes('ajax-view-state');

  const updateIds: string[] = [];
  $('meta[name="Ajax-Update-Ids"]').each((_index, element) => {
    const content = $(element).attr('content');
    if (content === undefined) return;
    for (const id of content.split(',')) {
      const trimmed = id.trim();
      if (trimmed !== '' && !updateIds.includes(trimmed)) updateIds.push(trimmed);
    }
  });

  const viewState =
    $('#ajax-view-state input[name="javax.faces.ViewState"]').attr('value') ??
    $('input[name="javax.faces.ViewState"]').first().attr('value') ??
    null;

  return { $, isAjax, updateIds, viewState };
}

/**
 * A JSF session can expire. When it does the server answers the postback with
 * the login view or the bare entry view instead of the fragment we asked for.
 *
 * This is the most dangerous failure mode in the whole scraper, because it does
 * NOT look like a failure. The answer is a 200, it parses, and the result grid
 * is simply absent, which a naive parser reads as "zero results". The cell then
 * gets marked finished and its cases are lost for good.
 *
 * The cheap tell is that the fragment does not contain the component the
 * postback targeted at all. An empty grid still renders its own table element.
 */
export function looksLikeExpiredView(envelope: AjaxEnvelope, expectedSelector: string): boolean {
  return envelope.$(expectedSelector).length === 0;
}
