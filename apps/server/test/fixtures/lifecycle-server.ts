// Servidor mínimo para las pruebas de HU-144: arranca la app real, registra un hijo con trackChild
// y otro lanzado con spawn directo (sin registrar), y avisa por stdout cuando está listo.
import { spawn } from 'node:child_process';
import { buildApp } from '../../src/app.ts';
import { installSignalHandlers, trackChild } from '../../src/services/lifecycle.ts';

const sleeper = ['-e', 'setInterval(() => {}, 1000)'];
const app = await buildApp();
installSignalHandlers(app);
const tracked = trackChild(process.execPath, sleeper, { stdio: 'ignore' });
const untracked = spawn(process.execPath, sleeper, { stdio: 'ignore' });
await app.listen({ port: Number(process.env.PORTAL_PORT), host: '127.0.0.1' });
process.stdout.write(JSON.stringify({ ready: true, trackedPid: tracked.pid, untrackedPid: untracked.pid }) + '\n');
