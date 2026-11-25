/* Seeds projects, one admin (from env) and sample V-Vault cases. Safe to run twice. */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import 'dotenv/config';
import cases from './seed-data/vvault-cases.json';

const prisma = new PrismaClient();

const PROJECTS = [
  { key: 'IMS', name: 'IMS', description: 'Inventory management app on the hub.', devBaseUrl: null },
  { key: 'VV', name: 'V-Vault', description: 'Secure file vault and transfer (V-Drive).', devBaseUrl: 'https://saas-v-drive-frontend-git-dev-vaics-consultings-projects.vercel.app' },
  { key: 'VS', name: 'V-Sign', description: 'Document e-signing app on the hub.', devBaseUrl: null },
];

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (email && password) {
    if (password.length < 8) throw new Error('SEED_ADMIN_PASSWORD must be at least 8 characters');
    const existing = await prisma.user.findUnique({ where: { email } });
    if (!existing) {
      await prisma.user.create({
        data: { email, name: process.env.SEED_ADMIN_NAME ?? 'Admin', role: 'ADMIN', passwordHash: await bcrypt.hash(password, 10) },
      });
      console.log(`admin created: ${email}`);
    } else {
      console.log(`admin exists: ${email}`);
    }
  } else {
    console.log('SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set, no admin created');
  }

  for (const p of PROJECTS) {
    await prisma.project.upsert({ where: { key: p.key }, update: {}, create: p });
  }
  const vv = await prisma.project.findUniqueOrThrow({ where: { key: 'VV' } });
  let added = 0;
  for (const [i, c] of cases.entries()) {
    const ex = await prisma.templateCase.findUnique({ where: { projectId_caseKey: { projectId: vv.id, caseKey: c.caseKey } } });
    if (!ex) {
      await prisma.templateCase.create({ data: { ...c, projectId: vv.id, sortOrder: i } });
      added++;
    }
  }
  console.log(`projects: ${PROJECTS.map((p) => p.key).join(', ')}; V-Vault sample cases added: ${added}`);
  console.log('Hub Portal dev: https://saas-portal-frontend-git-dev-vaics-consultings-projects.vercel.app');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
