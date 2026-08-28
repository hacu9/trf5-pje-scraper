/**
 * How the scraper enumerates "all pages" on a site that has no pages.
 *
 * ## The problem
 *
 * The exercise says to navigate every page of results. This portal has none.
 * The result grid is a RichFaces table whose datascroller renders EMPTY, and
 * the server truncates any result set at thirty rows with the banner
 *
 *     Sua consulta retornou muitos processos e somente os 30 primeiros serao
 *     exibidos. Por favor, refine sua pesquisa.
 *
 * Verified at 1, 2, 5, 8, 9, 18, 22 and 30 rows: a second page never appears.
 * So there is no "next page" postback to drive, and asking for one would be
 * inventing a mechanism the site does not have.
 *
 * ## The answer
 *
 * The equivalent of paging here is to SUBDIVIDE the query until every slice
 * fits under the cap. The planner keeps a work queue of cells. A cell is a set
 * of search criteria. When a cell comes back truncated it is replaced by its
 * children:
 *
 * 1. If the cell covers more than one filing day, split the date window in
 *    half. Binary subdivision, so a busy month costs about log2(days) extra
 *    searches rather than one per day.
 * 2. Otherwise, if the cell carries no case class, fan it out across the 132
 *    entries of the class catalogue, keeping the same single day.
 * 3. Otherwise the cell is SATURATED: one class on one day still overflows.
 *    The portal offers no third axis that partitions cleanly, so the cell is
 *    recorded in `state.json` under `saturatedCells` and coverage inside it is
 *    knowingly incomplete. Verified that this really happens: `APELACAO CIVEL`
 *    filed on 19/08/2026 returned the cap.
 *
 * Recording the saturated cells is the point. A scraper that silently drops
 * rows is worse than one that says which slice it could not finish.
 */

import { SearchCriteria, JudicialClass } from '../types';

export interface PlanCell {
  /** Stable identity used for resume and for the saturated list. */
  key: string;
  criteria: SearchCriteria;
  /** How many times this cell has already been subdivided. For the logs. */
  depth: number;
}

export interface PlanOptions {
  /** Filing date window, `dd/MM/yyyy`. Both ends inclusive. */
  dataInicio?: string;
  dataFim?: string;
  /** Fixed criteria that are never subdivided, for a targeted run. */
  nomeParte?: string;
  nomeAdvogado?: string;
  numeroProcesso?: string;
  classeJudicial?: string;
  /** Class catalogue used for the second axis. */
  classes?: JudicialClass[];
}

export class Planner {
  private readonly queue: PlanCell[] = [];
  private readonly classes: JudicialClass[];

  constructor(options: PlanOptions) {
    this.classes = options.classes ?? [];
    this.queue.push(...seedCells(options));
  }

  get pending(): number {
    return this.queue.length;
  }

  next(): PlanCell | undefined {
    return this.queue.shift();
  }

  /**
   * Replace a truncated cell with its children.
   * Returns false when the cell cannot be subdivided any further.
   */
  subdivide(cell: PlanCell): boolean {
    const children = this.childrenOf(cell);
    if (children.length === 0) return false;
    // Depth first, so a busy slice is finished before the next one starts and
    // the resume state stays meaningful.
    this.queue.unshift(...children);
    return true;
  }

  private childrenOf(cell: PlanCell): PlanCell[] {
    const { dataInicio, dataFim } = cell.criteria;

    if (dataInicio !== undefined && dataFim !== undefined) {
      const halves = splitRange(dataInicio, dataFim);
      if (halves !== null) {
        return halves.map(([from, to]) =>
          makeCell({ ...cell.criteria, dataInicio: from, dataFim: to }, cell.depth + 1),
        );
      }
    }

    if (cell.criteria.classeJudicial === undefined && this.classes.length > 0) {
      return this.classes.map((entry) =>
        makeCell({ ...cell.criteria, classeJudicial: entry.nome }, cell.depth + 1),
      );
    }

    return [];
  }
}

function seedCells(options: PlanOptions): PlanCell[] {
  const base: SearchCriteria = {};
  if (options.numeroProcesso !== undefined) base.numeroProcesso = options.numeroProcesso;
  if (options.nomeParte !== undefined) base.nomeParte = options.nomeParte;
  if (options.nomeAdvogado !== undefined) base.nomeAdvogado = options.nomeAdvogado;
  if (options.classeJudicial !== undefined) base.classeJudicial = options.classeJudicial;
  if (options.dataInicio !== undefined) base.dataInicio = options.dataInicio;
  if (options.dataFim !== undefined) base.dataFim = options.dataFim;

  const hasCriterion = Object.values(base).some((value) => value !== undefined && value !== '');
  if (!hasCriterion) {
    throw new Error(
      'at least one search criterion is required; the portal refuses an empty search with ' +
        '"Pelo menos um dos criterios de pesquisa deve ser informado"',
    );
  }
  return [makeCell(base, 0)];
}

export function makeCell(criteria: SearchCriteria, depth: number): PlanCell {
  return { key: cellKey(criteria), criteria, depth };
}

/** A stable, readable identity for a set of criteria. */
export function cellKey(criteria: SearchCriteria): string {
  return (
    Object.entries(criteria)
      .filter(([, value]) => value !== undefined && value !== '')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${String(value)}`)
      .join('|') || '(empty)'
  );
}

// ---- date helpers ---------------------------------------------------------

/**
 * `dd/MM/yyyy` to a UTC timestamp. UTC avoids a daylight saving off by one.
 *
 * The round trip check is not decoration. `Date.UTC(2026, 1, 31)` does not
 * fail, it rolls over to 3 March, so `31/02/2026` would silently search the
 * wrong window. A typo in a date flag must stop the run, not shift it.
 */
export function parseDate(value: string): number {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (match === null) throw new Error(`expected a date as dd/MM/yyyy, got ${value}`);
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const back = new Date(timestamp);
  if (
    back.getUTCDate() !== day ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCFullYear() !== year
  ) {
    throw new Error(`${value} is not a real date`);
  }
  return timestamp;
}

export function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getUTCFullYear()}`;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Split an inclusive date range into two halves.
 * Returns null when the range is a single day and cannot be split.
 */
export function splitRange(from: string, to: string): Array<[string, string]> | null {
  const start = parseDate(from);
  const end = parseDate(to);
  if (end <= start) return null;
  const days = Math.round((end - start) / DAY) + 1;
  const firstHalf = Math.floor(days / 2);
  const middle = start + (firstHalf - 1) * DAY;
  return [
    [formatDate(start), formatDate(middle)],
    [formatDate(middle + DAY), formatDate(end)],
  ];
}
