import { migrationMode } from '../src/taskMigrationCli';

test('final task migration requires an explicit MongoDB write freeze', () => {
  expect(migrationMode({ TASK_MIGRATION_MODE: 'backfill' })).toBe('backfill');
  expect(() => migrationMode({ TASK_MIGRATION_MODE: 'final' }))
    .toThrow('MONGO_WRITES_FROZEN=true');
  expect(migrationMode({ TASK_MIGRATION_MODE: 'final', MONGO_WRITES_FROZEN: 'true' }))
    .toBe('final');
  expect(() => migrationMode({ TASK_MIGRATION_MODE: 'cutover' })).toThrow('backfill or final');
});
