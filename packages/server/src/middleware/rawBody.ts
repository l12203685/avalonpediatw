import type { IncomingMessage } from 'http';
import express, { type Express, type Request } from 'express';

/**
 * Keep the exact request bytes next to the parsed JSON body.
 *
 * LINE signs the raw payload (HMAC-SHA256 over the bytes it sent). Re-serialising
 * `req.body` with JSON.stringify is byte-identical *most* of the time, but not
 * guaranteed (number formatting, escaping, key order from upstream proxies), and
 * a mismatch shows up as a silent 401 on every webhook — exactly the kind of
 * invisible failure the LINE/Discord sync keeps dying from. Verify against the
 * bytes instead.
 *
 * Usage: `express.json({ verify: captureRawBody })`.
 */
export interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

export function captureRawBody(req: IncomingMessage, _res: unknown, buf: Buffer): void {
  (req as RequestWithRawBody).rawBody = Buffer.from(buf);
}

/** The LINE webhook route (same as bots/line/webhookEndpoint.ts LINE_WEBHOOK_PATH). */
export const LINE_WEBHOOK_BODY_PATH = '/webhook/line';

/**
 * JSON body limit of the LINE webhook (2026-10-13). LINE may deliver several
 * events in one request, each text several thousand characters (a user may
 * send more than the 5000 a bot may); with express's default 100 kB a burst
 * of long messages was answered 413 and LINE dropped the whole delivery —
 * the short messages in it too. The body is parsed before the signature
 * check, as before; 1 MB of JSON costs milliseconds.
 */
export const LINE_WEBHOOK_JSON_LIMIT = '1mb';

/**
 * Mount the JSON body parsers, raw bytes kept (captureRawBody): the LINE
 * webhook first with LINE_WEBHOOK_JSON_LIMIT, then every other route with
 * the default limit (a body already parsed is not parsed again).
 */
export function mountJsonBodyParsers(app: Express): void {
  app.use(LINE_WEBHOOK_BODY_PATH, express.json({ limit: LINE_WEBHOOK_JSON_LIMIT, verify: captureRawBody }));
  app.use(express.json({ verify: captureRawBody }));
}
