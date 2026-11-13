import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * EN-028 · Regla de modelo de Portal IA. CLI de Claude Code SIMULADA (fixtures/fake-claude.mjs) y proveedor simulado:
 * ningún modelo real, ningún crédito. Cubre los criterios 2 (runs.start y --model), 3 (agentes nuevos), 5 (id no válido y
 * rechazo de Claude Code) y 6 (exportación con modelo predeterminado y Edición sin datos ni regla), más Codex/OpenAI y el PUT.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en028-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
delete process.env.PORTAL_SANDBOX;
const scriptPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-script.json'); const logPath = path.join(process.env.PORTAL_DATA_DIR, 'mock-log.jsonl');
process.env.PORTAL_MOCK_SCRIPT = scriptPath; process.env.PORTAL_MOCK_LOG = logPath;
fs.writeFileSync(scriptPath, JSON.stringify({ rules: [], markers: [] }));
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-fake-en028-'));
const FAKE = path.join(fakeDir, 'claude.mjs');
fs.copyFileSync(path.join(here, 'fixtures', 'fake-claude.mjs'), FAKE);
const ccLog = path.join(fakeDir, 'fake-claude.log.jsonl');
const scenario = (s: Record<string, unknown>) => { fs.writeFileSync(path.join(fakeDir, 'fake-claude.scenario.json'), JSON.stringify(s)); try { fs.unlinkSync(ccLog); } catch { /* vacío */ } };
const ccRuns = () => fs.existsSync(ccLog) ? fs.readFileSync(ccLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter((e: any) => e.kind === 'run') : [];
scenario({});

const { encryptSecret } = await import('../src/security/crypto.ts');
const { AGENT_TEMPLATES, classifyModel, filesToDefinition } = await import('@portal-ia/domain');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap, buildAgentConfig } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, claudeCodeRunsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');
const { resetDetectionCache } = await import('../src/services/claudeCode/detect.ts');
const { agentCaller, completeWith, setBridgeUrl } = await import('../src/services/claudeCode/backend.ts');
const { getClaudeCodeSettings, saveClaudeCodeSettings } = await import('../src/services/claudeCode/settings.ts');
const { ruleApplies, effectiveModel, ruleModelFor, explainModelRejection, ModelRuleError } = await import('../src/services/modelRule.ts');
const { harnessOptions } = await import('../src/services/harness/index.ts');
const { createCompany, createProject } = await import('../src/services/companies.ts');
const { exportFiles } = await import('../src/services/agentFolders.ts');
const { lessonsRepo } = await import('../src/services/lessons.ts');
const { EDITION_INCLUDE, EDITION_FORBIDDEN } = await import('../src/services/editionBundle.ts');
const { listPackageFiles } = await import('../src/services/packageTree.ts');
const creation: any = await import('../src/services/agentCreation.ts');
const { draftLesson, estimatePropose } = await import('../src/services/lessons.ts');

// Id de la regla: solo existe como dato (catálogo simulado y platform.sqlite), nunca en el código de src/.
const RULE = ['claude', 'fable', '5', '2', 'en028'].join('-');
const BASE = ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'];
const connect = (ids: string[]) => providersRepo.setConnected('anthropic', ids.map(id => classifyModel('anthropic', id)));
providersRepo.setCredential('anthropic', encryptSecret('clave-de-prueba'), 'clave…prueba');
connect([...BASE, RULE]);
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const app = await buildApp();
await app.listen({ port: 0, host: '127.0.0.1' });
setBridgeUrl(`http://127.0.0.1:${(app.server.address() as any).port}`);
after(async () => { await app.close(); });
const inject = (method: string, u: string, payload?: unknown) => app.inject({ method: method as any, url: u, payload: payload as any });

saveClaudeCodeSettings({ ...getClaudeCodeSettings(), cliPath: FAKE });
scenario({ auth: 'subscription' }); resetDetectionCache();
assert.equal((await inject('PUT', '/api/claude-code/settings', { enabled: true, authorized: true, maxDurationSec: 120 })).statusCode, 200);

const agentsOf = (slug: string): any[] => (agentsRepo(slug) as any).list();
const ccAgent = agentsOf(S).find(a => a.config.provider === 'anthropic')!;
const runModel = (id: string): string | undefined => {
  const r: any = claudeCodeRunsRepo(S);
  const row = r.get?.(id) ?? (r.list?.(100) ?? r.recent?.(100) ?? []).find((x: any) => x.id === id);
  return row?.model;
};
const req = (model: string) => ({ model, system: 'Eres un agente de prueba.', user: 'Responde «ok».', maxTokens: 64 }) as any;

test('g · PUT /model-rule sin confirm → 400; con confirm → 200 y se ve en GET; otra empresa o id fuera del catálogo → 400', async () => {
  const noConfirm = await inject('PUT', `${W}/model-rule`, { model: RULE, active: true });
  assert.equal(noConfirm.statusCode, 400, noConfirm.body);
  assert.match(JSON.parse(noConfirm.body).error, /confirmación/);
  const bad = await inject('PUT', `${W}/model-rule`, { model: 'modelo-inexistente', active: true, confirm: true });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.match(JSON.parse(bad.body).error, /no está en la lista de modelos de Anthropic/);
  const other = await inject('PUT', '/api/workspaces/otra/model-rule', { model: RULE, active: true, confirm: true });
  assert.equal(other.statusCode, 400, other.body);
  const ok = await inject('PUT', `${W}/model-rule`, { model: RULE, active: true, confirm: true });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(JSON.parse(ok.body).rule.model, RULE);
  const got = JSON.parse((await inject('GET', `${W}/model-rule`)).body);
  assert.equal(got.supported, true); assert.equal(got.rule.model, RULE); assert.equal(got.rule.active, true);
  assert.ok(got.rule.confirmedAt);
  assert.ok(got.models.some((m: any) => m.id === RULE));
});

test('2 · con la regla activa runs.start registra su modelo y cli.ts recibe --model <regla>', async () => {
  const r = await inject('PUT', `${W}/agents/${ccAgent.id}/backend`, { backend: 'claude-code', authorized: true });
  assert.equal(r.statusCode, 200, r.body);
  const agent = agentsRepo(S).get(ccAgent.id)!;
  scenario({ auth: 'subscription' });
  const cc = agentCaller(S, agent, null, 'Prueba EN-028');
  assert.ok(cc);
  const out: any = await cc!.complete(req('claude-sonnet-4-5'));
  assert.equal(runModel(out.runId), RULE, 'runs.start registra el modelo de la regla');
  const runs = ccRuns(); assert.ok(runs.length >= 1);
  for (const e of runs) { const i = e.args.indexOf('--model'); assert.ok(i >= 0); assert.equal(e.args[i + 1], RULE); }
});

test('2 · API de Anthropic: completeWith aplica la regla y, con id no válido, falla sin llamar', async () => {
  const apiAgent = { ...ccAgent, config: { ...ccAgent.config, backend: 'api', provider: 'anthropic' } };
  assert.equal(effectiveModel(S, apiAgent, 'claude-sonnet-4-5'), RULE);
  const cred = { ciphertext: encryptSecret('clave-de-prueba') };
  await completeWith(null, 'anthropic', cred, { workspace_id: null }, req('claude-sonnet-4-5'), undefined, { slug: S, agent: apiAgent });
  connect(BASE);
  try {
    await assert.rejects(completeWith(null, 'anthropic', cred, { workspace_id: null }, req('claude-sonnet-4-5'), undefined, { slug: S, agent: apiAgent }), /no está en la lista de modelos de Anthropic/);
  } finally { connect([...BASE, RULE]); }
});

test('5 · id fuera del catálogo: error claro y ninguna ejecución con otro modelo; el rechazo de Claude Code se explica', async () => {
  const agent = agentsRepo(S).get(ccAgent.id)!;
  scenario({ auth: 'subscription' });
  connect(BASE);
  try {
    await assert.rejects(agentCaller(S, agent, null, 'Prueba EN-028')!.complete(req('claude-sonnet-4-5')), (e: any) => {
      assert.match(String(e?.message), /no está en la lista de modelos de Anthropic/);
      assert.match(String(e?.message), /ni se ha usado otro modelo/);
      return true;
    });
    assert.equal(ccRuns().length, 0, 'no se lanza Claude Code con ningún modelo');
  } finally { connect([...BASE, RULE]); }
  const rejected = explainModelRejection({ message: 'x', error: { code: 'provider_error', message: `There's an issue with the selected model (${RULE}). It may not exist.` } }, RULE);
  assert.match(rejected.message, new RegExp(`Claude Code rechazó el modelo «${RULE}» de la regla de Portal IA`));
  assert.match(rejected.message, /No se ha usado otro modelo/);
  const other = { message: 'tiempo agotado', error: { code: 'timeout', message: 'tiempo agotado' } };
  assert.equal(explainModelRejection(other, RULE).message, 'tiempo agotado', 'otros fallos no se disfrazan de rechazo');
  assert.ok(new ModelRuleError('x') instanceof Error);
});

test('3 · agentes nuevos de portal-ia con el modelo de la regla; otras empresas no cambian', async () => {
  const models = [...BASE, RULE].map(id => classifyModel('anthropic', id));
  const t = AGENT_TEMPLATES[0]!;
  const ruled = buildAgentConfig(t, 'anthropic', models, null, ruleModelFor(S, 'anthropic'));
  assert.equal(ruled.model, RULE); assert.deepEqual(ruled.fallbacks, []);
  assert.notEqual(buildAgentConfig(t, 'anthropic', models, null, ruleModelFor('otra', 'anthropic')).model, RULE);
  assert.equal(ruleModelFor('otra', 'anthropic'), null);
  assert.equal(ruleModelFor(S, 'openai'), null);
  const p = createProject(S, 'Proyecto con regla');
  const projAgents = agentsOf(S).filter(a => a.projectId === p.id && a.config.provider === 'anthropic');
  assert.ok(projAgents.length > 0);
  for (const a of projAgents) assert.equal(a.config.model, RULE);
  const ws = createCompany('Otra Empresa EN028');
  const others = agentsOf(ws.slug);
  assert.ok(others.length > 0);
  for (const a of others) assert.notEqual(a.config.model, RULE, 'los agentes de otras empresas no cambian');
  // Nuevo agente: pide un modelo del catálogo; en portal-ia queda con el de la regla, en otra empresa con el pedido.
  const input = { name: 'Agente regla', role: 'Revisor', summary: 'Revisa', responsibilities: ['Revisar'], deliverables: [], department: 'Calidad', scope: 'workspace', projectId: null, harness: 'api', provider: 'anthropic', model: 'claude-sonnet-4-5', effort: 'medium', tools: [], knowledge: [], capabilities: [], autonomy: 'ask', authorized: true };
  const mine: any = await creation.createAgentFromWizard(S, { ...input });
  assert.equal((mine.config ?? mine.agent?.config).model, RULE);
  const theirs: any = await creation.createAgentFromWizard(ws.slug, { ...input });
  assert.equal((theirs.config ?? theirs.agent?.config).model, 'claude-sonnet-4-5');
});

test('f · Codex y OpenAI: la regla no se aplica, se dice por qué y su modelo no cambia', () => {
  const codex = { ...ccAgent, config: { ...ccAgent.config, backend: 'codex', provider: 'openai', model: 'gpt-5-codex' } };
  const openai = { ...ccAgent, config: { ...ccAgent.config, backend: 'api', provider: 'openai', model: 'gpt-5' } };
  const c = ruleApplies(S, codex); assert.equal(c.applies, false); assert.match(c.reason, /Codex/);
  const o = ruleApplies(S, openai); assert.equal(o.applies, false); assert.match(o.reason, /OpenAI/);
  assert.equal(effectiveModel(S, codex, 'gpt-5-codex'), 'gpt-5-codex');
  assert.equal(effectiveModel(S, openai, 'gpt-5'), 'gpt-5');
  const hc: any = harnessOptions(S, codex);
  assert.equal(hc.modelRule.applies, false); assert.match(hc.modelRule.reason, /no se aplica a este agente/); assert.equal(hc.model, 'gpt-5-codex');
  const ho: any = harnessOptions(S, openai);
  assert.equal(ho.modelRule.applies, false); assert.equal(ho.model, 'gpt-5');
  assert.equal(ruleApplies('otra', ccAgent).applies, false);
  assert.equal(ruleApplies(S, { ...ccAgent, config: { ...ccAgent.config, backend: 'claude-code', provider: 'anthropic' } }).applies, true);
});

test('6 · exportar la carpeta: harness.model vacío; AGENTS.md, habilidades y memoria verificada se conservan', async () => {
  const a = agentsOf(S).find(x => x.config.provider === 'anthropic' && x.id !== ccAgent.id)!;
  const memo = `Lección verificada EN-028 ${Date.now().toString(36)}`;
  const ts = new Date().toISOString();
  lessonsRepo(S).insert({ projectId: null, role: null, tags: ['en028'], status: 'validated', version: 1, parentId: null, title: 'Lección EN-028', detector: 'manual', evidence: { processId: null, processTitle: null, stepId: null, agentId: a.id, agentName: a.config.name, file: null, detail: 'prueba', at: ts }, rootCause: null, correctiveAction: null, lessonText: memo, source: 'manual', promotedTo: null, dedupeKey: null, agentId: a.id } as any);
  const { files } = await exportFiles(S, a.id);
  const def = filesToDefinition(files).definition;
  assert.ok(def, 'la carpeta exportada es válida');
  assert.equal(def!.manifest.harness.model, '', 'harness.model sale vacío («predeterminado»)');
  assert.ok(files['AGENTS.md'], 'conserva AGENTS.md');
  assert.ok(Object.keys(files).some(p => p.startsWith('skills/')), 'conserva las habilidades');
  assert.ok(Object.values(files).some(c => c.includes(memo)), 'conserva la memoria verificada');
  assert.ok(!Object.values(files).some(c => c.includes(RULE)), 'el id de la regla no viaja en la carpeta');
  // Regresión: con la regla inactiva el manifiesto vuelve a llevar el modelo del agente.
  assert.equal((await inject('PUT', `${W}/model-rule`, { model: RULE, active: false, confirm: true })).statusCode, 200);
  try {
    const off = filesToDefinition((await exportFiles(S, a.id)).files).definition;
    assert.equal(off!.manifest.harness.model, a.config.model);
  } finally { assert.equal((await inject('PUT', `${W}/model-rule`, { model: RULE, active: true, confirm: true })).statusCode, 200); }
});

test('6 · sincronizar la carpeta en disco no vacía el modelo ni config.model; solo la exportación lo vacía', async () => {
  const folders: any = await import('../src/services/agentFolders.ts');
  const repo: any = agentsRepo(S);
  const a = agentsOf(S).find(x => ruleApplies(S, x).applies);
  assert.ok(a, 'hay un agente de portal-ia al que se aplica la regla');
  const before: string = repo.get(a.id).config.model;
  assert.ok(before, 'el agente tiene modelo');
  await folders.syncAgentFolder(S, repo.get(a.id));
  const f = folders.agentFoldersRepo(S).folderOf(a.id);
  assert.ok(f, 'el agente tiene carpeta');
  const disk = folders.readFolder(folders.folderPath(S, f.folder)).files;
  assert.equal(filesToDefinition(disk).definition!.manifest.harness.model, before, 'la carpeta en disco conserva el modelo');
  assert.equal(filesToDefinition(folders.agentFoldersRepo(S).adopted(a.id).files).definition!.manifest.harness.model, before, 'la revisión adoptada conserva el modelo');
  assert.equal(repo.get(a.id).config.model, before, 'config.model no cambia');
  // Releer y sincronizar otra vez no cambia nada.
  await folders.syncAgentFolder(S, repo.get(a.id));
  assert.equal(repo.get(a.id).config.model, before);
  const exported = await exportFiles(S, a.id);
  assert.equal(filesToDefinition(exported.files).definition!.manifest.harness.model, '', 'solo lo exportado sale con modelo predeterminado');
  assert.ok(exported.files['AGENTS.md'], 'la exportación conserva AGENTS.md');
});

test('6 · Edición: solo código, sin data/ ni .sqlite ni el id de la regla', () => {
  const root = path.resolve(here, '..', '..', '..');
  const list = listPackageFiles(root)
    .filter(rel => EDITION_INCLUDE.some(re => re.test(rel)))
    .filter(rel => !EDITION_FORBIDDEN.some(f => f.pattern.test(rel)));
  assert.ok(list.length > 0);
  for (const rel of list) {
    assert.ok(!/^data(\/|$)/.test(rel), `${rel} está bajo data/`);
    assert.ok(!/\.sqlite/i.test(rel), `${rel} es una base de datos`);
    if (/\.(ts|tsx|mjs|js|json|md|html|css)$/i.test(rel)) assert.ok(!fs.readFileSync(path.join(root, rel), 'utf8').includes(RULE), `${rel} contiene el id de la regla`);
  }
});

test('2 · contrato: ninguna llamada directa al adaptador en src/ se salta la regla de modelo', () => {
  const srcRoot = path.resolve(here, '..', 'src');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : /\.(ts|tsx|mts)$/.test(d.name) ? [p] : [];
  });
  const DIRECT = /getAdapter\([^)]*\)!?\s*\.complete\(/g;
  // Único punto de entrada de la regla: completeWith en backend.ts. Los llamantes de esta lista llaman directamente al
  // adaptador, pero calculan antes el modelo con effectiveModel(...) y lo pasan a la llamada. Si aparece una llamada directa
  // en un archivo nuevo, hay que usar completeWith o añadir aquí ese archivo junto con su effectiveModel.
  const ALLOWED: Record<string, string> = {
    'services/claudeCode/backend.ts': 'completeWith (punto único de la regla)',
    'services/agentChat.ts': 'conversación con el agente: effectiveModel antes de la API',
    'services/agentFactory.ts': 'borrador de agente: effectiveModel del agente de incorporación',
    'services/agentNames.ts': 'nombre propio: effectiveModel en las dos ramas',
    'services/agentWizardDraft.ts': 'borrador del asistente: effectiveModel',
    'services/assistant.ts': 'Asistente: effectiveModel sobre el modelo de chat',
    'services/storyPipeline.ts': 'pipeline por API: effectiveModel antes de la llamada'
  };
  const offenders: string[] = []; const unguarded: string[] = []; const seen = new Set<string>();
  for (const file of walk(srcRoot)) {
    const rel = path.relative(srcRoot, file).split(path.sep).join('/');
    const text = fs.readFileSync(file, 'utf8');
    const direct = [...text.matchAll(DIRECT)];
    if (!direct.length) continue;
    seen.add(rel);
    if (!(rel in ALLOWED)) {
      for (const m of direct) offenders.push(`${rel}:${text.slice(0, m.index ?? 0).split('\n').length}`);
      continue;
    }
    const guards = (text.match(/effectiveModel\(/g) ?? []).length;
    if (guards < direct.length) unguarded.push(`${rel} (${direct.length} llamadas directas, ${guards} effectiveModel)`);
    if (rel !== 'services/claudeCode/backend.ts' && !/import\s*\{[^}]*\beffectiveModel\b[^}]*\}\s*from\s*['"][./]*(?:\.\.\/)*(?:services\/)?modelRule\.ts['"]/.test(text) && !/from\s*['"]\.\/modelRule\.ts['"]/.test(text)) {
      unguarded.push(`${rel} no importa effectiveModel de modelRule.ts`);
    }
  }
  assert.deepEqual(offenders, [], `llamadas directas al adaptador que se saltan la regla de modelo (usa completeWith): ${offenders.join(', ')}`);
  assert.deepEqual(unguarded, [], `llamadas directas sin effectiveModel: ${unguarded.join(', ')}`);
  // La lista no se queda vieja: cada archivo permitido sigue teniendo su llamada directa.
  for (const rel of Object.keys(ALLOWED)) assert.ok(seen.has(rel), `${rel} ya no llama directamente al adaptador: quítalo de la lista permitida`);
});

test('2 · extremo a extremo con un llamante real (draftLesson → completeWith) y un agente de la API de Anthropic', async () => {
  const ts = new Date().toISOString();
  const lesson: any = lessonsRepo(S).insert({ projectId: null, role: null, tags: ['en028-e2e'], status: 'validated', version: 1, parentId: null, title: 'Lección EN-028 e2e', detector: 'manual', evidence: { processId: null, processTitle: null, stepId: null, agentId: null, agentName: null, file: null, detail: 'prueba de extremo a extremo', at: ts }, rootCause: null, correctiveAction: null, lessonText: 'Texto de prueba', source: 'manual', promotedTo: null, dedupeKey: null, agentId: null } as any);
  const lessonId: string = typeof lesson === 'string' ? lesson : lesson.id;
  const { agentId } = estimatePropose(S, lessonId);
  // El agente que redacta la lección pasa a la API de Anthropic (no Claude Code): la regla debe entrar por completeWith.
  const put = await inject('PUT', `${W}/agents/${agentId}/backend`, { backend: 'api', authorized: true });
  assert.equal(put.statusCode, 200, put.body);
  const agent = agentsRepo(S).get(agentId)!;
  assert.equal(agent.config.backend ?? 'api', 'api'); assert.equal(agent.config.provider, 'anthropic');
  assert.notEqual(agent.config.model, RULE, 'el agente se creó antes de la regla: su modelo guardado no es el de la regla');
  const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  fs.writeFileSync(logPath, '');
  await draftLesson(S, lessonId, { authorized: true });
  const sent = calls();
  assert.equal(sent.length, 1, 'una sola llamada al proveedor');
  assert.equal(sent[0].model, RULE, 'el llamante real envía el modelo de la regla a la API de Anthropic');
  // Id fuera del catálogo: error claro y ninguna llamada con otro modelo.
  fs.writeFileSync(logPath, '');
  connect(BASE);
  try {
    await assert.rejects(draftLesson(S, lessonId, { authorized: true }), /no está en la lista de modelos de Anthropic/);
    assert.equal(calls().length, 0, 'no se llama al proveedor con ningún otro modelo');
  } finally { connect([...BASE, RULE]); }
});
