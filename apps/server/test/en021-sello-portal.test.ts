import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * EN-021 · Sello Portal IA. Sin modelo real (Claude Code simulado con suscripción; registra el system de cada llamada).
 *  (1) Texto único en @portal-ia/domain, en español; withSeal idempotente y sin línea 2 en pasos (owner=false).
 *  (2) Chat de agente: primera respuesta con L1 y L2 (una vez cada una); la segunda solo con L1.
 *  (3) Agente con AGENTS.md propio y agente del Portal sin él: mismo sello; carpeta, hash y revisión intactos.
 *  (4) «Tu nombre»: vacío por defecto; con valor entra en la línea 2; el correo nunca llega al prompt.
 *  (5) Cableado: pasos (callAgentStep), QA manual, delegación y Asistente sellan antes de llamar; Codex y Claude Code
 *      reciben req.system; las lecciones no se sellan en lessons.ts (no se duplican).
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en021-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en021-cc-'));
const FAKE = path.join(fakeDir, 'claude.mjs');
fs.copyFileSync(path.join(here, 'fixtures', 'fake-claude.mjs'), FAKE);
const ccLog = path.join(fakeDir, 'fake-claude.log.jsonl');
const scenario = (s: Record<string, unknown>) => { fs.writeFileSync(path.join(fakeDir, 'fake-claude.scenario.json'), JSON.stringify(s)); try { fs.unlinkSync(ccLog); } catch { /* vacío */ } };
const ccRuns = (): any[] => fs.existsSync(ccLog) ? fs.readFileSync(ccLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter((e: any) => e.kind === 'run') : [];

const D = await import('@portal-ia/domain');
const { encryptSecret } = await import('../src/security/crypto.ts');
const { providersRepo, settingsRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');
const { REPO_ROOT } = await import('../src/config.ts');
const { getClaudeCodeSettings, saveClaudeCodeSettings } = await import('../src/services/claudeCode/settings.ts');
const { resetDetectionCache, verifiedDetection } = await import('../src/services/claudeCode/detect.ts');
const { sourcesRepo } = await import('../src/services/externalAgents.ts');
const { OWNER_NAME_KEY, ownerDisplayName, saveOwnerDisplayName, sealForOwner, sealForStep } = await import('../src/services/portalSeal.ts');

providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-opus-4-1', 'claude-sonnet-4-5'].map(id => D.classifyModel('anthropic', id)));
runBootstrap();
const S = 'portal-ia'; const W = `/api/workspaces/${S}`;
const app = await buildApp();
after(async () => { await app.close(); });
saveClaudeCodeSettings({ ...getClaudeCodeSettings(), enabled: true, cliPath: FAKE, maxConcurrent: 1 }); resetDetectionCache();
scenario({ auth: 'subscription', defaultText: 'ok' }); await verifiedDetection(getClaudeCodeSettings(), 0);
const inject = async (method: string, u: string, payload?: unknown) => { const r = await app.inject({ method: method as any, url: u, payload: payload as any }); return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() as any }; };
const until = async (fn: () => boolean | Promise<boolean>, ms = 30_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 80)); } return false; };
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const EMAIL = 'propietario.en021@ejemplo.com';
const src = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, ...rel.split('/')), 'utf8');

/** Envía un mensaje al chat del agente, espera la respuesta y devuelve el system (y prompt) que recibió el modelo. */
async function chatSystem(P: string, text: string): Promise<string> {
  const n0 = ((await inject('GET', `${P}/chat`)).json.messages ?? []).length;
  const r = await inject('POST', `${P}/chat`, { text }); assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.ok(await until(async () => { const m = (await inject('GET', `${P}/chat`)).json.messages; return m.length >= n0 + 2 && m.at(-1).role === 'agent' && m.at(-1).status !== 'running'; }), 'el agente responde');
  const last = (await inject('GET', `${P}/chat`)).json.messages.at(-1);
  assert.equal(last.status, 'done', last.error ?? '');
  const run = ccRuns().filter(c => String(c.prompt).includes(text)).at(-1);
  assert.ok(run, 'Claude Code recibió la llamada');
  return String(run.system ?? '');
}

test('(1) el texto del sello vive solo en el dominio, en español, y withSeal no repite líneas', () => {
  assert.match(D.SEAL_LINE_1, /aplica las lecciones y la memoria verificada/);
  assert.match(D.sealLine2(null), /preséntate/); assert.match(D.sealLine2(null), /pregúntale una sola vez/);
  assert.match(D.sealLine2('Yair'), /llama al propietario por su nombre: Yair\./);
  const literal = 'la memoria verificada que recibes';
  const hits: string[] = [];
  const walk = (dir: string) => { if (!fs.existsSync(dir)) return; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(p); } else if (/\.(ts|tsx)$/.test(e.name) && fs.readFileSync(p, 'utf8').includes(literal)) hits.push(path.relative(REPO_ROOT, p).split(path.sep).join('/')); } };
  for (const d of ['packages/domain/src', 'apps/server/src', 'apps/web/src']) walk(path.join(REPO_ROOT, ...d.split('/')));
  assert.deepEqual(hits, ['packages/domain/src/portal-seal.ts'], 'un único sitio con el texto');
  // Pasos estructurados: nunca línea 2, aunque se pida firstReply.
  const step = sealForStep('Eres el Desarrollador.');
  assert.equal(count(step, D.SEAL_L1_MARK), 1); assert.equal(count(step, D.SEAL_L2_MARK), 0);
  assert.equal(D.withSeal('x', { firstReply: true }).includes(D.SEAL_L2_MARK), false, 'owner=false por defecto');
  // Idempotente (reintentos y llamadas encadenadas): cada línea como mucho una vez.
  const twice = D.withSeal(D.withSeal('base', { owner: true, firstReply: true }), { owner: true, firstReply: true });
  assert.equal(count(twice, D.SEAL_L1_MARK), 1); assert.equal(count(twice, D.SEAL_L2_MARK), 1);
  // La línea 2 se añade aunque la 1 ya esté (marcas independientes).
  const l2 = D.withSeal(sealForStep('base'), { owner: true, firstReply: true });
  assert.equal(count(l2, D.SEAL_L1_MARK), 1); assert.equal(count(l2, D.SEAL_L2_MARK), 1);
  // Segunda respuesta: solo línea 1.
  const second = sealForOwner('base', false);
  assert.equal(count(second, D.SEAL_L1_MARK), 1); assert.equal(count(second, D.SEAL_L2_MARK), 0);
});

test('(1b) las lecciones inyectadas no se repiten ni cambian con el sello', () => {
  const lessons = '\n\n# Lecciones aprendidas\n- LECCION-UNICA-EN021: valida los tipos antes de entregar.';
  const sys = sealForOwner(`Eres «Agente».${lessons}`, true);
  assert.equal(count(sys, 'LECCION-UNICA-EN021'), 1);
  assert.ok(sys.startsWith(`Eres «Agente».${lessons}`), 'el texto previo (identidad + lecciones) queda intacto y el sello va aparte');
  assert.doesNotMatch(src('apps/server/src/services/lessons.ts'), /portalSeal|withSeal/, 'injectLessons y buildLessonContext devuelven las lecciones sin sello');
});

test('(4) «Tu nombre» vacío por defecto; con valor entra en la línea 2; el correo nunca llega', () => {
  settingsRepo.set('owner.email', EMAIL);
  assert.equal(ownerDisplayName(), null, 'vacío por defecto (no se toma del correo)');
  const empty = sealForOwner('base', true);
  assert.match(empty, /pregúntale una sola vez/); assert.ok(!empty.includes(EMAIL));
  assert.equal(saveOwnerDisplayName('  Yair  '), 'Yair');
  const named = sealForOwner('base', true);
  assert.match(named, /llama al propietario por su nombre: Yair\./); assert.ok(!named.includes(EMAIL));
  assert.equal(saveOwnerDisplayName(''), null); assert.equal(settingsRepo.get(OWNER_NAME_KEY), '');
  assert.equal(ownerDisplayName(), null);
});

// Agente externo con AGENTS.md propio.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en021-agente-'));
after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* temporal */ } });
const root = path.join(base, 'Agente');
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Agente con instrucciones propias\n\nResume documentos.\n');

test('(2)(3) chat: primera respuesta con L1 y L2, segunda solo L1; mismo sello con y sin AGENTS.md; carpeta, hash y revisión intactos', async () => {
  settingsRepo.set('owner.email', EMAIL);
  const pv = (await inject('POST', `${W}/agents/external/preview`, { path: root })).json;
  const imp = await inject('POST', `${W}/agents/external`, { path: root, hash: pv.hash, name: 'Sellado', role: 'Pruebas del sello', summary: '', department: 'Documentos', harness: 'claude-code', model: 'claude-sonnet-4-5', grants: { writeDocuments: true }, authorized: true });
  assert.ok(imp.status < 300, JSON.stringify(imp.json));
  const extId = imp.json.id as string; const EXT = `${W}/agents/${extId}`;
  const agentsMdBefore = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  const filesBefore = fs.readdirSync(root, { recursive: true } as any).map(String).sort();
  const revBefore = (sourcesRepo(S).get(extId) as any)?.revision ?? null;

  const coord = agentsRepo(S).list().find(x => x.key === 'ws-gestor' || x.key === 'pj-coordinador')!;
  agentsRepo(S).updateConfig(coord.id, { ...coord.config, backend: 'claude-code', provider: 'anthropic' } as any);
  const COORD = `${W}/agents/${coord.id}`;
  scenario({ auth: 'subscription', defaultText: 'Hola, soy tu agente.' });

  // Con nombre guardado: el agente externo lo recibe en la línea 2.
  saveOwnerDisplayName('Yair');
  const ext1 = await chatSystem(EXT, 'EN021-EXT-PRIMERA hola');
  assert.equal(count(ext1, D.SEAL_L1_MARK), 1, 'L1 una vez'); assert.equal(count(ext1, D.SEAL_L2_MARK), 1, 'L2 una vez');
  assert.match(ext1, /llama al propietario por su nombre: Yair\./);
  assert.ok(!ext1.includes(EMAIL), 'el correo nunca llega al prompt');
  const ext2 = await chatSystem(EXT, 'EN021-EXT-SEGUNDA sigue');
  assert.equal(count(ext2, D.SEAL_L1_MARK), 1); assert.equal(count(ext2, D.SEAL_L2_MARK), 0, 'sin L2 en la segunda respuesta');

  // Sin nombre: el agente del Portal (sin AGENTS.md propio) pide preguntarlo.
  saveOwnerDisplayName('');
  const co1 = await chatSystem(COORD, 'EN021-COORD-PRIMERA hola');
  assert.equal(count(co1, D.SEAL_L1_MARK), 1); assert.equal(count(co1, D.SEAL_L2_MARK), 1);
  assert.match(co1, /pregúntale una sola vez/); assert.ok(!co1.includes(EMAIL));
  const co2 = await chatSystem(COORD, 'EN021-COORD-SEGUNDA sigue');
  assert.equal(count(co2, D.SEAL_L1_MARK), 1); assert.equal(count(co2, D.SEAL_L2_MARK), 0);

  // El mismo sello (L1) para los dos, con y sin AGENTS.md propio.
  const l1 = (s: string) => s.split('\n').find(l => l.includes(D.SEAL_L1_MARK));
  assert.equal(l1(ext1), D.SEAL_LINE_1); assert.equal(l1(co1), D.SEAL_LINE_1);

  // Carpeta, hash y estado de cambios externos sin cambios.
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), agentsMdBefore, 'AGENTS.md intacto');
  assert.deepEqual(fs.readdirSync(root, { recursive: true } as any).map(String).sort(), filesBefore, 'sin archivos nuevos en la carpeta');
  assert.equal((await inject('POST', `${W}/agents/external/preview`, { path: root })).json.hash, pv.hash, 'el hash no cambia');
  assert.equal((sourcesRepo(S).get(extId) as any)?.revision ?? null, revBefore, 'no aparece como cambio externo para adoptar');
});

test('(5) cableado: pasos, QA manual, delegación y Asistente sellan antes de llamar; sin L2 fuera de conversaciones', () => {
  const pipeline = src('apps/server/src/services/storyPipeline.ts');
  assert.match(pipeline, /return sealForStep\(injected\.get\(stepId\)!\)/, 'callAgentStep sella el system ya inyectado (pipeline y storyExecution)');
  const exec = src('apps/server/src/services/storyExecution.ts');
  assert.match(exec, /const system = sealForStep\(`Eres «\$\{agent\.config\.name\}»/, 'QA de pruebas manuales sellado');
  assert.match(exec, /callAgentStep/, 'storyExecution llama por callAgentStep');
  const deleg = src('apps/server/src/services/delegation.ts');
  assert.match(deleg, /system = sealForStep\(system \+ lc\.block\)/, 'análisis delegado sellado tras las lecciones');
  for (const [name, s] of [['storyPipeline', pipeline], ['storyExecution', exec], ['delegation', deleg]] as const) assert.doesNotMatch(s, /sealForOwner|owner:\s*true/, `${name}: nunca la línea 2`);
  for (const f of ['qaGate.ts', 'gauntlet.ts']) { const p = path.join(REPO_ROOT, 'apps', 'server', 'src', 'services', f); if (fs.existsSync(p)) assert.doesNotMatch(fs.readFileSync(p, 'utf8'), /sealForOwner/, `${f}: sin línea 2`); }
  assert.match(src('apps/server/src/services/agentChat.ts'), /sealForOwner\(systemFor\(slug, a, projectId\) \+ lessonCtx\.block, firstReply\)/);
  const assistant = src('apps/server/src/services/assistant.ts');
  assert.match(assistant, /system: sealForOwner\(system, !answeredBefore\)/, 'Asistente: L2 solo si aún no respondió en esa conversación (hilo reutilizado incluido)');
  assert.equal(count(assistant, 'sealForOwner('), 1, 'un único punto de sellado en el Asistente');
  // Arneses: Codex y Claude Code reciben req.system tal cual (con el sello ya aplicado).
  assert.match(src('apps/server/src/services/harness/codex.ts'), /INSTRUCCIONES DEL AGENTE \(Portal IA\)>>\\n\$\{req\.system\}/);
  assert.match(src('apps/server/src/services/claudeCode/backend.ts'), /\.system/);
});

test('(6) panel del agente y Ajustes: sello en solo lectura desde el dominio y campo «Tu nombre»', () => {
  const panel = src('apps/web/src/components/AgentConfigPanel.tsx');
  assert.match(panel, /@portal-ia\/domain/); assert.match(panel, /SEAL_NOTE|Lo añade el Portal a todos los agentes/);
  assert.ok(!panel.includes('la memoria verificada que recibes'), 'el panel no duplica el texto');
  assert.equal(D.SEAL_NOTE, 'Lo añade el Portal a todos los agentes');
  assert.match(src('apps/web/src/screens/Settings.tsx'), /Tu nombre/);
});
