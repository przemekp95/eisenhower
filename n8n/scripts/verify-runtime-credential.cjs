#!/usr/bin/env node

const databasePath = process.argv[2];
const credentialId = process.argv[3];
if (!databasePath || !credentialId) {
  throw new Error('Usage: verify-runtime-credential.cjs DATABASE CREDENTIAL_ID');
}

const modulePath = process.env.N8N_SQLITE3_MODULE
  || '/usr/local/lib/node_modules/n8n/node_modules/.pnpm/sqlite3@5.1.7/node_modules/sqlite3';
const sqlite3 = require(modulePath);
const database = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY);
database.get('SELECT type FROM credentials_entity WHERE id = ?', [credentialId], (error, row) => {
  database.close();
  if (error) throw error;
  if (!row || row.type !== 'httpHeaderAuth') {
    process.stderr.write(`RAG Header Auth credential ${credentialId} is missing or has the wrong type\n`);
    process.exitCode = 1;
  }
});
