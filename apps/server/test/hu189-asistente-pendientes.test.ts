import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assistantPendingCount } from '@portal-ia/domain';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

test('HU-189 · assistantPendingCount cuenta las acciones pendientes y omite las sustituidas', () => {
  const msgs = [
    { actions: [{ status: 'pending' }, { status: 'done' }, { status: 'pending', processId: 'p1' }] },
    { actions: [{ status: 'pending', processId: 'p2' }, { status: 'rejected' }] }
  ];
  assert.equal(assistantPendingCount(msgs), 3);
  assert.equal(assistantPendingCount(msgs, pid => pid === 'p2'), 2);
  assert.equal(assistantPendingCount([]), 0);
});

test('HU-189 · la campana pide la cifra del Asistente sin depender del chat montado', () => {
  const watcher = read('apps/web/src/components/AttentionWatcher.tsx');
  assert.match(watcher, /api\.assistantPendingCount\(\)\.then\(r => setAssistantPending\(r\.count\)\)/);
  assert.match(watcher, /useLive\(attentionChange\(slug\), load, \{ minMs: 1500/);
  const route = read('apps/server/src/routes/assistant.ts');
  assert.match(route, /app\.get\('\/api\/assistant\/pending-count'/);
  assert.match(route, /assistantPendingCount\(assistantRepo\.listLive\(80, id\)\)/);
  const chat = read('apps/web/src/components/AssistantChat.tsx');
  assert.match(chat, /assistantPendingCount\(msgs, pid => !!superseded\[pid\]\)/, 'el chat usa la misma regla');
});
