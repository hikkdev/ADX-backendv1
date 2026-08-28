import path from 'path';
import express from 'express';
import cors from 'cors';
import { apiRouter } from './register-modules';
import { errorHandler, notFound } from '../shared/errors';
import { requestLogger } from '../shared/logging';

/**
 * Assembles the Express application: global middleware, static uploads, the
 * versioned API surface, then the 404 and error terminators.
 *
 * Order matters and is asserted by tests/architecture/route-inventory.test.ts.
 */
export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(requestLogger);

  // Serve uploaded files as static assets
  app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

  app.use('/api/v1', apiRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
