/**
 * The stateful side of the portal: the `fPP` search view.
 *
 * ## Why this class exists
 *
 * Three properties of the view make a naive "post a fixed body" scraper wrong.
 *
 * **The component ids are generated.** Real field names look like
 * `fPP:j_id180:nomeAdv` and `fPP:j_id189:classeJudicial`. The `j_idNNN` part is
 * a JSF component index. It changes when the page template changes, so it must
 * never be hard coded. This class reads the rendered form and resolves every
 * field by its stable SUFFIX (`nomeAdv`, `classeJudicial`, and so on).
 *
 * **The submit is not the button.** `fPP:searchProcessos` is a plain
 * `type=button` whose onclick calls `executarReCaptcha()`, which calls
 * `executarPesquisa()`. That second function is an `a4j:jsFunction` and ITS
 * generated id is the parameter the server dispatches on. We read the id out of
 * the inline script rather than guess it.
 *
 * **The form keeps state between postbacks.** JSF 1.2 only decodes inputs that
 * are present in the request, so any field left out of the POST silently keeps
 * the value the backing bean already held. Verified: a POST that omitted the
 * empty text inputs returned rows belonging to the PREVIOUS search. So every
 * postback sends the COMPLETE field set, empty strings included. That is what
 * `buildPayload` guarantees.
 *
 * ## About the reCAPTCHA
 *
 * The page loads `recaptcha/api.js`, but the served source of the trigger is
 *
 *     function executarReCaptcha() {
 *         if (false) { grecaptcha.execute(); return false; }
 *         executarPesquisa();
 *     }
 *
 * The server renders the guard as the literal `false`, so no token is produced
 * and none is expected. Verified against the live site. If the operator ever
 * flips that flag on, `assertCaptchaDisabled` fails loudly instead of letting
 * the scraper post nonsense for hours.
 */

import * as cheerio from 'cheerio';
import { HttpClient } from '../http/client';
import { config } from '../config';
import { log } from '../logger';
import { parseAjaxResponse, AjaxEnvelope } from './ajaxResponse';
import { SearchCriteria } from '../types';

/** Stable suffixes of the form fields, mapped to the role each one plays. */
const FIELD_SUFFIXES = {
  numeroProcesso: 'numProcesso-inputNumeroProcesso',
  processoReferencia: 'processoReferenciaInput',
  nomeParte: 'nomeParte',
  nomeAdvogado: 'nomeAdv',
  classeJudicial: 'classeJudicial',
  classeSelection: 'sgbClasseJudicial_selection',
  documentoParte: 'documentoParte',
  numeroOAB: 'numeroOAB',
  estadoOAB: 'estadoComboOAB',
  dataInicio: 'dataAutuacaoInicioInputDate',
  dataFim: 'dataAutuacaoFimInputDate',
} as const;

type FieldRole = keyof typeof FIELD_SUFFIXES;

export class SearchView {
  private viewState = '';
  private searchFunctionId = '';
  private classSuggestionId = '';
  /** Every field the rendered form carries, with the value it was rendered with. */
  private baseline = new Map<string, string>();
  /** Role to real field name, resolved from the rendered form. */
  private fields = new Map<FieldRole, string>();
  private loaded = false;

  constructor(private readonly http: HttpClient) {}

  get url(): string {
    return config.baseUrl + config.searchPath;
  }

  /** Fetch the search view and learn its component ids. Call before any search. */
  async load(): Promise<void> {
    log.info('loading search view', { url: this.url });
    const response = await this.http.requestText(this.url, { label: 'search view' });
    const $ = cheerio.load(response.text);

    const form = $('form#fPP');
    if (form.length === 0) {
      throw new Error('the search form fPP is not present; the portal layout changed');
    }

    this.baseline.clear();
    this.fields.clear();

    form.find('input, select, textarea').each((_index, element) => {
      const node = $(element);
      const name = node.attr('name');
      if (name === undefined || name === '') return;
      const type = (node.attr('type') ?? '').toLowerCase();
      // A button never carries state, and an unchecked radio is not submitted.
      if (type === 'button' || type === 'submit' || type === 'reset') return;
      if (type === 'radio' && node.attr('checked') === undefined && this.baseline.has(name)) return;
      this.baseline.set(name, node.attr('value') ?? '');
    });

    // The radios have no rendered value. The portal only reads the onclick side
    // effect, so any non empty value keeps the request shaped like a browser's.
    for (const radio of ['mascaraProcessoReferenciaRadio', 'tipoMascaraDocumento']) {
      if (this.baseline.has(radio) && this.baseline.get(radio) === '') {
        this.baseline.set(radio, 'on');
      }
    }

    // A Seam no selection combo must post its sentinel, not an empty string.
    for (const [name, value] of this.baseline) {
      if (name.endsWith('estadoComboOAB') && value === '') {
        this.baseline.set(name, 'org.jboss.seam.ui.NoSelectionConverter.noSelectionValue');
      }
    }

    for (const [role, suffix] of Object.entries(FIELD_SUFFIXES) as Array<[FieldRole, string]>) {
      const match = [...this.baseline.keys()].find((name) => name.endsWith(suffix));
      if (match !== undefined) this.fields.set(role, match);
      else log.warn('search field not found on the rendered form', { role, suffix });
    }

    this.viewState = $('form#fPP input[name="javax.faces.ViewState"]').attr('value') ?? '';
    if (this.viewState === '') throw new Error('no javax.faces.ViewState on the search form');

    this.searchFunctionId = extractJsFunctionId(response.text, 'executarPesquisa');
    this.classSuggestionId = findSuggestionBoxId(response.text);
    assertCaptchaDisabled(response.text);

    this.loaded = true;
    log.info('search view ready', {
      viewState: this.viewState,
      submitParam: this.searchFunctionId,
      fields: this.fields.size,
      baselineFields: this.baseline.size,
    });
  }

  /** Post the search and hand back the parsed ajax envelope. */
  async submitSearch(criteria: SearchCriteria): Promise<AjaxEnvelope> {
    this.requireLoaded();
    const payload = this.buildPayload(criteria);
    payload.set('AJAXREQUEST', '_viewRoot');
    payload.set(this.searchFunctionId, this.searchFunctionId);

    const response = await this.http.requestText(this.url, {
      form: payload,
      label: `search ${describe(criteria)}`,
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Referer: this.url,
      },
    });

    const envelope = parseAjaxResponse(response.text);
    if (envelope.viewState !== null) this.viewState = envelope.viewState;
    return envelope;
  }

  /**
   * Ask the classe judicial suggestion box for its catalogue.
   *
   * Verified quirk: the box ignores the typed prefix and answers with the full
   * list, so one call with any three letter seed returns every case class.
   */
  async fetchClassSuggestions(seed: string): Promise<AjaxEnvelope> {
    this.requireLoaded();
    if (this.classSuggestionId === '') {
      throw new Error('the classe judicial suggestion box is not present on the form');
    }
    const classField = this.fields.get('classeJudicial');
    if (classField === undefined) throw new Error('the classe judicial input is not on the form');

    const payload = new URLSearchParams();
    payload.set('AJAXREQUEST', '_viewRoot');
    payload.set('fPP', 'fPP');
    payload.set(classField, seed);
    payload.set('javax.faces.ViewState', this.viewState);
    payload.set(this.classSuggestionId, this.classSuggestionId);
    payload.set('ajaxSingle', this.classSuggestionId);

    const response = await this.http.requestText(this.url, {
      form: payload,
      label: 'classe judicial suggestions',
      headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: this.url },
    });
    const envelope = parseAjaxResponse(response.text);
    if (envelope.viewState !== null) this.viewState = envelope.viewState;
    return envelope;
  }

  /**
   * Build the complete POST body: every rendered field, then the criteria on
   * top. Sending the whole set is not belt and braces, it is required. See the
   * class comment on statefulness.
   */
  buildPayload(criteria: SearchCriteria): URLSearchParams {
    const payload = new URLSearchParams();
    for (const [name, value] of this.baseline) payload.set(name, value);

    // Clear every user facing criterion first, then apply this request's values.
    for (const role of Object.keys(FIELD_SUFFIXES) as FieldRole[]) {
      if (role === 'estadoOAB') continue;
      const name = this.fields.get(role);
      if (name !== undefined) payload.set(name, '');
    }

    this.put(payload, 'numeroProcesso', criteria.numeroProcesso);
    this.put(payload, 'nomeParte', criteria.nomeParte);
    this.put(payload, 'nomeAdvogado', criteria.nomeAdvogado);
    this.put(payload, 'classeJudicial', criteria.classeJudicial);
    this.put(payload, 'documentoParte', criteria.documentoParte);
    this.put(payload, 'numeroOAB', criteria.numeroOAB);
    this.put(payload, 'dataInicio', criteria.dataInicio);
    this.put(payload, 'dataFim', criteria.dataFim);
    if (criteria.ufOAB !== undefined && criteria.ufOAB !== '') {
      const name = this.fields.get('estadoOAB');
      if (name !== undefined) payload.set(name, criteria.ufOAB);
    }

    payload.set('javax.faces.ViewState', this.viewState);
    payload.set('fPP', 'fPP');
    return payload;
  }

  /** Exposed for the unit tests and for the `probe` command. */
  get submitParameter(): string {
    return this.searchFunctionId;
  }

  get currentViewState(): string {
    return this.viewState;
  }

  fieldName(role: FieldRole): string | undefined {
    return this.fields.get(role);
  }

  private put(payload: URLSearchParams, role: FieldRole, value: string | undefined): void {
    if (value === undefined || value === '') return;
    const name = this.fields.get(role);
    if (name === undefined) {
      throw new Error(`cannot set ${role}: the field is not on the rendered form`);
    }
    payload.set(name, value);
  }

  private requireLoaded(): void {
    if (!this.loaded) throw new Error('call load() before using the search view');
  }
}

/**
 * Pull the generated id of an `a4j:jsFunction` out of its inline script.
 *
 * The rendered shape is
 *
 *     executarPesquisa=function(){A4J.AJAX.Submit('fPP',null,{ ...
 *       'parameters':{'fPP:j_id244':'fPP:j_id244'} } )};
 */
export function extractJsFunctionId(html: string, functionName: string): string {
  const start = html.indexOf(`${functionName}=function`);
  if (start === -1) {
    throw new Error(`the js function ${functionName} is not on the page`);
  }
  const window = html.slice(start, start + 2000);
  const match = /'parameters'\s*:\s*\{\s*'([^']+)'\s*:/.exec(window);
  if (match?.[1] === undefined) {
    throw new Error(`could not read the a4j parameter id for ${functionName}`);
  }
  return match[1];
}

/** Find the RichFaces suggestion box id that backs the classe judicial input. */
export function findSuggestionBoxId(html: string): string {
  const match = /new RichFaces\.Suggestion\('[^']*','[^']*','([^']+)'/.exec(html);
  return match?.[1] ?? '';
}

/**
 * Fail loudly if the portal ever turns the captcha on.
 *
 * The guard is rendered as a literal boolean. `if (false)` means off. Anything
 * else means a token is required and this scraper cannot produce one.
 */
export function assertCaptchaDisabled(html: string): void {
  const start = html.indexOf('function executarReCaptcha');
  if (start === -1) return;
  const window = html.slice(start, start + 400);
  const match = /if\s*\(\s*(true|false)\s*\)/.exec(window);
  if (match?.[1] === 'true') {
    throw new Error(
      'the portal now requires a reCAPTCHA token; this scraper cannot solve one and must stop',
    );
  }
}

function describe(criteria: SearchCriteria): string {
  const parts = Object.entries(criteria)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${String(value)}`);
  return parts.length === 0 ? '(no criteria)' : parts.join(' ');
}
