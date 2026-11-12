// HU-212 · Prueba la Edición distribuible en la misma PC: npm run edition:try. Sin IA.
// No importa config.ts: el data/ del Estudio se resuelve igual que allí, pero solo se usa para comparar rutas y claves.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDITION_SANDBOX_URL, startEditionSandbox, stopEditionSandbox } from '../src/services/editionSandbox.ts';

const installRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Valor de una variable: entorno o, si no está definida, la línea correspondiente del .env (sin cargar el resto). */
function envVar(name: string): string | undefined {
  if (process.env[name] !== undefined) return process.env[name];
  const f = path.join(installRoot, '.env');
  if (!fs.existsSync(f)) return undefined;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, '');
  }
  return undefined;
}
const rawData = envVar('PORTAL_DATA_DIR')?.trim() || './data';
const studioDataDir = path.isAbsolute(rawData) ? rawData : path.resolve(installRoot, rawData);

if (!fs.existsSync(path.join(installRoot, 'apps', 'web', 'dist'))) console.warn('Aviso: falta apps/web/dist. Ejecuta «npm run build» para ver la interfaz; la API sí responderá.');
console.log('Arrancando la Edición distribuible en esta PC…');

let stopping = false;
async function stop(code: number): Promise<void> {
  if (stopping) return; stopping = true;
  console.log('Deteniendo la Edición…');
  await stopEditionSandbox().catch(() => false);
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void stop(0));

try {
  const info = await startEditionSandbox({
    installRoot, studioDataDir, override: envVar('PORTAL_EDITION_SANDBOX_DIR'),
    onExit: code => { if (!stopping) { console.log(`La Edición terminó (código ${code ?? '—'}).`); process.exit(code ?? 1); } }
  });
  console.log('');
  console.log(`Edición distribuible lista: ${EDITION_SANDBOX_URL}`);
  console.log(`Carpeta de datos propia: ${info.dataDir} (clave maestra propia: ${info.ownKey ? 'sí' : 'no'})`);
  console.log(`Worktrees propios: ${info.worktreesDir}`);
  console.log('No hereda las claves de proveedor del .env del Estudio. Sí comparte tu sesión de Claude Code (carpeta de usuario).');
  console.log('El data/ del Estudio no se toca. Pulsa Ctrl+C para detenerla.');
} catch (e) {
  const err = e as { code?: string; message?: string };
  console.error(`No se pudo arrancar la Edición${err.code ? ` [${err.code}]` : ''}: ${err.message ?? String(e)}`);
  process.exit(1);
}
