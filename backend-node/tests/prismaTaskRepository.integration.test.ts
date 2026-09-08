import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaTaskRepository } from '../src/repositories/prismaTaskRepository';

const databaseUrl = process.env.POSTGRES_TEST_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('PrismaTaskRepository on PostgreSQL', () => {
  let prisma: PrismaClient;
  let repository: PrismaTaskRepository;

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl! }) });
    repository = new PrismaTaskRepository(prisma);
  });

  beforeEach(async () => {
    await prisma.task.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('persists a task as the source of truth and enforces tenant-owner reads', async () => {
    const scope = { tenantId: 'tenant-a', ownerId: 'owner-a' };
    const created = await repository.create(scope, {
      title: 'PostgreSQL task', description: 'Stored through Prisma', urgent: true, important: false,
    });

    expect(created.replayed).toBe(false);
    expect(created.task._id).toMatch(/^[a-f0-9]{24}$/);
    await expect(repository.get(scope, created.task._id)).resolves.toMatchObject({
      title: 'PostgreSQL task', revision: 0, lifecycleState: 'active',
    });
    await expect(repository.get(
      { tenantId: 'tenant-b', ownerId: 'owner-a' }, created.task._id
    )).resolves.toBeNull();

    const maximumTitle = 'x'.repeat(200);
    await expect(repository.create(scope, {
      title: maximumTitle, description: '', urgent: false, important: false,
    })).resolves.toMatchObject({ task: { title: maximumTitle } });
  });

  it('preserves idempotent create replay, digest mismatch evidence, and deletion tombstones', async () => {
    const scope = { tenantId: 'tenant-a', ownerId: 'owner-a' };
    const payload = { title: 'Idempotent', description: '', urgent: false, important: true };
    const operation = { id: 'request-1', payloadDigest: 'a'.repeat(64) };

    const first = await repository.create(scope, payload, operation);
    const replay = await repository.create(scope, payload, operation);
    expect(replay).toMatchObject({
      replayed: true,
      storedPayloadDigest: operation.payloadDigest,
      operationDeleted: false,
    });
    expect(replay.task._id).toBe(first.task._id);

    const trashed = await repository.transitionLifecycle(scope, first.task._id, 0, 'trash');
    expect(trashed.status).toBe('updated');
    await expect(repository.delete(scope, first.task._id, 1)).resolves.toMatchObject({ _id: first.task._id });
    await expect(repository.get(scope, first.task._id)).resolves.toBeNull();
    await expect(repository.create(scope, payload, operation)).resolves.toMatchObject({
      replayed: true,
      storedPayloadDigest: operation.payloadDigest,
      operationDeleted: true,
    });
  });

  it('uses atomic revisions for updates and lifecycle transitions', async () => {
    const scope = { tenantId: 'tenant-a', ownerId: 'owner-a' };
    const created = await repository.create(scope, {
      title: 'Revision', description: '', urgent: false, important: false,
    });
    const [winner, stale] = await Promise.all([
      repository.update(scope, created.task._id, 0, { title: 'Winner' }),
      repository.update(scope, created.task._id, 0, { title: 'Stale' }),
    ]);
    expect([winner, stale].filter(Boolean)).toHaveLength(1);
    const current = await repository.get(scope, created.task._id);
    expect(current).toMatchObject({ revision: 1 });
    await expect(repository.transitionLifecycle(scope, created.task._id, 0, 'complete'))
      .resolves.toEqual({ status: 'revision_conflict' });
    await expect(repository.transitionLifecycle(scope, created.task._id, 1, 'complete'))
      .resolves.toMatchObject({ status: 'updated', task: { lifecycleState: 'completed', revision: 2 } });
    await expect(repository.transitionLifecycle(scope, created.task._id, 2, 'complete'))
      .resolves.toEqual({ status: 'invalid_transition' });
  });

  it('paginates deterministically and filters lifecycle state', async () => {
    const scope = { tenantId: 'tenant-a', ownerId: 'owner-a' };
    const ids: string[] = [];
    for (const title of ['one', 'two', 'three']) {
      ids.push((await repository.create(scope, {
        title, description: '', urgent: false, important: false,
      })).task._id);
    }
    const sameTimestamp = new Date('2026-09-07T12:00:00.000Z');
    await prisma.task.updateMany({ where: { id: { in: ids } }, data: { createdAt: sameTimestamp } });
    const firstPage = await repository.listPage(scope, 2, undefined, 'active');
    expect(firstPage.tasks.map((task) => task._id)).toEqual([...ids].sort().reverse().slice(0, 2));
    expect(firstPage.hasNextPage).toBe(true);
    const last = firstPage.tasks[1];
    const secondPage = await repository.listPage(scope, 2, { createdAt: last.createdAt, id: last._id }, 'active');
    expect(secondPage.tasks.map((task) => task._id)).toEqual([...ids].sort().reverse().slice(2));
    expect(secondPage.hasNextPage).toBe(false);
  });

  it('round-trips schedules and enforces delegated-user transitions', async () => {
    const scope = { tenantId: 'tenant-a', ownerId: 'owner-a' };
    const created = await repository.create(scope, {
      title: 'Delegated', description: '', urgent: false, important: false,
    });
    const dueAt = new Date('2026-09-08T08:00:00.000Z');
    const remindAt = new Date('2026-09-08T07:30:00.000Z');
    await expect(repository.updateSchedule(scope, created.task._id, 0, {
      dueAt, remindAt, timeZone: 'Europe/Warsaw',
    })).resolves.toMatchObject({ schedule: { dueAt, remindAt, timeZone: 'Europe/Warsaw' }, revision: 1 });
    await expect(repository.updateDelegation(scope, created.task._id, 1, {
      assigneeUserId: 'owner-b', displayLabel: 'Owner B', handoffNote: 'Please handle',
    })).resolves.toMatchObject({ delegation: { status: 'offered', assigneeUserId: 'owner-b' }, revision: 2 });
    await expect(repository.listDelegated(
      { tenantId: 'tenant-a', userId: 'owner-b' }, 10, 'active'
    )).resolves.toHaveLength(1);
    await expect(repository.transitionDelegation(
      { tenantId: 'tenant-a', userId: 'owner-b' }, created.task._id, 2, 'accepted'
    )).resolves.toMatchObject({ status: 'updated', task: { delegation: { status: 'accepted' }, revision: 3 } });
    await expect(repository.transitionDelegation(
      { tenantId: 'tenant-b', userId: 'owner-b' }, created.task._id, 3, 'in_progress'
    )).resolves.toEqual({ status: 'not_found' });
  });
});
