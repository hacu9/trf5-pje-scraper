/**
 * PDF downloader.
 *
 * The link on a document row is not a static file. It is a Seam action:
 *
 *     GET .../listView.seam?idBin=...&numeroDocumento=...&nomeArqProcDocBin=...
 *         &idProcessoDocumento=...&actionMethod=...setDownloadInstance(row)
 *     302 Location: /pjeconsulta/download.seam?cid=<conversationId>
 *     200 content-type: application/pdf
 *         content-disposition: filename="Despacho"
 *
 * The `cid` is a fresh Seam conversation minted by the first hop, so the two
 * hops belong together and the redirect must be followed inside the same jar.
 * VERIFIED that the pair works from a completely fresh cookie jar that never
 * loaded the detail page, so no warm up request is needed.
 *
 * ## Filenames
 *
 * `<case number>/<sequence>_<yyyy-MM-dd>_<document type>_<document id>.pdf`
 *
 * One directory per case keeps a large run navigable. The date is reordered so
 * a plain sort is chronological. The PJe document id is the tail because it is
 * the only part guaranteed unique, which makes the name both descriptive and
 * collision free.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { HttpClient } from '../http/client';
import { HttpFailure, ContentError } from '../http/errors';
import { config } from '../config';
import { log } from '../logger';
import { DocumentRef, DownloadOutcome } from '../types';
import { documentSlug, slugify } from './detailParser';

const PDF_MAGIC = Buffer.from('%PDF');

export class PdfDownloader {
  constructor(private readonly http: HttpClient) {}

  /** Where a document's PDF will live, relative to the PDF directory. */
  relativePath(numeroProcesso: string, document: DocumentRef, index: number): string {
    const caseDir = slugify(numeroProcesso || 'sem-numero');
    const sequence = String(index + 1).padStart(4, '0');
    const date = reorderDate(document.data);
    const parts = [sequence, date, documentSlug(document), document.idProcessoDocumento].filter(
      (part) => part !== null && part !== '',
    );
    return path.join(caseDir, `${parts.join('_')}.pdf`);
  }

  /**
   * Fetch one document.
   *
   * Anything that fails here is reported through the return value rather than
   * thrown, so the caller can record the failure and move straight on to the
   * next document. That is the behaviour the exercise asks for.
   */
  async download(
    numeroProcesso: string,
    document: DocumentRef,
    index: number,
  ): Promise<DownloadOutcome> {
    if (document.formato !== 'pdf' || document.downloadUrl === null) {
      return {
        ok: false,
        path: null,
        bytes: 0,
        contentType: null,
        skipped: true,
        error: 'the row offers no public PDF link, only the login gated HTML view',
      };
    }

    const relative = this.relativePath(numeroProcesso, document, index);
    const absolute = path.join(config.pdfDir, relative);

    if (config.skipExistingPdfs && fs.existsSync(absolute) && fs.statSync(absolute).size > 0) {
      log.debug('pdf already on disk, skipping', { file: relative });
      return {
        ok: true,
        path: relative,
        bytes: fs.statSync(absolute).size,
        contentType: 'application/pdf',
        skipped: true,
      };
    }

    try {
      const response = await this.http.requestBinary(document.downloadUrl, {
        label: `pdf ${document.idProcessoDocumento}`,
        headers: { Accept: 'application/pdf,*/*' },
      });

      const contentType = response.contentType ?? '';
      const body = response.body;

      // A wrong body normally means the session bounced to the login view.
      // Never write that to disk under a .pdf name.
      if (!contentType.toLowerCase().includes('pdf') && !body.subarray(0, 4).equals(PDF_MAGIC)) {
        throw new ContentError(
          `expected a PDF, got ${contentType || 'no content type'} (${body.byteLength} bytes)`,
          document.downloadUrl,
          response.contentType,
        );
      }
      if (body.byteLength === 0) {
        throw new ContentError('the server returned an empty body', document.downloadUrl, contentType);
      }
      if (body.byteLength > config.maxPdfBytes) {
        throw new ContentError(
          `body of ${body.byteLength} bytes is over the ${config.maxPdfBytes} byte limit`,
          document.downloadUrl,
          contentType,
        );
      }

      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      // Write to a temporary name first so a kill never leaves a half PDF that
      // the resume logic would then treat as complete.
      const temporary = `${absolute}.part`;
      fs.writeFileSync(temporary, body);
      fs.renameSync(temporary, absolute);

      log.info('downloaded pdf', {
        file: relative,
        bytes: body.byteLength,
        servedAs: response.filename ?? 'unnamed',
      });

      return {
        ok: true,
        path: relative,
        bytes: body.byteLength,
        contentType: response.contentType,
        skipped: false,
      };
    } catch (error) {
      const message =
        error instanceof HttpFailure || error instanceof ContentError
          ? error.message
          : (error as Error).message;
      return {
        ok: false,
        path: null,
        bytes: 0,
        contentType: null,
        skipped: false,
        error: message,
      };
    }
  }
}

/** `dd/MM/yyyy HH:mm:ss` becomes `yyyy-MM-dd`, so filenames sort by date. */
function reorderDate(value: string | null): string {
  if (value === null) return 'sem-data';
  const match = /(\d{2})\/(\d{2})\/(\d{4})/.exec(value);
  if (match === null) return 'sem-data';
  return `${match[3]}-${match[2]}-${match[1]}`;
}
