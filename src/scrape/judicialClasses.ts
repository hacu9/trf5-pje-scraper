/**
 * The case class catalogue.
 *
 * The `Classe judicial` input is a RichFaces suggestion box. Verified quirk:
 * it IGNORES the typed prefix and answers with the whole catalogue, so a single
 * postback with any three letter seed returns every entry. One observed run
 * returned 132 pairs of `code = name`.
 *
 * The catalogue matters because it is the second axis the planner uses to break
 * a search slice that the server truncated at thirty rows. A search by class
 * needs only the NAME in the text input; the `..._selection` hidden field can
 * stay empty. Verified: the same eight rows came back with and without it.
 */

import * as fs from 'node:fs';
import { SearchView } from '../jsf/searchView';
import { config } from '../config';
import { log } from '../logger';
import { JudicialClass } from '../types';

export async function fetchJudicialClasses(view: SearchView): Promise<JudicialClass[]> {
  const envelope = await view.fetchClassSuggestions('ACA');
  const { $ } = envelope;

  const byIndex = new Map<string, { codigo?: string; nome?: string }>();

  $('table[id$=":suggest"] td[id]').each((_index, element) => {
    const id = $(element).attr('id') ?? '';
    // ids look like `fPP:j_id189:sgbClasseJudicial:<row>:<generated>`
    const parts = id.split(':');
    const row = parts[parts.length - 2];
    if (row === undefined || !/^\d+$/.test(row)) return;
    const value = $(element).text().replace(/\s+/g, ' ').trim();
    if (value === '') return;

    const entry = byIndex.get(row) ?? {};
    // The first populated cell of a row is the code, the second is the name.
    if (entry.codigo === undefined) entry.codigo = value;
    else if (entry.nome === undefined) entry.nome = value;
    byIndex.set(row, entry);
  });

  const classes: JudicialClass[] = [];
  for (const [, entry] of byIndex) {
    if (entry.codigo === undefined || entry.nome === undefined) continue;
    classes.push({ codigo: entry.codigo, nome: entry.nome });
  }
  classes.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

  log.info('read the classe judicial catalogue', { count: classes.length });
  return classes;
}

export function saveJudicialClasses(classes: JudicialClass[]): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(config.classesFile, JSON.stringify(classes, null, 2), 'utf8');
  log.info('wrote the classe judicial catalogue', { file: config.classesFile });
}

export function loadJudicialClasses(): JudicialClass[] {
  if (!fs.existsSync(config.classesFile)) return [];
  try {
    return JSON.parse(fs.readFileSync(config.classesFile, 'utf8')) as JudicialClass[];
  } catch {
    log.warn('the cached classe judicial catalogue is unreadable', { file: config.classesFile });
    return [];
  }
}
