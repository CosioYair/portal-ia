// HU-213 · Actualiza una Edición instalada con una Edición nueva del Estudio, o vuelve atrás la interfaz.
// Uso: npm run edition:update -- --from <carpeta de la Edición nueva>
//      npm run edition:update -- --rollback
// Sin IA. Antes de escribir nada hace una copia de data/ en data/backups/<fecha>_antes-de-<versión>.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, config } from '../src/config.ts';
import { rollback, updateEdition } from '../src/services/editionUpdate.ts';

function arg(argv: string[], name: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === name) return argv[i + 1]?.trim() || null;
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1).trim() || null;
  }
  return null;
}

/** Empresas con base propia: data/workspaces/<slug>/<slug>.sqlite. */
function workspaceSlugs(dataDir: string): string[] {
  const dir = path.join(dataDir, 'workspaces');
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^[a-z0-9][a-z0-9-]{0,79}$/.test(e.name) && fs.existsSync(path.join(dir, e.name, `${e.name}.sqlite`)))
      .map(e => e.name).sort();
  } catch { return []; }
}

function main(): number {
  const argv = process.argv.slice(2);
  if (argv.includes('--rollback')) {
    const r = rollback(REPO_ROOT, config.dataDir);
    console.log('[portal-ia] Interfaz anterior restaurada');
    console.log(`  interfaz: ${r.restored}`);
    console.log(r.backup
      ? `  datos:    no se han tocado. Para deshacerlos también, restaura a mano la copia ${r.backup}`
      : '  datos:    no se han tocado y no hay copias en data/backups.');
    return 0;
  }
  const from = arg(argv, '--from');
  if (!from) throw new Error('Falta --from <carpeta de la Edición nueva> (o usa --rollback).');
  const newRoot = path.resolve(process.cwd(), from);
  if (!fs.existsSync(newRoot)) throw new Error(`No existe la carpeta ${newRoot}.`);
  const r = updateEdition({ root: REPO_ROOT, newRoot, dataDir: config.dataDir, slugs: workspaceSlugs(config.dataDir) });
  if (r.blocked) {
    console.error('[portal-ia] Actualización bloqueada: no se ha escrito nada.');
    console.error(`  motivo: ${r.reason ?? 'sin motivo'}`);
    return 1;
  }
  if (r.upToDate) {
    console.log(`[portal-ia] La Edición ya está actualizada (esquema ${r.program}, commit ${r.commit ?? 'desconocido'}). No se ha cambiado nada.`);
    return 0;
  }
  console.log('[portal-ia] Edición actualizada');
  console.log(`  esquema:    ${r.data || '(sin marcador)'} → ${r.program}`);
  console.log(`  commit:     ${r.commit ?? 'desconocido'}`);
  console.log(`  copia:      ${r.backup ?? 'ninguna'}`);
  console.log(`  plantillas: ${r.templatesAdded.length ? r.templatesAdded.join(', ') : 'ninguna nueva'}`);
  console.log(`  fijados:    ${r.pinnedUntouched.length} agentes fijados sin cambios`);
  console.log(`  interfaz:   ${r.distPrev ? `anterior guardada en ${r.distPrev}` : 'sin interfaz anterior que guardar'}`);
  if (r.conflicts.length) {
    console.log(`  conflictos: ${r.conflicts.length} (no se ha creado ninguna versión para ellos)`);
    for (const c of r.conflicts) console.log(`    - ${c.slug}: ${c.key} · local ${c.ours} frente a Estudio ${c.theirs} · ${c.paths.join(', ')}`);
    return 2;
  }
  console.log('  Para volver atrás la interfaz: npm run edition:update -- --rollback');
  return 0;
}

try { process.exitCode = main(); }
catch (e: unknown) {
  console.error(`[portal-ia] No se actualizó la Edición: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
