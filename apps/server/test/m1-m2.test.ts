import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * M1 (ejecución segura) y M2 (automejora verificada), con proveedor simulado y sin sandbox (PORTAL_SANDBOX=none):
 * política en backend, worktrees, fail-closed, verificación en ejecución y regla de cierre.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-m12-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_SANDBOX = 'none';

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, processesRepo, projectsRepo, backlogRepo, workspaceDb } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { requirePolicy, PolicyError, policyTable } = await import('../src/services/executionPolicy.ts');
const { createCompany, createProject } = await import('../src/services/companies.ts');
const { addManualItem } = await import('../src/services/backlog.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const internal = projectsRepo('portal-ia').list()[0];

function tmpRepo(prefix = 'portal-ia-m12-repo-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: dir });
  return dir;
}
const policyLog = (slug: string) => (workspaceDb(slug).prepare(`SELECT kind, status FROM execution_history WHERE kind LIKE 'policy:%' ORDER BY rowid`).all() as any[]);

test('M1 · política de ejecución: niveles, herramientas de agente, ámbito, proceso en ejecución y presupuesto; todo queda auditado', () => {
  const agents = agentsRepo('portal-ia').list();
  const dev = agents.find(a => a.key === 'pj-dev')!; const qa = agents.find(a => a.key === 'pj-qa')!; const ux = agents.find(a => a.key === 'pj-ux')!;
  // Nivel auth sin autorización → denegado
  assert.throws(() => requirePolicy('write_worktree', { slug: 'portal-ia', agentId: dev.id, projectId: internal.id }), (e: any) => e instanceof PolicyError && e.code === 'authorization_required' && e.statusCode === 403);
  // Lectura: local, sin autorización, con herramienta read_repo
  assert.equal(requirePolicy('read_repo', { slug: 'portal-ia', agentId: qa.id, projectId: internal.id }).level, 'local');
  // Escritura: el Desarrollador tiene write_repo; QA no
  assert.equal(requirePolicy('write_worktree', { slug: 'portal-ia', agentId: dev.id, projectId: internal.id, authorized: true }).agent?.key, 'pj-dev');
  assert.throws(() => requirePolicy('write_worktree', { slug: 'portal-ia', agentId: qa.id, projectId: internal.id, authorized: true }), (e: any) => e.code === 'tool_not_granted' && /write_repo/.test(e.message));
  // UX no tiene sandbox_exec ni write_repo
  assert.throws(() => requirePolicy('sandbox_exec', { slug: 'portal-ia', agentId: ux.id, projectId: internal.id, authorized: true }), (e: any) => e.code === 'tool_not_granted');
  // Ámbito: un agente de otro proyecto no opera aquí
  const other = createProject('portal-ia', 'Otro proyecto', 'x', []);
  const otherDev = agentsRepo('portal-ia').list().find(a => a.key === 'pj-dev' && a.projectId === other.id)!;
  assert.throws(() => requirePolicy('write_worktree', { slug: 'portal-ia', agentId: otherDev.id, projectId: internal.id, authorized: true }), (e: any) => e.code === 'out_of_scope');
  // Agente desconocido
  assert.throws(() => requirePolicy('ai_call', { slug: 'portal-ia', agentId: 'no-existe', authorized: true }), (e: any) => e.code === 'unknown_agent');
  // ai_call exige proceso autorizado y en ejecución con presupuesto
  const procs = processesRepo('portal-ia');
  const p = procs.create({ projectId: internal.id, kind: 'story_execution', title: 'x', estimatedUsd: 0.1, steps: [{ agentId: dev.id, agentName: 'Dev', title: 'Impl', model: 'm' }] });
  assert.throws(() => requirePolicy('ai_call', { slug: 'portal-ia', processId: p.id, agentId: dev.id, projectId: internal.id, authorized: true }), (e: any) => e.code === 'process_not_running');
  procs.authorize(p.id, 0.5);
  assert.equal(requirePolicy('ai_call', { slug: 'portal-ia', processId: p.id, agentId: dev.id, projectId: internal.id, authorized: true }).op, 'ai_call');
  procs.addUsage(p.id, 10, 10, 0.6);
  assert.throws(() => requirePolicy('ai_call', { slug: 'portal-ia', processId: p.id, agentId: dev.id, projectId: internal.id, authorized: true }), (e: any) => e.code === 'budget_exhausted');
  // Auditoría: concedidos y denegados con motivo
  const log = policyLog('portal-ia');
  assert.ok(log.some(l => l.kind === 'policy:write_worktree:denied:sin_autorizacion' && l.status === 'failed'));
  assert.ok(log.some(l => l.kind === 'policy:write_worktree:denied:sin_herramienta_write_repo'));
  assert.ok(log.some(l => l.kind === 'policy:write_worktree:denied:fuera_de_ambito'));
  assert.ok(log.some(l => l.kind === 'policy:ai_call:denied:presupuesto_agotado'));
  assert.ok(log.some(l => l.kind === 'policy:write_worktree:granted' && l.status === 'done'));
  // La tabla es cerrada: git_push es externa
  assert.equal(policyTable().find(o => o.op === 'git_push')!.level, 'external');
});

test('M1 · sandbox fail-closed: sin Docker/WSL no se ejecutan install/test/build; typecheck solo como verificación mínima', async () => {
  const { detectSandbox, runInSandbox } = await import('../src/services/sandbox.ts');
  const st = await detectSandbox(true); assert.equal(st.available, 'unavailable');
  const dir = tmpRepo();
  for (const cmd of ['test', 'build']) {
    const r = await runInSandbox(dir, dir, cmd); assert.equal(r.exitCode, 1); assert.equal(r.isolation, 'unavailable'); assert.match(r.output, /fail-closed/);
  }
  await assert.rejects(runInSandbox(dir, dir, 'rm -rf /'), /no permitido/);
  // typecheck sin tsconfig en el worktree: verificación mínima, sin ejecutar scripts del repo
  const r = await runInSandbox(dir, path.resolve('.'), 'typecheck'); assert.equal(r.isolation, 'host-min'); assert.match(r.output, /verificación mínima|No se encontró/);
});

test('M1/M2 · flujo por API: aplicar en worktree, verificar, integrar bloqueado sin verificación, publicar no requerido, comprobación en ejecución y cierre', async () => {
  const ws = createCompany('Acme M12'); const slug = ws.slug;
  const project = createProject(slug, 'Producto', 'x', []);
  const dir = tmpRepo(); projectsRepo(slug).setRepository(project.id, dir, 'main');
  const dev = agentsRepo(slug).list().find(a => a.key === 'pj-dev' && a.projectId === project.id)!;
  const it = addManualItem(slug, project.id, { title: 'Añadir saludo' });
  const procs = processesRepo(slug);
  const proc = procs.create({ projectId: project.id, kind: 'story_execution', title: 'HU-001', estimatedUsd: 0.1, backlogItemId: it.id, steps: [{ agentId: 'c', agentName: 'Coord', title: 'Plan', model: 'm' }, { agentId: dev.id, agentName: 'Dev', title: 'Implementación', model: 'm' }] });
  procs.authorize(proc.id, 1);
  procs.setResult(proc.id, { plan: null, implementationSummary: 'x', changes: [{ path: 'src/hola.ts', action: 'create', content: 'export const hola = 1;\n', diff: '+1', before: 0, after: 1 }], verifyCommands: ['typecheck'], review: null, applied: null, verifications: [], manualTest: { steps: ['Abre X. Esperado: Y.'], checks: [false], note: null }, runtimeChecks: { checks: [{ kind: 'http', path: '/api/health', selector: null, expect: '"ok":true' }], results: [], ranAt: null } });
  procs.finish(proc.id, 'done'); backlogRepo(slug).setStatus(it.id, 'review', proc.id);
  const app = await buildApp(); await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as any; process.env.PORTAL_SELF_URL = `http://127.0.0.1:${addr.port}`;
  const post = (url: string, payload: any = { authorized: true }) => app.inject({ method: 'POST', url: `/api/workspaces/${slug}${url}`, payload });
  // Sin autorización explícita → 400
  assert.equal((await post(`/processes/${proc.id}/apply`, {})).statusCode, 400);
  // Verificar antes de aplicar → 409
  assert.equal((await post(`/processes/${proc.id}/verify`, { authorized: true, command: 'typecheck' })).statusCode, 409);
  // Aplicar: worktree aislado, el checkout principal no cambia
  const a = await post(`/processes/${proc.id}/apply`); assert.equal(a.statusCode, 200, a.body);
  const applied = a.json().result.applied; assert.equal(applied.branch, 'portal-ia/hu-001'); assert.ok(applied.worktree && fs.existsSync(applied.worktree));
  assert.equal(execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir }).toString().trim(), 'main');
  assert.equal(fs.existsSync(path.join(dir, 'src/hola.ts')), false);
  assert.match(a.json().guidance.phase, /falta verificar \(typecheck\)/);
  // Integrar sin verificación → 409 verification_required
  const m0 = await post(`/processes/${proc.id}/merge`); assert.equal(m0.statusCode, 409); assert.equal(m0.json().code, 'verification_required');
  // install exige confirmación de red
  const inst = await post(`/processes/${proc.id}/verify`, { authorized: true, command: 'install' }); assert.equal(inst.statusCode, 409); assert.equal(inst.json().code, 'network_confirmation_required');
  // test sin sandbox → registrado como fallido (fail-closed), no como verificado
  const t = await post(`/processes/${proc.id}/verify`, { authorized: true, command: 'test' }); assert.equal(t.statusCode, 200);
  assert.equal(t.json().result.verifications.at(-1).isolation, 'unavailable'); assert.equal(t.json().result.verifications.at(-1).exitCode, 1);
  assert.match(t.json().guidance.phase, /verificación FALLÓ \(test\)/);
  const mf = await post(`/processes/${proc.id}/merge`); assert.equal(mf.json().code, 'verification_failed');
  // Simulamos typecheck en verde (el worktree de prueba no tiene tsconfig): se registra como verificación y desbloquea
  const cur = procs.get(proc.id)!.result!;
  procs.setResult(proc.id, { ...cur, verifications: [{ command: 'typecheck', exitCode: 0, output: 'ok', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1, isolation: 'host-min' }] });
  const g = await app.inject({ method: 'GET', url: `/api/workspaces/${slug}/processes/${proc.id}` }); assert.match(g.json().guidance.phase, /Etapa 5 de 7 · Verificado .* falta integrar/);
  // Comprobación en ejecución antes de integrar → 409
  assert.equal((await post(`/processes/${proc.id}/runtime-check`)).statusCode, 409);
  // Integrar: merge --no-ff en main, worktree retirado, checkout principal intacto
  const m = await post(`/processes/${proc.id}/merge`); assert.equal(m.statusCode, 200, m.body);
  assert.equal(m.json().result.merged.into, 'main'); assert.equal(fs.existsSync(applied.worktree), false, 'worktree retirado tras integrar');
  assert.ok(execSync('git log --oneline main', { cwd: dir }).toString().includes('Integra portal-ia/hu-001 en main'));
  assert.ok(fs.existsSync(path.join(dir, 'src/hola.ts')), 'main contiene el archivo (checkout en main)');
  // Verificación en ejecución (http contra el propio servidor) con evidencia
  const rc = await post(`/processes/${proc.id}/runtime-check`); assert.equal(rc.statusCode, 200, rc.body);
  const res = rc.json().result.runtimeChecks; assert.equal(res.results.length, 1); assert.equal(res.results[0].status, 'ok'); assert.ok(fs.existsSync(res.results[0].evidence));
  // Cierre: sin probar → not_tested; probada → cerrada SIN publicar (publicar es opcional)
  const d1 = await post(`/backlog/${it.id}/done`, {}); assert.equal(d1.statusCode, 409); assert.equal(d1.json().code, 'not_tested');
  await post(`/processes/${proc.id}/manual-test`, { checks: [true], note: 'ok' });
  const g2 = await app.inject({ method: 'GET', url: `/api/workspaces/${slug}/processes/${proc.id}` }); assert.match(g2.json().guidance.phase, /Etapa 7 de 7 · Listo para cerrar/);
  const d2 = await post(`/backlog/${it.id}/done`, {}); assert.equal(d2.statusCode, 200, d2.body); assert.equal(d2.json().status, 'done');
  assert.equal(procs.get(proc.id)!.result!.published ?? null, null, 'cerrada sin publicar');
  const g3 = await app.inject({ method: 'GET', url: `/api/workspaces/${slug}/processes/${proc.id}` });
  assert.equal(g3.json().guidance.phase, 'Historia completada'); assert.equal(g3.json().guidance.settled, true);
  // Auditoría de política y verificaciones en execution_history
  const kinds = (workspaceDb(slug).prepare(`SELECT kind FROM execution_history ORDER BY rowid`).all() as any[]).map(r => r.kind);
  for (const k of ['policy:write_worktree:granted', 'policy:sandbox_exec:granted', 'policy:git_merge:granted', 'policy:runtime_check:granted', 'verify:test:unavailable', 'repo_merge', 'runtime_check:ok']) assert.ok(kinds.includes(k), `falta ${k} en ${kinds.join(',')}`);
  await app.close();
});

test('M2 · activación: un merge que el proceso en marcha no contiene no está activo; comprobaciones http/ui parseadas y con fallo real', async () => {
  const { activationOf } = await import('../src/services/system.ts');
  const { parseRuntimeChecks } = await import('../src/services/storyExecution.ts');
  const { runRuntimeChecks, matches } = await import('../src/services/runtimeChecks.ts');
  const act = await activationOf('0000000000000000000000000000000000000000', new Date().toISOString());
  assert.equal(act.active, false); assert.match(act.reason, /no contiene|no corre desde/);
  const checks = parseRuntimeChecks('- http GET /api/system/status | version\n- ui /backlog | h1 | /\\(\\d+ abiertas\\)/\n- ui /panel | Panel\n- ninguna: nada\n- basura sin formato');
  assert.deepEqual(checks, [{ kind: 'http', path: '/api/system/status', selector: null, expect: 'version' }, { kind: 'ui', path: '/backlog', selector: 'h1', expect: '/\\(\\d+ abiertas\\)/' }, { kind: 'ui', path: '/panel', selector: 'body', expect: 'Panel' }]);
  assert.equal(matches('Plan (9 abiertas)', '/\\(\\d+ abiertas\\)/'), true); assert.equal(matches('Plan', '/\\(\\d+ abiertas\\)/'), false);
  // Contra un servidor real: una comprobación que no se cumple FALLA (nunca «ok» sin prueba)
  const app = await buildApp(); await app.listen({ port: 0, host: '127.0.0.1' });
  process.env.PORTAL_SELF_URL = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const r = await runRuntimeChecks('proc-m2', [{ kind: 'http', path: '/api/health', selector: null, expect: '"name":"portal-ia"' }, { kind: 'http', path: '/api/health', selector: null, expect: 'texto-que-no-existe' }, { kind: 'http', path: '/api/no-existe', selector: null, expect: 'x' }]);
  assert.deepEqual(r.map(x => x.status), ['ok', 'fail', 'fail']);
  await app.close();
});

test('iteración anterior a v0.12 (aplicada en la carpeta, sin worktree): orientación clara, verificar/integrar explican la salida, descartar conserva la rama, se puede iterar o cerrar como resuelta', async () => {
  const ws = createCompany('Legado'); const slug = ws.slug;
  const project = createProject(slug, 'Producto', 'x', []);
  const dir = tmpRepo(); projectsRepo(slug).setRepository(project.id, dir, 'main');
  execSync('git branch portal-ia/hu-001', { cwd: dir }); // la rama antigua existe en el repositorio
  const it = addManualItem(slug, project.id, { title: 'Feedback por paso' });
  const procs = processesRepo(slug);
  const proc = procs.create({ projectId: project.id, kind: 'story_execution', title: 'HU-001', estimatedUsd: 0.1, backlogItemId: it.id, steps: [{ agentId: 'c', agentName: 'Coord', title: 'Plan', model: 'm' }, { agentId: 'd', agentName: 'Dev', title: 'Impl', model: 'm' }] });
  procs.authorize(proc.id, 1);
  // Como en v0.11: applied sin worktree, verificaciones fallidas en el equipo, prueba manual con 6 pasos
  procs.setResult(proc.id, { plan: null, implementationSummary: 'x', changes: [{ path: 'a.ts', action: 'create', content: 'x', diff: '+x', before: 0, after: 1 }], verifyCommands: ['typecheck'], review: { approve: false, issues: ['x'], summary: 's', suggestedTests: [] }, applied: { branch: 'portal-ia/hu-001', commit: '1de85e4', files: ['a.ts'], appliedAt: '2026-10-20T00:00:00Z' }, verifications: [{ command: 'typecheck', exitCode: 2, output: 'error', startedAt: '2026-10-20T00:01:00Z', finishedAt: '2026-10-20T00:01:06Z', durationMs: 6000 }], manualTest: { steps: ['a', 'b', 'c', 'd', 'e', 'f'], checks: [false, false, false, false, false, false], note: null } });
  procs.finish(proc.id, 'done'); backlogRepo(slug).setStatus(it.id, 'review', proc.id);
  const app = await buildApp();
  const g = await app.inject({ method: 'GET', url: `/api/workspaces/${slug}/processes/${proc.id}` });
  assert.match(g.json().guidance.phase, /anterior a v0\.12/); assert.match(g.json().guidance.next, /Cerrar como resuelta/);
  const v = await app.inject({ method: 'POST', url: `/api/workspaces/${slug}/processes/${proc.id}/verify`, payload: { authorized: true, command: 'typecheck' } });
  assert.equal(v.statusCode, 409); assert.equal(v.json().code, 'legacy_applied'); assert.match(v.json().error, /antes de v0\.12/);
  const m = await app.inject({ method: 'POST', url: `/api/workspaces/${slug}/processes/${proc.id}/merge`, payload: { authorized: true } });
  assert.equal(m.json().code, 'legacy_applied');
  // Descartar: la historia vuelve a pendiente, la rama se conserva
  const rj = await app.inject({ method: 'POST', url: `/api/workspaces/${slug}/processes/${proc.id}/reject`, payload: { reason: 'iteración anterior a v0.12 descartada' } });
  assert.equal(rj.statusCode, 200, rj.body); assert.match(rj.json().guidance.phase, /descartada \(rama conservada\)/);
  assert.equal(backlogRepo(slug).get(it.id)!.status, 'pending');
  assert.ok(execSync('git branch --list portal-ia/hu-001', { cwd: dir }).toString().trim(), 'la rama antigua se conserva');
  // Preparar otra iteración: queda pendiente de autorización
  const itr = await app.inject({ method: 'POST', url: `/api/workspaces/${slug}/stories/${it.id}/iterate`, payload: { note: 'revisa si ya existe' } });
  assert.equal(itr.statusCode, 201, itr.body); assert.equal(itr.json().process.status, 'pending_authorization');
  // Alternativa: cerrar como resuelta (otra historia en el mismo estado)
  const it2 = addManualItem(slug, project.id, { title: 'Otra antigua' });
  const p2 = procs.create({ projectId: project.id, kind: 'story_execution', title: 'HU-002', estimatedUsd: 0.1, backlogItemId: it2.id, steps: [] });
  procs.authorize(p2.id, 1); procs.setResult(p2.id, { plan: null, implementationSummary: 'x', changes: [], verifyCommands: [], review: null, applied: { branch: 'portal-ia/hu-002', commit: 'abc', files: [], appliedAt: 't' }, verifications: [] }); procs.finish(p2.id, 'done'); backlogRepo(slug).setStatus(it2.id, 'review', p2.id);
  const d = await app.inject({ method: 'POST', url: `/api/workspaces/${slug}/backlog/${it2.id}/done`, payload: { force: true, reason: 'ya incluida en v0.12' } });
  assert.equal(d.statusCode, 200); assert.equal(d.json().status, 'done');
  assert.equal((await app.inject({ method: 'GET', url: `/api/workspaces/${slug}/processes/${p2.id}` })).json().guidance.phase, 'Historia completada');
  await app.close();
});
