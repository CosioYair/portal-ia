#!/usr/bin/env node
// Lanzador de la Edición distribuible de Portal IA (HU-211).
// - Impone PORTAL_EDITION=distributable aunque el entorno traiga otro valor: la automejora nunca se activa aquí.
// - Usa una carpeta de datos propia (./data junto a esta instalación) salvo que PORTAL_DATA_DIR venga dado.
// - Comprueba que existen el build (apps/web/dist/index.html) y las dependencias (node_modules y tsx), y no instala nada.
// - Arranca el servidor sin el supervisor de reinicio (código 75): la Edición no se reconstruye ni se reinicia sola.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

process.env.PORTAL_EDITION = 'distributable';
if (!process.env.PORTAL_DATA_DIR || !process.env.PORTAL_DATA_DIR.trim()) process.env.PORTAL_DATA_DIR = path.join(root, 'data');
delete process.env.PORTAL_SUPERVISED;

const faltan = [];
if (!fs.existsSync(path.join(root, 'apps', 'web', 'dist', 'index.html'))) faltan.push('el build de la interfaz (apps/web/dist/index.html)');
if (!fs.existsSync(path.join(root, 'node_modules'))) faltan.push('las dependencias (node_modules)');
let tsxCli = null;
if (!faltan.length) {
  try { tsxCli = createRequire(import.meta.url).resolve('tsx/cli'); } catch { faltan.push('la dependencia tsx'); }
}
if (faltan.length || !tsxCli) {
  console.error(`[portal-ia] No se puede arrancar la Edición: falta ${faltan.join(' y ')}.`);
  console.error('[portal-ia] Ejecuta «npm ci» en esta carpeta y vuelve a lanzar «npm run start:edition». Este lanzador no instala nada.');
  process.exit(1);
}

console.log(`[portal-ia] Edición distribuible · datos en ${process.env.PORTAL_DATA_DIR}`);
const child = spawn(process.execPath, [tsxCli, 'src/index.ts'], { cwd: path.join(root, 'apps', 'server'), stdio: 'inherit', env: { ...process.env } });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { if (!child.killed) child.kill(sig); });
