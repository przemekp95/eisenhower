import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { TaskModel } from '../src/models/task';
import { exportMongoTaskBatch, importTaskRecords, verifyTaskRecords } from '../src/taskMigration';
import { clearMongo, startMongo, stopMongo } from './helpers/mongo';

const databaseUrl = process.env.POSTGRES_TEST_URL;
const describeMigration = databaseUrl ? describe : describe.skip;

describeMigration('incremental MongoDB to PostgreSQL task migration', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    await startMongo();
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl! }) });
  });

  afterEach(async () => {
    await clearMongo();
    await prisma.task.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await stopMongo();
  });

  it('backfills active and deleted tasks idempotently with checksum parity', async () => {
    const first = await TaskModel.create({
      tenantId: 'tenant-a', ownerId: 'owner-a', title: 'Active', urgent: true, important: false,
    });
    const deleted = await TaskModel.create({
      tenantId: 'tenant-a', ownerId: 'owner-a', title: 'Deleted', urgent: false, important: true,
    });
    await TaskModel.collection.updateOne(
      { _id: deleted._id },
      { $set: { deletedAt: new Date('2026-09-07T12:00:00.000Z'), createOperationId: 'op-1', createOperationDigest: 'a'.repeat(64) } },
    );

    const batch = await exportMongoTaskBatch({ upperBound: new Date(Date.now() + 1_000), limit: 100 });
    expect(batch.records.map((record) => record.id).sort()).toEqual([first.id, deleted.id].sort());
    await expect(importTaskRecords(prisma, batch.records)).resolves.toMatchObject({ inserted: 2, updated: 0 });
    await expect(importTaskRecords(prisma, batch.records)).resolves.toMatchObject({ inserted: 0, updated: 2 });
    await expect(verifyTaskRecords(prisma, batch.records)).resolves.toMatchObject({
      matches: true, count: 2, sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(prisma.task.findUnique({ where: { id: deleted.id } })).resolves.toMatchObject({
      deletedAt: new Date('2026-09-07T12:00:00.000Z'), createOperationId: 'op-1',
    });
  });
});
