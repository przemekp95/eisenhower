const { spawnSync } = require('node:child_process');

const EXPIRES_AT = new Date('2026-10-31T23:59:59Z');
const ALLOWED_ADVISORIES = new Set([1138808, 1138809]);
const ALLOWED_CHAIN = new Set([
  '@expo/cli',
  '@expo/metro',
  '@expo/metro-config',
  '@react-native/community-cli-plugin',
  'expo',
  'image-size',
  'metro',
  'metro-config',
  'metro-transform-worker',
  'react-native',
]);

function validateAudit(audit, now = new Date()) {
  const errors = [];
  const vulnerabilities = audit?.vulnerabilities ?? {};

  if ((audit?.metadata?.vulnerabilities?.critical ?? 0) > 0) {
    errors.push('Critical production vulnerabilities are never allowed.');
  }

  if (Object.keys(vulnerabilities).length === 0) {
    return errors;
  }

  if (now > EXPIRES_AT) {
    errors.push(`The temporary mobile audit exception expired at ${EXPIRES_AT.toISOString()}.`);
  }

  for (const [name, finding] of Object.entries(vulnerabilities)) {
    if (!ALLOWED_CHAIN.has(name)) {
      errors.push(`Unexpected vulnerable package: ${name}.`);
    }

    for (const cause of finding.via ?? []) {
      if (typeof cause === 'object' && !ALLOWED_ADVISORIES.has(cause.source)) {
        errors.push(`Unexpected advisory ${cause.source ?? 'unknown'} in ${name}.`);
      }
    }
  }

  return errors;
}

function runAuditPolicy() {
  const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  let audit;
  try {
    audit = JSON.parse(result.stdout);
  } catch {
    console.error(result.stderr || 'npm audit did not return valid JSON.');
    return 1;
  }

  const errors = validateAudit(audit);
  if (errors.length > 0) {
    errors.forEach((message) => console.error(message));
    return 1;
  }

  const total = audit?.metadata?.vulnerabilities?.total ?? 0;
  if (total > 0) {
    console.warn(`Accepted ${total} transitive build-tool findings under the temporary image-size exception.`);
  } else {
    console.log('No production dependency vulnerabilities found.');
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = runAuditPolicy();
}

module.exports = { validateAudit };
