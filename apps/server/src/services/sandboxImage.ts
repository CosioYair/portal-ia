import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SandboxCheckReport, SandboxEnvSnapshot, SandboxImageInfo } from '@portal-ia/domain';
import { clipSandboxOutput, DEFAULT_SANDBOX_IMAGE, dockerCliEnv, runProcess, SANDBOX_IMAGE } from './sandbox.ts';

/**
 * EN-024 · Imagen del sandbox por rama. Cada proceso se verifica con una imagen construida desde el
 * docker/sandbox.Dockerfile de SU worktree y etiquetada por hash (portal-ia-sandbox:df-<hash12>). La imagen por defecto
 * (portal-ia-sandbox:1 o PORTAL_SANDBOX_IMAGE), que usan main y los demás procesos, nunca se reetiqueta ni se sobrescribe.
 * La construcción usa red solo durante el build y exige la autorización del propietario (fail-closed).
 */
const execFileP = promisify(execFile);
export const DOCKERFILE_REL = path.join('docker', 'sandbox.Dockerfile');
export const DOCKERFILE_LABEL = 'portal-ia.dockerfile-sha';
const BRANCH_TAG_PREFIX = 'portal-ia-sandbox:df-';
const BUILD_TIMEOUT_MS = 20 * 60_000;

/** sha256 del Dockerfile de la rama con CRLF normalizado a LF; null si el worktree no lo tiene. */
export function dockerfileHash(worktree: string): string | null {
  const f = path.join(worktree, DOCKERFILE_REL);
  try { return createHash('sha256').update(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')).digest('hex'); } catch { return null; }
}

/** Etiqueta de la imagen de rama: portal-ia-sandbox:df-<hash12>. Nunca es «:1». */
export function branchImageTag(hash: string): string {
  if (!/^[0-9a-f]{12,}$/.test(hash)) throw Object.assign(new Error('Hash de Dockerfile no válido.'), { statusCode: 400 });
  return `${BRANCH_TAG_PREFIX}${hash.slice(0, 12)}`;
}

/** La etiqueta es de rama y no es ninguna de las imágenes compartidas (main y otros procesos). */
export function isBranchTag(tag: string): boolean {
  return tag.startsWith(BRANCH_TAG_PREFIX) && tag !== DEFAULT_SANDBOX_IMAGE && tag !== SANDBOX_IMAGE;
}

/** Argumentos de `docker build`: red solo durante la construcción, etiqueta por hash y la etiqueta con el sha del Dockerfile. */
export function buildImageArgs(spec: { worktree: string; tag: string; hash: string }): string[] {
  if (!isBranchTag(spec.tag)) throw Object.assign(new Error(`No se construye sobre la imagen compartida ${spec.tag}: solo etiquetas ${BRANCH_TAG_PREFIX}<hash>.`), { statusCode: 400 });
  const dir = path.resolve(spec.worktree);
  return ['build', '--pull', '--network', 'default', '--label', `${DOCKERFILE_LABEL}=${spec.hash}`, '-t', spec.tag,
    '-f', path.join(dir, DOCKERFILE_REL), path.join(dir, 'docker')];
}

/** Hash estable de la lectura del entorno (engine|available|image|stale). */
export function envFingerprint(s: Omit<SandboxEnvSnapshot, 'fingerprint' | 'at'>): string {
  return createHash('sha256').update(`${s.engine}|${s.available ? 1 : 0}|${s.image ?? ''}|${s.stale ? 1 : 0}`).digest('hex').slice(0, 16);
}

export function makeEnvSnapshot(s: Omit<SandboxEnvSnapshot, 'fingerprint' | 'at'>): SandboxEnvSnapshot {
  return { ...s, fingerprint: envFingerprint(s), at: new Date().toISOString() };
}

/**
 * Informe de «Comprobar el sandbox de nuevo» (función pura). `previous` es la lectura anterior del cliente (solo su
 * fingerprint) o la instantánea guardada al pausar. No escribe nada.
 */
export function buildSandboxCheckReport(input: {
  current: SandboxEnvSnapshot;
  previous: SandboxEnvSnapshot | { fingerprint: string } | null;
  comparedWith: SandboxCheckReport['comparedWith'];
  pauseActive: boolean;
  pauseImageRelated: boolean;
  detail?: string;
}): SandboxCheckReport {
  const { current: c, previous: p } = input;
  const changes: string[] = [];
  let changed: boolean;
  if (!p) changed = true;
  else {
    changed = p.fingerprint !== c.fingerprint;
    if (changed && 'engine' in p) {
      if (p.engine !== c.engine || p.available !== c.available) changes.push(`motor: ${p.engine}${p.available ? '' : ' (no disponible)'} → ${c.engine}${c.available ? '' : ' (no disponible)'}`);
      if (p.image !== c.image) changes.push(`imagen: ${p.image ?? 'ninguna'} → ${c.image ?? 'ninguna'}`);
      if (p.stale !== c.stale) changes.push(c.stale ? 'la imagen pasó a estar desactualizada' : 'la imagen ya corresponde al Dockerfile de la rama');
    } else if (changed) changes.push('el entorno cambió desde la lectura anterior');
  }
  const resolvingAction = c.stale || (input.pauseActive && input.pauseImageRelated) ? 'rebuild_sandbox_image'
    : !c.available ? 'sandbox_help' : input.pauseActive ? 'pipeline_resume' : null;
  const hint = resolvingAction === 'rebuild_sandbox_image' ? ' Lo resuelve «Reconstruir la imagen del sandbox desde la rama».'
    : resolvingAction === 'sandbox_help' ? ' Lo resuelve preparar el sandbox (ver la ayuda del sandbox).'
    : resolvingAction === 'pipeline_resume' ? ' Pulsa «Continuar» para repetir la verificación.' : '';
  const message = !p ? `Primera comprobación.${hint}`
    : changed ? `Cambió: ${changes.join('; ')}.${hint}`
    : `Nada cambió desde la última comprobación.${hint}`;
  return {
    engine: c.engine, available: c.available, image: c.image, stale: c.stale, pauseStillActive: input.pauseActive,
    changed, fingerprint: c.fingerprint, comparedWith: input.comparedWith, changes, message, resolvingAction,
    detail: input.detail ?? '', checkedAt: new Date().toISOString()
  };
}

/** Consulta al motor (inyectable en las pruebas): devuelve la salida de `docker image inspect --format` o null. */
export type ImageInspector = (ref: string, format: string) => Promise<string | null>;
const dockerInspect: ImageInspector = async (ref, format) => {
  try { const { stdout } = await execFileP('docker', ['image', 'inspect', '--format', format, ref], { timeout: 6000, windowsHide: true, env: dockerCliEnv() }); return stdout.toString().trim(); } catch { return null; }
};

/**
 * Imagen del proceso según su Dockerfile: la de rama si existe; si no, la por defecto si su etiqueta coincide con el hash
 * (o el Dockerfile de la rama es igual al de main); en otro caso, desactualizada.
 */
export async function resolveProcessImage(worktree: string, opts: { repoRoot?: string; inspect?: ImageInspector } = {}): Promise<SandboxImageInfo> {
  const inspect = opts.inspect ?? (process.env.PORTAL_SANDBOX === 'none' ? (async () => null) : dockerInspect);
  const hash = dockerfileHash(worktree);
  const defaultId = await inspect(SANDBOX_IMAGE, '{{.Id}}');
  if (!hash) return { image: SANDBOX_IMAGE, dockerfileHash: null, expectedTag: null, ready: defaultId !== null, stale: false, reason: 'El worktree no tiene docker/sandbox.Dockerfile: se usa la imagen por defecto.' };
  const tag = branchImageTag(hash);
  if ((await inspect(tag, '{{.Id}}')) !== null) return { image: tag, dockerfileHash: hash, expectedTag: tag, ready: true, stale: false, reason: `Imagen de la rama ${tag} construida desde su Dockerfile.` };
  const label = defaultId !== null ? await inspect(SANDBOX_IMAGE, `{{index .Config.Labels "${DOCKERFILE_LABEL}"}}`) : null;
  if (defaultId !== null && label === hash) return { image: SANDBOX_IMAGE, dockerfileHash: hash, expectedTag: tag, ready: true, stale: false, reason: `${SANDBOX_IMAGE} se construyó con este mismo Dockerfile.` };
  const mainHash = opts.repoRoot ? dockerfileHash(opts.repoRoot) : null;
  if (defaultId !== null && mainHash === hash && (!label || label === '<no value>')) return { image: SANDBOX_IMAGE, dockerfileHash: hash, expectedTag: tag, ready: true, stale: false, reason: `El Dockerfile de la rama es igual al de main: se usa ${SANDBOX_IMAGE}.` };
  return {
    image: SANDBOX_IMAGE, dockerfileHash: hash, expectedTag: tag, ready: defaultId !== null, stale: true,
    reason: defaultId === null
      ? `Imagen desactualizada: falta ${SANDBOX_IMAGE} y no existe ${tag}. Reconstruye la imagen desde el Dockerfile de la rama.`
      : `Imagen desactualizada: ${SANDBOX_IMAGE} no corresponde al docker/sandbox.Dockerfile de esta rama (falta ${tag}).`
  };
}

export interface SandboxImageBuild { ok: boolean; tag: string | null; hash: string | null; output: string; at: string }

/** Ejecutor de `docker build` (sustituible en las pruebas para contar llamadas sin lanzar docker). */
export const sandboxImageDeps: { run: typeof runProcess } = { run: runProcess };

/**
 * Construye la imagen de la rama. Solo con `authorized: true` (si no, error 403 sin lanzar docker). Red solo durante el
 * build; etiqueta por hash; nunca escribe la imagen por defecto. Si falla, devuelve la salida recortada.
 */
export async function buildSandboxImage(worktree: string, opts: { authorized: boolean; timeoutMs?: number; run?: typeof runProcess }): Promise<SandboxImageBuild> {
  if (opts.authorized !== true) throw Object.assign(new Error('Reconstruir la imagen del sandbox requiere tu autorización explícita.'), { statusCode: 403 });
  const at = new Date().toISOString();
  const hash = dockerfileHash(worktree);
  if (!hash) return { ok: false, tag: null, hash: null, output: 'El worktree no tiene docker/sandbox.Dockerfile: no hay nada que construir.', at };
  const runner = opts.run ?? sandboxImageDeps.run;
  if (process.env.PORTAL_SANDBOX === 'none' && runner === runProcess) return { ok: false, tag: null, hash, output: 'Sandbox desactivado por PORTAL_SANDBOX=none: no se construye ninguna imagen.', at };
  const tag = branchImageTag(hash);
  const args = buildImageArgs({ worktree, tag, hash });
  const r = await runner('docker', args, { env: dockerCliEnv(), timeoutMs: opts.timeoutMs ?? BUILD_TIMEOUT_MS });
  const ok = r.code === 0;
  const header = `[docker build ${tag} · red solo durante la construcción · ${SANDBOX_IMAGE} no se modifica]\n`;
  return { ok, tag: ok ? tag : null, hash, output: clipSandboxOutput(header + r.output), at };
}
