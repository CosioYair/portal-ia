import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PendingDecision, Process } from '@portal-ia/domain';

// EN-015 · Prueba unitaria de la función pura withAgentDisplayNames (Decisiones). Sin IA: 0 USD.
// Datos aislados en una carpeta temporal (inbox.ts importa los repositorios, aunque esta función no los usa).
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en015-inbox-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';

const { withAgentDisplayNames, decisionsFromProcess } = await import('../src/services/inbox.ts');

function proc(over: Partial<Process> = {}): Process {
  return {
    id: 'p1', projectId: 'pr1', kind: 'delegated_task', title: 'Encargo', status: 'pending_authorization',
    budgetUsd: 0, estimatedUsd: 0.4, spentUsd: 0, inputTokens: 0, outputTokens: 0,
    createdAt: '2025-01-01T00:00:00.000Z', authorizedAt: null, startedAt: null, finishedAt: null,
    error: null, steps: [], result: null, delegation: null, backlogItemId: null, ...over
  };
}

// Proceso con delegación: el agente que pide es delegation.leadAgentId.
const delegated = proc({
  id: 'p-deleg',
  delegation: {
    request: 'r', leadAgentId: 'a1', leadAgentName: 'Coordinador del Proyecto', triage: null, consulted: [], deliverable: null,
    knowledgeDocId: null, backlogOps: [], opsApplied: null
  } as unknown as Process['delegation']
});
// Proceso sin delegación: el agente que pide es steps[0].agentId.
const stepped = proc({
  id: 'p-step', kind: 'story_execution', title: 'HU-001: Pantalla',
  steps: [{ agentId: 'a2', agentName: 'Diseñador UX/UI' }] as unknown as Process['steps']
});
// Proceso sin agente identificable.
const orphan = proc({ id: 'p-none', title: 'Sin agente' });

const decisionsOf = (...ps: Process[]): PendingDecision[] => ps.flatMap(p => decisionsFromProcess('x', p));
const displayOf = (d: PendingDecision): string | undefined => (d as { agentDisplayName?: string }).agentDisplayName;

test('EN-015 · withAgentDisplayNames: con nombre propio añade «Nombre · Puesto» (delegation.leadAgentId y steps[0].agentId)', () => {
  const decisions = decisionsOf(delegated, stepped);
  assert.equal(decisions.length, 2);
  const snapshot = structuredClone(decisions);
  const agents = [
    { id: 'a1', config: { name: 'Coordinador del Proyecto', personalName: 'Mateo' } },
    { id: 'a2', config: { name: 'Diseñador UX/UI', personalName: 'Lucía' } }
  ];
  const out = withAgentDisplayNames(decisions, [delegated, stepped], agents);
  assert.equal(out.length, 2);
  const byProcess = new Map(out.map(d => [d.processId, d] as const));
  assert.equal(displayOf(byProcess.get('p-deleg')!), 'Mateo · Coordinador del Proyecto');
  assert.equal(displayOf(byProcess.get('p-step')!), 'Lucía · Diseñador UX/UI');
  // El resto de la decisión no cambia: solo se añade agentDisplayName.
  for (const d of out) {
    const original = decisions.find(o => o.id === d.id)!;
    const { agentDisplayName: _added, ...rest } = d as PendingDecision & { agentDisplayName?: string };
    assert.deepEqual(rest, original);
    assert.equal(d.requestedBy, original.requestedBy);
  }
  // Es pura: no muta las decisiones recibidas.
  assert.deepEqual(decisions, snapshot);
  for (const d of decisions) assert.equal('agentDisplayName' in d, false);
});

test('EN-015 · withAgentDisplayNames: sin nombre propio la decisión queda idéntica (deepEqual)', () => {
  const decisions = decisionsOf(delegated, stepped, orphan);
  assert.equal(decisions.length, 3);
  const withoutNames = [
    { id: 'a1', config: { name: 'Coordinador del Proyecto' } },
    { id: 'a2', config: { name: 'Diseñador UX/UI', personalName: null } }
  ];
  const out = withAgentDisplayNames(decisions, [delegated, stepped, orphan], withoutNames);
  assert.deepEqual(out, decisions);
  for (const d of out) assert.equal('agentDisplayName' in d, false);

  // Un nombre en blanco cuenta como «sin nombre»: tampoco añade nada.
  const blank = withAgentDisplayNames(decisions, [delegated, stepped, orphan], [{ id: 'a1', config: { name: 'Coordinador del Proyecto', personalName: '   ' } }]);
  assert.deepEqual(blank, decisions);

  // Agente desconocido o lista vacía: idéntica.
  assert.deepEqual(withAgentDisplayNames(decisions, [delegated, stepped, orphan], []), decisions);
  // Proceso desconocido para la decisión: idéntica.
  assert.deepEqual(withAgentDisplayNames(decisions, [], [{ id: 'a1', config: { name: 'Coordinador del Proyecto', personalName: 'Mateo' } }]), decisions);
});

test('EN-015 · withAgentDisplayNames: solo cambia la decisión del agente con nombre; las demás quedan iguales', () => {
  const decisions = decisionsOf(delegated, stepped, orphan);
  const agents = [
    { id: 'a1', config: { name: 'Coordinador del Proyecto' } },
    { id: 'a2', config: { name: 'Diseñador UX/UI', personalName: 'Lucía' } }
  ];
  const out = withAgentDisplayNames(decisions, [delegated, stepped, orphan], agents);
  const byProcess = new Map(out.map(d => [d.processId, d] as const));
  const original = new Map(decisions.map(d => [d.processId, d] as const));
  assert.equal(displayOf(byProcess.get('p-step')!), 'Lucía · Diseñador UX/UI');
  assert.deepEqual(byProcess.get('p-deleg'), original.get('p-deleg'));
  assert.deepEqual(byProcess.get('p-none'), original.get('p-none'));
});
