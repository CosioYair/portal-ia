/**
 * Evaluación organizativa (HU-159). El Gestor Organizacional (con el Coordinador si el ámbito es un proyecto) analiza
 * la organización real y propone añadir, fusionar, retirar o ajustar agentes o departamentos. Las propuestas solo se
 * registran: aceptarlas o rechazarlas no crea ni elimina nada; el propietario lo aplica después desde Equipo.
 * Este módulo es puro (sin IO).
 */
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
  return { id, action, target, subject, rationale, details, decision: 'pending', decidedAt: null, decidedBy: null };
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
