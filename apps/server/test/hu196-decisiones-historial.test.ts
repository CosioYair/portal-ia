import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * HU-196 · Decisiones sale del menú y pasa a historial accesible desde la campana. Servicio y ruta del historial de la
 * empresa (solo lectura, sin IA) y cableado de menú, campana, redirección, Panel y pestañas. Proveedor simulado (0 USD).
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu196-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, INTERNAL_WORKSPACE } = await import('@portal-ia/domain');
const ai = await import('@portal-ia/ai-adapters');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { projectsRepo } = await import('../src/db/workspace.ts');
const { createCompany } = await import('../src/services/companies.ts');
const { conversationsRepo } = await import('../src/db/conversations.ts');
const { proposeDecisions } = await import('../src/services/conversations.ts');
const { listDecisionHistory, decisionHistoryFromProcess } = await import('../src/services/inbox.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
const S = runBootstrap().workspace.slug; const W = `/api/workspaces/${S}`;
const project = projectsRepo(S).list()[0];
const app = await buildApp();
after(async () => { await app.close(); });
const inject = async (method: string, u: string, payload?: unknown) => { const r = await app.inject({ method: method as any, url: u, payload: payload as any }); return { status: r.statusCode, body: r.body ? r.json() : null }; };
const opts = [{ label: 'Primera opción', pros: 'Simple', cons: 'Limitada' }, { label: 'Segunda opción', pros: 'Flexible', cons: 'Más trabajo' }];

test('HU-196 · historial vacío en una empresa nueva, y aprobadas y denegadas con su resultado tras decidir', async () => {
  ai.resetMockCalls();
  const fresh = createCompany('Empresa Vacía HU-196');
  assert.deepEqual(listDecisionHistory(fresh.slug), [], 'sin decisiones resueltas, historial vacío');
  const emptyRoute = await inject('GET', `/api/workspaces/${fresh.slug}/inbox/history`);
  assert.equal(emptyRoute.status, 200);
  assert.deepEqual(emptyRoute.body, []);

  const conv = conversationsRepo.create('Prueba HU-196', S, project.id);
  const [dA, dB] = proposeDecisions(conv.id, null, [
    { question: '¿Aprobamos la propuesta HU-196?', options: opts, recommendation: 'Opción recomendada', risks: [] },
    { question: '¿Denegamos la propuesta HU-196?', options: opts, recommendation: null, risks: [] }
  ]);
  assert.ok(dA && dB, 'se crean dos propuestas');
  assert.equal((await inject('POST', `${W}/inbox/assistant_decision/${dA.id}/decision`, { verdict: 'approve' })).status, 200);
  assert.equal((await inject('POST', `${W}/inbox/assistant_decision/${dB.id}/decision`, { verdict: 'deny', reason: 'No hace falta' })).status, 200);

  const hist = listDecisionHistory(S);
  const a = hist.find(h => h.id === `assistant_decision:${dA.id}`);
  const b = hist.find(h => h.id === `assistant_decision:${dB.id}`);
  assert.ok(a && b, 'las dos decisiones resueltas aparecen en el historial');
  assert.equal(a!.verdict, 'approve'); assert.equal(a!.reason, 'Opción recomendada'); assert.equal(a!.conversationId, conv.id);
  assert.equal(b!.verdict, 'deny'); assert.equal(b!.kind, 'assistant_decision');
  for (let i = 1; i < hist.length; i++) assert.ok(hist[i - 1].decidedAt >= hist[i].decidedAt, 'de la más reciente a la más antigua');
  assert.ok(!listDecisionHistory(fresh.slug).length, 'no se mezclan empresas');

  assert.equal(listDecisionHistory(S, { limit: 1 }).length, 1, 'respeta el límite');
  const one = await inject('GET', `${W}/inbox/history?limit=1`);
  assert.equal(one.status, 200); assert.equal(one.body.length, 1);
  assert.equal(ai.mockCalls, 0, 'el historial no llama a la IA');
});

test('HU-196 · decisionHistoryFromProcess lee denegaciones, rechazos con motivo y aprobaciones del proceso', () => {
  const base = { id: 'p1', title: 'Historia X', projectId: 'pj', backlogItemId: 'b1', createdAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-02T00:00:00.000Z', steps: [], supersededBy: null };
  const denied = decisionHistoryFromProcess('ws', { ...base, kind: 'story_execution', status: 'cancelled', result: null } as any);
  assert.deepEqual(denied.map(d => [d.kind, d.verdict]), [['process_authorization', 'deny']]);
  const rejected = decisionHistoryFromProcess('ws', { ...base, kind: 'story_execution', status: 'done', authorizedAt: '2026-01-01T01:00:00.000Z', result: { changes: [], applied: null, merged: null, published: null, rejected: { at: '2026-01-03T00:00:00.000Z', reason: ' No convence ' } } } as any);
  assert.deepEqual(rejected.map(d => [d.kind, d.verdict, d.reason]), [['process_authorization', 'approve', null], ['apply_diff', 'deny', 'No convence']]);
  const done = decisionHistoryFromProcess('ws', { ...base, kind: 'story_execution', status: 'done', authorizedAt: '2026-01-01T01:00:00.000Z', result: { changes: [], rejected: null, applied: { appliedAt: '2026-01-03T00:00:00.000Z', branch: 'b', files: [] }, merged: { mergedAt: '2026-01-04T00:00:00.000Z', into: 'main' }, published: { pushedAt: '2026-01-05T00:00:00.000Z' } } } as any);
  assert.deepEqual(done.map(d => d.kind), ['process_authorization', 'apply_diff', 'integrate', 'publish']);
  assert.ok(done.every(d => d.verdict === 'approve' && d.storyId === 'b1'));
});

test('HU-196 · comprobación en ejecución: historial de la empresa real con limit=1 da 200 y un array JSON', async () => {
  // Replica la línea de COMPROBACIONES «- http GET /api/workspaces/portal-ia/inbox/history?limit=1 | /^\[/».
  assert.equal(S, INTERNAL_WORKSPACE.slug, 'la empresa de runBootstrap es la empresa interna del Portal');
  assert.equal(S, 'portal-ia', 'el slug declarado en COMPROBACIONES coincide con el real');
  const r = await app.inject({ method: 'GET', url: `/api/workspaces/${INTERNAL_WORKSPACE.slug}/inbox/history?limit=1` });
  assert.equal(r.statusCode, 200, 'el verificador en ejecución solo acepta 2xx');
  assert.match(String(r.headers['content-type'] ?? ''), /application\/json/);
  assert.match(r.body, /^\[/, 'el cuerpo serializado es un array JSON');
  const body = JSON.parse(r.body);
  assert.ok(Array.isArray(body), 'el cuerpo es un array');
  assert.ok(body.length <= 1, 'respeta limit=1');
});

// Casos negativos SOLO como prueba unitaria: no se declaran en COMPROBACIONES (el verificador trata todo no-2xx como fallo).
test('HU-196 · ruta: 400 con límite no válido y 404 si la empresa no existe', async () => {
  for (const bad of ['0', '501', 'abc']) assert.equal((await inject('GET', `${W}/inbox/history?limit=${bad}`)).status, 400, `limit=${bad}`);
  assert.equal((await inject('GET', '/api/workspaces/no-existe-hu196/inbox/history')).status, 404);
});

const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');

test('HU-196 · cableado: menú sin Decisiones, campana, redirección, Panel y pestañas', () => {
  const routes = read('lib/routes.ts');
  const line = routes.split('\n').find(l => l.includes("id: 'decisiones'"));
  assert.ok(line && /inMenu: false/.test(line) && line.includes("path: '/autorizaciones'"), 'Decisiones sigue registrada, fuera del menú');
  const shell = read('components/Shell.tsx');
  assert.match(shell, /s\.inMenu !== false/, 'el menú excluye las secciones con inMenu: false');
  assert.match(shell, /<Link className="top-icon" to="\/autorizaciones"/, 'la campana lleva a /autorizaciones');
  assert.ok(shell.includes('top-badge') && shell.includes('e historial'), 'la campana conserva el contador y nombra el historial');
  assert.match(read('App.tsx'), /<Route path="\/decisiones" element=\{<Redirect to="\/autorizaciones" \/>\} \/>/, '/decisiones redirige');
  assert.match(read('screens/Dashboard.tsx'), /'Revisar y decidir', onClick: \(\) => navigate\('\/autorizaciones'\)/, 'el Panel lleva a /autorizaciones');
  const inbox = read('screens/InboxScreen.tsx');
  assert.ok(inbox.includes('role="tablist"') && inbox.includes('Historial') && inbox.includes('api.inboxHistory(slug)'), 'pestañas e historial');
  for (const t of ['Aprobada', 'Denegada', 'Superada']) assert.ok(inbox.includes(t), `filtro de resultado «${t}»`);
  assert.match(read('lib/api.ts'), /inboxHistory: \(slug: string, limit\?: number\)/);
});
