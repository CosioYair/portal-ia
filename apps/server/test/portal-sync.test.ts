import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  PUBLICATION_WATCHER_ROLE,
  classifyChangeImpact,
  evaluatePublication,
  extractStoryIds
} from '@portal/domain';
import { PortalSyncStatusSchema, RestartNoticeSchema } from '@portal/contracts';
import { createPortalSyncService } from '../src/services/portal-sync.ts';
import { verifyPublication } from '../src/services/publication-watch.ts';
import type { PublicationActivityEntry } from '../src/services/publication-watch.ts';

const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function commit(work: string, file: string, message: string): Promise<string> {
  const full = join(work, file);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, `${message}\n${Math.random()}\n`);
  g(work, 'add', '.');
  g(work, 'commit', '-m', message);
  return g(work, 'rev-parse', 'HEAD');
}

async function setup(withRemote: boolean) {
  const dir = await mkdtemp(join(tmpdir(), 'hu123-'));
  const bare = join(dir, 'origin.git');
  const work = join(dir, 'work');
  g(dir, 'init', '--bare', bare);
  g(dir, 'init', work);
  g(work, 'config', 'user.name', 'Test');
  g(work, 'config', 'user.email', 'test@example.com');
  g(work, 'config', 'commit.gpgsign', 'false');
  g(work, 'checkout', '-b', 'main');
  await commit(work, 'README.md', 'inicial');
  if (withRemote) {
    g(work, 'remote', 'add', 'origin', bare);
    g(work, 'push', '-u', 'origin', 'main');
  }
  return { work, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function memoryRecorder() {
  const entries: PublicationActivityEntry[] = [];
  return { entries, record: async (entry: PublicationActivityEntry) => void entries.push(entry) };
}

// Dominio puro

test('classifyChangeImpact devuelve la acción más fuerte', () => {
  assert.equal(classifyChangeImpact([]), 'none');
  assert.equal(classifyChangeImpact(['docs/operacion/recarga-o-reinicio.md']), 'none');
  assert.equal(classifyChangeImpact(['apps/web/src/components/X.tsx']), 'reload');
  assert.equal(classifyChangeImpact(['apps/server/src/services/a.ts']), 'restart');
  assert.equal(classifyChangeImpact(['packages/domain/src/a.ts']), 'restart');
  assert.equal(classifyChangeImpact(['package.json']), 'restart');
  assert.equal(classifyChangeImpact(['package-lock.json']), 'restart');
  assert.equal(classifyChangeImpact(['tsconfig.json']), 'restart');
  assert.equal(classifyChangeImpact(['.env.local']), 'restart');
  assert.equal(classifyChangeImpact(['apps/server/test/a.test.ts']), 'none');
  assert.equal(
    classifyChangeImpact(['docs/a.md', 'apps/web/src/a.tsx', 'apps/server/src/b.ts']),
    'restart'
  );
  assert.equal(classifyChangeImpact(['docs/a.md', 'apps/web/src/a.tsx']), 'reload');
});

test('extractStoryIds devuelve las historias únicas y ordenadas', () => {
  assert.deepEqual(
    extractStoryIds(['HU-123: aviso', 'fix de hu-9 y HU-123', 'sin historia', 'HU-0 no vale']),
    ['HU-9', 'HU-123']
  );
  assert.deepEqual(extractStoryIds([]), []);
});

test('evaluatePublication cubre ok, pendiente y divergente', () => {
  const base = { integratedInMain: true, publishedToRemote: true, remoteTracked: true, mainDivergedFromRemote: false };
  assert.equal(evaluatePublication(base).verdict, 'ok');
  assert.equal(evaluatePublication({ ...base, publishedToRemote: false }).verdict, 'pendiente');
  assert.equal(evaluatePublication({ ...base, integratedInMain: false, publishedToRemote: false }).verdict, 'pendiente');
  assert.equal(evaluatePublication({ ...base, integratedInMain: false }).verdict, 'divergente');
  assert.equal(
    evaluatePublication({ ...base, publishedToRemote: false, mainDivergedFromRemote: true }).verdict,
    'divergente'
  );
  assert.equal(PUBLICATION_WATCHER_ROLE.usesModels, false);
  assert.equal(PUBLICATION_WATCHER_ROLE.usesNetwork, false);
});

// Estado de sincronización en repositorio temporal

test('en main publicado: coincide con main y está publicado', async (t) => {
  const s = await setup(true);
  t.after(s.cleanup);
  const service = await createPortalSyncService({ repoPath: s.work, cacheMs: 0 });
  const status = PortalSyncStatusSchema.parse(await service.getSyncStatus());
  assert.equal(status.activeBranch, 'main');
  assert.equal(status.branchMatchesMain, true);
  assert.equal(status.remote.tracked, true);
  assert.equal(status.remote.published, true);
  assert.equal(status.remote.ahead, 0);
});

test('un commit en main sin publicar queda pendiente', async (t) => {
  const s = await setup(true);
  t.after(s.cleanup);
  const service = await createPortalSyncService({ repoPath: s.work, cacheMs: 0 });
  await commit(s.work, 'docs/a.md', 'HU-123: doc');
  const status = await service.getSyncStatus();
  assert.equal(status.remote.published, false);
  assert.equal(status.remote.ahead, 1);
  assert.equal(status.remote.behind, 0);
});

test('en una rama distinta de main informa de commits por delante', async (t) => {
  const s = await setup(true);
  t.after(s.cleanup);
  const service = await createPortalSyncService({ repoPath: s.work, cacheMs: 0 });
  g(s.work, 'checkout', '-b', 'feature/x');
  await commit(s.work, 'docs/b.md', 'trabajo');
  const status = await service.getSyncStatus();
  assert.equal(status.activeBranch, 'feature/x');
  assert.equal(status.branchMatchesMain, false);
  assert.equal(status.aheadOfMain, 1);
  assert.equal(status.behindMain, 0);
  assert.equal(status.remote.published, true);
});

test('sin remoto: tracked es false y no es un error', async (t) => {
  const s = await setup(false);
  t.after(s.cleanup);
  const service = await createPortalSyncService({ repoPath: s.work, cacheMs: 0 });
  const status = await service.getSyncStatus();
  assert.equal(status.remote.tracked, false);
  assert.equal(status.remote.remoteMainSha, null);
  assert.equal(status.remote.published, false);
});

test('HEAD suelto se muestra como estado explícito', async (t) => {
  const s = await setup(true);
  t.after(s.cleanup);
  const service = await createPortalSyncService({ repoPath: s.work, cacheMs: 0 });
  g(s.work, 'checkout', '--detach');
  const status = await service.getSyncStatus();
  assert.equal(status.detached, true);
  assert.equal(status.activeBranch, null);
});

// Aviso de reinicio

test('sin cambios desde el arranque no hay aviso', async (t) => {
  const s = await setup(true);
  t.after(s.cleanup);
  const service = await createPortalSyncService({ repoPath: s.work, cacheMs: 0 });
  const notice = RestartNoticeSchema.parse(await service.getRestartNotice());
  assert.equal(notice.action, 'none');
  assert.deepEqual(notice.affectedStories, []);
});

test('un commit en apps/server exige reiniciar y lista las historias', async (t) => {
  const s = await setup(true);
  t.after(s.cleanup);
  const service = await createPortalSyncService({ repoPath: s.work, cacheMs: 0 });
  await commit(s.work, 'apps/server/src/services/nuevo.ts', 'HU-123: servicio');
  await commit(s.work, 'apps/web/src/components/X.tsx', 'HU-124: pantalla');
  const notice = await service.getRestartNotice();
  assert.equal(notice.action, 'restart');
  assert.deepEqual(notice.affectedStories, ['HU-123', 'HU-124']);
  assert.ok(notice.changedAreas.includes('servidor'));
  assert.notEqual(notice.bootHeadSha, notice.currentHeadSha);
});

test('un commit solo en apps/web propone recargar', async (t) => {
  const s = await setup(true);
  t.after(s.cleanup);
  const service = await createPortalSyncService({ repoPath: s.work, cacheMs: 0 });
  await commit(s.work, 'apps/web/src/components/Y.tsx', 'HU-125: ui');
  const notice = await service.getRestartNotice();
  assert.equal(notice.action, 'reload');
  assert.deepEqual(notice.affectedStories, ['HU-125']);
});

// Vigía de publicación

test('el vigía registra veredicto pendiente antes de publicar y ok después', async (t) => {
  const s = await setup(true);
  t.after(s.cleanup);
  const sha = await commit(s.work, 'docs/c.md', 'HU-123: cambio');
  const recorder = memoryRecorder();

  const antes = await verifyPublication({
    repoPath: s.work, companyId: 'acme', storyId: 'HU-123', commitSha: sha, recorder
  });
  assert.equal(antes.verdict, 'pendiente');
  assert.equal(antes.integratedInMain, true);
  assert.equal(antes.publishedToRemote, false);

  g(s.work, 'push', 'origin', 'main');
  const despues = await verifyPublication({
    repoPath: s.work, companyId: 'acme', storyId: 'HU-123', commitSha: sha, recorder
  });
  assert.equal(despues.verdict, 'ok');
  assert.equal(despues.publishedToRemote, true);

  assert.equal(recorder.entries.length, 2);
  assert.equal(recorder.entries[0]?.actor, 'Vigía de publicación');
  assert.equal(recorder.entries[0]?.verdict, 'pendiente');
  assert.equal(recorder.entries[0]?.status, 'error');
  assert.equal(recorder.entries[1]?.verdict, 'ok');
  assert.equal(recorder.entries[1]?.status, 'ok');
  assert.equal(recorder.entries[1]?.kind, 'publication.verified');
});

test('el vigía registra también cuando la publicación falló y nunca lanza', async (t) => {
  const s = await setup(false);
  t.after(s.cleanup);
  const sha = await commit(s.work, 'docs/d.md', 'HU-123: sin remoto');
  const recorder = memoryRecorder();
  const check = await verifyPublication({
    repoPath: s.work, companyId: 'acme', storyId: 'HU-123', commitSha: sha, operationFailed: true, recorder
  });
  assert.equal(check.verdict, 'pendiente');
  assert.equal(recorder.entries.length, 1);
  assert.equal(recorder.entries[0]?.status, 'error');
  assert.match(recorder.entries[0]?.message ?? '', /falló/);

  const inexistente = await verifyPublication({
    repoPath: join(tmpdir(), 'hu123-no-existe-nunca'), companyId: 'acme', storyId: 'HU-123', commitSha: 'abc1234', recorder
  });
  assert.equal(inexistente.verdict, 'pendiente');
  assert.equal(recorder.entries.length, 2);
});

test('el vigía detecta un commit en la rama de trabajo no integrado en main', async (t) => {
  const s = await setup(true);
  t.after(s.cleanup);
  g(s.work, 'checkout', '-b', 'hu-123/aviso');
  const sha = await commit(s.work, 'docs/e.md', 'HU-123: en rama');
  const recorder = memoryRecorder();
  const check = await verifyPublication({
    repoPath: s.work, companyId: 'acme', storyId: 'HU-123', commitSha: sha, branch: 'hu-123/aviso', recorder
  });
  assert.equal(check.verdict, 'pendiente');
  assert.equal(check.integratedInMain, false);
  assert.equal(recorder.entries[0]?.branch, 'hu-123/aviso');
});
