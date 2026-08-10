const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const CONFIG_MARKER = 'EISENHOWER_PRODUCTION_SIGNING';

function findNamedBlock(source, name, fromIndex = 0) {
  const nameIndex = source.indexOf(name, fromIndex);
  if (nameIndex < 0) {
    throw new Error(`Could not find ${name} block in generated Android build.gradle.`);
  }

  const openIndex = source.indexOf('{', nameIndex + name.length);
  if (openIndex < 0) {
    throw new Error(`Could not find opening brace for ${name} block.`);
  }

  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return { start: nameIndex, open: openIndex, end: index + 1 };
  }

  throw new Error(`Could not find closing brace for ${name} block.`);
}

function patchBuildGradle(source) {
  if (typeof source !== 'string' || source.trim() === '') {
    throw new Error('Generated Android build.gradle is empty.');
  }

  if (source.includes(CONFIG_MARKER)) {
    return source;
  }

  const signingConfigs = findNamedBlock(source, 'signingConfigs');
  const releaseConfig = `        // ${CONFIG_MARKER}: values are supplied only by the release workflow.
        release {
            def releaseStoreFile = System.getenv("ANDROID_RELEASE_STORE_FILE")
            if (!releaseStoreFile) {
                throw new GradleException("ANDROID_RELEASE_STORE_FILE is required for a production release")
            }
            storeFile file(releaseStoreFile)
            storePassword System.getenv("ANDROID_RELEASE_STORE_PASSWORD")
            keyAlias System.getenv("ANDROID_RELEASE_KEY_ALIAS")
            keyPassword System.getenv("ANDROID_RELEASE_KEY_PASSWORD")
        }
`;

  const closingLineStart = source.lastIndexOf('\n', signingConfigs.end - 1) + 1;
  let patched = `${source.slice(0, closingLineStart)}${releaseConfig}${source.slice(closingLineStart)}`;
  const buildTypes = findNamedBlock(patched, 'buildTypes');
  const release = findNamedBlock(patched, 'release', buildTypes.open + 1);
  const releaseBlock = patched.slice(release.start, release.end);

  if (!/signingConfig\s+signingConfigs\.debug/.test(releaseBlock)) {
    throw new Error('Expo release build no longer uses the expected debug signing configuration; review the generated Gradle contract.');
  }

  const patchedRelease = releaseBlock.replace(
    /signingConfig\s+signingConfigs\.debug/,
    'signingConfig signingConfigs.release',
  );
  patched = `${patched.slice(0, release.start)}${patchedRelease}${patched.slice(release.end)}`;
  return patched;
}

function normalizeDigest(value) {
  return String(value ?? '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
}

function validateApksignerOutput(output, expectedDigest) {
  const errors = [];
  const expected = normalizeDigest(expectedDigest);
  const digestMatch = output.match(/Signer #1 certificate SHA-256 digest:\s*([^\r\n]+)/i);
  const actual = normalizeDigest(digestMatch?.[1]);
  const subjectMatch = output.match(/Signer #1 certificate DN:\s*([^\r\n]+)/i);
  const subject = subjectMatch?.[1]?.trim() ?? '';

  if (!/Verified using v2 scheme \(APK Signature Scheme v2\): true/i.test(output)) {
    errors.push('APK must verify with APK Signature Scheme v2 or newer.');
  }
  if (/CN=Android Debug(?:,|$)/i.test(subject)) {
    errors.push('Production APK must not use the Android Debug certificate.');
  }
  if (!/^\d+$/.test(output.match(/Number of signers:\s*(\d+)/i)?.[1] ?? '') || !/Number of signers:\s*1\b/i.test(output)) {
    errors.push('Production APK must have exactly one signer.');
  }
  if (expected.length !== 64) {
    errors.push('Pinned release certificate SHA-256 digest must contain exactly 64 hexadecimal characters.');
  } else if (actual !== expected) {
    errors.push(`Release certificate digest mismatch: expected ${expected}, received ${actual || 'missing'}.`);
  }

  return errors;
}

function configure(buildGradlePath) {
  const source = fs.readFileSync(buildGradlePath, 'utf8');
  fs.writeFileSync(buildGradlePath, patchBuildGradle(source));
}

function verify(apkPath, expectedDigest) {
  const result = spawnSync('apksigner', ['verify', '--verbose', '--print-certs', apkPath], {
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

  if (result.status !== 0) {
    throw new Error(`apksigner rejected the APK:\n${output.trim()}`);
  }

  const errors = validateApksignerOutput(output, expectedDigest);
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  process.stdout.write(output.trim() + '\n');
}

function run() {
  const [command, target, expectedDigest] = process.argv.slice(2);
  if (command === 'configure' && target) {
    configure(target);
    return;
  }
  if (command === 'verify' && target && expectedDigest) {
    verify(target, expectedDigest);
    return;
  }

  throw new Error('Usage: node scripts/androidReleaseSigning.js configure <build.gradle> | verify <apk> <certificate-sha256>');
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { patchBuildGradle, validateApksignerOutput };
