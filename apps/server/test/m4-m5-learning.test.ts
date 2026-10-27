import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/** M4 · aprendizaje validado y M5 · plantillas versionadas, con proveedor simulado (0 USD). */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-m45-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_SANDBOX = 'none';
process.env.PORTAL_MOCK_PROVIDER = '1';
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json');
const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, processesRepo, projectsRepo, backlogRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('../src/app.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { createStoryProcess, runStory } = await import('../src/services/storyExecution.ts');
const { detectInProcess, lessonsRepo, lessonsFor, recordDetections } = await import('../src/services/lessons.ts');
const { templatesRepo, effectiveVersion, practicesFor } = await import('../src/services/agentTemplates.ts');
const { createAgent } = await import('../src/services/agentFactory.ts');
const adapters = await import('@portal-ia/ai-adapters');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const internal = projectsRepo('portal-ia').list()[0];
const L1 = 'Copia el fragmento BUSCAR literalmente desde el archivo recibido; si el archivo fue recortado, no lo parchees: crea un módulo nuevo.';

const BACKLOG_TSX = `export function Backlog() {\n  return <div>\n    <h1>Plan del proyecto y solicitudes</h1>\n    <form><input name="titulo" /></form>\n  </div>;\n}\n`;
function repoF() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-m45-repo-'));
  fs.mkdirSync(path.join(dir, 'apps/web/src/screens'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'apps/web/src/screens/Backlog.tsx'), BACKLOG_TSX); fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: dir });
  return dir;
}
const PLAN = '{"summary":"Añadir campo nota","tasks":["Editar Backlog.tsx"],"filesToRead":["apps/web/src/screens/Backlog.tsx"],"filesToChange":["apps/web/src/screens/Backlog.tsx"],"acceptance":["campo nota visible"],"risks":[]}';
const BAD_PATCH = '=== RESUMEN ===\nAñade nota.\n=== ARCHIVO: apps/web/src/screens/Backlog.tsx | patch ===\n<<<< BUSCAR\n<form><input name="title" /></form>\n==== REEMPLAZAR\n<form><input name="titulo" /><textarea name="nota" /></form>\n>>>> FIN\n=== FIN ARCHIVO ===\n=== ARCHIVO: apps/web/src/components/NotaField.tsx | create ===\nexport const NotaField = () => null;\n=== FIN ARCHIVO ===\n=== PARA EL PROPIETARIO ===\nVerás un campo nota.\n=== PRUEBA MANUAL ===\n1. Abre Backlog. Esperado: campo nota.\n2. Escribe. Esperado: se guarda.\n3. Recarga. Esperado: persiste.\n=== VERIFICAR: typecheck ===';
const GOOD_PATCH = BAD_PATCH.replace('<<<< BUSCAR\n<form><input name="title" /></form>', '<<<< BUSCAR\n<form><input name="titulo" /></form>').replace('=== ARCHIVO: apps/web/src/components/NotaField.tsx | create ===\nexport const NotaField = () => null;\n=== FIN ARCHIVO ===\n', '');
const QA_NO = '{"approve": false, "summary": "El parche no encaja", "issues": ["BUSCAR no coincide"], "suggestedTests": []}';
const QA_OK = '{"approve": true, "summary": "Bien", "issues": [], "suggestedTests": []}';
function script(rules: any[], markers: string[] = []) { fs.writeFileSync(scriptPath, JSON.stringify({ markers, rules })); fs.writeFileSync(logPath, ''); }
async function runF(title: string) {
  const it = addManualItem('portal-ia', internal.id, { title, criterion: 'campo nota' });
  const proc = createStoryProcess('portal-ia', internal.id, it.id);
  processesRepo('portal-ia').authorize(proc.id, 1);
  await runStory('portal-ia', proc.id, () => undefined, () => false);
  return processesRepo('portal-ia').get(proc.id)!;
}
const mockLog = () => fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

test('B1 · detección objetiva sin IA: parche que no encaja, módulo sin importar, QA no aprueba, verificación/activación/ejecución fallidas, historia devuelta; cada hecho → una lección con evidencia', async () => {
  const dir = repoF(); projectsRepo('portal-ia').setRepository(internal.id, dir, 'main');
  script([{ match: 'plan técnico', text: PLAN }, { match: 'Implementa la historia', text: BAD_PATCH }, { match: 'Revisa los cambios propuestos', text: QA_NO }]);
  adapters.resetMockCalls();
  const p = await runF('Añadir campo nota al formulario de nueva solicitud');
  assert.equal(p.status, 'done', p.error ?? '');
  const callsAfterRun = adapters.mockCalls;
  const ls = lessonsRepo('portal-ia').list(internal.id);
  const det = (d: string) => ls.filter(l => l.detector === d && l.evidence.processId === p.id);
  assert.equal(det('patch_mismatch').length, 1, 'parche que no encaja'); assert.equal(det('patch_mismatch')[0].evidence.file, 'apps/web/src/screens/Backlog.tsx'); assert.equal(det('patch_mismatch')[0].evidence.agentName, 'Desarrollador Full Stack'); assert.equal(det('patch_mismatch')[0].role, 'implementer');
  assert.equal(det('unused_module').length, 1, 'módulo nuevo sin importar');
  assert.equal(det('qa_rejected').length, 1);
  assert.ok(ls.every(l => l.status === 'detected'));
  // Idempotente: volver a detectar no duplica
  assert.equal(recordDetections('portal-ia', p.id, dir).length, 0);
  // Verificación fallida, ejecución fallida, activación fallida, devuelta a pendiente (sobre un resultado sintético)
  const procs = processesRepo('portal-ia');
  procs.setResult(p.id, { ...p.result!, verifications: [{ command: 'typecheck', exitCode: 2, output: 'error TS2304', startedAt: 't', finishedAt: 't', durationMs: 1, isolation: 'host-min' }], runtimeChecks: { checks: [{ kind: 'http', path: '/x', expect: 'y' }], results: [{ check: { kind: 'http', path: '/x', expect: 'y' }, status: 'fail', detail: 'HTTP 404', at: 't' }], ranAt: 't' } });
  const more = recordDetections('portal-ia', p.id, dir, { resetReason: 'no era lo pedido', updateFailedLog: 'npm run build terminó con código 1' });
  assert.deepEqual(more.map(l => l.detector).sort(), ['activation_failed', 'runtime_failed', 'story_reset', 'verification_failed']);
  assert.equal(more.find(l => l.detector === 'story_reset')!.role, 'planner');
  // Una lección que no está validada NUNCA se inyecta
  assert.equal(lessonsFor('portal-ia', { projectId: internal.id, role: 'implementer' }).length, 0);
  assert.equal(adapters.mockCalls, callsAfterRun, 'la detección no llama a la IA');
  // Sin falsos positivos: un módulo nuevo que ya se menciona en otro archivo del repositorio (fuera del diff) no es «sin importar»
  fs.mkdirSync(path.join(dir, 'apps/web/src/lib'), { recursive: true }); fs.writeFileSync(path.join(dir, 'apps/web/src/lib/usa.ts'), "import { Ayuda } from '../components/Ayuda.tsx';\nexport const x = Ayuda;\n");
  execSync('git add -A && git -c user.email=t@t -c user.name=t commit -qm usa', { cwd: dir });
  const fake: any = { ...p, id: 'proc-fp', result: { ...p.result!, review: null, verifications: [], runtimeChecks: null, changes: [{ path: 'apps/web/src/components/Ayuda.tsx', action: 'create', content: 'export const Ayuda = 1;', diff: '+', before: 0, after: 1 }] } };
  assert.deepEqual(detectInProcess('portal-ia', fake, dir).map(d => d.detector), [], 'referenciado en el repositorio: no se detecta');
  assert.deepEqual(detectInProcess('portal-ia', { ...fake, result: { ...fake.result, changes: [{ ...fake.result.changes[0], path: 'apps/web/src/components/Huerfano.tsx' }] } }, dir).map(d => d.detector), ['unused_module'], 'sin referencias: sí');
  // Detección pura sobre un proceso de otro tipo → nada
  assert.deepEqual(detectInProcess('portal-ia', { ...p, kind: 'delegated_task' } as any, dir), []);
});

test('B2 · ciclo de validación: proponer solo con autorización (1 llamada), validar, editar crea versión 2 y conserva la 1, rechazar/obsoleta no se inyectan', async () => {
  const app = await buildApp();
  const l = lessonsRepo('portal-ia').list(internal.id).find(x => x.detector === 'patch_mismatch')!;
  script([{ match: 'Error detectado', text: `{"rootCause":"El Desarrollador citó un fragmento que no existía.","correctiveAction":"Copiar literalmente.","lessonText":"${L1}","role":"implementer","tags":["patch"]}` }]);
  adapters.resetMockCalls();
  const noAuth = await app.inject({ method: 'POST', url: `/api/workspaces/portal-ia/lessons/${l.id}/propose`, payload: {} });
  assert.equal(noAuth.statusCode, 403); assert.equal(adapters.mockCalls, 0, 'sin autorización: 0 llamadas');
  const est = await app.inject({ method: 'GET', url: `/api/workspaces/portal-ia/lessons/${l.id}/propose/estimate` }); assert.ok(est.json().estimatedUsd > 0);
  const prop = await app.inject({ method: 'POST', url: `/api/workspaces/portal-ia/lessons/${l.id}/propose`, payload: { authorized: true } });
  assert.equal(prop.statusCode, 200, prop.body); assert.equal(adapters.mockCalls, 1); assert.equal(prop.json().status, 'proposed'); assert.equal(prop.json().lessonText, L1); assert.equal(prop.json().source, 'ai');
  assert.equal(lessonsFor('portal-ia', { projectId: internal.id, role: 'implementer' }).length, 0, 'propuesta: no se inyecta');
  const val = await app.inject({ method: 'POST', url: `/api/workspaces/portal-ia/lessons/${l.id}/validate`, payload: {} });
  assert.equal(val.statusCode, 200, val.body); assert.equal(val.json().status, 'validated'); assert.ok(val.json().validatedAt);
  assert.equal(lessonsFor('portal-ia', { projectId: internal.id, role: 'implementer' }).length, 1);
  assert.equal(lessonsFor('portal-ia', { projectId: internal.id, role: 'planner' }).length, 0, 'por papel');
  // Editar una validada → versión 2, la 1 queda obsoleta y enlazada
  const v2 = await app.inject({ method: 'POST', url: `/api/workspaces/portal-ia/lessons/${l.id}/validate`, payload: { lessonText: L1 + ' Indica en NOTAS qué archivo pediste completo.' } });
  assert.equal(v2.json().version, 2); assert.equal(v2.json().parentId, l.id); assert.equal(lessonsRepo('portal-ia').get(l.id)!.status, 'obsolete');
  assert.equal(lessonsFor('portal-ia', { projectId: internal.id, role: 'implementer' })[0].version, 2);
  // Ámbito: la lección del proyecto A no llega al proyecto B; una de espacio llega a todos
  const { createProject } = await import('../src/services/companies.ts');
  const other = createProject('portal-ia', 'Proyecto B', 'x', []);
  assert.equal(lessonsFor('portal-ia', { projectId: other.id, role: 'implementer' }).length, 0);
  const ws = await app.inject({ method: 'POST', url: `/api/workspaces/portal-ia/lessons`, payload: { projectId: null, title: 'Global', lessonText: 'Nunca borres archivos que no estén en el plan.', role: null } });
  assert.equal(ws.statusCode, 201); assert.equal(ws.json().status, 'validated'); assert.equal(ws.json().source, 'owner');
  assert.equal(lessonsFor('portal-ia', { projectId: other.id, role: 'implementer' }).length, 1);
  // Rechazar y obsoleta → fuera
  const rej = await app.inject({ method: 'POST', url: `/api/workspaces/portal-ia/lessons/${ws.json().id}/reject` }); assert.equal(rej.json().status, 'rejected');
  assert.equal(lessonsFor('portal-ia', { projectId: other.id, role: 'implementer' }).length, 0);
  await app.close();
});

test('B3/B4 · inyección y mejora medible: con L1 inyectada el parche encaja (el simulado responde bien SOLO si el prompt contiene L1); lessons_used registra; reincidencia marca candidata a obsoleta', async () => {
  const dir = repoF(); projectsRepo('portal-ia').setRepository(internal.id, dir, 'main');
  // El implementador acierta solo si recibe L1 (versión 2: contiene el texto de L1 como prefijo)
  script([{ match: 'plan técnico', text: PLAN }, { match: 'Implementa la historia', requires: 'Copia el fragmento BUSCAR literalmente', text: GOOD_PATCH, otherwise: BAD_PATCH }, { match: 'Revisa los cambios propuestos', text: QA_OK }], ['Lecciones de esta organización (obligatorias)', 'Copia el fragmento BUSCAR literalmente']);
  const p2 = await runF('Añadir campo nota al formulario de nueva solicitud (2)');
  assert.equal(p2.status, 'done', p2.error ?? '');
  const impl = p2.steps.find(s => s.role === 'implementer')!;
  const active = lessonsFor('portal-ia', { projectId: internal.id, role: 'implementer' })[0];
  assert.deepEqual(impl.lessonsUsed, [active.id], 'lessons_used registra la lección inyectada');
  assert.ok(mockLog().find(l => l.rule === 'Implementa la historia')!.markers.includes('Lecciones de esta organización (obligatorias)'));
  assert.equal(p2.result!.changes.filter(c => c.error).length, 0, 'patch_fail_rate = 0 con la lección (sin ella fue 1 en B1)');
  assert.equal(lessonsRepo('portal-ia').get(active.id)!.usedCount, 1);
  assert.equal(p2.steps.find(s => s.role === 'planner')!.lessonsUsed!.length, 0, 'la lección de implementador no llega al planificador');
  // Reincidencia: forzamos que el implementador falle aunque tenga L1 → el detector salta y L1 suma reincidencia
  script([{ match: 'plan técnico', text: PLAN }, { match: 'Implementa la historia', text: BAD_PATCH }, { match: 'Revisa los cambios propuestos', text: QA_OK }]);
  const p3 = await runF('Añadir campo nota al formulario de nueva solicitud (3)');
  assert.equal(p3.status, 'done');
  assert.equal(lessonsRepo('portal-ia').get(active.id)!.recurrenceCount, 1, 'reincidencia contada: candidata a obsoleta');
});

test('C1/C2 · plantillas versionadas: promover L1 crea pj-dev@2 con diff; los agentes nuevos heredan; los existentes siguen en v1 hasta opt-in (con diff y vuelta atrás); el prompt incluye la práctica', async () => {
  const app = await buildApp();
  const active = lessonsFor('portal-ia', { projectId: internal.id, role: 'implementer' })[0];
  const dev = agentsRepo('portal-ia').list().find(a => a.key === 'pj-dev' && a.projectId === internal.id)!;
  assert.equal(templatesRepo('portal-ia').latest('pj-dev')!.version, 1);
  const pr = await app.inject({ method: 'POST', url: `/api/workspaces/portal-ia/lessons/${active.id}/promote`, payload: { authorized: true } });
  assert.equal(pr.statusCode, 201, pr.body); assert.equal(pr.json().id, 'pj-dev@2'); assert.match(pr.json().diffMd, /\+ Copia el fragmento BUSCAR/); assert.equal(pr.json().practices.length, 1);
  assert.equal(lessonsRepo('portal-ia').get(active.id)!.promotedTo, 'pj-dev@2');
  // El Desarrollador existente NO cambia
  assert.equal(agentsRepo('portal-ia').get(dev.id)!.templateVersion ?? null, null); assert.equal(effectiveVersion('portal-ia', dev)!.id, 'pj-dev@1'); assert.equal(practicesFor('portal-ia', agentsRepo('portal-ia').get(dev.id)!).length, 0);
  // Un proyecto nuevo → Desarrollador nuevo con pj-dev@2
  const { createProject } = await import('../src/services/companies.ts');
  const np = createProject('portal-ia', 'Proyecto C', 'x', []);
  const newDev = agentsRepo('portal-ia').list().find(a => a.key === 'pj-dev' && a.projectId === np.id)!;
  assert.equal(newDev.templateVersion, 'pj-dev@2'); assert.equal(practicesFor('portal-ia', newDev)[0].text, active.lessonText);
  // Un agente personalizado con capacidad implementar hereda las prácticas del papel
  const custom = createAgent('portal-ia', { scope: 'project', projectId: np.id, name: 'Dev Móvil', role: 'Desarrollo móvil', reportsTo: 'pj-coordinador', collaborates: [], evaluation: ['x'], config: { name: 'Dev Móvil', specialization: 'x', responsibilities: ['y'], provider: 'anthropic', model: 'claude-sonnet-4-5', fallbacks: [], effort: 'low', tools: { read_repo: true, write_repo: true }, knowledge: {}, monthlyLimitUsd: 1, perTaskAuthUsd: 1, capabilities: ['implementar'] } });
  assert.equal(custom.templateVersion, 'pj-dev@2'); assert.equal(practicesFor('portal-ia', custom).length, 1);
  // Opt-in del existente: diff, actualizar, historial, volver atrás
  const info = await app.inject({ method: 'GET', url: `/api/workspaces/portal-ia/agents/${dev.id}/template` });
  assert.equal(info.json().current.id, 'pj-dev@1'); assert.equal(info.json().latest.id, 'pj-dev@2'); assert.deepEqual(info.json().diff.added, [active.lessonText]);
  const up = await app.inject({ method: 'POST', url: `/api/workspaces/portal-ia/agents/${dev.id}/template-version`, payload: { authorized: true, version: 'pj-dev@2' } });
  assert.equal(up.statusCode, 200, up.body); assert.equal(up.json().templateVersion, 'pj-dev@2');
  assert.equal(practicesFor('portal-ia', agentsRepo('portal-ia').get(dev.id)!).length, 1);
  const hist = templatesRepo('portal-ia').history(dev.id); assert.equal(hist.length, 1); assert.equal(hist[0].toVersion, 'pj-dev@2'); assert.equal(hist[0].by, 'owner');
  const back = await app.inject({ method: 'POST', url: `/api/workspaces/portal-ia/agents/${dev.id}/template-version`, payload: { authorized: true, version: 'pj-dev@1' } });
  assert.equal(back.json().templateVersion, 'pj-dev@1'); assert.equal(practicesFor('portal-ia', agentsRepo('portal-ia').get(dev.id)!).length, 0);
  assert.equal(templatesRepo('portal-ia').history(dev.id).length, 2);
  // Versión de otra plantilla → rechazada
  const bad = await app.inject({ method: 'POST', url: `/api/workspaces/portal-ia/agents/${dev.id}/template-version`, payload: { authorized: true, version: 'pj-qa@1' } }); assert.equal(bad.statusCode, 409);
  // C2 · ejecución con pj-dev@2: el prompt lleva la práctica aunque la lección no se inyecte por recuperación (la obsoletamos)
  await app.inject({ method: 'POST', url: `/api/workspaces/portal-ia/agents/${dev.id}/template-version`, payload: { authorized: true, version: 'pj-dev@2' } });
  await app.inject({ method: 'POST', url: `/api/workspaces/portal-ia/lessons/${active.id}/obsolete` });
  assert.equal(lessonsFor('portal-ia', { projectId: internal.id, role: 'implementer' }).length, 0);
  const dir = repoF(); projectsRepo('portal-ia').setRepository(internal.id, dir, 'main');
  script([{ match: 'plan técnico', text: PLAN }, { match: 'Implementa la historia', requires: 'Copia el fragmento BUSCAR literalmente', text: GOOD_PATCH, otherwise: BAD_PATCH }, { match: 'Revisa los cambios propuestos', text: QA_OK }], ['Prácticas de la organización (plantilla)']);
  const p4 = await runF('Añadir campo nota (4, con práctica de plantilla)');
  assert.equal(p4.status, 'done', p4.error ?? '');
  const impl = p4.steps.find(s => s.role === 'implementer')!;
  assert.deepEqual(impl.lessonsUsed, [`practice:pj-dev@2:${active.id}`]);
  assert.ok(mockLog().find(l => l.rule === 'Implementa la historia')!.markers.includes('Prácticas de la organización (plantilla)'));
  assert.equal(p4.result!.changes.filter(c => c.error).length, 0, 'la práctica heredada evita el fallo');
  await app.close();
});
