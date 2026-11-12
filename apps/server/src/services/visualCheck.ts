import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Process } from '@portal-ia/domain';
import { processesRepo } from '../db/workspace.ts';
import { requirePolicy } from './executionPolicy.ts';
import { previewsOf, startPreview } from './preview.ts';
import { evidenceDir } from './runtimeChecks.ts';

/**
 * Verificación visual obligatoria (HU-207). Sin IA.
 * - `routesForChanges`: rutas del Portal que hay que capturar, deducidas de los archivos tocados y del mapa de UX
 *   (apps/web/visual-routes.json).
 * - `evaluateVisualReport`: puro; exige el mismo commit, los tres anchos por ruta, un PNG por combinación, ningún
 *   desbordamiento, ninguna violación serious/critical y que el estado no sea unavailable.
 * - `runVisualCheck`: con la política (`runtime_check`), arranca o reutiliza la vista previa del commit y ejecuta
 *   scripts/visual-check.mjs en el HOST con un plazo (se mata de verdad al vencer o al cancelar). Queda auditado en
 *   execution_history. Las evidencias quedan en data/evidence/<proceso>/visual/<commit>/.
 * - `visualGate`: lo que exige el Gauntlet cuando la historia toca apps/web/src.
 */

export const VISUAL_WIDTHS = [375, 768, 1440] as const;
export const WEB_SRC = 'apps/web/src/';
export const ROUTE_MAP_FILE = 'apps/web/visual-routes.json';
const here = path.dirname(fileURLToPath(import.meta.url));
/** Instalación del Portal en marcha (services → src → server → apps → raíz): allí están el script y su Playwright. */
const PORTAL_INSTALL = path.resolve(here, '..', '..', '..', '..');
export const VISUAL_SCRIPT = path.join(PORTAL_INSTALL, 'scripts', 'visual-check.mjs');
const RUN_TIMEOUT_MS = Math.max(60_000, Number(process.env.PORTAL_VISUAL_TIMEOUT_MS) || 10 * 60_000);
const PREVIEW_WAIT_MS = 8 * 60_000;

export interface VisualRouteEntry { match: string; routes: string[]; seed?: string[] }
export interface VisualRouteMap { version?: number; entries: VisualRouteEntry[] }
export interface VisualVerdict { ok: boolean; missing: string[]; reasons: string[] }
export interface VisualGate extends VisualVerdict { required: boolean; routes: string[]; commit: string | null; dir: string | null; report: VisualReport | null }
export interface VisualResult { route: string; width: number; screenshot?: string | null; overflow?: boolean; scrollWidth?: number; clientWidth?: number; bodyScrollWidth?: number; bodyClientWidth?: number; violations?: { id: string; impact: string | null; nodes?: number }[]; status?: string; reasons?: string[] }
export interface VisualReport { commit: string; routes: string[]; widths: number[]; results: VisualResult[]; status: string; reason?: string | null }
export interface VisualRun { status: 'ok' | 'fail' | 'unavailable' | 'not_required'; exitCode: number | null; detail: string; gate: VisualGate }

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');
const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
function patternRe(p: string): RegExp {
  const n = norm(p);
  if (n.endsWith('/')) return new RegExp(`^${esc(n)}`);
  return new RegExp(`^${n.split('**').map(part => part.split('*').map(esc).join('[^/]*')).join('.*')}$`);
}

/** Rutas esperadas (sin duplicados, en el orden del mapa) para los archivos tocados. */
export function routesForChanges(paths: string[], map: VisualRouteMap | null): string[] {
  if (!map?.entries?.length) return [];
  const files = paths.map(norm);
  const out: string[] = [];
  for (const e of map.entries) {
    let re: RegExp; try { re = patternRe(e.match); } catch { continue; }
    if (files.some(f => re.test(f))) for (const r of e.routes ?? []) if (typeof r === 'string' && r && !out.includes(r)) out.push(r);
  }
  return out;
}

export function touchesWeb(paths: string[]): boolean { return paths.map(norm).some(p => p.startsWith(WEB_SRC)); }

export function loadRouteMap(root: string): VisualRouteMap | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, ...ROUTE_MAP_FILE.split('/')), 'utf8')) as Partial<VisualRouteMap>;
    return Array.isArray(raw.entries) ? { version: raw.version, entries: raw.entries } : null;
  } catch { return null; }
}

export function sameCommit(a: unknown, b: unknown): boolean {
  const x = String(a ?? '').trim().toLowerCase(); const y = String(b ?? '').trim().toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Puro (salvo `exists`): ¿el informe prueba las rutas esperadas en el commit indicado? */
export function evaluateVisualReport(report: unknown, expected: string[], commit: string, dir: string, exists: (p: string) => boolean = p => fs.existsSync(p)): VisualVerdict {
  const missing: string[] = []; const reasons: string[] = [];
  if (!expected.length) return { ok: false, missing, reasons: ['no se dedujo ninguna ruta a capturar de los archivos tocados (revisa apps/web/visual-routes.json)'] };
  const rep = report as Partial<VisualReport> | null;
  if (!rep || typeof rep !== 'object' || !Array.isArray(rep.results)) return { ok: false, missing: expected.flatMap(r => VISUAL_WIDTHS.map(w => `${r}@${w}`)), reasons: ['falta report.json o no es válido'] };
  if (!sameCommit(rep.commit, commit)) reasons.push(`el informe es del commit ${String(rep.commit ?? '?')}, no del aplicado ${commit}`);
  if (rep.status === 'unavailable') reasons.push(`verificación no disponible: ${rep.reason ?? 'faltan herramientas'}`);
  for (const route of expected) {
    for (const w of VISUAL_WIDTHS) {
      const r = rep.results.find(x => x && x.route === route && x.width === w);
      if (!r) { missing.push(`${route}@${w}`); continue; }
      if (!r.screenshot || !exists(path.join(dir, path.basename(String(r.screenshot))))) missing.push(`${route}@${w} (sin PNG)`);
      if (r.overflow || num(r.scrollWidth) > num(r.clientWidth) || num(r.bodyScrollWidth) > num(r.bodyClientWidth)) reasons.push(`${route} @${w}px: desbordamiento horizontal`);
      const grave = (r.violations ?? []).filter(v => v.impact === 'serious' || v.impact === 'critical');
      if (grave.length) reasons.push(`${route} @${w}px: axe ${grave.map(v => `${v.impact} ${v.id}`).join(', ')}`);
      if (r.status !== 'ok') reasons.push(`${route} @${w}px: ${(r.reasons ?? []).join('; ') || `estado ${String(r.status)}`}`);
    }
  }
  if (missing.length) reasons.push(`faltan capturas: ${missing.join(', ')}`);
  return { ok: !reasons.length && !missing.length, missing, reasons: Array.from(new Set(reasons)) };
}

export function visualDir(processId: string, commit: string): string {
  return path.join(evidenceDir(processId), 'visual', commit.replace(/[^A-Za-z0-9]/g, '_'));
}

function changedFiles(proc: Process): string[] {
  const r = proc.result;
  const fromChanges = (r?.changes ?? []).map(c => (c as { path?: string }).path).filter((p): p is string => typeof p === 'string');
  return Array.from(new Set([...fromChanges, ...(r?.applied?.files ?? [])].map(norm)));
}

/** Puerta del Gauntlet: obligatoria si la historia toca apps/web/src. */
export function visualGate(_slug: string, proc: Process): VisualGate {
  const files = changedFiles(proc);
  const base: VisualGate = { required: touchesWeb(files), ok: true, missing: [], reasons: [], routes: [], commit: null, dir: null, report: null };
  if (!base.required) return base;
  const applied = proc.result?.applied ?? null;
  if (!applied?.commit) return { ...base, ok: false, reasons: ['no hay commit aplicado que verificar'] };
  const root = applied.worktree && fs.existsSync(applied.worktree) ? applied.worktree : PORTAL_INSTALL;
  const routes = routesForChanges(files, loadRouteMap(root));
  const dir = visualDir(proc.id, applied.commit);
  let report: VisualReport | null = null;
  try { report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')) as VisualReport; } catch { report = null; }
  const v = evaluateVisualReport(report, routes, applied.commit, dir);
  return { ...base, ...v, routes, commit: applied.commit, dir, report };
}

/** Resumen para el Evaluador (rutas, anchos, desbordes, violaciones y capturas). */
export function visualSummary(g: VisualGate): string {
  if (!g.required) return 'Verificación visual: no aplica (la historia no toca apps/web/src).';
  const lines = [`Verificación visual (commit ${g.commit ?? '?'}): ${g.ok ? 'superada' : 'NO superada'}. Rutas: ${g.routes.join(', ') || '(ninguna)'}; anchos ${VISUAL_WIDTHS.join(', ')} px.`];
  for (const r of g.report?.results ?? []) lines.push(`- ${r.route} @${r.width}px: ${r.status ?? '?'}; scrollWidth ${num(r.scrollWidth)} / clientWidth ${num(r.clientWidth)}; axe graves ${(r.violations ?? []).filter(v => v.impact === 'serious' || v.impact === 'critical').length}; captura ${r.screenshot && g.dir ? path.join(g.dir, path.basename(r.screenshot)) : '—'}`);
  if (g.reasons.length) lines.push(`Motivos: ${g.reasons.join(' · ')}`);
  return lines.join('\n');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Proveedor que se conecta en la vista previa. Allí corre el adaptador simulado (PORTAL_MOCK_PROVIDER=1): sin red,
 * sin coste y sin credenciales reales. El id tiene que ser uno de los que admite /api/providers/:id (anthropic|openai).
 */
export const PREVIEW_SIM_PROVIDER = 'anthropic';
const PREVIEW_SIM_KEY = 'preview-visual-check-simulada';
export interface PreviewResponse { ok: boolean; status: number; json: () => Promise<unknown> }
export type PreviewFetch = (url: string, init: { method: string; body?: string; headers?: Record<string, string> }) => Promise<PreviewResponse>;

const defaultPreviewFetch: PreviewFetch = async (url, init) => {
  const r = await fetch(url, { method: init.method, body: init.body, headers: init.headers, signal: AbortSignal.timeout(30_000) });
  return { ok: r.ok, status: r.status, json: () => r.json() as Promise<unknown> };
};

/**
 * Prepara una vista previa vacía antes de capturar: conecta el proveedor simulado y crea el espacio interno.
 * Así las pantallas no redirigen al asistente de inicio. Es idempotente: si ya está listo, no escribe nada.
 * Sin IA (verificar el proveedor simulado no sale a la red).
 */
export async function initPreviewData(baseUrl: string, f: PreviewFetch = defaultPreviewFetch): Promise<{ steps: string[]; status: { providerConnected: boolean; initialized: boolean } }> {
  const base = baseUrl.replace(/\/+$/, '');
  const json = { 'content-type': 'application/json' };
  const readStatus = async () => {
    const r = await f(`${base}/api/bootstrap/status`, { method: 'GET' });
    if (!r.ok) throw new Error(`la vista previa no respondió al estado de inicialización (HTTP ${r.status})`);
    const s = (await r.json().catch(() => ({}))) as { providerConnected?: unknown; initialized?: unknown };
    return { providerConnected: !!s?.providerConnected, initialized: !!s?.initialized };
  };
  const steps: string[] = [];
  const st = await readStatus();
  if (!st.providerConnected) {
    const put = await f(`${base}/api/providers/${PREVIEW_SIM_PROVIDER}/credential`, { method: 'PUT', headers: json, body: JSON.stringify({ apiKey: PREVIEW_SIM_KEY }) });
    if (!put.ok) throw new Error(`no se pudo guardar la credencial del proveedor simulado en la vista previa (HTTP ${put.status})`);
    const ver = await f(`${base}/api/providers/${PREVIEW_SIM_PROVIDER}/verify`, { method: 'POST', headers: json, body: '{}' });
    if (!ver.ok) throw new Error(`el proveedor simulado no se verificó en la vista previa (HTTP ${ver.status}); ¿arrancó con PORTAL_MOCK_PROVIDER=1?`);
    steps.push('provider');
  }
  if (!st.initialized) {
    const b = await f(`${base}/api/bootstrap/internal`, { method: 'POST', headers: json, body: '{}' });
    if (!b.ok) throw new Error(`no se pudo inicializar el espacio interno de la vista previa (HTTP ${b.status})`);
    steps.push('bootstrap');
  }
  const after = await readStatus();
  if (!after.providerConnected || !after.initialized) throw new Error('la vista previa sigue sin inicializar: las pantallas redirigirían al asistente');
  return { steps, status: after };
}

async function readyPreview(slug: string, processId: string, commit: string, signal?: AbortSignal): Promise<string> {
  const mine = () => previewsOf(slug, processId).filter(p => p.live && sameCommit(p.commit, commit));
  const ready = () => mine().find(p => p.status === 'ready' && !!p.url)?.url ?? null;
  const now = ready(); if (now) return now;
  if (!mine().length) await startPreview(slug, processId);
  const t0 = Date.now();
  for (;;) {
    if (signal?.aborted) throw new Error('verificación cancelada');
    const u = ready(); if (u) return u;
    if (!mine().length && Date.now() - t0 > 5_000) throw new Error('la vista previa se detuvo antes de estar lista');
    if (Date.now() - t0 > PREVIEW_WAIT_MS) throw new Error(`la vista previa no estuvo lista en ${PREVIEW_WAIT_MS / 60_000} min`);
    await sleep(2_000);
  }
}

function scriptEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'PORTAL_AXE', 'PORTAL_PLAYWRIGHT', 'PLAYWRIGHT_BROWSERS_PATH'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] != null) env[k] = process.env[k];
  return env;
}

function runScript(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [VISUAL_SCRIPT, ...args], { cwd: PORTAL_INSTALL, env: scriptEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = ''; let timedOut = false; let done = false;
    const add = (b: Buffer) => { out = (out + b.toString('utf8')).slice(-20_000); };
    child.stdout?.on('data', add); child.stderr?.on('data', add);
    const kill = () => {
      if (process.platform === 'win32' && child.pid) { try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* sigue */ } }
      try { child.kill('SIGKILL'); } catch { /* ya terminó */ }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (code: number | null) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve({ code, out, timedOut }); };
    child.on('error', e => { out += `\n${e.message}`; finish(null); });
    child.on('close', code => finish(code));
  });
}

const inflight = new Map<string, Promise<VisualRun>>();

/** Ejecuta la verificación visual en el host (una a la vez por proceso). Nunca da por buena una ejecución incompleta. */
export function runVisualCheck(slug: string, processId: string, opts: { timeoutMs?: number; vars?: Record<string, string>; signal?: AbortSignal; authorized?: boolean } = {}): Promise<VisualRun> {
  const key = `${slug}:${processId}`;
  const running = inflight.get(key); if (running) return running;
  const p = doRun(slug, processId, opts).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function doRun(slug: string, processId: string, opts: { timeoutMs?: number; vars?: Record<string, string>; signal?: AbortSignal; authorized?: boolean }): Promise<VisualRun> {
  const procs = processesRepo(slug);
  const proc = procs.get(processId);
  if (!proc) throw Object.assign(new Error('Proceso no encontrado'), { statusCode: 404, code: 'process_not_found' });
  const pre = visualGate(slug, proc);
  if (!pre.required) return { status: 'not_required', exitCode: null, detail: 'La historia no toca apps/web/src.', gate: pre };
  if (!pre.commit || !pre.routes.length) return { status: 'fail', exitCode: null, detail: pre.reasons.join(' · '), gate: pre };
  const authorized = opts.authorized ?? !['cancelled', 'rejected', 'pending', 'draft'].includes(String(proc.status));
  requirePolicy('runtime_check', { slug, processId, projectId: proc.projectId, authorized });
  const startedAt = new Date().toISOString();
  const audit = (status: VisualRun['status'], detail: string) => {
    try { procs.logExecution({ projectId: proc.projectId, agentId: '', kind: `visual_check:${status}:${pre.commit}${status === 'ok' ? '' : `:${detail.slice(0, 160)}`}`, status: status === 'ok' ? 'done' : 'failed', tokensIn: 0, tokensOut: 0, cost: 0, startedAt }); } catch { /* la auditoría no rompe la verificación */ }
  };
  const dir = visualDir(processId, pre.commit);
  let status: VisualRun['status']; let detail: string; let exitCode: number | null = null;
  try {
    const url = await readyPreview(slug, processId, pre.commit, opts.signal);
    await initPreviewData(url);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    const vars = Object.entries(opts.vars ?? {}).map(([k, v]) => `${k}=${v}`).join(',');
    const args = ['--base-url', url, '--routes', pre.routes.join(','), '--out', dir, '--commit', pre.commit, ...(vars ? ['--vars', vars] : [])];
    const r = await runScript(args, opts.timeoutMs ?? RUN_TIMEOUT_MS, opts.signal);
    exitCode = r.code;
    status = r.code === 0 ? 'ok' : r.code === 1 ? 'fail' : 'unavailable';
    detail = r.timedOut ? 'plazo agotado: verificación detenida' : (r.out.trim().split(/\r?\n/).slice(-8).join(' | ') || `código ${String(r.code)}`);
  } catch (e) {
    status = 'unavailable'; detail = `no se pudo ejecutar en el host: ${(e as Error).message}`;
  }
  const gate = visualGate(slug, procs.get(processId) ?? proc);
  if (status === 'ok' && !gate.ok) { status = 'fail'; detail = gate.reasons.join(' · '); }
  audit(status, detail);
  return { status, exitCode, detail, gate };
}
