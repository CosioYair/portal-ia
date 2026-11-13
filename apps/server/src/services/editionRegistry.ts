import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  canTransition, editionTransitionError, EDITION_LICENSE_DAYS, INTERNAL_WORKSPACE, nextLicenseStatus, renewedExpiry,
  type EditionAction, type EditionLicenseStatus, type EditionView
} from '@portal-ia/domain';
import { workspaceDb, workspaceDbPath, processesRepo } from '../db/workspace.ts';
import { EDITION_DISABLED_REASON, SELF_IMPROVEMENT_ENABLED } from '../config.ts';
import { PolicyError } from './executionPolicy.ts';
import { assertCleanTree, buildEditionZip, type EditionZipResult } from './editionBundle.ts';

/**
 * HU-214 · Registro de ediciones (solo en el núcleo: base de INTERNAL_WORKSPACE). La raíz del repositorio la pasa quien
 * llama (este archivo no importa la constante de la raíz de config.ts, HU-205). Toda acción exige la autorización explícita del propietario y queda auditada en
 * execution_history como `policy:edition-<acción>:granted|denied`.
 */

export interface EditionEnv {
  root: string;
  webDist: string;
  dataDir: string;
  /** Carpeta de salida; por defecto la hermana «<repo>-ediciones». */
  outDir?: string;
  git?: (args: string[]) => string;
  build?: typeof buildEditionZip;
  now?: () => Date;
  /** Para pruebas: simula la edición distribuible. */
  distributable?: boolean;
}

const fail = (msg: string, statusCode: number, code?: string) => Object.assign(new Error(msg), { statusCode, code });

const ready = new Set<string>();
function db(slug: string) {
  const d = workspaceDb(slug);
  if (!ready.has(slug)) {
    const exists = d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'editions'").get();
    if (!exists) {
      // Migración aditiva con copia previa de la base (una sola vez).
      try {
        const bak = `${workspaceDbPath(slug)}.pre-editions.bak`;
        if (!fs.existsSync(bak)) d.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`);
      } catch { /* la copia no debe impedir la migración aditiva */ }
    }
    d.exec(`CREATE TABLE IF NOT EXISTS editions (
      id TEXT PRIMARY KEY, version TEXT NOT NULL, commit_sha TEXT NOT NULL, sha256 TEXT NOT NULL, zip_path TEXT NOT NULL,
      entries INTEGER NOT NULL, bytes INTEGER NOT NULL, created_at TEXT NOT NULL,
      license_id TEXT NOT NULL, license_status TEXT NOT NULL, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      renewals INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS editions_created ON editions(created_at);`);
    ready.add(slug);
  }
  return d;
}

interface Row {
  id: string; version: string; commit_sha: string; sha256: string; zip_path: string; entries: number; bytes: number;
  created_at: string; license_id: string; license_status: string; issued_at: string; expires_at: string; renewals: number; updated_at: string;
}
const toView = (r: Row): EditionView => ({
  id: r.id, version: r.version, commit: r.commit_sha, sha256: r.sha256, zipPath: r.zip_path, entries: Number(r.entries), bytes: Number(r.bytes),
  createdAt: r.created_at, updatedAt: r.updated_at,
  license: { id: r.license_id, status: r.license_status as EditionLicenseStatus, issuedAt: r.issued_at, expiresAt: r.expires_at, renewals: Number(r.renewals) }
});

/** Las ediciones solo existen en el núcleo (Estudio). */
function assertCore(slug: string): void {
  if (slug !== INTERNAL_WORKSPACE.slug) throw fail('Las ediciones solo existen en el núcleo del Portal.', 404, 'not_core');
}
function assertStudio(env?: Pick<EditionEnv, 'distributable'>): void {
  if (env?.distributable ?? !SELF_IMPROVEMENT_ENABLED) throw fail(EDITION_DISABLED_REASON, 403, 'edition_distributable');
}

/** Puerta de autorización y auditoría (misma semántica que requirePolicy: nivel «auth»). */
function authorize(slug: string, action: EditionAction, authorized: boolean): void {
  const log = (status: 'granted' | 'denied', reason?: string) =>
    processesRepo(slug).logExecution({ projectId: '', agentId: '', kind: `policy:edition-${action}:${status}${reason ? `:${reason}` : ''}`, status: status === 'granted' ? 'done' : 'failed', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: new Date().toISOString() });
  if (!authorized) {
    // La denegación se responde siempre con 403; si su registro falla, se avisa (no se oculta).
    try { log('denied', 'sin_autorizacion'); } catch (e) { console.warn(`[ediciones] no se pudo auditar la denegación de «${action}»:`, e); }
    throw new PolicyError('authorization_required', 'Esta acción sobre ediciones requiere autorización explícita del propietario.');
  }
  // Sin auditoría no hay acción: si no se puede registrar la autorización, no se cambia nada.
  try { log('granted'); }
  catch { throw fail('No se pudo registrar la autorización en el historial: la acción no se ha aplicado.', 500, 'audit_failed'); }
}

export function listEditions(slug: string): EditionView[] {
  assertCore(slug);
  return (db(slug).prepare('SELECT * FROM editions ORDER BY created_at DESC').all() as unknown as Row[]).map(toView);
}

export function getEdition(slug: string, id: string): EditionView | null {
  const r = db(slug).prepare('SELECT * FROM editions WHERE id = ?').get(id) as unknown as Row | undefined;
  return r ? toView(r) : null;
}

function readVersion(root: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: unknown };
    const v = typeof pkg.version === 'string' ? pkg.version.trim() : '';
    return /^[0-9A-Za-z.+-]+$/.test(v) ? v : '0.0.0';
  } catch { return '0.0.0'; }
}

export async function generateEdition(slug: string, authorized: boolean, env: EditionEnv): Promise<EditionView> {
  assertCore(slug);
  assertStudio(env);
  authorize(slug, 'generate', authorized);
  if (!canTransition(null, 'generate')) throw fail(editionTransitionError(null, 'generate'), 409);
  const git = env.git ?? ((args: string[]) => execFileSync('git', args, { cwd: env.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  let porcelain: string; let head: string;
  try { porcelain = git(['status', '--porcelain']); head = git(['rev-parse', 'HEAD']).trim(); }
  catch { throw fail('No se pudo consultar git en la raíz del repositorio: la edición solo se genera desde un checkout de git.', 409); }
  assertCleanTree(porcelain);
  if (!/^[0-9a-f]{40}$/i.test(head)) throw fail(`HEAD no es un commit válido («${head}»).`, 409);
  const version = readVersion(env.root);
  const outDir = env.outDir ?? path.join(path.dirname(env.root), `${path.basename(env.root)}-ediciones`);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `portal-ia-edicion-${version}-${head.slice(0, 7)}.zip`);
  const res: EditionZipResult = await (env.build ?? buildEditionZip)({ root: env.root, webDist: env.webDist, dataDir: env.dataDir, outFile, expectedCommit: head });
  const now = (env.now ?? (() => new Date()))();
  const at = now.toISOString();
  const id = crypto.randomUUID();
  const licenseId = `LIC-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const expires = new Date(now.getTime() + EDITION_LICENSE_DAYS * 86_400_000).toISOString();
  db(slug).prepare(`INSERT INTO editions (id, version, commit_sha, sha256, zip_path, entries, bytes, created_at, license_id, license_status, issued_at, expires_at, renewals, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 0, ?)`).run(id, version, head, res.sha256, res.outFile, res.entries, res.bytes, at, licenseId, at, expires, at);
  return getEdition(slug, id)!;
}

function transition(slug: string, id: string, action: Exclude<EditionAction, 'generate'>, authorized: boolean, env?: Pick<EditionEnv, 'distributable' | 'now'>): EditionView {
  assertCore(slug);
  assertStudio(env);
  authorize(slug, action, authorized);
  const cur = getEdition(slug, id);
  if (!cur) throw fail('La edición no existe.', 404, 'not_found');
  if (!canTransition(cur.license.status, action)) throw fail(editionTransitionError(cur.license.status, action), 409, 'invalid_transition');
  const now = (env?.now ?? (() => new Date()))();
  const status = nextLicenseStatus(cur.license.status, action);
  const expires = action === 'renew' ? renewedExpiry(cur.license.expiresAt, now) : cur.license.expiresAt;
  const renewals = cur.license.renewals + (action === 'renew' ? 1 : 0);
  db(slug).prepare('UPDATE editions SET license_status = ?, expires_at = ?, renewals = ?, updated_at = ? WHERE id = ?').run(status, expires, renewals, now.toISOString(), id);
  return getEdition(slug, id)!;
}

export function renewEdition(slug: string, id: string, authorized: boolean, env?: Pick<EditionEnv, 'distributable' | 'now'>): EditionView {
  return transition(slug, id, 'renew', authorized, env);
}
export function setEditionActive(slug: string, id: string, active: boolean, authorized: boolean, env?: Pick<EditionEnv, 'distributable' | 'now'>): EditionView {
  return transition(slug, id, active ? 'activate' : 'deactivate', authorized, env);
}
export function revokeEdition(slug: string, id: string, authorized: boolean, env?: Pick<EditionEnv, 'distributable' | 'now'>): EditionView {
  return transition(slug, id, 'revoke', authorized, env);
}
