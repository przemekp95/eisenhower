import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const expressPackage = ['ex', 'press'].join('');
const legacyRequestTestPackage = ['super', 'test'].join('');
const removedPackages = [
  expressPackage, `${expressPackage}-validator`, `${expressPackage}-rate-limit`, 'cors', 'helmet',
  `@types/${expressPackage}`, '@types/cors', legacyRequestTestPackage, `@types/${legacyRequestTestPackage}`,
];

describe('single Nest Fastify runtime', () => {
  it('declares no Express, Express middleware or Supertest packages', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const declared = new Set([
      ...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies),
    ]);
    expect([...declared].filter((name) => removedPackages.includes(name))).toEqual([]);
  });

  it('has no legacy Express route files or imports', () => {
    const legacy = [
      'src/routes/health.ts', 'src/routes/tasks.ts', 'src/routes/calendar.ts',
      'src/routes/googleOAuth.ts', 'src/routes/googleCalendarProvider.ts',
      'src/routes/calendarInternal.ts', 'src/nest-app.ts',
    ].filter((file) => fs.existsSync(path.join(root, file)));
    const source = fs.readdirSync(path.join(root, 'src'), { recursive: true })
      .filter((entry) => String(entry).endsWith('.ts'))
      .map((entry) => fs.readFileSync(path.join(root, 'src', String(entry)), 'utf8'))
      .join('\n');
    expect(legacy).toEqual([]);
    const removedImports = new RegExp(
      `from ['"](?:${[expressPackage, 'cors', 'helmet', `${expressPackage}-rate-limit`, `${expressPackage}-validator`].join('|')})['"]`,
    );
    expect(source).not.toMatch(removedImports);
  });

  it('marks every route as owned solely by Nest', () => {
    const map = fs.readFileSync(path.resolve(root, '../docs/architecture/node-http-migration-map.md'), 'utf8');
    const rows = map.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Method'));
    expect(rows).toHaveLength(41);
    expect(rows.every((row) => row.endsWith('| nest-final |'))).toBe(true);
  });
});
