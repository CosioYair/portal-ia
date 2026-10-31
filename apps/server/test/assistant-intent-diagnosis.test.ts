import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Diagnóstico Gauntlet del Asistente (fallos C, D y F de la primera prueba real del propietario). Proveedor SIMULADO
 * (0 USD), datos sintéticos, remoto git local (bare). Se captura la instrucción del sistema y el prompt reales que el
 * servidor envía al modelo y se fija lo que el servidor hace con cada bloque de acciones. Cada prueba acumula todos los
 * problemas encontrados y los muestra juntos (criterios Q6, Q7, Q8 y Q10 de docs/autonomia-suscripcion-y-persistencia.md).
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-intent-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json');
process.env.PORTAL_MOCK_SCRIPT = scriptPath;

const { encryptSecret } = await import('../src/security/crypto.ts');
const { classifyModel } = await import('@portal-ia/domain');
const { mockAdapter, resetMockCalls } = await import('@portal-ia/ai-adapters');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { backlogRepo, processesRepo, projectsRepo } = await import('../src/db/workspace.ts');
const { assignmentsRepo } = await import('../src/db/assignments.ts');
const { addManualItem } = await import('../src/services/backlog.ts');
const { createProject } = await import('../src/services/companies.ts');
const { buildApp } = await import('../src/app.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const portal = projectsRepo(S).list()[0]; // «Desarrollo del Portal»

// Segundo proyecto en el espacio interno (situación real: más de un proyecto), con repositorio y remoto «bare» local.
const site = createProject(S, 'Sitio público', 'Web pública');
const git = (cwd: string, cmd: string) => execSync(`git ${cmd}`, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-intent-remote-')); git(remote, 'init -q --bare -b main');
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-intent-repo-'));
fs.writeFileSync(path.join(repo, 'a.txt'), '1\n'); git(repo, 'init -q -b main'); git(repo, 'add -A'); git(repo, 'commit -qm Base');
git(repo, `remote add origin "${remote}"`); git(repo, 'push -q -u origin main');
fs.writeFileSync(path.join(repo, 'a.txt'), '2\n'); git(repo, 'commit -qam "Cambio 2"');
projectsRepo(S).setRepository(site.id, repo, 'main');
const remoteHead = () => git(remote, 'rev-parse main');

const app = await buildApp();
after(async () => { await app.close(); });
const inject = async (method: string, u: string, payload?: unknown) => { const r = await app.inject({ method: method as any, url: u, payload: payload as any }); return { status: r.statusCode, body: r.body ? r.json() : null }; };

// Captura de lo que el servidor envía realmente al modelo (sin red: proveedor simulado).
const seen: { system: string; user: string }[] = [];
const original = mockAdapter.complete.bind(mockAdapter);
(mockAdapter as any).complete = async (k: string, o: any, req: any, s?: AbortSignal) => { seen.push({ system: String(req.system ?? ''), user: String(req.user ?? '') }); return original(k, o, req, s); };
const chatPrompts = () => seen.filter(p => p.system.startsWith('Eres «Asistente de Empresa'));

const OWNER = 'La ejecución en paralelo se detuvo por una decisión que supuestamente debía tomar. Quiero que la ejecución continua siga cuando no hace falta aprobación. Si autoricé 1000 llamadas a la suscripción, no debe pararse por un presupuesto ficticio en USD. Es un encargo directo para ti. Arréglalo, aplica Gauntlet y publica main cuando termines.';
const block = (reply: string, actions: unknown[]) => `${reply}\n\`\`\`actions\n${JSON.stringify(actions)}\n\`\`\``;
const SYNTH = 'Diagnóstico: la pausa viene de la regla de presupuesto en USD.\n```backlog\n[{"op":"add","title":"Ejecución continua sin pausas por presupuesto ficticio","criterion":"El lote sigue cuando no hace falta aprobación","description":"Pedido por el propietario","estimate":"M","dependsOn":null,"reason":"pedido"}]\n```';
function script(chat: string) {
  resetMockCalls();
  fs.writeFileSync(scriptPath, JSON.stringify({ rules: [
    { match: '"accepted": boolean', text: JSON.stringify({ accepted: true, understanding: 'Analizo por qué se detiene la ejecución continua.', plan: ['Analizar'], consults: [] }) },
    { match: 'Usa solo ids de historias que existen', text: SYNTH },
    { match: '^Eres «Asistente de Empresa', text: chat }
  ] }));
}
const scoped = async (projectId: string | null, title = 'Diagnóstico') => (await inject('POST', '/api/assistant/conversations', { title, workspaceSlug: projectId ? S : null, projectId })).body.id as string;
const say = async (conversationId: string, text = OWNER) => { const r = await inject('POST', '/api/assistant/messages', { text, conversationId }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.assistant; };
const messages = async (C: string) => (await inject('GET', `/api/assistant/conversations/${C}`)).body;
const noProblems = (problems: string[]) => assert.deepEqual(problems, [], `\n${problems.map(p => `  · ${p}`).join('\n')}`);
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms; let v = await fn();
  while (!ok(v)) { if (Date.now() > end) throw new Error(`tiempo agotado esperando: ${what}`); await new Promise(r => setTimeout(r, 50)); v = await fn(); }
  return v;
}

let ownerSystem = '';
test('Q6 · contrato: una orden directa («arréglalo») va a propose_assignment; ninguna regla la manda a una historia', async () => {
  script('Entendido.');
  const C = await scoped(portal.id);
  await say(C);
  ownerSystem = chatPrompts().at(-1)!.system;
  const problems: string[] = [];
  if (!/"type":"propose_assignment"/.test(ownerSystem)) problems.push('la instrucción no incluye propose_assignment');
  if (/implementar\/corregir\/añadir una funcionalidad concreta en el código → add_backlog_item/.test(ownerSystem)) problems.push('ACTION_SCHEMA («Cómo elegir») manda «implementar/corregir/añadir … en el código → add_backlog_item (+ execute_story)»: contradice a CONVERSATION_GUIDE («arregla» → propose_assignment)');
  if (/cualquier mejora del Portal[^\n]*se consigue añadiendo la historia y ejecutándola/.test(ownerSystem)) problems.push('la presentación del Portal dice «cualquier mejora del Portal … se consigue añadiendo la historia y ejecutándola»');
  if (/Si pide algo que no está en ninguna lista, dilo y propón convertirlo en historia/.test(ownerSystem)) problems.push('lo que «no está en ninguna lista» se convierte en historia (no en encargo EN-n)');
  if (!/NO la propongas ahora[^\n]*integrado en main/.test(ownerSystem)) problems.push('el contrato no dice que «publícalo cuando termines» espera a que el EN esté integrado (sin tarjeta inmediata)');
  noProblems(problems);
});

test('Q6 · «encargo» designa solo el encargo de desarrollo EN-n: el análisis delegado (delegate_task) no se presenta como «ENCARGO»', async () => {
  const problems: string[] = [];
  if (/"type":"delegate_task"[^\n]*→ ENCARGO/.test(ownerSystem)) problems.push('el contrato define delegate_task como «ENCARGO» (análisis con documento): el propietario dice «es un encargo directo» y el modelo tiene dos acciones llamadas encargo');
  noProblems(problems);
});

let triageSystem = '';
test('Q8 · un análisis delegado terminado no se presenta como encargo entregado/aplicado ni como cambio de código (tarjeta, historial y estado real)', async () => {
  script(block('Se lo encargo al Coordinador del Proyecto.', [{ type: 'delegate_task', company: S, project: portal.slug, agent: 'pj-coordinador', request: OWNER }]));
  const C = await scoped(portal.id, 'Análisis');
  const a = await say(C);
  const act = a.actions.find((x: any) => x.type === 'propose_delegation');
  assert.ok(act?.processId, JSON.stringify(a.actions));
  // El propietario autoriza en la tarjeta (lo que hace la web: autorizar el proceso y marcar la propuesta resuelta).
  assert.equal((await inject('POST', `${W}/processes/${act.processId}/authorize`, { budgetUsd: 5, authorized: true })).status, 200);
  await inject('POST', `/api/assistant/messages/${a.id}/resolve`, { processId: act.processId, status: 'done', detail: 'En ejecución con presupuesto 5 USD.' });
  await waitFor(async () => processesRepo(S).get(act.processId)!.status, s => s === 'done', 'análisis terminado');
  triageSystem = seen.find(p => p.user.includes('"accepted": boolean'))?.system ?? '';
  // El propietario aplica las propuestas al backlog (su clic explícito).
  assert.equal((await inject('POST', `${W}/processes/${act.processId}/backlog-ops/apply`, { authorized: true })).status, 200);
  const live = (await messages(C)).messages.flatMap((m: any) => m.actions).find((x: any) => x.processId === act.processId);
  const problems: string[] = [];
  if (/^Encargo\b/.test(live.label)) problems.push(`la tarjeta del análisis se titula «${live.label.slice(0, 60)}…», igual que un encargo de desarrollo EN-n`);
  const text = `${live.live?.phase}. ${live.live?.next}`;
  if (/Encargo entregado/.test(text)) problems.push(`el estado vivo dice «${text}» (verde): se lee como el encargo pedido terminado y aplicado`);
  if (!/c[oó]digo/i.test(text)) problems.push(`el estado vivo «${text}» no dice que no hubo ningún cambio de código`);
  // Lo que el modelo ve en el siguiente mensaje.
  script('Ya está.');
  await say(C, '¿Está terminado lo que te pedí?');
  const p = chatPrompts().at(-1)!;
  if (/propose_delegation:done/.test(p.user)) problems.push('el historial que recibe el modelo dice «[acciones: propose_delegation:done]» (el «done» guardado al AUTORIZAR, no al terminar; sin decir que fue un análisis)');
  if (/\nEncargos: Encargo a /.test(p.system)) problems.push('la instantánea lista el análisis como «Encargos: Encargo a …» (mismo nombre que EN-n)');
  if (/propuestas aplicadas/.test(p.system) && !/c[oó]digo sin cambios|sin cambios de c[oó]digo|no cambi[aó] (el )?c[oó]digo/i.test(p.system)) problems.push('la instantánea dice «propuestas aplicadas» sin aclarar que son cambios al backlog, no al código');
  noProblems(problems);
});

test('Q8 · el estado de un encargo EN-n en el chat es el real (no «done» si espera, está en marcha o falló) y el modelo lo ve', async () => {
  script(block('Te preparo el encargo.', [{ type: 'propose_assignment', title: 'Ejecución continua sin pausas por presupuesto ficticio', request: OWNER, objective: 'Que la ejecución continua siga cuando no hace falta aprobación del propietario.', criteria: ['Con tope de llamadas a la suscripción, el lote no se detiene por un presupuesto en USD de API', 'typecheck, test y build en verde'], outOfScope: [], size: 'M' }]));
  const C = await scoped(portal.id, 'Encargo');
  const a = await say(C);
  const act = a.actions.find((x: any) => x.type === 'propose_assignment');
  assert.equal(act?.status, 'pending', JSON.stringify(a.actions));
  const problems: string[] = [];
  for (const st of ['pending_authorization', 'running', 'needs_owner', 'failed'] as const) {
    assignmentsRepo(S).update(act.assignmentId, x => { x.status = st; });
    const live = (await messages(C)).messages.flatMap((m: any) => m.actions).find((x: any) => x.assignmentId === act.assignmentId);
    if (live.status === 'done') problems.push(`encargo «${st}» → la acción del chat queda status 'done' (listLive)`);
  }
  script('Sigue.');
  await say(C, '¿Cómo va el encargo?');
  const p = chatPrompts().at(-1)!;
  const code = assignmentsRepo(S).get(act.assignmentId)!.code;
  if (!new RegExp(`${code}[^\\n]*fallido`).test(`${p.system}\n${p.user}`)) problems.push(`el modelo no recibe ${code} ni su estado real («fallido»): la instantánea no incluye encargos EN-n y el historial solo dice «propose_assignment:pending»`);
  noProblems(problems);
});

test('Q6 · «implementa» con add_backlog_item + execute_story: nunca se propone ejecutar OTRA historia en su lugar', async () => {
  // Proyecto con repositorio registrado (si no, execute_story falla antes por otra causa).
  const existing = addManualItem(S, site.id, { title: 'Ejecución continua', criterion: 'Lotes', description: 'Historia anterior distinta' });
  const procs0 = processesRepo(S).list(site.id).length;
  const title = 'Ejecución continua sin pausas por presupuesto ficticio';
  script(block('La añado y propongo ejecutarla.', [{ type: 'add_backlog_item', company: S, project: site.slug, title, criterion: 'No se detiene sin motivo', description: OWNER }, { type: 'execute_story', company: S, project: site.slug, story: title }]));
  const a = await say(await scoped(site.id, 'Historia'));
  const problems: string[] = [];
  const exec = a.actions.find((x: any) => x.type === 'propose_execution');
  if (exec?.storyId === existing.storyId) problems.push(`execute_story «${title}» (aún no creada: add_backlog_item queda pendiente de confirmar) se resolvió por inclusión de título a ${existing.storyId} «${existing.title}» (otra historia) y se preparó su ejecución (${exec.status}: «${exec.label}»)`);
  if (processesRepo(S).list(site.id).length !== procs0) problems.push('se creó un proceso de historia pendiente de autorizar para esa otra historia');
  noProblems(problems);
});

test('Q6 · propose_assignment sin alcance: no adivina el proyecto; con proyecto explícito, el encargo queda en la conversación', async () => {
  const C = await scoped(null, 'Sin alcance');
  const before = assignmentsRepo(S).list().length;
  script(block('Encargo preparado.', [{ type: 'propose_assignment', title: 'Ejecución continua', request: OWNER, objective: 'Que la ejecución continua siga cuando no hace falta aprobación.', criteria: ['El lote no se detiene sin motivo'], size: 'M' }]));
  const a = await say(C);
  const act = a.actions.find((x: any) => x.type === 'propose_assignment');
  const problems: string[] = [];
  if (act?.status !== 'failed' || assignmentsRepo(S).list().length !== before) {
    const made = act?.assignmentId ? assignmentsRepo(S).get(act.assignmentId) : null;
    problems.push(`con 2 proyectos y sin referencia, el encargo se creó en «${made ? projectsRepo(S).get(made.projectId)?.name : '?'}» (resolveProject: primer proyecto) sin preguntar`);
  }
  script(block('Encargo preparado.', [{ type: 'propose_assignment', company: S, project: portal.slug, title: 'Ejecución continua explícita', request: OWNER, objective: 'Que la ejecución continua siga cuando no hace falta aprobación.', criteria: ['El lote no se detiene sin motivo'], size: 'M' }]));
  const b = await say(C);
  const id = b.actions.find((x: any) => x.type === 'propose_assignment')?.assignmentId;
  const d = await messages(C);
  if (!d.assignments.some((x: any) => x.id === id)) problems.push('el encargo creado desde una conversación sin alcance no aparece en su panel (conversationDetail exige workspaceSlug)');
  if (d.stage !== 'execution') problems.push(`la etapa sigue «${d.stage}» y «Siguiente: ${d.next}» con un encargo ya creado`);
  noProblems(problems);
});

test('Q7 · «publica main» en una conversación con alcance no prepara la publicación de OTRO proyecto', async () => {
  const C = await scoped(portal.id, 'Publicar');
  const head0 = remoteHead();
  script(block('Preparo la publicación.', [{ type: 'request_operation', capability: 'publish_main', company: S, project: site.slug }]));
  const a = await say(C);
  const op = a.actions.find((x: any) => x.type === 'propose_operation');
  const problems: string[] = [];
  const refused = a.actions.find((x: any) => x.status === 'failed' && /Fuera del alcance/.test(x.detail ?? ''));
  if (!refused) problems.push(`no se rechazó por alcance: ${JSON.stringify(a.actions.map((x: any) => [x.type, x.status, x.detail]))}`);
  if (op && op.status === 'pending') problems.push(`conversación de «${portal.name}»: se preparó «${op.label}» (prepareOperations no recibe el alcance)`);
  assert.equal(remoteHead(), head0, 'nada se publicó');
  noProblems(problems);
});

test('Q7 · guarda (pasa hoy): encargo + «publica main» solo deja tarjetas; nada se ejecuta, publica ni crea historias', async () => {
  const C = await scoped(site.id, 'Encargo y publicar');
  const head0 = remoteHead(); const procs0 = processesRepo(S).list(site.id).length; const bl0 = backlogRepo(S).list(site.id).length;
  script(block('Encargo preparado y publicación lista para autorizar.', [
    { type: 'propose_assignment', title: 'Ejecución continua', request: OWNER, objective: 'Que la ejecución continua siga cuando no hace falta aprobación.', criteria: ['El lote no se detiene sin motivo'], size: 'M' },
    { type: 'request_operation', capability: 'publish_main', company: S, project: site.slug }
  ]));
  const a = await say(C);
  assert.deepEqual(a.actions.map((x: any) => [x.type, x.status]), [['propose_assignment', 'pending'], ['propose_operation', 'pending']]);
  assert.equal(remoteHead(), head0, 'proponer no publica');
  assert.equal(processesRepo(S).list(site.id).length, procs0, 'ningún proceso');
  assert.equal(backlogRepo(S).list(site.id).length, bl0, 'ninguna historia');
  assert.equal(assignmentsRepo(S).get(a.actions[0].assignmentId)!.status, 'draft');
});

test('Q10/F · el Asistente conoce el Portal: descripción compacta y versionada (Gauntlet, revisión del plan, correcciones, diagnóstico, encargos, lotes, suscripción)', async () => {
  const problems: string[] = [];
  // «revisa el plan» (no «REVISIÓN DEL PLAN»: las reglas del proveedor simulado no distinguen mayúsculas y chocarían).
  const want: [RegExp, string][] = [[/Gauntlet/, 'Gauntlet'], [/revis(i[oó]n del|a el) plan/i, 'revisión del plan'], [/correcciones/i, 'correcciones por progreso'], [/diagn[oó]stico/i, 'diagnóstico de brechas repetidas'], [/tope duro/i, 'tope duro'], [/\blotes?\b/i, 'lotes (/lotes)'], [/encargo de desarrollo/i, 'encargos EN-n'], [/suscripci[oó]n/i, 'suscripción']];
  for (const [re, name] of want) if (!re.test(ownerSystem)) problems.push(`la instrucción del sistema no menciona: ${name}`);
  if (!/(capacidades[^\n]{0,80}\bv(ersi[oó]n )?\d+|portal-capabilities@\d+)/i.test(ownerSystem)) problems.push('no hay una descripción de capacidades con versión');
  noProblems(problems);
});

test('Q10 · la descripción de capacidades es una sola, versionada y acotada (no crece sin límite)', async () => {
  const { PORTAL_CAPABILITIES, PORTAL_CAPABILITIES_VERSION } = await import('@portal-ia/domain');
  assert.match(PORTAL_CAPABILITIES_VERSION, /^portal-capabilities@\d+$/);
  assert.ok(PORTAL_CAPABILITIES.length <= 2000, `${PORTAL_CAPABILITIES.length} caracteres (máx. 2000)`);
  assert.equal(ownerSystem.split(PORTAL_CAPABILITIES).length - 1, 1, 'el Asistente la recibe una vez, entera');
  assert.ok(triageSystem.includes(PORTAL_CAPABILITIES), 'y el responsable de un análisis del propio Portal, la misma');
});

test('F · los especialistas a los que el Asistente encarga un análisis del propio Portal reciben esa misma descripción', async () => {
  assert.ok(triageSystem, 'se capturó la instrucción del responsable');
  noProblems(/Gauntlet/.test(triageSystem) ? [] : ['la instrucción del responsable (delegation.ts sys) solo dice «plataforma local donde empresas son operadas por equipos de agentes»: no sabe que existe Gauntlet, revisión del plan, encargos ni lotes']);
});
