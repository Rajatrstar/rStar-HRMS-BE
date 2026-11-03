/**
 * Gives every request an id and a start time. Mounted first in app.js.
 *
 * The id goes back on every response as X-Request-Id, and on a 5xx in
 * details.requestId too, and it is the RequestId of the dbo.tblErrorLog row
 * that failure wrote. So "the screen said something went wrong, ref 9f1c..."
 * is one lookup.
 *
 * An incoming X-Request-Id is kept when it is a UUID, so a proxy or the
 * frontend can stitch its own logs to ours. Anything else is replaced: the
 * column is a UNIQUEIDENTIFIER, and a client-chosen free-text id is a way to
 * write arbitrary strings into a log.
 */
import { randomUUID } from 'node:crypto';
import { REQUEST_ID_HEADER } from '../enums/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requestContext(req, res, next) {
  const incoming = req.get(REQUEST_ID_HEADER);

  req.requestId = incoming && UUID.test(incoming) ? incoming.toLowerCase() : randomUUID();
  req.startedAt = performance.now();
  res.setHeader(REQUEST_ID_HEADER, req.requestId);

  next();
}
