import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProposedChange, VerificationRun } from '@portal-ia/domain';
import { expandHome } from '../routes/fs.ts';

const execFileP = promisify(execFile);

/**
 * Escritura en el repositorio y verificación local. SIEMPRE tras autorización explícita del usuario por uso
 * (herramientas de riesgo `auth`). Las escrituras van a una rama de trabajo propia y se confirman en git para que
 * todo cambio sea revisable y reversible. Nunca se toca `.git`, `data/`, `node_modules/`, ni archivos con secretos.
 */
const FORBIDDEN = [/^\.git(\/|$)/i, /^data(\/|$)/i, /^node_modules(\/|$)/i, /(^|\/)\.env(\.(?!example$|sample$|template$|dist$)[^/]*)?$/i, /\.(key|pem|p12|pfx)$/i, /(^|\/)\.master\.key$/i];

/** Patrones de secretos que no deben entrar en un repositorio (aviso, no bloqueo: el propietario decide). */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'clave de API de Anthropic'], [/\bsk-[A-Za-z0-9]{32,}\b/, 'clave de API (sk-…)'], [/\bAKIA[0-9A-Z]{16}\b/, 'clave de acceso AWS'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, 'token de GitHub'], [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'clave privada'], [/_authToken\s*=\s*\S{8,}/i, 'token de registro npm'], [/\b(password|passwd|contraseña|secret|api[_-]?key)\s*[:=]\s*['"][^'"\s]{8,}['"]/i, 'credencial literal']
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
export const hashText = (t: string) => crypto.createHash('sha1').update(t).digest('hex');
/** Hash actual de un archivo del repositorio (null si no existe). */
/** El hash se calcula siempre sobre LF para que un archivo CRLF (Windows) no parezca «cambiado». */
export function fileHash(repoPath: string, rel: string): string | null { const c = readRepoFile(repoPath, rel, 50_000_000); return c === null ? null : hashText(c.replace(/\r\n/g, '\n')); }

/**
 * Comprueba, justo antes de aplicar, que cada archivo a modificar sigue siendo el que leyó el Desarrollador.
 * Un cambio «modify» completo sobre un archivo que cambió después machacaría trabajo posterior: se marca y no se escribe.
 */
export function checkStaleChanges(repoPath: string, changes: ProposedChange[]): ProposedChange[] {
  return changes.map(c => {
    if (c.error || c.action === 'delete' || !c.baseHash) return c;
    const now = fileHash(repoPath, c.path);
    if (now === null && c.action === 'modify') return { ...c, error: 'El archivo ya no existe en el repositorio (se leyó cuando existía).' };
    if (now !== null && now !== c.baseHash) return { ...c, error: 'El archivo cambió en el repositorio después de que el Desarrollador lo leyera: aplicar esta versión completa sobrescribiría ese trabajo. Vuelve a ejecutar la historia sobre el código actual.' };
    return c;
  });
}

/** ¿El archivo tiene commits (o cambios sin confirmar) posteriores a la fecha dada? Para resultados recuperados tarde. */
export async function fileChangedSince(repoPath: string, rel: string, sinceIso: string): Promise<boolean> {
  const cwd = repoRoot(repoPath);
  try {
    const last = await git(cwd, ['log', '-1', '--format=%cI', '--', rel]);
    if (last && new Date(last).getTime() > new Date(sinceIso).getTime()) return true;
    const dirty = await git(cwd, ['status', '--porcelain', '--', rel]);
    return !!dirty.trim();
  } catch { return false; }
}

export function annotateChanges(repoPath: string, changes: RawChange[]): ProposedChange[] {
  return changes.map(c => {
    const relDisplay = c.path.replace(/\\/g, '/');
    let rel: string;
    try { rel = safeRelPath(c.path); } catch (e: any) { return { path: relDisplay, action: c.action === 'delete' ? 'delete' : 'modify', content: null, diff: '', before: 0, after: 0, error: e.message } as ProposedChange; }
    const existingRaw = readRepoFile(repoPath, rel, 400_000);
    const existing = existingRaw === null ? null : existingRaw.replace(/\r\n/g, '\n'); // comparar siempre en LF (Windows suele guardar CRLF)
    const before = existing ?? '';
    let after = c.action === 'delete' ? '' : (c.content ?? '').replace(/\r\n/g, '\n');
    let error: string | null = null;
    if (c.action === 'patch') {
      if (existing === null) error = 'El archivo a parchear no existe en el repositorio.';
      else { const r = applyPatch(existing, c.edits ?? []); after = r.text; error = r.error; }
    }
    if (c.action === 'modify' && existing === null && !c.content) error = 'El archivo no existe y no se entregó contenido.';
    const action: ProposedChange['action'] = c.action === 'delete' ? 'delete' : existing === null ? 'create' : 'modify';
    const beforeLines = existing === null ? 0 : before.split('\n').length; const afterLines = action === 'delete' ? 0 : after.split('\n').length;
    const warnings: string[] = [];
    const secret = action !== 'delete' ? scanSecrets(after) : null; if (secret) warnings.push(secret);
    // Un «modify» completo que borra muchas líneas suele ser una copia desactualizada del archivo: avisar.
    if (action === 'modify' && c.action === 'modify' && beforeLines >= 40 && afterLines < beforeLines * 0.8) warnings.push(`Este reemplazo completo deja el archivo con ${afterLines} líneas (tenía ${beforeLines}): comprueba en el diff que las líneas en rojo no sean trabajo reciente que el Desarrollador no vio.`);
    return { path: rel, action, content: action === 'delete' ? null : after, diff: error ? '' : unifiedDiff(before, after, rel), before: beforeLines, after: afterLines, error, warning: warnings.join(' ') || null, baseHash: existing === null ? null : hashText(existing) };
  });
}

export async function git(cwd: string, args: string[]): Promise<string> {
  try { const { stdout } = await execFileP('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }); return stdout.trim(); }
  catch (e: any) { throw Object.assign(new Error(`git ${args[0]}: ${(e.stderr || e.message || '').toString().trim()}`), { statusCode: 500 }); }
}

/** Aplica los cambios en una rama de trabajo y crea un commit. Devuelve rama, commit y archivos. */
/** Ruta del worktree aislado de un proceso (fuera del repositorio, hermano `<repo>-worktrees/<id>`). */
export function worktreePathFor(repoPath: string, processId: string): string {
  const cwd = repoRoot(repoPath);
  const base = path.resolve(cwd, '..', `${path.basename(cwd)}-worktrees`);
  if (!/^[A-Za-z0-9-]{4,64}$/.test(processId)) throw Object.assign(new Error('Identificador de proceso no válido.'), { statusCode: 400 });
  return path.join(base, processId);
}

/**
 * Aplica los cambios en un WORKTREE aislado del proceso (M1): el checkout desde el que corre el Portal nunca cambia de
 * rama ni se toca. La rama de la historia nace de la rama principal; si ya existe (iteración), se reutiliza.
 * Rollback: eliminar el worktree (y la rama si la creamos nosotros y no tiene commits propios). Nunca `reset --hard`.
 */
export async function applyChanges(repoPath: string, branch: string, changes: ProposedChange[], message: string, opts: { processId?: string } = {}): Promise<{ branch: string; commit: string; files: string[]; worktree: string | null }> {
  const cwd = repoRoot(repoPath);
  if (!fs.existsSync(path.join(cwd, '.git'))) throw Object.assign(new Error('La carpeta registrada no es un repositorio git.'), { statusCode: 400 });
  if (!/^[A-Za-z0-9._\/-]{1,80}$/.test(branch)) throw Object.assign(new Error('Nombre de rama no válido.'), { statusCode: 400 });
  const hasCommits = await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).then(() => true).catch(() => false);
  if (!hasCommits) throw Object.assign(new Error('El repositorio no tiene commits. Confirma el código actual (git add -A && git commit -m "Base") antes de aplicar historias.'), { statusCode: 409 });
  const processId = opts.processId ?? `p-${Date.now().toString(36)}`;
  const wt = worktreePathFor(cwd, processId);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  // Un worktree anterior del mismo proceso (reintento) se reutiliza si está sano; si no, se retira.
  if (fs.existsSync(wt)) { await git(cwd, ['worktree', 'remove', '--force', wt]).catch(() => ''); if (fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true }); await git(cwd, ['worktree', 'prune']).catch(() => ''); }
  const branchExisted = !!(await git(cwd, ['branch', '--list', branch])).trim();
  const base = await mainBranch(cwd, branch);
  if (branchExisted) await git(cwd, ['worktree', 'add', '-q', wt, branch]);
  else await git(cwd, ['worktree', 'add', '-q', '-b', branch, wt, base]);
  const files: string[] = [];
  try {
    for (const c of changes) {
      if (c.error) continue; // cambios inválidos: se muestran en la revisión pero no se escriben
      const abs = path.join(wt, safeRelPath(c.path));
      if (c.action === 'delete') { if (fs.existsSync(abs)) fs.rmSync(abs); }
      else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        let content = c.content ?? '';
        try { if (fs.existsSync(abs) && /\r\n/.test(fs.readFileSync(abs, 'utf8').slice(0, 4000))) content = content.replace(/\r?\n/g, '\r\n'); } catch { /* se escribe tal cual */ }
        fs.writeFileSync(abs, content, 'utf8');
      }
      files.push(c.path);
    }
    await git(wt, ['add', '-A']);
    const staged = await git(wt, ['diff', '--cached', '--name-only']);
    if (!staged) throw Object.assign(new Error('Los cambios propuestos no modifican nada respecto al repositorio.'), { statusCode: 409 });
    await git(wt, ['-c', 'user.name=Portal IA', '-c', 'user.email=portal-ia@local', 'commit', '-q', '-m', message]);
    const commit = await git(wt, ['rev-parse', '--short', 'HEAD']);
    return { branch, commit, files, worktree: wt };
  } catch (e) {
    try { await git(cwd, ['worktree', 'remove', '--force', wt]); if (!branchExisted) await git(cwd, ['branch', '-D', branch]); } catch { /* informar el error original */ }
    throw e;
  }
}

/**
 * Corrección dentro del pipeline: escribe cambios (ya validados contra el worktree) en el worktree existente del proceso
 * y crea un commit adicional en su rama. Nunca toca el checkout principal.
 */
export async function commitInWorktree(wt: string, changes: ProposedChange[], message: string): Promise<{ commit: string; files: string[] }> {
  if (!fs.existsSync(wt)) throw Object.assign(new Error('El worktree del proceso ya no existe.'), { statusCode: 409 });
  const files: string[] = [];
  for (const c of changes) {
    if (c.error) continue;
    const abs = path.join(wt, safeRelPath(c.path));
    if (c.action === 'delete') { if (fs.existsSync(abs)) fs.rmSync(abs); }
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      let content = c.content ?? '';
      try { if (fs.existsSync(abs) && /\r\n/.test(fs.readFileSync(abs, 'utf8').slice(0, 4000))) content = content.replace(/\r?\n/g, '\r\n'); } catch { /* se escribe tal cual */ }
      fs.writeFileSync(abs, content, 'utf8');
    }
    files.push(c.path);
  }
  await git(wt, ['add', '-A']);
  const staged = await git(wt, ['diff', '--cached', '--name-only']);
  if (!staged) throw Object.assign(new Error('La corrección no modifica nada respecto al worktree.'), { statusCode: 409, code: 'no_effect' });
  await git(wt, ['-c', 'user.name=Portal IA', '-c', 'user.email=portal-ia@local', 'commit', '-q', '-m', message]);
  return { commit: await git(wt, ['rev-parse', '--short', 'HEAD']), files };
}

/**
 * Diff acumulado de la rama del proceso respecto a su base en la rama principal (lo que el propietario revisa al final,
 * tras correcciones). Cada archivo: contenido de la base → contenido actual del worktree.
 */
export async function changesSinceBase(repoPath: string, wt: string): Promise<ProposedChange[]> {
  const main = await mainBranch(repoRoot(repoPath));
  const base = await git(wt, ['merge-base', 'HEAD', main]);
  const status = (await git(wt, ['diff', '--name-status', '--no-renames', base, 'HEAD'])).split('\n').filter(Boolean);
  const out: ProposedChange[] = [];
  for (const line of status) {
    const [st, file] = line.split('\t'); if (!file) continue;
    // git() recorta la salida; aquí hace falta el contenido exacto (salto final incluido) para un diff fiel.
    const before = st === 'A' ? '' : (await execFileP('git', ['show', `${base}:${file}`], { cwd: wt, maxBuffer: 20 * 1024 * 1024 }).then(r => r.stdout, () => '')).replace(/\r\n/g, '\n');
    const after = st === 'D' ? '' : (readRepoFile(wt, file, 400_000) ?? '').replace(/\r\n/g, '\n');
    const action: ProposedChange['action'] = st === 'D' ? 'delete' : st === 'A' ? 'create' : 'modify';
    out.push({ path: file, action, content: action === 'delete' ? null : after, diff: unifiedDiff(before, after, file), before: st === 'A' ? 0 : before.split('\n').length, after: st === 'D' ? 0 : after.split('\n').length, error: null, warning: action !== 'delete' ? scanSecrets(after) : null, baseHash: st === 'A' ? null : hashText(before) });
  }
  return out;
}

/** Retira el worktree de un proceso (tras integrar o rechazar). Solo rutas bajo `<repo>-worktrees`. */
export async function removeWorktree(repoPath: string, processId: string): Promise<boolean> {
  const cwd = repoRoot(repoPath); const wt = worktreePathFor(cwd, processId);
  if (!fs.existsSync(wt)) { await git(cwd, ['worktree', 'prune']).catch(() => ''); return false; }
  await git(cwd, ['worktree', 'remove', '--force', wt]).catch(() => '');
  if (fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true });
  await git(cwd, ['worktree', 'prune']).catch(() => '');
  return true;
}

/** Descarta la rama de una historia no integrada: retira el worktree y borra la rama solo si main no la contiene. Nunca toca el checkout principal. */
export async function discardBranch(repoPath: string, processId: string, branch: string): Promise<{ worktreeRemoved: boolean; branchDeleted: boolean }> {
  const cwd = repoRoot(repoPath);
  const worktreeRemoved = await removeWorktree(cwd, processId);
  const main = await mainBranch(cwd, branch);
  const merged = (await git(cwd, ['branch', '--merged', main, '--format=%(refname:short)']).catch(() => '')).split('\n').map(s => s.trim());
  if (merged.includes(branch)) return { worktreeRemoved, branchDeleted: false }; // ya integrada: no se borra
  const current = await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '');
  if (current === branch) return { worktreeRemoved, branchDeleted: false }; // es la rama activa del checkout: no se toca
  const branchDeleted = await git(cwd, ['branch', '-D', branch]).then(() => true).catch(() => false);
  return { worktreeRemoved, branchDeleted };
}

/** Worktrees de procesos existentes (para listar huérfanos y limpiarlos con autorización). */
export async function listWorktrees(repoPath: string): Promise<{ path: string; branch: string | null; processId: string }[]> {
  const cwd = repoRoot(repoPath); const base = path.resolve(cwd, '..', `${path.basename(cwd)}-worktrees`);
  const out = await git(cwd, ['worktree', 'list', '--porcelain']).catch(() => '');
  const items: { path: string; branch: string | null; processId: string }[] = []; let cur: any = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), branch: null }; }
    else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (line === '' && cur) { if (path.resolve(cur.path).startsWith(base)) items.push({ ...cur, processId: path.basename(cur.path) }); cur = null; }
  }
  if (cur && path.resolve(cur.path).startsWith(base)) items.push({ ...cur, processId: path.basename(cur.path) });
  return items;
}

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
/**
 * Integra la rama de trabajo en la rama principal con un commit de merge (sin fast-forward) y sin cambiar la rama del
 * checkout principal: si este está en main, se integra ahí (exige que los archivos afectados no tengan cambios locales);
 * si está en otra rama, se integra en un worktree temporal de main y se actualiza la referencia.
 */
export async function mergeBranch(repoPath: string, branch: string, into?: string, opts: { affectedFiles?: string[]; processId?: string } = {}): Promise<{ into: string; commit: string; viaWorktree: boolean }> {
  const cwd = repoRoot(repoPath);
  const target = into ?? await mainBranch(cwd, branch);
  if (target === branch) throw Object.assign(new Error('La rama de destino no puede ser la misma rama de trabajo.'), { statusCode: 400 });
  if (!(await git(cwd, ['branch', '--list', target])).trim()) throw Object.assign(new Error(`La rama principal «${target}» no existe en el repositorio.`), { statusCode: 409 });
  const current = await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '');
  const mergeMsg = `Integra ${branch} en ${target} (aprobado por el propietario en Portal IA)`;
  const GIT_ID = ['-c', 'user.name=Portal IA', '-c', 'user.email=portal-ia@local'];
  if (current === target) {
    const files = opts.affectedFiles ?? [];
    const dirty = files.length ? await git(cwd, ['status', '--porcelain', '--', ...files]) : await git(cwd, ['status', '--porcelain']);
    if (dirty.trim()) throw Object.assign(new Error(`Hay cambios locales sin confirmar en archivos que esta historia modifica (${dirty.trim().split('\n').map(l => l.slice(3)).slice(0, 5).join(', ')}). Confírmalos o descártalos tú y vuelve a integrar.`), { statusCode: 409 });
    try { await execFileP('git', [...GIT_ID, 'merge', '--no-ff', '--no-edit', '-m', mergeMsg, branch], { cwd, maxBuffer: 10 * 1024 * 1024 }); }
    catch (e: any) { await git(cwd, ['merge', '--abort']).catch(() => ''); throw mergeFailure(branch, target, e); }
    return { into: target, commit: await git(cwd, ['rev-parse', '--short', 'HEAD']), viaWorktree: false };
  }
  // El checkout principal está en otra rama: no lo tocamos. Merge en un worktree temporal de main.
  const tmp = worktreePathFor(cwd, `merge-${Date.now().toString(36)}`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  await git(cwd, ['worktree', 'add', '-q', '--detach', tmp, target]);
  try {
    await execFileP('git', [...GIT_ID, 'merge', '--no-ff', '--no-edit', '-m', mergeMsg, branch], { cwd: tmp, maxBuffer: 10 * 1024 * 1024 });
    const commit = await git(tmp, ['rev-parse', 'HEAD']);
    await git(cwd, ['update-ref', `refs/heads/${target}`, commit]);
    return { into: target, commit: commit.slice(0, 7), viaWorktree: true };
  } catch (e: any) {
    await git(tmp, ['merge', '--abort']).catch(() => '');
    throw mergeFailure(branch, target, e);
  } finally { await git(cwd, ['worktree', 'remove', '--force', tmp]).catch(() => ''); }
}

/**
 * Error de un merge con la salida REAL de git: conflicto (stdout «CONFLICT …», con los archivos) o cualquier otro motivo
 * (archivos sin seguimiento que se sobrescribirían, cambios locales…), que ya no se presenta como «conflictos».
 */
function mergeFailure(branch: string, target: string, e: any): Error {
  const out = `${e?.stdout ?? ''}\n${e?.stderr ?? ''}`.trim();
  const files = Array.from(new Set(Array.from(out.matchAll(/Merge conflict in (\S+)/g)).map(x => x[1])));
  const conflict = files.length > 0 || /CONFLICT \(/.test(out);
  const why = out.split('\n').map(l => l.trim()).filter(l => /CONFLICT|error:|fatal:|would be overwritten|Please commit|Aborting/i.test(l)).slice(0, 12).join(' · ') || (e?.message ?? '').toString().slice(0, 400);
  return Object.assign(new Error(conflict
    ? `No se pudo integrar «${branch}» en «${target}» (conflictos en ${files.length || 'algunos'} archivo(s)${files.length ? `: ${files.join(', ')}` : ''}). La rama queda intacta. Detalle de git: ${why}`
    : `No se pudo integrar «${branch}» en «${target}» (no es un conflicto de contenido). La rama queda intacta. Detalle de git: ${why}`), { statusCode: 409, conflict, conflictFiles: files });
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

// (M1) La ejecución de comandos vive en services/sandbox.ts: nunca en el equipo del propietario.
