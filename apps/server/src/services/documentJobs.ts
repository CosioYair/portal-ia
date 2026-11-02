import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import {
  FEEDBACK_LABEL, isIdentityPath, parseSkillHeader, slugify, validatePlan,
  type Agent, type DocumentJob, type DocumentVersion, type FeedbackClass, type ImprovementProposal, type ProposalChange, type ScriptPlan
} from '@portal-ia/domain';
import { REPO_ROOT } from '../config.ts';
import { agentsRepo, workspaceDb } from '../db/workspace.ts';
import { agentBackend, agentCaller } from './claudeCode/backend.ts';
import { requirePolicy } from './executionPolicy.ts';
import { backupFiles, DEPS_KEY, diffSnapshots, identityZones, markEvaluating, safePath, safeWrite, scanExternal, sha256Text, snapshotHash, sourcesRepo, type SnapshotFiles } from './externalAgents.ts';
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
const PDF_MAX = 40 * 1024 * 1024;
const ZIP_MAX = 60 * 1024 * 1024;
const ZIP_MAX_ENTRIES = 200;
const ZIP_MAX_PDFS = 10;
const ZIP_MAX_TOTAL = 200 * 1024 * 1024;
const ZIP_MAX_RATIO = 200;
const RUN_TIMEOUT_MS = 20 * 60_000;
const DAILY_RUNS = 20;
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
  CREATE TABLE IF NOT EXISTS improvement_proposals (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, job_id TEXT, feedback TEXT NOT NULL, classification TEXT NOT NULL, reason TEXT NOT NULL, summary TEXT NOT NULL,
    changes_json TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT, applied_at TEXT, backup_dir TEXT, error TEXT, evidence_json TEXT NOT NULL DEFAULT '{}', base_revision INTEGER
  );`);
  return db;
}
const mapJob = (r: any): DocumentJob => ({ id: r.id, agentId: r.agent_id, title: r.title, slug: r.slug, status: r.status, inputName: r.input_name, inputSha256: r.input_sha, pages: r.pages ?? null, source: r.source, versions: JSON.parse(r.versions_json), error: r.error ?? null, createdAt: r.created_at, updatedAt: r.updated_at });
const mapProposal = (r: any): ImprovementProposal => ({ id: r.id, agentId: r.agent_id, jobId: r.job_id ?? null, feedback: r.feedback, classification: r.classification, reason: r.reason, summary: r.summary, changes: JSON.parse(r.changes_json), state: r.state, createdAt: r.created_at, decidedAt: r.decided_at ?? null, appliedAt: r.applied_at ?? null, backupDir: r.backup_dir ?? null, error: r.error ?? null, evidence: JSON.parse(r.evidence_json), baseRevision: r.base_revision ?? null });

function jobsDb(slug: string) {
  const db = ensure(slug);
  return {
    list(agentId: string): DocumentJob[] { return (db.prepare(`SELECT * FROM document_jobs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 100`).all(agentId) as any[]).map(mapJob); },
    get(id: string): DocumentJob | null { const r = db.prepare(`SELECT * FROM document_jobs WHERE id = ?`).get(id) as any; return r ? mapJob(r) : null; },
    bySha(agentId: string, sha: string): DocumentJob | null { const r = db.prepare(`SELECT * FROM document_jobs WHERE agent_id = ? AND input_sha = ?`).get(agentId, sha) as any; return r ? mapJob(r) : null; },
    insert(j: Omit<DocumentJob, 'versions' | 'error' | 'createdAt' | 'updatedAt'>) { db.prepare(`INSERT INTO document_jobs (id, agent_id, title, slug, status, input_name, input_sha, pages, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(j.id, j.agentId, j.title, j.slug, j.status, j.inputName, j.inputSha256, j.pages, j.source, now(), now()); },
    update(id: string, patch: { status?: string; versions?: DocumentVersion[]; error?: string | null; pages?: number | null }) {
      const cur = this.get(id)!;
      db.prepare(`UPDATE document_jobs SET status = ?, versions_json = ?, error = ?, pages = ?, updated_at = ? WHERE id = ?`).run(patch.status ?? cur.status, JSON.stringify(patch.versions ?? cur.versions), patch.error === undefined ? cur.error : patch.error, patch.pages === undefined ? cur.pages : patch.pages, now(), id);
      changed({ ws: slug, entity: 'agent', id: cur.agentId, kind: 'progress' });
    },
    runsToday(agentId: string): number {
      const since = new Date(); since.setHours(0, 0, 0, 0);
      return (db.prepare(`SELECT versions_json FROM document_jobs WHERE agent_id = ?`).all(agentId) as any[]).reduce((n, r) => n + (JSON.parse(r.versions_json) as DocumentVersion[]).filter(v => v.createdAt >= since.toISOString()).length, 0);
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

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
/** Nombre de archivo seguro en Windows: sin rutas, caracteres prohibidos, nombres reservados ni puntos/espacios finales. */
const safeName = (n: string) => {
  let s = path.basename(n.replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').slice(0, 120).replace(/[. ]+$/, '').trim();
  const ext = /\.([a-z0-9]{1,5})$/i.exec(s)?.[1] ?? ''; const stem = ext ? s.slice(0, -(ext.length + 1)) : s;
  if (!stem || RESERVED.test(stem.replace(/\..*$/, ''))) s = `documento-${stem || 'sin-nombre'}${ext ? `.${ext}` : ''}`;
  return s || 'documento.pdf';
};
const isPdf = (b: Buffer) => { const i = b.subarray(0, 1024).indexOf('%PDF-'); return i >= 0; };

/**
 * Lector de ZIP mínimo y defensivo: solo PDF, sin rutas (se usa el nombre base), sin cifrado, sin enlaces, sin ZIP64,
 * límites de número, tamaño total y relación de compresión, y CRC comprobado. Lo que no cumple se informa y se omite.
 */
export function readZipPdfs(buf: Buffer): { pdfs: { name: string; data: Buffer }[]; skipped: string[] } {
  if (buf.length > ZIP_MAX) throw err('El ZIP es demasiado grande (máx. 60 MB).', 413);
  const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const from = Math.max(0, buf.length - 65_557); const eocd = buf.lastIndexOf(sig);
  if (eocd < from || eocd < 0 || eocd + 22 > buf.length) throw err('No es un ZIP válido.', 400);
  const count = buf.readUInt16LE(eocd + 10); const cdSize = buf.readUInt32LE(eocd + 12); const cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff) throw err('ZIP64 no admitido.', 400);
  if (count > ZIP_MAX_ENTRIES) throw err(`El ZIP tiene demasiados archivos (máx. ${ZIP_MAX_ENTRIES}).`, 400);
  if (cdOff + cdSize > buf.length) throw err('ZIP dañado (directorio central fuera del archivo).', 400);
  const pdfs: { name: string; data: Buffer }[] = []; const skipped: string[] = []; let total = 0; let p = cdOff;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw err('ZIP dañado (entrada del directorio central).', 400);
    const flags = buf.readUInt16LE(p + 8); const method = buf.readUInt16LE(p + 10); const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20); const usize = buf.readUInt32LE(p + 24); const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32); const ext = buf.readUInt32LE(p + 38); const loff = buf.readUInt32LE(p + 42);
    const raw = buf.subarray(p + 46, p + 46 + nlen); const name = (flags & 0x800 ? raw.toString('utf8') : raw.toString('latin1')).replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    const why = (() => {
      if (name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..')) return 'ruta no permitida (recorrido de directorios)';
      if (((ext >>> 16) & 0o170000) === 0o120000) return 'es un enlace';
      if (flags & 0x1) return 'cifrado';
      if (!/\.pdf$/i.test(name)) return 'no es PDF';
      if (method !== 0 && method !== 8) return 'compresión no admitida';
      if (csize === 0xffffffff || usize === 0xffffffff) return 'ZIP64 no admitido';
      if (usize > PDF_MAX) return 'demasiado grande (máx. 40 MB)';
      if (csize > 0 && usize / csize > ZIP_MAX_RATIO) return 'relación de compresión sospechosa';
      if (pdfs.length >= ZIP_MAX_PDFS) return `solo se toman ${ZIP_MAX_PDFS} PDF por ZIP`;
      return null;
    })();
    if (why) { skipped.push(`${name.slice(0, 120)}: ${why}`); continue; }
    total += usize; if (total > ZIP_MAX_TOTAL) throw err('El contenido del ZIP es demasiado grande en total.', 413);
    if (loff + 30 > buf.length || buf.readUInt32LE(loff) !== 0x04034b50) { skipped.push(`${name}: cabecera local dañada`); continue; }
    const start = loff + 30 + buf.readUInt16LE(loff + 26) + buf.readUInt16LE(loff + 28);
    if (start + csize > buf.length) { skipped.push(`${name}: datos fuera del archivo`); continue; }
    const comp = buf.subarray(start, start + csize);
    let data: Buffer;
    try { data = method === 0 ? Buffer.from(comp) : zlib.inflateRawSync(comp, { maxOutputLength: usize + 1 }); } catch { skipped.push(`${name}: no se pudo descomprimir (o excede lo declarado)`); continue; }
    if (data.length !== usize || zlib.crc32(data) !== crc) { skipped.push(`${name}: tamaño o CRC no coinciden`); continue; }
    if (!isPdf(data)) { skipped.push(`${name}: no es un PDF válido`); continue; }
    pdfs.push({ name: safeName(name), data });
  }
  return { pdfs, skipped };
}

function sourceOr(slug: string, agentId: string) {
  const s = sourcesRepo(slug).get(agentId);
  if (!s) throw err('Este agente no tiene carpeta externa.', 404);
  if (!s.layout.outputs) throw err('La carpeta del agente no tiene «documentos/» para sus entregables.', 409);
  return s;
}

/** Recibe un PDF o un ZIP de PDF: cada PDF es un trabajo (el mismo PDF ya recibido no se duplica). */
export function receiveDocuments(slug: string, agentId: string, input: { name: string; contentBase64: string }, by = 'owner') {
  const s = sourceOr(slug, agentId);
  if (!s.grants.writeDocuments) throw err('Concede antes a este agente «escribir en documentos/ y bandeja-de-entrada/».', 403);
  const name = safeName(input.name);
  const buf = Buffer.from(input.contentBase64, 'base64');
  if (!buf.length) throw err('El archivo está vacío.', 400);
  let items: { name: string; data: Buffer; source: 'upload' | 'zip' }[]; let skipped: string[] = [];
  if (/\.zip$/i.test(name)) { const z = readZipPdfs(buf); items = z.pdfs.map(p => ({ ...p, source: 'zip' as const })); skipped = z.skipped; if (!items.length) throw err(`El ZIP no contiene PDF utilizables. ${skipped.slice(0, 5).join(' · ')}`, 400); }
  else if (/\.pdf$/i.test(name)) { if (buf.length > PDF_MAX) throw err('El PDF es demasiado grande (máx. 40 MB).', 413); if (!isPdf(buf)) throw err('No es un PDF válido (falta la cabecera %PDF-).', 400); items = [{ name, data: buf, source: 'upload' }]; }
  else throw err('Solo se admiten PDF o ZIP con PDF.', 400);
  const jobs = jobsDb(slug); const out: (DocumentJob & { duplicate?: boolean })[] = [];
  const zones = [s.layout.outputs!];
  for (const it of items) {
    const sha = crypto.createHash('sha256').update(it.data).digest('hex');
    const dup = jobs.bySha(agentId, sha); if (dup) { out.push({ ...dup, duplicate: true }); continue; }
    let base = slugify(it.name.replace(/\.pdf$/i, '')).slice(0, 60).replace(/[-.]+$/, '') || 'documento'; if (RESERVED.test(base)) base = `documento-${base}`;
    let docSlug = base; let k = 2;
    while (fs.existsSync(path.join(s.root, ...s.layout.outputs!.split('/'), docSlug))) docSlug = `${base}-${k++}`;
    const dir = `${s.layout.outputs}/${docSlug}`;
    safeWrite(s.root, `${dir}/original/${it.name}`, it.data, zones, { exclusive: true });
    appendHistory(s.root, dir, zones, `Recibido por Portal IA: «${it.name}» (${(it.data.length / 1024).toFixed(0)} KB, sha256 ${sha.slice(0, 12)}…${it.source === 'zip' ? `, desde ${name}` : ''}).`);
    const id = crypto.randomUUID();
    jobs.insert({ id, agentId, title: it.name.replace(/\.pdf$/i, ''), slug: docSlug, status: 'received', inputName: it.name, inputSha256: sha, pages: null, source: it.source });
    recordAgentEvent(slug, agentId, 'document_job', { jobId: id, action: 'received', name: it.name, sha256: sha, folder: dir }, by);
    out.push(jobs.get(id)!);
  }
  changed({ ws: slug, entity: 'agent', id: agentId });
  return { jobs: out, skipped };
}

function appendHistory(root: string, dir: string, zones: string[], line: string) {
  const rel = `${dir}/HISTORIAL.md`;
  let cur = ''; try { cur = fs.readFileSync(safePath(root, rel, zones, { create: true }), 'utf8'); } catch { cur = ''; }
  const stamp = new Date().toLocaleString('sv-SE', { hour12: false }).slice(0, 16);
  safeWrite(root, rel, `${cur || '# Historial\n'}${cur.endsWith('\n') || !cur ? '' : '\n'}- ${stamp} · ${line}\n`, zones);
}

// ---------------------------------------------------------------- Procesar una versión

const running = new Map<string, string>(); // `${slug}:${agentId}` → jobId
export const documentJobsRunning = () => [...running.entries()].map(([k, jobId]) => { const i = k.lastIndexOf(':'); return { slug: k.slice(0, i), agentId: k.slice(i + 1), jobId }; });

export function listJobs(slug: string, agentId: string): DocumentJob[] {
  const jobs = jobsDb(slug);
  // Un trabajo «procesando» que ya no está en marcha (reinicio del Portal) queda como fallido y se puede repetir.
  for (const j of jobs.list(agentId)) if (j.status === 'processing' && running.get(`${slug}:${agentId}`) !== j.id) jobs.update(j.id, { status: 'failed', error: 'Interrumpido por un reinicio del Portal. El original y las versiones anteriores siguen en su carpeta: vuelve a procesarlo.' });
  return jobs.list(agentId);
}

/** Lo que el agente necesita del modelo, sin el contenido del documento. */
function skillContext(files: SnapshotFiles, layoutSkills: { slug: string; path: string; scripts: string[] }[]) {
  const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n)}\n…(recortado)` : s;
  const skills = layoutSkills.map(s => `## Habilidad «${s.slug}» (${s.path})\n${clip(files[s.path] ?? '', 9000)}`).join('\n\n');
  const context = Object.keys(files).filter(p => /^contexto\//i.test(p)).map(p => `## ${p}\n${clip(files[p], 4000)}`).join('\n\n');
  const scripts = layoutSkills.flatMap(s => s.scripts).map(p => `- ${p}: ${(/^"""([\s\S]*?)"""/.exec(files[p] ?? '')?.[1] ?? '').trim().split('\n').slice(0, 4).join(' ').slice(0, 400)}`).join('\n');
  return { skills, context, scripts };
}

function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('La respuesta no contiene un objeto JSON.');
  return JSON.parse(t.slice(a, b + 1));
}

function callerFor(slug: string, a: Agent, title: string) {
  if (agentBackend(a) === 'api') throw err('Este agente usa la API facturable: para documentos usa Claude Code (tu suscripción). No se ha llamado a la API.', 409);
  const c = agentCaller(slug, a, null, title);
  if (!c) throw err('El arnés del agente no está disponible.', 409);
  return c;
}

export interface ProcessOptions { authorized: boolean; feedback?: string | null; by?: string }

export async function startProcessing(slug: string, agentId: string, jobId: string, opts: ProcessOptions): Promise<DocumentJob> {
  if (!opts.authorized) throw err('Procesar ejecuta scripts del agente en este equipo y usa tu suscripción: confírmalo.', 403);
  const a = agentsRepo(slug).get(agentId); if (!a) throw err('Agente no encontrado', 404);
  const s = sourceOr(slug, agentId);
  if (!s.grants.runScripts || !s.grants.writeDocuments) throw err('Concede antes a este agente «ejecutar los scripts de sus habilidades» y «escribir en documentos/».', 403);
  const jobs = jobsDb(slug); const job = jobs.get(jobId); if (!job || job.agentId !== agentId) throw err('Trabajo no encontrado', 404);
  const key = `${slug}:${agentId}`;
  if (running.has(key)) throw err(`«${a.config.name}» ya está procesando un documento.`, 409);
  if (jobs.runsToday(agentId) >= DAILY_RUNS) throw err(`Tope diario de ${DAILY_RUNS} versiones por agente alcanzado.`, 429);
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
async function processVersion(slug: string, a: Agent, jobId: string, tc: Toolchain, opts: ProcessOptions): Promise<void> {
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

  // 2. Plan del agente (Claude Code): qué script de su habilidad y con qué argumentos.
  const caller = callerFor(slug, a, `Documento «${job.title}»`);
  requirePolicy('ai_call', { slug, agentId: a.id, authorized: true, route: 'claude-code' });
  const ctx = skillContext(files, s.layout.skills);
  const scripts = s.layout.skills.flatMap(k => k.scripts);
  const prev = job.versions.map(v => `- v${v.n}: ${v.passed ? 'aprobada por la QA' : 'RECHAZADA por la QA'} · script ${v.plan.script} ${v.plan.args.join(' ')} · puertas fallidas: ${Object.entries(v.gates).filter(([, ok]) => !ok).map(([g]) => g).join(', ') || 'ninguna'}${v.feedback ? ` · corrección del propietario: «${v.feedback.slice(0, 300)}»` : ''}`).join('\n');
  const planPrompt = `${clipTotal(ctx.skills, 30_000)}\n\n${ctx.context ? `# Contexto\n${clipTotal(ctx.context, 12_000)}\n\n` : ''}# Scripts disponibles (SOLO estos)\n${ctx.scripts || '(ninguno)'}\n\n# Documento\n- Archivo: ${job.inputName} · páginas: ${pdf.pages} · páginas con texto extraíble: ${pdf.text_pages}\n${prev ? `- Versiones anteriores:\n${prev}\n` : ''}${opts.feedback ? `\n# Corrección del propietario para ESTA versión\n${opts.feedback.slice(0, 2000)}\n` : ''}\n# Reglas del plan\n- Empieza SIEMPRE por {entrada} {salida} (PDF original y DOCX nuevo). {informe} (JSON de informe del script, si lo admite) y {trabajo} (carpeta de trabajo temporal) solo como valor de una opción. Cada marcador una vez.\n- Argumentos: solo marcadores, opciones --nombre y valores simples (números o palabras). Ninguna ruta. Programas y perfiles (p. ej. LibreOffice) los fija el Portal.\n- Sigue el procedimiento de tu habilidad para producir el entregable COMPLETO (todas las páginas), salvo que el propietario pida un piloto.\n- La QA la hace el Portal después: no planifiques scripts de QA.\nResponde SOLO con JSON: {"script": "<ruta exacta de la lista>", "args": ["..."], "reason": "<por qué, en una frase>"}`;
  let plan: ScriptPlan; let planError: string | null = null;
  try {
    const r = await caller.complete({ model: a.config.model, system: `Eres «${a.config.name}». Planificas UNA ejecución de los scripts de tu habilidad para convertir un PDF. No ejecutas nada: el Portal valida y ejecuta tu plan. Respondes solo con JSON.`, user: planPrompt, maxTokens: 1500, effort: a.config.effort, supportsEffort: false });
    const v = validatePlan(extractJson(r.text), scripts);
    if (!v.ok) { planError = v.error; throw new Error(v.error); }
    plan = v.plan;
  } catch (e: any) {
    throw err(`El agente no produjo un plan válido: ${planError ?? e?.message ?? e}. No se ejecutó nada, no se usó otro arnés ni la API.`, 502);
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
  recordAgentEvent(slug, a.id, 'document_job', { jobId, action: 'run', version: n, script: plan.script, args: plan.args, scriptSha256: sha256Text(onDisk), skillRevision: s.revision }, 'portal');
  const conv = await run(tc.python!, [...pyRunFlags(work), scriptAbs, ...plan.args.map(x => sub[x] ?? x)], { cwd: work, timeoutMs: RUN_TIMEOUT_MS, env: runEnv });
  const tail = (t: string) => t.slice(-1500);
  if (conv.code !== 0 || !fs.existsSync(output)) {
    const version: DocumentVersion = { n, docx: '', qaDir: '', passed: false, gates: { conversion_completada: false }, metrics: { exit_code: conv.code ?? -1 }, plan, scriptHash: sha256Text(onDisk), skillRevision: String(s.revision), report: `La conversión falló${conv.timedOut ? ' (tiempo agotado)' : ''}: ${tail(conv.stderr || conv.stdout)}`, reportBy: 'Portal', feedback: opts.feedback ?? null, createdAt: now(), durationMs: Date.now() - t0 };
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

  // 5. Informe honesto del agente (a partir de las métricas).
  let report = ''; let reportBy = a.config.name;
  try {
    const worst = (q?.pages ?? []).slice().sort((x: any, y: any) => y.visual_diff - x.visual_diff).slice(0, 5).map((p: any) => ({ pagina: p.page, diferencia_visual: p.visual_diff, palabras_en_render: p.rendered_words }));
    const r = await caller.complete({ model: a.config.model, system: `Eres «${a.config.name}». Redactas el informe de entrega de una conversión PDF→Word para el propietario: en español, claro, ≤ 220 palabras. Honesto: no afirmes nada que no esté en los datos; si una puerta de calidad falló, dilo lo primero y no presentes el documento como válido. Distingue lo comprobado (métricas, render en LibreOffice) de lo pendiente (p. ej. revisión en Microsoft Word, que no está en este equipo).`, user: JSON.stringify({ documento: job.inputName, version: n, plan, codigo_de_salida: conv.code, puertas: gates, aprobado_por_la_QA: passed, metricas: metrics, peores_paginas: worst, problemas_de_estructura: q?.schema_problems ?? [] }, null, 1), maxTokens: 900, effort: a.config.effort, supportsEffort: false });
    report = r.text.trim();
  } catch (e: any) {
    reportBy = 'Portal';
    report = `${passed ? 'La QA del Portal aprobó esta versión.' : `La QA del Portal RECHAZÓ esta versión (puertas fallidas: ${Object.entries(gates).filter(([, ok]) => !ok).map(([g]) => g).join(', ')}).`} Métricas: ${JSON.stringify(metrics)}. (Informe automático: el arnés del agente falló al redactarlo — ${String(e?.message ?? e).slice(0, 200)}.)`;
  }
  const version: DocumentVersion = { n, docx: `versiones/v${n}.docx`, qaDir: q ? `revisiones/v${n}/qa` : '', passed, gates, metrics, plan, scriptHash: sha256Text(onDisk), skillRevision: String(s.revision), report, reportBy, feedback: opts.feedback ?? null, createdAt: now(), durationMs: Date.now() - t0 };
  safeWrite(s.root, `${dir}/revisiones/v${n}/INFORME.md`, `# Versión ${n} — ${passed ? 'aprobada por la QA del Portal' : 'RECHAZADA por la QA del Portal'}\n\n${report}\n\n## Plan\n\`${plan.script} ${plan.args.join(' ')}\`\n\n${plan.reason}\n\n## Puertas\n${Object.entries(gates).map(([g, ok]) => `- ${ok ? '✔' : '✘'} ${g}`).join('\n')}\n`, zones);
  jobs.update(jobId, { status: passed ? 'ready' : 'rejected', versions: [...job.versions, version], error: null });
  appendHistory(s.root, dir, zones, `v${n}: ${passed ? 'aprobada' : 'rechazada'} por la QA del Portal (${plan.script.split('/').pop()}, revisión ${s.revision} de la habilidad).`);
  recordAgentEvent(slug, a.id, 'document_job', { jobId, action: passed ? 'ready' : 'rejected', version: n, gates }, 'portal');
  markEvaluating(slug, a.id);
}

const clipTotal = (t: string, n: number) => t.length > n ? `${t.slice(0, n)}\n…(recortado: el resto no se envía)` : t;
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
export function pendingProposalCounts(slug: string): [string, number][] {
  return (ensure(slug).prepare(`SELECT agent_id, COUNT(*) AS n FROM improvement_proposals WHERE state = 'proposed' GROUP BY agent_id`).all() as any[]).map(r => [r.agent_id, Number(r.n)]);
}

/** Clasifica el feedback (una llamada del agente) y, si es reutilizable, guarda la propuesta de cambio para tu aprobación. */
export async function classifyFeedback(slug: string, agentId: string, input: { jobId: string | null; text: string }, by = 'owner'): Promise<ImprovementProposal> {
  const a = agentsRepo(slug).get(agentId); if (!a) throw err('Agente no encontrado', 404);
  const s = sourceOr(slug, agentId); const repo = sourcesRepo(slug); const files = repo.files(agentId)!;
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
