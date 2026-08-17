import fs from 'node:fs';
import path from 'node:path';

const sha256Reference = /^[^\s@]+@sha256:[a-f0-9]{64}$/;

describe('release base image policy', () => {
  it('pins every external web Dockerfile stage while allowing local stage references', () => {
    const dockerfile = fs.readFileSync(path.resolve(__dirname, '../Dockerfile'), 'utf8');
    const localStages = new Set<string>();

    for (const line of dockerfile.split('\n')) {
      const instruction = line.match(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?$/i);
      if (!instruction) continue;

      const [, image, alias] = instruction;
      if (!localStages.has(image)) {
        expect(image).toMatch(sha256Reference);
      }
      if (alias) localStages.add(alias);
    }
  });

  it('requires the canonical MongoDB image to remain an explicit deployment input', () => {
    const compose = fs.readFileSync(
      path.resolve(__dirname, '../../compose.yaml'),
      'utf8'
    );
    const mongoImage = compose.match(/^\s+image:\s+(\$\{MONGODB_IMAGE[^}]+\})$/m)?.[1];

    expect(mongoImage).toContain('MONGODB_IMAGE');
  });
});
