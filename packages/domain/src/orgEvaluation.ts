/**
 * Evaluación organizativa (HU-159). El Gestor Organizacional (con el Coordinador si el ámbito es un proyecto) analiza
 * la organización real y propone añadir, fusionar, retirar o ajustar agentes o departamentos. Cada propuesta trae su
 * configuración concreta (spec); nada se aplica sin la aprobación del propietario: al aceptarla, el servidor la aplica
 * (con foto previa para deshacer) y rechazarla solo registra la decisión. Retirar = desactivar de forma reversible
 * (template.retiredAt). Un departamento es la etiqueta template.department de sus agentes.
 * Este módulo es puro (sin IO).
 */
import type { Agent, AgentConfig } from './types.ts';
import { TOOLS } from './templates.ts';
// Ciclo seguro: CAPABILITIES solo se usa dentro de funciones, nunca al evaluar el módulo.
import { CAPABILITIES } from './index.ts';
export type OrgEvaluationScope = { kind: 'workspace' } | { kind: 'project'; projectId: string };
export type OrgScopeKind = OrgEvaluationScope['kind'];
export type OrgAction = 'add' | 'merge' | 'retire' | 'adjust';
export type OrgTarget = 'agent' | 'department';
export type OrgDecision = 'pending' | 'accepted' | 'rejected';
export type OrgEvaluationStatus = 'pending_authorization' | 'running' | 'done' | 'failed' | 'cancelled';

export const ORG_ACTIONS: readonly OrgAction[] = ['add', 'merge', 'retire', 'adjust'];
export const ORG_TARGETS: readonly OrgTarget[] = ['agent', 'department'];
export const ORG_ACTION_LABEL: Record<OrgAction, string> = { add: 'Añadir', merge: 'Fusionar', retire: 'Retirar', adjust: 'Ajustar' };
export const ORG_TARGET_LABEL: Record<OrgTarget, string> = { agent: 'agente', department: 'departamento' };
/** Tipos de registro (execution_history.kind) de los cambios organizativos decididos por el propietario: coste 0, sin IA. */
export const ORG_CHANGE_KINDS = ['org_change:apply', 'org_change:undo', 'org_change:reapply', 'org_change:reject', 'org_change:reopen'] as const;
export type OrgChangeKind = typeof ORG_CHANGE_KINDS[number];

export interface OrgProposal {
  id: string;
  action: OrgAction;
  target: OrgTarget;
  /** Agente o departamento afectado (nombre o clave); en «merge», los implicados separados por « + ». */
  subject: string;
  /** Justificación basada en el contenido real del proyecto (obligatoria). */
  rationale: string;
  details: string;
  decision: OrgDecision;
  decidedAt: string | null;
  decidedBy: string | null;
  /** Configuración concreta propuesta por el Gestor (ausente en las propuestas antiguas). */
  spec?: OrgProposalSpec;
  /** En «merge»: agente o departamento que se conserva. */
  keep?: string;
  /** Avisos de normalización (p. ej. herramientas fuera del catálogo descartadas). */
  specWarnings?: string[];
  /** Resultado de aplicar la propuesta aceptada (con fotos previas para deshacer). */
  application?: OrgApplication;
  /** Momento en que el propietario reabrió una propuesta rechazada (vuelve a 'pending'). */
  reopenedAt?: string | null;
}

export type OrgEffort = 'low' | 'medium' | 'high';

export interface OrgProposalSpec {
  name?: string;
  role?: string;
  specialization?: string;
  responsibilities?: string[];
  /** Clave (o nombre) del agente al que reporta, u «owner». */
  reportsTo?: string;
  /** Ids del catálogo TOOLS (los desconocidos ya se descartaron). */
  tools?: string[];
  /** Ids del catálogo CAPABILITIES (los desconocidos ya se descartaron). */
  capabilities?: string[];
  model?: string;
  effort?: OrgEffort;
  /** Etiqueta de departamento. */
  department?: string;
  /** Solo al añadir un departamento: agentes nuevos que lo forman. */
  agents?: OrgProposalSpec[];
  /** Solo al añadir un departamento: agentes existentes (clave o nombre) que pasan a él. */
  members?: string[];
}

export type OrgChangeOp = 'create' | 'update' | 'retire' | 'unretire';
export interface OrgAgentSnapshot { config: AgentConfig; template: Agent['template']; configEdited?: boolean }
export interface OrgChange {
  op: OrgChangeOp;
  agentId: string;
  agentKey: string;
  agentName: string;
  /** null si el agente lo creó la propia aplicación. */
  before: OrgAgentSnapshot | null;
  after: OrgAgentSnapshot | null;
}
export interface OrgApplication {
  status: 'applied' | 'reverted' | 'failed';
  appliedAt: string | null;
  revertedAt: string | null;
  error: string | null;
  changes: OrgChange[];
  warnings?: string[];
  /** Última vez que se volvió a aplicar tras deshacerla. */
  reappliedAt?: string | null;
  /** Veces que se ha vuelto a aplicar. */
  reapplyCount?: number;
}

/** Agente desactivado por una decisión organizativa (reversible: la fila se conserva). */
export function isRetired(template: unknown): boolean {
  if (!template || typeof template !== 'object') return false;
  const v = (template as { retiredAt?: unknown }).retiredAt;
  return typeof v === 'string' && v.length > 0;
}

/** Etiqueta de departamento de un agente (template.department) o null. */
export function departmentOf(template: unknown): string | null {
  const d = template && typeof template === 'object' ? (template as { department?: unknown }).department : null;
  return typeof d === 'string' && d.trim() ? d.trim() : null;
}

export interface OrgEvaluation {
  id: string;
  workspaceSlug: string;
  scopeKind: OrgScopeKind;
  /** Proyecto evaluado (null si el ámbito es la empresa). */
  projectId: string | null;
  /** Proyecto donde viven el proceso y el documento de Conocimiento (en una evaluación de empresa, el proyecto activo). */
  anchorProjectId: string;
  processId: string | null;
  status: OrgEvaluationStatus;
  knowledgeDocId: string | null;
  summary: string;
  proposals: OrgProposal[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export const isOrgEvaluationFinished = (s: OrgEvaluationStatus) => s === 'done' || s === 'failed' || s === 'cancelled';

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '').slice(0, max);

const EFFORTS: readonly OrgEffort[] = ['low', 'medium', 'high'];
const textList = (v: unknown, maxItems: number, maxLen: number): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\n|;/) : []).map(x => str(x, maxLen)).filter(Boolean).slice(0, maxItems);
const idList = (v: unknown): string[] => {
  const ids = Array.isArray(v) ? v.map(x => str(x, 60))
    : v && typeof v === 'object' ? Object.entries(v as Record<string, unknown>).filter(([, on]) => !!on).map(([k]) => k.trim())
      : typeof v === 'string' ? v.split(',').map(s => s.trim()) : [];
  return [...new Set(ids.filter(Boolean))];
};

/**
 * Normaliza la configuración propuesta: solo campos conocidos, textos recortados; herramientas y capacidades filtradas
 * contra TOOLS y CAPABILITIES (los ids desconocidos se descartan con aviso). spec ausente o vacío → undefined.
 */
export function normalizeOrgSpec(raw: unknown, nested = false): { spec: OrgProposalSpec | undefined; warnings: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { spec: undefined, warnings: [] };
  const r = raw as Record<string, unknown>; const warnings: string[] = []; const spec: OrgProposalSpec = {};
  const name = str(r.name, 80); if (name) spec.name = name;
  const role = str(r.role, 120); if (role) spec.role = role;
  const specialization = str(r.specialization, 600); if (specialization) spec.specialization = specialization;
  if (r.responsibilities != null) { const l = textList(r.responsibilities, 8, 300); if (l.length) spec.responsibilities = l; }
  const reportsTo = str(r.reportsTo ?? r.reports_to, 120); if (reportsTo) spec.reportsTo = reportsTo;
  if (r.tools != null) {
    const ids = idList(r.tools); const ok = ids.filter(id => TOOLS.some(t => t.id === id)); spec.tools = ok;
    const bad = ids.filter(id => !ok.includes(id)); if (bad.length) warnings.push(`Herramientas fuera del catálogo descartadas: ${bad.join(', ')}.`);
  }
  if (r.capabilities != null) {
    const ids = idList(r.capabilities); const ok = ids.filter(id => CAPABILITIES.some(c => c.id === id)); spec.capabilities = ok;
    const bad = ids.filter(id => !ok.includes(id)); if (bad.length) warnings.push(`Capacidades fuera del catálogo descartadas: ${bad.join(', ')}.`);
  }
  const model = str(r.model, 80); if (model) spec.model = model;
  const effort = str(r.effort, 10).toLowerCase() as OrgEffort; if (EFFORTS.includes(effort)) spec.effort = effort;
  const department = str(r.department ?? r.departamento, 80); if (department) spec.department = department;
  if (!nested && Array.isArray(r.agents)) {
    const subs = r.agents.slice(0, 8).map(a => normalizeOrgSpec(a, true));
    const agents = subs.map(x => x.spec).filter((x): x is OrgProposalSpec => !!x && !!x.name);
    if (agents.length) spec.agents = agents;
    for (const x of subs) warnings.push(...x.warnings);
  }
  if (!nested && r.members != null) { const m = textList(r.members, 20, 120); if (m.length) spec.members = m; }
  return { spec: Object.keys(spec).length ? spec : undefined, warnings };
}

/** Normaliza una entrada del bloque; null si no es válida o no tiene justificación. */
export function normalizeOrgProposal(raw: unknown, id: string): OrgProposal | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const action = str(r.action ?? r.op, 20).toLowerCase() as OrgAction;
  const target = str(r.target ?? r.kind, 20).toLowerCase() as OrgTarget;
  if (!ORG_ACTIONS.includes(action) || !ORG_TARGETS.includes(target)) return null;
  const subjectRaw = Array.isArray(r.subject) ? r.subject.map(s => str(s, 120)).filter(Boolean).join(' + ') : str(r.subject ?? r.name, 300);
  const subject = subjectRaw.slice(0, 300);
  const rationale = str(r.rationale ?? r.reason ?? r.justification, 2000);
  if (!subject || rationale.length < 3) return null;
  const details = typeof r.details === 'string' ? r.details.trim().slice(0, 4000) : r.details != null ? JSON.stringify(r.details).slice(0, 4000) : '';
  const { spec, warnings } = normalizeOrgSpec(r.spec ?? r.config);
  const keep = str(r.keep, 120);
  return {
    id, action, target, subject, rationale, details, decision: 'pending', decidedAt: null, decidedBy: null,
    ...(spec ? { spec } : {}), ...(keep ? { keep } : {}), ...(warnings.length ? { specWarnings: warnings } : {})
  };
}

/** Objetos JSON completos de un array cortado (equilibrio de llaves fuera de cadenas). */
function recoverObjects(src: string): unknown[] {
  const out: unknown[] = []; let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}' && depth > 0) { depth--; if (depth === 0 && start >= 0) { try { out.push(JSON.parse(src.slice(start, i + 1))); } catch { /* objeto inválido */ } start = -1; } }
  }
  return out;
}

/**
 * Extrae las propuestas del bloque ```org (array JSON), cerrado o no. Descarta las entradas sin justificación o con
 * acción/objetivo no válidos. Devuelve también el texto sin el bloque y si el bloque llegó cortado.
 */
export function parseOrgProposals(text: string): { proposals: OrgProposal[]; body: string; truncated: boolean; discarded: number; found: boolean } {
  const src = text ?? '';
  const m = /```org[ \t]*\r?\n([\s\S]*?)(?:\r?\n[ \t]*```|$(?![\s\S]))/i.exec(src);
  if (!m) return { proposals: [], body: src.trim(), truncated: false, discarded: 0, found: false };
  const closed = /```\s*$/.test(m[0]) && m[0].trimEnd().length > m[0].indexOf('\n') + 3;
  let items: unknown[] = []; let truncated = !closed;
  try { const v = JSON.parse(m[1]); items = Array.isArray(v) ? v : Array.isArray((v as any)?.proposals) ? (v as any).proposals : []; }
  catch { truncated = true; items = recoverObjects(m[1]); }
  const proposals: OrgProposal[] = [];
  for (const it of items.slice(0, 40)) { const p = normalizeOrgProposal(it, `p${proposals.length + 1}`); if (p) proposals.push(p); }
  const body = (src.slice(0, m.index) + src.slice(m.index + m[0].length)).trim();
  return { proposals, body, truncated, discarded: items.length - proposals.length, found: true };
}
