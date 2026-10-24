import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProposedChange, VerificationRun } from '@portal-ia/domain';
import { expandHome } from '../routes/fs.ts';

const execFileP = promisify(execFile);

/**
 * Escritura en el repositorio y verificación local. SIEMPRE tras autorización explícita del usuario por uso
 * (herramientas de riesgo `auth`). Las escrituras van a una rama de trabajo propia y se confirman en git para que
 * todo cambio sea revisable y reversible. Nunca se toca `.git`, `data/`, `node_modules/`, ni archivos con secretos.
 */
const FORBIDDEN = [/^\.git(\/|$)/, /^data(\/|$)/, /^node_modules(\/|$)/, /(^|\/)\.env(\.(?!example$|sample$|template$|dist$)[^/]*)?$/i, /\.(key|pem|p12|pfx)$/i, /(^|\/)\.master\.key$/];

/** Patrones de secretos que no deben entrar en un repositorio (aviso, no bloqueo: el propietario decide). */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'clave de API de Anthropic'], [/\bsk-[A-Za-z0-9]{32,}\b/, 'clave de API (sk-…)'], [/\bAKIA[0-9A-Z]{16}\b/, 'clave de acceso AWS'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, 'token de GitHub'], [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'clave privada'], [/\b(password|passwd|contraseña|secret|api[_-]?key)\s*[:=]\s*['"][^'"\s]{8,}['"]/i, 'credencial literal']
];
export function scanSecrets(text: string): string | null {
  for (const [re, label] of SECRET_PATTERNS) if (re.test(text)) return `Posible ${label} en el contenido: revísalo antes de aplicar o publicar.`;
  return null;
}

/** Aplica bloques buscar/reemplazar a un texto. Cada búsqueda debe aparecer exactamente una vez (tolerando espacios finales). */
export function applyPatch(original: string, edits: { search: string; replace: string }[]): { text: string; error: string | null } {
  let text = original;
  const norm = (t: string) => t.replace(/\r\n/g, '\n').split('\n').map(l => l.trimEnd()).join('\n');
  for (let i = 0; i < edits.length; i++) {
    const { search, replace } = edits[i];
    if (!search.trim()) return { text: original, error: `Bloque ${i + 1}: la búsqueda está vacía.` };
    let idx = text.indexOf(search); let len = search.length;
    if (idx < 0) { // tolerancia a espacios finales / saltos de línea
      const nt = norm(text), ns = norm(search); const j = nt.indexOf(ns);
      if (j < 0) return { text: original, error: `Bloque ${i + 1}: el texto a buscar no aparece en el archivo (primera línea: «${search.split('\n')[0].slice(0, 80)}»).` };
      if (nt.indexOf(ns, j + 1) >= 0) return { text: original, error: `Bloque ${i + 1}: el texto a buscar aparece más de una vez; amplía el contexto.` };
      // mapear posiciones normalizadas → originales recorriendo líneas
      const lines = text.replace(/\r\n/g, '\n').split('\n'); const nLines = ns.split('\n').length; const startLine = nt.slice(0, j).split('\n').length - 1;
      const before = lines.slice(0, startLine).join('\n'); const target = lines.slice(startLine, startLine + nLines).join('\n');
      idx = (startLine ? before.length + 1 : 0); len = target.length; text = text.replace(/\r\n/g, '\n');
    } else if (text.indexOf(search, idx + 1) >= 0) return { text: original, error: `Bloque ${i + 1}: el texto a buscar aparece más de una vez; amplía el contexto.` };
    text = text.slice(0, idx) + replace + text.slice(idx + len);
  }
  return { text, error: null };
}

export function safeRelPath(p: string): string {
  const norm = p.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!norm || norm.startsWith('/') || /^[A-Za-z]:/.test(norm) || norm.split('/').some(seg => seg === '..' || seg === '')) throw Object.assign(new Error(`Ruta no permitida: ${p}`), { statusCode: 400 });
  if (FORBIDDEN.some(r => r.test(norm))) throw Object.assign(new Error(`Ruta protegida: ${p}`), { statusCode: 400 });
  return norm;
}

/** Diff unificado simple (LCS por líneas) para revisión humana. Archivos muy grandes se resumen. */
export function unifiedDiff(before: string, after: string, file: string, maxLines = 2500): string {
  const a = before.split('\n'), b = after.split('\n');
  if (a.length * b.length > maxLines * maxLines) return `--- a/${file}\n+++ b/${file}\n@@ archivo grande: ${a.length} → ${b.length} líneas (diff omitido) @@`;
  const n = a.length, m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [`--- a/${file}`, `+++ b/${file}`];
  let i = 0, j = 0; const body: string[] = [];
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { body.push(' ' + a[i]); i++; j++; }
    else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { body.push('+' + b[j]); j++; }
    else { body.push('-' + a[i]); i++; }
  }
  // Compactar contexto: mantener 3 líneas alrededor de cada cambio.
  const keep = new Array(body.length).fill(false);
  body.forEach((l, k) => { if (l[0] !== ' ') for (let d = -3; d <= 3; d++) if (body[k + d] !== undefined) keep[k + d] = true; });
  let gap = false;
  body.forEach((l, k) => { if (keep[k]) { if (gap) { out.push('@@ … @@'); gap = false; } out.push(l); } else gap = true; });
  return out.join('\n');
}

export function repoRoot(repoPath: string): string { return path.resolve(expandHome(repoPath)); }

export function readRepoFile(repoPath: string, rel: string, maxChars = 60_000): string | null {
  try { const c = fs.readFileSync(path.join(repoRoot(repoPath), safeRelPath(rel)), 'utf8'); return c.length > maxChars ? c.slice(0, maxChars) + '\n… (truncado)' : c; } catch { return null; }
}

export interface RawChange { path: string; action: 'create' | 'modify' | 'delete' | 'patch'; content: string | null; edits?: { search: string; replace: string }[] }

/**
 * Enriquecer cambios propuestos con diff y métricas, sin escribir nada. Un cambio inválido (ruta protegida, parche que
 * no encaja) no invalida el resto: queda marcado con `error` y se excluye al aplicar.
 */
export function annotateChanges(repoPath: string, changes: RawChange[]): ProposedChange[] {
  return changes.map(c => {
    const relDisplay = c.path.replace(/\\/g, '/');
    let rel: string;
    try { rel = safeRelPath(c.path); } catch (e: any) { return { path: relDisplay, action: c.action === 'delete' ? 'delete' : 'modify', content: null, diff: '', before: 0, after: 0, error: e.message } as ProposedChange; }
    const existing = readRepoFile(repoPath, rel, 400_000);
    const before = existing ?? '';
    let after = c.action === 'delete' ? '' : (c.content ?? '');
    let error: string | null = null;
    if (c.action === 'patch') {
      if (existing === null) error = 'El archivo a parchear no existe en el repositorio.';
      else { const r = applyPatch(existing, c.edits ?? []); after = r.text; error = r.error; }
    }
    if (c.action === 'modify' && existing === null && !c.content) error = 'El archivo no existe y no se entregó contenido.';
    const action: ProposedChange['action'] = c.action === 'delete' ? 'delete' : existing === null ? 'create' : 'modify';
    const warning = action !== 'delete' ? scanSecrets(after) : null;
    return { path: rel, action, content: action === 'delete' ? null : after, diff: error ? '' : unifiedDiff(before, after, rel), before: existing === null ? 0 : before.split('\n').length, after: action === 'delete' ? 0 : after.split('\n').length, error, warning };
  });
}

export async function git(cwd: string, args: string[]): Promise<string> {
  try { const { stdout } = await execFileP('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }); return stdout.trim(); }
  catch (e: any) { throw Object.assign(new Error(`git ${args[0]}: ${(e.stderr || e.message || '').toString().trim()}`), { statusCode: 500 }); }
}

/** Aplica los cambios en una rama de trabajo y crea un commit. Devuelve rama, commit y archivos. */
export async function applyChanges(repoPath: string, branch: string, changes: ProposedChange[], message: string): Promise<{ branch: string; commit: string; files: string[] }> {
  const cwd = repoRoot(repoPath);
  if (!fs.existsSync(path.join(cwd, '.git'))) throw Object.assign(new Error('La carpeta registrada no es un repositorio git.'), { statusCode: 400 });
  if (!/^[A-Za-z0-9._\/-]{1,80}$/.test(branch)) throw Object.assign(new Error('Nombre de rama no válido.'), { statusCode: 400 });
  const dirty = await git(cwd, ['status', '--porcelain']);
  if (dirty) throw Object.assign(new Error('El repositorio tiene cambios sin confirmar. Confírmalos o descártalos antes de aplicar cambios de los agentes.'), { statusCode: 409 });
  // `symbolic-ref` funciona también en un repositorio recién creado (sin commits), donde `rev-parse HEAD` falla.
  const current = await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '') || 'main';
  const hasCommits = await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).then(() => true).catch(() => false);
  const branches = (await git(cwd, ['branch', '--list', branch])).trim();
  if (branches) await git(cwd, ['checkout', branch]);
  else if (hasCommits) {
    // Política de ramas: cada historia parte de la rama principal actualizada (main/master), no de la rama que esté activa.
    const base = await mainBranch(cwd, branch);
    const baseExists = (await git(cwd, ['branch', '--list', base])).trim();
    if (baseExists && base !== current) await git(cwd, ['checkout', base]);
    await git(cwd, ['checkout', '-b', branch]);
  }
  else await git(cwd, ['checkout', '--orphan', branch]); // sin commits: la rama nace vacía
  const files: string[] = [];
  try {
    for (const c of changes) {
      if (c.error) continue; // cambios inválidos: se muestran en la revisión pero no se escriben
      const abs = path.join(cwd, safeRelPath(c.path));
      if (c.action === 'delete') { if (fs.existsSync(abs)) fs.rmSync(abs); }
      else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, c.content ?? '', 'utf8'); }
      files.push(c.path);
    }
    await git(cwd, ['add', '-A']);
    const staged = await git(cwd, ['diff', '--cached', '--name-only']);
    if (!staged) throw Object.assign(new Error('Los cambios propuestos no modifican nada respecto al repositorio.'), { statusCode: 409 });
    await git(cwd, ['-c', 'user.name=Portal IA', '-c', 'user.email=portal-ia@local', 'commit', '-q', '-m', message]);
    const commit = await git(cwd, ['rev-parse', '--short', 'HEAD']);
    return { branch, commit, files };
  } catch (e) {
    // Dejar el repositorio limpio y volver a la rama original si algo falla.
    try {
      if (hasCommits) { await git(cwd, ['reset', '--hard']); await git(cwd, ['checkout', current]); }
      else { // repositorio sin commits: deshacer lo escrito y volver a la rama no nacida
        await git(cwd, ['rm', '-rfq', '--cached', '.']).catch(() => '');
        for (const f of files) { try { fs.rmSync(path.join(cwd, safeRelPath(f)), { force: true }); } catch { /* ignorar */ } }
        await git(cwd, ['symbolic-ref', 'HEAD', `refs/heads/${current}`]);
      }
    } catch { /* informar el error original */ }
    throw e;
  }
}

/** Remoto configurado del repositorio (origin o el primero que exista). */
export async function remoteInfo(repoPath: string): Promise<{ remote: string | null; url: string | null }> {
  const cwd = repoRoot(repoPath);
  const names = (await git(cwd, ['remote']).catch(() => '')).split('\n').map(s => s.trim()).filter(Boolean);
  if (!names.length) return { remote: null, url: null };
  const remote = names.includes('origin') ? 'origin' : names[0];
  const url = await git(cwd, ['remote', 'get-url', remote]).catch(() => null);
  return { remote, url };
}

export async function mainBranch(cwd: string, exclude = ''): Promise<string> {
  const all = (await git(cwd, ['branch', '--format=%(refname:short)']).catch(() => '')).split('\n').map(s => s.trim()).filter(Boolean);
  if (all.includes('main')) return 'main';
  if (all.includes('master')) return 'master';
  const current = await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '');
  if (current && current !== exclude) return current;
  return all.find(b => b !== exclude) ?? 'main';
}

/** Integra la rama de trabajo en la rama principal con un commit de merge (sin fast-forward). Requiere árbol limpio. */
export async function mergeBranch(repoPath: string, branch: string, into?: string): Promise<{ into: string; commit: string }> {
  const cwd = repoRoot(repoPath);
  const dirty = await git(cwd, ['status', '--porcelain']);
  if (dirty) throw Object.assign(new Error('El repositorio tiene cambios sin confirmar. Confírmalos o descártalos antes de integrar.'), { statusCode: 409 });
  const target = into ?? await mainBranch(cwd, branch);
  if (target === branch) throw Object.assign(new Error('La rama de destino no puede ser la misma rama de trabajo.'), { statusCode: 400 });
  const exists = (await git(cwd, ['branch', '--list', target])).trim();
  if (!exists) throw Object.assign(new Error(`La rama principal «${target}» no existe en el repositorio.`), { statusCode: 409 });
  await git(cwd, ['checkout', target]);
  try {
    await git(cwd, ['-c', 'user.name=Portal IA', '-c', 'user.email=portal-ia@local', 'merge', '--no-ff', '--no-edit', '-m', `Integra ${branch} en ${target} (aprobado por el propietario en Portal IA)`, branch]);
  } catch (e: any) {
    await git(cwd, ['merge', '--abort']).catch(() => '');
    throw Object.assign(new Error(`No se pudo integrar «${branch}» en «${target}» (conflictos o error de git). Resuélvelo manualmente con git. Detalle: ${e.message}`), { statusCode: 409 });
  }
  const commit = await git(cwd, ['rev-parse', '--short', 'HEAD']);
  return { into: target, commit };
}

/** Publica ramas en el remoto (git push -u). Usa las credenciales de git del equipo (gestor de credenciales / SSH). */
export async function pushBranches(repoPath: string, branches: string[]): Promise<{ remote: string; url: string | null; branches: string[] }> {
  const cwd = repoRoot(repoPath);
  const { remote, url } = await remoteInfo(repoPath);
  if (!remote) throw Object.assign(new Error('El repositorio no tiene un remoto configurado. Añádelo con «git remote add origin <url>» y vuelve a intentarlo.'), { statusCode: 409 });
  for (const b of branches) {
    if (!/^[A-Za-z0-9._\/-]{1,80}$/.test(b)) throw Object.assign(new Error(`Nombre de rama no válido: ${b}`), { statusCode: 400 });
    if (!(await git(cwd, ['branch', '--list', b])).trim()) throw Object.assign(new Error(`La rama «${b}» no existe en el repositorio local (quizá se borró o se renombró). Nada que publicar.`), { statusCode: 409 });
    try { await execFileP('git', ['push', '-u', remote, b], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 120_000 }); }
    catch (e: any) { throw Object.assign(new Error(`git push ${remote} ${b} falló: ${(e.stderr || e.message || '').toString().trim().split('\n').slice(-3).join(' ')}. Si pide credenciales, inicia sesión en git (gestor de credenciales o SSH) y vuelve a intentarlo.`), { statusCode: 502 }); }
  }
  return { remote, url, branches };
}

const ALLOWED_COMMANDS: Record<string, string[]> = { install: ['install', '--no-audit', '--no-fund'], typecheck: ['run', 'typecheck'], test: ['run', 'test'], build: ['run', 'build'] };

/** Ejecuta un comando npm permitido en el repositorio (ejecución local, sin sandbox; requiere autorización por uso). */
export function runVerification(repoPath: string, command: string, timeoutMs = 10 * 60_000): Promise<VerificationRun> {
  const args = ALLOWED_COMMANDS[command];
  if (!args) throw Object.assign(new Error(`Comando no permitido: ${command}`), { statusCode: 400 });
  const cwd = repoRoot(repoPath);
  const startedAt = new Date().toISOString(); const t0 = Date.now();
  return new Promise(resolve => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npm, args, { cwd, env: { ...process.env, CI: '1', FORCE_COLOR: '0' }, shell: process.platform === 'win32' });
    let out = '';
    const push = (b: Buffer) => { out += b.toString(); if (out.length > 60_000) out = out.slice(-60_000); };
    child.stdout.on('data', push); child.stderr.on('data', push);
    const timer = setTimeout(() => { child.kill(); out += `\n[Portal IA] Tiempo de espera agotado (${timeoutMs / 1000} s).`; }, timeoutMs);
    child.on('close', code => { clearTimeout(timer); resolve({ command: `npm ${args.join(' ')}`, exitCode: code, output: out.trim(), startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0 }); });
    child.on('error', err => { clearTimeout(timer); resolve({ command: `npm ${args.join(' ')}`, exitCode: null, output: `No se pudo ejecutar: ${err.message}`, startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0 }); });
  });
}
