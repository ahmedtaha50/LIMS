import { route } from '../core/route.js';

export const routes = [
  route({
    method: 'GET', path: '/api/health', permission: 'public', summary: 'Is the server up and can it reach its database',
    handler: async ({ pool }) => {
      const r = await pool.query<{ now: Date; migrations: string }>('SELECT now() AS now, (SELECT count(*) FROM schema_migrations)::text AS migrations');
      return { status: 'ok', serverTime: r.rows[0]?.now.toISOString(), migrations: Number(r.rows[0]?.migrations) };
    },
  }),
];
