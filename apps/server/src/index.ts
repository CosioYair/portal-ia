import { buildApp } from './app.ts';
import { config } from './config.ts';
import { describePortHolder, installSignalHandlers } from './services/lifecycle.ts';

const app = await buildApp();
// Mantenimiento puntual del backlog interno (una vez por versión; ver services/backlogMaintenance.ts).
try { const { runBacklogMaintenance } = await import('./services/backlogMaintenance.ts'); const r = runBacklogMaintenance((o, m) => app.log.info(o, m)); r.summary.forEach(l => app.log.info(l)); } catch (e) { app.log.warn({ err: (e as Error).message }, 'saneamiento del backlog omitido'); }
// HU-144: Ctrl+C, SIGTERM y SIGHUP hacen el mismo apagado limpio que «Reiniciar» (puerto libre, sin hijos huérfanos).
installSignalHandlers(app);
try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Portal IA · backend local en http://${config.host}:${config.port} · datos en ${config.dataDir}`);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    const pid = describePortHolder(config.port);
    app.log.error(`El puerto ${config.port} ya está en uso${pid ? ` por el proceso ${pid}` : ''}. Detén ese proceso o cambia PORTAL_PORT y vuelve a arrancar.`);
  } else {
    app.log.error(err);
  }
  process.exit(1);
}
