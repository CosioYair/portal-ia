import { buildApp } from './app.ts';
import { config } from './config.ts';

const app = await buildApp();
// Mantenimiento puntual del backlog interno (una vez por versión; ver services/backlogMaintenance.ts).
try { const { runBacklogMaintenance } = await import('./services/backlogMaintenance.ts'); const r = runBacklogMaintenance((o, m) => app.log.info(o, m)); r.summary.forEach(l => app.log.info(l)); } catch (e) { app.log.warn({ err: (e as Error).message }, 'saneamiento del backlog omitido'); }
try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Portal IA · backend local en http://${config.host}:${config.port} · datos en ${config.dataDir}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
