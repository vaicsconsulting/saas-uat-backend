import bcrypt from 'bcryptjs';
import type { User } from '@prisma/client';
import { prisma } from '../db';

/**
 * An auth provider turns credentials into a known user.
 * Password auth is used now. Hub Portal SSO can be added later as another
 * provider (for example an OIDC code exchange) without touching the routes:
 * register it in `providers` and call POST /auth/sso/:provider.
 */
export interface AuthProvider {
  readonly name: string;
  authenticate(input: Record<string, unknown>): Promise<User | null>;
}

export const passwordProvider: AuthProvider = {
  name: 'password',
  async authenticate(input) {
    const email = String(input.email ?? '').trim().toLowerCase();
    const password = String(input.password ?? '');
    if (!email || !password) return null;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.active || !user.passwordHash) return null;
    const ok = await bcrypt.compare(password, user.passwordHash);
    return ok ? user : null;
  },
};

/**
 * Placeholder for hub Portal SSO. Disabled until the Portal exposes a
 * token exchange. Expected flow: Portal launch code -> verify with Portal ->
 * find or create user by email with authProvider = 'hub'.
 */
export const hubSsoProvider: AuthProvider = {
  name: 'hub',
  async authenticate() {
    return null;
  },
};

export const providers: Record<string, AuthProvider> = {
  password: passwordProvider,
  ...(process.env.AUTH_HUB_SSO_ENABLED === 'true' ? { hub: hubSsoProvider } : {}),
};

export const hashPassword = (p: string) => bcrypt.hash(p, 10);
