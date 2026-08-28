/**
 * Typed shapes for everything the scraper extracts or persists.
 *
 * The vocabulary is the portal's own Brazilian Portuguese, kept verbatim so a
 * reader can match a field to the label on the page. An English gloss sits in
 * the doc comment of each field that is not self evident.
 */

/** One row of the search result grid (`fPP:processosTable`). */
export interface ProcessSummary {
  /** Internal PJe row id taken from the cell id, for example `127362`. */
  internalId: string;
  /** Opaque token that addresses the detail page: `listView.seam?ca=<token>`. */
  ca: string;
  /** Absolute URL of the detail page. */
  detailUrl: string;
  /** Formatted case number, for example `0006388-48.1986.4.05.8401`. */
  numeroProcesso: string;
  /** Case class as printed above the link, for example `APELACAO CIVEL`. */
  classeJudicial: string;
  /** Short case label, for example `ApCiv 0006388-48.1986.4.05.8401 - Desapropriacao`. */
  titulo: string;
  /** Parties line printed after the link, usually `A X B`. */
  partesResumo: string;
  /** Last movement text plus its timestamp, exactly as printed. */
  ultimaMovimentacao: string;
  /** The search criteria that produced this row. */
  foundBy: SearchCriteria;
}

/** A party in one of the three party panels of the detail page. */
export interface Party {
  /** Which panel the party came from. */
  polo: 'ativo' | 'passivo' | 'outros';
  /** Full printed line, for example `NAME - CNPJ: 00.000.000/0001-00 (APELANTE)`. */
  nome: string;
  /** CPF or CNPJ when the line carries one. */
  documento: string | null;
  /** Role in parentheses, for example `APELANTE`. */
  papel: string | null;
  /** Situation column, for example `Ativo`. */
  situacao: string | null;
  /** Representatives listed under the party, for example a law firm or a prosecutor. */
  representantes: string[];
}

/** One row of `Movimentacoes do Processo`. */
export interface Movement {
  /** Timestamp as printed, `dd/MM/yyyy HH:mm:ss`. */
  data: string | null;
  /** Movement description. */
  descricao: string;
  /** Document title printed in the second column, when there is one. */
  documento: string | null;
  /** URL of the document view linked from the second column, when there is one. */
  documentoUrl: string | null;
}

/**
 * One row of `Documentos juntados ao processo`.
 *
 * The portal renders two kinds of row and only one of them is publicly
 * downloadable:
 *
 * * `pdf` rows carry a real href with `idBin`, `numeroDocumento` and
 *   `actionMethod=...setDownloadInstance(row)`. That link answers 302 and then
 *   the PDF, from any session, with no prior page load. This is what the
 *   downloader fetches.
 * * `html` rows only offer a popup to `documentoSemLoginHTML.seam`. VERIFIED:
 *   that route answers 302 to `login.seam` for an anonymous caller, both from a
 *   fresh jar and from a jar that had just loaded the detail page. There is no
 *   public binary behind those rows, so the scraper records them and does not
 *   pretend it can fetch them.
 */
export interface DocumentRef {
  /** PJe document id, from `idProcessoDocumento` or from `idProcessoDoc`. */
  idProcessoDocumento: string;
  /** PJe binary id, from the `idBin` query parameter. Only on `pdf` rows. */
  idBin: string | null;
  /** Content hash the portal uses to address the document. Only on `pdf` rows. */
  numeroDocumento: string | null;
  /** Document name as stored, from `nomeArqProcDocBin`. */
  nomeArquivo: string | null;
  /** Full printed label, for example `13/08/2025 12:24:21 - Despacho (Despacho)`. */
  rotulo: string;
  /** Timestamp parsed out of the label when present. */
  data: string | null;
  /** Document type parsed out of the label when present. */
  tipo: string | null;
  /** Size as advertised in the link title, for example `4,62 Kb`. */
  tamanhoTexto: string | null;
  /** Which of the two row kinds this is. */
  formato: 'pdf' | 'html';
  /** Absolute download URL. Present only when `formato` is `pdf`. */
  downloadUrl: string | null;
  /** Absolute URL of the login gated HTML view, for the record. */
  htmlViewUrl: string | null;
}

/** Everything the detail page yields for one case. */
export interface ProcessDetail {
  numeroProcesso: string;
  ca: string;
  detailUrl: string;
  /** Free form label to value map of the `Dados do Processo` panel. */
  dadosProcesso: Record<string, string>;
  dataDistribuicao: string | null;
  classeJudicial: string | null;
  assunto: string | null;
  jurisdicao: string | null;
  orgaoJulgador: string | null;
  orgaoJulgadorColegiado: string | null;
  segredoJustica: boolean;
  partes: Party[];
  movimentacoes: Movement[];
  documentos: DocumentRef[];
  /**
   * Pages the `pagina` slider offers on the movements panel. 1 when the record
   * is short enough that the portal omits the slider.
   */
  movimentacoesPaginas?: number;
  /** Pages actually read. Lower than `movimentacoesPaginas` after a failure. */
  movimentacoesPaginasLidas?: number;
  /**
   * False when at least one movements page could not be read, so the case is on
   * record as partial instead of passing for complete.
   */
  movimentacoesCompleto?: boolean;
  /** ISO timestamp of the moment the detail page was fetched. */
  scrapedAt: string;
}

/** The criteria of a single search postback. Every field maps to one form input. */
export interface SearchCriteria {
  numeroProcesso?: string;
  nomeParte?: string;
  nomeAdvogado?: string;
  classeJudicial?: string;
  documentoParte?: string;
  numeroOAB?: string;
  ufOAB?: string;
  /** Filing date range, `dd/MM/yyyy`. */
  dataInicio?: string;
  dataFim?: string;
}

/** Outcome of one search postback. */
export interface SearchResult {
  criteria: SearchCriteria;
  rows: ProcessSummary[];
  /** Number printed in the footer, or null when the footer printed nothing. */
  totalLabel: number | null;
  /**
   * True when the server printed the "only the first 30 will be shown" banner.
   * A truncated result set is incomplete and the planner must subdivide it.
   */
  truncated: boolean;
  /** Validation message from the `rich-messages` block, when the server refused. */
  validationMessage: string | null;
}

/** A case class from the suggestion box catalogue. */
export interface JudicialClass {
  codigo: string;
  nome: string;
}

/** A unit of work that failed and can be retried later. */
export interface FailureRecord {
  /** What was being attempted. */
  kind: 'search' | 'detail' | 'pdf';
  /** Stable identity of the unit, used to deduplicate. */
  key: string;
  /** URL or a description of the request. */
  target: string;
  /** HTTP status when there was a response. */
  status: number | null;
  /** Error message. */
  error: string;
  /** How many times it has been attempted in total. */
  attempts: number;
  /** ISO timestamp of the last attempt. */
  lastAttemptAt: string;
  /** Extra context needed to replay the unit. */
  context?: Record<string, unknown>;
}

/** Result of one PDF download attempt. */
export interface DownloadOutcome {
  ok: boolean;
  path: string | null;
  bytes: number;
  contentType: string | null;
  skipped: boolean;
  error?: string;
}
