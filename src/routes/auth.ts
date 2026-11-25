import { Router } from 'express';
import { config } from '../config';
import { prisma } from '../db';
import { ah, badRequest, notFound, unauthorized } from '../lib/errors';
import { randomToken, sha256 } from '../lib/crypto';
import { hashPassword, providers } from '../auth/providers';
import { requireAuth, requireRole, ROLES, signToken } from '../auth/jwt';
import { AcceptInviteBody, InviteBody, LoginBody, UpdateUserBody } from '../schemas';
import { userDto } from '../services/serialize';
import { audit } from '../services/audit';

export const authRouter = Router();

authRouter.get('/auth/providers', (_req, res) => {
  res.json({ providers: Object.keys(providers) });
});

authRouter.post(
  '/auth/login',
  ah(async (req, res) => {
    const body = LoginBody.parse(req.body);
    const user = await providers.password.authenticate(body);
    if (!user) throw unauthorized('Wrong email or password');
    res.json({ token: signToken(user), user: userDto(user) });
  }),
);

authRouter.get(
  '/auth/me',
  requireAuth,
  ah(async (req, res) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    res.json(userDto(u));
  }),
);

authRouter.post(
  '/auth/invites',
  requireAuth,
  requireRole(...ROLES.admin),
  ah(async (req, res) => {
    const body = InviteBody.parse(req.body);
    const email = body.email.toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing?.passwordHash) throw badRequest('That person already has an account');
    const token = randomToken(24);
    const inv = await prisma.$transaction(async (tx) => {
      const i = await tx.invite.create({
        data: {
          email,
          name: body.name ?? null,
          role: body.role,
          tokenHash: sha256(token),
          expiresAt: new Date(Date.now() + config.inviteTtlHours * 3600_000),
          createdById: req.user!.id,
        },
      });
      await audit(tx, req.user, { action: 'user.invited', entity: 'invite', entityId: i.id, data: { email, role: body.role } });
      return i;
    });
    res.status(201).json({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      expiresAt: inv.expiresAt.toISOString(),
      inviteUrl: `${config.appUrl}/invite/${token}`,
    });
  }),
);

async function findInvite(token: string) {
  const inv = await prisma.invite.findUnique({ where: { tokenHash: sha256(token) } });
  if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) throw notFound('This invite link is not valid or has expired');
  return inv;
}

authRouter.get(
  '/auth/invites/:token',
  ah(async (req, res) => {
    const inv = await findInvite(String(req.params.token));
    res.json({ email: inv.email, name: inv.name, role: inv.role, expiresAt: inv.expiresAt.toISOString() });
  }),
);

authRouter.post(
  '/auth/accept-invite',
  ah(async (req, res) => {
    const body = AcceptInviteBody.parse(req.body);
    const inv = await findInvite(body.token);
    const passwordHash = await hashPassword(body.password);
    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.upsert({
        where: { email: inv.email },
        update: { name: body.name, passwordHash, role: inv.role, active: true },
        create: { email: inv.email, name: body.name, passwordHash, role: inv.role },
      });
      await tx.invite.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } });
      await audit(tx, { id: u.id, email: u.email, name: u.name, role: u.role }, { action: 'user.joined', entity: 'user', entityId: u.id });
      return u;
    });
    res.status(201).json({ token: signToken(user), user: userDto(user) });
  }),
);

authRouter.get(
  '/users',
  requireAuth,
  ah(async (_req, res) => {
    const users = await prisma.user.findMany({ orderBy: { name: 'asc' } });
    res.json(users.map(userDto));
  }),
);

authRouter.patch(
  '/users/:id',
  requireAuth,
  requireRole(...ROLES.admin),
  ah(async (req, res) => {
    const body = UpdateUserBody.parse(req.body);
    const id = String(req.params.id);
    if (id === req.user!.id && (body.active === false || (body.role && body.role !== 'ADMIN'))) {
      throw badRequest('You cannot remove your own admin access');
    }
    const u = await prisma.$transaction(async (tx) => {
      const x = await tx.user.update({ where: { id }, data: body });
      await audit(tx, req.user, { action: 'user.updated', entity: 'user', entityId: id, data: body });
      return x;
    });
    res.json(userDto(u));
  }),
);
