import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // Schema generation and static checks do not connect. Runtime and migrate
    // commands must override this non-routable documentation value.
    url: process.env.DATABASE_URL ?? 'postgresql://invalid:invalid@127.0.0.1:1/eisenhower',
  },
});
