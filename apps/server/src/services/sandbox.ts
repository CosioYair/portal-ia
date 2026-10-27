import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.ts';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { Isolation, VerificationRun } from '@portal-ia/domain';
import { scanSecrets } from './repoWrite.ts';

const execFileP = promisify(execFile);
const IS_WIN = process.platform === 'win32';

/**
 * Sandbox de ejecución (M1). El código generado y los scripts de npm NUNCA se ejecutan en el equipo del propietario:
 *  - `docker`: contenedor efímero node:22-alpine, sin red (salvo `install`, con autorización aparte), solo lectura
 *    salvo el worktree, sin variables del Portal, límites de CPU/memoria/procesos/tiempo, usuario sin privilegios.
 *  - `wsl`: distribución dedicada «PortalIA-sandbox» (usuario sin privilegios), misma lista de comandos.
 *  - `linux-ns` (Linux sin Docker): espacios de nombres de usuario, red y montaje (`unshare -rn -m`): sin red, el
 *    HOME, la carpeta del Portal y los datos montados en solo lectura, /tmp privado, solo el worktree escribible.
 *  - `host-min`: única excepción, solo `typecheck`: ejecuta el compilador TypeScript instalado (no código del repositorio),
 *    con entorno mínimo. Se marca como verificación mínima, no como sandbox.
 *  - Sin sandbox → fail-closed: `install`, `test` y `build` no se ejecutan.
 */
export const SANDBOX_IMAGE = process.env.PORTAL_SANDBOX_IMAGE ?? 'node:22-alpine';
export const WSL_DISTRO = process.env.PORTAL_WSL_DISTRO ?? 'PortalIA-sandbox';
/** Levanta `lo` dentro del nuevo espacio de red: con iproute2 si existe, si no con un ioctl desde python3; si nada existe, sigue (solo falla lo que necesite loopback). */
const LO_UP = `{ if command -v ip >/dev/null 2>&1; then ip link set lo up; elif command -v python3 >/dev/null 2>&1; then python3 -c 'import socket,fcntl,struct;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);f=struct.unpack("16sH14s",fcntl.ioctl(s,0x8913,struct.pack("16sH14s",b"lo",0,b"")))[1];fcntl.ioctl(s,0x8914,struct.pack("16sH14s",b"lo",f|0x41,b""))' ; fi; true; }`;
const COMMANDS: Record<string, string> = { install: 'npm ci --ignore-scripts --no-audit --no-fund', typecheck: 'npm run typecheck', test: 'npm test', build: 'npm run build' };

export interface SandboxStatus { available: Isolation; docker: boolean; wsl: boolean; linuxNs?: boolean; detail: string; checkedAt: string }
let cached: SandboxStatus | null = null; let cachedAt = 0;

async function has(cmd: string, args: string[], timeout = 6000): Promise<string | null> {
  try { const { stdout } = await execFileP(cmd, args, { timeout, windowsHide: true }); return stdout.toString().trim(); } catch { return null; }
}

/** Detecta el sandbox disponible (caché de 60 s). */
export async function detectSandbox(force = false): Promise<SandboxStatus> {
  if (cached && !force && Date.now() - cachedAt < 60_000) return cached;
  if (process.env.PORTAL_SANDBOX === 'none') { cached = { available: 'unavailable', docker: false, wsl: false, detail: 'Sandbox desactivado por PORTAL_SANDBOX=none (solo para pruebas).', checkedAt: new Date().toISOString() }; cachedAt = Date.now(); return cached; }
  const dockerOs = await has('docker', ['version', '--format', '{{.Server.Os}}']);
  const docker = dockerOs === 'linux';
  let wsl = false; let linuxNs = false;
  if (IS_WIN) { const list = await has('wsl.exe', ['-l', '-q']); wsl = !!list && list.replace(/\0/g, '').split(/\r?\n/).map(s => s.trim()).includes(WSL_DISTRO); }
  else if (!docker && process.platform === 'linux') linuxNs = (await has('unshare', ['-rn', '-m', '--', 'sh', '-c', 'mount -t tmpfs tmpfs /tmp && echo ok'])) === 'ok';
  const available: Isolation = docker ? 'docker' : wsl ? 'wsl' : linuxNs ? 'linux-ns' : 'unavailable';
  const detail = docker ? `Docker disponible (${SANDBOX_IMAGE}).` : wsl ? `WSL2: distribución «${WSL_DISTRO}».` : linuxNs ? 'Espacios de nombres de Linux (unshare): sin red, HOME/Portal/datos en solo lectura, /tmp privado; solo el worktree es escribible.' : IS_WIN
    ? `No hay sandbox: instala Docker Desktop (motor WSL2) o crea la distribución WSL2 «${WSL_DISTRO}» (ver docs/sandbox.md). Hasta entonces, install/test/build quedan bloqueados; solo se permite la verificación mínima (tsc).`
    : 'No hay sandbox (docker no responde). install/test/build quedan bloqueados; solo se permite la verificación mínima (tsc).';
  cached = { available, docker, wsl, linuxNs, detail, checkedAt: new Date().toISOString() }; cachedAt = Date.now();
  return cached;
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; shell?: boolean }): Promise<{ code: number | null; output: string }> {
  return new Promise(resolve => {
    let out = ''; const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? {}, shell: !!opts.shell, windowsHide: true });
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ya terminó */ } out += '\n[tiempo máximo agotado]'; }, opts.timeoutMs);
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    child.on('error', e => { clearTimeout(t); resolve({ code: 1, output: out + `\n${e.message}` }); });
    child.on('close', code => { clearTimeout(t); resolve({ code, output: out }); });
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
    const nm = path.join(repoRoot, 'node_modules');
    const args = ['run', '--rm', '--network', command === 'install' && opts.allowNetwork ? 'bridge' : 'none', '--memory', '2g', '--cpus', '2', '--pids-limit', '512',
      '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--user', '1000:1000', '-e', 'CI=1', '-e', 'PORTAL_INSIDE_SANDBOX=1', '-e', 'HOME=/tmp', '-e', 'npm_config_cache=/tmp/npm-cache', '-e', 'FORCE_COLOR=0',
      '-v', `${worktree}:/work`, '-w', '/work'];
    // Dependencias: se montan las del checkout principal en solo lectura salvo que se esté instalando.
    if (command !== 'install' && fs.existsSync(nm)) args.push('-v', `${nm}:/work/node_modules:ro`);
    args.push(SANDBOX_IMAGE, 'sh', '-c', script);
    const r = await run('docker', args, { timeoutMs, env: { PATH: process.env.PATH ?? '', DOCKER_HOST: process.env.DOCKER_HOST ?? '' } });
    return finish(r.code, `[docker ${SANDBOX_IMAGE} · red ${command === 'install' && opts.allowNetwork ? 'activada solo para install' : 'desactivada'}]\n` + r.output, 'docker');
  }
  if (st.available === 'wsl') {
    const wslPath = (await has('wsl.exe', ['-d', WSL_DISTRO, '--', 'wslpath', '-a', worktree])) ?? worktree;
    const inner = `cd "${wslPath}" && ${command === 'install' && opts.allowNetwork ? '' : 'unshare -rn '}env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp CI=1 PORTAL_INSIDE_SANDBOX=1 ${script}`;
    const r = await run('wsl.exe', ['-d', WSL_DISTRO, '--', 'bash', '-lc', inner], { timeoutMs, env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '' } });
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
    const r = await run('unshare', args, { timeoutMs, env: { PATH: process.env.PATH ?? '' } });
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
    const r = await run(process.execPath, [tsc, '-p', proj, '--noEmit'], { cwd: worktree, timeoutMs, env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '' } });
    output += `\n> tsc -p ${proj}\n${r.output}`; if (r.code !== 0) code = r.code ?? 1;
  }
  return { command: 'typecheck', exitCode: code, output: redact(output), startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0, isolation: 'host-min' };
}
