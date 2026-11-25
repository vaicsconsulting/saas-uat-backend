import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { prisma } from './db';
import { errorHandler, notFound } from './lib/errors';
import { storage } from './storage';
import { authRouter } from './routes/auth';
import { projectsRouter } from './routes/projects';
import { filesRouter, runsRouter } from './routes/runs';
import { publicRouter } from './routes/public';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin) return cb(null, true);
        const ok = config.corsOrigins.some((o) => o === origin || (o.startsWith('*.') && origin.endsWith(o.slice(1))));
        cb(null, ok);
      },
      credentials: false,
      exposedHeaders: ['Content-Disposition'],
    }),
  );
  app.use(filesRouter);
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', async (_req, res) => {
    let db = 'ok';
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'down';
    }
    res.status(db === 'ok' ? 200 : 503).json({ status: db === 'ok' ? 'ok' : 'degraded', service: 'saas-uat-backend', version: pkg.version, db, storage: storage().driver, time: new Date().toISOString() });
  });

  app.get('/openapi.json', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'openapi.json'));
  });

  app.use(authRouter);
  app.use(projectsRouter);
  app.use(runsRouter);
  app.use(publicRouter);
  app.use((_req, _res, next) => next(notFound('Route not found')));
  app.use(errorHandler);
  return app;
}
