import path from 'node:path';
import { Client } from 'pg';
import { runPostgresMigrations } from '../src/postgresMigrations';

const adminUrl = process.env.POSTGRES_TEST_URL;
const describeIfPostgres = adminUrl ? describe : describe.skip;

describeIfPostgres('PostgreSQL deployment migrations', () => {
  const database = 'eisenhower_migration_test';
  const appRole = 'eisenhower_migration_app';
  const appPassword = 'local-migration-test-password';
  let admin: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${appRole}`);
    await admin.query(`CREATE DATABASE ${database}`);
  });

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${appRole}`);
    await admin.end();
  });

  it('applies migrations idempotently and grants only application DML', async () => {
    const config = {
      host: '127.0.0.1', port: 33196, database,
      adminUsername: 'eisenhower', adminPassword: 'eisenhower_test',
      appUsername: appRole, appPassword, ssl: false,
      migrationsDirectory: path.resolve('prisma/migrations'),
    };

    await runPostgresMigrations(config);
    await runPostgresMigrations(config);

    const app = new Client({
      host: config.host, port: config.port, database,
      user: appRole, password: appPassword, ssl: false,
    });
    await app.connect();
    await expect(app.query('SELECT count(*) FROM tasks')).resolves.toMatchObject({ rowCount: 1 });
    await expect(app.query('CREATE TABLE forbidden_by_app (id int)')).rejects.toThrow(/permission denied/);
    await app.end();

    const databaseAdmin = new Client({
      host: config.host, port: config.port, database,
      user: config.adminUsername, password: config.adminPassword, ssl: false,
    });
    await databaseAdmin.connect();
    const migrated = await databaseAdmin.query(
      'SELECT migration_name FROM _eisenhower_migrations ORDER BY migration_name',
    );
    expect(migrated.rows).toHaveLength(1);
    await databaseAdmin.end();
  });
});
