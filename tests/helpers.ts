import request from 'supertest';
import bcrypt from 'bcryptjs';
import type { Role } from '@prisma/client';
import { createApp } from '../src/app';
import { prisma } from '../src/db';

export const app = createApp();
export const api = () => request(app);

export async function resetDb() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AuditLog","SignOff","ShareLink","Defect","Attachment","CaseEvent","RunCase","Run","TemplateCase","Project","Invite","User" CASCADE',
  );
}

export async function makeUser(role: Role, name = role.toLowerCase()) {
  const email = `${name.toLowerCase()}@test.local`;
  await prisma.user.create({ data: { email, name, role, passwordHash: await bcrypt.hash('password123', 4) } });
  const res = await api().post('/auth/login').send({ email, password: 'password123' }).expect(200);
  return { token: res.body.token as string, auth: { Authorization: `Bearer ${res.body.token}` }, user: res.body.user };
}

// A real 1x1 PNG.
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
