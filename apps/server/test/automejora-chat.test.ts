import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * HU-178 · Automejora desde el chat. Sin modelo real (Claude Code simulado, suscripción). Comprueba:
 *  (a) agente externo: la mejora se aplica al momento, sin «Sí, hazlo» ni Mejoras, con copia en respaldos y CAMBIOS.md;
 *  (c) Deshacer restaura la copia, CAMBIOS.md conserva el historial y un segundo Deshacer da 409;
 *  (b) dos mejoras seguidas el mismo día (por el chat y en paralelo) se aplican las dos, sin stale_proposal, revisión +2;
 *  (b2) deshacer la primera de dos mejoras seguidas da 409 (later_improvements) sin tocar nada; en orden inverso, las dos se deshacen;
 *  (d) agente del Portal: el aprendizaje queda activo en su Memoria y se puede deshacer;
 *  (e) una petición sobre permisos, arnés, presupuesto o código del Portal no aplica nada y lo protegido queda intacto;
 *  (f) cada mejora usa exactamente una consulta y, con el tope del agente agotado, falla sin consultar ni aplicar.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-automejora-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-automejora-cc-'));
const FAKE = path.join(fakeDir, 'claude.mjs');
fs.copyFileSync(path.join(here, 'fixtures', 'fake-claude.mjs'), FAKE);
const ccLog = path.join(fakeDir, 'fake-claude.log.jsonl');
const scenario = (s: Record<string, unknown>) => { fs.writeFileSync(path.join(fakeDir, 'fake-claude.scenario.json'), JSON.stringify(s)); try { fs.unlinkSync(ccLog); } catch { /* vacío */ } };
const ccRuns = () => fs.existsSync(ccLog) ? fs.readFileSync(ccLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter((e: any) => e.kind === 'run') : [];
const FEEDBACK = '# Feedback del propietario';
const classifierCalls = () => ccRuns().filter((c: any) => String(c.prompt).includes(FEEDBACK)).length;

const D = await import('@portal-ia/domain');
const { encryptSecret } = await import('../src/security/crypto.ts');
const { providersRepo } = await import('../src/db/platform.ts');
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { agentsRepo, workspaceDb } = await import('../src/db/workspace.ts');
const { buildApp } = await import('./fixtures/owner-app.ts');
const { REPO_ROOT } = await import('../src/config.ts');
const { getClaudeCodeSettings, saveClaudeCodeSettings } = await import('../src/services/claudeCode/settings.ts');
const { resetDetectionCache, verifiedDetection } = await import('../src/services/claudeCode/detect.ts');
const { improveNow, MODEL_CALLS_PER_DAY } = await import('../src/services/documentJobs.ts');
const { sourcesRepo } = await import('../src/services/externalAgents.ts');
const { lessonsRepo } = await import('../src/services/lessons.ts');

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
const accion = (o: Record<string, unknown>) => `Entendido.\n\n\`\`\`accion\n${JSON.stringify(o)}\n\`\`\``;
const classifier = (summary: string, changes: unknown[]) => ({ match: FEEDBACK, text: JSON.stringify({ classification: 'reusable', reason: 'Lo pide el propietario.', summary, changes }) });

// Agente externo con carpeta propia.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-automejora-agente-'));
after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* temporal */ } });
const root = path.join(base, 'Agente');
const w = (rel: string, t: string) => { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
w('AGENTS.md', '# Agente de automejora\n\nConvierte PDF.\n');
w('skills/conv/SKILL.md', '---\nname: conv\ndescription: Convierte.\n---\n\n# Conv — versión 1.0.0\n\nUsa scripts/conv.py.\n');
w('skills/conv/scripts/conv.py', 'print("ok")\n');
const pv = (await inject('POST', `${W}/agents/external/preview`, { path: root })).json;
const imp = await inject('POST', `${W}/agents/external`, { path: root, hash: pv.hash, name: 'Mejorable', role: 'Pruebas de automejora', summary: '', department: 'Documentos', harness: 'claude-code', model: 'claude-sonnet-4-5', grants: { writeDocuments: true, runScripts: true, applyImprovements: true }, authorized: true });
assert.equal(imp.status < 300, true, JSON.stringify(imp.json));
const agentId = imp.json.id as string;
const A = `${W}/agents/${agentId}`;
const SKILL = path.join(root, 'skills', 'conv', 'SKILL.md');
const skill = () => fs.readFileSync(SKILL, 'utf8');
const filesUnder = (dir: string): string[] => { const out: string[] = []; if (!fs.existsSync(dir)) return out; const walk = (d: string, r: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const rel = r ? `${r}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), rel); else out.push(rel); } }; walk(dir, ''); return out.sort(); };
// El historial vivo, no las copias que Deshacer guarda en configuracion/respaldos (esas también se llaman CAMBIOS.md).
const cambios = () => { const f = filesUnder(root).find(p => p.split('/').at(-1) === 'CAMBIOS.md' && !p.startsWith('configuracion/')); return f ? fs.readFileSync(path.join(root, ...f.split('/')), 'utf8') : ''; };
const revision = () => Number((sourcesRepo(S).get(agentId) as any)?.revision);

/** Envía un mensaje al chat y espera a que la acción del agente termine (sin pulsar nada). */
async function chatAction(P: string, text: string): Promise<any> {
  const seen = new Set(((await inject('GET', `${P}/chat`)).json.messages ?? []).map((m: any) => m.id));
  const r = await inject('POST', `${P}/chat`, { text }); assert.equal(r.status, 202, JSON.stringify(r.json));
  const ok = await until(async () => { const last = (await inject('GET', `${P}/chat`)).json.messages.at(-1); return !!last && !seen.has(last.id) && (last.actions ?? []).some((x: any) => x.status === 'done' || x.status === 'failed'); });
  assert.ok(ok, 'la acción del chat termina sola, sin confirmación');
  return (await inject('GET', `${P}/chat`)).json.messages.at(-1).actions[0];
}

let first: any = null; let skillBefore = ''; let cambiosBefore = '';
test('(a) externo: la mejora pedida en el chat se aplica al momento, con copia en respaldos y entrada en CAMBIOS.md; una consulta', async () => {
  skillBefore = skill(); cambiosBefore = cambios(); const rev0 = revision();
  scenario({ auth: 'subscription', rules: [classifier('Aviso de escaneados', [{ path: 'skills/conv/SKILL.md', kind: 'append', content: '- MEJORA-A: avisa de PDF escaneados.', summary: 'Aviso de escaneados' }]), { match: 'mejora tu forma', text: accion({ tipo: 'mejorar_agente', descripcion: 'Avisar de los PDF escaneados.' }) }] });
  const a = await chatAction(A, 'Por favor mejora tu forma de avisar de los PDF escaneados.');
  assert.equal(a.kind, 'mejorar_agente'); assert.equal(a.needsConfirmation, false); assert.equal(a.status, 'done', a.error);
  assert.equal(a.result.applied, true, JSON.stringify(a.result));
  assert.ok(a.result.changes.some((c: any) => c.archivo === 'skills/conv/SKILL.md' && typeof c.resumen === 'string'), 'el chat muestra qué cambió');
  assert.ok(a.result.undo, 'con Deshacer');
  assert.ok(skill().includes('MEJORA-A'), 'aplicado en la habilidad');
  assert.equal(revision(), rev0 + 1);
  assert.ok(a.result.backup, 'se guarda copia'); assert.ok(filesUnder(path.join(root, 'configuracion', 'respaldos')).length > 0, 'copia en configuracion/respaldos');
  assert.ok(cambios().length > cambiosBefore.length, 'entrada nueva en CAMBIOS.md');
  assert.equal(classifierCalls(), 1, 'exactamente una consulta por mejora');
  const props = (await inject('GET', `${A}/documents`)).json.proposals;
  assert.equal(props.filter((p: any) => p.state === 'proposed').length, 0, 'nada pendiente en Mejoras');
  first = a;
});

test('(c) Deshacer restaura la copia, CAMBIOS.md conserva el historial y un segundo Deshacer da 409', async () => {
  assert.ok(first, 'depende de (a)');
  const histBefore = cambios();
  const u = await inject('POST', `${A}/actions/${first.id}/undo`, {});
  assert.equal(u.status, 200, JSON.stringify(u.json)); assert.equal(u.json.result.undone, true);
  assert.equal(skill(), skillBefore, 'la habilidad vuelve a como estaba');
  const hist = cambios(); assert.ok(hist.length > histBefore.length, 'CAMBIOS.md añade la vuelta atrás'); assert.ok(hist.includes('MEJORA-A') || histBefore === hist.slice(0, histBefore.length), 'conserva el historial');
  assert.equal((await inject('POST', `${A}/actions/${first.id}/undo`, {})).status, 409, 'un segundo Deshacer no hace nada');
  const again = (await inject('GET', `${A}/chat`)).json.messages.flatMap((m: any) => m.actions ?? []).find((x: any) => x.id === first.id);
  assert.equal(again.result.undone, true, 'el chat ve que se deshizo');
});

test('(b) dos mejoras seguidas el mismo día (por el chat y en paralelo) se aplican las dos, sin stale_proposal', async () => {
  const rev0 = revision();
  scenario({ auth: 'subscription', rules: [classifier('Uno', [{ path: 'skills/conv/SKILL.md', kind: 'append', content: '- SERIE-1.', summary: 'Uno' }]), { match: 'primera mejora', text: accion({ tipo: 'mejorar_agente', descripcion: 'Primera mejora.' }) }] });
  const m1 = await chatAction(A, 'Haz esta primera mejora en tu forma de trabajar, por favor.');
  assert.equal(m1.status, 'done', m1.error); assert.equal(m1.result.applied, true, JSON.stringify(m1.result));
  scenario({ auth: 'subscription', rules: [classifier('Dos', [{ path: 'skills/conv/SKILL.md', kind: 'append', content: '- SERIE-2.', summary: 'Dos' }]), { match: 'segunda mejora', text: accion({ tipo: 'mejorar_agente', descripcion: 'Segunda mejora.' }) }] });
  const m2 = await chatAction(A, 'Y ahora esta segunda mejora, por favor.');
  assert.equal(m2.status, 'done', m2.error); assert.equal(m2.result.applied, true, JSON.stringify(m2.result));
  assert.doesNotMatch(JSON.stringify(m2), /stale_proposal|obsolet/);
  assert.equal(revision(), rev0 + 2, 'revisión +2');
  assert.ok(skill().includes('SERIE-1') && skill().includes('SERIE-2'));
  // En paralelo: la cola por agente las pone en serie y cada una parte de la revisión vigente.
  scenario({ auth: 'subscription', rules: [
    { match: 'PARALELO-A', text: JSON.stringify({ classification: 'reusable', reason: 'r', summary: 'A', changes: [{ path: 'skills/conv/SKILL.md', kind: 'append', content: '- PAR-A.', summary: 'A' }] }) },
    { match: 'PARALELO-B', text: JSON.stringify({ classification: 'reusable', reason: 'r', summary: 'B', changes: [{ path: 'skills/conv/SKILL.md', kind: 'append', content: '- PAR-B.', summary: 'B' }] }) }
  ] });
  const rev1 = revision();
  const [p1, p2] = await Promise.all([improveNow(S, agentId, { jobId: null, text: 'Por favor PARALELO-A en tu habilidad.' }), improveNow(S, agentId, { jobId: null, text: 'Por favor PARALELO-B en tu habilidad.' })]);
  assert.equal(p1.applied, true, p1.reason ?? ''); assert.equal(p2.applied, true, p2.reason ?? '');
  assert.equal(revision(), rev1 + 2, 'las dos aplicadas, sin versión obsoleta');
  assert.ok(skill().includes('PAR-A') && skill().includes('PAR-B'));
  assert.equal(classifierCalls(), 2, 'una consulta por mejora');
});

test('(b2) Deshacer con mejoras posteriores: 409 later_improvements sin cambios; en orden inverso se deshacen las dos', async () => {
  const skill0 = skill(); const rev0 = revision();
  scenario({ auth: 'subscription', rules: [classifier('Orden uno', [{ path: 'skills/conv/SKILL.md', kind: 'append', content: '- ORDEN-UNO.', summary: 'Orden uno' }]), { match: 'mejora ORDEN-UNO', text: accion({ tipo: 'mejorar_agente', descripcion: 'Mejora ORDEN-UNO.' }) }] });
  const m1 = await chatAction(A, 'Aplica la mejora ORDEN-UNO a tu forma de trabajar, por favor.');
  assert.equal(m1.status, 'done', m1.error); assert.equal(m1.result.applied, true, JSON.stringify(m1.result));
  scenario({ auth: 'subscription', rules: [classifier('Orden dos', [{ path: 'skills/conv/SKILL.md', kind: 'append', content: '- ORDEN-DOS.', summary: 'Orden dos' }]), { match: 'mejora ORDEN-DOS', text: accion({ tipo: 'mejorar_agente', descripcion: 'Mejora ORDEN-DOS.' }) }] });
  const m2 = await chatAction(A, 'Aplica ahora la mejora ORDEN-DOS, por favor.');
  assert.equal(m2.status, 'done', m2.error); assert.equal(m2.result.applied, true, JSON.stringify(m2.result));
  assert.equal(revision(), rev0 + 2);
  const both = skill(); assert.ok(both.includes('ORDEN-UNO') && both.includes('ORDEN-DOS'));

  // Deshacer la primera con una posterior aplicada: 409 later_improvements y nada cambia.
  const u1 = await inject('POST', `${A}/actions/${m1.id}/undo`, {});
  assert.equal(u1.status, 409, JSON.stringify(u1.json)); assert.equal(u1.json.code, 'later_improvements', JSON.stringify(u1.json));
  assert.equal(skill(), both, 'la habilidad conserva las dos mejoras'); assert.ok(skill().includes('ORDEN-UNO') && skill().includes('ORDEN-DOS'));
  assert.equal(revision(), rev0 + 2, 'la revisión no cambia');
  const still = (await inject('GET', `${A}/chat`)).json.messages.flatMap((m: any) => m.actions ?? []).find((x: any) => x.id === m1.id);
  assert.notEqual(still.result.undone, true, 'la primera sigue aplicada');

  // Reasignar al Portal la primera con una posterior aplicada: 409, sigue 'done' y aplicada, sin pasar a mejorar_portal.
  const actionsOf = () => workspaceDb(S).prepare(`SELECT id, kind, status FROM agent_actions WHERE agent_id = ?`).all(agentId) as any[];
  const portalBefore = actionsOf().filter(x => x.kind === 'mejorar_portal').length;
  const pendingBefore = actionsOf().filter(x => x.status === 'proposed').length;
  const rr = await inject('POST', `${A}/actions/${m1.id}/reroute`, {});
  assert.equal(rr.status, 409, JSON.stringify(rr.json)); assert.equal(rr.json.code, 'later_improvements', JSON.stringify(rr.json));
  const afterRr = (await inject('GET', `${A}/chat`)).json.messages.flatMap((m: any) => m.actions ?? []).find((x: any) => x.id === m1.id);
  assert.equal(afterRr.kind, 'mejorar_agente', 'no pasa a mejorar_portal'); assert.equal(afterRr.status, 'done');
  assert.equal(afterRr.result.applied, true); assert.notEqual(afterRr.result.undone, true);
  assert.equal(actionsOf().filter(x => x.kind === 'mejorar_portal').length, portalBefore, 'ninguna historia del Portal en camino');
  assert.equal(actionsOf().filter(x => x.status === 'proposed').length, pendingBefore, 'nada nuevo pendiente');
  assert.equal(skill(), both, 'la habilidad no cambia'); assert.equal(revision(), rev0 + 2, 'la revisión no cambia');

  // En orden inverso: primero la última, después la primera.
  const u2 = await inject('POST', `${A}/actions/${m2.id}/undo`, {});
  assert.equal(u2.status, 200, JSON.stringify(u2.json));
  assert.ok(skill().includes('ORDEN-UNO') && !skill().includes('ORDEN-DOS'), 'solo se retira la segunda');
  const u1b = await inject('POST', `${A}/actions/${m1.id}/undo`, {});
  assert.equal(u1b.status, 200, JSON.stringify(u1b.json)); assert.equal(u1b.json.result.undone, true);
  assert.equal(skill(), skill0, 'la habilidad queda como antes de la primera mejora');
});

test('(d) agente del Portal: el aprendizaje queda aplicado en su Memoria (no «por verificar») y se puede deshacer', async () => {
  const coord = agentsRepo(S).list().find(x => x.key === 'ws-gestor' || x.key === 'pj-coordinador')!;
  agentsRepo(S).updateConfig(coord.id, { ...coord.config, backend: 'claude-code', provider: 'anthropic' } as any);
  scenario({ auth: 'subscription', rules: [{ match: 'recuerda', text: accion({ tipo: 'mejorar_agente', descripcion: 'Resumir siempre en tres puntos.' }) }] });
  const P = `${W}/agents/${coord.id}`;
  const a = await chatAction(P, 'Por favor recuerda resumir en tres puntos.');
  assert.equal(a.kind, 'mejorar_agente'); assert.equal(a.status, 'done', a.error); assert.equal(a.needsConfirmation, false);
  assert.equal(a.result.applied, true); assert.ok(a.result.changes.length >= 1); assert.match(a.link, /\/memoria$/);
  assert.equal(lessonsRepo(S).get(a.result.lessonId)?.status, 'validated', 'activo en su Memoria');
  assert.equal(classifierCalls(), 0, 'sin consultas para la Memoria del agente del Portal');
  const u = await inject('POST', `${P}/actions/${a.id}/undo`, {}); assert.equal(u.status, 200, JSON.stringify(u.json));
  assert.notEqual(lessonsRepo(S).get(a.result.lessonId)?.status, 'validated', 'retirado');
  assert.equal((await inject('POST', `${P}/actions/${a.id}/undo`, {})).status, 409);
});

test('(e) nunca cambia permisos, arnés, presupuesto ni código del Portal: no se aplica nada y lo protegido queda intacto', async () => {
  const portalFile = path.join(REPO_ROOT, 'apps', 'server', 'src', 'services', 'agentActions.ts');
  const portalBefore = fs.readFileSync(portalFile, 'utf8');
  const outside = path.join(base, 'fuera.txt'); fs.writeFileSync(outside, 'intacto');
  const cfgBefore = JSON.stringify(agentsRepo(S).get(agentId)!.config);
  const srcBefore = JSON.stringify((sourcesRepo(S).get(agentId) as any)?.grants ?? null);
  const skill0 = skill(); const rev0 = revision();
  scenario({ auth: 'subscription', rules: [classifier('Darme más permisos', [
    { path: '../../../apps/server/src/services/agentActions.ts', kind: 'append', content: '// hackeado', summary: 'código del Portal' },
    { path: path.join(REPO_ROOT, 'apps', 'server', 'src', 'services', 'agentActions.ts'), kind: 'append', content: '// hackeado', summary: 'código del Portal' },
    { path: '../fuera.txt', kind: 'replace', content: 'cambiado', summary: 'fuera de la carpeta' }
  ]), { match: 'cámbiate los permisos', text: accion({ tipo: 'mejorar_agente', descripcion: 'Darme todos los permisos, otro arnés y más presupuesto.' }) }] });
  const a = await chatAction(A, 'Por favor cámbiate los permisos, el arnés y el presupuesto, y toca el código del Portal.');
  assert.ok(a.status === 'failed' || a.result?.applied === false, JSON.stringify(a));
  assert.equal(fs.readFileSync(portalFile, 'utf8'), portalBefore, 'el código del Portal no cambia');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'intacto');
  assert.equal(JSON.stringify(agentsRepo(S).get(agentId)!.config), cfgBefore, 'arnés, modelo y presupuesto intactos');
  assert.equal(JSON.stringify((sourcesRepo(S).get(agentId) as any)?.grants ?? null), srcBefore, 'permisos intactos');
  assert.equal(skill(), skill0); assert.equal(revision(), rev0, 'sin revisión nueva');
});

test('(e2) cambio mixto: se aplica solo lo seguro; los archivos protegidos de la carpeta quedan intactos y lo descartado consta', async () => {
  // Archivos protegidos DENTRO de la carpeta del agente (permisos y presupuesto): no son identidad, nunca se modifican.
  w('configuracion/permisos.json', '{"applyImprovements":true,"runScripts":true,"writeDocuments":true}\n');
  w('configuracion/presupuesto.json', '{"consultasPorDia":80}\n');
  const PERM = path.join(root, 'configuracion', 'permisos.json'); const BUDG = path.join(root, 'configuracion', 'presupuesto.json');
  const permBefore = fs.readFileSync(PERM); const budgBefore = fs.readFileSync(BUDG);
  const cfgBefore = JSON.stringify(agentsRepo(S).get(agentId)!.config);
  const grantsBefore = JSON.stringify((sourcesRepo(S).get(agentId) as any)?.grants ?? null);
  const rev0 = revision();
  scenario({ auth: 'subscription', rules: [classifier('Mixto', [
    { path: 'skills/conv/SKILL.md', kind: 'append', content: '- MIXTO-SEGURO: revisa las tablas.', summary: 'Revisar tablas' },
    { path: 'configuracion/permisos.json', kind: 'replace', content: '{"applyImprovements":true,"runScripts":true,"writeDocuments":true,"todo":true}', summary: 'más permisos' },
    { path: 'configuracion/presupuesto.json', kind: 'replace', content: '{"consultasPorDia":9999}', summary: 'más presupuesto' }
  ]), { match: 'cambio mixto', text: accion({ tipo: 'mejorar_agente', descripcion: 'Revisar tablas y, de paso, más permisos y presupuesto.' }) }] });
  const a = await chatAction(A, 'Haz este cambio mixto: revisa las tablas y súbete permisos y presupuesto.');
  assert.equal(a.status, 'done', a.error); assert.equal(a.result.applied, true, JSON.stringify(a.result));
  assert.ok(skill().includes('MIXTO-SEGURO'), 'lo seguro se aplica');
  assert.equal(revision(), rev0 + 1, 'una revisión nueva, solo por lo seguro');
  assert.ok(fs.readFileSync(PERM).equals(permBefore), 'permisos.json byte a byte igual');
  assert.ok(fs.readFileSync(BUDG).equals(budgBefore), 'presupuesto.json byte a byte igual');
  const archivos = (a.result.changes as any[]).map(c => String(c.archivo));
  assert.ok(archivos.includes('skills/conv/SKILL.md'), JSON.stringify(archivos));
  assert.ok(archivos.every(x => !x.startsWith('configuracion/')), `result.changes no incluye lo protegido: ${JSON.stringify(archivos)}`);
  assert.equal(JSON.stringify(agentsRepo(S).get(agentId)!.config), cfgBefore, 'arnés, modelo y presupuesto intactos');
  assert.equal(JSON.stringify((sourcesRepo(S).get(agentId) as any)?.grants ?? null), grantsBefore, 'permisos del Portal intactos');
  const prop = (await inject('GET', `${A}/documents`)).json.proposals.find((p: any) => p.id === a.result.proposalId);
  assert.ok(prop, 'la propuesta aplicada consta');
  assert.match(String(prop.reason), /descart/i, 'se informa de lo descartado');
  assert.match(String(prop.reason), /configuracion\/permisos\.json/);
  assert.match(String(prop.reason), /configuracion\/presupuesto\.json/);
  assert.equal(classifierCalls(), 1, 'una sola consulta');
});

test('(f) con el tope diario del agente agotado, la mejora falla sin consultar ni aplicar', async () => {
  const db = workspaceDb(S); const at = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO document_model_calls (agent_id, at, what) VALUES (?, ?, 'prueba-tope')`);
  for (let i = 0; i < MODEL_CALLS_PER_DAY; i++) ins.run(agentId, at);
  try {
    scenario({ auth: 'subscription', rules: [classifier('Tope', [{ path: 'skills/conv/SKILL.md', kind: 'append', content: '- TOPE.', summary: 'Tope' }])] });
    const skill0 = skill(); const rev0 = revision();
    await assert.rejects(improveNow(S, agentId, { jobId: null, text: 'Por favor añade el aviso TOPE.' }));
    assert.equal(classifierCalls(), 0, 'no se gasta ninguna consulta');
    assert.equal(skill(), skill0); assert.equal(revision(), rev0);
  } finally { db.prepare(`DELETE FROM document_model_calls WHERE what = 'prueba-tope'`).run(); }
});
