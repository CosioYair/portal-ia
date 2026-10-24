// Supervisor de arranque de Portal IA.
// Lanza el servidor y, si este termina con el código 75 (convenio de «relánzame», ver apps/server/src/services/lifecycle.ts),
// lo vuelve a arrancar en el mismo puerto: así «Reconstruir y reiniciar» desde la interfaz funciona sin intervención.
// Cualquier otro código de salida (0 = apagado pedido, 1 = error) termina el supervisor con ese mismo código.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');
const RESTART_EXIT_CODE = 75;
let child = null;

function launch(attempt = 0) {
  child = spawn(process.execPath, [tsxCli, 'src/index.ts'], { cwd: path.join(root, 'apps', 'server'), stdio: 'inherit', env: { ...process.env, PORTAL_SUPERVISED: '1' } });
  child.on('exit', (code, signal) => {
    if (code === RESTART_EXIT_CODE) { console.log('[portal-ia] reiniciando el servidor…'); setTimeout(() => launch(attempt + 1), 500); return; }
    process.exit(code ?? (signal ? 1 : 0));
  });
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { if (child && !child.killed) child.kill(sig); });
launch();
