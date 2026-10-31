import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

/**
 * Recorrido completo del Asistente (prioridad 5), de punta a punta, en una instancia aislada: proveedor SIMULADO (0 USD,
 * ninguna llamada real), repositorio sintético y el SANDBOX DOCKER REAL para verificar el encargo. Exige Docker: sin él se
 * omite y lo dice (también dentro del sandbox del propio Portal), salvo con PORTAL_REQUIRE_DOCKER=1, donde FALLA. Pasos: conversación con alcance → investigar una idea → cerrar decisiones
 * una a una → guardar y recuperar → propuesta con cuestionamiento independiente → consultar al equipo → autorizar la
 * creación de historias → encargo de desarrollo SIN historia → verificado con Docker, QA y Gauntlet (con revisión del plan)
 * → revisar y pedir cambios → segunda iteración → el trabajo terminado queda en el historial (Conocimiento).
 * En cada paso se comprueba que nada gasta, cambia código ni crea historias sin la autorización correspondiente.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-journey-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
delete process.env.PORTAL_SANDBOX;
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { backlogRepo, claudeCodeRunsRepo, knowledgeRepo, processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { sandboxDeps } = await import('../src/services/verification.ts');
const { buildApp } = await import('../src/app.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const project = projectsRepo(S).list()[0];
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-journey-repo-'));
const uniq = `journey-${Date.now().toString(36)}`;
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src/pie.ts'), 'export const pie = "Hola";\n');
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: uniq, version: '1.0.0', private: true, scripts: { typecheck: 'node -e ""', test: 'node -e "require(\'fs\').readFileSync(\'src/pie.ts\',\'utf8\').includes(\'Hola, mundo\') || process.exit(1)"', build: 'node -e ""' } }, null, 2));
fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ name: uniq, version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: uniq, version: '1.0.0' } } }, null, 2));
const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, windowsHide: true }).toString().trim();
git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-qm', 'Base');
const mainHead = git('rev-parse', 'main');
projectsRepo(S).setRepository(project.id, repo, 'main');
const app = await buildApp();
after(async () => { await app.close(); });
const json = async (method: string, url: string, payload?: unknown) => { const r = await app.inject({ method: method as any, url, payload: payload as any }); return { status: r.statusCode, body: r.body ? r.json() : null }; };
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 180_000): Promise<T> {
  const end = Date.now() + ms; let v = await fn();
  while (!ok(v)) { if (Date.now() > end) throw new Error(`tiempo agotado esperando: ${what} · ${JSON.stringify(v).slice(0, 1200)}`); await new Promise(r => setTimeout(r, 200)); v = await fn(); }
  return v;
}
const stories = () => backlogRepo(S).list(project.id).length;
const block = (acts: unknown[]) => '```actions\n' + JSON.stringify(acts) + '\n```';

const PLAN = JSON.stringify({ summary: 'Cambiar el texto del pie', tasks: ['Editar src/pie.ts'], filesToRead: ['src/pie.ts'], filesToChange: ['src/pie.ts'], acceptance: ['src/pie.ts exporta «Hola, mundo»', 'la prueba del pie pasa'], risks: [] });
const DEV = (v: string) => `=== RESUMEN ===\nCambia el pie.\n=== ARCHIVO: src/pie.ts | patch ===\n<<<< BUSCAR\nexport const pie = "Hola";\n==== REEMPLAZAR\nexport const pie = "${v}";\n>>>> FIN\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nEl pie dice ${v}.\n=== PRUEBA MANUAL ===\n1. Abre src/pie.ts. Esperado: ${v}.`;
const QA_OK = JSON.stringify({ verdict: 'approved', summary: 'Cumple; verificación en verde.', findings: [], suggestedTests: [] });
const EV_PASS = JSON.stringify({ verdict: 'pass', criteria: [{ criterion: 'src/pie.ts exporta «Hola, mundo»', status: 'met', evidence: 'src/pie.ts:1 export const pie = "Hola, mundo";' }, { criterion: 'la prueba del pie pasa', status: 'met', evidence: 'test: en verde (docker)' }], findings: [], largestGap: null, anotherRoundWorthIt: false, limitations: [] });
const REVIEW_OK = JSON.stringify({ verdict: 'approve', coverage: [{ criterion: 'src/pie.ts exporta «Hola, mundo»', covered: 'yes', evidence: 'tasks[0] Editar src/pie.ts' }], gaps: [] });
function script() {
  fs.writeFileSync(scriptPath, JSON.stringify({ markers: ['Nota del propietario: usa una coma'], rules: [
    // Primero las respuestas del chat (ancladas al final del mensaje): el esquema del Asistente menciona «implementa la historia».
    { match: 'Propietario: Quiero un pie configurable[^\\n]*$', text: `Dos decisiones antes de proponer.\n${block([{ type: 'open_decision', question: '¿El texto del pie se edita en Ajustes o en un archivo?', options: [{ label: 'Ajustes' }, { label: 'Archivo' }], recommendation: 'Ajustes', risks: [] }, { type: 'open_decision', question: '¿Se traduce el pie?', recommendation: null, risks: [] }])}` },
    { match: 'Propietario: Arregla el texto del pie[^\\n]*$', text: `Lo preparo como encargo de desarrollo.\n${block([{ type: 'propose_assignment', company: S, project: project.name, title: 'Corregir el texto del pie', request: 'Arregla el texto del pie y déjalo listo para revisar', objective: 'Que el pie diga «Hola, mundo».', criteria: ['src/pie.ts exporta «Hola, mundo»', 'la prueba del pie pasa'], outOfScope: ['estilos'], size: 'S' }])}` },
    { match: 'REVISIÓN DEL PLAN', text: REVIEW_OK },
    { match: 'Cuestiona de forma INDEPENDIENTE', text: '**Mayor** · El criterio no dice si el texto se traduce. Corrección mínima: fijarlo en español.' },
    { match: 'Valida el encargo', text: JSON.stringify({ accepted: true, understanding: 'Redactaré con las decisiones aprobadas.', plan: ['Redactar'], consults: [{ agentKey: 'pj-qa', question: '¿Cómo se prueba?' }] }) },
    { match: 'Te pregunta:', text: 'Con una prueba que lea el texto exportado.' },
    { match: 'Es la PROPUESTA', text: '## Objetivo\nPie configurable.\n## Criterios de aceptación\n- El pie muestra el texto elegido.' },
    { match: 'Es la REVISIÓN DEL EQUIPO', text: '## Revisión\n- QA: añadir una prueba del texto.' },
    { match: 'Genera las HISTORIAS del backlog', text: 'Historias.\n```backlog\n[{"op":"add","title":"Pie configurable desde Ajustes","criterion":"El pie muestra el texto elegido","description":"Origen: propuesta aprobada de la conversación","estimate":"S","dependsOn":null,"reason":"Base"}]\n```' },
    { match: 'Elabora el plan técnico', text: PLAN },
    { match: 'Evalúa la implementación con la EVIDENCIA real', text: QA_OK },
    { match: 'Evalúa de forma INDEPENDIENTE', text: EV_PASS },
    { match: 'Nota del propietario: usa una coma', text: DEV('Hola, mundo') },
    { match: 'Implementa la historia', text: DEV('Hola, mundo') },
    { match: 'Cómo trabajar en esta conversación', text: 'Anotado.' }
  ] }));
}

// Sin Docker (otro equipo, o dentro del sandbox del propio Portal, que no tiene Docker) se omite y lo dice; con
// PORTAL_REQUIRE_DOCKER=1 (la puerta de integración) FALLA: nunca se da por superada sin Docker.
const requireDocker = process.env.PORTAL_REQUIRE_DOCKER === '1';
const dockerReady = (await sandboxDeps.detect(true)).available === 'docker';
test('recorrido completo del Asistente con el sandbox Docker real (sin omitir Docker)', { skip: dockerReady || requireDocker ? false : 'Docker no disponible (obligatoria con PORTAL_REQUIRE_DOCKER=1)' }, async () => {
  const det = await sandboxDeps.detect(true);
  assert.equal(det.available, 'docker', `Esta prueba exige Docker: ${det.detail ?? det.available}`);
  script();
  const s0 = stories();
  // Evaluador Gauntlet aprobado por el propietario (necesario para Gauntlet y la revisión del plan).
  assert.equal((await json('POST', `${W}/projects/${project.id}/gauntlet/evaluator`, { authorized: true })).status, 201);

  // 1 · Conversación con alcance.
  const conv = await json('POST', '/api/assistant/conversations', { workspaceSlug: S, projectId: project.id }); assert.equal(conv.status, 201);
  const C = conv.body.id; const A = `/api/assistant/conversations/${C}`;
  // 2 · Investigar la idea: decisiones abiertas por el modelo, ninguna aprobada.
  const m1 = await json('POST', '/api/assistant/messages', { text: 'Quiero un pie configurable, ayúdame a decidir cómo.', conversationId: C });
  assert.equal(m1.status, 200); let d = (await json('GET', A)).body;
  assert.equal(d.decisions.length, 2); assert.ok(d.decisions.every((x: any) => x.status === 'open')); assert.equal(stories(), s0);
  // 3 · Cerrar decisiones una a una.
  await json('POST', `${A}/decisions/${d.decisions[0].id}/approve`, {}); await json('POST', `${A}/decisions/${d.decisions[1].id}/defer`, {});
  // 4 · Guardar y recuperar: el registro está en SQLite (otra conexión, como tras reiniciar) y la conversación vuelve entera.
  const raw = new DatabaseSync(path.join(process.env.PORTAL_DATA_DIR!, 'platform.sqlite'), { readOnly: true });
  assert.deepEqual((raw.prepare(`SELECT status FROM assistant_decisions WHERE conversation_id = ? ORDER BY seq`).all(C) as any[]).map(r => r.status), ['approved', 'deferred']); raw.close();
  d = (await json('GET', `/api/assistant?conversationId=${C}`)).body.detail; assert.match(d.next, /Preparar propuesta/);
  // 6 · Propuesta con cuestionamiento independiente (preparar no gasta; autorizar sí).
  const before = calls().length;
  const prop = await json('POST', `${A}/artifacts`, { kind: 'proposal' }); assert.equal(prop.status, 201); assert.equal(calls().length, before, 'preparar no llama a la IA');
  await json('POST', `${W}/processes/${prop.body.process.id}/authorize`, { budgetUsd: 3, authorized: true });
  d = await waitFor(async () => (await json('GET', A)).body, v => v.artifacts[0]?.status === 'ready', 'propuesta');
  assert.match(d.artifacts[0].challenge.text, /Corrección mínima/);
  // 5 · Consultar al equipo.
  const tr = await json('POST', `${A}/artifacts`, { kind: 'team_review' }); await json('POST', `${W}/processes/${tr.body.process.id}/authorize`, { budgetUsd: 3, authorized: true });
  d = await waitFor(async () => (await json('GET', A)).body, v => v.artifacts.find((a: any) => a.kind === 'team_review')?.status === 'ready', 'revisión del equipo');
  // 7 · Autorizar la creación de historias (solo con la propuesta aprobada y el clic autorizado).
  await json('POST', `${A}/artifacts/${d.artifacts[0].id}/approve`, {});
  const st = await json('POST', `${A}/artifacts`, { kind: 'stories' }); await json('POST', `${W}/processes/${st.body.process.id}/authorize`, { budgetUsd: 3, authorized: true });
  d = await waitFor(async () => (await json('GET', A)).body, v => v.artifacts.find((a: any) => a.kind === 'stories')?.status === 'ready', 'borradores');
  assert.equal(stories(), s0, 'los borradores no crean historias');
  assert.equal((await json('POST', `${A}/artifacts/${d.artifacts.find((a: any) => a.kind === 'stories').id}/create-stories`, {})).status, 403);
  assert.equal((await json('POST', `${A}/artifacts/${d.artifacts.find((a: any) => a.kind === 'stories').id}/create-stories`, { authorized: true })).status, 200);
  const s1 = stories(); assert.equal(s1, s0 + 1);

  // 8 · Encargo de desarrollo directo, SIN historia: borrador sin proceso hasta autorizarlo.
  const m2 = await json('POST', '/api/assistant/messages', { text: 'Arregla el texto del pie y déjalo listo para revisar', conversationId: C });
  const act = m2.body.assistant.actions.find((a: any) => a.type === 'propose_assignment'); assert.ok(act?.assignmentId);
  const E = `${W}/assignments/${act.assignmentId}`;
  assert.equal((await json('GET', E)).body.status, 'draft'); assert.equal(processesRepo(S).list(project.id).filter(p => p.assignmentId === act.assignmentId).length, 0);
  assert.equal(git('rev-parse', 'main'), mainHead, 'sin autorización no cambia el código');
  // 9 · Verificado con Docker real, QA y Gauntlet (profundo: con revisión del plan antes de implementar).
  const auth1 = await json('POST', `${E}/authorize`, { authorized: true, budgetUsd: 3, allowInstall: true, gauntlet: { mode: 'deep' } });
  assert.equal(auth1.status, 200, JSON.stringify(auth1.body));
  let a = await waitFor(async () => (await json('GET', E)).body, v => !['running', 'pending_authorization'].includes(v.status), 'primera ejecución', 600_000);
  assert.equal(a.status, 'ready_for_review', `${a.status}: ${a.reason ?? ''}`);
  const p1 = processesRepo(S).get(a.processId)!;
  for (const cmd of ['typecheck', 'test', 'build']) assert.ok(p1.result!.verifications.some(v => v.command === cmd && v.exitCode === 0 && v.isolation === 'docker'), `${cmd} en Docker real`);
  assert.equal(p1.result!.review?.verdict, 'approved'); assert.equal(p1.result!.gauntlet?.status, 'passed');
  assert.equal(p1.result!.gauntlet?.planReview?.status, 'approved', 'el plan se revisó antes de implementar');
  assert.equal(stories(), s1, 'el encargo no crea historias'); assert.equal(git('rev-parse', 'main'), mainHead, 'nunca integra solo en main');
  assert.match(p1.result!.applied!.branch, /en-\d{3}/i);
  // 10 · Revisar y pedir cambios: la siguiente ejecución se autoriza aparte y recibe la nota.
  assert.equal((await json('POST', `${E}/changes`, { note: 'Nota del propietario: usa una coma después de Hola', discardApplied: true })).status, 200);
  assert.equal((await json('POST', `${E}/authorize`, { authorized: true, budgetUsd: 3, allowInstall: true, gauntlet: { mode: 'standard' } })).status, 200);
  a = await waitFor(async () => (await json('GET', E)).body, v => v.processIds.length === 2 && !['running', 'pending_authorization'].includes(v.status), 'segunda ejecución', 600_000);
  assert.equal(a.status, 'ready_for_review', `${a.status}: ${a.reason ?? ''}`);
  assert.ok(calls().some(c => c.markers?.includes('Nota del propietario: usa una coma')), 'la nota llega a los agentes');
  const old = processesRepo(S).get(p1.id)!; assert.ok(old.result!.rejected, 'la versión anterior no integrada se descartó al pedir cambios');
  assert.equal((await json('POST', `${W}/processes/${p1.id}/merge`, { authorized: true })).status, 409, 'y ya no se puede integrar');
  // 11 · El trabajo terminado queda en el historial de la organización.
  assert.ok(a.knowledgeDocId); assert.ok(knowledgeRepo(S).list(project.id).some(k => k.id === a.knowledgeDocId));
  assert.ok(knowledgeRepo(S).list(project.id).some(k => /^Propuesta/.test(k.title)), 'la propuesta también quedó en Conocimiento');
  // Nada real: proveedor simulado y ninguna ejecución de Claude Code.
  assert.equal(claudeCodeRunsRepo(S).countForProcesses(processesRepo(S).list(project.id).map(p => p.id)), 0);
});
