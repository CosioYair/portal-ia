#!/usr/bin/env node
/**
 * Prueba B · Automejora verificada de extremo a extremo (proveedor SIMULADO, 0 USD).
 *
 * Arranca una COPIA del Portal (clon de main en una carpeta temporal) con el supervisor `npm start` en un puerto libre y
 * con datos temporales, y recorre el ciclo completo sobre el proyecto interno (la carpeta de esa instalación):
 *   solicitud → ejecución (plan, implementación con patch a Backlog.tsx, QA) → aplicar en worktree → verificar en sandbox
 *   (typecheck, test, build) → integrar → «no activada» → reconstruir y reiniciar (supervisor) → «activada» →
 *   comprobar en ejecución (HTTP + navegador con captura) → prueba manual → cerrar SIN publicar.
 * Escenarios negativos: typecheck roto (integrar bloqueado), activación fallida (build roto; la interfaz anterior sigue
 * sirviéndose), fallo en ejecución (compila pero no cambia el título: no se puede cerrar).
 *
 * Uso: node apps/server/test/e2e/self-improvement.e2e.mjs [--keep]   (desde la raíz del repositorio; tarda ~10 min)
 * Resultado: JSON y capturas en <dataDir>/evidence y en apps/server/test/e2e/out/.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_REPO = path.resolve(here, '../../../..');
const OUT = path.join(here, 'out'); fs.mkdirSync(OUT, { recursive: true });
const keep = process.argv.includes('--keep');
const results = []; const t0 = Date.now();
const step = (id, ok, detail, extra = {}) => { results.push({ id, ok, detail, at: new Date().toISOString(), ...extra }); console.log(`${ok ? '✓' : '✖'} ${id} — ${detail}`); if (!ok) throw new Error(`Paso ${id} falló: ${detail}`); };
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString();
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 0 · Copia del Portal ----------
const work = fs.mkdtempSync(path.join(os.homedir(), 'portal-ia-e2e-'));
const repo = path.join(work, 'portal'); const dataDir = path.join(work, 'data');
sh('git', ['clone', '-q', '-b', 'main', SRC_REPO, repo]);
sh('git', ['-C', repo, 'config', 'user.email', 'e2e@local']); sh('git', ['-C', repo, 'config', 'user.name', 'e2e']);
fs.symlinkSync(path.join(SRC_REPO, 'node_modules'), path.join(repo, 'node_modules'));
sh('npm', ['run', 'build', '--workspace', 'apps/web'], { cwd: repo });
const port = await freePort();
const script = path.join(work, 'mock-script.json'); const mockLog = path.join(work, 'mock-log.jsonl');
const env = { ...process.env, PORTAL_PORT: String(port), PORTAL_DATA_DIR: dataDir, PORTAL_MOCK_PROVIDER: '1', PORTAL_MOCK_SCRIPT: script, PORTAL_MOCK_LOG: mockLog, PORTAL_PLAYWRIGHT: process.env.PORTAL_PLAYWRIGHT ?? '/opt/npm-tools/node_modules/playwright/index.mjs', LOG_LEVEL: 'warn' };
delete env.PORTAL_SANDBOX; delete env.PORTAL_ALLOW_FOREIGN_REPO;
const serverLog = fs.createWriteStream(path.join(OUT, 'server.log'));
let sup = spawn(process.execPath, ['scripts/portal-start.mjs'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
sup.stdout.pipe(serverLog); sup.stderr.pipe(serverLog);
const base = `http://127.0.0.1:${port}`;
const api = async (method, p, body) => { const r = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let j = null; try { j = text ? JSON.parse(text) : null; } catch { j = { raw: text }; } return { status: r.status, body: j }; };
const waitHealth = async (prevStartedAt = null, tries = 120) => { for (let i = 0; i < tries; i++) { try { const r = await api('GET', '/api/system/status'); if (r.status === 200 && r.body.startedAt !== prevStartedAt) return r.body; } catch { /* arrancando */ } await sleep(1000); } throw new Error('el Portal no arrancó'); };
const waitProcess = async (slug, id, tries = 600) => { for (let i = 0; i < tries; i++) { const r = await api('GET', `/api/workspaces/${slug}/processes/${id}`); if (r.body.status !== 'running' && r.body.status !== 'pending_authorization') return r.body; await sleep(1000); } throw new Error('proceso no terminó'); };

// Playwright (capturas de la interfaz como evidencia)
let pw = null; try { pw = await import(env.PORTAL_PLAYWRIGHT); } catch { try { pw = await import('playwright'); } catch { pw = null; } }
let browser = pw ? await pw.chromium.launch() : null;
const shot = async (route, name) => { if (!browser) return null; const page = await browser.newPage({ viewport: { width: 1360, height: 900 } }); await page.goto(base + route, { waitUntil: 'networkidle' }); await sleep(600); const file = path.join(OUT, `${name}.png`); await page.screenshot({ path: file, fullPage: true }); await page.close(); return file; };

const PLAN = JSON.stringify({ summary: 'Mostrar el número de historias abiertas en el título de Backlog', tasks: ['Calcular abiertas en Backlog.tsx', 'Mostrar en el h1'], filesToRead: ['apps/web/src/screens/Backlog.tsx'], filesToChange: ['apps/web/src/screens/Backlog.tsx'], acceptance: ['El h1 de /backlog muestra (N abiertas)'], risks: [] });
const H1_ORIG = '<h1 className="h1" style={{ fontSize: 26 }}>Plan del proyecto y solicitudes</h1>';
const H1_NEW = '<h1 className="h1" style={{ fontSize: 26 }}>Plan del proyecto y solicitudes ({pending.length} abiertas)</h1>';
const PATCH = (replace, search = H1_ORIG) => `=== RESUMEN ===\nEl título de Backlog muestra el número de historias abiertas.\n=== ARCHIVO: apps/web/src/screens/Backlog.tsx | patch ===\n<<<< BUSCAR\n${search}\n==== REEMPLAZAR\n${replace}\n>>>> FIN\n=== FIN ARCHIVO ===\n=== VERIFICAR: typecheck, test, build ===\n=== PARA EL PROPIETARIO ===\nEn Backlog (menú izquierdo), el título «Plan del proyecto y solicitudes» muestra entre paréntesis cuántas historias siguen abiertas, p. ej. «(9 abiertas)».\n=== PRUEBA MANUAL ===\n1. Abre Backlog. Esperado: el título termina en «(N abiertas)».\n2. Cierra o descarta una historia. Esperado: el número baja en uno.\n3. Añade una solicitud nueva. Esperado: el número sube en uno.\n=== COMPROBACIONES ===\n- ui /backlog | h1 | /\\(\\d+ abiertas\\)/\n- http GET /api/health | "ok":true\n=== NOTAS ===\n-`;
const GOOD = PATCH(H1_NEW);
// Tras integrar HU-001 el h1 ya cambió: las variantes siguientes parchean sobre el h1 nuevo.
const BAD_TYPES = PATCH('<h1 className="h1" style={{ fontSize: 26 }}>Plan del proyecto y solicitudes ({abiertasQueNoExiste} abiertas)</h1>', H1_NEW);
const NO_CHANGE = PATCH('<h1 className="h1" style={{ fontSize: 26 }}>Plan del proyecto y solicitudes</h1>\n{/* comentario sin efecto visible */}');
// Compila, se integra y se activa, pero la comprobación en ejecución exige algo que el Portal no muestra («pendientes»).
const RUNTIME_FAIL = PATCH(H1_NEW + '\n{/* e2e: cambio sin efecto visible */}', H1_NEW).replace('/\\(\\d+ abiertas\\)/', '/\\(\\d+ pendientes\\)/');
const QA = '{"approve": true, "summary": "Cambio mínimo y correcto.", "issues": [], "suggestedTests": ["npm run build"]}';
const setScript = (impl) => fs.writeFileSync(script, JSON.stringify({ markers: ['Lecciones de esta organización'], rules: [{ match: 'plan técnico', text: PLAN }, { match: 'Implementa la historia', text: impl }, { match: 'Revisa los cambios propuestos', text: QA }] }));

let slug = 'portal-ia', projectId = null, prevStarted = null;
try {
  let sys = await waitHealth(); prevStarted = sys.startedAt;
  step('0-arranque', sys.version != null, `Portal copia arrancado en ${base}, commit ${sys.startCommit}, sandbox ${sys.sandbox?.available}`);
  // Proveedor simulado + espacio interno + repositorio = carpeta de esta instalación
  await api('PUT', '/api/providers/anthropic/credential', { apiKey: 'sk-ant-SIMULADO-no-real-000000000' });
  const v = await api('POST', '/api/providers/anthropic/verify'); step('0-proveedor', v.status === 200 && v.body.status === 'connected', `proveedor SIMULADO conectado (${v.body.models?.length} modelos)`);
  const b = await api('POST', '/api/bootstrap/internal'); step('0-bootstrap', b.status === 200 || b.status === 201, 'espacio interno inicializado');
  const projects = (await api('GET', '/api/workspaces/portal-ia/projects')).body; projectId = projects[0].id;
  const reg = await api('POST', `/api/workspaces/portal-ia/projects/${projectId}/repository`, { path: repo, authorized: true }); step('0-repositorio', reg.status === 200 || reg.status === 201, 'repositorio = carpeta de esta instalación (automejora real)');
  const rs = (await api('GET', `/api/workspaces/portal-ia/projects/${projectId}/repository/status`)).body; step('0-runtime', rs.isPortalRuntime === true && rs.branch === 'main', `isPortalRuntime=${rs.isPortalRuntime}, rama ${rs.branch}`);
  await shot('/panel', '00-panel');

  // ---------- Escenario principal ----------
  setScript(GOOD);
  const item = (await api('POST', `/api/workspaces/portal-ia/projects/${projectId}/backlog`, { title: 'Mostrar el número de historias abiertas en el título de Backlog', criterion: 'El h1 de /backlog muestra «(N abiertas)»' })).body;
  const est = (await api('GET', `/api/workspaces/portal-ia/projects/${projectId}/backlog/${item.id}/estimate`)).body;
  step('1-estimacion', est.team && est.steps.length >= 3 && est.approximate === true, `equipo: ${est.team.members.map(m => `${m.agentName} (${m.role})`).join(', ')} · ≈ ${est.estimatedUsd.toFixed(3)} USD (estimación)`);
  const proc = (await api('POST', `/api/workspaces/portal-ia/projects/${projectId}/backlog/${item.id}/execute`, {})).body;
  const au = await api('POST', `/api/workspaces/portal-ia/processes/${proc.id}/authorize`, { budgetUsd: 1, authorized: true }); step('2-autorizar', au.status === 200 && au.body.status === 'running' && au.body.budgetUsd === 1, 'proceso autorizado con 1,00 USD');
  let p = await waitProcess(slug, proc.id);
  step('3-ejecucion', p.status === 'done' && p.result.changes.length === 1 && p.result.changes[0].action === 'modify' && !p.result.changes[0].error && p.result.manualTest.steps.length === 3 && p.result.runtimeChecks.checks.length === 2 && p.spentUsd <= 1, `done · 1 patch a Backlog.tsx · manualTest 3 pasos · runtimeChecks 2 · gastado ${p.spentUsd.toFixed(4)} USD (simulado)`);
  await shot(`/historias/${item.id}`, '01-historia-diff');
  const branchBefore = sh('git', ['-C', repo, 'branch', '--show-current']).trim();
  const ap = await api('POST', `/api/workspaces/portal-ia/processes/${proc.id}/apply`, { authorized: true });
  const branchAfter = sh('git', ['-C', repo, 'branch', '--show-current']).trim();
  step('4-aplicar', ap.status === 200 && fs.existsSync(ap.body.result.applied.worktree) && branchBefore === 'main' && branchAfter === 'main' && !fs.readFileSync(path.join(repo, 'apps/web/src/screens/Backlog.tsx'), 'utf8').includes('abiertas)</h1>'), `worktree ${ap.body.result.applied.worktree}; el checkout sigue en main y sin el cambio`);
  const m0 = await api('POST', `/api/workspaces/portal-ia/processes/${proc.id}/merge`, { authorized: true }); step('5-integrar-bloqueado', m0.status === 409 && m0.body.code === 'verification_required', `integrar sin verificar → 409 ${m0.body.code}`);
  for (const cmd of ['typecheck', 'test', 'build']) {
    const vr = await api('POST', `/api/workspaces/portal-ia/processes/${proc.id}/verify`, { authorized: true, command: cmd });
    const last = vr.body.result?.verifications?.at(-1);
    step(`5-verificar-${cmd}`, vr.status === 200 && last.exitCode === 0 && last.isolation !== 'host-min' && last.isolation !== 'unavailable', `${cmd}: exit ${last?.exitCode} en ${last?.isolation} (${((last?.durationMs ?? 0) / 1000).toFixed(0)} s)`);
  }
  await shot(`/procesos/${proc.id}`, '02-proceso-verificado');
  const m = await api('POST', `/api/workspaces/portal-ia/processes/${proc.id}/merge`, { authorized: true });
  step('6-integrar', m.status === 200 && m.body.result.merged.into === 'main' && !fs.existsSync(ap.body.result.applied.worktree) && sh('git', ['-C', repo, 'log', '--oneline', '-1']).includes('Integra'), `merge --no-ff en main (${m.body.result.merged.commit}); worktree retirado; fase: ${m.body.guidance.phase}`);
  step('6-no-activada', /NO activada/.test(m.body.guidance.phase) && m.body.result.activation.active === false, `guidance: ${m.body.guidance.phase}`);
  sys = (await api('GET', '/api/system/status')).body;
  const html0 = await (await fetch(base + '/backlog')).text();
  step('7-existe-pero-no-corre', sys.action !== 'none' && sys.headCommit !== sys.startCommit, `system.action=${sys.action}; servidor ${sys.startCommit} vs HEAD ${sys.headCommit}`);
  const rc0 = await api('POST', `/api/workspaces/portal-ia/processes/${proc.id}/runtime-check`, { authorized: true }); step('7-comprobar-bloqueado', rc0.status === 409 && rc0.body.code === 'not_activated', 'comprobar en ejecución antes de activar → 409 not_activated');
  const d0 = await api('POST', `/api/workspaces/portal-ia/backlog/${item.id}/done`, {}); step('7-cerrar-bloqueado', d0.status === 409 && d0.body.code === 'not_activated', `cerrar sin activar → 409 ${d0.body.code}`);
  await shot('/backlog', '03-backlog-antes-de-activar');
  const up = await api('POST', '/api/system/update', { authorized: true, restart: true }); step('8-reconstruir', up.status === 200 && up.body.update.status === 'running', 'reconstrucción iniciada (dist.next) y reinicio por supervisor');
  sys = await waitHealth(prevStarted); prevStarted = sys.startedAt;
  step('8-reiniciado', sys.startCommit === sys.headCommit && sys.buildCommit === sys.headCommit, `servidor reiniciado con ${sys.startCommit}; interfaz construida con ${sys.buildCommit}; action=${sys.action}`);
  p = (await api('GET', `/api/workspaces/portal-ia/processes/${proc.id}`)).body;
  step('9-activada', p.result.activation.active === true && /Activada/.test(p.guidance.phase), `activation.active=true (${p.result.activation.reason}); fase: ${p.guidance.phase}`);
  const html1 = await (await fetch(base + '/backlog')).text();
  step('9-interfaz-nueva', html0 !== html1, 'index.html servido cambió tras reconstruir (sin caché)');
  const rc = await api('POST', `/api/workspaces/portal-ia/processes/${proc.id}/runtime-check`, { authorized: true });
  const rr = rc.body.result?.runtimeChecks?.results ?? [];
  step('10-comprobacion-ejecucion', rc.status === 200 && rr.length === 4 && rr.every(x => x.status === 'ok') && rr.some(x => x.check.kind === 'ui' && x.evidence && fs.existsSync(x.evidence)), `${rr.map(x => `${x.check.kind} ${x.check.path}: ${x.status}`).join(' · ')} · evidencia: ${rr.find(x => x.check.kind === 'ui')?.evidence}`);
  step('10-fase', /Verificada en ejecución/.test(rc.body.guidance.phase), `fase: ${rc.body.guidance.phase}`);
  await shot(`/historias/${item.id}`, '04-historia-verificada');
  const d1 = await api('POST', `/api/workspaces/portal-ia/backlog/${item.id}/done`, {}); step('11-cerrar-sin-probar', d1.status === 409 && d1.body.code === 'not_tested', `cerrar sin probar → 409 ${d1.body.code}`);
  const mt = await api('POST', `/api/workspaces/portal-ia/processes/${proc.id}/manual-test`, { checks: [true, true, true], note: 'probado en el navegador (e2e)' });
  step('11-prueba-manual', mt.status === 200 && /Listo para cerrar/.test(mt.body.guidance.phase), `fase: ${mt.body.guidance.phase}`);
  const d2 = await api('POST', `/api/workspaces/portal-ia/backlog/${item.id}/done`, {});
  const originMain = sh('git', ['-C', repo, 'rev-parse', 'origin/main']).trim(); const localMain = sh('git', ['-C', repo, 'rev-parse', 'main']).trim();
  step('12-cerrar', d2.status === 200 && d2.body.status === 'done' && !p.result.published && originMain !== localMain, `historia cerrada SIN publicar (origin/main ${originMain.slice(0, 7)} ≠ main ${localMain.slice(0, 7)})`);
  await shot('/backlog', '05-backlog-cerrada');
  const lessons = (await api('GET', `/api/workspaces/portal-ia/lessons?projectId=${projectId}`)).body;
  step('12-sin-lecciones-falsas', Array.isArray(lessons) && lessons.length === 0, 'una historia sin errores no genera lecciones');

  // ---------- 5b · typecheck roto → integrar bloqueado ----------
  setScript(BAD_TYPES);
  const item2 = (await api('POST', `/api/workspaces/portal-ia/projects/${projectId}/backlog`, { title: 'Variante con error de tipos (prueba negativa)', criterion: 'x' })).body;
  const proc2 = (await api('POST', `/api/workspaces/portal-ia/projects/${projectId}/backlog/${item2.id}/execute`, { skipQa: true })).body;
  await api('POST', `/api/workspaces/portal-ia/processes/${proc2.id}/authorize`, { budgetUsd: 1, authorized: true });
  let p2 = await waitProcess(slug, proc2.id);
  await api('POST', `/api/workspaces/portal-ia/processes/${proc2.id}/apply`, { authorized: true });
  const tc = await api('POST', `/api/workspaces/portal-ia/processes/${proc2.id}/verify`, { authorized: true, command: 'typecheck' });
  const m2 = await api('POST', `/api/workspaces/portal-ia/processes/${proc2.id}/merge`, { authorized: true });
  const m2b = await api('POST', `/api/workspaces/portal-ia/processes/${proc2.id}/merge`, { authorized: true, skipVerification: true });
  step('5b-typecheck-roto', tc.body.result.verifications.at(-1).exitCode !== 0 && m2.status === 409 && m2.body.code === 'verification_failed' && m2b.status === 409, `typecheck exit ${tc.body.result.verifications.at(-1).exitCode} → integrar 409 ${m2.body.code}; saltar verificación también 409; fase: ${tc.body.guidance.phase}`);
  const l2 = (await api('GET', `/api/workspaces/portal-ia/lessons?projectId=${projectId}`)).body;
  step('5b-leccion', l2.some(l => l.detector === 'verification_failed' && l.status === 'detected' && l.evidence.processId === proc2.id), `lección detectada sin IA: ${l2.map(l => l.detector).join(', ')}`);
  const rj = await api('POST', `/api/workspaces/portal-ia/processes/${proc2.id}/reject`, { reason: 'prueba negativa' }); step('5b-rechazar', rj.status === 200, 'diff rechazado; historia a pendiente');
  step('5b-rama-descartada', !sh('git', ['-C', repo, 'branch', '--list', 'portal-ia/hu-002']).trim() && !fs.existsSync(path.join(repo, '..', 'portal-worktrees', proc2.id)), 'worktree retirado y rama borrada al rechazar');

  // ---------- 13 · activación fallida (build roto) ----------
  // Se integra un cambio que rompe el build de la web directamente en git (simula un merge válido en verificación pero roto al construir, p. ej. por un cambio del entorno).
  const beforeHead = sh('git', ['-C', repo, 'rev-parse', '--short', 'HEAD']).trim();
  const distBefore = fs.readFileSync(path.join(repo, 'apps/web/dist/build-info.json'), 'utf8');
  fs.appendFileSync(path.join(repo, 'apps/web/src/screens/Backlog.tsx'), '\nexport const rompeBuild = (;\n'); // error de sintaxis en un módulo que sí se empaqueta: vite/esbuild no construye
  sh('git', ['-C', repo, 'add', 'apps/web/src/screens/Backlog.tsx']); sh('git', ['-C', repo, 'commit', '-qm', 'e2e: rompe el build (prueba de activación fallida)']);
  const up2 = await api('POST', '/api/system/update', { authorized: true, restart: true });
  let st2 = null; for (let i = 0; i < 180; i++) { await sleep(1000); try { const r = await api('GET', '/api/system/status'); if (r.body.update?.status === 'failed') { st2 = r.body; break; } if (r.body.startedAt !== prevStarted) { st2 = r.body; break; } } catch { /* reiniciando: no debería ocurrir */ } }
  const distAfter = fs.readFileSync(path.join(repo, 'apps/web/dist/build-info.json'), 'utf8');
  const alive = (await api('GET', '/api/health')).status === 200;
  step('13-activacion-fallida', up2.status === 200 && st2?.update.status === 'failed' && distBefore === distAfter && alive && st2.startedAt === prevStarted, `build falló; dist anterior intacta (${JSON.parse(distAfter).commit}); el Portal sigue respondiendo sin reiniciar; main íntegra (${sh('git', ['-C', repo, 'rev-parse', '--short', 'HEAD']).trim()})`);
  const l3 = (await api('GET', `/api/workspaces/portal-ia/lessons?projectId=${projectId}`)).body;
  step('13-leccion', l3.some(l => l.detector === 'activation_failed'), 'lección «activación fallida» detectada');
  sh('git', ['-C', repo, 'reset', '-q', '--hard', beforeHead]); // deshacer el commit de prueba en la COPIA temporal (nunca en tu repositorio)

  // ---------- 14 · compila pero no cambia el título → fallo en ejecución ----------
  setScript(NO_CHANGE);
  const item3 = (await api('POST', `/api/workspaces/portal-ia/projects/${projectId}/backlog`, { title: 'Título con contador (variante sin efecto, prueba negativa)', criterion: 'El h1 muestra (N abiertas) dos veces' })).body;
  const proc3 = (await api('POST', `/api/workspaces/portal-ia/projects/${projectId}/backlog/${item3.id}/execute`, { skipQa: true })).body;
  await api('POST', `/api/workspaces/portal-ia/processes/${proc3.id}/authorize`, { budgetUsd: 1, authorized: true });
  await waitProcess(slug, proc3.id);
  // La iteración 1 ya cambió el h1: el parche de esta variante busca el h1 original y no encaja → cambio no aplicable y lección patch_mismatch.
  let p3 = (await api('GET', `/api/workspaces/portal-ia/processes/${proc3.id}`)).body;
  const l4 = (await api('GET', `/api/workspaces/portal-ia/lessons?projectId=${projectId}`)).body;
  step('14-parche-no-encaja', p3.status === 'failed' && p3.result.changes[0].error && /aplicable/.test(p3.error) && l4.some(l => l.detector === 'patch_mismatch' && l.evidence.processId === proc3.id), `proceso «failed» con motivo claro (${p3.result.changes[0].error.slice(0, 60)}…), nada escrito, y lección patch_mismatch detectada sin IA`);

  // ---------- 15 · compila, se integra y se activa, pero el Portal en marcha no hace lo prometido → no se puede cerrar ----------
  if (!RUNTIME_FAIL.includes('pendientes')) throw new Error('el guion RUNTIME_FAIL no sustituyó la comprobación');
  setScript(RUNTIME_FAIL);
  const item4 = (await api('POST', `/api/workspaces/portal-ia/projects/${projectId}/backlog`, { title: 'Título con historias pendientes (prueba negativa en ejecución)', criterion: 'El h1 muestra (N pendientes)' })).body;
  const proc4 = (await api('POST', `/api/workspaces/portal-ia/projects/${projectId}/backlog/${item4.id}/execute`, { skipQa: true })).body;
  await api('POST', `/api/workspaces/portal-ia/processes/${proc4.id}/authorize`, { budgetUsd: 1, authorized: true });
  let p4 = await waitProcess(slug, proc4.id);
  const ap4 = await api('POST', `/api/workspaces/portal-ia/processes/${proc4.id}/apply`, { authorized: true });
  const v4 = [];
  for (const cmd of ['typecheck', 'test', 'build']) { const vr = await api('POST', `/api/workspaces/portal-ia/processes/${proc4.id}/verify`, { authorized: true, command: cmd }); v4.push(`${cmd}:${vr.body.result?.verifications?.at(-1)?.exitCode}`); }
  const m4 = await api('POST', `/api/workspaces/portal-ia/processes/${proc4.id}/merge`, { authorized: true });
  step('15-integrada', p4.status === 'done' && ap4.status === 200 && v4.every(x => x.endsWith(':0')) && m4.status === 200, `aplicada, verificada (${v4.join(', ')}) e integrada (${m4.body.result?.merged?.commit})`);
  await api('POST', '/api/system/update', { authorized: true, restart: true });
  sys = await waitHealth(prevStarted); prevStarted = sys.startedAt;
  p4 = (await api('GET', `/api/workspaces/portal-ia/processes/${proc4.id}`)).body;
  step('15-activada', p4.result.activation.active === true, `activada tras reconstruir y reiniciar (${sys.startCommit})`);
  const rc4 = await api('POST', `/api/workspaces/portal-ia/processes/${proc4.id}/runtime-check`, { authorized: true });
  const rr4 = rc4.body.result?.runtimeChecks?.results ?? [];
  const uiFail = rr4.find(x => x.check.kind === 'ui');
  step('15-comprobacion-falla', rc4.status === 200 && uiFail?.status === 'fail' && rr4.filter(x => x.check.kind === 'http').every(x => x.status === 'ok') && !!uiFail.evidence && fs.existsSync(uiFail.evidence), `ui /backlog: ${uiFail?.status} — ${uiFail?.detail?.slice(0, 110)} · captura ${uiFail?.evidence}`);
  step('15-fase', /comprobación en ejecución FALLÓ/.test(rc4.body.guidance.phase) && rc4.body.guidance.tone === 'err', `fase: ${rc4.body.guidance.phase}`);
  await api('POST', `/api/workspaces/portal-ia/processes/${proc4.id}/manual-test`, { checks: p4.result.manualTest.steps.map(() => true), note: 'marcada a mano: aun así no debe cerrarse' });
  const d4 = await api('POST', `/api/workspaces/portal-ia/backlog/${item4.id}/done`, {});
  step('15-cerrar-bloqueado', d4.status === 409 && d4.body.code === 'not_runtime_verified', `cerrar con la prueba manual marcada pero la comprobación en rojo → 409 ${d4.body.code}`);
  const l5 = (await api('GET', `/api/workspaces/portal-ia/lessons?projectId=${projectId}`)).body;
  step('15-leccion', l5.some(l => l.detector === 'runtime_failed' && l.evidence.processId === proc4.id), 'lección «comprobación en ejecución fallida» detectada sin IA, con la evidencia del navegador');
  await shot(`/historias/${item4.id}`, '12-historia-fallo-en-ejecucion');

  // ---------- Capturas de las pantallas nuevas (evidencia visual) ----------
  if (browser) {
    const snap = async (route, name, click = null) => { const page = await browser.newPage({ viewport: { width: 1360, height: 900 } }); await page.goto(base + route, { waitUntil: 'networkidle' }); await sleep(600); if (click) { await page.getByRole('button', { name: click }).first().click(); await sleep(500); } await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: !click }); await page.close(); };
    await snap('/conocimiento#lecciones', '06-conocimiento-lecciones');
    const devAgent = (await api('GET', '/api/workspaces/portal-ia/agents')).body.find(a => a.key === 'pj-dev');
    await snap(`/equipo/${devAgent.id}`, '07-agente-capacidades-plantilla');
    await snap(`/historias/${item.id}`, '08-historia-cerrada');
    await snap(`/historias/${item.id}`, '09-historia-chat', /Chat con el equipo/);
    await snap(`/historias/${item4.id}`, '10-historia-iteraciones', /Iteraciones/);
    await snap('/backlog', '11-backlog-final');
    step('capturas', true, 'lecciones, agente (capacidades, participación, plantilla), espacio de la historia (estado, chat, iteraciones), backlog');
  }

  // ---------- Resumen ----------
  const mock = fs.readFileSync(mockLog, 'utf8').trim().split('\n').length;
  step('fin', true, `${results.length} pasos en ${((Date.now() - t0) / 1000).toFixed(0)} s · ${mock} llamadas al proveedor SIMULADO (0 USD) · ninguna a un proveedor real`);
} catch (e) {
  console.error('✖', e.message);
  results.push({ id: 'error', ok: false, detail: e.message });
} finally {
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ at: new Date().toISOString(), base, repo, provider: 'simulado (PORTAL_MOCK_PROVIDER=1)', results }, null, 2));
  if (browser) await browser.close();
  try { await api('POST', '/api/system/restart', { confirm: true }); } catch { /* ya parado */ }
  await sleep(1500); try { sup.kill('SIGTERM'); } catch { /* ya parado */ }
  if (!keep) { await sleep(500); fs.rmSync(work, { recursive: true, force: true }); } else console.log('copia conservada en', work);
  console.log(`\nResultados: ${results.filter(r => r.ok).length}/${results.length} ok → ${path.join(OUT, 'results.json')}`);
  process.exit(results.every(r => r.ok) ? 0 : 1);
}
