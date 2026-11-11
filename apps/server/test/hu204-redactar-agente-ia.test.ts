import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * HU-204 · «Redactar con IA» en «Nuevo agente». Proveedor SIMULADO (0 USD), datos sintéticos.
 * (a) sin autorización no hay llamada ni registro; (b) la propuesta solo trae campos permitidos; (c) crear con la propuesta
 * no cambia permisos y guarda la necesidad; (d) regresión sin IA; (e) un fallo queda registrado a 0 USD.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu204-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { mockAdapter, costUsd } = await import('@portal-ia/ai-adapters');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, workspaceDb } = await import('../src/db/workspace.ts');
const { agentFoldersRepo } = await import('../src/services/agentFolders.ts');
const { agentEvents } = await import('../src/services/agentEvents.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia';

// El Agente de Onboarding redacta por la API simulada (0 USD) y con límite mensual, para no depender de un arnés local.
const onboarding = agentsRepo(S).list().find(a => a.key === 'ws-onboarding');
assert.ok(onboarding, 'el espacio tiene Agente de Onboarding');
agentsRepo(S).updateConfig(onboarding.id, { ...onboarding.config, backend: 'api', provider: 'anthropic', model: 'claude-haiku-4-5', monthlyLimitUsd: 20 } as any);

const app = await buildApp();
after(async () => { await app.close(); });
const OWNER = await (await import('./fixtures/owner.ts')).ownerHeaders();
const inject = async (method: string, u: string, payload?: unknown) => { const r = await app.inject({ method: method as any, url: u, payload: (payload ?? (method === 'POST' ? {} : undefined)) as any, headers: OWNER }); return { status: r.statusCode, body: r.body ? r.json() : null }; };

// Respuesta del simulado para el prompt de redacción; cuenta las llamadas y puede fallar a voluntad.
const NEED = 'Quiero un agente que revise la accesibilidad de las pantallas y proponga correcciones concretas.';
const PROPOSAL = {
  role: 'Revisor de accesibilidad', summary: 'Revisa las pantallas y propone correcciones de accesibilidad.',
  responsibilities: ['Auditar contraste y foco', 'Revisar etiquetas ARIA', 'Proponer correcciones'], deliverables: ['Informe de accesibilidad', 'Lista de correcciones'],
  skills: [{ name: 'Auditoría WCAG', description: 'Revisa una pantalla con WCAG 2.2.', body: '# Auditoría WCAG\n\n1. Revisa el contraste.\n2. Revisa el foco.' }],
  instructions: '# Revisor de accesibilidad\n\nINSTRUCCIONES-PROPUESTAS-HU204: entrega siempre una lista priorizada.',
  // Lo que la IA NO puede proponer: debe descartarse.
  tools: { shell: true, git_write: true }, autonomy: 'within_scope', model: 'claude-opus-4-1', harness: 'codex', capabilities: ['publish_main']
};
let calls = 0; let failNext = false;
const original = mockAdapter.complete.bind(mockAdapter);
(mockAdapter as any).complete = async (k: string, o: any, req: any, s?: AbortSignal) => {
  if (!String(req.system ?? '').startsWith('Eres el Agente de Onboarding de Portal IA. Redactas')) return original(k, o, req, s);
  calls++;
  if (failNext) { failNext = false; throw new Error('Fallo simulado del proveedor'); }
  const r = await original(k, o, req, s);
  return { ...r, text: JSON.stringify(PROPOSAL) };
};
const runs = () => workspaceDb(S).prepare(`SELECT status, cost_usd AS cost FROM execution_history WHERE kind = 'agent_wizard_draft' ORDER BY started_at`).all() as { status: string; cost: number }[];

const BASE = {
  department: 'Ingeniería', scope: 'workspace', projectId: null, harness: 'api', model: 'claude-haiku-4-5', provider: 'anthropic', effort: 'medium',
  tools: ['read_repo'], knowledge: [], capabilities: [], autonomy: 'ask', authorized: true
};
const filesOf = (id: string): Record<string, string> => (agentFoldersRepo(S).adopted(id)?.files ?? {}) as Record<string, string>;
const grantsOf = (id: string) => { const a = agentsRepo(S).get(id)!; const c = a.config as any; return { tools: c.tools, knowledge: c.knowledge, capabilities: c.capabilities ?? null, autonomy: c.autonomy ?? null, backend: c.backend ?? 'api', model: c.model }; };

test('estimar no llama a nada y muestra motor y costo', async () => {
  const r = await inject('GET', `/api/workspaces/${S}/agents/wizard-draft/estimate?need=${encodeURIComponent(NEED)}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.calls, 1); assert.equal(r.body.costKind, 'usd'); assert.ok(r.body.byAgent); assert.equal(r.body.model, 'claude-haiku-4-5');
  assert.equal(calls, 0); assert.equal(runs().length, 0);
});

test('(a) sin authorized:true se rechaza: ninguna llamada ni registro de ejecución', async () => {
  for (const body of [{ need: NEED, maxUsd: 1 }, { need: NEED, maxUsd: 1, authorized: false }, { need: NEED, maxUsd: 1, authorized: 'true' }]) {
    const r = await inject('POST', `/api/workspaces/${S}/agents/wizard-draft`, body);
    assert.ok(r.status === 400 || r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);
  }
  assert.equal(calls, 0, 'el proveedor simulado no se llamó');
  assert.equal(runs().length, 0, 'sin registro agent_wizard_draft');
});

let draft: any;
test('(b) con autorización la propuesta rellena los campos y descarta permisos, herramientas, arnés, modelo y autonomía', async () => {
  const r = await inject('POST', `/api/workspaces/${S}/agents/wizard-draft`, { need: NEED, maxUsd: 1, authorized: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(calls, 1);
  draft = r.body.draft;
  assert.deepEqual(Object.keys(draft).sort(), ['deliverables', 'instructions', 'responsibilities', 'role', 'skills', 'summary']);
  assert.equal(draft.role, 'Revisor de accesibilidad');
  assert.match(draft.summary, /accesibilidad/);
  assert.equal(draft.responsibilities.length, 3); assert.equal(draft.deliverables.length, 2);
  assert.equal(draft.skills[0].slug, 'auditoria-wcag'); assert.match(draft.skills[0].body, /contraste/);
  assert.match(draft.instructions, /INSTRUCCIONES-PROPUESTAS-HU204/);
  for (const k of ['tools', 'autonomy', 'model', 'harness', 'capabilities']) assert.ok(r.body.discarded.includes(k), `descarta ${k}`);
  // El simulado no gasta dinero real, pero la llamada por API se cuenta con el precio de catálogo del modelo (como el resto de servicios).
  const expected = costUsd('anthropic', 'claude-haiku-4-5', r.body.tokensIn, r.body.tokensOut);
  assert.ok(r.body.tokensIn > 0 && r.body.tokensOut > 0, 'registra tokens');
  assert.equal(r.body.costUsd, expected, 'costo calculado con complete() y los tokens devueltos');
  assert.ok(r.body.costUsd > 0 && r.body.costUsd <= 1, 'dentro del tope autorizado');
  const log = runs(); assert.equal(log.length, 1); assert.equal(log[0].status, 'done'); assert.equal(log[0].cost, expected);
});

test('(c) crear con la propuesta y una habilidad añadida: mismos permisos que sin IA, AGENTS.md propuesto y la necesidad guardada', async () => {
  const added = { name: 'Informe para el equipo', description: 'Redacta el informe final.', body: '# Informe\n\nHABILIDAD-AÑADIDA-HU204' };
  const withAi = await inject('POST', `/api/workspaces/${S}/agents/wizard`, {
    ...BASE, name: 'Revisora Accesible', role: draft.role, summary: draft.summary, responsibilities: draft.responsibilities, deliverables: draft.deliverables,
    skills: [...draft.skills, added], instructions: draft.instructions, need: NEED
  });
  assert.equal(withAi.status, 201, JSON.stringify(withAi.body));
  const plain = await inject('POST', `/api/workspaces/${S}/agents/wizard`, { ...BASE, name: 'Revisor Manual', role: 'Revisor manual', summary: 'Sin IA.', responsibilities: ['Revisar'], deliverables: ['Informe'] });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.deepEqual(grantsOf(withAi.body.id), grantsOf(plain.body.id), 'la IA no cambia herramientas, conocimiento, capacidades, autonomía, arnés ni modelo');
  assert.equal(grantsOf(withAi.body.id).backend, 'api');
  const f = filesOf(withAi.body.id);
  assert.match(f['AGENTS.md'] ?? '', /INSTRUCCIONES-PROPUESTAS-HU204/);
  assert.ok(Object.entries(f).some(([p, c]) => p.includes('auditoria-wcag') && /contraste/.test(c)), 'habilidad propuesta en la carpeta');
  assert.ok(Object.values(f).some(c => c.includes('HABILIDAD-AÑADIDA-HU204')), 'habilidad añadida en la carpeta');
  assert.match(f['knowledge/necesidad-original.md'] ?? '', /revise la accesibilidad de las pantallas/);
  assert.match(JSON.stringify(agentEvents(S, withAi.body.id)), /revise la accesibilidad de las pantallas/, 'la necesidad consta en el evento de creación');
  assert.equal(calls, 1, 'crear no llama a ningún modelo');
});

test('(d) regresión: sin necesidad ni instrucciones se mantiene el AGENTS.md por defecto', async () => {
  const r = await inject('POST', `/api/workspaces/${S}/agents/wizard`, { ...BASE, name: 'Agente Clásico', role: 'Analista clásico', summary: 'Flujo sin IA.', responsibilities: ['Analizar'], deliverables: ['Nota'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const f = filesOf(r.body.id);
  assert.ok((f['AGENTS.md'] ?? '').length > 0, 'hay AGENTS.md por defecto');
  assert.doesNotMatch(f['AGENTS.md'] ?? '', /INSTRUCCIONES-PROPUESTAS-HU204/);
  assert.equal(f['knowledge/necesidad-original.md'], undefined);
  assert.equal(calls, 1);
});

test('(e) un fallo del proveedor queda registrado a 0 USD y la creación sin IA sigue funcionando', async () => {
  failNext = true;
  const r = await inject('POST', `/api/workspaces/${S}/agents/wizard-draft`, { need: NEED, maxUsd: 1, authorized: true });
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.equal(calls, 2);
  const last = runs().at(-1)!; assert.equal(last.status, 'failed'); assert.equal(last.cost, 0);
  const c = await inject('POST', `/api/workspaces/${S}/agents/wizard`, { ...BASE, name: 'Tras El Fallo', role: 'Revisor tras fallo', summary: 'Sin IA.', responsibilities: ['Revisar'], deliverables: ['Informe'], need: NEED });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.match(filesOf(c.body.id)['knowledge/necesidad-original.md'] ?? '', /accesibilidad/);
});
