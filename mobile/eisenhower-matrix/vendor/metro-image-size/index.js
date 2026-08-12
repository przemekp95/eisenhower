const fs = require('node:fs');
const probe = require('probe-image-size/sync');

const KTX_SIGNATURES = new Set(['KTX 11', 'KTX 20']);

function readUInt32LE(input, offset) {
  if (input.length < offset + 4) {
    throw new TypeError('Invalid KTX image: dimensions are missing.');
  }

  return (
    input[offset] +
    input[offset + 1] * 2 ** 8 +
    input[offset + 2] * 2 ** 16 +
    input[offset + 3] * 2 ** 24
  );
}

function probeKtx(input) {
  if (input.length < 7) {
    return null;
  }

  const signature = input.subarray(1, 7).toString('utf8');
  if (!KTX_SIGNATURES.has(signature)) {
    return null;
  }

  const type = input[5] === 0x31 ? 'ktx' : 'ktx2';
  const offset = type === 'ktx' ? 36 : 20;
  const width = readUInt32LE(input, offset);
  const height = readUInt32LE(input, offset + 4);

  if (width <= 0 || height <= 0) {
    throw new TypeError('Invalid KTX image: dimensions must be positive.');
  }

  return { width, height, type };
}

function imageSize(source) {
  const input = typeof source === 'string' ? fs.readFileSync(source) : Buffer.from(source);
  const dimensions = probeKtx(input) ?? probe(input);

  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    throw new TypeError('Unsupported or invalid image asset.');
  }

  return dimensions;
}

module.exports = imageSize;
