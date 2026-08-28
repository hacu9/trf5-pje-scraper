/**
 * The one HTTP client every other module uses.
 *
 * What it adds on top of axios:
 *
 * * A cookie jar. The portal hands out JSESSIONID, ROUTER_ID (load balancer
 *   affinity) and two vendor cookies, and drops the session if any of them is
 *   missing on the next hop.
 * * Charset aware decoding. `listView.seam` answers ISO-8859-1 while its own
 *   `<meta http-equiv>` claims UTF-8, and the ajax postbacks answer UTF-8. We
 *   trust the HTTP header and decode with iconv-lite, so accented Portuguese
 *   survives.
 * * The politeness gate from rateLimiter.ts.
 * * Retry with exponential backoff and full jitter.
 *
 * ## The backoff policy
 *
 * Retryable conditions: HTTP 429, HTTP 408, any 5xx, and the transport level
 * errors ECONNRESET, ETIMEDOUT, ECONNABORTED, EAI_AGAIN, EPIPE, ENOTFOUND,
 * ECONNREFUSED and socket hang up. Everything else, a 404 above all, fails at
 * once because repeating it cannot change the answer.
 *
 * The wait before attempt n (n starts at 1) is
 *
 *     raw   = backoffBaseMs * 2 ** (n - 1)
 *     wait  = random(0, min(raw, backoffMaxMs))
 *
 * That is "full jitter": the wait is a uniform draw from the whole window, not
 * the window plus a small wobble. With several workers it spreads the retries
 * instead of lining them up on the same instant, which is exactly the failure a
 * fixed backoff creates.
 *
 * A `Retry-After` header wins over the computed wait whenever it is larger.
 * Both the seconds form and the HTTP date form are understood.
 *
 * A 429 also trips a shared cool down: after `coolDownAfter` consecutive 429
 * answers the client pauses EVERY request for `coolDownMs`. One slow worker
 * would otherwise keep walking into the same wall.
 */

import axios, { AxiosInstance, AxiosResponse, AxiosError } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as iconv from 'iconv-lite';
import { config } from '../config';
import { log } from '../logger';
import { RateLimiter, sleep } from './rateLimiter';
import { HttpFailure } from './errors';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 507, 509]);
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  'EAI_AGAIN',
  'EPIPE',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

export interface TextResponse {
  status: number;
  url: string;
  /** Body decoded with the charset the server declared. */
  text: string;
  headers: Record<string, string>;
  contentType: string | null;
}

export interface BinaryResponse {
  status: number;
  url: string;
  body: Buffer;
  headers: Record<string, string>;
  contentType: string | null;
  /** Filename taken from `content-disposition`, when the server sent one. */
  filename: string | null;
}

/** How many 3xx hops a single logical request may follow before it is refused. */
const MAX_REDIRECTS = 5;

export interface RequestOptions {
  /** Extra request headers merged over the defaults. */
  headers?: Record<string, string>;
  /** Form body. When present the request is a POST. */
  form?: URLSearchParams;
  /** Follow 3xx. Default true. The PDF endpoint needs it. */
  followRedirects?: boolean;
  /** A label used in the logs so a failure can be traced back to its caller. */
  label?: string;
  /**
   * Internal. How many redirects have already been followed for this logical
   * request. It exists so a redirect loop cannot reset the retry budget and
   * recurse forever.
   */
  redirectDepth?: number;
}

/** Counters worth printing at the end of a run. */
export interface HttpStats {
  requests: number;
  retries: number;
  rateLimited: number;
  bytesDown: number;
  failures: number;
}

export class HttpClient {
  readonly jar: CookieJar;
  private readonly axios: AxiosInstance;
  private readonly limiter: RateLimiter;
  private consecutive429 = 0;

  readonly stats: HttpStats = {
    requests: 0,
    retries: 0,
    rateLimited: 0,
    bytesDown: 0,
    failures: 0,
  };

  constructor(jar: CookieJar = new CookieJar()) {
    this.jar = jar;
    this.limiter = new RateLimiter(
      config.concurrency,
      config.requestDelayMs,
      config.requestJitterMs,
    );
    this.axios = wrapper(
      axios.create({
        jar,
        timeout: config.timeoutMs,
        // We decode the body ourselves, so ask axios for raw bytes.
        responseType: 'arraybuffer',
        maxRedirects: 0,
        // Never throw on a status. The retry policy decides what is fatal.
        validateStatus: () => true,
        decompress: true,
        headers: {
          'User-Agent': config.userAgent,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
          Connection: 'keep-alive',
        },
      }),
    );
  }

  /** Throw away every cookie. Used when a session goes stale and must be rebuilt. */
  async resetSession(): Promise<void> {
    await this.jar.removeAllCookies();
  }

  /** GET or POST a page and return the decoded text. */
  async requestText(url: string, options: RequestOptions = {}): Promise<TextResponse> {
    const response = await this.send(url, options);
    return {
      status: response.status,
      url: response.finalUrl,
      text: decodeBody(response.body, response.contentType),
      headers: response.headers,
      contentType: response.contentType,
    };
  }

  /** GET a binary body, following redirects. Used for the PDFs. */
  async requestBinary(url: string, options: RequestOptions = {}): Promise<BinaryResponse> {
    const response = await this.send(url, { ...options, followRedirects: true });
    return {
      status: response.status,
      url: response.finalUrl,
      body: response.body,
      headers: response.headers,
      contentType: response.contentType,
      filename: parseContentDisposition(response.headers['content-disposition'] ?? null),
    };
  }

  /**
   * One logical request: the politeness gate, the retry loop, and manual
   * redirect handling so the cookie jar is applied on every hop.
   */
  private async send(
    url: string,
    options: RequestOptions,
  ): Promise<{
    status: number;
    finalUrl: string;
    body: Buffer;
    headers: Record<string, string>;
    contentType: string | null;
  }> {
    const label = options.label ?? url;
    const follow = options.followRedirects !== false;
    const maxAttempts = config.maxRetries + 1;

    let lastStatus: number | null = null;
    let lastError = 'unknown error';

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let result: AxiosResponse<ArrayBuffer> | null = null;
      let transportCode: string | null = null;

      try {
        result = await this.limiter.run(async () => {
          this.stats.requests += 1;
          return this.axios.request<ArrayBuffer>({
            url,
            method: options.form === undefined ? 'GET' : 'POST',
            data: options.form === undefined ? undefined : options.form.toString(),
            headers: {
              ...(options.form === undefined
                ? {}
                : { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }),
              ...(options.headers ?? {}),
            },
          });
        });
      } catch (error) {
        const axiosError = error as AxiosError;
        transportCode = axiosError.code ?? null;
        lastError = axiosError.message;
      }

      if (result !== null) {
        const status = result.status;
        lastStatus = status;
        const headers = normaliseHeaders(result.headers as Record<string, unknown>);
        const body = Buffer.from(result.data ?? new ArrayBuffer(0));
        this.stats.bytesDown += body.byteLength;

        // Redirects. axios is configured with maxRedirects 0 so that the jar is
        // consulted again for every hop and so that a redirect chain cannot
        // silently escape the origin we intend to talk to.
        if (status >= 300 && status < 400 && headers['location'] !== undefined && follow) {
          const depth = options.redirectDepth ?? 0;
          if (depth >= MAX_REDIRECTS) {
            this.stats.failures += 1;
            throw new HttpFailure(
              `redirect loop: more than ${MAX_REDIRECTS} hops for ${label}`,
              status,
              url,
              attempt,
              false,
            );
          }
          const next = new URL(headers['location'], url).toString();
          log.debug('redirect', { from: label, to: next, status, hop: depth + 1 });
          return this.send(next, { ...options, label, redirectDepth: depth + 1 });
        }

        if (status === 429) {
          this.stats.rateLimited += 1;
          this.consecutive429 += 1;
          const wait = this.waitFor(attempt, headers['retry-after']);
          log.warn('rate limited, backing off', {
            label,
            attempt,
            of: maxAttempts,
            waitMs: wait,
            retryAfter: headers['retry-after'] ?? 'none',
            consecutive: this.consecutive429,
          });
          if (this.consecutive429 >= config.coolDownAfter) {
            log.warn('too many consecutive 429, pausing every worker', {
              pauseMs: config.coolDownMs,
            });
            this.limiter.pause(config.coolDownMs);
            this.consecutive429 = 0;
          }
          if (attempt === maxAttempts) break;
          this.stats.retries += 1;
          await sleep(wait);
          continue;
        }

        this.consecutive429 = 0;

        if (RETRYABLE_STATUS.has(status)) {
          lastError = `server answered ${status}`;
          if (attempt === maxAttempts) break;
          const wait = this.waitFor(attempt, headers['retry-after']);
          log.warn('retryable status, backing off', {
            label,
            status,
            attempt,
            of: maxAttempts,
            waitMs: wait,
          });
          this.stats.retries += 1;
          await sleep(wait);
          continue;
        }

        if (status >= 400) {
          this.stats.failures += 1;
          throw new HttpFailure(`HTTP ${status} for ${label}`, status, url, attempt, false);
        }

        return {
          status,
          finalUrl: url,
          body,
          headers,
          contentType: headers['content-type'] ?? null,
        };
      }

      // No response at all. Retry only the transport errors we know are transient.
      const retryable = transportCode !== null && RETRYABLE_CODES.has(transportCode);
      if (!retryable || attempt === maxAttempts) {
        this.stats.failures += 1;
        throw new HttpFailure(
          `${lastError} for ${label}`,
          null,
          url,
          attempt,
          retryable,
        );
      }
      const wait = this.waitFor(attempt, undefined);
      log.warn('transport error, backing off', {
        label,
        code: transportCode,
        attempt,
        of: maxAttempts,
        waitMs: wait,
      });
      this.stats.retries += 1;
      await sleep(wait);
    }

    this.stats.failures += 1;
    throw new HttpFailure(
      `gave up after ${maxAttempts} attempts: ${lastError}`,
      lastStatus,
      url,
      maxAttempts,
      true,
    );
  }

  /** Full jitter exponential backoff, raised to `Retry-After` when the server sent one. */
  private waitFor(attempt: number, retryAfter: string | undefined): number {
    return backoffWait(attempt, parseRetryAfter(retryAfter));
  }
}

/**
 * The backoff window for a given attempt, in milliseconds.
 *
 * Doubles per attempt and is capped, so with the defaults the windows are
 * 2s, 4s, 8s, 16s, 32s ... up to `BACKOFF_MAX_MS`.
 */
export function backoffWindow(attempt: number): number {
  return Math.min(config.backoffBaseMs * 2 ** (attempt - 1), config.backoffMaxMs);
}

/**
 * How long to wait before the next attempt.
 *
 * FULL JITTER: the wait is a uniform draw from the WHOLE window, not the window
 * plus a small wobble. The failure this avoids is retry synchronisation. If
 * several workers are throttled by the same event and every one of them backs
 * off deterministically, they all come back at the same instant and rebuild the
 * burst that caused the throttle in the first place.
 *
 * `retryAfterMs` wins whenever it is larger, because the server naming a time
 * beats our guess at one.
 *
 * `random` is a parameter so the policy can be tested without sampling.
 */
export function backoffWait(
  attempt: number,
  retryAfterMs: number | null,
  random: () => number = Math.random,
): number {
  const jittered = Math.floor(random() * backoffWindow(attempt));
  return Math.max(jittered, retryAfterMs ?? 0);
}

/** `Retry-After` is either a whole number of seconds or an HTTP date. */
export function parseRetryAfter(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - Date.now());
}

/** Read the charset out of `content-type` and decode. Defaults to UTF-8. */
export function decodeBody(body: Buffer, contentType: string | null): string {
  const match = contentType === null ? null : /charset=\s*"?([\w-]+)"?/i.exec(contentType);
  const charset = (match?.[1] ?? 'utf-8').toLowerCase();
  if (iconv.encodingExists(charset)) return iconv.decode(body, charset);
  return body.toString('utf8');
}

/**
 * Pull `filename` out of a `content-disposition` header.
 *
 * Handles the RFC 5987 `filename*=UTF-8''...` form and the plain form.
 *
 * The plain form also needs a repair pass. Node decodes every header value as
 * Latin-1, per RFC 7230, but this portal writes UTF-8 bytes into the header. So
 * the raw bytes are recovered and re decoded as UTF-8 whenever that produces
 * something valid. Without it a name like `Inspecao` comes back mangled.
 */
export function parseContentDisposition(value: string | null): string | null {
  if (value === null) return null;
  const star = /filename\*\s*=\s*[^']*''([^;]+)/i.exec(value);
  if (star?.[1] !== undefined) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      return star[1].trim();
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(value);
  const name = plain?.[1]?.trim();
  return name === undefined ? null : repairLatin1Header(name);
}

/** Re read a Latin-1 decoded header value as UTF-8 when that is what it really was. */
export function repairLatin1Header(value: string): string {
  if (!/[\u0080-\u00ff]/.test(value)) return value;
  const bytes = Buffer.from(value, 'latin1');
  const asUtf8 = bytes.toString('utf8');
  return asUtf8.includes('\uFFFD') ? value : asUtf8;
}

function normaliseHeaders(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}
