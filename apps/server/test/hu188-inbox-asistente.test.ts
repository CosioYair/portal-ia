import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * HU-188 · Las propuestas pendientes del Asistente (assistant_decisions) aparecen en Decisiones (/autorizaciones) y en la
 * campana, se aprueban o deniegan desde la bandeja sin llamar a la IA y su aviso en vivo lleva el ws de su espacio.
 * Proveedor simulado (0 USD) y datos temporales.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu188-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const ai = await import('@portal-ia/ai-adapters');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { projectsRepo } = await import('../src/db/workspace.ts');
const { createCompany } = await import('../src/services/companies.ts');
const { conversationsRepo, decisionsRepo } = await import('../src/db/conversations.ts');
const { proposeDecisions } = await import('../src/services/conversations.ts');
const { subscribeLive, flushLiveNow } = await import('../src/services/live.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
const boot = runBootstrap();
const S = boot.workspace.slug; const W = `/api/workspaces/${S}`;
const project = projectsRepo(S).list()[0];
const app = await buildApp();
after(async () => { await app.close(); });
const inject = async (method: string, u: string, payload?: unknown) => { const r = await app.inject({ method: method as any, url: u, payload: payload as any }); return { status: r.statusCode, body: r.body ? r.json() : null }; };
const opts = [{ label: 'Primera opción', pros: 'Simple', cons: 'Limitada' }, { label: 'Segunda opción', pros: 'Flexible', cons: 'Más trabajo' }];
const decideUrl = (id: string) => `${W}/inbox/assistant_decision/${id}/decision`;

test('HU-188 · bandeja, campana, aprobar/denegar sin IA, 409, 404 y aviso en vivo con ws del espacio', async () => {
  ai.resetMockCalls();
  const total0 = (await inject('GET', `${W}/inbox/summary`)).body.total as number;

  // Aviso en vivo: al crear la propuesta, llega con el ws del espacio.
  const seen: { ws: string | null; entity: string }[] = [];
  const off = subscribeLive(m => { for (const c of m.changes) seen.push({ ws: c.ws, entity: c.entity }); });
  const conv = conversationsRepo.create('Prueba HU-188', S, project.id);
  const [dA, dB, dC] = proposeDecisions(conv.id, null, [
    { question: '¿Usamos la opción recomendada?', options: opts, recommendation: 'Opción recomendada', risks: [] },
    { question: '¿Se deniega esta propuesta?', options: opts, recommendation: null, risks: [] },
    { question: '¿Sin recomendación, la primera opción?', options: opts, recommendation: null, risks: [] }
  ]);
  flushLiveNow(); off();
  assert.ok(dA && dB && dC, 'se crean tres propuestas');
  assert.ok(seen.some(c => c.ws === S && c.entity === 'assistant'), 'el aviso lleva el ws del espacio, no null');

  // Las que no son de una conversación activa de este espacio no aparecen en su bandeja.
  const other = createCompany('Empresa Aparte HU-188');
  const otherConv = conversationsRepo.create('Otra empresa', other.slug, null);
  const [dOther] = proposeDecisions(otherConv.id, null, [{ question: '¿Propuesta de la otra empresa?', options: opts, recommendation: 'Sí', risks: [] }]);
  const noWs = conversationsRepo.create('Sin empresa', null, null);
  proposeDecisions(noWs.id, null, [{ question: '¿Propuesta sin empresa?', options: opts, recommendation: 'Sí', risks: [] }]);
  const archived = conversationsRepo.create('Archivada', S, project.id);
  proposeDecisions(archived.id, null, [{ question: '¿Propuesta archivada?', options: opts, recommendation: 'Sí', risks: [] }]);
  conversationsRepo.update(archived.id, { status: 'archived' });

  // a) bandeja y campana
  const inbox = await inject('GET', `${W}/inbox`);
  assert.equal(inbox.status, 200);
  const mine = (inbox.body as any[]).filter(d => d.kind === 'assistant_decision');
  assert.deepEqual(mine.map(d => d.processId).sort(), [dA.id, dB.id, dC.id].sort(), 'solo las tres propuestas de este espacio');
  const a = mine.find(d => d.processId === dA.id);
  assert.equal(a.id, `assistant_decision:${dA.id}`);
  assert.equal(a.title, '¿Usamos la opción recomendada?');
  assert.equal(a.workspaceSlug, S);
  assert.equal(a.estimatedCost, null);
  assert.ok(a.approveEffect && a.denyEffect, 'muestra los efectos de aprobar y denegar');
  const summary = await inject('GET', `${W}/inbox/summary`);
  assert.equal(summary.status, 200);
  assert.equal(summary.body.total, total0 + 3, 'la campana suma 1 por cada propuesta');
  assert.ok(((await inject('GET', `/api/workspaces/${other.slug}/inbox`)).body as any[]).some(d => d.processId === dOther.id), 'la otra empresa ve la suya');

  // b) aprobar con la recomendación
  const ok = await inject('POST', decideUrl(dA.id), { verdict: 'approve' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.kind, 'assistant_decision');
  const afterA = decisionsRepo.get(dA.id)!;
  assert.equal(afterA.status, 'approved');
  assert.equal(afterA.answer, 'Opción recomendada');

  // c) repetir devuelve 409 y no cambia nada
  const again = await inject('POST', decideUrl(dA.id), { verdict: 'deny' });
  assert.equal(again.status, 409);
  assert.equal(decisionsRepo.get(dA.id)!.status, 'approved');

  // d) denegar queda 'rejected'
  const deny = await inject('POST', decideUrl(dB.id), { verdict: 'deny', reason: 'No hace falta' });
  assert.equal(deny.status, 200, JSON.stringify(deny.body));
  assert.equal(decisionsRepo.get(dB.id)!.status, 'rejected');

  // e) sin recomendación se aprueba con la primera opción
  const first = await inject('POST', decideUrl(dC.id), { verdict: 'approve' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(decisionsRepo.get(dC.id)!.answer, 'Primera opción');

  // f) una propuesta de otra empresa: 404 y sigue abierta
  const foreign = await inject('POST', decideUrl(dOther.id), { verdict: 'approve' });
  assert.equal(foreign.status, 404);
  assert.equal(decisionsRepo.get(dOther.id)!.status, 'open');

  // La bandeja y la campana vuelven al punto de partida.
  assert.ok(!((await inject('GET', `${W}/inbox`)).body as any[]).some(d => d.kind === 'assistant_decision'));
  assert.equal((await inject('GET', `${W}/inbox/summary`)).body.total, total0);

  // g) ninguna llamada al proveedor simulado en todo el flujo
  assert.equal(ai.mockCalls, 0, 'aprobar o denegar desde la bandeja no llama a la IA');
});
