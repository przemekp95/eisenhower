import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';
import { TaskModel } from './models/task';
import { exportMongoTaskBatch, importTaskRecords, TaskMigrationCursor, verifyTaskRecords } from './taskMigration';

type MigrationMode = 'backfill' | 'final';

export function migrationMode(env: NodeJS.ProcessEnv): MigrationMode {
  const mode = env.TASK_MIGRATION_MODE ?? 'backfill';
  if (!['backfill', 'final'].includes(mode)) {
    throw new Error('TASK_MIGRATION_MODE must be backfill or final');
  }
  if (mode === 'final' && env.MONGO_WRITES_FROZEN !== 'true') {
    throw new Error('final migration requires MONGO_WRITES_FROZEN=true');
  }
  return mode as MigrationMode;
}

function required(env: NodeJS.ProcessEnv, name: 'MONGODB_URI' | 'DATABASE_URL') {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function initialCursor(env: NodeJS.ProcessEnv, mode: MigrationMode): TaskMigrationCursor | undefined {
  const updatedAt = env.TASK_MIGRATION_AFTER_UPDATED_AT?.trim();
  const id = env.TASK_MIGRATION_AFTER_ID?.trim();
  if (mode === 'final' && (updatedAt || id)) {
    throw new Error('final migration must verify the complete source and cannot resume after a cursor');
  }
  if (!updatedAt && !id) return undefined;
  if (!updatedAt || !id || !/^[a-f0-9]{24}$/.test(id)) {
    throw new Error('incremental cursor requires TASK_MIGRATION_AFTER_UPDATED_AT and a 24-hex TASK_MIGRATION_AFTER_ID');
  }
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) throw new Error('TASK_MIGRATION_AFTER_UPDATED_AT is invalid');
  return { updatedAt: date, id };
}

export async function runTaskMigration(env: NodeJS.ProcessEnv = process.env) {
  const mode = migrationMode(env);
  const upperBound = env.TASK_MIGRATION_UPPER_BOUND
    ? new Date(env.TASK_MIGRATION_UPPER_BOUND)
    : new Date();
  if (Number.isNaN(upperBound.getTime())) throw new Error('TASK_MIGRATION_UPPER_BOUND is invalid');
  const batchSize = Number(env.TASK_MIGRATION_BATCH_SIZE ?? 500);
  let cursor = initialCursor(env, mode);
  let inserted = 0;
  let updated = 0;
  let staleSkipped = 0;
  let sourceCount = 0;
  const batchDigests: string[] = [];

  await mongoose.connect(required(env, 'MONGODB_URI'));
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: required(env, 'DATABASE_URL') }),
  });
  try {
    await prisma.$connect();
    while (true) {
      const batch = await exportMongoTaskBatch({ upperBound, limit: batchSize, ...(cursor ? { after: cursor } : {}) });
      if (batch.records.length === 0) break;
      const imported = await importTaskRecords(prisma, batch.records);
      const parity = await verifyTaskRecords(prisma, batch.records);
      if (!parity.matches) throw new Error('task migration batch checksum parity failed');
      inserted += imported.inserted;
      updated += imported.updated;
      staleSkipped += imported.staleSkipped;
      sourceCount += batch.records.length;
      batchDigests.push(parity.sourceDigest);
      cursor = batch.nextCursor;
      if (!cursor) break;
    }

    const totalSourceCount = mode === 'final'
      ? await TaskModel.countDocuments({ updatedAt: { $lte: upperBound } })
      : undefined;
    const totalTargetCount = mode === 'final' ? await prisma.task.count() : undefined;
    if (mode === 'final' && (staleSkipped !== 0 || totalSourceCount !== totalTargetCount)) {
      throw new Error('final task migration count or revision parity failed');
    }
    const evidence = {
      evidenceVersion: 'mongo-postgres-task-migration-v1',
      mode,
      upperBound: upperBound.toISOString(),
      sourceCount,
      inserted,
      updated,
      staleSkipped,
      ...(totalSourceCount === undefined ? {} : { totalSourceCount, totalTargetCount }),
      batchDigest: createHash('sha256').update(batchDigests.join('\n')).digest('hex'),
      taskRepositoryCutoverEligible: mode === 'final',
      calendarBoundary: 'not_migrated_fail_closed',
    };
    return {
      ...evidence,
      evidenceChecksum: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
    };
  } finally {
    await Promise.allSettled([prisma.$disconnect(), mongoose.disconnect()]);
  }
}

if (require.main === module) {
  runTaskMigration().then(
    (evidence) => console.info(JSON.stringify(evidence)),
    (error) => {
      console.error(JSON.stringify({
        event: 'task_migration_failed',
        error: error instanceof Error ? error.message : 'unknown error',
      }));
      process.exitCode = 1;
    },
  );
}
