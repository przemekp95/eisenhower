const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const imageSize = require('./index');

// Kept outside Jest discovery so the adapter is tested in its native Node runtime.

test('is the implementation that Metro resolves for image-size', () => {
  const mobileRoot = path.resolve(__dirname, '../..');
  const metroPackage = require.resolve('metro/package.json', { paths: [mobileRoot] });
  const resolvedImageSize = require.resolve('image-size', {
    paths: [path.dirname(metroPackage)],
  });

  assert.equal(fs.realpathSync(resolvedImageSize), fs.realpathSync(path.join(__dirname, 'index.js')));
});

test('reads the real PNG assets used by the mobile application', () => {
  const asset = path.resolve(__dirname, '../../assets/icon.png');

  assert.deepEqual(
    (({ width, height, type }) => ({ width, height, type }))(imageSize(asset)),
    { width: 1024, height: 1024, type: 'png' },
  );
});

test('reads KTX dimensions without using an unbounded parser loop', () => {
  const input = Buffer.alloc(44);
  input.write('KTX 11', 1, 'utf8');
  input.writeUInt32LE(32, 36);
  input.writeUInt32LE(48, 40);

  assert.deepEqual(imageSize(input), { width: 32, height: 48, type: 'ktx' });
});

test('rejects zero-length ICNS, JXL and HEIF containers promptly', () => {
  const maliciousInputs = [
    Buffer.from('69636e73000000106963313000000000', 'hex'),
    Buffer.from('0000000c4a584c200d0a870a000000006a786c70', 'hex'),
    Buffer.from('00000000667479706865696300000000', 'hex'),
  ];

  for (const input of maliciousInputs) {
    assert.throws(() => imageSize(input), /Unsupported or invalid image asset/);
  }
});

test('reads a Buffer as well as a file path', () => {
  const asset = fs.readFileSync(path.resolve(__dirname, '../../assets/splash.png'));
  const dimensions = imageSize(asset);

  assert.equal(dimensions.type, 'png');
  assert.ok(dimensions.width > 0);
  assert.ok(dimensions.height > 0);
});
