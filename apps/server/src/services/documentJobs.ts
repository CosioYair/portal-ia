import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import {
  FEEDBACK_LABEL, isIdentityPath, parseSkillHeader, RETRY_REASON, slugify, validatePlan,
  type Agent, type DocumentJob, type DocumentVersion, type FeedbackClass, type ImprovementProposal, type ProposalChange, type ScriptPlan
} from '@portal-ia/domain';
import { REPO_ROOT } from '../config.ts';
import { agentsRepo, workspaceDb } from '../db/workspace.ts';
import { agentBackend, agentCaller } from './claudeCode/backend.ts';
import { requirePolicy } from './executionPolicy.ts';
import { reconcileWithDisk, removalsById, removedIds } from './documentRemoval.ts';
import { backupFiles, DEPS_KEY, diffSnapshots, identityZones, markEvaluating, restoreSourceRevision, safePath, safeWrite, scanExternal, sha256Text, snapshotHash, sourcesRepo, type SnapshotFiles } from './externalAgents.ts';
import { recordAgentEvent } from './agentEvents.ts';
import { changed } from './live.ts';
import { monotonicNow } from '../clock.ts';

/**
 * Trabajo de documentos de un agente externo (p. ej. «PDF Word Fiel»): recibir un PDF o un ZIP, convertirlo con los
 * scripts de SU habilidad adoptada, comprobarlo con la QA propia del Portal y entregar versiones con un informe honesto.
 *
 * Flujo de una versión:
 *  1. Inventario del PDF (páginas, texto extraíble → OCR necesario o no). Sin texto y sin OCR instalado: se rechaza.
 *  2. El agente (Claude Code, tu suscripción) PLANIFICA qué script de su habilidad usar y con qué argumentos (JSON).
 *     El Portal valida el plan (script adoptado, argumentos sin rutas) y lo ejecuta: sin shell, carpeta de trabajo propia,
 *     entorno mínimo, límite de tiempo y huella del script fijada a la revisión adoptada. NO es un sandbox de Docker.
 *  3. QA del Portal (tools/doc_qa.py): texto editable, sin páginas como imagen, sin marcos/VML, mismas páginas,
 *     contenido completo y sin duplicados, estructura compatible con Word, comparación visual por página.
 *  4. El agente redacta el informe de entrega a partir de las MÉTRICAS (no se envía el contenido del documento).
 * Nada se sobrescribe: v1, v2… con sus evidencias en `revisiones/vN/`; el historial queda en HISTORIAL.md.
 *
 * Feedback → clasificación (solo este documento / reutilizable / necesita validación / no aplicable). Lo reutilizable
 * es una PROPUESTA de cambio a su habilidad, instrucciones o memoria: solo se aplica con tu aprobación, con copia en
 * `configuracion/respaldos/`, entrada en CAMBIOS.md, nueva revisión adoptada y registro de integración.
 */
const now = monotonicNow;
export const PDF_MAX = 100 * 1024 * 1024;
/**
 * Límites de un lote (ZIP). No hay un número fijo de PDF que se «corte» en silencio: si un ZIP supera un límite, se rechaza
 * ENTERO antes de aceptar nada, explicando cuál y cómo seguir (dividirlo). Protegen disco, memoria y tiempo.
 */
export const BATCH_LIMITS = { maxUploadBytes: 1024 * 1024 * 1024, maxEntries: 5000, maxDocs: 500, maxPdfBytes: PDF_MAX, maxTotal: 4 * 1024 ** 3, maxRatio: 200 };
const RUN_TIMEOUT_MS = 20 * 60_000;
/** Topes diarios por agente: conversiones (recursos del equipo) y llamadas al modelo (tu suscripción) por separado. */
export const VERSIONS_PER_DAY = 600;
export const MODEL_CALLS_PER_DAY = 80;
/** Herramientas del Portal (QA, inventario, kits). Las pruebas usan unas simuladas (PORTAL_DOC_TOOLS_DIR). */
const TOOLS_DIR = process.env.PORTAL_DOC_TOOLS_DIR ?? path.join(REPO_ROOT, 'apps/server/tools');
/** Herramientas verificadas del Portal que una mejora aprobada puede instalar en una habilidad (código nunca escrito por el modelo). */
export const PORTAL_KITS: Record<string, { file: string; description: string }> = {
  'pdf-word/convertir_editable.py': { file: path.join(TOOLS_DIR, 'kits/pdf-word/convertir_editable.py'), description: 'Conversor PDF→Word EDITABLE 0.5.0: texto real, tablas nativas con filetes, columnas, listas; figuras complejas como imagen de su región (nunca páginas completas); ajuste con LibreOffice y reintentos acotados por desborde.' }
};
const err = (msg: string, statusCode: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(msg), { statusCode, ...extra });

const ensured = new Set<string>();
function ensure(slug: string) {
  const db = workspaceDb(slug);
  if (ensured.has(slug)) return db;
  ensured.add(slug);
  db.exec(`CREATE TABLE IF NOT EXISTS document_jobs (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, title TEXT NOT NULL, slug TEXT NOT NULL, status TEXT NOT NULL, input_name TEXT NOT NULL,
    input_sha TEXT NOT NULL, pages INTEGER, source TEXT NOT NULL, versions_json TEXT NOT NULL DEFAULT '[]', error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS document_jobs_agent ON document_jobs(agent_id, created_at);
  CREATE TABLE IF NOT EXISTS document_batches (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL, source_name TEXT NOT NULL, source_sha TEXT NOT NULL,
    source_rel TEXT, status TEXT NOT NULL, plan_json TEXT, summary TEXT, summary_by TEXT, deliverable_rel TEXT, deliverable_sig TEXT, manifest_rel TEXT, error TEXT,
    calls INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
  ); CREATE INDEX IF NOT EXISTS document_batches_agent ON document_batches(agent_id, created_at);
  CREATE TABLE IF NOT EXISTS document_model_calls (agent_id TEXT NOT NULL, at TEXT NOT NULL, what TEXT NOT NULL DEFAULT 'lote');
  CREATE INDEX IF NOT EXISTS document_model_calls_agent ON document_model_calls(agent_id, at);
  CREATE TABLE IF NOT EXISTS document_batch_items (
    batch_id TEXT NOT NULL, idx INTEGER NOT NULL, entry_name TEXT NOT NULL, sha TEXT, size INTEGER NOT NULL DEFAULT 0, outcome TEXT NOT NULL,
    reason TEXT, job_id TEXT, state TEXT NOT NULL, PRIMARY KEY (batch_id, idx)
  );
  CREATE TABLE IF NOT EXISTS improvement_proposals (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, job_id TEXT, feedback TEXT NOT NULL, classification TEXT NOT NULL, reason TEXT NOT NULL, summary TEXT NOT NULL,
    changes_json TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT, applied_at TEXT, backup_dir TEXT, error TEXT, evidence_json TEXT NOT NULL DEFAULT '{}', base_revision INTEGER
  );`);
  // 0.19 (aditivo): cada trabajo puede pertenecer a un lote.
  const cols = (db.prepare(`PRAGMA table_info(document_jobs)`).all() as any[]).map(c => c.name);
  if (!cols.includes('batch_id')) db.exec(`ALTER TABLE document_jobs ADD COLUMN batch_id TEXT`);
  // HU-177 (aditivo): borrado blando. Las filas eliminadas se conservan como histórico (documentRemoval.ts).
  const addCols = (table: string, wanted: string[]) => {
    const have = (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(c => c.name);
    for (const c of wanted) if (!have.includes(c)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${c} TEXT`);
  };
  addCols('document_jobs', ['removed_at', 'removal_id', 'intervention']);
  addCols('document_batches', ['removed_at', 'removal_id']);
  addCols('document_batch_items', ['removed_at']);
  return db;
}
export const documentsDb = ensure;
const mapJob = (r: any): DocumentJob => ({ id: r.id, agentId: r.agent_id, title: r.title, slug: r.slug, status: r.status, inputName: r.input_name, inputSha256: r.input_sha, pages: r.pages ?? null, source: r.source, versions: JSON.parse(r.versions_json), error: r.error ?? null, createdAt: r.created_at, updatedAt: r.updated_at, batchId: r.batch_id ?? null, needsIntervention: !!r.intervention, interventionReason: r.intervention ?? null });
const mapProposal = (r: any): ImprovementProposal => ({ id: r.id, agentId: r.agent_id, jobId: r.job_id ?? null, feedback: r.feedback, classification: r.classification, reason: r.reason, summary: r.summary, changes: JSON.parse(r.changes_json), state: r.state, createdAt: r.created_at, decidedAt: r.decided_at ?? null, appliedAt: r.applied_at ?? null, backupDir: r.backup_dir ?? null, error: r.error ?? null, evidence: JSON.parse(r.evidence_json), baseRevision: r.base_revision ?? null });

export function jobsDb(slug: string) {
  const db = ensure(slug);
  return {
    list(agentId: string): DocumentJob[] { return (db.prepare(`SELECT * FROM document_jobs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 2000`).all(agentId) as any[]).map(mapJob); },
    get(id: string): DocumentJob | null { const r = db.prepare(`SELECT * FROM document_jobs WHERE id = ?`).get(id) as any; return r ? mapJob(r) : null; },
    /**
     * Trabajo con el mismo contenido (SHA-256). Si se indica un lote, solo busca dentro de ese lote: cada lote es
     * independiente y un PDF que ya llegó en otro lote vuelve a procesarse con su propio trabajo. Si no se indica lote
     * (PDF suelto), busca en todos los trabajos del agente, como antes, pero con una elección determinista: como cada
     * lote tiene su propio trabajo, puede haber varias filas con el mismo SHA. Se elige primero el trabajo SUELTO
     * (batch_id NULL) más antiguo y, solo si no hay ninguno, el trabajo de lote más antiguo (desempate por id).
     */
    bySha(agentId: string, sha: string, batchId?: string | null): DocumentJob | null {
      const r = batchId
        ? db.prepare(`SELECT * FROM document_jobs WHERE agent_id = ? AND input_sha = ? AND batch_id = ? AND removed_at IS NULL ORDER BY created_at, id LIMIT 1`).get(agentId, sha, batchId) as any
        : db.prepare(`SELECT * FROM document_jobs WHERE agent_id = ? AND input_sha = ? AND removed_at IS NULL ORDER BY (batch_id IS NOT NULL), created_at, id LIMIT 1`).get(agentId, sha) as any;
      return r ? mapJob(r) : null;
    },
    /**
     * HU-180 · Plan que ya funcionó para ESTE mismo documento (mismo agente y SHA-256) en otro trabajo (p. ej. de un lote
     * anterior). Recorre los trabajos no eliminados con ese SHA, excepto `excludeJobId`, del más reciente al más antiguo,
     * y devuelve la última versión aprobada por la QA que cumpla `accept` (p. ej. misma huella del script). Sin SQL nuevo:
     * se lee de versions_json. No llama al modelo.
     */
    provenPlanBySha(agentId: string, sha: string, excludeJobId: string, accept: (v: DocumentVersion) => boolean = () => true): { plan: ScriptPlan; jobId: string; jobTitle: string; version: number; scriptHash: string | null; skillRevision: string | null; batchId: string | null } | null {
      const rows = db.prepare(`SELECT * FROM document_jobs WHERE agent_id = ? AND input_sha = ? AND id <> ? AND removed_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 200`).all(agentId, sha, excludeJobId) as any[];
      for (const r of rows) {
        const j = mapJob(r);
        const ok = j.versions.slice().reverse().find(v => v.passed === true && !!v.plan?.script && accept(v));
        if (ok) return { plan: ok.plan, jobId: j.id, jobTitle: j.title, version: ok.n, scriptHash: (ok as any).scriptHash ?? null, skillRevision: (ok as any).skillRevision ?? null, batchId: j.batchId ?? null };
      }
      return null;
    },
    /**
     * Carpeta libre para un trabajo nuevo: devuelve base, base-2, base-3… si ya existe un trabajo del agente con ese slug
     * o, si se indica `outputsDir`, una carpeta con ese nombre en disco. Así no se sobrescribe nada de lotes anteriores.
     */
    uniqueSlug(agentId: string, base: string, outputsDir?: string | null): string {
      const taken = (s: string) => !!db.prepare(`SELECT 1 AS x FROM document_jobs WHERE agent_id = ? AND slug = ? LIMIT 1`).get(agentId, s) || (!!outputsDir && fs.existsSync(path.join(outputsDir, s)));
      if (!taken(base)) return base;
      for (let n = 2; n < 10_000; n++) { const c = `${base}-${n}`; if (!taken(c)) return c; }
      return `${base}-${crypto.randomUUID().slice(0, 8)}`;
    },
    insert(j: Omit<DocumentJob, 'versions' | 'error' | 'createdAt' | 'updatedAt'>) { db.prepare(`INSERT INTO document_jobs (id, agent_id, title, slug, status, input_name, input_sha, pages, source, batch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(j.id, j.agentId, j.title, j.slug, j.status, j.inputName, j.inputSha256, j.pages, j.source, j.batchId ?? null, now(), now()); },
    update(id: string, patch: { status?: string; versions?: DocumentVersion[]; error?: string | null; pages?: number | null }) {
      const cur = this.get(id)!;
      db.prepare(`UPDATE document_jobs SET status = ?, versions_json = ?, error = ?, pages = ?, updated_at = ? WHERE id = ?`).run(patch.status ?? cur.status, JSON.stringify(patch.versions ?? cur.versions), patch.error === undefined ? cur.error : patch.error, patch.pages === undefined ? cur.pages : patch.pages, now(), id);
      changed({ ws: slug, entity: 'agent', id: cur.agentId, kind: 'progress' });
    },
    /** Marca (o quita, con null) la intervención de un trabajo. No toca `status`: los conteos del lote no cambian. */
    setIntervention(id: string, reason: string | null) {
      const cur = this.get(id); if (!cur) return;
      db.prepare(`UPDATE document_jobs SET intervention = ?, error = COALESCE(?, error), updated_at = ? WHERE id = ?`).run(reason, reason, now(), id);
      changed({ ws: slug, entity: 'agent', id: cur.agentId, kind: 'progress' });
    },
    /** Versiones de hoy y llamadas al modelo de hoy (versiones sueltas: plan + informe; lotes: plan y resumen del lote; feedback). */
    usageToday(agentId: string): { versions: number; calls: number } {
      const since = new Date(); since.setHours(0, 0, 0, 0); const iso = since.toISOString();
      let versions = 0; let calls = 0;
      for (const r of db.prepare(`SELECT versions_json FROM document_jobs WHERE agent_id = ?`).all(agentId) as any[]) for (const v of JSON.parse(r.versions_json) as DocumentVersion[]) if (v.createdAt >= iso) { versions++; calls += v.calls ?? 2; }
      // Llamadas de los lotes (plan y resumen), cada una con su hora: un lote antiguo tocado hoy no vuelve a contar.
      calls += Number((db.prepare(`SELECT COUNT(*) AS c FROM document_model_calls WHERE agent_id = ? AND at >= ?`).get(agentId, iso) as any).c);
      calls += Number((db.prepare(`SELECT COUNT(*) AS c FROM improvement_proposals WHERE agent_id = ? AND created_at >= ?`).get(agentId, iso) as any).c);
      return { versions, calls };
    }
  };
}
function proposalsDb(slug: string) {
  const db = ensure(slug);
  return {
    list(agentId: string): ImprovementProposal[] { return (db.prepare(`SELECT * FROM improvement_proposals WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50`).all(agentId) as any[]).map(mapProposal); },
    get(id: string): ImprovementProposal | null { const r = db.prepare(`SELECT * FROM improvement_proposals WHERE id = ?`).get(id) as any; return r ? mapProposal(r) : null; },
    insert(p: ImprovementProposal) { db.prepare(`INSERT INTO improvement_proposals (id, agent_id, job_id, feedback, classification, reason, summary, changes_json, state, created_at, evidence_json, base_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.id, p.agentId, p.jobId, p.feedback, p.classification, p.reason, p.summary, JSON.stringify(p.changes), p.state, p.createdAt, JSON.stringify(p.evidence), p.baseRevision ?? null); },
    /** Cambia de estado solo si sigue en el esperado (dos aprobaciones a la vez: solo una aplica). */
    transition(id: string, from: string, to: string, patch: { backupDir?: string | null; error?: string | null } = {}): boolean {
      const ts = now();
      const r = db.prepare(`UPDATE improvement_proposals SET state = ?, decided_at = COALESCE(decided_at, ?), applied_at = CASE WHEN ? = 'applied' THEN ? ELSE applied_at END, backup_dir = COALESCE(?, backup_dir), error = ? WHERE id = ? AND state = ?`)
        .run(to, ts, to, ts, patch.backupDir ?? null, patch.error ?? null, id, from);
      return Number(r.changes) === 1;
    }
  };
}

// ---------------------------------------------------------------- Herramientas del equipo (Python, LibreOffice)

export interface Toolchain { python: string | null; pythonVersion: string | null; sitePath: string | null; soffice: string | null; problems: string[]; checkedAt: string }
let toolchain: Toolchain | null = null;
const pyFlags = () => (process.env.PORTAL_PYTHON_ARGS ?? '-s -B').split(/\s+/).filter(Boolean);

function run(file: string, args: string[], opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<{ code: number | null; stdout: string; stderr: string; ms: number; timedOut: boolean }> {
  const t0 = Date.now();
  return new Promise(resolve => {
    execFile(file, args, { cwd: opts.cwd, timeout: opts.timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: opts.env, encoding: 'utf8' }, (e: any, stdout, stderr) => {
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : null) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') + (e && typeof e.code !== 'number' ? `\n${e.message}` : ''), ms: Date.now() - t0, timedOut: !!e?.killed });
    });
  });
}

/** Pythons registrados (HKLM primero, luego HKCU), de la versión más nueva a la más antigua. */
async function registeredPythons(): Promise<string[]> {
  const out: { v: number[]; p: string }[] = [];
  for (const hive of ['HKLM', 'HKCU']) {
    const r = await run(path.join(process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'reg.exe'), ['query', `${hive}\\SOFTWARE\\Python\\PythonCore`, '/s', '/v', 'ExecutablePath'], { cwd: os.tmpdir(), timeoutMs: 15_000 });
    let ver: number[] = [];
    for (const line of r.stdout.split(/\r?\n/)) {
      const k = /PythonCore\\(\d+)\.(\d+)/.exec(line); if (k) { ver = [Number(k[1]), Number(k[2])]; continue; }
      const m = /ExecutablePath\s+REG_SZ\s+(.+\.exe)\s*$/i.exec(line); if (m && ver[0] === 3) out.push({ v: ver, p: m[1].trim() });
    }
  }
  return out.sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1]).map(x => x.p);
}

/** Busca Python (con PyMuPDF y Pillow) y LibreOffice. Nunca instala nada. */
export async function detectToolchain(force = false): Promise<Toolchain> {
  if (toolchain && !force) return toolchain;
  const problems: string[] = [];
  const cands: string[] = [];
  if (process.env.PORTAL_PYTHON) cands.push(process.env.PORTAL_PYTHON);
  // Windows: solo las instalaciones registradas (PEP 514), nunca carpetas que cualquier usuario puede crear (p. ej. C:\\Python399).
  if (process.platform === 'win32') cands.push(...await registeredPythons());
  else cands.push('/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3');
  let python: string | null = null; let pythonVersion: string | null = null; let sitePath: string | null = null;
  // La sonda ve los paquetes del usuario (pip --user) para saber DÓNDE están; las ejecuciones reciben solo esa ruta.
  const probeEnv: NodeJS.ProcessEnv = { ...baseEnv(null, null), APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  delete probeEnv.PYTHONNOUSERSITE;
  for (const c of cands) {
    if (!c || (path.isAbsolute(c) && !fs.existsSync(c))) continue;
    if (process.env.PORTAL_PYTHON && c === process.env.PORTAL_PYTHON) { python = c; pythonVersion = 'configurado'; break; }
    const r = await run(c, ['-B', '-c', 'import json, os, site, sys, fitz, PIL; u = site.getusersitepackages(); print(json.dumps({"v": sys.version.split()[0], "mupdf": fitz.VersionBind, "user": u if any(os.path.abspath(m.__file__).lower().startswith(os.path.abspath(u).lower()) for m in (fitz, PIL)) else None}))'], { cwd: TOOLS_DIR, timeoutMs: 30_000, env: probeEnv });
    if (r.code === 0) { try { const j = JSON.parse(r.stdout.trim().split('\n').pop()!); python = c; pythonVersion = `${j.v} · PyMuPDF ${j.mupdf}`; sitePath = j.user ?? null; break; } catch { /* salida inesperada */ } }
  }
  if (!python) problems.push('No se encontró Python con PyMuPDF y Pillow en este equipo (necesarios para convertir y comprobar). No se instala nada sin tu autorización.');
  const offices = [process.env.PORTAL_SOFFICE, 'C:\\Program Files\\LibreOffice\\program\\soffice.com', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com', '/usr/bin/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice'];
  const soffice = offices.find(p => !!p && fs.existsSync(p)) ?? null;
  if (!soffice) problems.push('No se encontró LibreOffice: sin él no se puede renderizar el Word para comprobarlo.');
  toolchain = { python, pythonVersion, sitePath, soffice, problems, checkedAt: new Date().toISOString() };
  return toolchain;
}

/** Entorno mínimo: sin variables del Portal ni credenciales; temporales y perfil dentro de la carpeta del trabajo. */
function baseEnv(tc: Toolchain | null, tmp: string | null): NodeJS.ProcessEnv {
  const sys = process.env.SYSTEMROOT ?? process.env.SystemRoot ?? 'C:\\Windows';
  const dirs = [tc?.python && path.isAbsolute(tc.python) ? path.dirname(tc.python) : null, tc?.soffice ? path.dirname(tc.soffice) : null, process.platform === 'win32' ? path.join(sys, 'System32') : '/usr/bin:/bin'].filter(Boolean);
  const env: NodeJS.ProcessEnv = { PATH: dirs.join(path.delimiter), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' };
  if (process.platform === 'win32') { env.SYSTEMROOT = sys; env.WINDIR = sys; }
  // Temporales dentro del trabajo. Las variables de perfil (USERPROFILE/APPDATA…) NO se pasan: LibreOffice 26.8 se
  // cierra con 0xC0000409 si las recibe sin el resto del entorno; su perfil va aparte (-env:UserInstallation).
  if (tmp) { env.TEMP = tmp; env.TMP = tmp; env.TMPDIR = tmp; }
  if (tc?.soffice) env.SOFFICE = tc.soffice;
  if (tc?.sitePath) env.PYTHONPATH = tc.sitePath; // solo los paquetes del usuario donde están PyMuPDF/Pillow
  return env;
}

// ---------------------------------------------------------------- Entradas: PDF y ZIP seguros

export const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
/** Nombre de archivo seguro en Windows: sin rutas, caracteres prohibidos, nombres reservados ni puntos/espacios finales. */
export const safeName = (n: string) => {
  let s = path.basename(n.replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').slice(0, 120).replace(/[. ]+$/, '').trim();
  const ext = /\.([a-z0-9]{1,5})$/i.exec(s)?.[1] ?? ''; const stem = ext ? s.slice(0, -(ext.length + 1)) : s;
  if (!stem || RESERVED.test(stem.replace(/\..*$/, ''))) s = `documento-${stem || 'sin-nombre'}${ext ? `.${ext}` : ''}`;
  return s || 'documento.pdf';
};
export const isPdf = (b: Buffer) => { const i = b.subarray(0, 1024).indexOf('%PDF-'); return i >= 0; };

export function sourceOr(slug: string, agentId: string) {
  const s = sourcesRepo(slug).get(agentId);
  if (!s) throw err('Este agente no tiene carpeta externa.', 404);
  if (!s.layout.outputs) throw err('La carpeta del agente no tiene «documentos/» para sus entregables.', 409);
  return s;
}

export function appendHistory(root: string, dir: string, zones: string[], line: string) {
  const rel = `${dir}/HISTORIAL.md`;
  let cur = ''; try { cur = fs.readFileSync(safePath(root, rel, zones, { create: true }), 'utf8'); } catch { cur = ''; }
  const stamp = new Date().toLocaleString('sv-SE', { hour12: false }).slice(0, 16);
  safeWrite(root, rel, `${cur || '# Historial\n'}${cur.endsWith('\n') || !cur ? '' : '\n'}- ${stamp} · ${line}\n`, zones);
}

// ---------------------------------------------------------------- Procesar una versión

const running = new Map<string, string>(); // `${slug}:${agentId}` → jobId (uno a la vez por agente; lo usa también la cola de lotes)
export const runKey = (slug: string, agentId: string) => `${slug}:${agentId}`;
export const isAgentRunning = (slug: string, agentId: string) => running.has(runKey(slug, agentId));
export const reserveRun = (slug: string, agentId: string, jobId: string) => { const k = runKey(slug, agentId); if (running.has(k)) return false; running.set(k, jobId); return true; };
export const releaseRun = (slug: string, agentId: string) => { running.delete(runKey(slug, agentId)); };
export const documentJobsRunning = () => [...running.entries()].map(([k, jobId]) => { const i = k.lastIndexOf(':'); return { slug: k.slice(0, i), agentId: k.slice(i + 1), jobId }; });

/**
 * Documentos del agente cruzados con el disco. Por defecto se ocultan los eliminados desde el Portal; con
 * `includeRemoved` se devuelven como histórico, con su registro de eliminación. Lo que el Portal registró pero ya no
 * está en disco se marca como «falta en disco» y no se crea ni se borra nada.
 */
export function listJobs(slug: string, agentId: string, opts: { includeRemoved?: boolean } = {}): DocumentJob[] {
  const all = listJobsAll(slug, agentId);
  const gone = removedIds(slug, agentId).jobs;
  const missing = reconcileWithDisk(slug, agentId).jobs;
  const recs = gone.size ? removalsById(slug, agentId) : null;
  const out: DocumentJob[] = [];
  for (const j of all) {
    const rid = gone.get(j.id);
    if (rid !== undefined) {
      if (opts.includeRemoved) out.push({ ...j, presence: 'removed', missingOnDisk: false, removal: recs?.get(rid) ?? null });
      continue;
    }
    const miss = missing.has(j.id);
    out.push({ ...j, presence: miss ? 'missing' : 'present', missingOnDisk: miss, removal: null });
  }
  return out;
}

/**
 * Diagnóstico del intento anterior, para corregirlo al reintentar: comprobaciones no superadas, métricas de doc_qa,
 * plan usado y error. Devuelve null si la última versión pasó o si no hubo intento anterior. No incluye contenido del
 * documento: igual que en el feedback, se omite `qa_error`.
 */
export function retryDiagnosis(job: DocumentJob): string | null {
  const last = job.versions[job.versions.length - 1] ?? null;
  if (last?.passed) return null;
  if (!last && !job.error) return null;
  const parts: string[] = [];
  if (last) {
    const failed = Object.entries(last.gates ?? {}).filter(([, ok]) => !ok).map(([g]) => g);
    parts.push(failed.length ? `La v${last.n} no superó estas comprobaciones: ${failed.join(', ')}.` : `La v${last.n} no pasó las comprobaciones.`);
    const m = Object.entries(last.metrics ?? {}).filter(([k]) => k !== 'qa_error').slice(0, 30).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`);
    if (m.length) parts.push(`Métricas de doc_qa: ${m.join('; ')}.`);
    if (last.plan?.script) parts.push(`Plan anterior: ${last.plan.script} ${(last.plan.args ?? []).join(' ')}.`);
  }
  if (job.error) parts.push(`Error: ${job.error.slice(0, 600)}`);
  return parts.join('\n').slice(0, 2000);
}

const RETRY_TAG = 'Reintento corregido';
/**
 * Tras una corrección que pasó la QA, propone lo aprendido: el error, la causa y la corrección. Se añade a la memoria
 * del agente con el mecanismo de propuestas existente y queda pendiente de que el propietario la apruebe; no se aplica
 * sola. No hace llamadas al modelo.
 */
function proposeRetryLearning(slug: string, a: Agent, job: DocumentJob, v: DocumentVersion, diagnosis: string): ImprovementProposal | null {
  const repo = sourcesRepo(slug); const s = repo.get(a.id); if (!s) return null;
  const props = proposalsDb(slug);
  if (props.list(a.id).some(p => p.state === 'proposed' && p.jobId === job.id && p.feedback.startsWith(RETRY_TAG))) return null;
  const files = (repo.files(a.id) ?? {}) as SnapshotFiles;
  const canon = new Map(Object.keys(files).map(k => [k.toLowerCase(), k] as const));
  const mem = s.layout.memory && files[s.layout.memory] !== undefined ? s.layout.memory : (canon.get('memoria/aprendizajes.md') ?? null);
  const date = new Date().toISOString().slice(0, 10);
  const lesson = `## Aprendizaje ${date}: reintento corregido\n\n- Documento: «${job.inputName}» (SHA-256 ${job.inputSha256.slice(0, 12)}…), versión v${v.n} aprobada por la QA del Portal.\n- Error anterior: ${diagnosis.replace(/\n+/g, ' ').slice(0, 900)}\n- Corrección que pasó las pruebas: ${v.plan.script} ${v.plan.args.join(' ')}.${v.plan.reason ? ` Motivo: ${v.plan.reason.slice(0, 300)}` : ''}\n- Regla: ante este mismo fallo, aplica esta corrección desde el primer intento.`;
  const summary = 'Anotar en la memoria el error, su causa y la corrección que pasó las pruebas.';
  const change: ProposalChange = mem
    ? { path: mem, kind: 'append', content: lesson, previous: files[mem] ?? null, summary }
    : { path: 'memoria/APRENDIZAJES.md', kind: 'replace', content: `# Aprendizajes del agente\n\n${lesson}\n`, previous: null, summary };
  const p: ImprovementProposal = {
    id: crypto.randomUUID(), agentId: a.id, jobId: job.id, feedback: `${RETRY_TAG}: ${diagnosis}`.slice(0, 4000), classification: 'needs_validation',
    reason: 'La corrección del reintento pasó las comprobaciones del Portal. Se propone recordarla para no repetir el error. Requiere tu aprobación.',
    summary: `Aprendizaje del reintento de «${job.inputName}» (v${v.n})`.slice(0, 600), changes: [change], state: 'proposed', createdAt: now(),
    decidedAt: null, appliedAt: null, backupDir: null, error: null, evidence: { jobId: job.id, version: v.n, gates: v.gates ?? null }, baseRevision: s.revision
  };
  props.insert(p);
  recordAgentEvent(slug, a.id, 'improvement_proposed', { proposalId: p.id, classification: p.classification, changes: p.changes.map(c => ({ path: c.path, kind: c.kind })), jobId: job.id, source: 'retry' }, 'portal');
  changed({ ws: slug, entity: 'agent', id: a.id });
  return p;
}

function listJobsAll(slug: string, agentId: string): DocumentJob[] {
  const jobs = jobsDb(slug);
  // Un trabajo «procesando» que ya no está en marcha (reinicio del Portal) queda como fallido y se puede repetir.
  for (const j of jobs.list(agentId)) if (j.status === 'processing' && running.get(`${slug}:${agentId}`) !== j.id) jobs.update(j.id, { status: 'failed', error: 'Interrumpido por un reinicio del Portal. El original y las versiones anteriores siguen en su carpeta: vuelve a procesarlo.' });
  return jobs.list(agentId);
}

/** Lo que el agente necesita del modelo, sin el contenido del documento. */
export function skillContext(files: SnapshotFiles, layoutSkills: { slug: string; path: string; scripts: string[] }[]) {
  const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n)}\n…(recortado)` : s;
  const skills = layoutSkills.map(s => `## Habilidad «${s.slug}» (${s.path})\n${clip(files[s.path] ?? '', 9000)}`).join('\n\n');
  const context = Object.keys(files).filter(p => /^contexto\//i.test(p)).map(p => `## ${p}\n${clip(files[p], 4000)}`).join('\n\n');
  // Descripción de cada script: primeras líneas Y su sección «Uso» (opciones), para que el plan pueda usarlas.
  const doc = (p: string) => (/^"""([\s\S]*?)"""/.exec(files[p] ?? '')?.[1] ?? '').trim();
  const usage = (d: string) => { const i = d.search(/^\s*(Uso|Usage)\s*:/im); return i < 0 ? '' : ` · ${d.slice(i).split('\n').slice(0, 4).join(' ').replace(/\s+/g, ' ').slice(0, 400)}`; };
  const scripts = layoutSkills.flatMap(s => s.scripts).map(p => `- ${p}: ${doc(p).split('\n').slice(0, 4).join(' ').slice(0, 400)}${usage(doc(p))}`).join('\n');
  return { skills, context, scripts };
}

export function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('La respuesta no contiene un objeto JSON.');
  return JSON.parse(t.slice(a, b + 1));
}

export function callerFor(slug: string, a: Agent, title: string) {
  if (agentBackend(a) === 'api') throw err('Este agente usa la API facturable: para documentos usa Claude Code (tu suscripción). No se ha llamado a la API.', 409);
  const c = agentCaller(slug, a, null, title);
  if (!c) throw err('El arnés del agente no está disponible.', 409);
  return c;
}

export interface ProcessOptions {
  authorized: boolean; feedback?: string | null; by?: string; plan?: ScriptPlan | null; reportMode?: 'agent' | 'portal'; batchId?: string | null;
  /**
   * Diagnóstico del intento anterior. Si no se indica, se calcula a partir del documento (rechazado o fallido); con null
   * se desactiva. Con él, el agente vuelve a planificar sabiendo qué falló y, si la corrección pasa, se propone lo aprendido.
   */
  diagnosis?: string | null;
}

export async function startProcessing(slug: string, agentId: string, jobId: string, opts: ProcessOptions): Promise<DocumentJob> {
  if (!opts.authorized) throw err('Procesar ejecuta scripts del agente en este equipo y usa tu suscripción: confírmalo.', 403);
  const a = agentsRepo(slug).get(agentId); if (!a) throw err('Agente no encontrado', 404);
  const s = sourceOr(slug, agentId);
  if (!s.grants.runScripts || !s.grants.writeDocuments) throw err('Concede antes a este agente «ejecutar los scripts de sus habilidades» y «escribir en documentos/».', 403);
  const jobs = jobsDb(slug); const job = jobs.get(jobId); if (!job || job.agentId !== agentId) throw err('Trabajo no encontrado', 404);
  const key = `${slug}:${agentId}`;
  if (running.has(key)) throw err(`«${a.config.name}» ya está procesando un documento.`, 409);
  const use = jobs.usageToday(agentId);
  if (use.versions >= VERSIONS_PER_DAY) throw err(`Tope diario de ${VERSIONS_PER_DAY} conversiones por agente alcanzado.`, 429);
  if (use.calls + 2 > MODEL_CALLS_PER_DAY) throw err(`Tope diario de ${MODEL_CALLS_PER_DAY} llamadas a tu suscripción para documentos alcanzado (hoy: ${use.calls}). Mañana se renueva.`, 429);
  running.set(key, jobId); // reservado ANTES de esperar nada: dos clics no lanzan dos ejecuciones
  try {
    const tc0 = await detectToolchain();
    if (!tc0.python || !tc0.soffice) throw err(tc0.problems.join(' '), 409);
    callerFor(slug, a, 'Documento'); // falla ya (409) si su arnés no está disponible: nunca se usa otro
    const scan = scanExternal(s.root);
    const pending = diffSnapshots(sourcesRepo(slug).files(agentId)!, scan.files).filter(c => c.path.endsWith('.py') || c.path === DEPS_KEY);
    if (pending.length) throw err(`Programas o dependencias cambiados fuera del Portal sin revisar (${pending.map(c => c.path === DEPS_KEY ? '.dependencias' : c.path).join(', ')}): revísalos y adóptalos en «Origen» antes de ejecutar.`, 409);
  } catch (e) { running.delete(key); throw e; }
  const tc = await detectToolchain();
  jobs.update(jobId, { status: 'processing', error: null });
  void processVersion(slug, a, jobId, tc, opts).catch(e => { jobs.update(jobId, { status: 'failed', error: String(e?.message ?? e) }); }).finally(() => { running.delete(key); changed({ ws: slug, entity: 'agent', id: agentId }); });
  return jobs.get(jobId)!;
}

/**
 * El trabajo intermedio (perfiles de LibreOffice, intentos de ajuste, temporales) va a una carpeta temporal de ruta
 * CORTA fuera de la carpeta del agente y se borra al terminar: dentro de `documentos/…/revisiones/vN/` los perfiles de
 * LibreOffice superan el límite de ruta de Windows y LibreOffice se cierra al arrancar. Las evidencias sí van al agente.
 */
/**
 * Una versión del documento. Si hubo un intento anterior que no pasó, se hace UNA corrección (sin reintentos en bucle):
 * el agente vuelve a planificar con el diagnóstico y, si la nueva versión pasa la QA, se crea una propuesta de
 * aprendizaje pendiente. Si vuelve a fallar, el motivo queda en el documento.
 */
export async function processVersion(slug: string, a: Agent, jobId: string, tc: Toolchain, opts: ProcessOptions): Promise<void> {
  const job = jobsDb(slug).get(jobId);
  const diagnosis = opts.diagnosis === undefined ? (job ? retryDiagnosis(job) : null) : (opts.diagnosis?.trim() || null);
  // Se vuelve a planificar si la última versión FALLÓ (la conversión no terminó o la QA la rechazó) o si llega un
  // diagnóstico explícito. Sin versiones fallidas (primer intento o un fallo previo a la conversión) se usa el plan del lote.
  // Una conversión que no terminó (script con error o tiempo agotado) también se guarda con passed=false, pero con
  // Nunca se ejecuta un plan ya probado sin éxito (ni el del lote): como máximo una versión por petición.
  const lastV = job && job.versions.length > 0 ? job.versions[job.versions.length - 1] : null;
  const lastFailed = !!lastV && lastV.passed === false; // conversión fallida o rechazo de la QA
  if (!job || !diagnosis || (opts.diagnosis === undefined && !lastFailed)) {
    if (job) jobsDb(slug).setIntervention(jobId, null);
    return processVersionOnce(slug, a, jobId, tc, opts);
  }
  // Reintento con aprendizaje (suelto o de lote): una sola replanificación; si no se puede, intervención con el motivo real.
  const failedSigs = failedPlanSignatures(job);
  const lotSig = opts.plan ? planSignature(opts.plan) : null;
  const before = job.versions.length;
  let plan: ScriptPlan | null = null;
  // El tope se comprueba ANTES de llamar al planificador: agotado, no hay ninguna llamada (ni plan ni conversión).
  let blocked: string | null = jobsDb(slug).usageToday(a.id).calls >= MODEL_CALLS_PER_DAY ? `${RETRY_REASON.cap} (${MODEL_CALLS_PER_DAY} consultas de hoy).` : null;
  const tried = [...new Set([...job.versions.filter(v => v.passed === false && v.plan?.script).map(v => `${v.plan.script} ${(v.plan.args ?? []).join(' ')}`), ...(opts.plan ? [`${opts.plan.script} ${opts.plan.args.join(' ')}`] : [])])].slice(-6);
  const intervene = (reason: string) => {
    jobsDb(slug).setIntervention(jobId, reason);
    // Sin versión nueva: el documento vuelve al estado de su último intento (no se queda «processing»).
    jobsDb(slug).update(jobId, { status: lastV?.gates?.conversion_completada === false ? 'failed' : (lastV?.passed === false ? 'rejected' : 'failed'), error: reason.slice(0, 800) });
    recordAgentEvent(slug, a.id, 'document_job', { jobId, action: 'intervention', reason }, 'portal');
  };
  if (!blocked) {
    try {
      plan = await planScript(slug, a, `PDF «${job.inputName}» (${job.pages ?? '?'} páginas). REINTENTO: el intento anterior no pasó las comprobaciones del Portal${lastV?.gates?.conversion_completada === false ? ' (la conversión no terminó)' : ''}.${tried.length ? `\nPlanes ya probados sin éxito (NO los repitas):\n${tried.map(t => `- ${t}`).join('\n')}` : ''}`, `Corrige el fallo del intento anterior (elige script u opciones que lo eviten):\n${diagnosis}`);
    } catch (e: any) {
        plan = null;
        blocked = `${RETRY_REASON.planner}: ${String(e?.message ?? e).slice(0, 300)}`;
      } finally {
        recordModelCall(slug, a.id, 'reintento'); // la replanificación cuenta en el tope aunque falle
      }
  }
  if (blocked || !plan) { intervene(blocked ?? `${RETRY_REASON.planner}: sin plan.`); return; }
  const newSig = planSignature(plan);
  if (failedSigs.has(newSig) || (lotSig !== null && newSig === lotSig)) {
    intervene(`${RETRY_REASON.same}: el plan propuesto (${plan.script} ${plan.args.join(' ')}) ya se probó sin éxito.`);
    return;
  }
  jobsDb(slug).setIntervention(jobId, null);
  const feedback = [opts.feedback ?? null, `Corrección del intento anterior: ${diagnosis}`].filter(Boolean).join('\n\n').slice(0, 4000);
  await processVersionOnce(slug, a, jobId, tc, { ...opts, plan, feedback });
  const after = jobsDb(slug).get(jobId);
  const v = after?.versions[after.versions.length - 1];
  if (!after || after.versions.length <= before || !v?.passed) return;
  try { proposeRetryLearning(slug, a, after, v, diagnosis); } catch { /* la versión ya está guardada; la propuesta es opcional */ }
}
async function processVersionOnce(slug: string, a: Agent, jobId: string, tc: Toolchain, opts: ProcessOptions): Promise<void> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pia-'));
  try { await processVersionIn(slug, a, jobId, tc, opts, work); }
  finally { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temporal del sistema */ } }
}

async function processVersionIn(slug: string, a: Agent, jobId: string, tc: Toolchain, opts: ProcessOptions, work: string): Promise<void> {
  const jobs = jobsDb(slug); const job = jobs.get(jobId)!; const repo = sourcesRepo(slug); const s = repo.get(a.id)!;
  const files = repo.files(a.id)!; const zones = [s.layout.outputs!];
  const dir = `${s.layout.outputs}/${job.slug}`;
  // Siguiente versión libre según la base Y el disco (una ejecución interrumpida pudo dejar vN.docx sin registrar).
  let n = Math.max(0, ...job.versions.map(v => v.n)) + 1;
  while (fs.existsSync(path.join(s.root, ...dir.split('/'), 'versiones', `v${n}.docx`)) || fs.existsSync(path.join(s.root, ...dir.split('/'), 'revisiones', `v${n}`))) n++;
  const input = safePath(s.root, `${dir}/original/${job.inputName}`, zones);
  const outRel = `${dir}/versiones/v${n}.docx`;
  // El script y la QA escriben en la carpeta temporal; el Portal copia después los resultados a la del agente.
  const output = path.join(work, 'salida.docx'); const reportPath = path.join(work, 'informe-conversion.json');
  const tmp = path.join(work, 'tmp'); fs.mkdirSync(tmp, { recursive: true });
  const env = baseEnv(tc, tmp);
  const t0 = Date.now();

  // 1. Inventario (sin texto del documento).
  const info = await run(tc.python!, [...pyFlags(), path.join(TOOLS_DIR, 'pdf_info.py'), input], { cwd: work, timeoutMs: 120_000, env });
  let pdf: { encrypted?: boolean; pages?: number; text_pages?: number; ocr_available?: boolean } = {};
  try { pdf = JSON.parse(info.stdout.trim().split('\n').pop() ?? '{}'); } catch { /* se informa abajo */ }
  if (info.code !== 0 || !pdf.pages) throw err(`No se pudo leer el PDF: ${(info.stderr || info.stdout).slice(-400)}`, 400);
  jobs.update(jobId, { pages: pdf.pages });
  if (pdf.encrypted) throw err('El PDF está protegido con contraseña: no se puede convertir.', 400);
  const scanned = (pdf.text_pages ?? 0) < (pdf.pages ?? 0) * 0.5;
  if (scanned && !pdf.ocr_available) throw err(`Este PDF es escaneado (${(pdf.pages ?? 0) - (pdf.text_pages ?? 0)} de ${pdf.pages} páginas sin texto extraíble): necesita OCR y Tesseract no está instalado en este equipo. No se instala nada sin tu autorización; no se entrega un Word de imágenes como si fuera editable.`, 422);

  // 2. Plan del agente (Claude Code): qué script de su habilidad y con qué argumentos. Un lote trae su plan (una llamada).
  const scripts = s.layout.skills.flatMap(k => k.scripts);
  let plan: ScriptPlan;
  // HU-180 · Primer intento con lo aprendido: si este trabajo aún no tiene versiones ni corrección del propietario, se usa
  // el plan que ya pasó la QA para este MISMO documento (SHA-256) en otro trabajo, solo si el script sigue existiendo con
  // la misma huella y el plan es válido con los scripts actuales. Si no, se sigue con el plan del lote (o se planifica).
  let proven: ReturnType<ReturnType<typeof jobsDb>['provenPlanBySha']> = null;
  if (!job.versions.length && !opts.feedback) {
    try {
      const found = jobs.provenPlanBySha(a.id, job.inputSha256, job.id, v => files[v.plan.script] !== undefined && (!v.scriptHash || v.scriptHash === sha256Text(files[v.plan.script] ?? '')));
      if (found) { const v = validatePlan(found.plan, scripts); if (v.ok) proven = { ...found, plan: v.plan }; }
    } catch { proven = null; /* sin plan probado: se sigue con el plan normal */ }
  }
  const provenNote = proven ? `Primer intento con el plan que ya funcionó para este documento (SHA-256 ${job.inputSha256.slice(0, 12)}…, trabajo ${proven.jobId} v${proven.version}${proven.skillRevision && proven.skillRevision !== String(s.revision) ? `; plan de la revisión ${proven.skillRevision}, habilidad ahora en ${s.revision}` : ''}).` : '';
  const planCalls = proven || opts.plan ? 0 : 1;
  if (proven) { plan = proven.plan; appendHistory(s.root, dir, zones, `v${n}: ${provenNote}`); }
  else if (opts.plan) { const v = validatePlan(opts.plan, scripts); if (!v.ok) throw err(`El plan del lote ya no es válido: ${v.error}`, 409); plan = v.plan; }
  else {
    const prev = job.versions.map(v => `- v${v.n}: ${v.passed ? 'aprobada por la QA' : 'RECHAZADA por la QA'} · script ${v.plan.script} ${v.plan.args.join(' ')} · puertas fallidas: ${Object.entries(v.gates).filter(([, ok]) => !ok).map(([g]) => g).join(', ') || 'ninguna'}${v.feedback ? ` · corrección del propietario: «${v.feedback.slice(0, 300)}»` : ''}`).join('\n');
    plan = await planScript(slug, a, `- Archivo: ${job.inputName} · páginas: ${pdf.pages} · páginas con texto extraíble: ${pdf.text_pages}\n${prev ? `- Versiones anteriores:\n${prev}\n` : ''}`, opts.feedback ?? null);
  }

  // 3. Ejecutar el script adoptado: se ejecuta una COPIA en la carpeta temporal, escrita desde la instantánea adoptada
  //    (con sus scripts hermanos), no el archivo del disco; y solo si disco, dependencias e instantánea coinciden.
  const now0 = scanExternal(s.root);
  const drift = diffSnapshots(files, now0.files).filter(c => c.path.endsWith('.py') || c.path === DEPS_KEY);
  if (drift.length) throw err(`Programas o dependencias cambiados fuera del Portal desde que se adoptaron (${drift.map(c => c.path).join(', ')}): no se ejecuta.`, 409);
  const onDisk = files[plan.script] ?? '';
  const skillDir = plan.script.split('/').slice(0, 2).join('/');
  for (const [rel, text] of Object.entries(files)) if (rel.startsWith(`${skillDir}/scripts/`) && rel.endsWith('.py')) { const dst = path.join(work, 'agente', ...rel.split('/')); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, text, { flag: 'wx' }); }
  const scriptAbs = path.join(work, 'agente', ...plan.script.split('/'));
  const runEnv: NodeJS.ProcessEnv = { ...env, PYTHONPATH: [tc.sitePath, DEPS_KEY in files ? path.join(s.root, '.dependencias') : null].filter(Boolean).join(path.delimiter) || undefined };
  if (!runEnv.PYTHONPATH) delete runEnv.PYTHONPATH;
  const sub: Record<string, string> = { '{entrada}': input, '{salida}': output, '{informe}': reportPath, '{trabajo}': path.join(work, 'ajuste') }; // ruta corta temporal (ver processVersion)
  requirePolicy('agent_script', { slug, agentId: a.id, authorized: true });
  recordAgentEvent(slug, a.id, 'document_job', { jobId, action: 'run', version: n, script: plan.script, args: plan.args, scriptSha256: sha256Text(onDisk), skillRevision: s.revision, ...(proven ? { provenFrom: { jobId: proven.jobId, version: proven.version, sha256: job.inputSha256, batchId: proven.batchId } } : {}) }, 'portal');
  const conv = await run(tc.python!, [...pyRunFlags(work), scriptAbs, ...plan.args.map(x => sub[x] ?? x)], { cwd: work, timeoutMs: RUN_TIMEOUT_MS, env: runEnv });
  const tail = (t: string) => t.slice(-1500);
  if (conv.code !== 0 || !fs.existsSync(output)) {
    const version: DocumentVersion = { n, docx: '', qaDir: '', passed: false, gates: { conversion_completada: false }, metrics: { exit_code: conv.code ?? -1 }, plan, scriptHash: sha256Text(onDisk), skillRevision: String(s.revision), report: `La conversión falló${conv.timedOut ? ' (tiempo agotado)' : ''}: ${tail(conv.stderr || conv.stdout)}`, reportBy: 'Portal', feedback: opts.feedback ?? null, createdAt: now(), durationMs: Date.now() - t0, calls: planCalls, batchId: opts.batchId ?? null };
    jobs.update(jobId, { status: 'failed', versions: [...job.versions, version], error: version.report.slice(0, 600) });
    appendHistory(s.root, dir, zones, `v${n}: la conversión falló (${plan.script}).`);
    return;
  }
  // El entregable entra en su carpeta sin reemplazar nada (escritura exclusiva).
  safeWrite(s.root, outRel, fs.readFileSync(output), zones, { exclusive: true });

  // 4. QA del Portal: SIEMPRE sobre todas las páginas (un piloto parcial nunca queda «listo»), en una carpeta que crea el
  //    Portal después del script, y solo vale si la propia QA termina bien (0 aprobada, 2 rechazada).
  const qaTmp = path.join(work, `qa-${crypto.randomBytes(4).toString('hex')}`);
  const qaArgs = [path.join(TOOLS_DIR, 'doc_qa.py'), input, output, qaTmp, ...(fs.existsSync(reportPath) ? ['--informe', reportPath] : []), '--perfil', path.join(work, 'lo')];
  const qa = await run(tc.python!, [...pyFlags(), ...qaArgs], { cwd: work, timeoutMs: RUN_TIMEOUT_MS, env });
  let q: any = null; if (qa.code === 0 || qa.code === 2) { try { q = JSON.parse(fs.readFileSync(path.join(qaTmp, 'qa.json'), 'utf8')); } catch { /* sin QA */ } }
  const evidence = (rel: string, file: string) => { try { safeWrite(s.root, `${dir}/revisiones/v${n}/${rel}`, fs.readFileSync(file), zones, { exclusive: true }); } catch { /* evidencia opcional */ } };
  if (q) { for (const f of fs.readdirSync(qaTmp)) if (/^(qa\.json|comparacion-\d+\.png)$/.test(f)) evidence(`qa/${f}`, path.join(qaTmp, f)); }
  if (fs.existsSync(reportPath)) evidence('informe-conversion.json', reportPath);
  const gates: Record<string, boolean> = q?.gates ?? { qa_ejecutada: false };
  const passed = !!q?.passed;
  const metrics: Record<string, number | string> = q ? {
    paginas_pdf: q.pdf_pages, paginas_word: q.rendered_pages, texto_editable_fuera_de_figuras: q.recall_docx_outside_figures, palabras_en_figuras: q.words_in_figures,
    proporcion_en_figuras: q.figure_share, orden: q.order_render, duplicacion: q.duplication, imagenes: q.docx?.pictures, mayor_imagen_vs_pagina: q.docx?.largest_picture_ratio,
    imagenes_de_pagina_completa: q.docx?.pictures_over_60pct, tablas: q.docx?.tables, diferencia_visual_media: q.pages?.length ? Number((q.pages.reduce((t: number, p: any) => t + p.visual_diff, 0) / q.pages.length).toFixed(4)) : 0
  } : { qa_error: tail(qa.stderr || qa.stdout) };

  // 5. Informe honesto: del agente (a partir de las métricas) o, en un lote, del Portal (sin gastar una llamada por documento).
  let report = ''; let reportBy = a.config.name;
  if (opts.reportMode === 'portal') {
    reportBy = 'Portal';
    report = portalReport(passed, gates, metrics);
  } else try {
    const caller = callerFor(slug, a, `Documento «${job.title}»`);
    const worst = (q?.pages ?? []).slice().sort((x: any, y: any) => y.visual_diff - x.visual_diff).slice(0, 5).map((p: any) => ({ pagina: p.page, diferencia_visual: p.visual_diff, palabras_en_render: p.rendered_words }));
    const r = await caller.complete({ model: a.config.model, system: `Eres «${a.config.name}». Redactas el informe de entrega de una conversión PDF→Word para el propietario: en español, claro, ≤ 220 palabras. Honesto: no afirmes nada que no esté en los datos; si una puerta de calidad falló, dilo lo primero y no presentes el documento como válido. Distingue lo comprobado (métricas, render en LibreOffice) de lo pendiente (p. ej. revisión en Microsoft Word, que no está en este equipo).`, user: JSON.stringify({ documento: job.inputName, version: n, plan, codigo_de_salida: conv.code, puertas: gates, aprobado_por_la_QA: passed, metricas: metrics, peores_paginas: worst, problemas_de_estructura: q?.schema_problems ?? [] }, null, 1), maxTokens: 900, effort: a.config.effort, supportsEffort: false });
    report = r.text.trim();
  } catch (e: any) {
    reportBy = 'Portal';
    report = `${passed ? 'La QA del Portal aprobó esta versión.' : `La QA del Portal RECHAZÓ esta versión (puertas fallidas: ${Object.entries(gates).filter(([, ok]) => !ok).map(([g]) => g).join(', ')}).`} Métricas: ${JSON.stringify(metrics)}. (Informe automático: el arnés del agente falló al redactarlo — ${String(e?.message ?? e).slice(0, 200)}.)`;
  }
  const version: DocumentVersion = { n, docx: `versiones/v${n}.docx`, qaDir: q ? `revisiones/v${n}/qa` : '', passed, gates, metrics, plan, scriptHash: sha256Text(onDisk), skillRevision: String(s.revision), report: provenNote ? `${provenNote}\n\n${report}` : report, reportBy, feedback: opts.feedback ?? null, createdAt: now(), durationMs: Date.now() - t0, calls: planCalls + (opts.reportMode === 'portal' ? 0 : 1), batchId: opts.batchId ?? null };
  safeWrite(s.root, `${dir}/revisiones/v${n}/INFORME.md`, `# Versión ${n} — ${passed ? 'aprobada por la QA del Portal' : 'RECHAZADA por la QA del Portal'}\n\n${version.report}\n\n## Plan\n\`${plan.script} ${plan.args.join(' ')}\`\n\n${plan.reason}\n\n## Puertas\n${Object.entries(gates).map(([g, ok]) => `- ${ok ? '✔' : '✘'} ${g}`).join('\n')}\n`, zones);
  jobs.update(jobId, { status: passed ? 'ready' : 'rejected', versions: [...job.versions, version], error: null });
  appendHistory(s.root, dir, zones, `v${n}: ${passed ? 'aprobada' : 'rechazada'} por la QA del Portal (${plan.script.split('/').pop()}, revisión ${s.revision} de la habilidad).`);
  recordAgentEvent(slug, a.id, 'document_job', { jobId, action: passed ? 'ready' : 'rejected', version: n, gates }, 'portal');
  markEvaluating(slug, a.id);
}

/** Firma de un plan (script + argumentos normalizados): dos planes con la misma firma son el mismo intento. */
export function planSignature(plan: Pick<ScriptPlan, 'script' | 'args'>): string {
  return JSON.stringify([String(plan.script ?? '').trim(), (plan.args ?? []).map(x => String(x).trim())]);
}
/** Firmas de los planes de las versiones fallidas (conversión no terminada o rechazo de la QA). */
export function failedPlanSignatures(job: Pick<DocumentJob, 'versions'>): Set<string> {
  return new Set(job.versions.filter(v => v.passed === false && v.plan?.script).map(v => planSignature(v.plan)));
}

const clipTotal = (t: string, n: number) => t.length > n ? `${t.slice(0, n)}\n…(recortado: el resto no se envía)` : t;

/** Informe del Portal (sin modelo) a partir de las puertas y métricas: lo que se comprobó, sin adornos. */
export function portalReport(passed: boolean, gates: Record<string, boolean>, metrics: Record<string, number | string>): string {
  const failed = Object.entries(gates).filter(([, ok]) => !ok).map(([g]) => g.replace(/_/g, ' '));
  const m = metrics as Record<string, any>;
  const lines = [passed ? 'La comprobación del Portal aprobó esta versión.' : `La comprobación del Portal RECHAZÓ esta versión: ${failed.join(', ') || 'sin comprobación'}.`];
  if (m.paginas_pdf !== undefined) lines.push(`Páginas: ${m.paginas_pdf} en el PDF, ${m.paginas_word} en el Word. Tablas: ${m.tablas}. Imágenes: ${m.imagenes} (de página completa: ${m.imagenes_de_pagina_completa}).`);
  if (m.palabras_en_figuras) lines.push(`${m.palabras_en_figuras} palabras (${Math.round(Number(m.proporcion_en_figuras) * 100)} %) están dentro de figuras: van como imagen con su texto alternativo, no son editables.`);
  if (m.qa_error) lines.push(`La comprobación no terminó: ${String(m.qa_error).slice(0, 300)}`);
  lines.push('Informe automático del Portal (en un lote no se gasta una llamada por documento). Microsoft Word no está en este equipo: el render comprobado es el de LibreOffice.');
  return lines.join('\n\n');
}

/**
 * Plan del agente para UNA ejecución (una llamada a Claude Code): qué script de su habilidad y con qué argumentos, validado.
 * `docInfo` describe el documento o el lote (sin su contenido).
 */
export async function planScript(slug: string, a: Agent, docInfo: string, feedback: string | null): Promise<ScriptPlan> {
  const repo = sourcesRepo(slug); const s = repo.get(a.id)!; const files = repo.files(a.id)!;
  const caller = callerFor(slug, a, 'Plan de conversión');
  requirePolicy('ai_call', { slug, agentId: a.id, authorized: true, route: 'claude-code' });
  const ctx = skillContext(files, s.layout.skills);
  // HU-180 · Memoria aplicada del agente (la que deja una propuesta aprobada en memoria/APRENDIZAJES.md o la memoria de su
  // carpeta): el plan del lote la ve, igual que la identidad del agente (extracto final acotado, ~1 800 caracteres).
  const memPath = s.layout.memory && files[s.layout.memory] !== undefined ? s.layout.memory : (Object.keys(files).find(p => p.toLowerCase() === 'memoria/aprendizajes.md') ?? null);
  const memText = memPath ? (files[memPath] ?? '').trim() : '';
  const memBlock = memText && !ctx.context.includes(memText.slice(-200)) ? `# Memoria aplicada del agente (${memPath}, final; aplícala)\n${memText.slice(-1800)}\n\n` : '';
  const scripts = s.layout.skills.flatMap(k => k.scripts);
  const planPrompt = `${clipTotal(ctx.skills, 30_000)}\n\n${ctx.context ? `# Contexto\n${clipTotal(ctx.context, 12_000)}\n\n` : ''}${memBlock}# Scripts disponibles (SOLO estos)\n${ctx.scripts || '(ninguno)'}\n\n# Documento\n${docInfo}${feedback ? `\n# Corrección del propietario para ESTA versión\n${feedback.slice(0, 2000)}\n` : ''}\n# Reglas del plan\n- Empieza SIEMPRE por {entrada} {salida} (PDF original y DOCX nuevo). {informe} (JSON de informe del script, si lo admite) y {trabajo} (carpeta de trabajo temporal) solo como valor de una opción. Cada marcador una vez.\n- Argumentos: solo marcadores, opciones --nombre y valores simples (números o palabras). Ninguna ruta. Programas y perfiles (p. ej. LibreOffice) los fija el Portal.\n- Sigue el procedimiento de tu habilidad para producir el entregable COMPLETO (todas las páginas), salvo que el propietario pida un piloto.\n- La QA la hace el Portal después: no planifiques scripts de QA.\nResponde SOLO con JSON: {"script": "<ruta exacta de la lista>", "args": ["..."], "reason": "<por qué, en una frase>"}`;
  let planError: string | null = null;
  try {
    const r = await caller.complete({ model: a.config.model, system: `Eres «${a.config.name}». Planificas UNA ejecución de los scripts de tu habilidad para convertir PDF. No ejecutas nada: el Portal valida y ejecuta tu plan. Respondes solo con JSON.`, user: planPrompt, maxTokens: 1500, effort: a.config.effort, supportsEffort: false });
    const v = validatePlan(extractJson(r.text), scripts);
    if (!v.ok) { planError = v.error; throw new Error(v.error); }
    return v.plan;
  } catch (e: any) {
    throw err(`El agente no produjo un plan válido: ${planError ?? e?.message ?? e}. No se ejecutó nada, no se usó otro arnés ni la API.`, 502);
  }
}
/** Opciones de Python de una ejecución: sin paquetes del usuario salvo los pasados, sin escribir ni leer cachés de bytecode del agente. */
const pyRunFlags = (work: string) => process.env.PORTAL_PYTHON_ARGS !== undefined ? pyFlags() : [...pyFlags(), '-X', `pycache_prefix=${path.join(work, 'pyc')}`];

/** Archivo de un trabajo para descargar o ver (solo dentro de su carpeta y con extensiones conocidas). */
export function jobFile(slug: string, agentId: string, jobId: string, rel: string): { abs: string; type: string; name: string } {
  const s = sourceOr(slug, agentId); const job = jobsDb(slug).get(jobId);
  if (!job || job.agentId !== agentId) throw err('Trabajo no encontrado', 404);
  const ext = /\.([a-z0-9]+)$/i.exec(rel)?.[1]?.toLowerCase() ?? '';
  const types: Record<string, string> = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf: 'application/pdf', png: 'image/png', json: 'application/json', md: 'text/markdown; charset=utf-8' };
  if (!types[ext]) throw err('Tipo de archivo no permitido.', 400);
  const dir = `${s.layout.outputs}/${job.slug}`;
  const abs = safePath(s.root, `${dir}/${rel}`, [dir]);
  if (!fs.statSync(abs).isFile()) throw err('No es un archivo.', 400);
  return { abs, type: types[ext], name: `${job.slug}-${path.basename(abs)}` };
}

export function versionEvidence(slug: string, agentId: string, jobId: string, n: number): string[] {
  const s = sourceOr(slug, agentId); const job = jobsDb(slug).get(jobId); if (!job) return [];
  try { return fs.readdirSync(safePath(s.root, `${s.layout.outputs}/${job.slug}/revisiones/v${n}/qa`, [s.layout.outputs!])).filter(f => /^comparacion-\d+\.png$/.test(f)).sort(); } catch { return []; }
}

// ---------------------------------------------------------------- Feedback, propuestas y mejoras aprobadas

export function listProposals(slug: string, agentId: string) { const db = proposalsDb(slug); recoverInterrupted(slug, db.list(agentId)); return db.list(agentId); }

/**
 * HU-178 · Cola en serie por agente (espacio + agente) para la automejora desde el chat: generar, aplicar y deshacer nunca
 * se cruzan. Así cada mejora parte de la revisión VIGENTE (la que dejó la anterior) y dos mejoras seguidas no dan
 * stale_proposal. La cola siempre se libera, aunque la tarea falle.
 */
const improveQueues = new Map<string, Promise<unknown>>();
export function serialByAgent<T>(slug: string, agentId: string, fn: () => Promise<T>): Promise<T> {
  const key = `${slug}:${agentId}`;
  const prev = improveQueues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const tail: Promise<unknown> = next.catch(() => undefined);
  improveQueues.set(key, tail);
  void tail.finally(() => { if (improveQueues.get(key) === tail) improveQueues.delete(key); });
  return next;
}

export interface ImproveNowResult {
  proposalId: string; applied: boolean; classification: FeedbackClass; changes: { archivo: string; resumen: string }[];
  summary: string; reason: string | null; revisionBefore: number | null; revision: number | null; backup: string | null;
}

/**
 * HU-178 · Automejora desde el chat: el propietario lo pide y se aplica en el mismo paso, sin «Sí, hazlo» ni Mejoras.
 * 1) classifyFeedback crea la propuesta sobre la revisión actual: una consulta de la suscripción, dentro del tope del agente.
 * 2) applyProposal la aplica: copia en configuracion/respaldos, entrada en CAMBIOS.md y nueva revisión adoptada.
 * El filtro de classifyFeedback descarta todo cambio a permisos, arnés, presupuesto o código del Portal. Si no queda ningún
 * cambio seguro, no se aplica nada y se dice por qué. applyProposal y su stale_proposal siguen igual para Mejoras.
 */
export function improveNow(slug: string, agentId: string, input: { jobId: string | null; text: string }, by = 'chat'): Promise<ImproveNowResult> {
  return serialByAgent(slug, agentId, async () => {
    const p = await classifyFeedback(slug, agentId, input, by);
    const changes = p.changes.map(c => ({ archivo: c.path, resumen: String((c as any).summary ?? (c as any).reason ?? (c as any).description ?? c.kind ?? '').slice(0, 300) }));
    const base = { proposalId: p.id, classification: p.classification, changes, summary: p.summary, revisionBefore: null, revision: null, backup: null };
    const applicable = (p.classification === 'reusable' || p.classification === 'needs_validation') && p.changes.length > 0;
    if (!applicable) {
      const reason = p.changes.length ? `Clasificada como «${FEEDBACK_LABEL[p.classification] ?? p.classification}»: no cambia su forma de trabajar.` : `No hay cambios seguros que aplicar (${p.reason}). Nunca se tocan permisos, arnés, presupuesto ni código del Portal.`;
      proposalsDb(slug).transition(p.id, 'proposed', 'rejected', { error: reason.slice(0, 600) });
      return { ...base, changes: [], applied: false, reason };
    }
    const before = sourcesRepo(slug).get(agentId);
    const revisionBefore = before ? Number(before.revision) : null;
    await applyProposal(slug, agentId, p.id, { authorized: true, by });
    const after = proposalsDb(slug).get(p.id);
    const now1 = sourcesRepo(slug).get(agentId);
    if (!after || after.state !== 'applied') return { ...base, applied: false, revisionBefore, reason: after?.error ?? 'La mejora no se pudo aplicar.' };
    return { ...base, applied: true, reason: null, revisionBefore, revision: now1 ? Number(now1.revision) : null, backup: after.backupDir ?? null };
  });
}

/**
 * HU-178 · Deshacer una automejora: vuelve a la revisión anterior a esa mejora con la vuelta atrás que ya existe
 * (restoreSourceRevision, que conserva CAMBIOS.md y le añade la reversión). Va por la misma cola del agente.
 */
export function undoImprovement(slug: string, agentId: string, proposalId: string, revisionBefore: number, by = 'owner', revisionAfter: number | null = null): Promise<void> {
  return serialByAgent(slug, agentId, async () => {
    const p = proposalsDb(slug).get(proposalId);
    if (!p || p.agentId !== agentId) throw err('Mejora no encontrada.', 404);
    if (p.state !== 'applied') throw err('Esa mejora no está aplicada: no hay nada que deshacer.', 409);
    // Solo se deshace la ÚLTIMA mejora: si la revisión vigente ya no es la que dejó esta, volver a revisionBefore borraría
    // en silencio las mejoras posteriores. Se responde 409 sin tocar nada.
    const later = () => err('Hay mejoras posteriores a esta: deshaz primero la última.', 409, { code: 'later_improvements' });
    const current = sourcesRepo(slug).get(agentId);
    if (!current) throw err('Agente externo no encontrado.', 404);
    if (typeof revisionAfter === 'number') { if (Number(current.revision) !== revisionAfter) throw later(); }
    else if (proposalsDb(slug).list(agentId).some(o => o.id !== p.id && o.state === 'applied' && !!o.appliedAt && !!p.appliedAt && o.appliedAt > p.appliedAt)) throw later();
    restoreSourceRevision(slug, agentId, revisionBefore, by);
    // La propuesta deja de figurar como aplicada (Mejoras y el chat muestran lo mismo).
    proposalsDb(slug).transition(p.id, 'applied', 'rejected', { error: `Deshecha desde el chat (${by}) el ${now()}: se volvió a la revisión ${revisionBefore}.` });
    changed({ ws: slug, entity: 'agent', id: agentId, kind: 'progress' });
  });
}
export function pendingProposalCounts(slug: string): [string, number][] {
  return (ensure(slug).prepare(`SELECT agent_id, COUNT(*) AS n FROM improvement_proposals WHERE state = 'proposed' GROUP BY agent_id`).all() as any[]).map(r => [r.agent_id, Number(r.n)]);
}

/** Clasifica el feedback (una llamada del agente) y, si es reutilizable, guarda la propuesta de cambio para tu aprobación. */
/** Anota una llamada al modelo hecha para un lote (cuenta en el tope diario aunque la respuesta no sirviera). */
export function recordModelCall(slug: string, agentId: string, what = 'lote') {
  documentsDb(slug).prepare(`INSERT INTO document_model_calls (agent_id, at, what) VALUES (?, ?, ?)`).run(agentId, now(), what);
}

export async function classifyFeedback(slug: string, agentId: string, input: { jobId: string | null; text: string }, by = 'owner'): Promise<ImprovementProposal> {
  const a = agentsRepo(slug).get(agentId); if (!a) throw err('Agente no encontrado', 404);
  if (jobsDb(slug).usageToday(agentId).calls >= MODEL_CALLS_PER_DAY) throw err(`Hoy ya se usaron las ${MODEL_CALLS_PER_DAY} consultas diarias de este agente para documentos y mejoras: inténtalo mañana.`, 429);
  // HU-178: mejorar la habilidad, las instrucciones o la memoria no necesita «documentos/» (solo la carpeta externa del agente).
const s = sourcesRepo(slug).get(agentId); if (!s) throw err('Este agente no tiene carpeta externa.', 404); const repo = sourcesRepo(slug); const files = repo.files(agentId)!;
  const job = input.jobId ? jobsDb(slug).get(input.jobId) : null; if (input.jobId && (!job || job.agentId !== agentId)) throw err('Trabajo no encontrado', 404);
  const last = job?.versions[job.versions.length - 1] ?? null;
  const caller = callerFor(slug, a, 'Feedback');
  requirePolicy('ai_call', { slug, agentId, authorized: true, route: 'claude-code' });
  const clip = (t: string, n2: number) => t.length > n2 ? `${t.slice(0, n2)}\n…(recortado)` : t;
  const editable = Object.keys(files).filter(p => p.endsWith('.md') && !/CAMBIOS\.md$/i.test(p)).sort();
  const kits = Object.entries(PORTAL_KITS).map(([k, v]) => `- ${k} (sha256 ${sha256Text(fs.readFileSync(v.file, 'utf8')).slice(0, 12)}…): ${v.description}`).join('\n');
  const safeMetrics = last ? Object.fromEntries(Object.entries(last.metrics).filter(([k]) => k !== 'qa_error')) : {};
  const user = clipTotal(`# Feedback del propietario\n${input.text.slice(0, 4000)}\n\n${last ? `# Última versión del documento «${job!.inputName}» (v${last.n})\n${JSON.stringify({ aprobada_por_la_QA: last.passed, puertas: last.gates, metricas: safeMetrics, plan: last.plan }, null, 1)}\n\n` : ''}# Tus instrucciones (AGENTS.md)\n${clip(files['AGENTS.md'] ?? '', 6000)}\n\n${s.layout.skills.map(k => `# ${k.path}\n${clip(files[k.path] ?? '', 9000)}`).join('\n\n')}\n\n${s.layout.context.map(p => `# ${p}\n${clip(files[p], 4000)}`).join('\n\n')}\n\n${s.layout.memory ? `# ${s.layout.memory} (final)\n${(files[s.layout.memory] ?? '').slice(-2500)}\n\n` : ''}# Archivos de texto que puedes proponer cambiar\n${editable.map(p => `- ${p}`).join('\n')}\n\n# Herramientas verificadas del Portal que puedes proponer instalar en una habilidad (el código NUNCA lo escribes tú)\n${kits}\n\n# Reglas\n- classification: "document_only" (corrección solo de este documento: se aplica generando una nueva versión), "reusable" (debe cambiar cómo trabajas siempre), "needs_validation" (podría ser reutilizable pero falta evidencia), "invalid" (no aplicable o contradictorio con tu contrato sin que el propietario lo cambie).\n- Solo con "reusable" o "needs_validation" propones cambios (máx. 6). Cada cambio: {"path", "kind": "replace"|"append"|"install", "content" (replace: el archivo COMPLETO nuevo; append: el texto a añadir), "kit" (install: clave de la herramienta; path: skills/<habilidad>/scripts/<nombre>.py), "summary"}.\n- Mantén el idioma y el estilo de tus archivos; si cambias SKILL.md, sube su versión. No edites CAMBIOS.md: el Portal añade la entrada con motivo, evidencia y copia de seguridad.\n- Si el feedback contradice tu contrato de calidad y es reutilizable, propone también el cambio del contrato.\nResponde SOLO JSON: {"classification": "...", "reason": "...", "summary": "...", "changes": [...]}`, 70_000);
  const r = await caller.complete({ model: a.config.model, system: `Eres «${a.config.name}». Clasificas el feedback del propietario sobre tu trabajo y, si procede, propones cambios concretos a tu habilidad, instrucciones o memoria. Nada se aplica sin su aprobación. Respondes solo con JSON.`, user, maxTokens: 12_000, effort: a.config.effort, supportsEffort: false });
  let parsed: any; try { parsed = extractJson(r.text); } catch (e: any) { throw err(`El agente no devolvió una clasificación válida: ${e?.message ?? e}`, 502); }
  const cls: FeedbackClass = (['document_only', 'reusable', 'needs_validation', 'invalid'] as const).includes(parsed?.classification) ? parsed.classification : 'needs_validation';
  const changes = (cls === 'reusable' || cls === 'needs_validation') && Array.isArray(parsed?.changes) ? validateChanges(parsed.changes, files, s.layout) : { ok: [] as ProposalChange[], dropped: [] as string[] };
  const p: ImprovementProposal = {
    id: crypto.randomUUID(), agentId, jobId: job?.id ?? null, feedback: input.text.slice(0, 4000), classification: cls,
    reason: String(parsed?.reason ?? '').slice(0, 1500) + (changes.dropped.length ? `\n(El Portal descartó: ${changes.dropped.join(' · ')})` : ''), summary: String(parsed?.summary ?? FEEDBACK_LABEL[cls]).slice(0, 600),
    changes: changes.ok, state: changes.ok.length ? 'proposed' : 'rejected', createdAt: now(), decidedAt: null, appliedAt: null, backupDir: null, error: null,
    evidence: { jobId: job?.id ?? null, version: last?.n ?? null, gates: last?.gates ?? null }, baseRevision: s.revision
  };
  if (!changes.ok.length) p.decidedAt = p.createdAt;
  proposalsDb(slug).insert(p);
  recordAgentEvent(slug, agentId, 'improvement_proposed', { proposalId: p.id, classification: cls, changes: p.changes.map(c => ({ path: c.path, kind: c.kind })), jobId: p.jobId }, by);
  return proposalsDb(slug).get(p.id)!;
}

/**
 * Solo archivos de identidad del mapa; código solo como herramienta verificada del Portal; nunca CAMBIOS.md.
 * Las rutas se llevan a la grafía EXACTA del archivo existente (en Windows `memoria/memoria.md` es `memoria/MEMORIA.md`):
 * si no, la copia previa no lo guardaría y el cambio reemplazaría el archivo real sin copia.
 */
function validateChanges(raw: any[], files: SnapshotFiles, layout: { skills: { slug: string }[] }) {
  const ok: ProposalChange[] = []; const dropped: string[] = []; const zones = ['AGENTS.md', 'contexto/', 'memoria/', ...layout.skills.map(s => `skills/${s.slug}/`)];
  const canon = new Map(Object.keys(files).map(k => [k.toLowerCase(), k] as const));
  const seen = new Set<string>();
  for (const c of raw.slice(0, 6)) {
    const asked = String(c?.path ?? '').replace(/\\/g, '/').trim(); const kind = c?.kind;
    if (/~\d/.test(asked) || /[\s.]$/.test(asked) || asked.includes(':')) { dropped.push(`${asked || '(sin ruta)'}: ruta no válida`); continue; }
    const p = canon.get(asked.toLowerCase()) ?? asked;
    const inZone = zones.some(z => p === z || (z.endsWith('/') && p.startsWith(z)));
    if (!inZone || !isIdentityPath(p) || /CAMBIOS\.md$/i.test(p) || p === DEPS_KEY) { dropped.push(`${asked || '(sin ruta)'}: fuera de lo que se puede cambiar`); continue; }
    if (seen.has(p.toLowerCase())) { dropped.push(`${p}: repetido`); continue; }
    if (kind === 'install') {
      const kit = String(c?.kit ?? ''); if (!Object.hasOwn(PORTAL_KITS, kit) || !/^skills\/[^/]+\/scripts\/[^/]+\.py$/.test(p)) { dropped.push(`${p}: herramienta desconocida`); continue; }
      seen.add(p.toLowerCase()); ok.push({ path: p, kind, kit, previous: files[p] ?? null, summary: String(c?.summary ?? '').slice(0, 400) }); continue;
    }
    if (p.endsWith('.py')) { dropped.push(`${p}: el código solo llega como herramienta verificada del Portal`); continue; }
    if ((kind !== 'replace' && kind !== 'append') || typeof c?.content !== 'string' || !c.content.trim() || c.content.length > 60_000) { dropped.push(`${p}: cambio no válido`); continue; }
    if (kind === 'append' && !(p in files)) { dropped.push(`${p}: no existe (solo se añade a archivos existentes)`); continue; }
    if (kind === 'replace' && !(p in files) && !/^(contexto|memoria)\//.test(p)) { dropped.push(`${p}: no existe`); continue; }
    seen.add(p.toLowerCase());
    // El texto actual va con la propuesta: el propietario ve qué cambia antes de aprobarla.
    ok.push({ path: p, kind, content: c.content, previous: files[p] ?? null, summary: String(c?.summary ?? '').slice(0, 400) });
  }
  return { ok, dropped };
}

export function rejectProposal(slug: string, agentId: string, id: string, by = 'owner') {
  const p = proposalsDb(slug).get(id); if (!p || p.agentId !== agentId) throw err('Propuesta no encontrada', 404);
  if (!proposalsDb(slug).transition(id, 'proposed', 'rejected')) throw err('La propuesta ya no está pendiente.', 409);
  recordAgentEvent(slug, agentId, 'improvement_rejected', { proposalId: id }, by);
  return proposalsDb(slug).get(id)!;
}

/** Propuestas que se están aplicando AHORA en este proceso: una «aprobada» que no está aquí quedó interrumpida. */
const applying = new Set<string>();

/**
 * Aplica una mejora aprobada a la carpeta ORIGINAL del agente: copia previa, cambios, entrada en CAMBIOS.md, validación,
 * nueva revisión adoptada y registro de integración. Si cualquier paso falla, todo vuelve a como estaba.
 */
export async function applyProposal(slug: string, agentId: string, id: string, opts: { authorized: boolean; by?: string }) {
  const by = opts.by ?? 'owner';
  if (!opts.authorized) throw err('Aplicar una mejora cambia las instrucciones o habilidades del agente: confírmalo.', 403);
  const props = proposalsDb(slug); const p = props.get(id); if (!p || p.agentId !== agentId) throw err('Propuesta no encontrada', 404);
  if (p.state !== 'proposed' || !p.changes.length) throw err('La propuesta no está pendiente o no tiene cambios.', 409);
  const repo = sourcesRepo(slug); const s = repo.get(agentId); if (!s) throw err('Este agente no tiene carpeta externa.', 404);
  if (!s.grants.applyImprovements) throw err('Concede antes a este agente «aplicar mejoras aprobadas a sus instrucciones y habilidades».', 403);
  // Obsoleta: se propuso sobre otra versión de su identidad (otra mejora, un cambio externo adoptado, una vuelta atrás).
  if (p.baseRevision != null && p.baseRevision !== s.revision) throw err(`Esta propuesta se hizo sobre la versión ${p.baseRevision} de su identidad y ahora es la ${s.revision}: aplicarla desharía lo cambiado después. Vuelve a dar el feedback para una propuesta al día.`, 409, { code: 'stale_proposal' });
  const scan = scanExternal(s.root);
  if (snapshotHash(scan.files) !== s.adoptedHash) throw err('La carpeta tiene cambios hechos fuera del Portal sin revisar: adóptalos o deshazlos en «Origen» antes de aplicar la mejora.', 409);
  if (!props.transition(id, 'proposed', 'approved')) throw err('La propuesta ya no está pendiente.', 409);
  applying.add(id);
  const before = scan.files; const after: SnapshotFiles = { ...before };
  const zones = identityZones(s.layout);
  const written: string[] = []; let backup: string | null = null;
  const rollback = () => { for (const rel of written) { try { if (rel in before) safeWrite(s.root, rel, before[rel], zones); else fs.rmSync(safePath(s.root, rel, zones), { force: true }); } catch { /* queda la copia previa */ } } };
  try {
    requirePolicy('agent_files_write', { slug, agentId, authorized: true });
    for (const c of p.changes) {
      if (c.kind === 'install') { if (!Object.hasOwn(PORTAL_KITS, c.kit!)) throw new Error(`Herramienta desconocida: ${c.kit}`); after[c.path] = fs.readFileSync(PORTAL_KITS[c.kit!].file, 'utf8'); }
      else if (c.kind === 'append') { if (!(c.path in before)) throw new Error(`${c.path} no existe.`); after[c.path] = `${before[c.path].replace(/\s*$/, '')}\n\n${c.content!.trim()}\n`; }
      else after[c.path] = c.content!.endsWith('\n') ? c.content! : `${c.content}\n`;
    }
    // Entrada en CAMBIOS.md de cada habilidad tocada (motivo, evidencia, copia).
    const touched = [...new Set(p.changes.map(c => /^skills\/([^/]+)\//.exec(c.path)?.[1]).filter((x): x is string => !!x))];
    const canon = new Map(Object.keys(before).map(k => [k.toLowerCase(), k] as const));
    const cambios = (t: string) => canon.get(`skills/${t}/cambios.md`.toLowerCase()) ?? `skills/${t}/CAMBIOS.md`;
    const date = new Date().toISOString().slice(0, 10);
    const changedPaths = [...new Set([...p.changes.map(c => c.path), ...touched.map(cambios)])];
    backup = backupFiles(s.root, s.layout, before, changedPaths, `mejora-${id.slice(0, 8)}`);
    for (const t of touched) {
      const rel = cambios(t);
      const ver = parseSkillHeader(after[`skills/${t}/SKILL.md`] ?? '').version;
      after[rel] = `${(before[rel] ?? '# Cambios\n').replace(/\s*$/, '')}\n\n## ${date} — ${ver ? `versión ${ver} — ` : ''}mejora aprobada en Portal IA\n\n- Qué: ${p.summary}\n- Motivo (feedback del propietario): «${p.feedback.slice(0, 500).replace(/\n+/g, ' ')}»\n- Clasificación: ${FEEDBACK_LABEL[p.classification]}. ${p.reason.slice(0, 400).replace(/\n+/g, ' ')}\n- Evidencia: ${p.evidence.jobId ? `trabajo ${p.evidence.jobId.slice(0, 8)}, versión v${p.evidence.version}, comprobaciones no superadas: ${Object.entries(p.evidence.gates ?? {}).filter(([, ok]) => !ok).map(([g]) => g).join(', ') || 'ninguna'}` : 'sin trabajo asociado'}.\n- Archivos: ${p.changes.map(c => `${c.path} (${c.kind})`).join(', ')}.\n- Copia previa: ${backup}/ (restaurable).\n`;
    }
    for (const rel of changedPaths) { safeWrite(s.root, rel, after[rel], zones); written.push(rel); }
    // Validación: la carpeta entera es EXACTAMENTE lo aprobado (nada más cambió a la vez), las habilidades se leen y el
    // código instalado es Python válido (se analiza sin ejecutarse).
    const check = scanExternal(s.root);
    if (snapshotHash(check.files) !== snapshotHash(after)) {
      const other = diffSnapshots(after, check.files).map(c => c.path);
      throw new Error(`La carpeta no quedó como se aprobó (${other.join(', ')}): ¿se editó a la vez fuera del Portal?`);
    }
    for (const t of touched) if (!parseSkillHeader(check.files[`skills/${t}/SKILL.md`] ?? '').name) throw new Error(`skills/${t}/SKILL.md quedó sin nombre (frontmatter).`);
    const tc = await detectToolchain();
    for (const rel of changedPaths.filter(r => r.endsWith('.py'))) {
      if (!tc.python) throw new Error('No hay Python para validar el script instalado.');
      const r = await run(tc.python, [...pyFlags(), path.join(TOOLS_DIR, 'check_python.py'), safePath(s.root, rel, zones)], { cwd: TOOLS_DIR, timeoutMs: 60_000, env: baseEnv(tc, null) });
      if (r.code !== 0) throw new Error(`${rel} no es Python válido: ${r.stderr.slice(-300)}`);
    }
    const nRev = repo.adopt(agentId, check.files, check.layout, 'improvement', `Mejora aprobada: ${p.summary.slice(0, 200)}`, by);
    props.transition(id, 'approved', 'applied', { backupDir: backup });
    const fileChanges = diffSnapshots(before, check.files);
    recordAgentEvent(slug, agentId, 'improvement_applied', {
      proposalId: id, actor: by, at: now(), files: fileChanges, backup, revision: nRev, baseRevision: s.revision,
      authorization: { by, at: now(), statement: 'Aprobada por el propietario en el panel del agente' },
      validation: { folderMatchesApproved: true, skillsParse: touched, pythonParsed: changedPaths.filter(r => r.endsWith('.py')) }
    }, by);
    if (s.state !== 'integrated') { repo.setState(agentId, 'integrated'); recordAgentEvent(slug, agentId, 'integration_state', { from: s.state, to: 'integrated', reason: `Mejora ${id.slice(0, 8)} aplicada, validada y registrada`, revision: nRev }, by); }
    return { proposal: props.get(id)!, revision: nRev, backup, files: fileChanges };
  } catch (e: any) {
    rollback();
    props.transition(id, 'approved', 'failed', { backupDir: backup, error: String(e?.message ?? e).slice(0, 600) });
    throw err(`No se aplicó la mejora (todo volvió a como estaba${backup ? `; copia en ${backup}` : ''}): ${e?.message ?? e}`, e?.statusCode && e.statusCode < 500 ? e.statusCode : 500);
  } finally { applying.delete(id); }
}

/** Una propuesta «aprobada» que ya no se está aplicando (reinicio a mitad) queda como fallida, con el motivo. */
function recoverInterrupted(slug: string, list: ImprovementProposal[]) {
  for (const x of list) if (x.state === 'approved' && !applying.has(x.id)) proposalsDb(slug).transition(x.id, 'approved', 'failed', { error: 'Interrumpida por un reinicio del Portal mientras se aplicaba. Revisa «Origen»: si quedó algún archivo a medias aparecerá como cambio externo, y la copia previa está en configuracion/respaldos/.' });
}
