import fs from 'node:fs';
import path from 'node:path';
import { CONTRACT_CASES } from './cases';
import { createNestTarget } from './nest-target';
import { normalizeResponse } from './normalizers';
import type { ContractFixture, ContractTarget } from './types';

const fixture = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../contracts/express-5db1983-contract.json'), 'utf8',
)) as ContractFixture;

describe('Nest Fastify parity with the immutable Express oracle', () => {
  let target: ContractTarget;
  beforeAll(async () => { target = await createNestTarget(); });
  afterAll(async () => { await target.close(); });

  it.each(CONTRACT_CASES.map((contractCase) => [
    `${contractCase.route.method} ${contractCase.route.path}`, contractCase,
  ] as const))('%s', async (_route, contractCase) => {
    await target.reset();
    const expected = fixture.cases.find(({ id }) => id === contractCase.request.id);
    expect(expected).toBeDefined();
    const actual = normalizeResponse(
      await target.request(contractCase.request), contractCase.normalization,
    );
    const oracle = normalizeResponse(expected!.response, contractCase.normalization);
    expect(actual).toEqual(oracle);
  });
});
