import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Datos de prueba aislados en una carpeta temporal.
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-test-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1'; // las pruebas usan repositorios temporales para el proyecto interno

const { encryptSecret, decryptSecret, credentialHint } = await import('../src/security/crypto.ts');
const { classifyModel, pickByTier, AGENT_TEMPLATES } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');

test('cifrado AES-GCM: ida y vuelta, y la pista no revela la clave', () => {
  const secret = 'sk-ant-api03-EJEMPLO-no-real-0123456789';
  const enc = encryptSecret(secret);
  assert.notEqual(enc, secret);
  assert.equal(decryptSecret(enc), secret);
  const hint = credentialHint(secret);
  assert.ok(hint.includes('…') && hint.length < 16);
});

test('clasificación de modelos por heurística', () => {
  assert.equal(classifyModel('anthropic', 'claude-opus-4-1-20250805', 'Claude Opus 4.1').tier, 'top');
  assert.equal(classifyModel('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5').tier, 'low');
  assert.equal(classifyModel('anthropic', 'claude-sonnet-4-5', 'Claude Sonnet 4.5').supportsEffort, true);
  assert.equal(classifyModel('openai', 'gpt-5-mini').tier, 'low');
  assert.equal(classifyModel('openai', 'gpt-5').supportsEffort, true);
  const list = ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id));
  assert.equal(pickByTier(list, 'mid')!.id, 'claude-sonnet-4-5');
});

test('bootstrap exige proveedor conectado, es idempotente y crea 8 agentes inactivos', async () => {
  assert.throws(() => runBootstrap(), /Conecta y verifica un proveedor/);
  providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
  providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
  const r1 = runBootstrap();
  assert.equal(r1.alreadyInitialized, false);
  assert.equal(r1.agentsCreated, AGENT_TEMPLATES.length);
  assert.equal(r1.aiCalls, 0);
  const r2 = runBootstrap();
  assert.equal(r2.alreadyInitialized, true);
  assert.equal(r2.agentsCreated, 0);
  const agents = agentsRepo(r1.workspace.slug).list();
  assert.equal(agents.length, 8);
  assert.ok(agents.every(a => a.status === 'inactive'));
  const arq = agents.find(a => a.key === 'pj-arquitecto')!;
  assert.equal(arq.config.model, 'claude-opus-4-1');
  assert.equal(agents.filter(a => a.scope === 'workspace').length, 3);
});

test('API: la credencial nunca se devuelve y la verificación sin red falla de forma controlada', async () => {
  const app = await buildApp();
  const put = await app.inject({ method: 'PUT', url: '/api/providers/openai/credential', payload: { apiKey: 'sk-test-no-real-000000' } });
  assert.equal(put.statusCode, 200);
  const body = put.json();
  assert.equal(JSON.stringify(body).includes('sk-test-no-real'), false);
  assert.ok(body.credentialHint.includes('…'));
  const verify = await app.inject({ method: 'POST', url: '/api/providers/openai/verify' });
  assert.ok([401, 502].includes(verify.statusCode));
  assert.equal(verify.json().status, 'failed');
  await app.close();
});

test('evaluación inicial: estimación, autorización explícita y fallo controlado sin red', async () => {
  const { estimateAssessment, createAssessment, runAssessment } = await import('../src/services/assessment.ts');
  const { workspacesRepo } = await import('../src/db/platform.ts');
  const { projectsRepo, processesRepo } = await import('../src/db/workspace.ts');
  const ws = workspacesRepo.get('portal-ia')!;
  const project = projectsRepo(ws.slug).list()[0];
  const est = estimateAssessment(ws.slug, project.id);
  assert.equal(est.steps.length, 4);
  assert.ok(est.estimatedUsd > 0 && est.suggestedBudgetUsd >= est.estimatedUsd);
  const proc = createAssessment(ws.slug, project.id);
  assert.equal(proc.status, 'pending_authorization');
  assert.equal(createAssessment(ws.slug, project.id).id, proc.id, 'no duplica procesos pendientes');
  processesRepo(ws.slug).authorize(proc.id, 1);
  await runAssessment(ws.slug, proc.id, () => {});
  const done = processesRepo(ws.slug).get(proc.id)!;
  assert.equal(done.status, 'failed');            // clave de prueba → el proveedor rechaza o no hay red
  // Con respuesta 401 del proveedor no se gasta nada; sin red (p. ej. dentro del sandbox) se anota el costo estimado de la entrada «sin confirmación del proveedor».
  assert.ok(done.spentUsd === 0 || /sin confirmación del proveedor/.test(done.error ?? ''), `gasto ${done.spentUsd}: ${done.error}`);
  assert.ok(agentsRepo(ws.slug).list().every(a => a.status === 'inactive'), 'agentes vuelven a inactivo');
});

test('agentes especializados: crear, relaciones inversas, validaciones y eliminar', async () => {
  const { createAgent, deleteAgent } = await import('../src/services/agentFactory.ts');
  const { workspacesRepo } = await import('../src/db/platform.ts');
  const { projectsRepo } = await import('../src/db/workspace.ts');
  const ws = workspacesRepo.get('portal-ia')!;
  const project = projectsRepo(ws.slug).list()[0];
  const agents = agentsRepo(ws.slug);
  const input = {
    scope: 'project' as const, projectId: project.id, name: 'Documentador Técnico', role: 'Documentación técnica', reportsTo: 'pj-coordinador', collaborates: ['pj-dev'],
    evaluation: ['Documentación actualizada por cambio.'],
    config: { name: 'Documentador Técnico', specialization: 'Mantiene la documentación.', responsibilities: ['Documentar módulos.'], provider: 'anthropic' as const, model: 'claude-haiku-4-5', fallbacks: ['claude-haiku-4-5'], effort: 'low' as const, tools: { read_repo: true }, knowledge: { repo: true }, monthlyLimitUsd: 5, perTaskAuthUsd: 1 }
  };
  const a = createAgent(ws.slug, input);
  assert.equal(a.key, 'pj-documentador-tecnico');
  assert.equal(a.status, 'inactive');
  assert.equal(a.templateId, 'tpl.custom@1');
  assert.deepEqual(a.config.fallbacks, [], 'el preferido no puede ser alternativo');
  assert.equal(a.template.initials, 'DT');
  const boss = agents.list().find(x => x.key === 'pj-coordinador')!;
  assert.ok(boss.template.supervises.includes(a.key), 'el supervisor lo incluye en supervisa');
  const b = createAgent(ws.slug, input);
  assert.equal(b.key, 'pj-documentador-tecnico-2', 'claves únicas');
  assert.throws(() => createAgent(ws.slug, { ...input, reportsTo: 'no-existe' }), /no existe/);
  assert.throws(() => createAgent(ws.slug, { ...input, config: { ...input.config, model: 'modelo-inventado' } }), /no está disponible/);
  assert.throws(() => deleteAgent(ws.slug, boss.id), /equipo inicial/);
  deleteAgent(ws.slug, a.id); deleteAgent(ws.slug, b.id);
  assert.equal(agents.list().length, 8);
  assert.ok(!agents.list().find(x => x.key === 'pj-coordinador')!.template.supervises.includes('pj-documentador-tecnico'), 'relación inversa limpiada');
});

test('backlog: parseo de la síntesis, importación idempotente y solicitud manual', async () => {
  const { parseBacklogFromMarkdown, importBacklogFromKnowledge, addManualItem } = await import('../src/services/backlog.ts');
  const { workspacesRepo } = await import('../src/db/platform.ts');
  const { projectsRepo, knowledgeRepo, backlogRepo } = await import('../src/db/workspace.ts');
  const md = 'Texto previo\n```json\n[{"id":"HU-005","titulo":"Solicitudes de desarrollo","responsable":"Coordinador del Proyecto","dependeDe":"ninguna","estimacion":"M","criterio":"Se crean tareas"},{"id":"HU-006","titulo":"Sandbox","responsable":"pj-dev","dependeDe":"HU-005","estimacion":"L","criterio":"Comandos aislados"}]\n```';
  const parsed = parseBacklogFromMarkdown(md);
  assert.equal(parsed.length, 2); assert.equal(parsed[0].dependsOn, null); assert.equal(parsed[1].dependsOn, 'HU-005'); assert.equal(parsed[1].estimate, 'L');
  const ws = workspacesRepo.get('portal-ia')!; const project = projectsRepo(ws.slug).list()[0];
  knowledgeRepo(ws.slug).add({ projectId: project.id, title: 'Síntesis y backlog inicial priorizado — Coordinador del Proyecto', body: md, authorAgentId: null, authorAgentName: 'Coordinador', processId: null });
  const r1 = importBacklogFromKnowledge(ws.slug, project.id);
  assert.equal(r1.imported, 2);
  const items = backlogRepo(ws.slug).list(project.id);
  assert.equal(items[0].ownerKey, 'pj-coordinador', 'resuelve responsable por nombre');
  assert.equal(items[1].ownerKey, 'pj-dev', 'resuelve responsable por key');
  assert.equal(importBacklogFromKnowledge(ws.slug, project.id).imported, 0, 'idempotente');
  const manual = addManualItem(ws.slug, project.id, { title: 'Arreglar el selector' });
  assert.match(manual.storyId, /^HU-\d{3}$/); assert.equal(manual.status, 'pending');
});

test('escritura en repositorio: rutas seguras, diff y aplicación real en rama git', async () => {
  const { safeRelPath, unifiedDiff, annotateChanges, applyChanges, worktreePathFor, listWorktrees, removeWorktree } = await import('../src/services/repoWrite.ts');
  const { execFileSync } = await import('node:child_process');
  assert.throws(() => safeRelPath('../fuera.ts'), /no permitida/);
  assert.throws(() => safeRelPath('data/platform.sqlite'), /protegida/);
  assert.throws(() => safeRelPath('.env'), /protegida/);
  assert.equal(safeRelPath('./apps/web/src/x.tsx'), 'apps/web/src/x.tsx');
  const d = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'f.txt');
  assert.ok(d.includes('-b') && d.includes('+B'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-repo-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir }).toString().trim();
  git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(dir, 'README.md'), 'hola\n'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  const changes = annotateChanges(dir, [{ path: 'src/nuevo.ts', action: 'create', content: 'export const x = 1;\n' }, { path: 'README.md', action: 'modify', content: 'hola\nmundo\n' }]);
  assert.equal(changes[0].action, 'create'); assert.equal(changes[1].before, 2); assert.equal(changes[1].after, 3);
  const applied = await applyChanges(dir, 'portal-ia/hu-999', changes, 'HU-999: prueba', { processId: 'proc-hu-999' });
  assert.equal(applied.branch, 'portal-ia/hu-999'); assert.equal(applied.files.length, 2);
  // M1: el checkout principal NO cambia de rama ni recibe los archivos; todo ocurre en el worktree del proceso
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'el checkout principal sigue en main');
  assert.equal(fs.existsSync(path.join(dir, 'src/nuevo.ts')), false, 'el archivo no aparece en el checkout principal');
  assert.equal(applied.worktree, worktreePathFor(dir, 'proc-hu-999'));
  assert.equal(fs.readFileSync(path.join(applied.worktree!, 'src/nuevo.ts'), 'utf8'), 'export const x = 1;\n');
  assert.equal(git('status', '--porcelain'), '', 'árbol principal limpio');
  assert.equal(git('log', '--format=%s', '-n', '1', 'portal-ia/hu-999'), 'HU-999: prueba');
  const wts = await listWorktrees(dir); assert.deepEqual(wts.map(w => w.processId), ['proc-hu-999']);
  // Cambios locales sin confirmar en el checkout principal ya no bloquean aplicar (no se toca ese árbol)
  fs.writeFileSync(path.join(dir, 'sucio.txt'), 'x');
  const otra = await applyChanges(dir, 'portal-ia/otra', changes, 'x', { processId: 'proc-otra' });
  assert.equal(otra.branch, 'portal-ia/otra'); assert.ok(fs.existsSync(path.join(dir, 'sucio.txt')), 'el archivo local sigue intacto');
  assert.equal(await removeWorktree(dir, 'proc-otra'), true); assert.equal(fs.existsSync(otra.worktree!), false);
  assert.equal((await listWorktrees(dir)).length, 1);
  assert.throws(() => worktreePathFor(dir, '../x'), /no válido/);
});

test('parser de backlog robusto: tabla markdown, lista y JSON sin etiqueta', async () => {
  const { parseBacklogFromMarkdown } = await import('../src/services/backlog.ts');
  const table = `| ID | Título | Responsable | Depende de | Estimación | Criterio |\n|---|---|---|---|---|---|\n| HU-005 | **Solicitudes** | Coordinador | — | M | Se crean tareas |\n| HU-006 | Sandbox | Desarrollador | HU-005 | L | Aislado |`;
  const t = parseBacklogFromMarkdown(table);
  assert.equal(t.length, 2); assert.equal(t[0].title, 'Solicitudes'); assert.equal(t[1].dependsOn, 'HU-005'); assert.equal(t[1].estimate, 'L');
  const list = `### Semana 1\n- **HU-005 — Solicitudes de desarrollo** (Coordinador, M)\n- HU-006: Sandbox de ejecución\n`;
  const l = parseBacklogFromMarkdown(list);
  assert.equal(l.length, 2); assert.ok(l[0].title.startsWith('Solicitudes'));
  const plain = 'Backlog:\n```\n[{"id":"HU-010","titulo":"Exportar","estimacion":"S"}]\n```';
  assert.equal(parseBacklogFromMarkdown(plain)[0].storyId, 'HU-010');
  const wrapped = '```json\n{"backlog":[{"id":"HU-011","title":"Otra","estimate":"M","dependeDe":"HU-010"}]}\n```';
  assert.equal(parseBacklogFromMarkdown(wrapped)[0].dependsOn, 'HU-010');
});

test('empresas y proyectos: creación con agentes de plantilla; asistente persiste mensajes', async () => {
  const { createCompany, createProject } = await import('../src/services/companies.ts');
  const { assistantRepo, assistantInfo } = await import('../src/services/assistant.ts');
  const ws = createCompany('Panadería Luna');
  assert.equal(ws.slug, 'panaderia-luna'); assert.equal(ws.kind, 'company');
  assert.equal(agentsRepo(ws.slug).list().length, 3, '3 agentes de espacio');
  const p = createProject(ws.slug, 'Tienda en línea', 'Vender pan por internet', ['Catálogo', 'Pedidos']);
  assert.equal(agentsRepo(ws.slug).list().filter(a => a.projectId === p.id).length, 5, '5 agentes de proyecto');
  const ws2 = createCompany('Panadería Luna');
  assert.equal(ws2.slug, 'panaderia-luna-2', 'slug único');
  const info = assistantInfo();
  assert.equal(info.name, 'Asistente de Empresa'); assert.ok(info.monthlyLimitUsd > 0);
  assistantRepo.add({ role: 'user', content: 'hola', actions: [], attachments: [{ name: 'captura.png', mediaType: 'image/png', bytes: 1200 }], tokensIn: 0, tokensOut: 0, costUsd: 0, model: null });
  assert.equal(assistantRepo.list().length, 1);
  assert.equal(assistantRepo.list()[0].attachments[0].name, 'captura.png', 'adjuntos persistidos');
  assistantRepo.clear(); assert.equal(assistantRepo.list().length, 0);
});

test('asistente: parseo de respuesta (bloque actions, JSON legado, texto plano) y propuestas con autorización', async () => {
  const { parseResponse, performActions, assistantRepo, resolveProposal } = await import('../src/services/assistant.ts');
  const { backlogRepo, processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
  const { execSync } = await import('node:child_process');
  // Repositorio git temporal registrado en el proyecto interno (la estimación lo requiere).
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-repo-'));
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# demo\n');
  execSync('git init -q && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: repoDir });
  const internal = projectsRepo('portal-ia').list()[0];
  projectsRepo('portal-ia').setRepository(internal.id, repoDir, 'main');
  // 1) Formato nuevo: markdown + bloque ```actions
  const r1 = parseResponse('Claro, **la añado**.\n\n```actions\n[{"type":"add_backlog_item","company":"portal-ia","project":"Desarrollo del Portal","title":"Soportar imágenes en el chat","criterion":"Se pueden adjuntar PNG/JPEG"}]\n```');
  assert.equal(r1.reply, 'Claro, **la añado**.'); assert.equal(r1.actions.length, 1);
  // 2) JSON legado completo
  const r2 = parseResponse('{"reply":"Hecho","actions":[]}'); assert.equal(r2.reply, 'Hecho');
  // 3) Texto plano con JSON colado al final → se recorta
  const r3 = parseResponse('Respuesta normal.\n{"reply":"duplicado"}'); assert.equal(r3.reply, 'Respuesta normal.'); assert.equal(r3.actions.length, 0);
  // 4) Bloque truncado → no rompe
  const r4 = parseResponse('Texto\n```actions\n[{"type":"add_'); assert.equal(r4.actions.length, 0);

  // Acciones: añadir historia (local) y proponer su ejecución (pendiente de autorización, sin IA)
  const acts = performActions([
    { type: 'add_backlog_item', company: 'portal-ia', project: 'Desarrollo del Portal', title: 'Soportar imágenes en el chat', criterion: 'Se pueden adjuntar PNG/JPEG' },
    { type: 'execute_story', company: 'portal-ia', project: 'Desarrollo del Portal', story: 'Soportar imágenes en el chat' },
    { type: 'apply_changes', company: 'portal-ia', processId: 'no-existe' }
  ]);
  assert.equal(acts[0].type, 'add_backlog_item'); assert.equal(acts[0].status, 'done');
  assert.equal(acts[1].type, 'propose_execution'); assert.equal(acts[1].status, 'pending'); assert.ok(acts[1].processId); assert.ok((acts[1].estimatedUsd ?? 0) > 0);
  assert.equal(acts[2].type, 'propose_apply'); assert.equal(acts[2].status, 'failed');
  const proc = processesRepo('portal-ia').get(acts[1].processId!);
  assert.equal(proc?.status, 'pending_authorization', 'el proceso espera autorización: no se gastó IA');
  const items = backlogRepo('portal-ia').list(acts[1].projectId!);
  assert.ok(items.some(i => i.title === 'Soportar imágenes en el chat'));
  // Resolver la propuesta desde la tarjeta
  const msg = assistantRepo.add({ role: 'assistant', content: 'Propongo ejecutarla.', actions: acts, attachments: [], tokensIn: 10, tokensOut: 5, costUsd: 0.001, model: 'x' });
  resolveProposal(msg.id, acts[1].processId!, 'done', 'Autorizada');
  assert.equal(assistantRepo.get(msg.id)!.actions[1].status, 'done');
  assert.equal(assistantRepo.get(msg.id)!.actions[1].detail, 'Autorizada');
  assistantRepo.clear();
});

test('aplicar cambios en un repositorio recién creado (sin commits) y rescate del veredicto de QA cortado', async () => {
  const { applyChanges, worktreePathFor } = await import('../src/services/repoWrite.ts');
  const { parseReview } = await import('../src/services/storyExecution.ts');
  const { execSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-empty-'));
  execSync('git init -q', { cwd: dir });
  const changes = [{ path: 'README.md', action: 'create', content: '# Hola\n' }, { path: 'src/index.ts', action: 'create', content: 'export {};\n' }].map(c => ({ ...c, diff: '', before: 0, after: 1 })) as any;
  // M1: sin commits no hay base desde la que crear un worktree → mensaje claro (409), nada se escribe
  await assert.rejects(applyChanges(dir, 'portal-ia/hu-001', changes, 'HU-001: inicio'), /no tiene commits/);
  assert.equal(fs.existsSync(path.join(dir, 'README.md')), false);
  execSync('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m Base', { cwd: dir });
  const r = await applyChanges(dir, 'portal-ia/hu-001', changes, 'HU-001: inicio', { processId: 'proc-hu-001' });
  assert.equal(r.branch, 'portal-ia/hu-001'); assert.ok(r.commit.length >= 7); assert.equal(r.files.length, 2);
  assert.notEqual(execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir }).toString().trim(), 'portal-ia/hu-001', 'el checkout principal no cambia de rama');
  assert.equal(execSync('git status --porcelain', { cwd: dir }).toString().trim(), '', 'árbol principal limpio');
  // Fallo controlado: ruta protegida → se deshace: sin worktree, sin rama, sin restos
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-empty2-'));
  execSync('git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m Base', { cwd: dir2 });
  await assert.rejects(applyChanges(dir2, 'portal-ia/x', [{ path: 'ok.txt', action: 'create', content: 'a' }, { path: '.git/config', action: 'create', content: 'x' }].map(c => ({ ...c, diff: '', before: 0, after: 1 })) as any, 'm', { processId: 'proc-x' }));
  assert.equal(fs.existsSync(path.join(dir2, 'ok.txt')), false, 'archivo revertido');
  assert.equal(fs.existsSync(worktreePathFor(dir2, 'proc-x')), false, 'worktree retirado');
  assert.equal(execSync('git branch --list portal-ia/x', { cwd: dir2 }).toString().trim(), '', 'rama retirada');
  // QA cortado por max_tokens
  const v = parseReview('{"approve": false, "summary": "El esqueleto es coherente. Sin embargo no hay evidencia de ejecución", "issues": ["Nada se ha ejecutado", "Falta package-lock', 'max_tokens');
  assert.equal(v.approve, false); assert.ok(v.summary.startsWith('El esqueleto es coherente')); assert.ok(v.summary.includes('se cortó'));
  assert.deepEqual(v.issues, ['Nada se ha ejecutado']);
  const ok = parseReview('```json\n{"approve": true, "summary": "Bien", "issues": [], "suggestedTests": ["npm test"]}\n```', 'end_turn');
  assert.equal(ok.approve, true); assert.deepEqual(ok.suggestedTests, ['npm test']);
});

test('desarrollador: formato de bloques de archivo, detección de archivo cortado y tolerancia a cercas', async () => {
  const { parseFileBlocks } = await import('../src/services/storyExecution.ts');
  const ok = parseFileBlocks(`=== RESUMEN ===\nSe añade contracts.\n=== ARCHIVO: packages/contracts/package.json | create ===\n{\n  "name": "@portal/contracts"\n}\n=== FIN ARCHIVO ===\n=== ARCHIVO: src/old.ts | delete ===\n=== FIN ARCHIVO ===\n=== ARCHIVO: eslint.config.js | modify ===\n\`\`\`js\nconst a = "=== no es marcador ===";\n\`\`\`\n=== FIN ARCHIVO ===\n=== VERIFICAR: typecheck, test ===\n=== NOTAS ===\nFalta lock.\n`);
  assert.equal(ok.changes.length, 3); assert.equal(ok.changes[0].content, '{\n  "name": "@portal/contracts"\n}\n'); assert.equal(ok.changes[1].action, 'delete');
  assert.equal(ok.changes[2].content, 'const a = "=== no es marcador ===";\n'); assert.deepEqual(ok.verify, ['typecheck', 'test']); assert.equal(ok.summary, 'Se añade contracts.'); assert.equal(ok.notes, 'Falta lock.'); assert.equal(ok.truncatedFile, null);
  const cut = parseFileBlocks(`=== RESUMEN ===\nX\n=== ARCHIVO: a.ts | create ===\nexport const a = 1;\n=== FIN ARCHIVO ===\n=== ARCHIVO: b.ts | create ===\nexport const b = `);
  assert.equal(cut.changes.length, 1); assert.equal(cut.truncatedFile, 'b.ts');
  assert.equal(parseFileBlocks('{"summary":"json"}').changes.length, 0);
});

test('git: integrar en la rama principal y publicar en un remoto local; numeración continua y referencias del asistente', async () => {
  const { applyChanges, mergeBranch, pushBranches, remoteInfo } = await import('../src/services/repoWrite.ts');
  const { parseResponse } = await import('../src/services/assistant.ts');
  const { addManualItem } = await import('../src/services/backlog.ts');
  const { backlogRepo, projectsRepo } = await import('../src/db/workspace.ts');
  const { execSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-merge-'));
  execSync('git init -q -b main && echo base > base.txt && git add -A && git -c user.email=t@t -c user.name=t commit -qm base', { cwd: dir });
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-remote-')); execSync('git init -q --bare', { cwd: bare });
  execSync(`git remote add origin "${bare}"`, { cwd: dir });
  const a = await applyChanges(dir, 'portal-ia/hu-002', [{ path: 'src/x.ts', action: 'create', content: 'export const x = 2;\n', diff: '', before: 0, after: 1 } as any], 'HU-002');
  const m = await mergeBranch(dir, a.branch);
  assert.equal(m.into, 'main'); assert.equal(execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir }).toString().trim(), 'main');
  assert.ok(execSync('git log --oneline', { cwd: dir }).toString().includes('Integra portal-ia/hu-002 en main'));
  assert.ok(fs.existsSync(path.join(dir, 'src/x.ts')), 'archivo integrado en main');
  await assert.rejects(mergeBranch(dir, a.branch, a.branch), /misma rama/); // destino inválido
  await assert.rejects(mergeBranch(dir, a.branch, 'no-existe'), /no existe/);
  const info = await remoteInfo(dir); assert.equal(info.remote, 'origin');
  const p = await pushBranches(dir, [a.branch, 'main']);
  assert.equal(p.branches.length, 2);
  assert.ok(execSync('git branch', { cwd: bare }).toString().includes('portal-ia/hu-002'), 'rama publicada en el remoto');
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-noremote-')); execSync('git init -q', { cwd: dir2 });
  await assert.rejects(pushBranches(dir2, ['main']), /no tiene un remoto/);
  // Numeración continua de historias manuales
  const internal = projectsRepo('portal-ia').list()[0];
  const before = backlogRepo('portal-ia').list(internal.id);
  const maxN = Math.max(0, ...before.map(b => parseInt(b.storyId.replace(/\D+/g, ''), 10)));
  const it = addManualItem('portal-ia', internal.id, { title: 'Numeración continua' });
  assert.equal(it.storyId, `HU-${String(maxN + 1).padStart(3, '0')}`);
  // JSON legado cortado → texto legible
  const r = parseResponse('{"reply":"Hecho.\\n- **Una**\\n- Dos","actions":[{"type":"add_backlog_item","title":"El');
  assert.equal(r.reply, 'Hecho.\n- **Una**\n- Dos'); assert.equal(r.actions.length, 0);
});

test('flujo git: estado del repositorio, crear main, remoto, preflight del proyecto interno, impacto de cambios y regla de cierre', async () => {
  const { repoStatus, initMainBranch, setRemote } = await import('../src/services/repoStatus.ts');
  const { applyChanges } = await import('../src/services/repoWrite.ts');
  const { preflightRepo } = await import('../src/services/storyExecution.ts');
  const { classifyImpact } = await import('../src/services/system.ts');
  const { REPO_ROOT } = await import('../src/config.ts');
  const { execSync } = await import('node:child_process');
  // Repositorio que nació sin main (como el del propietario): solo ramas portal-ia/hu-xxx
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-nomain-'));
  execSync('git init -q -b portal-ia/hu-001 && echo a > a.txt && git add -A && git -c user.email=t@t -c user.name=t commit -qm HU-001', { cwd: dir });
  let st = await repoStatus(dir);
  assert.equal(st.hasMain, false); assert.equal(st.branch, 'portal-ia/hu-001'); assert.deepEqual(st.storyBranches, ['portal-ia/hu-001']); assert.equal(st.remote, null); assert.equal(st.isPortalRuntime, false);
  const im = await initMainBranch(dir); assert.equal(im.mainBranch, 'main'); assert.equal(im.from, 'portal-ia/hu-001');
  st = await repoStatus(dir); assert.equal(st.hasMain, true); assert.equal(st.branch, 'main');
  await assert.rejects(initMainBranch(dir), /ya existe/);
  await assert.rejects(setRemote(dir, 'ftp://malo'), /no válida/);
  const r = await setRemote(dir, 'https://github.com/CosioYair/portal-ia.git'); assert.equal(r.remote, 'origin');
  st = await repoStatus(dir); assert.equal(st.remoteUrl, 'https://github.com/CosioYair/portal-ia.git'); assert.equal(st.aheadOfRemote, -1, 'main nunca publicada');
  // Las historias nuevas parten de main aunque la rama activa sea otra
  execSync('git checkout -q portal-ia/hu-001', { cwd: dir });
  await applyChanges(dir, 'portal-ia/hu-002', [{ path: 'b.txt', action: 'create', content: 'b', diff: '', before: 0, after: 1 } as any], 'HU-002', { processId: 'proc-hu-002' });
  assert.equal(execSync('git log --format=%s -n 2 portal-ia/hu-002', { cwd: dir }).toString().trim().split('\n')[1], 'HU-001', 'hu-002 parte de main (que contiene HU-001)');
  assert.equal(execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir }).toString().trim(), 'portal-ia/hu-001', 'la rama activa del checkout no cambia');
  // Preflight: el proyecto interno exige la carpeta de esta instalación
  delete process.env.PORTAL_ALLOW_FOREIGN_REPO;
  assert.throws(() => preflightRepo('portal-ia', dir), /no es la carpeta desde la que corre este Portal/);
  assert.doesNotThrow(() => preflightRepo('portal-ia', REPO_ROOT));
  assert.doesNotThrow(() => preflightRepo('otra-empresa', dir));
  process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
  // Clasificación del impacto de los cambios
  assert.equal(classifyImpact(['docs/x.md', 'apps/server/test/a.test.ts']), 'none');
  assert.equal(classifyImpact(['apps/web/src/screens/Backlog.tsx']), 'reload');
  assert.equal(classifyImpact(['apps/web/src/a.tsx', 'apps/server/src/app.ts']), 'restart');
  assert.equal(classifyImpact(['package.json']), 'restart');
  // Regla de cierre vía API: sin cambios integrados → 409; con force → cerrada
  const { addManualItem } = await import('../src/services/backlog.ts');
  const { projectsRepo } = await import('../src/db/workspace.ts');
  const internal = projectsRepo('portal-ia').list()[0];
  const it = addManualItem('portal-ia', internal.id, { title: 'Historia resuelta fuera del flujo' });
  const app = await buildApp();
  const r1 = await app.inject({ method: 'POST', url: `/api/workspaces/portal-ia/backlog/${it.id}/done`, payload: {} });
  assert.equal(r1.statusCode, 409); assert.equal(r1.json().code, 'not_applied');
  const r2 = await app.inject({ method: 'POST', url: `/api/workspaces/portal-ia/backlog/${it.id}/done`, payload: { force: true, reason: 'ya implementada en v0.8' } });
  assert.equal(r2.statusCode, 200); assert.equal(r2.json().status, 'done');
  const r3 = await app.inject({ method: 'GET', url: '/api/system/status' });
  assert.equal(r3.statusCode, 200); assert.ok(/^0\.(8|9|1\d)/.test(r3.json().version));
  await app.close();
});

test('encargos delegados: responsable por ámbito, equipo a su cargo, proceso pendiente sin IA y aplicación de propuestas al backlog', async () => {
  const { pickLeadAgent, teamOf, createDelegation, estimateDelegation, applyBacklogOps } = await import('../src/services/delegation.ts');
  const { backlogRepo, processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
  const { addManualItem } = await import('../src/services/backlog.ts');
  const internal = projectsRepo('portal-ia').list()[0];
  const coord = pickLeadAgent('portal-ia', internal.id, undefined); assert.equal(coord.key, 'pj-coordinador');
  const gestor = pickLeadAgent('portal-ia', null, undefined); assert.equal(gestor.key, 'ws-gestor');
  assert.equal(pickLeadAgent('portal-ia', internal.id, 'arquitecto').key, 'pj-arquitecto');
  assert.equal(pickLeadAgent('portal-ia', internal.id, 'Agente de Onboarding').key, 'ws-onboarding');
  const team = teamOf('portal-ia', coord).map(a => a.key).sort(); assert.deepEqual(team, ['pj-arquitecto', 'pj-dev', 'pj-qa', 'pj-ux']);
  const est = estimateDelegation('portal-ia', internal.id, undefined, 'Revisa y replantea el backlog');
  assert.equal(est.steps.length, 1 + 3 + 1, 'validación + hasta 3 consultas + entregable'); assert.ok(est.estimatedUsd > 0);
  const proc = createDelegation('portal-ia', internal.id, undefined, 'Revisa y replantea el backlog');
  assert.equal(proc.kind, 'delegated_task'); assert.equal(proc.status, 'pending_authorization'); assert.equal(proc.delegation?.leadAgentName, 'Coordinador del Proyecto'); assert.equal(proc.spentUsd, 0);
  // Propuestas al backlog aplicadas con aprobación
  const a = addManualItem('portal-ia', internal.id, { title: 'Historia A (solapada)' });
  const b = addManualItem('portal-ia', internal.id, { title: 'Historia B (ancla)' });
  const c = addManualItem('portal-ia', internal.id, { title: 'Historia C (resuelta)' });
  processesRepo('portal-ia').setDelegation(proc.id, { ...proc.delegation!, deliverable: 'ok', backlogOps: [
    { op: 'merge', into: b.storyId, from: [a.storyId], title: 'Historia B ampliada', reason: 'solapamiento' },
    { op: 'discard', story: c.storyId, reason: 'ya resuelta en v0.8' },
    { op: 'add', title: 'Historia nueva D', criterion: 'criterio D', estimate: 'S', reason: 'hueco detectado' },
    { op: 'update', story: 'HU-999', title: 'no existe', reason: 'x' },
    { op: 'reprioritize', order: [b.storyId], reason: 'primero lo ancla' }
  ] });
  const d = applyBacklogOps('portal-ia', proc.id);
  assert.ok(d.opsApplied); assert.equal(d.opsApplied!.summary.length, 5);
  assert.ok(d.opsApplied!.summary[3].startsWith('✖'), 'historia inexistente informada, no rompe');
  const items = backlogRepo('portal-ia').list(internal.id);
  assert.equal(items.find(i => i.id === a.id)!.status, 'discarded'); assert.equal(items.find(i => i.id === b.id)!.title, 'Historia B ampliada'); assert.equal(items.find(i => i.id === c.id)!.status, 'discarded');
  assert.ok(items.some(i => i.title === 'Historia nueva D' && i.estimate === 'S'));
  assert.throws(() => applyBacklogOps('portal-ia', proc.id), /ya se aplicaron/);
});

test('propuestas al backlog: bloque backlog cerrado, bloque json, bloque cortado (recupera objetos completos) y re-parseo de procesos antiguos', async () => {
  const { extractBacklogOps, ensureOpsParsed, createDelegation } = await import('../src/services/delegation.ts');
  const { processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
  const ok = extractBacklogOps('# Informe\n\n```bash\ngit status\n```\n\nTexto.\n\n```backlog\n[{"op":"discard","story":"HU-003","reason":"ya"},{"op":"add","title":"X","criterion":"c","reason":"r"}]\n```');
  assert.equal(ok.ops.length, 2); assert.equal(ok.truncated, false); assert.ok(ok.body.includes('git status') && !ok.body.includes('"op"'));
  const js = extractBacklogOps('Texto\n```json\n[{"op":"update","story":"HU-001","title":"t","reason":"r"}]\n```');
  assert.equal(js.ops.length, 1);
  const cut = extractBacklogOps('Informe\n```backlog\n[\n  {"op":"merge","into":"HU-129","from":["HU-121"],"reason":"a {b} \\"c\\""},\n  {"op":"discard","story":"HU-118","reason":"x"},\n  {"op":"add","title":"cortada","criterion":"se corta aq');
  assert.equal(cut.ops.length, 2); assert.equal(cut.truncated, true); assert.equal(cut.body, 'Informe');
  assert.equal(extractBacklogOps('Sin propuestas\n```json\n{"a":1}\n```').ops.length, 0);
  // Proceso antiguo con el bloque sin extraer
  const internal = projectsRepo('portal-ia').list()[0];
  const p = createDelegation('portal-ia', internal.id, undefined, 'Encargo antiguo de prueba');
  processesRepo('portal-ia').setDelegation(p.id, { ...p.delegation!, deliverable: 'Hola\n```backlog\n[{"op":"discard","story":"HU-003","reason":"x"}]\n```' });
  const fixed = ensureOpsParsed('portal-ia', processesRepo('portal-ia').get(p.id)!);
  assert.equal(fixed.delegation!.backlogOps.length, 1); assert.equal(fixed.delegation!.deliverable, 'Hola');
});

test('v0.9: parches buscar/reemplazar, rutas protegidas sin tumbar el proceso, .env.example permitido, secretos, orientación', async () => {
  const { applyPatch, annotateChanges, scanSecrets, safeRelPath } = await import('../src/services/repoWrite.ts');
  const { parseFileBlocks } = await import('../src/services/storyExecution.ts');
  const { describeProcess } = await import('../src/services/guidance.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-patch-'));
  fs.writeFileSync(path.join(dir, 'a.ts'), 'const a = 1;\nconst b = 2;\nexport { a, b };\n');
  // applyPatch exacto y tolerante a espacios finales
  assert.equal(applyPatch('x\ny\nz', [{ search: 'y', replace: 'Y' }]).text, 'x\nY\nz');
  assert.match(applyPatch('x\ny\nz', [{ search: 'q', replace: 'Q' }]).error!, /no aparece/);
  assert.match(applyPatch('y\ny', [{ search: 'y', replace: 'Q' }]).error!, /más de una vez/);
  assert.equal(applyPatch('a  \nb\n', [{ search: 'a\nb', replace: 'c' }]).text, 'c\n', 'tolera espacios finales');
  // Formato con patch
  const parsed = parseFileBlocks('=== RESUMEN ===\nok\n=== ARCHIVO: a.ts | patch ===\n<<<< BUSCAR\nconst b = 2;\n==== REEMPLAZAR\nconst b = 3;\n>>>> FIN\n=== FIN ARCHIVO ===\n=== ARCHIVO: .env.example | create ===\nPORT=4310\n=== FIN ARCHIVO ===\n=== ARCHIVO: .env | create ===\nSECRET=x\n=== FIN ARCHIVO ===\n=== ARCHIVO: k.ts | create ===\nconst key = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";\n=== FIN ARCHIVO ===');
  assert.equal(parsed.changes.length, 4); assert.equal(parsed.changes[0].action, 'patch'); assert.equal(parsed.changes[0].edits!.length, 1);
  const ann = annotateChanges(dir, parsed.changes);
  assert.equal(ann[0].content, 'const a = 1;\nconst b = 3;\nexport { a, b };\n'); assert.equal(ann[0].action, 'modify'); assert.equal(ann[0].error ?? null, null);
  assert.equal(ann[1].error ?? null, null, '.env.example se permite');
  assert.match(ann[2].error!, /protegida/, '.env real se bloquea pero no tumba el resto');
  assert.match(ann[3].warning!, /Anthropic/, 'aviso de secreto');
  assert.doesNotThrow(() => safeRelPath('.env.sample')); assert.throws(() => safeRelPath('.env.local'));
  assert.equal(scanSecrets('const x = 1;'), null);
  // Parche que no encaja → error en ese cambio
  const bad = annotateChanges(dir, [{ path: 'a.ts', action: 'patch', content: null, edits: [{ search: 'no existe', replace: 'x' }] }]);
  assert.match(bad[0].error!, /no aparece/);
  // Orientación
  const base: any = { id: 'p', kind: 'story_execution', status: 'done', steps: [], spentUsd: 0.5, budgetUsd: 2, error: null, delegation: null };
  assert.match(describeProcess({ ...base, result: { changes: [{ path: 'a', error: null }], applied: null, merged: null, published: null, review: null, verifyCommands: [] } }).phase, /Diff listo/);
  assert.match(describeProcess({ ...base, result: { changes: [{ path: 'a' }], applied: { branch: 'b', appliedAt: new Date().toISOString() }, merged: null, published: null, review: null, verifyCommands: [], verifications: [] } }).phase, /falta verificar/);
  assert.match(describeProcess({ ...base, result: { changes: [{ path: 'a' }], applied: { branch: 'b' }, merged: { into: 'main' }, published: null, review: null, verifyCommands: [] } }, { isPortalRepo: true }).next, /lista de prueba/);
  assert.match(describeProcess({ ...base, status: 'failed', error: 'X', result: null }).phase, /Falló/);
  assert.equal(describeProcess({ ...base, status: 'pending_authorization', result: null }).settled, false);
});

test('recuperar sin IA un proceso fallido con salida del Desarrollador, y reintentar', async () => {
  const { recoverStory, retryStory, createStoryProcess } = await import('../src/services/storyExecution.ts');
  const { processesRepo, projectsRepo, backlogRepo } = await import('../src/db/workspace.ts');
  const { addManualItem } = await import('../src/services/backlog.ts');
  const { execSync } = await import('node:child_process');
  const internal = projectsRepo('portal-ia').list()[0];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-recover-')); fs.writeFileSync(path.join(dir, 'x.ts'), 'export const x = 1;\n'); execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm i', { cwd: dir });
  projectsRepo('portal-ia').setRepository(internal.id, dir, 'main');
  const it = addManualItem('portal-ia', internal.id, { title: 'Historia recuperable' });
  const proc = createStoryProcess('portal-ia', internal.id, it.id);
  const procs = processesRepo('portal-ia');
  procs.authorize(proc.id, 1);
  procs.stepFinish(proc.steps[0].id, 'done', { outputMd: '{"summary":"plan","tasks":["t"],"filesToRead":[],"filesToChange":["x.ts"],"acceptance":[],"risks":[]}' });
  procs.stepFinish(proc.steps[1].id, 'done', { outputMd: '=== RESUMEN ===\nhecho\n=== ARCHIVO: x.ts | patch ===\n<<<< BUSCAR\nexport const x = 1;\n==== REEMPLAZAR\nexport const x = 2;\n>>>> FIN\n=== FIN ARCHIVO ===\n=== ARCHIVO: .env | create ===\nA=1\n=== FIN ARCHIVO ===\n=== VERIFICAR: typecheck ===' });
  procs.finish(proc.id, 'failed', 'Ruta protegida: .env'); backlogRepo('portal-ia').setStatus(it.id, 'pending', proc.id);
  const r = await recoverStory('portal-ia', proc.id);
  assert.equal(r.status, 'done'); assert.equal(r.result!.changes.length, 2); assert.equal(r.result!.changes.filter(c => !c.error).length, 1);
  assert.equal(r.result!.changes[0].content, 'export const x = 2;\n'); assert.equal(r.result!.plan?.summary, 'plan');
  assert.equal(backlogRepo('portal-ia').get(it.id)!.status, 'review');
  const again = retryStory('portal-ia', proc.id); // una historia en revisión también puede relanzarse (diff flojo) assert.equal(again.status, 'pending_authorization'); assert.notEqual(again.id, proc.id);
});

test('v0.10: devolver a pendiente / rechazar diff, replanteo por encargo, y protección contra archivos desactualizados', async () => {
  const { resetStory, addManualItem } = await import('../src/services/backlog.ts');
  const { createStoryProcess } = await import('../src/services/storyExecution.ts');
  const { applyBacklogOps, createDelegation } = await import('../src/services/delegation.ts');
  const { checkStaleChanges, annotateChanges, fileChangedSince } = await import('../src/services/repoWrite.ts');
  const { processesRepo, projectsRepo, backlogRepo } = await import('../src/db/workspace.ts');
  const { execSync } = await import('node:child_process');
  const internal = projectsRepo('portal-ia').list()[0];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-stale-')); fs.writeFileSync(path.join(dir, 'f.ts'), 'v1\n'); execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm i', { cwd: dir });
  projectsRepo('portal-ia').setRepository(internal.id, dir, 'main');
  // Historia en revisión con diff pendiente → reset
  const it = addManualItem('portal-ia', internal.id, { title: 'Historia replanteable', criterion: 'c1' });
  const proc = createStoryProcess('portal-ia', internal.id, it.id); const procs = processesRepo('portal-ia');
  procs.authorize(proc.id, 1); procs.setResult(proc.id, { plan: null, implementationSummary: 'x', changes: annotateChanges(dir, [{ path: 'f.ts', action: 'modify', content: 'v2\n' }]), verifyCommands: [], review: null, applied: null, verifications: [] }); procs.finish(proc.id, 'done'); backlogRepo('portal-ia').setStatus(it.id, 'review', proc.id);
  const r = resetStory('portal-ia', it.id, 'alcance nuevo');
  assert.equal(r.status, 'pending'); assert.ok(procs.get(proc.id)!.result!.rejected); assert.match(r.description, /Devuelta a pendiente: alcance nuevo/);
  assert.throws(() => { backlogRepo('portal-ia').setStatus(it.id, 'in_progress', proc.id); resetStory('portal-ia', it.id, 'x'); }, /en ejecución/);
  backlogRepo('portal-ia').setStatus(it.id, 'review', proc.id);
  // Encargo que replantea (update de título/criterio) una historia en revisión → vuelve a pendiente
  const d = createDelegation('portal-ia', internal.id, undefined, 'Replantea la historia');
  procs.setDelegation(d.id, { ...d.delegation!, deliverable: 'ok', backlogOps: [{ op: 'update', story: it.storyId, title: 'Historia replanteada', criterion: 'c2', reason: 'nuevo alcance' }] });
  const applied = applyBacklogOps('portal-ia', d.id);
  assert.match(applied.opsApplied!.summary[0], /devuelta a pendiente/);
  assert.equal(backlogRepo('portal-ia').get(it.id)!.status, 'pending'); assert.equal(backlogRepo('portal-ia').get(it.id)!.title, 'Historia replanteada');
  // Archivo cambiado después de leerse → el modify completo se bloquea al aplicar
  const ch = annotateChanges(dir, [{ path: 'f.ts', action: 'modify', content: 'v2\n' }]); assert.ok(ch[0].baseHash);
  fs.writeFileSync(path.join(dir, 'f.ts'), 'v1 editado después\n'); execSync('git add -A && git -c user.email=t@t -c user.name=t commit -qm later', { cwd: dir });
  const checked = checkStaleChanges(dir, ch); assert.match(checked[0].error!, /cambió en el repositorio/);
  assert.equal(await fileChangedSince(dir, 'f.ts', new Date(Date.now() - 60_000).toISOString()), true);
  assert.equal(await fileChangedSince(dir, 'f.ts', new Date(Date.now() + 60_000).toISOString()), false);
  // Aviso por borrado masivo en un modify completo
  fs.writeFileSync(path.join(dir, 'big.ts'), Array.from({ length: 60 }, (_, i) => `l${i}`).join('\n') + '\n');
  const big = annotateChanges(dir, [{ path: 'big.ts', action: 'modify', content: 'solo\n' }]); assert.match(big[0].warning!, /reemplazo completo/);
});

test('v0.11: sección PARA EL PROPIETARIO y PRUEBA MANUAL, regla de cierre con prueba, orden de cierre, EOL', async () => {
  const { parseFileBlocks } = await import('../src/services/storyExecution.ts');
  const { describeProcess } = await import('../src/services/guidance.ts');
  const { repoStatus, normalizeEol } = await import('../src/services/repoStatus.ts');
  const { annotateChanges, applyChanges } = await import('../src/services/repoWrite.ts');
  const { execSync } = await import('node:child_process');
  const p = parseFileBlocks('=== RESUMEN ===\nx\n=== PARA EL PROPIETARIO ===\nVerás un botón **Nuevo** en Backlog.\n=== ARCHIVO: a.ts | create ===\nexport {};\n=== FIN ARCHIVO ===\n=== PRUEBA MANUAL ===\n1. Abre Backlog. Esperado: botón Nuevo.\n2. Pulsa Nuevo. Esperado: se abre el diálogo.\n=== VERIFICAR: typecheck ===\n=== NOTAS ===\nn');
  assert.equal(p.userFacing, 'Verás un botón **Nuevo** en Backlog.'); assert.deepEqual(p.manualSteps, ['Abre Backlog. Esperado: botón Nuevo.', 'Pulsa Nuevo. Esperado: se abre el diálogo.']); assert.equal(p.changes.length, 1); assert.equal(p.notes, 'n');
  const base: any = { id: 'p', kind: 'story_execution', status: 'done', steps: [], spentUsd: 0, budgetUsd: 1, error: null, delegation: null };
  const mt = { steps: ['a', 'b'], checks: [true, false], note: null };
  assert.match(describeProcess({ ...base, result: { changes: [{ path: 'a' }], applied: { branch: 'b' }, merged: { into: 'main' }, published: null, review: null, verifyCommands: [], verifications: [], manualTest: mt } }).phase, /falta probar \(1 de 2/);
  // M2: publicar ya no es requisito para cerrar; una historia probada está lista para cerrar aunque no se haya publicado
  assert.match(describeProcess({ ...base, result: { changes: [{ path: 'a' }], applied: { branch: 'b' }, merged: { into: 'main' }, published: null, review: null, verifyCommands: [], verifications: [], manualTest: { ...mt, checks: [true, true] } } }).phase, /Listo para cerrar/);
  assert.match(describeProcess({ ...base, result: { changes: [{ path: 'a' }], applied: { branch: 'b' }, merged: { into: 'main' }, published: { remote: 'origin', branches: [] }, review: null, verifyCommands: [], verifications: [], manualTest: { ...mt, checks: [true, true] } } }).phase, /Listo para cerrar.*publicado/);
  // Antes de integrar: sin verificación → falta verificar; con typecheck fallido → FALLÓ; con typecheck ok → falta integrar
  const applied = { branch: 'b', commit: 'c', files: ['a'], appliedAt: new Date().toISOString() };
  assert.match(describeProcess({ ...base, result: { changes: [{ path: 'a' }], applied, merged: null, published: null, review: null, verifyCommands: [], verifications: [] } }).phase, /falta verificar \(typecheck\)/);
  const v = (command: string, exitCode: number) => ({ command, exitCode, output: '', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1 });
  assert.match(describeProcess({ ...base, result: { changes: [{ path: 'a' }], applied, merged: null, published: null, review: null, verifyCommands: [], verifications: [v('typecheck', 2)] } }).phase, /verificación FALLÓ \(typecheck\)/);
  assert.match(describeProcess({ ...base, result: { changes: [{ path: 'a' }], applied, merged: null, published: null, review: null, verifyCommands: [], verifications: [v('typecheck', 0)] } }).phase, /falta integrar/);
  assert.match(describeProcess({ ...base, result: { changes: [{ path: 'a' }], applied, merged: null, published: null, review: null, verifyCommands: [], verifications: [v('typecheck', 0)] } }, { isPortalRepo: true }).phase, /falta verificar \(test, build\)/);
  // Portal (M2): integrada pero no activada → activada sin comprobar → comprobación fallida → verificada → probada → cerrar
  const merged = { into: 'main', commit: 'abc1234', mergedAt: new Date().toISOString() };
  const inactive = { active: false, runningCommit: 'old', buildCommit: null, buildAt: null, reason: 'El servidor arrancó con old.' };
  const active = { ...inactive, active: true, runningCommit: 'new1234', reason: 'ok' };
  const rc = (status: 'ok' | 'fail' | 'skipped') => ({ checks: [{ kind: 'http', path: '/api/health', expect: 'ok' }], results: [{ check: { kind: 'http', path: '/api/health', expect: 'ok' }, status, detail: '', at: 't' }], ranAt: 't' });
  const portal = (extra: any) => describeProcess({ ...base, result: { changes: [{ path: 'a' }], applied, merged, published: null, review: null, verifyCommands: [], verifications: [], manualTest: { ...mt, checks: [true, true] }, ...extra } }, { isPortalRepo: true });
  assert.match(portal({ activation: inactive }).phase, /Paso 5 de 8 .* NO activada/);
  assert.match(portal({ activation: active }).phase, /Paso 6 de 8 · Activada \(new1234\) · falta comprobar/);
  assert.match(portal({ activation: active, runtimeChecks: rc('fail') }).phase, /comprobación en ejecución FALLÓ/);
  assert.match(portal({ activation: active, runtimeChecks: rc('skipped') }).phase, /interfaz pendiente/);
  assert.match(portal({ activation: active, runtimeChecks: rc('ok'), manualTest: mt }).phase, /Paso 7 de 8 · Verificada en ejecución · falta probar \(1 de 2/);
  assert.match(portal({ activation: active, runtimeChecks: rc('ok') }).phase, /Paso 8 de 8 · Listo para cerrar \(activada y probada\)/);
  assert.match(describeProcess({ ...base, result: { changes: [{ path: 'a' }], applied: null, merged: null, published: null, review: { approve: false, issues: ['x', 'y'], summary: 's', suggestedTests: [] }, verifyCommands: [], verifications: [] } }).phase, /QA NO aprueba \(2/);
  // EOL: archivo CRLF, contenido nuevo LF → diff limpio y escritura en CRLF; cambios solo-EOL detectados y normalizados
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-eol-'));
  fs.writeFileSync(path.join(dir, 'w.ts'), 'a\r\nb\r\n'); execSync('git init -q -b main && git -c core.autocrlf=false add -A && git -c user.email=t@t -c user.name=t commit -qm i', { cwd: dir });
  const ann = annotateChanges(dir, [{ path: 'w.ts', action: 'modify', content: 'a\nb\nc\n' }]);
  assert.equal(ann[0].before, 3); assert.ok(!(ann[0].diff ?? '').includes('-a'), 'las líneas iguales no aparecen como cambiadas por el CRLF');
  const ap = await applyChanges(dir, 'portal-ia/hu-eol', ann, 'eol', { processId: 'proc-eol' }); assert.equal(fs.readFileSync(path.join(ap.worktree!, 'w.ts'), 'utf8'), 'a\r\nb\r\nc\r\n');
  fs.writeFileSync(path.join(dir, 'w.ts'), 'a\nb\n');
  let st = await repoStatus(dir); assert.equal(st.dirty, true); assert.equal(st.eolOnly, true);
  const n = await normalizeEol(dir); assert.ok(n.commit); st = await repoStatus(dir); assert.equal(st.dirty, false);
});

test('v0.11.1: lista de prueba a mano para historias antiguas, estimación de generarla y cierre bloqueado sin prueba', async () => {
  const { processesRepo, projectsRepo, backlogRepo } = await import('../src/db/workspace.ts');
  const { addManualItem } = await import('../src/services/backlog.ts');
  const { estimateManualTest } = await import('../src/services/storyExecution.ts');
  const internal = projectsRepo('portal-ia').list()[0];
  const it = addManualItem('portal-ia', internal.id, { title: 'Historia antigua sin prueba' });
  const procs = processesRepo('portal-ia');
  const proc = procs.create({ projectId: internal.id, kind: 'story_execution', title: 'HU-old', estimatedUsd: 1, backlogItemId: it.id, steps: [{ agentId: 'a', agentName: 'A', title: 'Plan', model: 'm' }, { agentId: 'b', agentName: 'B', title: 'Impl', model: 'm' }] });
  procs.authorize(proc.id, 1);
  procs.setResult(proc.id, { plan: null, implementationSummary: 'x', changes: [{ path: 'a.ts', action: 'create', content: 'x', diff: '+x', before: 0, after: 1 }], verifyCommands: [], review: null, applied: { branch: 'b', commit: 'c', files: ['a.ts'], appliedAt: 't' }, merged: { into: 'main', commit: 'd', mergedAt: 't' }, published: { remote: 'origin', url: null, branches: ['main'], pushedAt: 't' }, verifications: [] });
  procs.finish(proc.id, 'done'); backlogRepo('portal-ia').setStatus(it.id, 'review', proc.id);
  const est = estimateManualTest('portal-ia', proc.id); assert.ok(est.estimatedUsd > 0); assert.match(est.agentName, /QA|Coordinador/);
  const app = await buildApp();
  const r1 = await app.inject({ method: 'POST', url: `/api/workspaces/portal-ia/backlog/${it.id}/done`, payload: {} });
  assert.equal(r1.statusCode, 409); assert.equal(r1.json().code, 'no_test');
  const r2 = await app.inject({ method: 'POST', url: `/api/workspaces/portal-ia/processes/${proc.id}/manual-test`, payload: { steps: ['1. Abre el Panel. Esperado: tarjeta.', '2. Pulsa X. Esperado: Y.'] } });
  assert.equal(r2.statusCode, 200); assert.deepEqual(r2.json().result.manualTest.checks, [false, false]); assert.match(r2.json().guidance.phase, /falta probar \(0 de 2/);
  const r3 = await app.inject({ method: 'POST', url: `/api/workspaces/portal-ia/backlog/${it.id}/done`, payload: {} });
  assert.equal(r3.json().code, 'not_tested');
  const r4 = await app.inject({ method: 'POST', url: `/api/workspaces/portal-ia/processes/${proc.id}/manual-test`, payload: { checks: [true, true], note: 'todo ok' } });
  assert.match(r4.json().guidance.phase, /Listo para cerrar/);
  const r5 = await app.inject({ method: 'POST', url: `/api/workspaces/portal-ia/backlog/${it.id}/done`, payload: {} });
  assert.equal(r5.statusCode, 200); assert.equal(r5.json().status, 'done');
  await app.close();
});

test('v0.11.2: el hash de archivo ignora CRLF (no marca como cambiado lo que no cambió) y no se integra sin typecheck', async () => {
  const { fileHash, annotateChanges, checkStaleChanges } = await import('../src/services/repoWrite.ts');
  const { processesRepo, projectsRepo, backlogRepo } = await import('../src/db/workspace.ts');
  const { addManualItem } = await import('../src/services/backlog.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-crlf-'));
  fs.writeFileSync(path.join(dir, 't.ts'), 'a\r\nb\r\n');
  const ann = annotateChanges(dir, [{ path: 't.ts', action: 'patch', content: null, edits: [{ search: 'b', replace: 'c' }] }]);
  assert.equal(ann[0].baseHash, fileHash(dir, 't.ts'), 'misma huella con CRLF en disco');
  assert.equal(checkStaleChanges(dir, ann)[0].error ?? null, null, 'no se bloquea un archivo que no cambió');
  // Integrar sin typecheck → 409 con código claro
  const internal = projectsRepo('portal-ia').list()[0];
  const it = addManualItem('portal-ia', internal.id, { title: 'Sin verificar' });
  const procs = processesRepo('portal-ia');
  const proc = procs.create({ projectId: internal.id, kind: 'story_execution', title: 'HU-nv', estimatedUsd: 1, backlogItemId: it.id, steps: [] });
  procs.authorize(proc.id, 1);
  procs.setResult(proc.id, { plan: null, implementationSummary: 'x', changes: [], verifyCommands: [], review: null, applied: { branch: 'b', commit: 'c', files: [], appliedAt: new Date().toISOString() }, merged: null, published: null, verifications: [] });
  procs.finish(proc.id, 'done'); backlogRepo('portal-ia').setStatus(it.id, 'review', proc.id);
  const app = await buildApp();
  const r1 = await app.inject({ method: 'POST', url: `/api/workspaces/portal-ia/processes/${proc.id}/merge`, payload: { authorized: true } });
  assert.equal(r1.statusCode, 409); assert.equal(r1.json().code, 'verification_required');
  procs.setResult(proc.id, { ...procs.get(proc.id)!.result!, verifications: [{ command: 'typecheck', exitCode: 1, output: 'error TS', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1 }] });
  const r2 = await app.inject({ method: 'POST', url: `/api/workspaces/portal-ia/processes/${proc.id}/merge`, payload: { authorized: true } });
  assert.equal(r2.json().code, 'verification_failed');
  await app.close();
});
