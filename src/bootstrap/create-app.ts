import path from 'path';
import express from 'express';
import cors from 'cors';
import { env } from '../config/env';
import { apiRouter } from './register-modules';
import { errorHandler, notFound } from '../shared/errors';
import { requestId } from '../shared/http';
import { requestLogger } from '../shared/logging';
import { auditAdminWrites } from '../shared/audit';
import { trackingRouter } from '../modules/campaigns';
import { packageLinkRouter } from '../modules/packages';
import { spotPageRouter } from '../modules/listings';
import { statusRouter } from '../modules/ops';

/**
 * Assembles the Express application: global middleware, static uploads, the
 * versioned API surface, then the 404 and error terminators.
 *
 * Order matters and is asserted by tests/architecture/route-inventory.test.ts.
 */
export function createApp(): express.Express {
  const app = express();

  /*
   * Behind a proxy, `req.ip` is the proxy until Express is told otherwise —
   * and every per-IP limiter in shared/security keys on `req.ip`. Off unless
   * the environment says what is in front of it (config/trust-proxy.ts).
   */
  if (env.TRUST_PROXY !== false) app.set('trust proxy', env.TRUST_PROXY);

  app.disable('x-powered-by');
  // First, before anything can log or fail: every later layer reads
  // req.requestId, and the header is echoed on every response including 404s.
  app.use(requestId);
  app.use(cors());
  // The raw buffer is kept alongside the parsed body so webhook signatures can
  // be checked against the exact bytes the provider sent.
  app.use(
    express.json({
      limit: '10mb',
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(requestLogger);
  // Registers a 'finish' listener only; the row is written after the response
  // has gone, for successful ADMIN writes nobody audited by hand (shared/audit).
  app.use(auditAdminWrites);

  // Serve uploaded files as static assets
  app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));
  // QR-9: the DR 11 brand files — the wordmark, the mark, the icon tile — the
  // defaults `GET /app/branding` points every surface at. Long-cached: a
  // retuned brand is a different URL (an upload), never a changed file here.
  app.use('/brand', express.static(path.join(process.cwd(), 'public', 'brand'), { maxAge: '7d', immutable: true }));

  /*
   * The campaign scan redirect. Deliberately outside /api/v1: this URL is
   * printed on a hoarding, and every character somebody might have to read off
   * a wall and type into a phone is a character that can be misread.
   */
  app.use(trackingRouter);

  /*
   * The package payment link. Root-mounted for the same reason as the scan
   * redirect: it is sent by SMS to somebody who may end up typing it.
   */
  app.use(packageLinkRouter);

  /*
   * E11-2: the public spot page a shared link opens (`/s/:displayId`). Root-
   * mounted like the two above: it is sent to somebody who may have neither
   * an account nor the app, and it has to open on any phone.
   */
  app.use(spotPageRouter);

  /*
   * Lot G (Q130): the public status page (`/status`) and its subscribe,
   * confirm and unsubscribe links. Root-mounted for the same reason again:
   * it is read during an outage by people with no account, and the links
   * arrive by email. Rate-limited by IP inside the router.
   */
  app.use(statusRouter);

  app.use('/api/v1', apiRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
