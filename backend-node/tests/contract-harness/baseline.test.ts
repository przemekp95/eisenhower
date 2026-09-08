import fs from 'node:fs';
import path from 'node:path';
import { CONTRACT_CASES } from './cases';
import { normalizeResponse } from './normalizers';
import { ContractFixture, ContractResponse, RouteManifestEntry } from './types';

const repositoryRoot = path.resolve(__dirname, '../..');
const routeManifestPath = path.join(repositoryRoot, 'contracts', 'node-http-routes.json');
const fixturePath = path.join(repositoryRoot, 'contracts', 'express-5db1983-contract.json');

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

describe('immutable Express migration baseline', () => {
  it('keeps the machine-readable manifest aligned with every contract case', () => {
    const manifest = readJson<RouteManifestEntry[]>(routeManifestPath);
    const declared = manifest.map(({ method, path: routePath }) => `${method} ${routePath}`).sort();

    expect(new Set(declared).size).toBe(declared.length);
    expect(declared).toEqual(CONTRACT_CASES.map(({ route }) => `${route.method} ${route.path}`).sort());
  });

  it('labels the fixture with the exact Express oracle and every route case', () => {
    const fixture = readJson<ContractFixture>(fixturePath);
    const manifest = readJson<RouteManifestEntry[]>(routeManifestPath);

    expect(fixture.baselineSha).toBe('5db1983da7f4e583a133f42d6b4a95ac8b3ab9c9');
    expect(new Set(fixture.cases.map(({ id }) => id)).size).toBe(fixture.cases.length);
    for (const route of manifest) {
      expect(fixture.cases.some(({ routeKey }) => (
        routeKey === `${route.method} ${route.path}`
      ))).toBe(true);
    }
  });

  it('normalizes only named generated fields and preserves semantic order and scalar types', () => {
    const response: ContractResponse = {
      status: 412,
      headers: {
        date: 'Sat, 23 Aug 2026 12:00:00 GMT',
        'x-request-id': 'generated-request-id',
        etag: '"7"',
      },
      rawBody: '{"error":"Revision conflict"}',
      jsonBody: {
        _id: '507f1f77bcf86cd799439011',
        createdAt: '2026-08-23T12:00:00.000Z',
        error: 'Revision conflict',
        details: ['If-Match is stale', 'Retry with current ETag'],
        revision: 7,
      },
      state: { taskCount: 1 },
    };

    expect(normalizeResponse(response, {
      generatedHeaders: ['date', 'x-request-id'],
      generatedJsonPaths: { _id: '<task-id>', createdAt: '<created-at>' },
    })).toEqual({
      ...response,
      headers: { date: '<date>', 'x-request-id': '<x-request-id>', etag: '"7"' },
      jsonBody: {
        _id: '<task-id>',
        createdAt: '<created-at>',
        error: 'Revision conflict',
        details: ['If-Match is stale', 'Retry with current ETag'],
        revision: 7,
      },
    });
  });
});
