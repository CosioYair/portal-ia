import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { LabAnalysisId, LabReport, ReaUpdateCheck } from '@portal-ia/domain';
import { LAB_ANALYSES, LAB_LIMITS, REA_PIN, compareLabReports, labSummary, parseReaOutput } from '@portal-ia/domain';
import { workspaceDb } from '../db/workspace.ts';
import { dockerCliEnv, dockerMountArg } from './sandbox.ts';
import { entryProblem, listZip, readZipEntry, sha256FileAsync } from './zipFile.ts';

/**
 * Portal IA 4 · Laboratorio de análisis de artefactos. Ejecuta REA (versión fijada) en un contenedor aparte:
 * sin red, sin privilegios, sistema de archivos de solo lectura, el artefacto montado en solo lectura, con tope de
 * memoria, CPU, procesos y tiempo. Solo órdenes de la lista cerrada (LAB_ANALYSES): análisis estático; nada se ejecuta.
 * El artefacto y lo que la herramienta dice de él son contenido NO fiable.
 */
export const REA_IMAGE = process.env.PORTAL_REA_IMAGE || REA_PIN.image;
const BUILD_HINT = `docker build -t ${REA_PIN.image} -f docker/rea.Dockerfile docker`;
const err = (statusCode: number, message: string, code?: string) => Object.assign(new Error(message), { statusCode, code });

const ready = new Set<string>();
function db(slug: string) {
  const d = workspaceDb(slug);
  if (!ready.has(slug)) { d.exec(`CREATE TABLE IF NOT EXISTS lab_reports (id TEXT PRIMARY KEY, status TEXT NOT NULL, doc_json TEXT NOT NULL, created_at TEXT NOT NULL)`); ready.add(slug); }
  return d;
}
export const labRepo = (slug: string) => {
  const d = db(slug);
  return {
    list(): LabReport[] { return (d.prepare(`SELECT doc_json FROM lab_reports ORDER BY created_at DESC LIMIT 50`).all() as any[]).map(r => JSON.parse(r.doc_json)); },
    get(id: string): LabReport | null { const r = d.prepare(`SELECT doc_json FROM lab_reports WHERE id = ?`).get(id) as any; return r ? JSON.parse(r.doc_json) : null; },
    put(r: LabReport): LabReport { d.prepare(`INSERT INTO lab_reports (id, status, doc_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, doc_json = excluded.doc_json`).run(r.id, r.status, JSON.stringify(r), r.createdAt); return r; },
    unfinished(): LabReport[] { return (d.prepare(`SELECT doc_json FROM lab_reports WHERE status = 'running'`).all() as any[]).map(r => JSON.parse(r.doc_json)); }
  };
};

function run(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise(resolve => {
    let stdout = '', stderr = '', timedOut = false, done = false;
    const child = spawn('docker', args, { env: dockerCliEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* ya terminó */ } }, timeoutMs);
    const end = (code: number | null) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); };
    child.stdout.on('data', b => { if (stdout.length < 8_000_000) stdout += String(b); });
    child.stderr.on('data', b => { if (stderr.length < 200_000) stderr += String(b); });
    child.on('error', e => { stderr += String(e.message); end(null); });
    child.on('close', code => end(code));
  });
}

export type LabEngine = { state: 'ready'; version: string } | { state: 'no_docker' | 'missing_image'; detail: string; hint: string };
let engineCache: { at: number; value: LabEngine } | null = null;
export async function labEngine(fresh = false): Promise<LabEngine> {
  if (!fresh && engineCache && Date.now() - engineCache.at < 30_000) return engineCache.value;
  let value: LabEngine;
  if ((await run(['version', '--format', '{{.Server.Version}}'], 8000)).code !== 0) value = { state: 'no_docker', detail: 'Docker no está en marcha: el análisis de artefactos lo usa para aislar la herramienta.', hint: 'Abre Docker Desktop y vuelve a intentarlo.' };
  else value = (await run(['image', 'inspect', '--format', '{{.Id}}', REA_IMAGE], 8000)).code === 0 ? { state: 'ready', version: REA_PIN.version } : { state: 'missing_image', detail: `Falta la imagen de análisis (${REA_IMAGE}).`, hint: BUILD_HINT };
  engineCache = { at: Date.now(), value };
  return value;
}

const SAFE_NAME = (n: string) => path.basename(String(n || '').replace(/\\/g, '/')).replace(/[^\w.\- ]+/g, '_').trim().slice(0, 100) || 'artefacto';
const isZip = (file: string) => { const fd = fs.openSync(file, 'r'); try { const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 0); return b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5); } finally { fs.closeSync(fd); } };

/**
 * Desempaqueta un ZIP en `dest` de forma segura: cada entrada se valida (rutas absolutas, «..», unidades, enlaces,
 * tamaño y proporción de compresión), el total expandido tiene tope y ninguna ruta sale de `dest`.
 */
export function extractZipSafely(file: string, dest: string): { files: number; bytes: number } {
  const listing = listZip(file, { maxEntries: LAB_LIMITS.maxEntries, maxEntryBytes: LAB_LIMITS.maxEntryBytes, maxRatio: LAB_LIMITS.maxRatio });
  let bytes = 0, files = 0; const root = path.resolve(dest);
  for (const e of listing.entries) {
    const problem = entryProblem(e, { maxEntryBytes: LAB_LIMITS.maxEntryBytes, maxRatio: LAB_LIMITS.maxRatio });
    if (problem) throw err(422, `El ZIP no se puede analizar: ${problem}`, 'unsafe_zip');
    if (e.name.endsWith('/')) continue;
    bytes += e.usize;
    if (bytes > LAB_LIMITS.maxExpandedBytes) throw err(413, 'El contenido del ZIP es demasiado grande para analizarlo.', 'too_large');
    const parts = e.name.replace(/\\/g, '/').split('/').filter(p => p && p !== '.');
    if (parts.some(p => p === '..' || /[<>:"|?*\u0000-\u001f]/.test(p))) throw err(422, 'El ZIP contiene rutas no válidas.', 'unsafe_zip');
    const out = path.resolve(root, ...parts);
    if (out !== root && !out.startsWith(root + path.sep)) throw err(422, 'El ZIP contiene rutas fuera de su carpeta.', 'unsafe_zip');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, readZipEntry(file, e), { flag: 'wx' });
    files++;
  }
  if (!files) throw err(422, 'El ZIP está vacío.', 'empty');
  return { files, bytes };
}

const active = new Set<string>();
let queue: Promise<void> = Promise.resolve();

export async function startLabAnalysis(slug: string, input: { analysis: LabAnalysisId; tempFile: string; size: number; name: string; statement: string }): Promise<LabReport> {
  const def = LAB_ANALYSES.find(a => a.id === input.analysis); if (!def) throw err(400, 'Análisis no reconocido.');
  const statement = input.statement.trim();
  if (statement.length < LAB_LIMITS.minStatement) throw err(400, 'Indica por qué puedes examinar este artefacto (es tuyo, o tienes permiso de su dueño). Sin eso no se analiza.', 'authorization_required');
  if (input.size <= 0) throw err(400, 'El archivo está vacío.');
  if (input.size > LAB_LIMITS.maxUploadBytes) throw err(413, `El archivo supera el máximo de ${Math.round(LAB_LIMITS.maxUploadBytes / 1048576)} MB.`, 'too_large');
  const eng = await labEngine(); if (eng.state !== 'ready') throw err(503, `${eng.detail} ${eng.hint}`, `lab_${eng.state}`);
  const sha256 = await sha256FileAsync(input.tempFile);
  // Carpeta de trabajo corta en el temporal del sistema (Docker en Windows falla al montar rutas largas).
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pia-lab-')); const target = path.join(work, 'target'); fs.mkdirSync(target);
  let kind: 'file' | 'folder' = 'file', files = 1, inner = SAFE_NAME(input.name);
  try {
    if (isZip(input.tempFile) && !def.needsFile && /\.zip$/i.test(input.name)) { files = extractZipSafely(input.tempFile, target).files; kind = 'folder'; inner = ''; }
    else fs.copyFileSync(input.tempFile, path.join(target, inner));
  } catch (e) { fs.rmSync(work, { recursive: true, force: true }); throw e; }
  const id = crypto.randomUUID();
  const report = labRepo(slug).put({
    id, analysis: def.id, status: 'running', error: null, target: { name: SAFE_NAME(input.name), bytes: input.size, sha256, kind, files },
    authorization: { statement: statement.slice(0, 1000), at: new Date().toISOString() }, tool: { name: 'rea', version: REA_PIN.version, image: REA_IMAGE, network: 'none' },
    findings: [], limitations: [], summary: { confirmed: 0, high: 0, unknown: 0, clean: 0 }, createdAt: new Date().toISOString(), finishedAt: null
  });
  active.add(id);
  queue = queue.then(() => runAnalysis(slug, id, def.command, work, inner).catch(() => undefined));
  return report;
}

async function runAnalysis(slug: string, id: string, command: string, work: string, inner: string): Promise<void> {
  const repo = labRepo(slug); const r = repo.get(id); if (!r) return;
  const name = `pia-lab-${id.slice(0, 12)}`;
  const finish = (patch: Partial<LabReport>) => repo.put({ ...r, ...patch, finishedAt: new Date().toISOString() });
  try {
    const args = ['run', '--rm', '--init', '--pull', 'never', '--name', name, '--label', 'portal-ia.lab=1', '--network', 'none', '--memory', '2g', '--memory-swap', '2g', '--cpus', '2', '--pids-limit', '256',
      '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--user', '1000:1000', '--read-only',
      '--mount', dockerMountArg({ type: 'tmpfs', target: '/tmp', 'tmpfs-mode': '1777', 'tmpfs-size': '536870912' }), '--env', 'HOME=/tmp',
      '--mount', dockerMountArg({ type: 'tmpfs', target: '/evidence', 'tmpfs-mode': '1777', 'tmpfs-size': '268435456' }),
      '--mount', dockerMountArg({ type: 'bind', source: path.join(work, 'target'), target: '/target', readonly: true }),
      REA_IMAGE, 'timeout', '-s', 'KILL', String(LAB_LIMITS.timeoutSec), 'rea', command, inner ? `/target/${inner}` : '/target', '--format', 'json'];
    const res = await run(args, (LAB_LIMITS.timeoutSec + 30) * 1000);
    if (res.timedOut || res.code === 137) { await run(['rm', '-f', name], 15_000); finish({ status: 'failed', error: 'El análisis superó el tiempo o la memoria permitidos y se detuvo.' }); return; }
    let parsed: unknown = null; try { parsed = JSON.parse(res.stdout); } catch { /* salida no JSON */ }
    const out = parseReaOutput(parsed);
    if (!out.recognized) { finish({ status: 'failed', error: `La herramienta no pudo analizar este artefacto${res.stderr.trim() ? `: ${res.stderr.trim().split('\n').slice(-2).join(' ').replace(/[\u0000-\u001f]/g, ' ').slice(0, 300)}` : '.'}` }); return; }
    finish({ status: 'done', findings: out.findings, limitations: out.limitations, summary: labSummary(out.findings) });
  } catch (e: any) { finish({ status: 'failed', error: String(e?.message ?? e).slice(0, 400) }); }
  finally { active.delete(id); try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temporal */ } }
}

export function compareLab(slug: string, beforeId: string, afterId: string) {
  const repo = labRepo(slug); const a = repo.get(beforeId), b = repo.get(afterId);
  if (!a || !b) throw err(404, 'Informe no encontrado.');
  if (a.status !== 'done' || b.status !== 'done') throw err(409, 'Los dos informes deben haber terminado bien para compararlos.');
  if (a.analysis !== b.analysis) throw err(409, 'Solo se comparan dos informes del mismo tipo de análisis.');
  return { before: { id: a.id, target: a.target, createdAt: a.createdAt }, after: { id: b.id, target: b.target, createdAt: b.createdAt }, ...compareLabReports(a, b) };
}

/** Al arrancar: un análisis «en marcha» de antes del reinicio ya no tiene proceso. */
export async function recoverLabAtStartup(slugs: string[]): Promise<number> {
  let n = 0;
  for (const s of slugs) { try { for (const r of labRepo(s).unfinished()) { if (active.has(r.id)) continue; labRepo(s).put({ ...r, status: 'failed', error: 'El Portal se reinició durante el análisis. Vuelve a lanzarlo.', finishedAt: new Date().toISOString() }); n++; } } catch { /* espacio sin laboratorio */ } }
  const ps = await run(['ps', '-aq', '--filter', 'label=portal-ia.lab=1'], 8000);
  const ids = ps.code === 0 ? ps.stdout.split(/\s+/).filter(Boolean) : []; if (ids.length) await run(['rm', '-f', ...ids], 20_000);
  try { for (const e of fs.readdirSync(os.tmpdir(), { withFileTypes: true })) if (e.isDirectory() && /^pia-lab-/.test(e.name)) fs.rmSync(path.join(os.tmpdir(), e.name), { recursive: true, force: true }); } catch { /* sin acceso */ }
  return n;
}

/**
 * ¿Hay una versión más nueva de REA? Solo CONSULTA los metadatos públicos del registro de npm (no envía nada del
 * propietario ni instala nada). Adoptar una versión es una decisión revisada: cambiar la versión y la huella fijadas
 * en docker/rea.Dockerfile y en REA_PIN, reconstruir la imagen y repetir las pruebas. La imagen anterior se conserva.
 */
export async function checkReaUpdate(fetchImpl: typeof fetch = fetch): Promise<ReaUpdateCheck> {
  const base: ReaUpdateCheck = { checkedAt: new Date().toISOString(), pinned: REA_PIN.version, latest: null, latestPublishedAt: null, ageDays: null, integrity: null, maintainers: [], engines: null, verdict: 'unavailable', notes: [] };
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/${REA_PIN.package}`, { headers: { accept: 'application/json', 'user-agent': 'portal-ia-update-check' }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { ...base, notes: [`El registro de npm respondió ${res.status}.`] };
    const j: any = await res.json();
    const latest = typeof j?.['dist-tags']?.latest === 'string' ? j['dist-tags'].latest : null; if (!latest) return { ...base, notes: ['El registro no indica una versión «latest».'] };
    const v = j.versions?.[latest] ?? {}; const published = typeof j.time?.[latest] === 'string' ? j.time[latest] : null;
    const ageDays = published ? Math.floor((Date.now() - new Date(published).getTime()) / 86_400_000) : null;
    const maintainers = (Array.isArray(j.maintainers) ? j.maintainers : []).map((m: any) => String(m?.name ?? '')).filter(Boolean).slice(0, 10);
    const pinnedIntegrity = j.versions?.[REA_PIN.version]?.dist?.integrity ?? null;
    const notes: string[] = [];
    if (pinnedIntegrity && pinnedIntegrity !== REA_PIN.integrity) notes.push('ATENCIÓN: la huella que publica npm para la versión fijada ya no coincide con la que se revisó. No reconstruyas la imagen hasta aclararlo.');
    if (maintainers.length !== 1) notes.push(`El paquete tiene ${maintainers.length} mantenedores (${maintainers.join(', ')}); cuando se revisó tenía uno. Un cambio de mantenedores es motivo para parar y revisar.`);
    let verdict: ReaUpdateCheck['verdict'] = 'up_to_date';
    if (latest !== REA_PIN.version) {
      verdict = ageDays != null && ageDays >= REA_PIN.cooldownDays ? 'review' : 'wait';
      notes.push(verdict === 'review' ? `Hay una versión más nueva (${latest}) publicada hace ${ageDays} días. Antes de adoptarla: leer sus notas de versión, comparar dependencias y scripts, reconstruir la imagen con su huella y repetir las pruebas del laboratorio.` : `Hay una versión más nueva (${latest}), publicada hace ${ageDays ?? '?'} días. Se espera a que cumpla ${REA_PIN.cooldownDays} días antes de proponerla.`);
    }
    return { ...base, latest, latestPublishedAt: published, ageDays, integrity: typeof v?.dist?.integrity === 'string' ? v.dist.integrity : null, maintainers, engines: typeof v?.engines?.node === 'string' ? v.engines.node : null, verdict, notes };
  } catch (e: any) { return { ...base, notes: [`No se pudo consultar el registro de npm: ${String(e?.message ?? e).slice(0, 200)}`] }; }
}
