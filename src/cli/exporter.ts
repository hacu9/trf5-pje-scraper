/**
 * CSV export.
 *
 * JSON Lines is what the crawler writes because it survives a kill. CSV is what
 * a reviewer opens. This module turns one into the other with no extra
 * dependency: the quoting rule of RFC 4180 is four lines long.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from '../config';
import { log } from '../logger';
import { readJsonLines } from '../store/persistence';
import { DocumentRow, DownloadRow } from '../store/persistence';
import { ProcessDetail } from '../types';

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(file: string, headers: string[], rows: unknown[][]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = [headers.join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\n');
  fs.writeFileSync(file, body + '\n', 'utf8');
  log.info('wrote csv', { file, rows: rows.length });
}

export async function exportCsv(): Promise<void> {
  const processes = await readJsonLines<ProcessDetail>(config.processesFile);
  const documents = await readJsonLines<DocumentRow>(config.documentsFile);
  const downloads = await readJsonLines<DownloadRow>(config.downloadsFile);

  // A document is written when its detail page is parsed and its PDF lands
  // later, so the local path is joined in here rather than stored twice.
  const localPath = new Map<string, string>();
  for (const row of downloads) localPath.set(row.idProcessoDocumento, row.arquivoLocal);

  writeCsv(
    path.join(config.dataDir, 'processes.csv'),
    [
      'numeroProcesso',
      'classeJudicial',
      'dataDistribuicao',
      'assunto',
      'jurisdicao',
      'orgaoJulgador',
      'orgaoJulgadorColegiado',
      'segredoJustica',
      'qtdPartes',
      'qtdMovimentacoes',
      'qtdDocumentos',
      'detailUrl',
      'scrapedAt',
    ],
    processes.map((row) => [
      row.numeroProcesso,
      row.classeJudicial,
      row.dataDistribuicao,
      row.assunto,
      row.jurisdicao,
      row.orgaoJulgador,
      row.orgaoJulgadorColegiado,
      row.segredoJustica,
      row.partes?.length ?? 0,
      row.movimentacoes?.length ?? 0,
      row.documentos?.length ?? 0,
      row.detailUrl,
      row.scrapedAt,
    ]),
  );

  writeCsv(
    path.join(config.dataDir, 'documents.csv'),
    [
      'numeroProcesso',
      'idProcessoDocumento',
      'data',
      'tipo',
      'nomeArquivo',
      'tamanhoTexto',
      'formato',
      'downloadUrl',
      'arquivoLocal',
    ],
    documents.map((row) => [
      row.numeroProcesso,
      row.idProcessoDocumento,
      row.data,
      row.tipo,
      row.nomeArquivo,
      row.tamanhoTexto,
      row.formato,
      row.downloadUrl,
      localPath.get(row.idProcessoDocumento) ?? null,
    ]),
  );
}
