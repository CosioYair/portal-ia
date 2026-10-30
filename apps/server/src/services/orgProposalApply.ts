import type { Agent, AgentConfig, AgentCreateInput, Capability, ModelInfo, OrgAgentSnapshot, OrgApplication, OrgChange, OrgChangeKind, OrgEvaluation, OrgProposal, OrgProposalSpec, ProviderId } from '@portal-ia/domain';
import { CAPABILITIES, ORG_ACTION_LABEL, ORG_TARGET_LABEL, TOOLS, departmentOf, isRetired } from '@portal-ia/domain';
import { providersRepo } from '../db/platform.ts';
import { agentsRepo, processesRepo, workspaceDb } from '../db/workspace.ts';
import { orgEvaluationsRepo } from '../db/orgEvaluationSchema.ts';
import { createAgent, deleteAgent } from './agentFactory.ts';
import { monotonicNow } from '../clock.ts';

/**
 * HU-159 · Aplicación de propuestas organizativas aceptadas por el propietario (sin IA, sin costo).
 * 1) planProposal valida sin escribir: sujeto (solo agentes activos del ámbito de la evaluación, sin ambigüedad),
 *    spec, jerarquía, herramientas (mínimo privilegio) y agentes protegidos. Error → 422/409 y la propuesta sigue pendiente.
 * 2) acceptProposal ejecuta en UNA transacción los cambios, la decisión, la auditoría (org_change:apply) y la nota en
 *    Conocimiento, guardando la foto previa (before/after) de cada agente tocado.
 * 3) revertProposal restaura las fotos previas (org_change:undo) si nadie ha editado esos agentes después.
 * Retirar = template.retiredAt (reversible, la fila se conserva). Departamento = etiqueta template.department.
 */
const httpError = (statusCode: number, message: string, code?: string) => Object.assign(new Error(message), { statusCode, code });
const now = monotonicNow;
const stamp = (iso: string | null | undefined) => (iso ?? now()).slice(0, 16).replace('T', ' ');
const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[«»"'`]/g, '').replace(/\s+/g, ' ').trim();
const withExtra = (t: Agent['template'], extra: Record<string, unknown>) => ({ ...t, ...extra }) as Agent['template'];
const snapOf = (a: Agent): OrgAgentSnapshot => ({ config: a.config, template: a.template, configEdited: a.configEdited });
const sameState = (a: Agent, s: OrgAgentSnapshot | null) => !!s && JSON.stringify([a.config, a.template]) === JSON.stringify([s.config, s.template]);
const OP_LABEL: Record<OrgChange['op'], string> = { create: 'creado', update: 'ajustado', retire: 'retirado', unretire: 'reactivado' };
const title = (p: OrgProposal) => `${ORG_ACTION_LABEL[p.action]} ${ORG_TARGET_LABEL[p.target]} «${p.subject}»`;

/** Transacción sobre la conexión única del espacio; si ya hay una abierta, se reutiliza. fn debe ser síncrona. */
const txOpen = new Set<string>();
export function withTx<T>(slug: string, fn: () => T): T {
  if (txOpen.has(slug)) return fn();
  const db = workspaceDb(slug);
  db.exec('BEGIN IMMEDIATE'); txOpen.add(slug);
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* ya revertida */ } throw e; }
  finally { txOpen.delete(slug); }
}

function providerModels(provider: string): ModelInfo[] {
  const p = providersRepo.get(provider as ProviderId);
  if (!p) return [];
  try { const v = JSON.parse(p.models_json); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** Catálogo que el Gestor debe usar en cada spec (herramientas con riesgo, capacidades, modelos y mínimo privilegio). */
export function orgCatalog(slug: string): string {
  const gestor = agentsRepo(slug).list().find(a => a.key === 'ws-gestor');
  const models = gestor ? providerModels(gestor.config.provider) : [];
  return [
    `Herramientas (id · riesgo): ${TOOLS.map(t => `${t.id} · ${t.risk === 'auth' ? 'requiere autorización' : 'local'}`).join(', ')}.`,
    `Capacidades (id · qué permite en una historia): ${CAPABILITIES.map(c => `${c.id} · ${c.label}`).join(', ')}.`,
    `Modelos disponibles (id · nivel): ${models.map(m => `${m.id} · ${m.tier}`).join(', ') || '—'}.`,
    'Mínimo privilegio: activa solo las herramientas imprescindibles; write_repo solo para quien tiene la capacidad implementar; read_repo para quien revisa o consulta.'
  ].join('\n');
}

function scopeAgents(slug: string, ev: OrgEvaluation): Agent[] {
  return agentsRepo(slug).list().filter(a => !ev.projectId || a.scope === 'workspace' || a.projectId === ev.projectId);
}
const splitSubjects = (s: string) => s.split(/\s*\+\s*|\s*,\s*/).map(x => x.trim()).filter(Boolean);
const uniqById = (list: Agent[]) => list.filter((a, i) => list.findIndex(b => b.id === a.id) === i);

/** Agente activo del ámbito de la evaluación por clave o nombre (acepta «Nombre (clave)»). 422 si no existe o es ambiguo. */
export function resolveSubject(slug: string, ev: OrgEvaluation, ref: string): Agent {
  const pool = scopeAgents(slug, ev).filter(a => !isRetired(a.template));
  const inParens = /\(([^)]+)\)\s*$/.exec(ref)?.[1];
  for (const cand of [inParens, ref].filter((x): x is string => !!x)) {
    const q = norm(cand);
    const byKey = pool.filter(a => norm(a.key) === q);
    const hits = byKey.length ? byKey : pool.filter(a => norm(a.config.name) === q);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw httpError(422, `«${ref}» es ambiguo: coincide con ${hits.map(a => `${a.config.name} (${a.key})`).join(', ')}.`, 'invalid_subject');
  }
  throw httpError(422, `No existe un agente activo «${ref}» en el ámbito evaluado.`, 'invalid_subject');
}

function departmentAgents(slug: string, ev: OrgEvaluation, label: string): Agent[] {
  const q = norm(label);
  return scopeAgents(slug, ev).filter(a => !isRetired(a.template) && norm(departmentOf(a.template) ?? '') === q);
}

/** Jefe válido dentro del ámbito: agentes de empresa o del mismo proyecto (projectId) que el subordinado. */
function resolveKey(all: Agent[], ref: string, projectId: string | null): string {
  const q = norm(ref);
  if (q === 'owner' || q === 'propietario') return 'owner';
  const active = all.filter(a => !isRetired(a.template) && (a.scope === 'workspace' || (projectId !== null && a.projectId === projectId)));
  const byKey = active.filter(a => norm(a.key) === q);
  const hits = byKey.length ? byKey : active.filter(a => norm(a.config.name) === q);
  if (hits.length === 1) return hits[0].key;
  if (hits.length > 1) throw httpError(422, `«${ref}» es ambiguo: coincide con ${hits.map(a => `${a.config.name} (${a.key})`).join(', ')}.`, 'invalid_spec');
  throw httpError(422, `«${ref}» no es un agente activo del ámbito al que se pueda reportar.`, 'invalid_spec');
}

function toolsFor(list: string[], caps: readonly string[], warnings: string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const t of list) {
    if (!TOOLS.some(x => x.id === t)) { warnings.push(`Herramienta desconocida descartada: ${t}.`); continue; }
    if (t === 'write_repo' && !caps.includes('implementar')) { warnings.push('write_repo descartada: solo la recibe un agente con la capacidad «implementar» (mínimo privilegio).'); continue; }
    out[t] = true;
  }
  return out;
}
const validCaps = (list: string[] | undefined) => (list ?? []).filter(c => CAPABILITIES.some(k => k.id === c)) as Capability[];

function assertRetirable(all: Agent[], a: Agent, retiring: Set<string>) {
  if (a.key === 'ws-gestor') throw httpError(422, 'No se puede retirar al Gestor Organizacional.', 'protected_agent');
  if (a.key === 'pj-coordinador' && !all.some(x => x.key === 'pj-coordinador' && x.projectId === a.projectId && !isRetired(x.template) && !retiring.has(x.id))) {
    throw httpError(422, 'No se puede retirar al último Coordinador del proyecto.', 'protected_agent');
  }
  if (a.status === 'active') throw httpError(409, `«${a.config.name}» participa ahora en un proceso: espera a que termine.`, 'agent_busy');
}

type Op =
  | { kind: 'create'; input: AgentCreateInput; department: string | null }
  | { kind: 'update'; agentId: string; spec: OrgProposalSpec; identity: boolean }
  | { kind: 'retire'; agentId: string };
interface Plan { ops: Op[]; warnings: string[] }

function createOp(all: Agent[], ev: OrgEvaluation, spec: OrgProposalSpec, department: string | null, warnings: string[]): Op {
  if (!spec.name) throw httpError(422, 'El agente nuevo necesita un nombre (spec.name).', 'invalid_spec');
  const gestor = all.find(a => a.key === 'ws-gestor');
  if (!gestor) throw httpError(409, 'Falta el Gestor Organizacional (ws-gestor) en esta empresa.', 'missing_agent');
  const models = providerModels(gestor.config.provider);
  const model = spec.model && models.some(m => m.id === spec.model) ? spec.model : gestor.config.model;
  if (spec.model && model !== spec.model) warnings.push(`Modelo «${spec.model}» no disponible: se usa ${model}, el del Gestor.`);
  const caps = validCaps(spec.capabilities); const capabilities: Capability[] = caps.length ? caps : ['consultar'];
  const tools = spec.tools ? toolsFor(spec.tools, capabilities, warnings) : { read_repo: true };
  const coordinator = ev.projectId ? all.find(a => a.key === 'pj-coordinador' && a.projectId === ev.projectId && !isRetired(a.template)) : undefined;
  const reportsTo = spec.reportsTo ? resolveKey(all, spec.reportsTo, ev.projectId ?? null) : (coordinator?.key ?? 'ws-gestor');
  const config: AgentConfig = {
    ...gestor.config, name: spec.name, specialization: spec.specialization || spec.role || spec.name,
    responsibilities: spec.responsibilities?.length ? spec.responsibilities : [spec.specialization || spec.name],
    provider: gestor.config.provider, model, effort: spec.effort ?? 'medium', tools,
    knowledge: { objectives: true, context: true, history: true, ...(ev.projectId ? { repo: true } : {}) },
    monthlyLimitUsd: 20, perTaskAuthUsd: 2, fallbacks: [], capabilities
  };
  const input = {
    scope: ev.projectId ? 'project' : 'workspace', ...(ev.projectId ? { projectId: ev.projectId } : {}),
    name: spec.name, role: spec.role || spec.name, reportsTo, collaborates: [], evaluation: [], config
  } as AgentCreateInput;
  return { kind: 'create', input, department };
}

/** Valida la propuesta y calcula las operaciones, SIN escribir nada. */
export function planProposal(slug: string, ev: OrgEvaluation, p: OrgProposal): Plan {
  const all = agentsRepo(slug).list();
  const warnings = [...(p.specWarnings ?? [])];
  const ops: Op[] = []; const retiring = new Set<string>(); const touched = new Set<string>();
  const needSpec = (): OrgProposalSpec => { if (!p.spec) throw httpError(422, 'La propuesta no trae configuración (spec).', 'invalid_spec'); return p.spec; };
  const retire = (a: Agent) => {
    if (touched.has(a.id)) return; touched.add(a.id); retiring.add(a.id);
    assertRetirable(all, a, retiring); ops.push({ kind: 'retire', agentId: a.id });
  };
  const update = (a: Agent, spec: OrgProposalSpec, identity: boolean) => {
    if (touched.has(a.id)) return; touched.add(a.id);
    if (a.status === 'active') throw httpError(409, `«${a.config.name}» participa ahora en un proceso: espera a que termine.`, 'agent_busy');
    const s: OrgProposalSpec = { ...spec };
    if (s.reportsTo) {
      const k = resolveKey(all, s.reportsTo, a.projectId ?? null);
      if (k === a.key) { if (identity) throw httpError(422, 'Un agente no puede reportarse a sí mismo.', 'invalid_spec'); delete s.reportsTo; }
      else s.reportsTo = k;
    }
    ops.push({ kind: 'update', agentId: a.id, spec: s, identity });
  };

  if (p.target === 'agent') {
    if (p.action === 'add') { const spec = needSpec(); ops.push(createOp(all, ev, spec, spec.department ?? null, warnings)); }
    else if (p.action === 'adjust') update(resolveSubject(slug, ev, p.subject), needSpec(), true);
    else if (p.action === 'retire') { for (const s of splitSubjects(p.subject)) retire(resolveSubject(slug, ev, s)); }
    else {
      const subs = uniqById(splitSubjects(p.subject).map(s => resolveSubject(slug, ev, s)));
      if (subs.length < 2) throw httpError(422, 'Una fusión necesita al menos dos agentes distintos («A + B»).', 'invalid_subject');
      const keep = p.keep ? resolveSubject(slug, ev, p.keep) : subs[0];
      if (!subs.some(a => a.id === keep.id)) throw httpError(422, `«${p.keep}» no está entre los agentes a fusionar.`, 'invalid_subject');
      if (p.spec) update(keep, p.spec, true);
      for (const a of subs) if (a.id !== keep.id) retire(a);
    }
  } else if (p.action === 'add') {
    const spec = needSpec(); const dept = spec.department || p.subject;
    for (const s of spec.agents ?? []) ops.push(createOp(all, ev, s, dept, warnings));
    for (const m of spec.members ?? []) update(resolveSubject(slug, ev, m), { department: dept }, false);
    if (!spec.agents?.length && !spec.members?.length) {
      if (!spec.name) throw httpError(422, 'Indica en spec.agents los agentes nuevos del departamento o en spec.members los existentes.', 'invalid_spec');
      ops.push(createOp(all, ev, spec, dept, warnings));
    }
  } else if (p.action === 'merge') {
    const labels = splitSubjects(p.subject);
    if (labels.length < 2) throw httpError(422, 'Una fusión necesita al menos dos departamentos («A + B»).', 'invalid_subject');
    const groups = labels.map(label => ({ label, agents: departmentAgents(slug, ev, label) }));
    const empty = groups.find(g => !g.agents.length);
    if (empty) throw httpError(422, `No hay agentes activos en el departamento «${empty.label}».`, 'invalid_subject');
    let keepLabel: string;
    if (p.keep) {
      const kept = groups.find(g => norm(g.label) === norm(p.keep!));
      if (!kept) throw httpError(422, `«${p.keep}» no está entre los departamentos a fusionar.`, 'invalid_subject');
      keepLabel = departmentOf(kept.agents[0].template) ?? kept.label;
    } else keepLabel = p.spec?.department || (departmentOf(groups[0].agents[0].template) ?? groups[0].label);
    for (const g of groups) for (const a of g.agents) update(a, { ...(p.spec ?? {}), department: keepLabel }, false);
  } else {
    const members = departmentAgents(slug, ev, p.subject);
    if (!members.length) throw httpError(422, `No hay agentes activos en el departamento «${p.subject}».`, 'invalid_subject');
    if (p.action === 'retire') for (const a of members) retire(a);
    else { const spec = needSpec(); for (const a of members) update(a, spec, false); }
  }

  const retiringKeys = new Set(all.filter(a => retiring.has(a.id)).map(a => a.key));
  for (const op of ops) {
    const rt = op.kind === 'create' ? op.input.reportsTo : op.kind === 'update' ? op.spec.reportsTo : undefined;
    if (rt && retiringKeys.has(rt)) throw httpError(422, `No se puede reportar a «${rt}»: esta misma propuesta lo retira.`, 'invalid_spec');
  }
  if (!ops.length) throw httpError(422, 'La propuesta no afecta a ningún agente.', 'invalid_subject');
  return { ops, warnings };
}

/** Ejecuta las operaciones (dentro de withTx) y devuelve los cambios con su foto previa y posterior. */
function execute(slug: string, plan: Plan): OrgChange[] {
  const agents = agentsRepo(slug);
  const before = new Map<string, OrgAgentSnapshot | null>(); const opOf = new Map<string, OrgChange['op']>();
  const RANK: Record<OrgChange['op'], number> = { update: 1, unretire: 1, retire: 2, create: 3 };
  const touch = (id: string, op: OrgChange['op']) => {
    if (!before.has(id)) { const a = agents.get(id); if (a) before.set(id, snapOf(a)); }
    const prev = opOf.get(id); if (!prev || RANK[op] > RANK[prev]) opOf.set(id, op);
  };
  // Jefe dentro del ámbito: primero el del mismo proyecto, luego el de empresa (nunca el de otro proyecto).
  const findBoss = (key: string, projectId: string | null) => {
    const all = agents.list();
    return all.find(a => a.key === key && projectId !== null && a.projectId === projectId) ?? all.find(a => a.key === key && a.scope === 'workspace');
  };
  const retiringIds = new Set(plan.ops.flatMap(o => (o.kind === 'retire' ? [o.agentId] : [])));
  for (const op of plan.ops) {
    if (op.kind === 'create') {
      // createAgent añade el nuevo a «supervisa» de su jefe: foto previa del jefe ANTES de crear.
      if (op.input.reportsTo !== 'owner') { const boss = findBoss(op.input.reportsTo, op.input.scope === 'project' ? (op.input.projectId ?? null) : null); if (boss) touch(boss.id, 'update'); }
      const created = createAgent(slug, op.input);
      before.set(created.id, null); opOf.set(created.id, 'create');
      if (op.department) agents.updateTemplateMeta(created.id, withExtra(agents.get(created.id)!.template, { department: op.department }));
      continue;
    }
    const cur = agents.get(op.agentId);
    if (!cur) throw httpError(409, 'Un agente afectado cambió durante la aplicación.', 'conflict');
    if (op.kind === 'retire') {
      touch(cur.id, 'retire');
      // Nuevo jefe de sus subordinados: el jefe del retirado, saltando a los que esta propuesta también retira.
      let up: Agent = cur; let nb: Agent | undefined; let guard = 0;
      while (up.template.reportsTo !== 'owner' && guard++ < 50) {
        const b = findBoss(up.template.reportsTo, up.projectId ?? null);
        if (!b || b.id === up.id) break;
        if (!retiringIds.has(b.id) && !isRetired(b.template)) { nb = b; break; }
        up = agents.get(b.id) ?? b;
      }
      const newBossKey = nb?.key ?? 'owner';
      // El retirado sale de «supervisa» de su jefe directo.
      if (cur.template.reportsTo !== 'owner') {
        const old = findBoss(cur.template.reportsTo, cur.projectId ?? null);
        if (old && old.id !== cur.id) {
          const o = agents.get(old.id)!;
          if (o.template.supervises.includes(cur.key)) {
            touch(o.id, 'update');
            agents.updateTemplateMeta(o.id, { ...o.template, supervises: o.template.supervises.filter(k => k !== cur.key) });
          }
        }
      }
      // Subordinados activos (que no se retiran aquí) pasan a reportar al nuevo jefe; foto previa para «Deshacer».
      const subs = agents.list().filter(x => x.id !== cur.id && x.template.reportsTo === cur.key && !isRetired(x.template)
        && !retiringIds.has(x.id) && findBoss(x.template.reportsTo, x.projectId ?? null)?.id === cur.id);
      for (const sub of subs) {
        touch(sub.id, 'update');
        agents.updateTemplateMeta(sub.id, { ...agents.get(sub.id)!.template, reportsTo: newBossKey });
        if (nb) {
          const n = agents.get(nb.id)!;
          if (!n.template.supervises.includes(sub.key)) { touch(n.id, 'update'); agents.updateTemplateMeta(n.id, { ...n.template, supervises: [...n.template.supervises, sub.key] }); }
        }
        plan.warnings.push(`${sub.config.name} pasa a reportar a ${nb ? nb.config.name : 'el propietario'} porque ${cur.config.name} se retira.`);
      }
      const fresh = agents.get(cur.id)!;
      agents.updateTemplateMeta(cur.id, withExtra({ ...fresh.template, supervises: fresh.template.supervises.filter(k => !subs.some(s => s.key === k)) }, { retiredAt: now(), retiredBy: 'owner' }));
      continue;
    }
    touch(cur.id, 'update');
    const s = op.spec;
    const given = validCaps(s.capabilities);
    const caps: Capability[] = given.length ? given : (cur.config.capabilities ?? []);
    const tools: Record<string, boolean> = s.tools ? toolsFor(s.tools, caps, plan.warnings) : { ...(cur.config.tools as Record<string, boolean>) };
    if (given.length && !caps.includes('implementar') && tools.write_repo) {
      delete tools.write_repo; plan.warnings.push(`write_repo retirada a ${cur.config.name}: ya no implementa (mínimo privilegio).`);
    }
    const models = providerModels(cur.config.provider);
    const model = s.model && models.some(m => m.id === s.model) ? s.model : cur.config.model;
    if (s.model && model !== s.model) plan.warnings.push(`Modelo «${s.model}» no disponible para ${cur.config.name}: se mantiene ${model}.`);
    const config: AgentConfig = {
      ...cur.config,
      ...(op.identity && s.name ? { name: s.name } : {}),
      ...(op.identity && s.specialization ? { specialization: s.specialization } : {}),
      ...(op.identity && s.responsibilities?.length ? { responsibilities: s.responsibilities } : {}),
      ...(s.effort ? { effort: s.effort } : {}),
      tools, capabilities: caps, model, fallbacks: (cur.config.fallbacks ?? []).filter(f => f !== model)
    };
    if (JSON.stringify(config) !== JSON.stringify(cur.config)) agents.updateConfig(cur.id, config);
    const tpl = agents.get(cur.id)!.template;
    const extra: Record<string, unknown> = {};
    if (op.identity && s.role) extra.role = s.role;
    if (s.department) extra.department = s.department;
    if (s.reportsTo && s.reportsTo !== tpl.reportsTo) {
      if (tpl.reportsTo !== 'owner') {
        const old = findBoss(tpl.reportsTo, cur.projectId);
        if (old && old.template.supervises.includes(cur.key)) {
          touch(old.id, 'update'); const o = agents.get(old.id)!;
          agents.updateTemplateMeta(o.id, { ...o.template, supervises: o.template.supervises.filter(k => k !== cur.key) });
        }
      }
      if (s.reportsTo !== 'owner') {
        const nb = findBoss(s.reportsTo, cur.projectId);
        if (nb && nb.id !== cur.id) {
          touch(nb.id, 'update'); const n = agents.get(nb.id)!;
          if (!n.template.supervises.includes(cur.key)) agents.updateTemplateMeta(n.id, { ...n.template, supervises: [...n.template.supervises, cur.key] });
        }
      }
      extra.reportsTo = s.reportsTo;
    }
    if (Object.keys(extra).length) agents.updateTemplateMeta(cur.id, withExtra(agents.get(cur.id)!.template, extra));
  }
  return [...opOf.entries()].map(([id, op]) => {
    const a = agents.get(id)!;
    return { op, agentId: id, agentKey: a.key, agentName: a.config.name, before: before.get(id) ?? null, after: snapOf(a) };
  });
}

function audit(slug: string, ev: OrgEvaluation, changes: OrgChange[], kind: OrgChangeKind, startedAt: string) {
  const procs = processesRepo(slug);
  for (const c of changes) procs.logExecution({ projectId: ev.anchorProjectId, agentId: c.agentId, kind, status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt });
}

/** Una sola fila de registro (coste 0) para una decisión sin cambios en agentes; se atribuye al Gestor Organizacional. */
function auditDecision(slug: string, ev: OrgEvaluation, kind: OrgChangeKind) {
  const all = agentsRepo(slug).list();
  const gestor = all.find(a => a.key === 'ws-gestor') ?? all[0];
  if (!gestor) return;
  processesRepo(slug).logExecution({ projectId: ev.anchorProjectId, agentId: gestor.id, kind, status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: now() });
}

function appendDoc(slug: string, ev: OrgEvaluation, line: string) {
  if (ev.knowledgeDocId) workspaceDb(slug).prepare(`UPDATE knowledge SET body = body || ? WHERE id = ?`).run(line, ev.knowledgeDocId);
}

const changeList = (changes: OrgChange[]) => changes.map(c => `${OP_LABEL[c.op]} ${c.agentName} (${c.agentKey})`).join('; ');

function loadProposal(slug: string, evalId: string, proposalId: string) {
  const evals = orgEvaluationsRepo(slug);
  const ev = evals.get(evalId);
  if (!ev) throw httpError(404, 'Evaluación no encontrada');
  if (ev.status !== 'done') throw httpError(409, 'La evaluación aún no ha terminado.', 'not_finished');
  const p = ev.proposals.find(x => x.id === proposalId);
  if (!p) throw httpError(404, 'Propuesta no encontrada');
  return { evals, ev, p };
}

/**
 * Acepta y aplica UNA propuesta. Valida antes de escribir (422/409 → sigue pendiente, sin cambios parciales).
 * Propuestas antiguas sin spec en add/adjust: solo se registra la decisión (no hay configuración que aplicar).
 */
export function acceptProposal(slug: string, evalId: string, proposalId: string, confirmed = false): { evaluation: OrgEvaluation; proposal: OrgProposal } {
  const { evals, ev, p } = loadProposal(slug, evalId, proposalId);
  if (p.decision !== 'pending') throw httpError(409, `La propuesta ya está ${p.decision === 'accepted' ? 'aceptada' : 'rechazada'}.`, 'already_decided');
  const recordOnly = !p.spec && (p.action === 'add' || p.action === 'adjust');
  // Aplicar cambia la organización: exige confirmación explícita. Registrar una propuesta sin spec no la necesita.
  if (!recordOnly && !confirmed) throw httpError(400, 'Aceptar aplica cambios en la organización: requiere confirmación explícita (confirm: true).', 'confirmation_required');
  if (recordOnly) {
    return withTx(slug, () => {
      const r = evals.setProposalDecision(evalId, proposalId, 'accepted', 'owner');
      appendDoc(slug, ev, `\n- ${stamp(r.proposal.decidedAt)} · ${p.id} · Aceptada: ${title(p)}. Sin configuración propuesta (evaluación anterior): no se aplicó automáticamente.`);
      return r;
    });
  }
  const plan = planProposal(slug, ev, p);
  const startedAt = now();
  try {
    return withTx(slug, () => {
      const changes = execute(slug, plan);
      const r = evals.setProposalDecision(evalId, proposalId, 'accepted', 'owner');
      const warnings = [...new Set(plan.warnings)];
      const application: OrgApplication = { status: 'applied', appliedAt: now(), revertedAt: null, error: null, changes, ...(warnings.length ? { warnings } : {}) };
      const proposal: OrgProposal = { ...r.proposal, application };
      const evaluation = evals.update(evalId, { proposals: r.evaluation.proposals.map(x => (x.id === proposalId ? proposal : x)) });
      audit(slug, ev, changes, 'org_change:apply', startedAt);
      appendDoc(slug, ev, `\n- ${stamp(r.proposal.decidedAt)} · ${p.id} · Aceptada y aplicada automáticamente (deshacer disponible): ${title(p)} → ${changeList(changes)}.${warnings.length ? ` Avisos: ${warnings.join(' ')}` : ''}`);
      return { evaluation, proposal };
    });
  } catch (err: any) {
    const e = err?.statusCode === 400 ? httpError(422, err.message, 'invalid_spec') : err;
    // La transacción ya se revirtió: solo se anota el fallo; la propuesta sigue pendiente.
    try {
      const fresh = evals.get(evalId);
      if (fresh) evals.update(evalId, { proposals: fresh.proposals.map(x => (x.id === proposalId && x.decision === 'pending' ? { ...x, application: { status: 'failed' as const, appliedAt: null, revertedAt: null, error: String(e?.message ?? e), changes: [] } } : x)) });
    } catch { /* sin anotación */ }
    throw e;
  }
}

/** Deshace una propuesta aplicada restaurando las fotos previas. 409 stale_undo si algún agente cambió después. */
export function revertProposal(slug: string, evalId: string, proposalId: string): { evaluation: OrgEvaluation; proposal: OrgProposal } {
  const { evals, ev, p } = loadProposal(slug, evalId, proposalId);
  const app = p.application;
  if (p.decision !== 'accepted' || !app || app.status !== 'applied') throw httpError(409, 'Esta propuesta no tiene cambios aplicados que deshacer.', 'not_applied');
  const agents = agentsRepo(slug);
  for (const c of app.changes) {
    const cur = agents.get(c.agentId);
    if (!cur || !sameState(cur, c.after)) throw httpError(409, `«${c.agentName}» cambió después de aplicar la propuesta: deshacer sobrescribiría esos cambios.`, 'stale_undo');
    if (c.op === 'create' && cur.status === 'active') throw httpError(409, `«${c.agentName}» participa ahora en un proceso: espera a que termine.`, 'agent_busy');
  }
  const startedAt = now();
  return withTx(slug, () => {
    for (const c of app.changes.filter(x => x.op === 'create')) deleteAgent(slug, c.agentId);
    const upd = workspaceDb(slug).prepare(`UPDATE agents SET config_json = ?, template_json = ?, config_edited = ?, updated_at = ? WHERE id = ?`);
    for (const c of app.changes) if (c.op !== 'create' && c.before) upd.run(JSON.stringify(c.before.config), JSON.stringify(c.before.template), c.before.configEdited ? 1 : 0, now(), c.agentId);
    const application: OrgApplication = { ...app, status: 'reverted', revertedAt: now() };
    const proposal: OrgProposal = { ...p, application };
    const fresh = evals.get(evalId)!;
    const evaluation = evals.update(evalId, { proposals: fresh.proposals.map(x => (x.id === proposalId ? proposal : x)) });
    audit(slug, ev, app.changes, 'org_change:undo', startedAt);
    const undone = app.changes.map(c => `${c.op === 'create' ? 'eliminado' : c.op === 'retire' ? 'reactivado' : 'restaurado'} ${c.agentName} (${c.agentKey})`).join('; ');
    appendDoc(slug, ev, `\n- ${stamp(application.revertedAt)} · ${p.id} · Deshecha por el propietario: ${title(p)} → ${undone}.`);
    return { evaluation, proposal };
  });
}

/** Rechaza UNA propuesta pendiente (sin cambios en la organización). Exige confirmación explícita. */
export function rejectProposal(slug: string, evalId: string, proposalId: string, confirmed = false): { evaluation: OrgEvaluation; proposal: OrgProposal } {
  const { evals, ev, p } = loadProposal(slug, evalId, proposalId);
  if (p.decision !== 'pending') throw httpError(409, `La propuesta ya está ${p.decision === 'accepted' ? 'aceptada' : 'rechazada'}.`, 'already_decided');
  if (confirmed !== true) throw httpError(400, 'Rechazar una propuesta requiere confirmación explícita (confirm: true).', 'confirmation_required');
  return withTx(slug, () => {
    const r = evals.setProposalDecision(evalId, proposalId, 'rejected', 'owner');
    auditDecision(slug, ev, 'org_change:reject');
    appendDoc(slug, ev, `\n- ${stamp(r.proposal.decidedAt)} · ${p.id} · Rechazada: ${title(p)}. Sin cambios en la organización (puede reabrirse).`);
    return r;
  });
}

/** Reabre una propuesta rechazada: vuelve a 'pending' para poder aceptarla y aplicarla. Exige confirmación. */
export function reopenProposal(slug: string, evalId: string, proposalId: string, confirmed = false): { evaluation: OrgEvaluation; proposal: OrgProposal } {
  const { evals, ev, p } = loadProposal(slug, evalId, proposalId);
  if (p.decision !== 'rejected') throw httpError(409, 'Solo se puede reabrir una propuesta rechazada.', 'not_rejected');
  if (confirmed !== true) throw httpError(400, 'Reabrir una propuesta requiere confirmación explícita (confirm: true).', 'confirmation_required');
  return withTx(slug, () => {
    const { application: _drop, ...rest } = p;
    const proposal: OrgProposal = { ...rest, decision: 'pending', decidedAt: null, decidedBy: null, reopenedAt: now() };
    const fresh = evals.get(evalId)!;
    const evaluation = evals.update(evalId, { proposals: fresh.proposals.map(x => (x.id === proposalId ? proposal : x)) });
    auditDecision(slug, ev, 'org_change:reopen');
    appendDoc(slug, ev, `\n- ${stamp(proposal.reopenedAt)} · ${p.id} · Reabierta por el propietario: vuelve a pendiente.`);
    return { evaluation, proposal };
  });
}

/**
 * Vuelve a aplicar una propuesta aceptada y deshecha. Se valida contra la organización ACTUAL (422/409 → sigue
 * revertida, sin cambios parciales) y se ejecuta en una transacción con fotos previas nuevas: se puede deshacer otra vez.
 */
export function reapplyProposal(slug: string, evalId: string, proposalId: string, confirmed = false): { evaluation: OrgEvaluation; proposal: OrgProposal } {
  const { evals, ev, p } = loadProposal(slug, evalId, proposalId);
  const app = p.application;
  if (p.decision !== 'accepted' || !app || app.status !== 'reverted') throw httpError(409, 'Solo se puede volver a aplicar una propuesta aceptada y deshecha.', 'not_reverted');
  if (confirmed !== true) throw httpError(400, 'Volver a aplicar cambia la organización: requiere confirmación explícita (confirm: true).', 'confirmation_required');
  const startedAt = now();
  try {
    const plan = planProposal(slug, ev, p);
    return withTx(slug, () => {
      const changes = execute(slug, plan);
      const warnings = [...new Set(plan.warnings)];
      const at = now();
      const application: OrgApplication = {
        status: 'applied', appliedAt: at, revertedAt: null, error: null, changes,
        reappliedAt: at, reapplyCount: (app.reapplyCount ?? 0) + 1, ...(warnings.length ? { warnings } : {})
      };
      const proposal: OrgProposal = { ...p, application };
      const fresh = evals.get(evalId)!;
      const evaluation = evals.update(evalId, { proposals: fresh.proposals.map(x => (x.id === proposalId ? proposal : x)) });
      audit(slug, ev, changes, 'org_change:reapply', startedAt);
      appendDoc(slug, ev, `\n- ${stamp(at)} · ${p.id} · Vuelta a aplicar (deshacer disponible): ${title(p)} → ${changeList(changes)}.${warnings.length ? ` Avisos: ${warnings.join(' ')}` : ''}`);
      return { evaluation, proposal };
    });
  } catch (err: any) {
    const e = err?.statusCode === 400 ? httpError(422, err.message, 'invalid_spec') : err;
    // Sin cambios parciales: la propuesta sigue revertida; solo se anota el error.
    try {
      const fresh = evals.get(evalId);
      if (fresh) evals.update(evalId, { proposals: fresh.proposals.map(x => (x.id === proposalId && x.application?.status === 'reverted' ? { ...x, application: { ...x.application, error: String(e?.message ?? e) } } : x)) });
    } catch { /* sin anotación */ }
    throw e;
  }
}
