import type { Prisma } from '@prisma/client';
import type { Tx } from '../db';
import type { AuthUser } from '../types';

export interface AuditInput {
  runId?: string | null;
  projectId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  data?: Prisma.InputJsonValue;
}

export async function audit(tx: Tx, actor: AuthUser | null | undefined, a: AuditInput): Promise<void> {
  await tx.auditLog.create({
    data: {
      runId: a.runId ?? null,
      projectId: a.projectId ?? null,
      actorId: actor?.id ?? null,
      actorName: actor?.name ?? null,
      action: a.action,
      entity: a.entity,
      entityId: a.entityId ?? null,
      data: a.data,
    },
  });
}
