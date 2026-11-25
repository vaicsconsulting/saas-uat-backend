import jwt, { type SignOptions } from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import type { Role } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../db';
import { forbidden, unauthorized } from '../lib/errors';

interface Claims {
  sub: string;
  role: Role;
}

export function signToken(user: { id: string; role: Role }): string {
  return jwt.sign({ sub: user.id, role: user.role } satisfies Claims, config.jwtSecret, {
    expiresIn: config.jwtTtl as SignOptions['expiresIn'],
    issuer: 'saas-uat',
  });
}

function readToken(req: Request): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  // EventSource cannot set headers, so SSE passes the token as a query value.
  if (typeof req.query.access_token === 'string') return req.query.access_token;
  return null;
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = readToken(req);
    if (!token) throw unauthorized();
    let claims: Claims;
    try {
      claims = jwt.verify(token, config.jwtSecret, { issuer: 'saas-uat' }) as unknown as Claims;
    } catch {
      throw unauthorized('Your session ended. Sign in again');
    }
    const user = await prisma.user.findUnique({ where: { id: claims.sub } });
    if (!user || !user.active) throw unauthorized();
    req.user = { id: user.id, email: user.email, name: user.name, role: user.role };
    next();
  } catch (e) {
    next(e);
  }
}

export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };

export const ROLES = {
  admin: ['ADMIN'] as Role[],
  testers: ['ADMIN', 'TESTER'] as Role[],
  devs: ['ADMIN', 'DEVELOPER'] as Role[],
  workers: ['ADMIN', 'TESTER', 'DEVELOPER'] as Role[],
};
