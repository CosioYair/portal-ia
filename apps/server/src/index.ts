import { buildApp } from './app.ts';
import { config } from './config.ts';
import { describePortHolder, installSignalHandlers } from './services/lifecycle.ts';
import { attachApp } from './services/system.ts';

const app = await buildApp();
// Mantenimiento puntual del backlog interno (una vez por versión; ver services/backlogMaintenance.ts).
try { const { runBacklogMaintenance } = await import('./services/backlogMaintenance.ts'); const r = runBacklogMaintenance((o, m) => app.log.info(o, m)); r.summary.forEach(l => app.log.info(l)); } catch (e) { app.log.warn({ err: (e as Error).message }, 'saneamiento del backlog omitido'); }
// Procesos «en ejecución» de un arranque anterior: se marcan como interrumpidos sin reenviar ninguna llamada (ver interruptions.ts).
try { const { recoverInterruptedProcesses } = await import('./services/interruptions.ts'); const n = recoverInterruptedProcesses((o, m) => app.log.info(o, m)); if (n) app.log.warn({ interrupted: n }, 'procesos interrumpidos por el reinicio: pausados sin reenviar nada'); } catch (e) { app.log.warn({ err: (e as Error).message }, 'recuperación de procesos interrumpidos omitida'); }
// EN-014: ámbito inicial de los agentes (Empresa con el nombre registrado + General); idempotente, sin IA ni costo.
try { const { runContextScopeMigration } = await import('./services/contextScopeStartup.ts'); const r = await runContextScopeMigration((o, m) => app.log.info(o, m)); if (r.migrated) app.log.info({ migrated: r.migrated }, 'ámbito de los agentes migrado'); if (r.failed) app.log.warn({ failed: r.failed }, 'migración del ámbito: algunos agentes no se migraron'); } catch (e) { app.log.warn({ err: (e as Error).message }, 'migración del ámbito de los agentes omitida'); }
// EN-020: las lecciones aplicadas pasan a prácticas de sus plantillas y los agentes a la última versión.
// Es idempotente y sin IA. La primera ejecución deja una marca por espacio; cada espacio falla por separado sin bloquear el arranque.
try {
  const { workspacesRepo } = await import('./db/platform.ts');
  const { syncLessonPractices } = await import('./services/lessonPractices.ts');
  for (const ws of workspacesRepo.list()) {
    try { const r = syncLessonPractices(ws.slug, { migration: true }); if (r.created.length || r.moved.length) app.log.info({ workspace: ws.slug, versions: r.created, agents: r.moved.length, first: r.migration }, 'lecciones aplicadas incorporadas a las plantillas'); }
    catch (e) { app.log.warn({ workspace: ws.slug, err: (e as Error).message }, 'migración de lecciones a plantillas omitida en este espacio'); }
  }
} catch (e) { app.log.warn({ err: (e as Error).message }, 'migración de lecciones a plantillas omitida'); }
// Revisiones del proyecto que se estaban ejecutando: quedan «a medias» (reanudables) y su tarjeta del Asistente lo dice.
try { const { recoverInterruptedPlans } = await import('./services/projectMaintenance.ts'); const n = recoverInterruptedPlans(); if (n) app.log.warn({ interrupted: n }, 'revisiones del proyecto interrumpidas por el reinicio: quedan a medias, reanudables'); } catch (e) { app.log.warn({ err: (e as Error).message }, 'recuperación de revisiones interrumpidas omitida'); }
// Worktrees temporales (línea base, run_checks) que dejó un apagado brusco: son del Portal y se retiran.
try { const { cleanupBaselineWorktrees } = await import('./services/baseline.ts'); const n = await cleanupBaselineWorktrees(); if (n) app.log.warn({ removed: n }, 'worktrees temporales de una ejecución anterior retirados'); } catch (e) { app.log.warn({ err: (e as Error).message }, 'limpieza de worktrees temporales omitida'); }
// Operaciones del Asistente que se ejecutaban en segundo plano (p. ej. pruebas en el sandbox): no terminaron; se dice así.
try { const { recoverInterruptedOperations } = await import('./services/assistant.ts'); const n = recoverInterruptedOperations(); if (n) app.log.warn({ interrupted: n }, 'operaciones del Asistente interrumpidas por el reinicio: quedan como no terminadas'); } catch (e) { app.log.warn({ err: (e as Error).message }, 'recuperación de operaciones del Asistente omitida'); }
// Portal IA 4 · Un trabajo ya integrado no figura como «detenido» por una iteración posterior que no tenía nada que
// cambiar (EN-029): se corrige al arrancar y cada vez que termina un proceso. Sin IA; no acepta ni cierra nada.
try {
  const { reconcileDelivered } = await import('./services/deliveredReconcile.ts');
  const { workspacesRepo } = await import('./db/platform.ts');
  const { onProcessFinish } = await import('./db/workspace.ts');
  for (const ws of workspacesRepo.list()) { try { const r = reconcileDelivered(ws.slug); if (r.length) app.log.warn({ workspace: ws.slug, restored: r }, 'trabajos ya integrados devueltos a su entrega (la iteración posterior no tenía nada que cambiar)'); } catch (e) { app.log.warn({ workspace: ws.slug, err: (e as Error).message }, 'conciliación de entregas integradas omitida en este espacio'); } }
  onProcessFinish((slug, processId) => { setImmediate(() => { try { const r = reconcileDelivered(slug, { processId }); if (r.length) app.log.info({ workspace: slug, restored: r }, 'iteración sin código tras una integración: vuelve a ser vigente la entrega integrada'); } catch { /* se corregirá al arrancar */ } }); });
} catch (e) { app.log.warn({ err: (e as Error).message }, 'conciliación de entregas integradas omitida'); }
// Portal IA 4 · Estudio: exportaciones que un cierre dejó a medias, sus contenedores y sus carpetas temporales.
void (async () => { try { const { recoverStudioAtStartup } = await import('./services/studio.ts'); const { workspacesRepo } = await import('./db/platform.ts'); const r = await recoverStudioAtStartup(workspacesRepo.list().map(w => w.slug)); if (r.renders || r.containers) app.log.warn(r, 'Estudio: exportaciones interrumpidas por el reinicio marcadas como no terminadas'); const { recoverLabAtStartup } = await import('./services/artifactLab.ts'); const n = await recoverLabAtStartup(workspacesRepo.list().map(w => w.slug)); if (n) app.log.warn({ interrupted: n }, 'análisis de artefactos interrumpidos por el reinicio'); } catch (e) { app.log.warn({ err: (e as Error).message }, 'Estudio: recuperación omitida'); } })();
// HU-144: Ctrl+C, SIGTERM y SIGHUP hacen el mismo apagado limpio que «Reiniciar» (puerto libre, sin hijos huérfanos).
installSignalHandlers(app);
attachApp(app);
try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Portal IA · backend local en http://${config.host}:${config.port} · datos en ${config.dataDir}`);
  // Lotes de ejecución continua: retoman tras el reinicio (sin reenviar llamadas con cobro incierto) y se revisan sin IA.
  // Va tras escuchar: la activación de un lote se comprueba contra el Portal ya en marcha.
  try { const { resumeBatches, startBatchScheduler } = await import('./services/batchRunner.ts'); startBatchScheduler((o, m) => app.log.info(o, m)); await resumeBatches((o, m) => app.log.info(o, m)); } catch (e) { app.log.warn({ err: (e as Error).message }, 'lotes: recuperación omitida'); }
  // Portal IA 4 · Trabajos cuyo commit verificado ya está en la rama principal: se registran como integrados (hechos de git).
  void (async () => { try { const { reconcileIntegrated } = await import('./services/deliveredReconcile.ts'); const { workspacesRepo } = await import('./db/platform.ts'); for (const ws of workspacesRepo.list()) { const r = await reconcileIntegrated(ws.slug, (o, m) => app.log.info(o, m)); if (r.length) app.log.warn({ workspace: ws.slug, processes: r }, 'trabajos ya contenidos en la rama principal registrados como integrados (falta la aceptación del propietario)'); } } catch (e) { app.log.warn({ err: (e as Error).message }, 'conciliación con git omitida'); } })();
  // Vistas previas que dejó un arranque anterior de esta instancia: se retiran (no siguen sirviendo código sin aceptar).
  void import('./services/preview.ts').then(m => m.cleanupPreviews((o, msg) => app.log.info(o, msg))).catch(e => app.log.warn({ err: (e as Error).message }, 'vistas previas: limpieza omitida'));
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    const pid = describePortHolder(config.port);
    app.log.error(`El puerto ${config.port} ya está en uso${pid ? ` por el proceso ${pid}` : ''}. Detén ese proceso o cambia PORTAL_PORT y vuelve a arrancar.`);
  } else {
    app.log.error(err);
  }
  process.exit(1);
}
