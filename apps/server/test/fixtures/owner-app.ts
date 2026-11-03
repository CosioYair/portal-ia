import type { FastifyInstance } from 'fastify';
import { buildApp as build } from '../../src/app.ts';
import { ownerHeaders } from './owner.ts';

/**
 * El Portal de las pruebas con el propietario ya vinculado (en el propio proceso, como haría el navegador con el código):
 * todo cambio por la API exige su sesión (services/ownerSession.ts). Sus `inject` y los `fetch` a la API local llevan la
 * sesión salvo que la petición traiga la suya. Las pruebas de la política en sí (test/politica-propietario.test.ts y test/seguridad-propietario.test.ts) usan
 * el Portal sin esto. Importar después de fijar PORTAL_DATA_DIR, como `src/app.ts`.
 */
export async function buildApp(...args: Parameters<typeof build>): Promise<FastifyInstance> {
  const app = await build(...args);
  const owner = await ownerHeaders();
  const inject = app.inject.bind(app) as any;
  // Las llamadas internas del propio Portal (Decisiones: fijan su Host) no se tocan: así se prueba que reenvían la sesión.
  (app as any).inject = (opts?: any, cb?: any) => opts && typeof opts === 'object' && !opts.headers?.host ? inject({ ...opts, headers: { ...owner, ...(opts.headers ?? {}) } }, cb) : inject(opts, cb);
  const f = globalThis.fetch;
  if (!(f as any).owner) {
    const withOwner = ((input: any, init?: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/api\//.test(url)) return f(input, init);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (!headers.has('x-portal-owner')) headers.set('x-portal-owner', current);
      return f(input, { ...init, headers });
    }) as typeof fetch;
    (withOwner as any).owner = true; globalThis.fetch = withOwner;
  }
  current = owner['x-portal-owner'];
  return app;
}
let current = '';
