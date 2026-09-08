import { createHash } from 'node:crypto';
import { Prisma, PrismaClient, Task as PrismaTask } from './generated/prisma/client';
import { TaskModel } from './models/task';

export interface TaskMigrationCursor {
  updatedAt: Date;
  id: string;
}

export interface TaskMigrationRecord {
  id: string;
  tenantId: string;
  ownerId: string;
  projectId: string | null;
  title: string;
  description: string;
  urgent: boolean;
  important: boolean;
  lifecycleState: string;
  priorLifecycleState: string | null;
  schedule: Prisma.InputJsonValue | null;
  delegation: Prisma.InputJsonValue | null;
  revision: number;
  createOperationId: string | null;
  createOperationDigest: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function jsonDates(value: unknown): Prisma.InputJsonValue | null {
  if (value === null || value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function migrationRecord(task: Record<string, any>): TaskMigrationRecord {
  const record = {
    id: String(task._id ?? task.id),
    tenantId: task.tenantId ?? 'local',
    ownerId: task.ownerId ?? 'local-user',
    projectId: task.projectId ?? null,
    title: task.title,
    description: task.description ?? '',
    urgent: task.urgent ?? false,
    important: task.important ?? false,
    lifecycleState: task.lifecycleState ?? 'active',
    priorLifecycleState: task.priorLifecycleState ?? null,
    schedule: jsonDates(task.schedule),
    delegation: jsonDates(task.delegation),
    revision: task.revision ?? task.__v ?? 0,
    createOperationId: task.createOperationId ?? null,
    createOperationDigest: task.createOperationDigest ?? null,
    deletedAt: task.deletedAt ?? null,
    createdAt: new Date(task.createdAt),
    updatedAt: new Date(task.updatedAt),
  } satisfies TaskMigrationRecord;
  if (!/^[a-f0-9]{24}$/.test(record.id)) throw new Error(`invalid task id for migration: ${record.id}`);
  if (typeof record.title !== 'string' || record.title.length < 1 || record.title.length > 200) {
    throw new Error(`invalid title for migrated task: ${record.id}`);
  }
  if (!['active', 'completed', 'archived', 'trashed'].includes(record.lifecycleState)) {
    throw new Error(`invalid lifecycle state for migrated task: ${record.id}`);
  }
  if (!Number.isInteger(record.revision) || record.revision < 0) {
    throw new Error(`invalid revision for migrated task: ${record.id}`);
  }
  return record;
}

export async function exportMongoTaskBatch(options: {
  upperBound: Date;
  limit: number;
  after?: TaskMigrationCursor;
}) {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1_000) {
    throw new Error('migration batch limit must be between 1 and 1000');
  }
  const filter = {
    updatedAt: { $lte: options.upperBound },
    ...(options.after ? {
      $or: [
        { updatedAt: { $gt: options.after.updatedAt, $lte: options.upperBound } },
        { updatedAt: options.after.updatedAt, _id: { $gt: options.after.id } },
      ],
    } : {}),
  };
  const tasks = await TaskModel.find(filter)
    .select('+createOperationId +createOperationDigest +deletedAt +priorLifecycleState')
    .sort({ updatedAt: 1, _id: 1 })
    .limit(options.limit)
    .lean();
  const records = tasks.map((task) => migrationRecord(task as unknown as Record<string, any>));
  const last = records.at(-1);
  return {
    records,
    nextCursor: last && records.length === options.limit
      ? { updatedAt: last.updatedAt, id: last.id }
      : undefined,
  };
}

function prismaData(record: TaskMigrationRecord): Prisma.TaskUncheckedCreateInput {
  return {
    ...record,
    schedule: record.schedule ?? Prisma.JsonNull,
    delegation: record.delegation ?? Prisma.JsonNull,
  };
}

export async function importTaskRecords(prisma: PrismaClient, records: TaskMigrationRecord[]) {
  let inserted = 0;
  let updated = 0;
  let staleSkipped = 0;
  for (const record of records) {
    const existing = await prisma.task.findUnique({ where: { id: record.id }, select: { revision: true } });
    if (existing && existing.revision > record.revision) {
      staleSkipped += 1;
      continue;
    }
    const data = prismaData(record);
    await prisma.task.upsert({ where: { id: record.id }, create: data, update: data });
    if (existing) updated += 1;
    else inserted += 1;
  }
  return { inserted, updated, staleSkipped };
}

function canonical(record: TaskMigrationRecord) {
  return JSON.stringify({
    ...record,
    deletedAt: record.deletedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

function digest(records: TaskMigrationRecord[]) {
  const hash = createHash('sha256');
  for (const record of [...records].sort((left, right) => left.id.localeCompare(right.id))) {
    hash.update(canonical(record));
    hash.update('\n');
  }
  return hash.digest('hex');
}

export async function verifyTaskRecords(prisma: PrismaClient, source: TaskMigrationRecord[]) {
  const rows = await prisma.task.findMany({ where: { id: { in: source.map((record) => record.id) } } });
  const target = rows.map((row: PrismaTask) => migrationRecord(row as unknown as Record<string, any>));
  const sourceDigest = digest(source);
  const targetDigest = digest(target);
  return {
    matches: source.length === target.length && sourceDigest === targetDigest,
    count: target.length,
    sourceDigest,
    targetDigest,
  };
}
