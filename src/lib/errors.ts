import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'error', public details?: unknown) {
    super(message);
  }
}

export const badRequest = (m: string, d?: unknown) => new HttpError(400, m, 'bad_request', d);
export const unauthorized = (m = 'Sign in first') => new HttpError(401, m, 'unauthorized');
export const forbidden = (m = 'You do not have access to this') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'Not found') => new HttpError(404, m, 'not_found');
export const conflict = (m: string, d?: unknown) => new HttpError(409, m, 'conflict', d);
export const locked = (m = 'This run is signed off and locked') => new HttpError(423, m, 'locked');

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: 'validation', message: 'Check the fields and try again', details: err.issues } });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  const e = err as { code?: string; type?: string; status?: number };
  if (e?.code === 'P2002') {
    res.status(409).json({ error: { code: 'conflict', message: 'That already exists' } });
    return;
  }
  if (e?.code === 'P2025') {
    res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
    return;
  }
  if (e?.type === 'entity.too.large' || e?.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: { code: 'too_large', message: 'File is too large' } });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong' } });
}

export const ah =
  <T extends Request>(fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: T, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
