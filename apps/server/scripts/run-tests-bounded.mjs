// Verificación ACOTADA y REANUDABLE de la suite del servidor (Portal IA 3).
//
// Por qué existe: `run-tests.mjs` lanza toda la suite de una vez. En un equipo con poca memoria libre el sistema (o la
// herramienta que lo lanzó) puede detener la ejecución a medias, y entonces no queda ninguna evidencia utilizable: los
// archivos que no llegaron a ejecutarse figuran como fallidos y hay que repetirlo todo.
//
// Qué hace:
//  - Ejecuta UN archivo de prueba cada vez (un proceso por archivo). Nunca dos a la vez.
//  - Antes de cada archivo espera a que haya memoria libre suficiente (--min-free-gb, 2.5 por defecto). No cierra nada
//    ni fuerza nada: solo espera; si se agota la espera (--wait-min), se detiene limpiamente y lo dice.
//  - Guarda la evidencia completa de cada archivo (TAP) y un registro acumulado (results.json) ligado al ÁRBOL exacto
//    (hash del árbol de git, incluidos los cambios sin confirmar) y al ENTORNO (versión de Node y dependencias
//    instaladas). Al relanzarlo continúa donde lo dejó: lo que ya pasó no se repite; lo interrumpido se repite siempre
//    y lo que falló solo con --rerun-failed (un fallo es evidencia: no se borra relanzando sin querer).
//  - Cada archivo tiene un plazo (--file-timeout-min, 15): si lo supera se detiene y queda «interrumpido».
//  - Se detiene solo al cumplir --budget-min (por defecto 8), entre archivos, para caber en una orden de primer plano.
//  - Un archivo interrumpido (señal, plazo, sin resumen TAP) se anota como «interrumpido», NUNCA como fallo ni como éxito.
//
// Uso: node scripts/run-tests-bounded.mjs [--out <dir>] [--budget-min 8] [--min-free-gb 2.5] [--wait-min 10]
//                                          [--file-timeout-min 15] [--only <subcadena>] [--rerun-failed] [--status]
// Sale 0 solo si TODOS los archivos de la suite pasaron en este árbol; 3 si falta alguno por ejecutar; 1 si hay fallos.
// La carpeta de evidencia por defecto está en .gitignore: si eliges otra con --out, que quede FUERA del repositorio
// (dentro cambiaría el hash del árbol en cada ejecución).
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def; };
const flag = name => args.includes(name);
const outDir = path.resolve(opt('--out', path.join(serverDir, 'test', 'e2e', 'out', 'bounded')));
const budgetMs = Number(opt('--budget-min', '8')) * 60_000;
const minFreeGb = Number(opt('--min-free-gb', '2.5'));
const waitMs = Number(opt('--wait-min', '10')) * 60_000;
const fileTimeoutMs = Number(opt('--file-timeout-min', '15')) * 60_000;
const only = opt('--only', '');
const freeGb = () => os.freemem() / 2 ** 30;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Hash del árbol EXACTO que se verifica (HEAD + cambios sin confirmar + archivos nuevos), sin tocar el índice real. */
function treeHash() {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: serverDir, encoding: 'utf8' }).trim();
  const tmp = path.join(os.tmpdir(), `p3-idx-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmp };
  try {
    execFileSync('git', ['read-tree', 'HEAD'], { cwd: root, env });
    execFileSync('git', ['add', '-A'], { cwd: root, env, stdio: ['ignore', 'ignore', 'ignore'] });
    return execFileSync('git', ['write-tree'], { cwd: root, env, encoding: 'utf8' }).trim();
  } catch { return `sin-git-${crypto.createHash('sha1').update(String(Date.now())).digest('hex').slice(0, 12)}`; }
  finally { try { fs.unlinkSync(tmp); } catch { /* no existía */ } }
}
/** El entorno también cuenta: las mismas fuentes con otras dependencias instaladas u otro Node no son la misma evidencia. */
function envKey() {
  const h = crypto.createHash('sha1').update(process.version);
  try { h.update(fs.readFileSync(path.join(serverDir, '..', '..', 'node_modules', '.package-lock.json'))); } catch { h.update('sin-node_modules'); }
  return h.digest('hex').slice(0, 8);
}

const tree = treeHash();
const runDir = path.join(outDir, `${tree.slice(0, 12)}-${envKey()}`);
fs.mkdirSync(runDir, { recursive: true });
const resultsFile = path.join(runDir, 'results.json');
const state = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')) : { tree, node: process.version, startedAt: new Date().toISOString(), files: {} };
const save = () => { state.updatedAt = new Date().toISOString(); fs.writeFileSync(resultsFile, JSON.stringify(state, null, 1)); };

const all = fs.readdirSync(path.join(serverDir, 'test')).filter(f => f.endsWith('.test.ts')).sort();
const suite = only ? all.filter(f => f.includes(only)) : all;

function summary() {
  const s = { files: all.length, passed: 0, failed: 0, interrupted: 0, pending: 0, tests: 0, pass: 0, fail: 0, skipped: 0, failing: [], skippedIn: [] };
  for (const f of all) {
    const r = state.files[f];
    if (!r) { s.pending++; continue; }
    if (r.status === 'passed') s.passed++; else if (r.status === 'failed') { s.failed++; s.failing.push({ file: f, tests: r.failing ?? [] }); } else s.interrupted++;
    if (r.status !== 'interrupted') { s.tests += r.tests ?? 0; s.pass += r.pass ?? 0; s.fail += r.fail ?? 0; s.skipped += r.skipped ?? 0; if (r.skipped) s.skippedIn.push(`${f} (${r.skipped})`); }
  }
  return s;
}
function report(prefix) {
  const s = summary();
  console.log(`${prefix} árbol ${tree.slice(0, 12)} · archivos ${s.passed}/${s.files} superados, ${s.failed} con fallos, ${s.interrupted} interrumpidos, ${s.pending} sin ejecutar · pruebas ${s.pass}/${s.tests} superadas, ${s.fail} fallidas, ${s.skipped} omitidas`);
  for (const f of s.failing) console.log(`  ✖ ${f.file}${f.tests.length ? `: ${f.tests.slice(0, 4).join(' | ')}${f.tests.length > 4 ? ` (+${f.tests.length - 4})` : ''}` : ''}`);
  if (s.skippedIn.length) console.log(`  omitidas en: ${s.skippedIn.join(', ')}`);
  return s;
}
const exitFor = s => (s.failed ? 1 : s.pending || s.interrupted ? 3 : 0);

if (flag('--status')) { process.exit(exitFor(report('#'))); }

let current = null;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { current?.kill(sig); } catch { /* ya terminó */ } process.exit(130); });

function runFile(file) {
  return new Promise(resolve => {
    const tap = path.join(runDir, `${file}.tap`);
    const out = fs.createWriteStream(tap);
    const t0 = Date.now();
    const env = { ...process.env }; delete env.ANTHROPIC_API_KEY; delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', '--import', 'tsx', path.join('test', file)], { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    current = child;
    let text = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* ya terminó */ } }, fileTimeoutMs);
    const take = d => { const s = d.toString(); out.write(s); text += s; if (text.length > 4_000_000) text = text.slice(-2_000_000); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.on('exit', (code, signal) => {
      out.end(); clearTimeout(timer); current = null;
      // El ÚLTIMO resumen es el del archivo (una prueba puede imprimir antes el TAP de un `node --test` anidado).
      const num = k => { const hits = [...text.matchAll(new RegExp(`^# ${k} (\\d+)`, 'gm'))]; return hits.length ? Number(hits.at(-1)[1]) : null; };
      const tests = num('tests'); const pass = num('pass'); const fail = num('fail'); const skipped = num('skipped');
      const failing = [...text.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map(m => m[1].trim()).filter(n => !/\.test\.ts$/.test(n)).slice(0, 40);
      // Sin resumen TAP, terminado por señal o por plazo: no se sabe qué pasó. Ni éxito ni fallo.
      const complete = tests !== null && !signal && !timedOut;
      const status = !complete ? 'interrupted' : code === 0 && fail === 0 ? 'passed' : 'failed';
      resolve({ status, code, signal: signal ?? null, timedOut, tests, pass, fail, skipped, failing, durationMs: Date.now() - t0, at: new Date().toISOString(), tap: path.basename(tap), freeGbBefore: null });
    });
  });
}

const started = Date.now();
const todo = suite.filter(f => { const r = state.files[f]; return !r || r.status === 'interrupted' || (r.status === 'failed' && flag('--rerun-failed')); });
console.log(`# verificación acotada · ${todo.length} archivo(s) por ejecutar de ${suite.length} · uno cada vez · memoria mínima ${minFreeGb} GB · tope ${Math.round(budgetMs / 60_000)} min · evidencia en ${runDir}`);
let stopped = '';
for (const file of todo) {
  if (Date.now() - started > budgetMs) { stopped = 'se cumplió el tope de tiempo de esta tanda; relánzalo para continuar'; break; }
  const waitStart = Date.now();
  while (freeGb() < minFreeGb) {
    if (Date.now() - waitStart > waitMs) { stopped = `memoria libre insuficiente (${freeGb().toFixed(1)} GB < ${minFreeGb} GB) tras esperar ${Math.round(waitMs / 60_000)} min`; break; }
    await sleep(5000);
  }
  if (stopped) break;
  const before = freeGb();
  const r = await runFile(file);
  r.freeGbBefore = Number(before.toFixed(1));
  state.files[file] = r; save();
  console.log(`${r.status === 'passed' ? 'ok    ' : r.status === 'failed' ? 'FALLA ' : 'CORTE '} ${file} · ${r.pass ?? '?'}/${r.tests ?? '?'} · ${(r.durationMs / 1000).toFixed(0)} s · libre ${r.freeGbBefore} GB${r.failing.length ? ` · ${r.failing.slice(0, 2).join(' | ')}` : ''}`);
}
if (stopped) console.log(`# detenido: ${stopped}`);
process.exit(exitFor(report('#')));
