import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * HU-189 · Decisiones y la campana se actualizan en vivo con el backlog y el Asistente.
 * Cableado (lectura del código fuente): filtro compartido attentionChange en lib/live.ts, usado por InboxScreen y
 * AttentionWatcher con una espera de como mucho 2 s. Servidor: los avisos 'assistant' (propuestas) y 'backlog' llevan la
 * empresa. Proveedor simulado (0 USD) y datos temporales.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-hu189-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';

const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');

test('live.ts exporta attentionChange con backlog y la rama del Asistente sin empresa', () => {
  const live = read('lib/live.ts');
  assert.match(live, /export function attentionChange\(slug: string \| null\): \(c: LiveChange\) => boolean/);
  const set = live.slice(live.indexOf('const ATTENTION_ENTITIES'), live.indexOf('export function attentionChange'));
  for (const e of ['process', 'assignment', 'batch', 'agent', 'agent_chat', 'backlog', 'assistant']) assert.ok(set.includes(`'${e}'`), `falta la entidad «${e}» en el filtro`);
  const fn = live.slice(live.indexOf('export function attentionChange'), live.indexOf('export function useLatest'));
  assert.ok(fn.includes("c.kind === 'progress'") && fn.includes('return false'), 'los avisos de progreso no cuentan');
  assert.ok(fn.includes('c.ws === slug'), 'avisos de la propia empresa');
  assert.match(fn, /c\.entity === 'assistant' && c\.ws === null/, 'los avisos del Asistente sin empresa también cuentan');
});

test('InboxScreen y AttentionWatcher usan el filtro compartido con minMs ≤ 2000', () => {
  for (const rel of ['screens/InboxScreen.tsx', 'components/AttentionWatcher.tsx']) {
    const src = read(rel);
    assert.match(src, /import \{[^}]*\battentionChange\b[^}]*\} from '\.\.\/lib\/live\.ts'/, `${rel} importa attentionChange`);
    const m = src.match(/useLive\(attentionChange\(slug\),[^;]*?\{ minMs: (\d+)/);
    assert.ok(m, `${rel} se suscribe con useLive(attentionChange(slug), …)`);
    assert.ok(Number(m![1]) <= 2000, `${rel}: minMs ${m![1]} supera 2000 ms`);
    assert.ok(!/useLive\(c =>/.test(src), `${rel} no debe conservar un filtro propio`);
  }
});

test('AttentionWatcher publica la cifra de acciones del chat con setAssistantPending (sin depender del chat montado)', () => {
  const src = read('components/AttentionWatcher.tsx');
  assert.match(src, /import \{[^}]*\bsetAssistantPending\b[^}]*\} from '\.\.\/lib\/uiBus\.ts'/, 'importa setAssistantPending');
  const load = src.slice(src.indexOf('const load = useCallback'), src.indexOf('useEffect(() => { load(); }'));
  assert.ok(load.length > 0, 'existe la función load');
  assert.match(load, /api\.assistantPendingCount\(\)\.then\(r => setAssistantPending\(r\.count\)\)/, 'load pide la cifra y la publica');
  assert.match(src, /useLive\(attentionChange\(slug\), load,/, 'cada aviso en vivo vuelve a ejecutar load (y con ello la cifra del Asistente)');
  assert.match(read('lib/api.ts'), /assistantPendingCount: \(\) => request<\{ count: number \}>\('\/api\/assistant\/pending-count'\)/, 'api.ts llama a la ruta global');
});

test('el servidor emite assistant y backlog con la empresa', async () => {
  const { encryptSecret } = await import('../src/security/crypto.ts');
  const { classifyModel } = await import('@portal-ia/domain');
  const { providersRepo } = await import('../src/db/platform.ts');
  const { runBootstrap } = await import('../src/routes/bootstrap.ts');
  const { projectsRepo, backlogRepo } = await import('../src/db/workspace.ts');
  const { conversationsRepo } = await import('../src/db/conversations.ts');
  const { proposeDecisions } = await import('../src/services/conversations.ts');
  const { addManualItem } = await import('../src/services/backlog.ts');
  const { subscribeLive, flushLiveNow } = await import('../src/services/live.ts');
  providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
  providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
  const S = runBootstrap().workspace.slug;
  const project = projectsRepo(S).list()[0];
  const item = addManualItem(S, project.id, { title: 'Historia HU-189', criterion: 'el aviso llega' });
  flushLiveNow();

  const seen: { ws: string | null; entity: string }[] = [];
  const off = subscribeLive(m => { for (const c of m.changes) seen.push({ ws: c.ws, entity: c.entity }); });
  try {
    const conv = conversationsRepo.create('Prueba HU-189', S, project.id);
    const [d] = proposeDecisions(conv.id, null, [{ question: '¿Seguimos?', options: [{ label: 'Sí', pros: 'Rápido', cons: 'Ninguno' }], recommendation: 'Sí', risks: [] }]);
    assert.ok(d, 'se crea la propuesta');
    backlogRepo(S).setPosition(item.id, 0);
    flushLiveNow();
  } finally { off(); }
  assert.ok(seen.some(c => c.ws === S && c.entity === 'assistant'), 'la propuesta del Asistente avisa con la empresa');
  assert.ok(seen.some(c => c.ws === S && c.entity === 'backlog'), 'el cambio del backlog avisa con la empresa');
});

test('una acción del chat pendiente (propose_*) cuenta en /api/assistant/pending-count y avisa «assistant»', async () => {
  const { buildApp } = await import('../src/app.ts');
  const { stopBatchScheduler } = await import('../src/services/batchRunner.ts');
  const { workspacesRepo } = await import('../src/db/platform.ts');
  const { projectsRepo } = await import('../src/db/workspace.ts');
  const { conversationsRepo } = await import('../src/db/conversations.ts');
  const { assistantRepo } = await import('../src/services/assistant.ts');
  const { subscribeLive, flushLiveNow } = await import('../src/services/live.ts');
  const { attentionChange } = await import('../../web/src/lib/live.ts');
  const S = workspacesRepo.list()[0].slug;
  const project = projectsRepo(S).list()[0];
  const app = await buildApp();
  try {
    const conv = conversationsRepo.create('Chat HU-189', S, project.id);
    const before = (await app.inject({ method: 'GET', url: '/api/assistant/pending-count' })).json() as { count: number };
    assert.equal(typeof before.count, 'number');
    flushLiveNow();

    const seen: { ws: string | null; entity: string; kind?: string }[] = [];
    const off = subscribeLive(m => { for (const c of m.changes) seen.push({ ws: c.ws, entity: c.entity, kind: c.kind }); });
    try {
      assistantRepo.add({ role: 'assistant', content: 'Propongo ejecutar la historia.', actions: [{ type: 'propose_execution', status: 'pending', label: 'Ejecutar', processId: null, workspaceSlug: S, projectId: project.id }], attachments: [], tokensIn: 0, tokensOut: 0, costUsd: 0, model: null } as any, conv.id);
      flushLiveNow();
    } finally { off(); }

    // El aviso llega sin empresa, y el filtro compartido de Decisiones y la campana lo acepta.
    const a = seen.find(c => c.entity === 'assistant');
    assert.ok(a, 'la acción del chat emite un aviso «assistant»');
    assert.ok(attentionChange(S)(a as any), 'attentionChange acepta el aviso del Asistente (con o sin empresa)');

    const one = (await app.inject({ method: 'GET', url: `/api/assistant/pending-count?conversationId=${encodeURIComponent(conv.id)}` })).json() as { count: number };
    assert.equal(one.count, 1, 'la conversación tiene una acción pendiente');
    const after = (await app.inject({ method: 'GET', url: '/api/assistant/pending-count' })).json() as { count: number };
    assert.equal(after.count - before.count, 1, 'el contador global (sin chat montado) sube en uno');
  } finally { stopBatchScheduler(); await app.close(); }
});
