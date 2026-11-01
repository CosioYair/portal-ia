import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PreviewRecord } from '@portal-ia/domain';
import { REPO_ROOT, config } from '../config.ts';
import { processesRepo, projectsRepo } from '../db/workspace.ts';
import { withRwLock } from './capacity.ts';
import { changed } from './live.ts';
import { mainBranch, readProtectedReason, repoRoot, scanSecrets } from './repoWrite.ts';
import { clipSandboxOutput, depsVolumeName, detectSandbox, dockerCliEnv, dockerMountArg, NM_CACHES, SANDBOX_IMAGE } from './sandbox.ts';

/**
 * Vista previa temporal de un candidato de integración, para que el propietario PRUEBE la historia antes de aceptarla. Sin IA.
 *
 * Qué se ve: el árbol exacto que dejaría integrarla (`git merge-tree` de main + la rama, sin tocar ninguna referencia ni el
 * worktree), exportado a una carpeta temporal con un índice propio. Si choca con main, la rama sola (y se dice).
 *
 * Aislamiento (el código del candidato lo escribieron agentes y aún no lo aceptaste):
 * - contenedor de la imagen del sandbox SIN red (`--network none`), sin privilegios, raíz de solo lectura, copia del
 *   candidato de solo lectura, /tmp y la salida de la compilación en tmpfs con tamaño acotado, dependencias del volumen de
 *   la verificación en solo lectura; datos del Portal temporales y proveedor de IA SIMULADO; ni credenciales ni el
 *   directorio de datos real ni variables del servidor (solo `-e CLAVE=valor` explícitas);
 * - el navegador llega por un proxy HTTP de confianza (otro contenedor) que solo reenvía al socket del candidato y añade una
 *   política de seguridad: la página no puede hablar con otros orígenes (el Portal en marcha), registrar service workers
 *   ni incrustarse. Se publica en 127.0.0.2 (otro origen y otras cookies que el Portal en 127.0.0.1);
 * - tiempo máximo (también dentro de los contenedores, por si el Portal cae) y limpieza al arrancar.
 * Detenerla retira los contenedores, su volumen de socket y la copia; nunca el worktree ni la rama de la historia, y el
 * registro (commit, árbol, estado, últimas líneas) queda como evidencia en el proceso.
 */

const execFileP = promisify(execFile);
const fail = (statusCode: number, message: string, code: string) => Object.assign(new Error(message), { statusCode, code });
const TTL_MIN = Math.min(120, Math.max(5, Number(process.env.PORTAL_PREVIEW_TTL_MIN) || 45));
const MAX_LIVE = Math.max(1, Number(process.env.PORTAL_PREVIEW_MAX) || 1);
/** Siempre otro host de bucle local que el Portal (127.0.0.1/localhost comparten cookies y la lista de orígenes permitidos). */
const BIND = (() => { const h = process.env.PORTAL_PREVIEW_HOST || '127.0.0.2'; return /^127\.\d+\.\d+\.\d+$/.test(h) && h !== '127.0.0.1' ? h : '127.0.0.2'; })();
const START_MS = Number(process.env.PORTAL_PREVIEW_START_MS) || 6 * 60_000;
const realLower = (p: string) => { try { return fs.realpathSync(p).toLowerCase(); } catch { return path.resolve(p).toLowerCase(); } };
/** Esta instancia del Portal (por su carpeta de datos): la limpieza nunca toca las vistas previas de otra instancia. */
const OWNER = createHash('sha1').update(realLower(config.dataDir)).digest('hex').slice(0, 12);
const ROOT = path.join(os.tmpdir(), 'portal-ia-previews', OWNER);
const LABELS = (id: string) => ['--label', `portal-ia.preview=${id}`, '--label', `portal-ia.preview.owner=${OWNER}`];
/** Git sin conversiones ni filtros (LFS) ni enlaces: exportar nunca dispara nada en el equipo por el contenido del candidato. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const GIT_SAFE = ['--attr-source', EMPTY_TREE, '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.symlinks=false', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.clean=', '-c', 'filter.lfs.required=false'];
const gitOut = async (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => (await execFileP('git', [...GIT_SAFE, ...args], { cwd, windowsHide: true, maxBuffer: 50 * 1024 * 1024, env: env ?? process.env })).stdout;
const docker = async (args: string[], timeout = 60_000) => { const r = await execFileP('docker', args, { env: dockerCliEnv(), windowsHide: true, timeout, maxBuffer: 10 * 1024 * 1024 }); return `${r.stdout}`.trim(); };

type Live = { slug: string; processId: string; id: string; app: string; proxy: string; vol: string; net: string; dir: string; timer: NodeJS.Timeout | null; stopping: boolean };
const live = new Map<string, Live>();
/** Procesos con una vista previa preparándose (antes de registrarla): el límite cuenta también estas (dos pestañas a la vez). */
const reserving = new Set<string>();
let logger: (o: any, m: string) => void = () => undefined;
export function setPreviewLogger(l: (o: any, m: string) => void) { logger = l; }

/** ¿Está en marcha esta vista previa en ESTA instancia? (un registro «lista» de antes de un reinicio ya no lo está). */
export const previewLive = (processId: string, previewId: string) => live.get(previewId)?.processId === processId;

function setRecord(slug: string, processId: string, id: string, patch: Partial<PreviewRecord>) {
  const procs = processesRepo(slug); const cur = procs.get(processId); if (!cur?.result) return;
  procs.setResult(processId, { ...cur.result, previews: (cur.result.previews ?? []).map(x => x.id === id ? { ...x, ...patch } : x) });
  changed({ ws: slug, entity: 'process', id: processId });
}
const recordOf = (slug: string, processId: string, id: string) => processesRepo(slug).get(processId)?.result?.previews?.find(x => x.id === id) ?? null;

/** Copia exacta de un árbol con un índice temporal propio: no cambia HEAD, el índice, ninguna referencia ni ningún worktree. */
async function exportTree(root: string, tree: string, dir: string, work: string) {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, 'index'), GIT_LFS_SKIP_SMUDGE: '1' };
  await gitOut(root, ['read-tree', tree], env);
  // Lo protegido (.env, datos, credenciales, .git…) se quita del índice antes de escribir nada: nunca llega al disco.
  const prot = (await gitOut(root, ['ls-files', '-z'], env)).split('\0').filter(f => f && readProtectedReason(f) !== null);
  for (let i = 0; i < prot.length; i += 100) await gitOut(root, ['rm', '--cached', '-q', '--ignore-unmatch', '--', ...prot.slice(i, i + 100)], env);
  await gitOut(root, ['checkout-index', '-a', '-f', `--prefix=${work.replace(/\\/g, '/')}/`], env);
  fs.rmSync(path.join(dir, 'index'), { force: true });
}
const isAncestor = (root: string, a: string, b: string) => execFileP('git', ['merge-base', '--is-ancestor', a, b], { cwd: root, windowsHide: true }).then(() => true, () => false);
/** Retira contenedores, red y volumen de una vista previa (por su etiqueta) y comprueba que no queda nada. */
async function removeResources(id: string): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    const ids = (await docker(['ps', '-aq', '--filter', `label=portal-ia.preview=${id}`]).catch(() => '')).split(/\s+/).filter(Boolean);
    if (ids.length) await docker(['rm', '-f', ...ids]).catch(() => '');
    for (const v of (await docker(['volume', 'ls', '-q', '--filter', `label=portal-ia.preview=${id}`]).catch(() => '')).split(/\s+/).filter(Boolean)) await docker(['volume', 'rm', v]).catch(() => '');
    for (const n of (await docker(['network', 'ls', '-q', '--filter', `label=portal-ia.preview=${id}`]).catch(() => '')).split(/\s+/).filter(Boolean)) await docker(['network', 'rm', n]).catch(() => '');
    if (!(await docker(['ps', '-aq', '--filter', `label=portal-ia.preview=${id}`]).catch(() => 'x'))) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}
const removeDir = (dir: string) => { if (path.resolve(dir).startsWith(path.resolve(ROOT) + path.sep)) fs.rmSync(dir, { recursive: true, force: true }); };

/**
 * Prepara y arranca la vista previa del candidato actual del proceso. Devuelve enseguida (estado «arrancando»): la
 * compilación y el arranque siguen en segundo plano y el registro pasa a «lista» (con su dirección) o a «falló» (con el
 * motivo y las últimas líneas). Una sola a la vez por proceso; como mucho PORTAL_PREVIEW_MAX en total.
 */
export async function startPreview(slug: string, processId: string): Promise<PreviewRecord> {
  const procs = processesRepo(slug); const p = procs.get(processId);
  if (!p || p.kind !== 'story_execution' || !p.result) throw fail(404, 'Proceso de historia no encontrado.', 'not_found');
  if (p.status === 'running' || p.status === 'pending_authorization') throw fail(409, 'La historia está trabajando: su código aún cambia. Abre la vista previa cuando termine.', 'active');
  const r = p.result;
  if (!r.applied?.branch) throw fail(409, 'La historia aún no tiene una rama aplicada que previsualizar.', 'not_applied');
  if (r.merged) throw fail(409, `Ya está integrada en ${r.merged.into} (${r.merged.commit}): pruébala en el Portal en marcha.`, 'merged');
  const mine = [...live.values()].find(l => l.processId === processId);
  if (mine) { const rec = recordOf(slug, processId, mine.id); if (rec) return rec; }
  if (reserving.has(processId)) throw fail(409, 'Ya se está preparando su vista previa.', 'preview_starting');
  if (live.size + reserving.size >= MAX_LIVE) { const o = [...live.values()][0]; throw fail(409, `Ya hay una vista previa en marcha o preparándose${o ? ` (${processesRepo(o.slug).get(o.processId)?.title ?? o.processId})` : ''}: detenla antes de abrir otra.`, 'preview_limit'); }
  reserving.add(processId);
  try { return await startReserved(slug, processId); } finally { reserving.delete(processId); }
}

async function startReserved(slug: string, processId: string): Promise<PreviewRecord> {
  const procs = processesRepo(slug); const p = procs.get(processId)!; const r = p.result!;
  if (!r.applied?.branch) throw fail(409, 'La historia aún no tiene una rama aplicada que previsualizar.', 'not_applied');
  const sb = await detectSandbox();
  if (sb.available !== 'docker') throw fail(409, `La vista previa necesita Docker con la imagen del sandbox (aislamiento obligatorio): ${sb.detail}`, 'docker_required');
  const repo = projectsRepo(slug).repository(p.projectId); if (!repo) throw fail(409, 'No hay repositorio registrado.', 'no_repo');
  const root = repoRoot(repo.path); const branch = r.applied.branch; const target = await mainBranch(root, branch);
  const head = (await gitOut(root, ['rev-parse', '--verify', `${branch}^{commit}`]).catch(() => '')).trim();
  if (!head) throw fail(409, `La rama ${branch} ya no existe.`, 'no_branch');
  if (!head.startsWith(r.applied.commit.slice(0, 7))) throw fail(409, `La rama tiene commits que el Portal no registró (${r.applied.commit} → ${head.slice(0, 7)}): no se previsualiza algo distinto de lo verificado.`, 'unregistered_commits');
  const mainHead = (await gitOut(root, ['rev-parse', target])).trim();
  // Lo que dejaría integrarla: main + candidato, en memoria. Si choca, la rama sola (y se dice).
  let tree = ''; let combined = true;
  try { tree = (await gitOut(root, ['merge-tree', '--write-tree', mainHead, head])).split(/\r?\n/)[0].trim(); }
  catch (e: any) { if (e?.code !== 1) throw e; combined = false; tree = (await gitOut(root, ['rev-parse', `${head}^{tree}`])).trim(); }
  const provisional = r.stack && !(await isAncestor(root, r.stack.commit, mainHead)) ? { storyId: r.stack.storyId, commit: r.stack.commit.slice(0, 7) } : null;
  const has = (rel: string) => execFileP('git', ['cat-file', '-e', `${tree}:${rel}`], { cwd: root, windowsHide: true }).then(() => true, () => false);
  let profile: PreviewRecord['profile'] | null = null;
  if (await has('apps/server/src/index.ts') && await has('apps/web/package.json')) profile = 'portal';
  else { try { if (JSON.parse(await gitOut(root, ['cat-file', 'blob', `${tree}:package.json`]))?.scripts?.preview) profile = 'script'; } catch { /* sin package.json */ } }
  if (!profile) throw fail(409, 'Este proyecto no tiene cómo previsualizarse: añade a package.json un script «preview» que sirva la aplicación en el puerto $PORT de $HOST, sin red (por ejemplo, tras compilar). El Portal se previsualiza solo.', 'no_preview_profile');

  const id = randomBytes(5).toString('hex'); const dir = path.join(ROOT, id); const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  let volume = '';
  try {
    await exportTree(root, tree, dir, work);
    // Puntos de montaje dentro de la copia (que se monta de solo lectura): Docker no podría crearlos.
    fs.mkdirSync(path.join(work, 'node_modules'), { recursive: true });
    if (profile === 'portal') fs.mkdirSync(path.join(work, 'apps', 'web', 'dist'), { recursive: true });
    volume = depsVolumeName(work);
    if (!(await docker(['volume', 'inspect', '--format', '{{.Name}}', volume]).catch(() => ''))) throw fail(409, `Faltan las dependencias Linux de este candidato (volumen ${volume}): se crean al verificarlo en el sandbox («install» con red temporal). No se ha arrancado nada.`, 'deps_missing');
    // Código de confianza del Portal en marcha, copiado: se monta cada archivo, nunca una carpeta del Portal.
    fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'preview-runner.mjs'), path.join(dir, 'runner.mjs'));
    fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'preview-proxy.mjs'), path.join(dir, 'proxy.mjs'));
  } catch (e) { removeDir(dir); throw e; }
  const at = new Date();
  const rec: PreviewRecord = { id, commit: head.slice(0, 7), mainHead: mainHead.slice(0, 7), tree, combined, includesProvisional: provisional, profile, status: 'starting', url: null, startedAt: at.toISOString(), expiresAt: new Date(at.getTime() + TTL_MIN * 60_000).toISOString(), reason: combined ? null : `Choca con ${target}: se previsualiza la rama sola, sin el ${target} actual.`, readyAt: null, stoppedAt: null, logTail: null };
  const cur = procs.get(processId)!;
  procs.setResult(processId, { ...cur.result!, previews: [...(cur.result!.previews ?? []).slice(-9), rec] });
  const l: Live = { slug, processId, id, app: `portal-ia-pv-${id}-app`, proxy: `portal-ia-pv-${id}-proxy`, vol: `portal-ia-pv-${id}-sock`, net: `portal-ia-pv-${id}-net`, dir, timer: null, stopping: false };
  live.set(id, l);
  changed({ ws: slug, entity: 'process', id: processId });
  logger({ processId, previewId: id, commit: rec.commit, mainHead: rec.mainHead, combined, profile }, 'vista previa: arrancando (aislada, sin IA)');
  ensureSweeper();
  void launch(l, rec, work, volume, profile);
  return rec;
}

async function launch(l: Live, rec: PreviewRecord, work: string, volume: string, profile: PreviewRecord['profile']) {
  const ttlSec = String(TTL_MIN * 60);
  const mb = (n: number) => String(n * 1024 * 1024);
  const logs = ['--log-opt', 'max-size=1m', '--log-opt', 'max-file=2'];
  try {
    // Socket en un volumen tmpfs de 1 MB (no disco, no el HOME del proxy) y una red propia para el proxy (sin otros contenedores).
    await docker(['volume', 'create', ...LABELS(l.id), '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', 'o=size=1m,uid=1000,gid=1000,mode=0700', l.vol]);
    await docker(['network', 'create', ...LABELS(l.id), '-o', 'com.docker.network.bridge.enable_icc=false', l.net]);
    const appArgs = ['run', '-d', '--rm', '--init', '--pull', 'never', '--name', l.app, ...LABELS(l.id), ...logs,
      '--network', 'none', '--memory', '1536m', '--cpus', '1.5', '--pids-limit', '512', '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--user', '1000:1000', '--read-only',
      '--mount', dockerMountArg({ type: 'tmpfs', target: '/tmp', 'tmpfs-mode': '1777', 'tmpfs-size': mb(512) }),
      '--mount', dockerMountArg({ type: 'bind', source: work, target: '/work', readonly: true }),
      '--mount', dockerMountArg({ type: 'volume', source: volume, target: '/work/node_modules', readonly: true }),
      ...NM_CACHES.flatMap(c => ['--mount', dockerMountArg({ type: 'tmpfs', target: `/work/node_modules/${c}`, 'tmpfs-mode': '1777', 'tmpfs-size': mb(256) })]),
      ...(profile === 'portal' ? ['--mount', dockerMountArg({ type: 'tmpfs', target: '/work/apps/web/dist', 'tmpfs-mode': '1777', 'tmpfs-size': mb(256) })] : []),
      '--mount', dockerMountArg({ type: 'volume', source: l.vol, target: '/run/pv' }),
      '--mount', dockerMountArg({ type: 'bind', source: path.join(l.dir, 'runner.mjs'), target: '/portal-preview/runner.mjs', readonly: true }),
      '-e', 'HOME=/tmp', '-e', 'TMPDIR=/tmp', '-e', 'CI=1', '-e', 'PORTAL_INSIDE_SANDBOX=1',
      '-w', '/work', SANDBOX_IMAGE, 'timeout', ttlSec, 'node', '/portal-preview/runner.mjs', profile];
    const banner = `Vista previa aislada · candidato ${rec.commit}${rec.combined ? ` + main ${rec.mainHead}` : ''}${rec.includesProvisional ? ` · incluye la versión provisional de ${rec.includesProvisional.storyId}` : ''} · NO es el Portal en marcha: no escribas claves ni datos reales`;
    const proxyArgs = ['run', '-d', '--rm', '--init', '--pull', 'never', '--name', l.proxy, ...LABELS(l.id), ...logs, '--network', l.net, '-p', `${BIND}:0:8080`,
      '--memory', '128m', '--cpus', '0.5', '--pids-limit', '64', '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--user', '1000:1000', '--read-only',
      '--mount', dockerMountArg({ type: 'tmpfs', target: '/tmp', 'tmpfs-mode': '1777', 'tmpfs-size': mb(16) }),
      '--mount', dockerMountArg({ type: 'volume', source: l.vol, target: '/run/pv', readonly: true }),
      '--mount', dockerMountArg({ type: 'bind', source: path.join(l.dir, 'proxy.mjs'), target: '/portal-preview/proxy.mjs', readonly: true }),
      '-e', `PREVIEW_HOST=${BIND}`, '-e', `PREVIEW_BANNER=${banner}`, '-e', 'HOME=/tmp',
      SANDBOX_IMAGE, 'timeout', ttlSec, 'node', '/portal-preview/proxy.mjs'];
    // Las dependencias se leen con el cerrojo de lectura solo mientras compila y arranca (una instalación espera ese rato).
    const url = await withRwLock(`deps:${volume}`, false, async () => {
      await docker(appArgs);
      if (l.stopping) throw new Error('detenida');
      await docker(proxyArgs);
      if (l.stopping) throw new Error('detenida');
      const port = (await docker(['port', l.proxy, '8080/tcp'])).split(/\r?\n/)[0].split(':').pop();
      const u = `http://${BIND}:${port}/`;
      setRecord(l.slug, l.processId, l.id, { url: u });
      const health = profile === 'portal' ? 'api/health' : '';
      const t0 = Date.now();
      for (let n = 1; ; n++) {
        if (l.stopping) throw new Error('detenida');
        try { const res = await fetch(u + health, { redirect: 'manual', signal: AbortSignal.timeout(3000) }); await res.body?.cancel().catch(() => undefined); if (profile === 'portal' ? res.ok : res.status < 500) return u; } catch { /* arrancando */ }
        if (n % 5 === 0 && !(await docker(['inspect', '-f', '{{.State.Running}}', l.app]).catch(() => 'false')).includes('true')) throw new Error('el contenedor del candidato terminó al arrancar');
        if (Date.now() - t0 > START_MS) throw new Error(`no respondió en ${Math.round(START_MS / 60_000)} min`);
        await new Promise(r => setTimeout(r, 1000));
      }
    });
    if (l.stopping) return;
    setRecord(l.slug, l.processId, l.id, { status: 'ready', url, readyAt: new Date().toISOString() });
    logger({ processId: l.processId, previewId: l.id, url }, 'vista previa: lista');
    l.timer = setTimeout(() => void stopPreview(l.slug, l.processId, l.id, 'caducó (tiempo máximo de la vista previa)'), Math.max(1000, Date.parse(rec.expiresAt) - Date.now()));
    l.timer.unref?.();
  } catch (e: any) {
    // Detenida mientras arrancaba: lo que llegara a crearse se retira igualmente (nunca queda un contenedor huérfano).
    if (l.stopping) { await removeResources(l.id); return; }
    const why = String(e?.stderr || e?.message || e).trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
    await stopPreview(l.slug, l.processId, l.id, `no arrancó: ${why.slice(0, 400)}`, 'failed');
  }
}

/** Detiene la vista previa (si sigue en marcha) y deja su registro como evidencia. Nunca toca el worktree ni la rama. */
export async function stopPreview(slug: string, processId: string, id: string, reason0: string, status: 'stopped' | 'failed' = 'stopped'): Promise<PreviewRecord | null> {
  let reason = reason0;
  const l = live.get(id);
  let logTail: string | null = null;
  if (l && l.processId === processId) {
    if (l.stopping && status === 'stopped') return recordOf(slug, processId, id);
    l.stopping = true; if (l.timer) clearTimeout(l.timer);
    const logs = await execFileP('docker', ['logs', '--tail', '60', l.app], { env: dockerCliEnv(), windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }).then(r => `${r.stdout}${r.stderr}`, () => '');
    logTail = logs ? clipSandboxOutput(scanSecrets(logs) ? '[salida omitida: contenía un posible secreto]' : logs).slice(-4000) : null;
    const gone = await removeResources(id);
    removeDir(l.dir);
    live.delete(id);
    if (!gone) { reason = `${reason}; Docker no confirmó la retirada de sus contenedores: se reintentará en la próxima revisión`; leaked.add(id); }
  }
  const rec = recordOf(slug, processId, id);
  if (rec && (rec.status === 'starting' || rec.status === 'ready')) setRecord(slug, processId, id, { status, stoppedAt: new Date().toISOString(), reason, ...(logTail ? { logTail } : {}) });
  logger({ processId, previewId: id, reason }, 'vista previa: detenida');
  return recordOf(slug, processId, id);
}

/** Registros de vistas previas del proceso; los que decían «en marcha» de antes de un reinicio se cierran (ya no lo están). */
export function previewsOf(slug: string, processId: string): (PreviewRecord & { live: boolean })[] {
  const p = processesRepo(slug).get(processId); const list = p?.result?.previews ?? [];
  for (const x of list) if ((x.status === 'starting' || x.status === 'ready') && !previewLive(processId, x.id)) setRecord(slug, processId, x.id, { status: 'stopped', stoppedAt: new Date().toISOString(), reason: 'el Portal se reinició (la vista previa se retiró al arrancar)' });
  return (processesRepo(slug).get(processId)?.result?.previews ?? []).map(x => ({ ...x, live: previewLive(processId, x.id) }));
}

const leaked = new Set<string>();
let sweeper: NodeJS.Timeout | null = null;
/**
 * Revisión periódica (sin IA): se detiene la vista previa de un candidato que cambió (se integró o vuelve a trabajar: su
 * código ya no es el que se ve) y se retiran contenedores de esta instancia que no corresponden a ninguna vista previa en
 * marcha (un arranque interrumpido, un `timeout` anulado por el candidato…).
 */
export async function sweepPreviews(): Promise<void> {
  for (const l of [...live.values()]) {
    const p = processesRepo(l.slug).get(l.processId);
    if (!p || p.result?.merged) await stopPreview(l.slug, l.processId, l.id, p?.result?.merged ? 'la historia se integró' : 'el proceso ya no existe');
    else if (p.status === 'running') await stopPreview(l.slug, l.processId, l.id, 'el candidato vuelve a cambiar (la historia está trabajando)');
    else if (p.supersededBy || (p.backlogItemId && processesRepo(l.slug).listByBacklogItem(p.backlogItemId).filter(x => x.kind === 'story_execution').at(-1)?.id !== p.id)) await stopPreview(l.slug, l.processId, l.id, 'hay una iteración más reciente de la historia');
  }
  const out = await docker(['ps', '-a', '--filter', `label=portal-ia.preview.owner=${OWNER}`, '--format', '{{.Label "portal-ia.preview"}}']).catch(() => '');
  for (const id of new Set(out.split(/\s+/).filter(Boolean))) if (!live.has(id)) { if (await removeResources(id)) leaked.delete(id); }
  const names = [(await docker(['volume', 'ls', '-q', '--filter', `label=portal-ia.preview.owner=${OWNER}`]).catch(() => '')), (await docker(['network', 'ls', '--format', '{{.Name}}', '--filter', `label=portal-ia.preview.owner=${OWNER}`]).catch(() => ''))].join(' ');
  for (const id of new Set([...names.matchAll(/portal-ia-pv-([0-9a-f]+)-(?:sock|net)/g)].map(m => m[1]))) if (!live.has(id) && ![...reserving].length) await removeResources(id);
}
function ensureSweeper() { if (sweeper) return; sweeper = setInterval(() => { void sweepPreviews().catch(e => logger({ err: e?.message }, 'vistas previas: revisión fallida')); }, 30_000); sweeper.unref?.(); }

/** Al arrancar: retira las vistas previas que dejó ESTA instancia (contenedores, volúmenes de socket y copias). */
export async function cleanupPreviews(log: (o: any, m: string) => void = logger): Promise<number> {
  logger = log;
  const ids = (await docker(['ps', '-aq', '--filter', `label=portal-ia.preview.owner=${OWNER}`]).catch(() => '')).split(/\s+/).filter(Boolean);
  if (ids.length) await docker(['rm', '-f', ...ids]).catch(() => '');
  const vols = (await docker(['volume', 'ls', '-q', '--filter', `label=portal-ia.preview.owner=${OWNER}`]).catch(() => '')).split(/\s+/).filter(Boolean);
  for (const v of vols) await docker(['volume', 'rm', v]).catch(() => '');
  for (const n of (await docker(['network', 'ls', '-q', '--filter', `label=portal-ia.preview.owner=${OWNER}`]).catch(() => '')).split(/\s+/).filter(Boolean)) await docker(['network', 'rm', n]).catch(() => '');
  try { if (fs.existsSync(ROOT)) for (const d of fs.readdirSync(ROOT)) removeDir(path.join(ROOT, d)); } catch { /* sin acceso */ }
  if (ids.length || vols.length) log({ containers: ids.length, volumes: vols.length }, 'vistas previas anteriores retiradas al arrancar');
  return ids.length;
}

// Al salir el proceso (apagado o reinicio): no quedan contenedores sirviendo código sin aceptar.
process.once('exit', () => {
  const names = [...live.values()].flatMap(l => [l.app, l.proxy]);
  if (names.length) { try { execFileSync('docker', ['rm', '-f', ...names], { env: dockerCliEnv(), stdio: 'ignore', timeout: 10_000, windowsHide: true }); } catch { /* motor parado */ } }
});
