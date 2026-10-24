import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecutionResult, Process } from '@portal-ia/domain';

// Datos de prueba aislados en una carpeta temporal.
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-inbox-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { projectsRepo, processesRepo } = await import('../src/db/workspace.ts');
const { createAssessment } = await import('../src/services/assessment.ts');
const { createCompany } = await import('../src/services/companies.ts');
const { decisionsFromProcess, authorizationBudget } = await import('../src/services/inbox.ts');
const { buildApp } = await import('../src/app.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
const boot = runBootstrap();
const slug = boot.workspace.slug;
const project = projectsRepo(slug).list()[0];

function proc(over: Partial<Process> = {}): Process {
  return {
    id: 'p1', projectId: 'pr1', kind: 'story_execution', title: 'HU-009: Bandeja', status: 'done',
    budgetUsd: 0, estimatedUsd: 0.4, spentUsd: 0, inputTokens: 0, outputTokens: 0,
    createdAt: '2025-01-01T00:00:00.000Z', authorizedAt: null, startedAt: null, finishedAt: '2025-01-01T00:10:00.000Z',
    error: null, steps: [], result: null, delegation: null, backlogItemId: null, ...over
  };
}
function result(over: Partial<ExecutionResult> = {}): ExecutionResult {
  return { plan: null, implementationSummary: null, changes: [], verifyCommands: [], review: null, applied: null, verifications: [], ...over };
}
const applied = { branch: 'portal-ia/hu-009', commit: 'abc1234', files: ['a.ts', 'b.ts'], appliedAt: '2025-01-01T00:20:00.000Z' };

test('autorizar proceso: costo estimado, presupuesto con margen y respeto del presupuesto ya fijado', () => {
  const pending = proc({ status: 'pending_authorization', finishedAt: null });
  assert.equal(authorizationBudget(pending), 0.6);
  assert.equal(authorizationBudget({ ...pending, budgetUsd: 2 }), 2);
  const [d] = decisionsFromProcess('x', pending);
  assert.equal(d.kind, 'process_authorization');
  assert.equal(d.id, 'process_authorization:p1');
  assert.equal(d.estimatedCost?.usd, 0.4);
  assert.equal(d.estimatedCost?.budgetUsd, 0.6);
  assert.ok(d.denyEffect);
});

test('aplicar diff: impacto en archivos y líneas; rechazado o aplicado ya no aparece como diff', () => {
  const changes = [{ path: 'a.ts', action: 'modify' as const, content: 'x', diff: '--- a\n+++ b\n-old\n+new\n+more', before: 1, after: 2 }];
  const [d] = decisionsFromProcess('x', proc({ result: result({ changes }) }));
  assert.equal(d.kind, 'apply_diff');
  assert.equal(d.estimatedCost, null);
  assert.match(d.impact, /1 archivo/);
  assert.match(d.impact, /\+2 −1/);
  assert.ok(d.denyEffect);
  assert.deepEqual(decisionsFromProcess('x', proc({ result: result({ changes, rejected: { at: 'x', reason: 'no' } }) })), []);
  assert.equal(decisionsFromProcess('x', proc({ result: result({ changes, applied }) }))[0].kind, 'integrate');
  assert.deepEqual(decisionsFromProcess('x', proc({ result: result({ changes: [{ ...changes[0], error: 'ruta protegida' }] }) })), []);
});

test('integrar y publicar: solo se pueden aprobar y cada uno aparece en su momento', () => {
  const [i] = decisionsFromProcess('x', proc({ result: result({ applied }) }));
  assert.equal(i.kind, 'integrate');
  assert.match(i.impact, /portal-ia\/hu-009/);
  assert.equal(i.denyEffect, null);
  const merged = { into: 'main', commit: 'def5678', mergedAt: '2025-01-01T00:30:00.000Z' };
  const [pub] = decisionsFromProcess('x', proc({ result: result({ applied, merged }) }));
  assert.equal(pub.kind, 'publish');
  assert.equal(pub.denyEffect, null);
  const published = { remote: 'origin', url: null, branches: ['main'], pushedAt: '2025-01-01T00:40:00.000Z' };
  assert.deepEqual(decisionsFromProcess('x', proc({ result: result({ applied, merged, published }) })), []);
});

test('propuesta al backlog: resumen de operaciones y desaparece una vez aplicada', () => {
  const delegation = {
    request: 'r', leadAgentId: 'a1', leadAgentName: 'Coordinador del Proyecto', triage: null, consulted: [], deliverable: null, knowledgeDocId: null,
    backlogOps: [{ op: 'add' as const, title: 'X' }, { op: 'discard' as const, story: 'HU-001', reason: 'ya resuelta' }], opsApplied: null
  };
  const [d] = decisionsFromProcess('x', proc({ kind: 'delegated_task', delegation }));
  assert.equal(d.kind, 'backlog_proposal');
  assert.equal(d.requestedBy, 'Coordinador del Proyecto');
  assert.match(d.impact, /2 cambios/);
  assert.deepEqual(decisionsFromProcess('x', proc({ kind: 'delegated_task', delegation: { ...delegation, opsApplied: { at: 'x', summary: [] } } })), []);
});

test('API: bandeja vacía, 404 y validaciones', async () => {
  const app = await buildApp();
  const empty = await app.inject({ method: 'GET', url: `/api/workspaces/${slug}/inbox` });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json(), []);
  assert.equal((await app.inject({ method: 'GET', url: '/api/workspaces/no-existe/inbox' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `/api/workspaces/${slug}/inbox/no_valido/x/decision`, payload: { verdict: 'approve' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `/api/workspaces/${slug}/inbox/process_authorization/x/decision`, payload: { verdict: 'tal vez' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `/api/workspaces/${slug}/inbox/process_authorization/no-existe/decision`, payload: { verdict: 'deny' } })).statusCode, 404);
  await app.close();
});

test('API: denegar desde la bandeja equivale a cancelar en el proceso; segunda decisión devuelve 409 y no hay fugas entre empresas', async () => {
  const app = await buildApp();
  const first = createAssessment(slug, project.id);
  assert.equal(first.status, 'pending_authorization');

  // (a) aparece con costo e impacto
  const listed = (await app.inject({ method: 'GET', url: `/api/workspaces/${slug}/inbox` })).json() as Array<{ id: string; kind: string; processId: string; estimatedCost: { usd: number } | null; impact: string }>;
  const entry = listed.find(d => d.processId === first.id);
  assert.ok(entry, 'la autorización pendiente aparece en la bandeja');
  assert.equal(entry!.kind, 'process_authorization');
  assert.ok((entry!.estimatedCost?.usd ?? 0) > 0);
  assert.ok(entry!.impact.length > 0);

  // Solo se listan decisiones del espacio indicado
  const other = createCompany('Empresa Aparte');
  const otherList = await app.inject({ method: 'GET', url: `/api/workspaces/${other.slug}/inbox` });
  assert.equal(otherList.statusCode, 200);
  assert.deepEqual(otherList.json(), []);

  // Una decisión de otro tipo sobre el mismo proceso no procede: 409 y sin efectos
  const wrongKind = await app.inject({ method: 'POST', url: `/api/workspaces/${slug}/inbox/integrate/${first.id}/decision`, payload: { verdict: 'approve' } });
  assert.equal(wrongKind.statusCode, 409);
  assert.equal(processesRepo(slug).get(first.id)!.status, 'pending_authorization');

  // (c) denegar desde la bandeja
  const viaInbox = await app.inject({ method: 'POST', url: `/api/workspaces/${slug}/inbox/process_authorization/${first.id}/decision`, payload: { verdict: 'deny' } });
  assert.equal(viaInbox.statusCode, 200);
  assert.equal(viaInbox.json().processStatus, 'cancelled');
  const afterInbox = processesRepo(slug).get(first.id)!;

  // Mismo efecto cancelando por la ruta del proceso sobre un proceso equivalente
  const second = createAssessment(slug, project.id);
  assert.notEqual(second.id, first.id);
  const direct = await app.inject({ method: 'POST', url: `/api/workspaces/${slug}/processes/${second.id}/cancel` });
  assert.equal(direct.statusCode, 200);
  const afterDirect = processesRepo(slug).get(second.id)!;
  assert.equal(afterInbox.status, afterDirect.status);
  assert.equal(afterInbox.spentUsd, afterDirect.spentUsd);
  assert.equal(afterInbox.authorizedAt, afterDirect.authorizedAt);

  // (d) segunda decisión sobre el mismo elemento: 409 y el estado no cambia
  const again = await app.inject({ method: 'POST', url: `/api/workspaces/${slug}/inbox/process_authorization/${first.id}/decision`, payload: { verdict: 'approve' } });
  assert.equal(again.statusCode, 409);
  assert.equal(processesRepo(slug).get(first.id)!.status, 'cancelled');

  // La bandeja vuelve a quedar vacía
  assert.deepEqual((await app.inject({ method: 'GET', url: `/api/workspaces/${slug}/inbox` })).json(), []);
  await app.close();
});
