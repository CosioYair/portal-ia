import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Desarrollo conversacional de ideas (v0.16). Proveedor simulado (0 USD), datos sintéticos. Escenario completo:
 * exploración → decisiones abiertas por el modelo (no las aprueba) → el propietario aprueba una y aplaza otra (persisten
 * en SQLite) → propuesta (solo con las decisiones cerradas; el equipo la redacta y OTRO especialista la cuestiona con
 * contexto propio) → revisión del equipo → aprobación → borradores de historias → historias creadas SOLO con el clic
 * autorizado, sin duplicar y con dependencias por título. En ningún momento se crea código ni procesos de historia.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-conv-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { resetMockCalls } = await import('@portal-ia/ai-adapters');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { backlogRepo, processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { buildApp } = await import('../src/app.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const project = projectsRepo(S).list()[0];
const app = await buildApp();
after(async () => { await app.close(); });
const inject = async (method: string, u: string, payload?: unknown) => { const r = await app.inject({ method: method as any, url: u, payload: payload as any }); return { status: r.statusCode, body: r.body ? r.json() : null }; };

const DECISIONS = '```actions\n' + JSON.stringify([
  { type: 'open_decision', question: '¿El tema oscuro se elige por usuario o sigue al sistema operativo?', context: 'Afecta a Ajustes y al arranque.', options: [{ label: 'Seguir al sistema', pros: 'Cero configuración', cons: 'Sin control' }, { label: 'Selector propio', pros: 'Control', cons: 'Más UI' }], recommendation: 'Seguir al sistema con opción de forzarlo', risks: ['Contraste insuficiente'] },
  { type: 'open_decision', question: '¿Se adapta también la vista de diferencias de código?', recommendation: null, risks: [] },
  { type: 'open_decision', question: '¿El tema oscuro se elige por usuario o sigue al sistema operativo?' } // repetida: no se duplica
]) + '\n```';
const PROPOSAL = '## Objetivo\nTema oscuro que sigue al sistema y se puede forzar.\n## Decisiones aprobadas\nD1 → Seguir al sistema con opción de forzarlo.\n## Criterios de aceptación\n- Con el sistema en oscuro, la app abre en oscuro.';
const STORIES = 'Historias en orden de prioridad.\n```backlog\n' + [
  { op: 'add', title: 'Base del tema oscuro v2', criterion: 'Los tokens tienen variante oscura', description: 'Origen: propuesta aprobada de la conversación', estimate: 'M', dependsOn: null, reason: 'Base' },
  { op: 'add', title: 'Selector de tema en Ajustes', criterion: 'Ajustes permite forzar claro u oscuro', description: 'Origen: propuesta aprobada de la conversación', estimate: 'S', dependsOn: 'Base del tema oscuro v2', reason: 'Control' },
  { op: 'add', title: 'Contraste accesible en modo oscuro', criterion: 'AA en todos los textos', description: 'Duplicada de una existente', estimate: 'S', dependsOn: null, reason: 'Accesibilidad' },
  { op: 'discard', story: 'HU-001', reason: 'una propuesta de historias nunca descarta' }
].map(o => JSON.stringify(o)).join('\n') + '\n```';
function script() {
  resetMockCalls(); try { fs.unlinkSync(logPath); } catch { /* vacío */ }
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: [
    { match: 'Cuestiona de forma INDEPENDIENTE', text: '**Mayor** · El criterio «abre en oscuro» no dice qué pasa si el usuario lo forzó. Corrección: precedencia explícita.' },
    { match: 'Valida el encargo', text: JSON.stringify({ accepted: true, understanding: 'COMPRENSION-DEL-REDACTOR: entiendo el encargo.', plan: ['Redactar'], consults: [{ agentKey: 'pj-arquitecto', question: '¿Riesgos técnicos del tema oscuro?' }] }) },
    { match: 'Te pregunta:', text: 'Riesgo: imágenes con fondo blanco. Recomiendo tokens semánticos.' },
    { match: 'Es la PROPUESTA', text: PROPOSAL },
    { match: 'Es la REVISIÓN DEL EQUIPO', text: '## Revisión\n- Arquitecto: falta la precedencia entre sistema y selector. Complejidad M.' },
    { match: 'Genera las HISTORIAS del backlog', text: STORIES },
    { match: 'Cómo trabajar en esta conversación', responses: [{ text: `Hay dos decisiones que cerrar antes de proponer nada.\n${DECISIONS}` }, { text: 'Anotado.' }] }
  ], markers: ['COMPRENSION-DEL-REDACTOR', 'Decisiones aprobadas por el propietario', 'Decisiones aplazadas', 'D2 [deferred]'] }));
}
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms; let v = await fn();
  while (!ok(v)) { if (Date.now() > end) throw new Error(`tiempo agotado esperando: ${what} · ${JSON.stringify(v).slice(0, 800)}`); await new Promise(r => setTimeout(r, 50)); v = await fn(); }
  return v;
}

test('idea → decisiones una a una → propuesta cuestionada → revisión del equipo → historias solo con tu clic; nada de código', async () => {
  script();
  addManualItem(S, project.id, { title: 'Contraste accesible en modo oscuro', criterion: 'AA', description: 'Ya existía' });
  const backlog0 = backlogRepo(S).list(project.id).length; const procs0 = processesRepo(S).list(project.id).length;
  const conv = await inject('POST', '/api/assistant/conversations', { title: 'Tema oscuro', workspaceSlug: S, projectId: project.id });
  assert.equal(conv.status, 201); const C = conv.body.id; const A = `/api/assistant/conversations/${C}`;

  // 1 · Exploración: el modelo abre decisiones (sin duplicar) y no aprueba ninguna.
  const m1 = await inject('POST', '/api/assistant/messages', { text: 'Quiero un tema oscuro. Ayúdame a decidir cómo.', conversationId: C });
  assert.equal(m1.status, 200, JSON.stringify(m1.body));
  assert.deepEqual(m1.body.assistant.actions.map((a: any) => [a.type, a.status]), [['open_decision', 'done'], ['open_decision', 'done']], 'la pregunta repetida no se duplica');
  let d = (await inject('GET', A)).body;
  assert.equal(d.stage, 'decisions'); assert.equal(d.decisions.length, 2);
  assert.ok(d.decisions.every((x: any) => x.status === 'open' && x.answer === null), 'el modelo no aprueba decisiones');
  assert.equal(backlogRepo(S).list(project.id).length, backlog0); assert.equal(processesRepo(S).list(project.id).length, procs0, 'explorar no crea procesos');
  const [D1, D2] = d.decisions;

  // Sin decisiones cerradas no hay propuesta.
  const early = await inject('POST', `${A}/artifacts`, { kind: 'proposal' });
  assert.equal(early.status, 409); assert.equal(early.body.code, 'open_decisions');
  const noAnswer = await inject('POST', `${A}/decisions/${D2.id}/approve`, {});
  assert.equal(noAnswer.status, 400, 'aprobar sin respuesta ni recomendación se rechaza'); assert.equal(noAnswer.body.code, 'answer_required');

  // 2 · El propietario decide UNA a una: aprueba D1 (la recomendación), aplaza D2. La otra no cambia.
  const ok1 = await inject('POST', `${A}/decisions/${D1.id}/approve`, {});
  assert.equal(ok1.body.status, 'approved'); assert.equal(ok1.body.answer, 'Seguir al sistema con opción de forzarlo');
  assert.equal((await inject('GET', A)).body.decisions.find((x: any) => x.id === D2.id).status, 'open', 'decidir una no toca la otra');
  const def2 = await inject('POST', `${A}/decisions/${D2.id}/defer`, { note: 'Más adelante' });
  assert.equal(def2.body.status, 'deferred');
  const rev1 = await inject('POST', `${A}/decisions/${D1.id}/revise`, { answer: 'Seguir al sistema; forzarlo en Ajustes' });
  assert.equal(rev1.body.answer, 'Seguir al sistema; forzarlo en Ajustes'); assert.deepEqual(rev1.body.history.map((h: any) => h.status), ['approved', 'approved'], 'el historial guarda cada cambio');

  // Persistencia: lo decidido está en SQLite (otra conexión, como tras un reinicio) y el siguiente mensaje lo ve.
  const raw = new DatabaseSync(path.join(process.env.PORTAL_DATA_DIR!, 'platform.sqlite'), { readOnly: true });
  const rows = raw.prepare(`SELECT status AS st FROM assistant_decisions WHERE conversation_id = ? ORDER BY seq`).all(C) as any[];
  raw.close();
  assert.deepEqual(rows.map(r => r.st), ['approved', 'deferred']);
  await inject('POST', '/api/assistant/messages', { text: 'Sigamos.', conversationId: C });
  const chatPrompt = calls().filter(c => c.rule === 'Cómo trabajar en esta conversación').at(-1);
  assert.ok(chatPrompt?.markers.includes('D2 [deferred]'), 'el siguiente mensaje ve el registro de decisiones');
  d = (await inject('GET', A)).body;
  assert.match(d.next, /Preparar propuesta/, 'siempre hay una siguiente acción clara');

  // 3 · Propuesta: pendiente de autorización, sin llamadas; con ella, el equipo la redacta y OTRO la cuestiona.
  const callsBefore = calls().length;
  const prop = await inject('POST', `${A}/artifacts`, { kind: 'proposal' });
  assert.equal(prop.status, 201, JSON.stringify(prop.body));
  assert.equal(prop.body.process.status, 'pending_authorization'); assert.equal(calls().length, callsBefore, 'preparar no llama a la IA');
  const challengeStep = prop.body.process.steps.find((s: any) => s.title === 'Cuestionamiento independiente de la propuesta');
  assert.ok(challengeStep, 'la propuesta incluye el cuestionamiento');
  const leadStep = prop.body.process.steps[0];
  assert.notEqual(challengeStep.agentId, leadStep.agentId, 'quien cuestiona no es quien redacta');
  assert.ok(!prop.body.process.steps.some((s: any) => s.title.startsWith('Consulta a') && s.agentId === challengeStep.agentId), 'a quien cuestiona no se le consulta al redactar');
  assert.match((await inject('GET', A)).body.next, /^Autoriza la propuesta/, 'la siguiente acción es autorizar lo que espera, no revisarlo');
  // Historias sin propuesta aprobada: no.
  const storiesEarly = await inject('POST', `${A}/artifacts`, { kind: 'stories' });
  assert.equal(storiesEarly.status, 409); assert.equal(storiesEarly.body.code, 'proposal_not_approved');
  const auth = await inject('POST', `${W}/processes/${prop.body.process.id}/authorize`, { budgetUsd: 5, authorized: true });
  assert.equal(auth.status, 200, JSON.stringify(auth.body));
  d = await waitFor(async () => (await inject('GET', A)).body, v => v.artifacts[0]?.status === 'ready', 'propuesta lista');
  const pa = d.artifacts[0];
  assert.match(pa.deliverable, /Tema oscuro que sigue al sistema/); assert.match(pa.challenge.text, /precedencia/);
  assert.equal(d.stage, 'proposal');
  const challengeCall = calls().find(c => c.rule === 'Cuestiona de forma INDEPENDIENTE');
  assert.ok(!challengeCall.markers.includes('COMPRENSION-DEL-REDACTOR'), 'el cuestionamiento no hereda el razonamiento del redactor');
  const synth = calls().find(c => c.rule === 'Es la PROPUESTA');
  assert.ok(synth.markers.includes('Decisiones aprobadas por el propietario') && synth.markers.includes('Decisiones aplazadas'), 'la propuesta recibe lo aprobado y lo aplazado');
  assert.deepEqual(pa.backlogOps, [], 'una propuesta no propone cambios al backlog');
  assert.ok(!pa.consulted.some((c: any) => c.agentName === pa.challenge.agentName), 'quien cuestiona no participó en la redacción');

  // 4 · Revisión del equipo (con consulta al arquitecto).
  const tr = await inject('POST', `${A}/artifacts`, { kind: 'team_review' });
  assert.equal(tr.status, 201);
  await inject('POST', `${W}/processes/${tr.body.process.id}/authorize`, { budgetUsd: 5, authorized: true });
  d = await waitFor(async () => (await inject('GET', A)).body, v => v.artifacts.find((a: any) => a.kind === 'team_review')?.status === 'ready', 'revisión lista');
  const review = d.artifacts.find((a: any) => a.kind === 'team_review');
  assert.match(review.deliverable, /precedencia/); assert.ok(review.consulted.some((c: any) => /tokens semánticos/.test(c.answer)), 'aporta el especialista consultado');
  assert.equal(d.stage, 'team_review');

  // 5 · Aprobación de la propuesta → borradores de historias (aún sin crear).
  const ap = await inject('POST', `${A}/artifacts/${pa.id}/approve`, { note: 'Adelante' });
  assert.equal(ap.body.status, 'approved');
  assert.equal((await inject('GET', A)).body.stage, 'approved');
  const st = await inject('POST', `${A}/artifacts`, { kind: 'stories' });
  assert.equal(st.status, 201);
  await inject('POST', `${W}/processes/${st.body.process.id}/authorize`, { budgetUsd: 5, authorized: true });
  d = await waitFor(async () => (await inject('GET', A)).body, v => v.artifacts.find((a: any) => a.kind === 'stories')?.status === 'ready', 'borradores listos');
  const drafts = d.artifacts.find((a: any) => a.kind === 'stories');
  assert.deepEqual(drafts.backlogOps.map((o: any) => o.op), ['add', 'add', 'add'], 'solo altas: nunca descarta ni reprioriza');
  assert.equal(backlogRepo(S).list(project.id).length, backlog0, 'los borradores no tocan el backlog');
  assert.doesNotMatch(drafts.deliverable, /se cortó/, 'un bloque cerrado con un objeto por línea no es un corte');

  // 6 · Crear historias: exige autorización explícita; sin duplicados; dependencia por título; no se repite.
  const noAuth = await inject('POST', `${A}/artifacts/${drafts.id}/create-stories`, {});
  assert.equal(noAuth.status, 403);
  const created = await inject('POST', `${A}/artifacts/${drafts.id}/create-stories`, { authorized: true });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const items = backlogRepo(S).list(project.id);
  assert.equal(items.length, backlog0 + 2, 'la duplicada no se crea');
  assert.ok(created.body.summary.some((s: string) => /ya existía/.test(s)));
  const base = items.find(i => i.title === 'Base del tema oscuro v2')!; const sel = items.find(i => i.title === 'Selector de tema en Ajustes')!;
  assert.equal(sel.dependsOn, base.storyId, 'dependencia resuelta por título, no por la cifra del título');
  assert.match(sel.description ?? '', /Origen: propuesta aprobada/);
  assert.ok(items.some(i => i.storyId === 'HU-001' ? i.status !== 'discarded' : true), 'nada se descartó');
  assert.equal((await inject('POST', `${A}/artifacts/${drafts.id}/create-stories`, { authorized: true })).status, 409, 'no se crean dos veces');
  d = (await inject('GET', A)).body;
  assert.equal(d.stage, 'backlog');
  // Nada de código: solo encargos de análisis; ninguna ejecución de historia.
  assert.ok(processesRepo(S).list(project.id).slice(0, processesRepo(S).list(project.id).length - procs0).every(p => p.kind === 'delegated_task'));
  assert.ok(processesRepo(S).list(project.id).every(p => p.kind !== 'story_execution'));
});

test('conversaciones: «Limpiar» archiva sin borrar; leer no escribe; alcance validado', async () => {
  const list0 = await inject('GET', '/api/assistant');
  const before = JSON.stringify(list0.body.conversations);
  assert.equal(JSON.stringify((await inject('GET', '/api/assistant')).body.conversations), before, 'leer no crea ni cambia conversaciones');
  assert.equal((await inject('POST', '/api/assistant/conversations', { workspaceSlug: 'no-existe' })).status, 404);
  const noScope = await inject('POST', '/api/assistant/conversations', { title: 'Sin alcance' });
  assert.equal((await inject('POST', `/api/assistant/conversations/${noScope.body.id}/artifacts`, { kind: 'proposal' })).body.code, 'no_scope');
  const total = (await inject('GET', `/api/assistant/conversations/${list0.body.conversations[0].id}`)).body.messages.length;
  await inject('DELETE', '/api/assistant/messages');
  const after = (await inject('GET', '/api/assistant')).body;
  assert.ok(after.conversations.every((c: any) => c.status === 'archived'));
  assert.equal((await inject('GET', `/api/assistant/conversations/${list0.body.conversations[0].id}`)).body.messages.length, total, 'los mensajes se conservan');
});

test('imágenes: llegan al modelo como bloques (no se finge haberlas analizado)', async () => {
  script();
  const conv = await inject('POST', '/api/assistant/conversations', {});
  assert.equal(conv.body.title, 'Nueva conversación');
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const r = await inject('POST', '/api/assistant/messages', { text: 'Mira esta captura.', conversationId: conv.body.id, images: [{ mediaType: 'image/png', data: png, name: 'a.png' }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.attachments[0].name, 'a.png');
  assert.equal(calls().at(-1).images, 1, 'la imagen se envía al proveedor');
  assert.equal((await inject('GET', `/api/assistant/conversations/${conv.body.id}`)).body.conversation.title, 'Mira esta captura.', 'el primer mensaje titula la conversación');
});
