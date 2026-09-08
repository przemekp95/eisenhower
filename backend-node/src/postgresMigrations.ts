import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';

export interface PostgresMigrationConfig {
  host: string;
  port: number;
  database: string;
  adminUsername: string;
  adminPassword: string;
  appUsername: string;
  appPassword: string;
  ssl: boolean;
  migrationsDirectory: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function quotedIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`unsafe PostgreSQL identifier: ${value}`);
  return `"${value}"`;
}

function quotedLiteral(value: string): string {
  if (value.includes('\0')) throw new Error('PostgreSQL password contains a null byte');
  return `'${value.replaceAll("'", "''")}'`;
}

async function migrationFiles(directory: string) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      file: path.join(directory, entry.name, 'migration.sql'),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function runPostgresMigrations(config: PostgresMigrationConfig): Promise<void> {
  const appRole = quotedIdentifier(config.appUsername);
  const database = quotedIdentifier(config.database);
  const client = new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.adminUsername,
    password: config.adminPassword,
    ssl: config.ssl ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('eisenhower-schema-migration-v1'))");
    await client.query('BEGIN');
    try {
      const role = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [config.appUsername]);
      if (role.rowCount === 0) {
        await client.query(`CREATE ROLE ${appRole} LOGIN PASSWORD ${quotedLiteral(config.appPassword)}`);
      } else {
        await client.query(`ALTER ROLE ${appRole} WITH LOGIN PASSWORD ${quotedLiteral(config.appPassword)}`);
      }
      await client.query(`REVOKE ALL ON DATABASE ${database} FROM ${appRole}`);
      await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${appRole}`);
      await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await client.query(`GRANT USAGE ON SCHEMA public TO ${appRole}`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS _eisenhower_migrations (
          migration_name varchar(200) PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      for (const migration of await migrationFiles(config.migrationsDirectory)) {
        const applied = await client.query(
          'SELECT 1 FROM _eisenhower_migrations WHERE migration_name = $1',
          [migration.name],
        );
        if (applied.rowCount) continue;
        await client.query(await fs.readFile(migration.file, 'utf8'));
        await client.query(
          'INSERT INTO _eisenhower_migrations (migration_name) VALUES ($1)',
          [migration.name],
        );
      }

      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appRole}`);
      await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${appRole}`);
      await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole}`);
      await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${appRole}`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('eisenhower-schema-migration-v1'))").catch(() => undefined);
    await client.end();
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for PostgreSQL migration`);
  return value;
}

if (require.main === module) {
  runPostgresMigrations({
    host: required('DATABASE_HOST'),
    port: Number(required('DATABASE_PORT')),
    database: required('DATABASE_NAME'),
    adminUsername: required('DATABASE_ADMIN_USERNAME'),
    adminPassword: required('DATABASE_ADMIN_PASSWORD'),
    appUsername: required('DATABASE_USERNAME'),
    appPassword: required('DATABASE_PASSWORD'),
    ssl: process.env.DATABASE_SSL !== 'false',
    migrationsDirectory: process.env.PRISMA_MIGRATIONS_PATH ?? path.resolve('prisma/migrations'),
  }).then(
    () => console.info(JSON.stringify({ event: 'postgres_migration_completed' })),
    (error) => {
      console.error(JSON.stringify({
        event: 'postgres_migration_failed',
        error: error instanceof Error ? error.message : 'unknown error',
      }));
      process.exitCode = 1;
    },
  );
}
