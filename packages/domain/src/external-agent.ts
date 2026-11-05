/**
 * Agentes externos como REFERENCIA GESTIONADA (docs/agentes-externos.md).
 *
 * Un agente que ya existe en una carpeta propia (p. ej. «PDF Word Fiel»: AGENTS.md, CLAUDE.md, contexto/, skills/,
 * memoria/, bandeja-de-entrada/, documentos/) se integra SIN copiarlo ni reescribirlo: la carpeta original sigue siendo la
 * fuente de verdad. El Portal guarda un mapa de su estructura, una instantánea adoptada de lo que entra en los prompts
 * (y la huella de sus scripts), los permisos concedidos por ruta y el estado de integración.
 *
 * - Procedencia (histórica, no cambia): de dónde vino y cuándo se importó.
 * - Estado de integración: pendiente → en evaluación → integrado. «Integrado» SOLO tras una modificación gestionada por
 *   el Portal, autorizada, validada y escrita en los archivos del agente con su registro (antes/después, copia, revisión).
 */

export type IntegrationState = 'pending' | 'evaluating' | 'integrated';
export const INTEGRATION_LABEL: Record<IntegrationState, string> = {
  pending: 'Externo · pendiente de integración',
  evaluating: 'Externo · en evaluación',
  integrated: 'Integrado'
};

/** Mapa de la estructura de una carpeta externa (detectado y confirmado al importar). Rutas relativas con «/». */
export interface ExternalLayout {
  identity: string;                 // instrucciones canónicas del agente (AGENTS.md)
  adapters: string[];               // adaptadores de arnés (CLAUDE.md…): se muestran, no se inyectan
  context: string[];                // contexto y conocimiento (contexto/*.md)
  skills: { slug: string; path: string; name: string; description: string; version: string | null; scripts: string[] }[];
  memory: string | null;            // memoria propia del agente (memoria/MEMORIA.md)
  inbox: string | null;             // entradas del propietario (bandeja-de-entrada/)
  outputs: string | null;           // entregables (documentos/)
  backups: string | null;           // copias de seguridad (configuracion/respaldos/)
  ignored: string[];                // dependencias, perfiles, cachés… (no se leen)
}

/** Permisos concedidos por el propietario, siempre acotados a rutas del mapa. */
export interface ExternalGrants {
  /** Escribir entregables y entradas: solo bajo `outputs` e `inbox`. */
  writeDocuments: boolean;
  /** Ejecutar scripts de sus habilidades en este equipo (Python), solo los de la revisión adoptada. */
  runScripts: boolean;
  /** Modificar sus instrucciones, habilidades y memoria: SOLO aplicando una mejora aprobada (copia + registro). */
  applyImprovements: boolean;
}

export interface ExternalProvenance { origin: 'external-folder'; path: string; importedAt: string; importedBy: string; originalHash: string; note: string }

export interface ExternalFileChange { path: string; change: 'added' | 'removed' | 'modified'; before: string | null; after: string | null }

/** Archivos que forman la identidad de un agente externo (lo que se adopta y se fija por huella). */
export const EXTERNAL_TEXT_LIMIT = 256 * 1024;
export const EXTERNAL_TOTAL_LIMIT = 3 * 1024 * 1024;
export const EXTERNAL_IGNORED_DIRS = ['.dependencias', 'node_modules', '.git', '__pycache__', '.venv', 'venv', '.cache'];
/** Directorios que nunca forman parte de la identidad (entregables, entradas, copias, perfiles de render). */
export const isIgnoredExternalDir = (name: string) => EXTERNAL_IGNORED_DIRS.includes(name) || /^perfil[_-]/i.test(name) || name.startsWith('.');

export function isIdentityPath(rel: string): boolean {
  if (/^(AGENTS|CLAUDE|COMO_EMPEZAR|README)\.md$/i.test(rel)) return true;
  if (/^contexto\/[^/]+\.md$/i.test(rel)) return true;
  if (/^memoria\/[^/]+\.md$/i.test(rel)) return true;
  if (/^skills\/[a-z0-9][a-z0-9_-]{0,63}\/(SKILL|CAMBIOS|README)\.md$/i.test(rel)) return true;
  if (/^skills\/[a-z0-9][a-z0-9_-]{0,63}\/scripts\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,80}\.(py|txt)$/.test(rel)) return true;
  return false;
}

/** Frontmatter mínimo de SKILL.md (`name`, `description`) y versión del título («versión 0.4.0»). */
export function parseSkillHeader(text: string): { name: string | null; description: string | null; version: string | null } {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const field = (k: string) => fm ? (new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm[1])?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null) : null;
  const version = /versi[oó]n\s+(\d+(?:\.\d+){1,2})/i.exec(text)?.[1] ?? null;
  return { name: field('name'), description: field('description'), version };
}

// ---------------------------------------------------------------- Plan de ejecución de un script (lo propone el modelo)

/** Marcadores que el Portal sustituye por rutas de la carpeta de trabajo del encargo (el modelo nunca escribe rutas). */
export const PLAN_PLACEHOLDERS = ['{entrada}', '{salida}', '{informe}', '{trabajo}'] as const;
export interface ScriptPlan { script: string; args: string[]; reason: string }

/**
 * Valida el plan que propone el modelo: el script debe ser uno de los adoptados de la habilidad y cada argumento un
 * marcador, una opción (`--nombre`) o un valor simple (número o palabra sin barras ni dos puntos). Nada de rutas libres,
 * comodines ni redirecciones: el Portal no usa shell y las rutas las pone él.
 */
export function validatePlan(plan: unknown, scripts: string[]): { ok: true; plan: ScriptPlan } | { ok: false; error: string } {
  if (!plan || typeof plan !== 'object') return { ok: false, error: 'El plan no es un objeto.' };
  const p = plan as Record<string, unknown>;
  const script = typeof p.script === 'string' ? p.script.trim() : '';
  if (!scripts.includes(script)) return { ok: false, error: `Script no permitido: «${script || '(vacío)'}». Solo los de la habilidad adoptada.` };
  if (!Array.isArray(p.args) || p.args.length > 100) return { ok: false, error: 'Los argumentos deben ser una lista (máx. 100).' };
  const args: string[] = [];
  for (const a of p.args) {
    if (typeof a !== 'string') return { ok: false, error: 'Cada argumento debe ser texto.' };
    const s = a.trim();
    const ok = (PLAN_PLACEHOLDERS as readonly string[]).includes(s) || /^--[a-z][a-z0-9-]{0,30}$/.test(s) || /^-?\d{1,6}(\.\d{1,4})?$/.test(s) || /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(s);
    if (!ok || s.includes('..')) return { ok: false, error: `Argumento no permitido: «${s.slice(0, 60)}».` };
    args.push(s);
  }
  // Cada marcador tiene UN papel: {entrada} y {salida} son los dos primeros argumentos; {informe} y {trabajo} solo como
  // valor de una opción; ninguno se repite (p. ej. `--informe {entrada}` sobrescribiría el original).
  if (args[0] !== '{entrada}' || args[1] !== '{salida}') return { ok: false, error: 'El plan debe empezar por {entrada} {salida}.' };
  for (const ph of PLAN_PLACEHOLDERS) if (args.filter(x => x === ph).length > 1) return { ok: false, error: `${ph} solo puede aparecer una vez.` };
  for (let i = 2; i < args.length; i++) {
    if ((args[i] === '{entrada}' || args[i] === '{salida}')) return { ok: false, error: `${args[i]} solo va al principio.` };
    if ((args[i] === '{informe}' || args[i] === '{trabajo}') && !/^--/.test(args[i - 1])) return { ok: false, error: `${args[i]} solo puede ser el valor de una opción.` };
    // Opciones que eligen programas o perfiles: las fija el Portal, nunca el plan.
    if (DENIED_OPTIONS.test(args[i])) return { ok: false, error: `Opción no permitida en un plan: ${args[i]}.` };
  }
  return { ok: true, plan: { script, args, reason: typeof p.reason === 'string' ? p.reason.slice(0, 600) : '' } };
}
const DENIED_OPTIONS = /^--(soffice|libreoffice|office|perfil|profile|python|interprete|interpreter|exe|bin|cmd|comando|command|shell|env|pythonpath)$/i;

// ---------------------------------------------------------------- Encargos de documentos y mejoras

export type DocumentJobStatus = 'received' | 'processing' | 'ready' | 'rejected' | 'failed';
export interface DocumentVersion {
  n: number; docx: string; qaDir: string; passed: boolean; gates: Record<string, boolean>; metrics: Record<string, number | string>;
  plan: ScriptPlan; scriptHash: string; skillRevision: string; report: string; reportBy: string; feedback: string | null; createdAt: string; durationMs: number;
  /** Llamadas al modelo que usó esta versión (plan e informe; en un lote, 0: el plan es del lote). */
  calls?: number; batchId?: string | null;
}
export interface DocumentJob {
  id: string; agentId: string; title: string; slug: string; status: DocumentJobStatus; inputName: string; inputSha256: string; pages: number | null;
  source: 'upload' | 'zip' | 'attachment'; versions: DocumentVersion[]; error: string | null; createdAt: string; updatedAt: string; batchId?: string | null;
  /** Intervención: el reintento no pudo replanificar o no encontró una corrección distinta. No cambia `status` ni los conteos. */
  needsIntervention?: boolean; interventionReason?: string | null;
  /** Presencia en disco: 'removed' = eliminado desde el Portal (queda como histórico); 'missing' = falta en disco. */
  presence?: DocumentPresence; missingOnDisk?: boolean; removal?: RemovalRecord | null;
}

// ---------------------------------------------------------------- Eliminación autorizada (borrado blando con histórico)

/**
 * Presencia de un lote o documento:
 * - present: sus archivos están en la carpeta del agente;
 * - missing: el Portal lo registró, pero ya no está en disco (el propietario lo borró a mano). Se puede quitar de la lista;
 * - removed: se eliminó desde el Portal con autorización. La fila se conserva como histórico y nunca se borra de la base.
 */
export type DocumentPresence = 'present' | 'missing' | 'removed';
export const PRESENCE_LABEL: Record<DocumentPresence, string> = { present: 'En disco', missing: 'Falta en disco', removed: 'Eliminado (histórico)' };

/** Registro histórico de una eliminación. Vive en la base y en «documentos/HISTORIAL.md», fuera de la carpeta borrada. */
export interface RemovalRecord {
  id: string; agentId: string; kind: 'batch' | 'document'; targetId: string; batchId: string | null; name: string;
  /** Carpeta borrada, relativa a la carpeta del agente. */
  folder: string;
  /** Se conserva el SHA-256 de cada PDF afectado, aunque su archivo ya no exista. */
  sha256: string[];
  /** Motivo por documento (rechazos, fallos o exclusiones) en el momento de eliminarlo. */
  reasons: { name: string; reason: string }[];
  files: number; freedBytes: number;
  /** true si ya faltaba en disco al eliminarlo: no se borró nada, solo se quitó de la lista. */
  missingOnDisk: boolean;
  reason: string | null; removedBy: string; removedAt: string;
}

/** Vista previa de una eliminación: no borra nada. `token` identifica exactamente lo mostrado (si cambia, 409). */
export interface RemovalPreview {
  kind: 'batch' | 'document'; id: string; name: string; folder: string; exists: boolean; files: number; sample: string[];
  freedBytes: number; keeps: string[]; warning: string; token: string; blockedBy: string | null;
}

// ---------------------------------------------------------------- Lotes de documentos (un ZIP con muchos PDF)

export type DocumentBatchStatus = 'received' | 'running' | 'paused' | 'completed' | 'cancelled';
/** Estado de cada archivo del lote. `excluded`: no es un PDF utilizable (con su motivo); nada se omite en silencio. */
export type DocumentBatchItemState = 'pending' | 'queued' | 'processing' | 'passed' | 'rejected_qa' | 'failed' | 'cancelled' | 'excluded';
export interface DocumentBatchItem {
  idx: number; entryName: string; sha256: string | null; size: number; outcome: 'accepted' | 'duplicate' | 'rejected'; reason: string | null;
  jobId: string | null; state: DocumentBatchItemState; version: number | null;
  /** Documento eliminado desde el Portal: cuenta en `counts.removed`, aparte del total. */
  removed?: boolean; missingOnDisk?: boolean;
  /** Word aprobado: `docx` relativo a «documentos/» (manifiesto, entregable); `docxRel` relativo a la carpeta del documento (descarga). */
  docx: string | null; docxRel: string | null; error: string | null;
  /** Marca sobre el estado (`failed`/`rejected_qa`), no un estado más: el ítem sigue contando donde estaba. */
  needsIntervention?: boolean; interventionReason?: string | null;
}
export interface DocumentBatchCounts {
  /** total = listos + rechazados + fallidos + cancelados + excluidos + pendientes (cada elemento en un solo estado). */
  total: number; detected: number; accepted: number; duplicates: number; excluded: number;
  pending: number; queued: number; processing: number; passed: number; rejectedQa: number; failed: number; cancelled: number;
  /** PDF de este lote cuyo contenido (SHA-256) ya se convirtió en OTRO lote: volver a procesarlos gasta conversiones del tope diario. */
  reprocessed?: number;
  /** Documentos eliminados desde el Portal. No entran en `total`: total = listos + rechazados + fallidos + excluidos (+ por hacer). */
  removed?: number;
}
export interface DocumentBatch {
  id: string; agentId: string; name: string; slug: string; sourceName: string; sourceSha256: string; status: DocumentBatchStatus;
  createdAt: string; updatedAt: string; startedAt: string | null; finishedAt: string | null; plan: ScriptPlan | null; summary: string | null;
  summaryBy: string | null; deliverable: string | null; manifest: string | null; error: string | null; waiting: string | null; calls: number;
  counts: DocumentBatchCounts; items: DocumentBatchItem[];
  presence?: DocumentPresence; missingOnDisk?: boolean; removal?: RemovalRecord | null;
}
export const BATCH_ITEM_LABEL: Record<DocumentBatchItemState, string> = {
  pending: 'Pendiente', queued: 'En cola', processing: 'Convirtiendo…', passed: 'Listo', rejected_qa: 'No pasó las comprobaciones', failed: 'Falló', cancelled: 'Cancelado', excluded: 'Excluido'
};

/** Motivos de intervención de un reintento (un solo sitio para servicio, pruebas y documentación). */
export const RETRY_REASON = {
  cap: 'No se pudo replanificar: tope diario agotado',
  planner: 'No se pudo replanificar: error del planificador',
  same: 'El agente no encontró una corrección distinta'
} as const;

/** Documento reintentado en un lote, tal como lo devuelve el reintento del lote. */
export interface DocumentBatchRetryItem {
  idx: number; jobId: string; state: DocumentBatchItemState; needsIntervention?: boolean; reason?: string | null;
}
/** Campos que el reintento de un lote añade a su respuesta habitual. */
export interface DocumentBatchRetryExtras { retried: DocumentBatchRetryItem[] }

export type FeedbackClass = 'document_only' | 'reusable' | 'needs_validation' | 'invalid';
export const FEEDBACK_LABEL: Record<FeedbackClass, string> = {
  document_only: 'Solo este documento', reusable: 'Reutilizable (cambia la habilidad)', needs_validation: 'Necesita validación', invalid: 'No aplicable'
};
export interface ProposalChange { path: string; kind: 'replace' | 'append' | 'install'; content?: string; kit?: string; summary: string; previous?: string | null }
export type ProposalState = 'proposed' | 'approved' | 'applied' | 'rejected' | 'failed';
export interface ImprovementProposal {
  id: string; agentId: string; jobId: string | null; feedback: string; classification: FeedbackClass; reason: string; summary: string;
  changes: ProposalChange[]; state: ProposalState; createdAt: string; decidedAt: string | null; appliedAt: string | null;
  backupDir: string | null; error: string | null; evidence: { jobId: string | null; version: number | null; gates: Record<string, boolean> | null };
  /** Revisión adoptada sobre la que se propuso: si cambió, la propuesta está obsoleta y no se aplica. */
  baseRevision?: number | null;
}
