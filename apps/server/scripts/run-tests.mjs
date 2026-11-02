// Ejecuta la suite del servidor con CONCURRENCIA ACOTADA.
//
// Por qué: `node --test` ejecuta por defecto availableParallelism()-1 archivos a la vez (15 en un equipo de 16 hilos), cada
// uno en su propio proceso con tsx/esbuild, y muchos lanzan a su vez un servidor, CLIs simuladas, git o Docker. En un equipo
// con otras cargas eso agotó la memoria (2 GB libres de 32): el sistema detuvo la verificación, cayó el servicio de esbuild y
// todos los archivos restantes fallaron con «The service was stopped». Acotar la concurrencia mantiene la huella estable.
//
// Concurrencia: PORTAL_TEST_CONCURRENCY si está fijada; si no, entre 2 y 6 según hilos (la mitad) y memoria libre (≈1 GB por
// archivo en paralelo). Uso: node scripts/run-tests.mjs [patrones…] (por defecto test/*.test.ts).
import { spawn } from 'node:child_process';
import os from 'node:os';

const cpus = os.availableParallelism();
const freeGb = os.freemem() / 2 ** 30;
const fixed = Number(process.env.PORTAL_TEST_CONCURRENCY);
const auto = Math.max(2, Math.min(6, Math.floor(cpus / 2), Math.floor(freeGb)));
const n = Number.isInteger(fixed) && fixed > 0 ? fixed : auto;
const patterns = process.argv.slice(2).length ? process.argv.slice(2) : ['test/*.test.ts'];
console.log(`# concurrencia de pruebas: ${n} archivo(s) a la vez (hilos ${cpus}, memoria libre ${freeGb.toFixed(1)} GB; PORTAL_TEST_CONCURRENCY la fija)`);
const child = spawn(process.execPath, ['--test', `--test-concurrency=${n}`, '--import', 'tsx', ...patterns], { stdio: 'inherit' });
const forward = sig => { try { child.kill(sig); } catch { /* ya terminó */ } };
process.on('SIGINT', forward); process.on('SIGTERM', forward);
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
