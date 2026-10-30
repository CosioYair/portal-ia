import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * HU-159 · Paso «Contexto y dirección» con proveedor simulado (0 USD reales). Preparación idéntica a org-evaluation.test.ts:
 * todo en el nivel superior; el proveedor simulado se conecta antes de runBootstrap.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-orgbrief-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_SANDBOX = 'none';
process.env.PORTAL_MOCK_PROVIDER = '1';
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json');
const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel, ORG_BRIEF_SKIPPED_TEXT } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { knowledgeRepo, projectsRepo, workspaceDb } = await import('../src/db/workspace.ts');
const { orgEvaluationsRepo } = await import('../src/db/orgEvaluationSchema.ts');
const { createCompany, createProject } = await import('../src/services/companies.ts');
const { buildApp } = await import('../src/app.ts');
const { resetMockCalls } = await import('@portal-ia/ai-adapters');
const adapters = await import('@portal-ia/ai-adapters');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const internal = projectsRepo('portal-ia').list()[0];

// Marcadores únicos por ejecución: no pueden coincidir con nada del repositorio.
const tag = Math.random().toString(36).slice(2, 8).toUpperCase();
const M = { dir: `DIR-${tag}`, ctx: `CTX-${tag}`, file: `FILE-${tag}`, imgNote: `IMGNOTA-${tag}`, imgBytes: `IMGBYTES-${tag}` };
const NO_REPO = 'sin repositorio vinculado';
const proposals = JSON.stringify([{ action: 'add', target: 'agent', subject: 'Analista de producto', rationale: 'La dirección del propietario pide foco en producto.', details: 'Reporta a pj-coordinador' }]);
fs.writeFileSync(scriptPath, JSON.stringify({ markers: [M.dir, M.ctx, M.file, M.imgNote, M.imgBytes, NO_REPO, ORG_BRIEF_SKIPPED_TEXT], rules: [
  { match: 'Entrega en markdown', text: `## Resumen\nOrganización revisada según la dirección.\n\n\`\`\`org\n${proposals}\n\`\`\`\n` },
  { match: 'Tu análisis lo usará el Gestor', text: 'Análisis: el backlog es técnico.' }
] }));
fs.writeFileSync(logPath, '');

const COORD = 'Tu análisis lo usará el Gestor'; const GESTOR = 'Entrega en markdown';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const countProcesses = (slug: string) => (workspaceDb(slug).prepare(`SELECT COUNT(*) AS n FROM processes`).get() as any).n as number;
const readLog = () => fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const markersOf = (rule: string) => readLog().find(l => l.rule === rule)?.markers as string[] | undefined;
const url = (slug: string) => `/api/workspaces/${slug}/org-evaluations`;
async function waitFinished(app: any, slug: string, id: string): Promise<any> {
  for (let i = 0; i < 600; i++) {
    const ev = (await app.inject({ method: 'GET', url: `${url(slug)}/${id}` })).json();
    if (['done', 'failed', 'cancelled'].includes(ev.status)) return ev;
    await sleep(25);
  }
  throw new Error('La evaluación no terminó a tiempo');
}
/** Envía payloads que deben fallar con el estado indicado sin crear proceso ni evaluación ni llamar a la IA. */
async function expectRejected(app: any, payloads: any[], status: number, code: string) {
  resetMockCalls();
  const before = countProcesses('portal-ia'); const evBefore = orgEvaluationsRepo('portal-ia').list().length;
  for (const payload of payloads) {
    const r = await app.inject({ method: 'POST', url: url('portal-ia'), payload });
    assert.equal(r.statusCode, status, `${JSON.stringify(payload).slice(0, 120)} → ${r.body.slice(0, 200)}`);
    assert.equal(r.json().code, code);
  }
  assert.equal(countProcesses('portal-ia'), before, 'no se crea ningún proceso');
  assert.equal(orgEvaluationsRepo('portal-ia').list().length, evBefore, 'no se crea ninguna evaluación');
  assert.equal(adapters.mockCalls, 0, 'no se llama a la IA');
}
const base = () => ({ projectId: internal.id, budgetUsd: 5, authorized: true });

test('a · autorizado pero sin brief (o con un brief que no es un objeto) → 400 brief_required, sin procesos ni IA', async () => {
  const app = await buildApp();
  await expectRejected(app, [base(), { ...base(), brief: null }, { ...base(), brief: 'hola' }, { ...base(), brief: [] }], 400, 'brief_required');
  const r = await app.inject({ method: 'POST', url: url('portal-ia'), payload: base() });
  assert.match(r.json().error, /Contexto y dirección/);
  // La autorización se comprueba antes: sin ella sigue siendo 403 aunque falte el brief.
  await expectRejected(app, [{ projectId: internal.id, budgetUsd: 5 }], 403, 'authorization_required');
  await app.close();
});

test('b · brief vacío sin «Evaluar sin indicaciones» → 400 brief_required', async () => {
  const app = await buildApp();
  await expectRejected(app, [
    { ...base(), brief: {} },
    { ...base(), brief: { direction: '   ', initialContext: '', attachments: [], skipped: false } }
  ], 400, 'brief_required');
  await app.close();
});

test('c · dirección, contexto, archivo de texto e imagen: la estimación crece y el brief llega al Coordinador, al Gestor, al documento y a GET', async () => {
  const app = await buildApp(); resetMockCalls(); fs.writeFileSync(logPath, '');
  const plain = (await app.inject({ method: 'GET', url: `${url('portal-ia')}/estimate?projectId=${internal.id}` })).json();
  const withBrief = (await app.inject({ method: 'GET', url: `${url('portal-ia')}/estimate?projectId=${internal.id}&briefChars=5000` })).json();
  assert.ok(withBrief.contextChars > plain.contextChars && withBrief.estimatedUsd > plain.estimatedUsd, 'la estimación incluye el contexto aportado');
  assert.equal(adapters.mockCalls, 0, 'estimar no llama a la IA');
  const brief = { direction: `Quiero foco en producto ${M.dir}`, initialContext: `Empresa con clientes B2B ${M.ctx}`, skipped: false, attachments: [
    { name: 'notas.md', kind: 'text', content: `# Notas\n${M.file}`, note: 'Notas de la reunión' },
    { name: 'organigrama.png', kind: 'image', content: M.imgBytes, note: `Organigrama actual ${M.imgNote}` }
  ] };
  const r = await app.inject({ method: 'POST', url: url('portal-ia'), payload: { ...base(), brief } });
  assert.equal(r.statusCode, 202, r.body);
  const ev = await waitFinished(app, 'portal-ia', r.json().id);
  assert.equal(ev.status, 'done', ev.error ?? '');
  assert.equal(adapters.mockCalls, 2);
  for (const rule of [COORD, GESTOR]) {
    const mk = markersOf(rule); assert.ok(mk, `hay llamada para «${rule}»`);
    for (const m of [M.dir, M.ctx, M.file, M.imgNote]) assert.ok(mk!.includes(m), `${m} llega a «${rule}»`);
    assert.ok(!mk!.includes(M.imgBytes), 'el contenido de la imagen nunca se envía');
  }
  const doc = knowledgeRepo('portal-ia').get(ev.knowledgeDocId)!;
  assert.match(doc.body, /# Contexto y dirección/);
  for (const m of [M.dir, M.ctx, M.file, M.imgNote]) assert.ok(doc.body.includes(m), `${m} en el documento`);
  assert.ok(!doc.body.includes(M.imgBytes)); assert.match(doc.body, /Analista de producto/);
  assert.ok(ev.brief.direction.includes(M.dir)); assert.equal(ev.brief.skipped, false); assert.equal(ev.brief.attachments.length, 2);
  const img = ev.brief.attachments.find((a: any) => a.kind === 'image');
  assert.equal(img.content, undefined, 'de la imagen solo se guardan el nombre y la descripción'); assert.ok(img.note.includes(M.imgNote));
  assert.ok(ev.proposals.every((p: any) => p.decision === 'pending'), 'nada se decide sin el propietario');
  await app.close();
});

test('d · «Evaluar sin indicaciones» funciona y queda registrado en el historial', async () => {
  const app = await buildApp(); resetMockCalls(); fs.writeFileSync(logPath, '');
  const r = await app.inject({ method: 'POST', url: url('portal-ia'), payload: { ...base(), brief: { skipped: true } } });
  assert.equal(r.statusCode, 202, r.body);
  const ev = await waitFinished(app, 'portal-ia', r.json().id);
  assert.equal(ev.status, 'done', ev.error ?? '');
  assert.ok(markersOf(COORD)!.includes(ORG_BRIEF_SKIPPED_TEXT)); assert.ok(markersOf(GESTOR)!.includes(ORG_BRIEF_SKIPPED_TEXT));
  assert.ok(knowledgeRepo('portal-ia').get(ev.knowledgeDocId)!.body.includes(ORG_BRIEF_SKIPPED_TEXT));
  const hist = (await app.inject({ method: 'GET', url: `${url('portal-ia')}?projectId=${internal.id}` })).json();
  assert.equal(hist[0].id, ev.id); assert.equal(hist[0].brief.skipped, true);
  assert.ok(hist.some((e: any) => e.brief && e.brief.direction.includes(M.dir)), 'el historial conserva el contexto de cada evaluación');
  await app.close();
});

test('f · límites excedidos → 400 brief_too_large, sin procesos ni IA', async () => {
  const app = await buildApp();
  const txt = (n: number) => ({ name: `f${n}.txt`, kind: 'text', content: 'x'.repeat(15_000) });
  await expectRejected(app, [
    { ...base(), brief: { direction: 'd'.repeat(4001) } },
    { ...base(), brief: { initialContext: 'c'.repeat(8001) } },
    { ...base(), brief: { attachments: Array.from({ length: 9 }, (_, i) => ({ name: `a${i}.txt`, kind: 'text', content: 'a' })) } },
    { ...base(), brief: { attachments: [{ name: 'grande.txt', kind: 'text', content: 'x'.repeat(20_001) }] } },
    { ...base(), brief: { attachments: [txt(1), txt(2), txt(3)] } }
  ], 400, 'brief_too_large');
  await app.close();
});

test('g · empresa nueva sin repositorio: la estimación, los prompts y el documento lo indican', async () => {
  const delta = createCompany('Empresa Delta Brief');
  const pj = createProject(delta.slug, 'App nueva', 'Proyecto recién creado', ['Lanzar la primera versión']);
  const app = await buildApp(); resetMockCalls(); fs.writeFileSync(logPath, '');
  const est = (await app.inject({ method: 'GET', url: `${url(delta.slug)}/estimate?projectId=${pj.id}` })).json();
  assert.deepEqual(est.missingRepository, ['App nueva']);
  const r = await app.inject({ method: 'POST', url: url(delta.slug), payload: { projectId: pj.id, budgetUsd: 5, authorized: true, brief: { initialContext: `Empresa recién creada ${M.ctx}` } } });
  assert.equal(r.statusCode, 202, r.body);
  const ev = await waitFinished(app, delta.slug, r.json().id);
  assert.equal(ev.status, 'done', ev.error ?? '');
  for (const rule of [COORD, GESTOR]) { const mk = markersOf(rule)!; assert.ok(mk.includes(NO_REPO), `«${rule}» sabe que no hay repositorio`); assert.ok(mk.includes(M.ctx)); }
  const body = knowledgeRepo(delta.slug).get(ev.knowledgeDocId)!.body;
  assert.match(body, /Sin repositorio vinculado: «App nueva»/); assert.ok(body.includes(M.ctx));
  await app.close();
});
