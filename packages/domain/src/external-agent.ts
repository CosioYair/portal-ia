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
}
export interface DocumentJob {
  id: string; agentId: string; title: string; slug: string; status: DocumentJobStatus; inputName: string; inputSha256: string; pages: number | null;
  source: 'upload' | 'zip'; versions: DocumentVersion[]; error: string | null; createdAt: string; updatedAt: string;
}

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
