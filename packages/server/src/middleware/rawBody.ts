import type { IncomingMessage } from 'http';
import type { Request } from 'express';

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
