import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.ts';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import type { Isolation, VerificationRun } from '@portal-ia/domain';
import { scanSecrets } from './repoWrite.ts';

const execFileP = promisify(execFile);
const IS_WIN = process.platform === 'win32';

/**
 * Sandbox de ejecución (M1). El código generado y los scripts de npm NUNCA se ejecutan en el equipo del propietario:
 *  - `docker`: contenedor efímero de la imagen `portal-ia-sandbox:1` (docker/sandbox.Dockerfile), sin red (salvo `install`,
 *    con autorización aparte), raíz de solo lectura, solo el worktree escribible, sin variables del Portal, límites de
 *    CPU/memoria/procesos/tiempo, usuario sin privilegios. Las dependencias son Linux y viven en un volumen por
 *    package-lock (`portal-ia-nm-<hash>`): `install` lo llena; el resto de comandos lo montan en solo lectura.
 *  - `wsl`: distribución dedicada «PortalIA-sandbox» (usuario sin privilegios), misma lista de comandos.
 *  - `linux-ns` (Linux sin Docker): espacios de nombres de usuario, red y montaje (`unshare -rn -m`): sin red, el
 *    HOME, la carpeta del Portal y los datos montados en solo lectura, /tmp privado, solo el worktree escribible.
 *  - `host-min`: única excepción, solo `typecheck`: ejecuta el compilador TypeScript instalado (no código del repositorio),
 *    con entorno mínimo. Se marca como verificación mínima, no como sandbox.
 *  - Sin sandbox → fail-closed: `install`, `test` y `build` no se ejecutan.
 */
export const DEFAULT_SANDBOX_IMAGE = 'portal-ia-sandbox:1';
export const SANDBOX_IMAGE = process.env.PORTAL_SANDBOX_IMAGE || DEFAULT_SANDBOX_IMAGE;
const IMAGE_BUILD_HINT = `docker build -t ${DEFAULT_SANDBOX_IMAGE} -f docker/sandbox.Dockerfile docker`;
export const WSL_DISTRO = process.env.PORTAL_WSL_DISTRO ?? 'PortalIA-sandbox';
/** Levanta `lo` dentro del nuevo espacio de red: con iproute2 si existe, si no con un ioctl desde python3; si nada existe, sigue (solo falla lo que necesite loopback). */
const LO_UP = `{ if command -v ip >/dev/null 2>&1; then ip link set lo up; elif command -v python3 >/dev/null 2>&1; then python3 -c 'import socket,fcntl,struct;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);f=struct.unpack("16sH14s",fcntl.ioctl(s,0x8913,struct.pack("16sH14s",b"lo",0,b"")))[1];fcntl.ioctl(s,0x8914,struct.pack("16sH14s",b"lo",f|0x41,b""))' ; fi; true; }`;
const COMMANDS: Record<string, string> = { install: 'npm ci --ignore-scripts --no-audit --no-fund', typecheck: 'npm run typecheck', test: 'npm test', build: 'npm run build' };

export interface SandboxStatus { available: Isolation; docker: boolean; dockerImage?: string; dockerImageReady?: boolean; wsl: boolean; linuxNs?: boolean; detail: string; checkedAt: string }
let cached: SandboxStatus | null = null; let cachedAt = 0;

async function has(cmd: string, args: string[], timeout = 6000, env?: NodeJS.ProcessEnv): Promise<string | null> {
  try { const { stdout } = await execFileP(cmd, args, { timeout, windowsHide: true, env }); return stdout.toString().trim(); } catch { return null; }
}

// ---- Docker: construcción de la orden (funciones puras; probadas sin Docker en sandbox-docker.test.ts) ----

/**
 * Variables del equipo que necesita el CLI de Docker para encontrar su configuración y su contexto (en Windows, Docker
 * Desktop las lee de USERPROFILE, APPDATA…). Solo llegan al proceso `docker`, nunca al contenedor: dentro solo entra lo
 * que buildDockerRunArgs pasa explícitamente con `-e CLAVE=valor`.
 */
const DOCKER_CLI_VARS = ['PATH', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'HOME', 'XDG_RUNTIME_DIR'];
const DOCKER_CLI_VARS_WIN = ['SYSTEMROOT', 'SystemDrive', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'TEMP', 'TMP'];

/** Entorno mínimo del proceso `docker` (no del contenedor). En Windows las claves se buscan sin distinguir mayúsculas. */
export function dockerCliEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const byLower = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  const out: NodeJS.ProcessEnv = {};
  for (const key of platform === 'win32' ? [...DOCKER_CLI_VARS, ...DOCKER_CLI_VARS_WIN] : DOCKER_CLI_VARS) {
    const v = platform === 'win32' ? byLower.get(key.toLowerCase()) : env[key];
    if (v) out[key] = v;
  }
  return out;
}

/** Valor de `--mount` (formato CSV de Docker): un campo con coma o comillas va entre comillas dobles. Admite rutas `C:\Mis Proyectos\…`. */
export function dockerMountArg(fields: Record<string, string | true>): string {
  const csv = (f: string) => /[",]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f;
  return Object.entries(fields).map(([k, v]) => csv(v === true ? k : `${k}=${v}`)).join(',');
}

/** Volumen de dependencias Linux: uno por imagen + package-lock (finales de línea normalizados: CRLF y LF comparten volumen). */
export function depsVolumeName(worktree: string, image: string = SANDBOX_IMAGE): string {
  const lock = ['package-lock.json', 'package.json'].map(f => path.join(worktree, f)).find(f => fs.existsSync(f));
  const content = lock ? fs.readFileSync(lock, 'utf8').replace(/\r\n/g, '\n') : '';
  return `portal-ia-nm-${createHash('sha256').update(`${image}\n${content}`).digest('hex').slice(0, 16)}`;
}

/**
 * Contenedores en marcha lanzados por este servidor. Matar el CLI de docker no detiene su contenedor: al salir el proceso
 * (apagado normal, reinicio por el supervisor) se eliminan, para que no queden huérfanos ocupando el motor.
 */
const activeContainers = new Set<string>();
process.once('exit', () => {
  if (!activeContainers.size) return;
  try { execFileSync('docker', ['rm', '-f', ...activeContainers], { env: dockerCliEnv(), stdio: 'ignore', timeout: 10_000, windowsHide: true }); } catch { /* motor parado */ }
});

/** Marca que deja `install` en el volumen al terminar bien; sin ella, el resto de comandos no se ejecutan. */
const DEPS_READY = 'node_modules/.portal-ia-ready';
/** Cachés que las herramientas escriben dentro de node_modules (vite, babel…): tmpfs privados sobre el volumen de solo lectura. */
const NM_CACHES = ['.vite-temp', '.vite', '.cache'];
export const DEPS_MISSING_EXIT = 86;
/**
 * Marca de salida que imprime el propio contenedor al terminar. Docker Desktop (Windows) a veces no registra el final
 * de un contenedor con mucha actividad en paralelo: el proceso terminó, el contenedor sigue «Up» sin procesos y
 * `docker run` no vuelve hasta el tiempo máximo. Con la marca, el Portal sabe que terminó y con qué código.
 */
export const EXIT_MARK = '__PORTAL_IA_EXIT__=';
/** Espera tras la marca antes de dar el contenedor por colgado y retirarlo. */
const STUCK_GRACE_MS = 15_000;

export interface DockerRunSpec { worktree: string; command: string; script: string; image: string; volume: string; allowNetwork: boolean; name: string }

/** Argumentos de `docker run` para un comando permitido. Red solo en `install` con la red confirmada. */
export function buildDockerRunArgs(spec: DockerRunSpec): string[] {
  const install = spec.command === 'install';
  const network = install && spec.allowNetwork ? 'bridge' : 'none';
  const env = { CI: '1', PORTAL_INSIDE_SANDBOX: '1', HOME: '/tmp', TMPDIR: '/tmp', npm_config_cache: '/tmp/npm-cache', npm_config_update_notifier: 'false', FORCE_COLOR: '0' };
  const deps = { type: 'volume', source: spec.volume, target: '/work/node_modules' };
  const args = ['run', '--rm', '--init', '--pull', 'never', '--name', spec.name, '--label', 'portal-ia.sandbox=1',
    '--network', network, '--memory', '2g', '--cpus', '2', '--pids-limit', '512',
    '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--user', '1000:1000',
    '--read-only', '--mount', dockerMountArg({ type: 'tmpfs', target: '/tmp', 'tmpfs-mode': '1777' }),
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    '--mount', dockerMountArg({ type: 'bind', source: path.resolve(spec.worktree), target: '/work' }),
    '--mount', dockerMountArg(install ? deps : { ...deps, readonly: true })];
  if (!install) for (const c of NM_CACHES) args.push('--mount', dockerMountArg({ type: 'tmpfs', target: `/work/node_modules/${c}`, 'tmpfs-mode': '1777' }));
  const script = install
    ? `${spec.script} && mkdir -p ${NM_CACHES.map(c => `node_modules/${c}`).join(' ')} && touch ${DEPS_READY}`
    : `if [ ! -f ${DEPS_READY} ]; then echo "Faltan las dependencias Linux de este package-lock (volumen ${spec.volume}). Ejecuta una vez «npm ci (install)» con «Permitir red solo para install»; después typecheck, test y build corren sin red."; exit ${DEPS_MISSING_EXIT}; fi; ${spec.script}`;
  // En un subshell (también un `exit` temprano) y con la marca de salida al final, siempre.
  args.push('-w', '/work', spec.image, 'sh', '-c', wrapWithExitMark(script));
  return args;
}

/** Envuelve el script para que imprima su código de salida como última línea (ver EXIT_MARK). */
export const wrapWithExitMark = (script: string) => `( ${script} ); __rc=$?; printf '\\n${EXIT_MARK}%s\\n' "$__rc"; exit $__rc`;
/** Separa la marca de salida de la salida del comando. */
export function splitExitMark(output: string): { output: string; code: number | null } {
  const m = output.match(new RegExp(`\\r?\\n?${EXIT_MARK}(\\d+)\\r?\\n?`));
  return m ? { output: output.replace(m[0], '\n').replace(/\n+$/, '\n'), code: Number(m[1]) } : { output, code: null };
}

/** Detecta el sandbox disponible (caché de 60 s). */
export async function detectSandbox(force = false): Promise<SandboxStatus> {
  if (cached && !force && Date.now() - cachedAt < 60_000) return cached;
  if (process.env.PORTAL_SANDBOX === 'none') { cached = { available: 'unavailable', docker: false, wsl: false, detail: 'Sandbox desactivado por PORTAL_SANDBOX=none (solo para pruebas).', checkedAt: new Date().toISOString() }; cachedAt = Date.now(); return cached; }
  const dockerOs = await has('docker', ['version', '--format', '{{.Server.Os}}'], 6000, dockerCliEnv());
  const dockerEngine = dockerOs === 'linux';
  // Sin la imagen no hay sandbox Docker (fail-closed): `--pull never` impide descargarla en silencio.
  const dockerImageReady = dockerEngine && (await has('docker', ['image', 'inspect', '--format', '{{.Id}}', SANDBOX_IMAGE], 6000, dockerCliEnv())) !== null;
  const docker = dockerEngine && dockerImageReady;
  let wsl = false; let linuxNs = false;
  if (IS_WIN) { const list = await has('wsl.exe', ['-l', '-q']); wsl = !!list && list.replace(/\0/g, '').split(/\r?\n/).map(s => s.trim()).includes(WSL_DISTRO); }
  else if (!docker && process.platform === 'linux') linuxNs = (await has('unshare', ['-rn', '-m', '--', 'sh', '-c', 'mount -t tmpfs tmpfs /tmp && echo ok'])) === 'ok';
  const available: Isolation = docker ? 'docker' : wsl ? 'wsl' : linuxNs ? 'linux-ns' : 'unavailable';
  const imageMissing = dockerEngine && !dockerImageReady ? `Docker responde, pero falta la imagen ${SANDBOX_IMAGE}: constrúyela una vez con «${IMAGE_BUILD_HINT}» (ver docs/sandbox.md).` : '';
  const detail = docker ? `Docker disponible (${SANDBOX_IMAGE}).` : imageMissing && !wsl && !linuxNs ? `No hay sandbox. ${imageMissing} Hasta entonces, install/test/build quedan bloqueados; solo se permite la verificación mínima (tsc).` : wsl ? `WSL2: distribución «${WSL_DISTRO}».` : linuxNs ? 'Espacios de nombres de Linux (unshare): sin red, HOME/Portal/datos en solo lectura, /tmp privado; solo el worktree es escribible.' : IS_WIN
    ? `No hay sandbox: instala Docker Desktop (motor WSL2) o crea la distribución WSL2 «${WSL_DISTRO}» (ver docs/sandbox.md). Hasta entonces, install/test/build quedan bloqueados; solo se permite la verificación mínima (tsc).`
    : 'No hay sandbox (docker no responde). install/test/build quedan bloqueados; solo se permite la verificación mínima (tsc).';
  cached = { available, docker, dockerImage: SANDBOX_IMAGE, dockerImageReady, wsl, linuxNs, detail, checkedAt: new Date().toISOString() }; cachedAt = Date.now();
  return cached;
}

/** Ejecuta un proceso con tiempo máximo; con `onStuck`, vigila la marca de salida (exportado para las pruebas). */
export function runProcess(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; shell?: boolean; onTimeout?: () => void; onStuck?: () => void; stuckGraceMs?: number }): Promise<{ code: number | null; output: string; stuck?: boolean }> {
  return new Promise(resolve => {
    let out = ''; let done = false; let grace: NodeJS.Timeout | null = null;
    const end = (r: { code: number | null; output: string; stuck?: boolean }) => { if (done) return; done = true; clearTimeout(t); if (grace) clearTimeout(grace); resolve(r); };
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? {}, shell: !!opts.shell, windowsHide: true });
    const t = setTimeout(() => { try { opts.onTimeout?.(); } catch { /* sin limpieza */ } try { child.kill('SIGKILL'); } catch { /* ya terminó */ } out += '\n[tiempo máximo agotado]'; }, opts.timeoutMs);
    const onData = (d: Buffer) => {
      out += d;
      // El comando ya terminó (marca impresa): si el CLI no vuelve en el margen, el motor se colgó con el contenedor.
      if (opts.onStuck && !grace && out.includes(EXIT_MARK)) grace = setTimeout(() => { try { opts.onStuck!(); } catch { /* sin limpieza */ } try { child.kill('SIGKILL'); } catch { /* ya terminó */ } end({ code: null, output: out, stuck: true }); }, opts.stuckGraceMs ?? STUCK_GRACE_MS);
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => end({ code: 1, output: out + `\n${e.message}` }));
    child.on('close', code => end({ code, output: out }));
  });
}

/** Redacta posibles claves y recorta: conserva el inicio (dónde falló) y el final (resumen). */
const redact = (s: string) => { const t = s.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-…').replace(/\bsk-[A-Za-z0-9]{20,}\b/g, 'sk-…'); return t.length <= 40_000 ? t : `${t.slice(0, 15_000)}\n\n[… ${t.length - 30_000} caracteres omitidos …]\n\n${t.slice(-15_000)}`; };

/**
 * Ejecuta un comando permitido sobre el worktree del proceso en el sandbox disponible.
 * `install` necesita red; se permite solo si `allowNetwork` (autorización aparte con el diff de package.json a la vista).
 */
export async function runInSandbox(worktree: string, repoRoot: string, command: string, opts: { allowNetwork?: boolean; timeoutMs?: number } = {}): Promise<VerificationRun> {
  const script = COMMANDS[command];
  if (!script) throw Object.assign(new Error(`Comando no permitido: ${command}`), { statusCode: 400 });
  const startedAt = new Date().toISOString(); const t0 = Date.now(); const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const finish = (code: number | null, output: string, isolation: Isolation): VerificationRun => ({ command, exitCode: code, output: redact(output) + (scanSecrets(output) ? '\n[aviso: la salida contenía un posible secreto; se ha redactado]' : ''), startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0, isolation });
  const st = await detectSandbox();
  if (st.available === 'docker') {
    // Dependencias Linux en un volumen propio: los node_modules del equipo (binarios de Windows, enlaces con rutas C:\…) no sirven dentro.
    const allowNetwork = command === 'install' && !!opts.allowNetwork;
    const volume = depsVolumeName(worktree);
    const name = `portal-ia-sbx-${randomBytes(6).toString('hex')}`;
    const env = dockerCliEnv();
    const args = buildDockerRunArgs({ worktree, command, script, image: SANDBOX_IMAGE, volume, allowNetwork, name });
    // Matar el CLI no detiene el contenedor: al agotar el tiempo se elimina por nombre.
    activeContainers.add(name);
    const remove = () => { spawn('docker', ['rm', '-f', name], { env, stdio: 'ignore', windowsHide: true }).on('error', () => { /* sin docker */ }); };
    const r = await runProcess('docker', args, { timeoutMs, env, onTimeout: remove, onStuck: remove });
    activeContainers.delete(name);
    const marked = splitExitMark(r.output);
    // El código lo da el CLI; si el motor se quedó colgado tras terminar el comando, el que imprimió el propio contenedor.
    const code = r.stuck ? marked.code : r.code;
    const note = r.stuck ? `\n[el motor de Docker no informó del final del contenedor; se usó el código que imprimió el propio comando (${marked.code}) y se retiró el contenedor]` : '';
    return finish(code, `[docker ${SANDBOX_IMAGE} · red ${allowNetwork ? 'activada solo para install' : 'desactivada'} · dependencias ${volume}${command === 'install' ? '' : ' (solo lectura)'}]\n` + marked.output + note, 'docker');
  }
  if (st.available === 'wsl') {
    const wslPath = (await has('wsl.exe', ['-d', WSL_DISTRO, '--', 'wslpath', '-a', worktree])) ?? worktree;
    const inner = `cd "${wslPath}" && ${command === 'install' && opts.allowNetwork ? '' : 'unshare -rn '}env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp CI=1 PORTAL_INSIDE_SANDBOX=1 ${script}`;
    const r = await runProcess('wsl.exe', ['-d', WSL_DISTRO, '--', 'bash', '-lc', inner], { timeoutMs, env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '' } });
    return finish(r.code, `[wsl ${WSL_DISTRO}]\n` + r.output, 'wsl');
  }
  if (st.available === 'linux-ns') {
    // Montajes de solo lectura (de fuera hacia dentro) y el worktree vuelto a montar escribible encima.
    const nmLink = path.join(worktree, 'node_modules');
    if (command !== 'install' && !fs.existsSync(nmLink) && fs.existsSync(path.join(repoRoot, 'node_modules'))) { try { fs.symlinkSync(path.join(repoRoot, 'node_modules'), nmLink); } catch { /* sin enlace */ } }
    const ro = Array.from(new Set([os.homedir(), path.dirname(repoRoot), repoRoot, config.dataDir].map(p => path.resolve(p)).filter(p => fs.existsSync(p)))).sort((a, b) => a.length - b.length);
    const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
    // HOME y caché de npm dentro del worktree (único lugar escribible); /tmp privado solo si nada relevante vive bajo /tmp.
    const tmpInside = path.join(worktree, '.portal-tmp'); fs.mkdirSync(tmpInside, { recursive: true });
    const privateTmp = ![...ro, worktree].some(p => p === '/tmp' || p.startsWith('/tmp/'));
    const inner = [
      ...ro.map(p => `mount --bind ${q(p)} ${q(p)} && mount -o remount,bind,ro ${q(p)}`),
      `mount --bind ${q(worktree)} ${q(worktree)} && mount -o remount,bind,rw ${q(worktree)}`,
      ...(privateTmp ? ['mount -t tmpfs tmpfs /tmp'] : []),
      LO_UP, // loopback dentro del espacio de red (las pruebas escuchan en 127.0.0.1); nunca da acceso al exterior
      `cd ${q(worktree)}`,
      `exec env -i PATH=${q(`${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`)} HOME=${q(tmpInside)} TMPDIR=${q(tmpInside)} CI=1 PORTAL_INSIDE_SANDBOX=1 FORCE_COLOR=0 npm_config_cache=${q(path.join(tmpInside, 'npm-cache'))} npm_config_update_notifier=false sh -c ${q(script)}`
    ].join(' && ');
    const args = ['-r', ...(command === 'install' && opts.allowNetwork ? [] : ['-n']), '-m', '--', 'sh', '-c', inner];
    const r = await runProcess('unshare', args, { timeoutMs, env: { PATH: process.env.PATH ?? '' } });
    return finish(r.code, `[linux-ns · red ${command === 'install' && opts.allowNetwork ? 'activada solo para install' : 'desactivada'} · solo lectura: ${ro.join(', ')}]\n` + r.output, 'linux-ns');
  }
  if (command === 'typecheck') return runHostTypecheckMin(worktree, repoRoot, timeoutMs, startedAt, t0);
  return finish(1, `Sandbox no disponible: «${command}» no se ejecuta en el equipo del propietario (fail-closed). ${st.detail}`, 'unavailable');
}

/** Verificación mínima: solo el compilador TypeScript ya instalado, con entorno vacío. No ejecuta scripts ni código del repositorio. */
export async function runHostTypecheckMin(worktree: string, repoRoot: string, timeoutMs: number, startedAt = new Date().toISOString(), t0 = Date.now()): Promise<VerificationRun> {
  const tsc = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) return { command: 'typecheck', exitCode: 1, output: 'No se encontró el compilador TypeScript en node_modules del Portal.', startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0, isolation: 'host-min' };
  let output = '[verificación mínima en el equipo: tsc --noEmit; no se ejecutan scripts del repositorio]\n'; let code = 0;
  for (const proj of ['packages/domain/tsconfig.json', 'packages/ai-adapters/tsconfig.json', 'apps/server/tsconfig.json', 'apps/web/tsconfig.json']) {
    if (!fs.existsSync(path.join(worktree, proj))) continue;
    const nmLink = path.join(worktree, 'node_modules');
    if (!fs.existsSync(nmLink)) { try { fs.symlinkSync(path.join(repoRoot, 'node_modules'), nmLink, 'junction'); } catch { /* sin enlace: tsc buscará hacia arriba */ } }
    const r = await runProcess(process.execPath, [tsc, '-p', proj, '--noEmit'], { cwd: worktree, timeoutMs, env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '' } });
    output += `\n> tsc -p ${proj}\n${r.output}`; if (r.code !== 0) code = r.code ?? 1;
  }
  return { command: 'typecheck', exitCode: code, output: redact(output), startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0, isolation: 'host-min' };
}
