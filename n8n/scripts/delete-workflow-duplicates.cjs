#!/usr/bin/env node

const fs = require('node:fs');

const databasePath = process.argv[2];
const planPath = process.argv[3];
if (!databasePath || !planPath) {
  throw new Error('Usage: delete-workflow-duplicates.cjs DATABASE PLAN');
}

const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
if (plan.deleteIds.length === 0) process.exit(0);

const modulePath = process.env.N8N_SQLITE3_MODULE
  || '/usr/local/lib/node_modules/n8n/node_modules/.pnpm/sqlite3@5.1.7/node_modules/sqlite3';
const sqlite3 = require(modulePath);
const database = new sqlite3.Database(databasePath);
const allowedNames = new Set([
  'Eisenhower - async RAG ingestion',
  'Eisenhower - Google Calendar inbound signal',
  'Eisenhower - Google Calendar outbound',
  'Eisenhower - Google Calendar reconciliation and watch renewal',
  'Eisenhower - RAG ingestion error handler',
]);

function run(sql, parameters = []) {
  return new Promise((resolve, reject) => {
    database.run(sql, parameters, function callback(error) {
      if (error) reject(error);
      else resolve(this.changes);
    });
  });
}

function all(sql, parameters = []) {
  return new Promise((resolve, reject) => {
    database.all(sql, parameters, (error, rows) => error ? reject(error) : resolve(rows));
  });
}

(async () => {
  await run('PRAGMA foreign_keys = ON');
  await run('BEGIN IMMEDIATE');
  try {
    for (const id of plan.deleteIds) {
      const rows = await all('SELECT name FROM workflow_entity WHERE id = ?', [id]);
      if (rows.length !== 1 || !allowedNames.has(rows[0].name)) {
        throw new Error(`Refusing to delete unmanaged workflow ${id}`);
      }
      const changes = await run('DELETE FROM workflow_entity WHERE id = ?', [id]);
      if (changes !== 1) throw new Error(`Failed to delete duplicate workflow ${id}`);
      process.stdout.write(`Removed stale duplicate ${id}\n`);
    }
    await run('COMMIT');
  } catch (error) {
    await run('ROLLBACK');
    throw error;
  }
})().finally(() => database.close()).catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
