import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * EN-014 · La migración del ámbito corre en la secuencia de arranque y toma el nombre de la empresa del registro del
 * espacio (sin escribirlo a mano). Proveedor simulado, datos temporales, 0 USD.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en014-arranque-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';

const D: any = await import('@portal-ia/domain');
const { encryptSecret } = await import('../src/security/crypto.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { workspacesRepo, providersRepo } = await import('../src/db/platform.ts');
const { agentsRepo, workspaceDb } = await import('../src/db/workspace.ts');
const F: any = await import('../src/services/agentFolders.ts');
const { runContextScopeMigration } = await import('../src/services/contextScopeStartup.ts');

// runBootstrap exige un proveedor conectado (si no, lanza 409 en el nivel superior): proveedor simulado, sin llamadas ni costo.
providersRepo.setCredential('anthropic', encryptSecret('sk-' + 'ant-test'), 'sk-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5'].map(id => D.classifyModel('anthropic', id)));
runBootstrap();
after(() => { try { fs.rmSync(process.env.PORTAL_DATA_DIR!, { recursive: true, force: true }); } catch { /* temporal */ } });

test('arranque: migra a Empresa (nombre registrado) + General, sin nombre escrito a mano, e idempotente', async () => {
  const ws = workspacesRepo.list()[0]!; assert.ok(ws, 'hay un espacio de partida');
  const S = ws.slug; const db = workspaceDb(S) as any;
  assert.equal(F.companyNameOf(S), ws.name, 'el nombre de la empresa sale del registro del espacio');
  db.prepare('UPDATE agents SET context_scope_json = NULL').run();
  const first = await runContextScopeMigration();
  assert.equal(first.failed, 0);
  // La ruta de carpetas (sin companyName explícito) tampoco usa un nombre genérico.
  await F.ensureAgentFolders(S);
  const second = await runContextScopeMigration();
  assert.equal(second.migrated, 0, 'la segunda pasada no migra nada');
  const ids = (db.prepare('SELECT id FROM agents').all() as any[]).map(r => r.id as string);
  assert.ok(ids.length > 0);
  for (const id of ids) {
    assert.deepEqual(agentsRepo(S).get(id)!.contextScope, { project: null, company: true, general: true }, `${id}: Empresa + General`);
    const notes = (db.prepare('SELECT note, source FROM agent_revisions WHERE agent_id = ?').all(id) as any[]).filter(r => String(r.note).startsWith('Ámbito inicial'));
    assert.ok(notes.length <= 1, `${id}: como mucho una revisión de la migración`);
    for (const n of notes) {
      assert.equal(n.source, 'portal');
      assert.ok(String(n.note).includes(`Empresa (${ws.name})`), `${id}: la nota nombra la empresa registrada`);
      assert.ok(!String(n.note).includes('la empresa)'), `${id}: sin nombre genérico`);
    }
  }
});
