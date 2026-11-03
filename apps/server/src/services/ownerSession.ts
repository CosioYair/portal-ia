import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import { platform } from '../db/platform.ts';

/**
 * Identidad del propietario para las acciones que deciden una revisión del proyecto (prepararla, ejecutarla, reanudarla
 * o rechazarla) y las operaciones que el Asistente propone en el chat. La API escucha en 127.0.0.1 y, sin esto,
 * cualquier programa del equipo o cualquier página de otro puerto local podía enviar `authorized: true` y ejecutarlas.
 *
 * - Vincular un navegador: el Portal genera un código de un solo uso (5 min, 100 bits: adivinarlo es imposible, así que
 *   no hace falta limitar intentos y nadie puede bloquearte la vinculación a base de fallos) y lo muestra SOLO fuera de
 *   la API: en un archivo de tu perfil de usuario (ver `codeFile`) y en la ventana donde se arrancó (`npm start`). Nunca
 *   viaja en una respuesta. El propietario lo pega en la interfaz y recibe una sesión.
 * - La sesión es un secreto aleatorio que la interfaz guarda en el almacenamiento de SU origen (otro puerto local no lo
 *   puede leer, a diferencia de una cookie, que el navegador envía a cualquier puerto del mismo host) y envía en la
 *   cabecera `X-Portal-Owner`. El servidor guarda solo su hash; caduca en 7 días; se puede cerrar una o todas.
 * - Solo en la dirección del propio Portal (su puerto): la interfaz de desarrollo (5173, el puerto que usa Vite en
 *   cualquier proyecto) u otra copia no vinculan ni autorizan, porque otra aplicación en ese puerto leería la sesión.
 * - Las peticiones protegidas exigen además JSON y, si traen Origin, el del propio Portal.
 *
 * Límite: un programa que se ejecuta con TU usuario de Windows y lee tus archivos podría leer el código o la base de
 * datos (y usar git directamente con tus credenciales); esto protege frente a quien solo puede hacer peticiones HTTP.
 */
export const OWNER_HEADER = 'x-portal-owner';
const SESSION_MS = 7 * 24 * 3600_000; const MAX_LIFETIME_MS = 30 * 24 * 3600_000; const CODE_MS = 5 * 60_000; const GROUPS = 5;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 símbolos sin I, O, 0 ni 1: 5 bits cada uno, sin sesgo (256 % 32 = 0)
let pending: { code: string; hash: string; expiresAt: number } | null = null;

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const fail = (statusCode: number, error: string, code: string) => Object.assign(new Error(error), { statusCode, code });
function ensure() { platform.exec(`CREATE TABLE IF NOT EXISTS owner_sessions (token_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, label TEXT)`); }
const normalize = (c: string) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Archivo con el código: en tu perfil (solo tu usuario de Windows lo abre), nunca en la carpeta del repositorio; con el
 * puerto en el nombre, para que otro Portal del equipo no lo pise. Un Portal con datos en una carpeta temporal (pruebas,
 * entornos aislados) lo deja junto a sus datos. PORTAL_OWNER_CODE_FILE lo fija.
 */
export function codeFile(): string {
  if (process.env.PORTAL_OWNER_CODE_FILE?.trim()) return path.resolve(process.env.PORTAL_OWNER_CODE_FILE.trim());
  const tmp = path.resolve(os.tmpdir()).toLowerCase(); const data = path.resolve(config.dataDir);
  if (data.toLowerCase().startsWith(tmp + path.sep)) return path.join(data, 'codigo-propietario.txt');
  const base = process.platform === 'win32' ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')) : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'Portal IA', `codigo-propietario-${config.port}.txt`);
}
function forgetCode() { pending = null; try { fs.rmSync(codeFile(), { force: true }); } catch { /* ya no está */ } }
// Al arrancar no hay código vigente: el archivo de un arranque anterior mostraría uno que ya no vale.
forgetCode();

/**
 * Pedir un código: si hay uno vigente se vuelve a mostrar el mismo (otra petición no invalida el que estás pegando). Se
 * escribe en `codeFile()` (creado de nuevo, solo para ti) y en la salida del servidor; se devuelve SOLO a quien llama
 * dentro del proceso (pruebas): la ruta HTTP nunca lo incluye en su respuesta.
 */
export function issuePairingCode(show: (line: string) => void = line => console.log(line)): { code: string; expiresInSec: number; file: string | null; problem: string | null } {
  const t = Date.now();
  if (!pending || t >= pending.expiresAt) {
    const raw = Array.from(crypto.randomBytes(GROUPS * 4), b => ALPHABET[b % ALPHABET.length]).join('');
    pending = { code: raw.match(/.{4}/g)!.join('-'), hash: sha(raw), expiresAt: t + CODE_MS };
  }
  const until = new Date(pending.expiresAt).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  const text = `Código para vincular tu navegador como propietario del Portal IA:\n\n${pending.code}\n\nVálido hasta las ${until}, un solo uso. Cópialo y pégalo en el Portal, en «Vincula este navegador como propietario».\nSi no lo pediste tú, no lo uses: sin este código nadie puede autorizar en tu nombre.\n`;
  // Se borra y se crea de nuevo en exclusiva: un archivo previo (p. ej. puesto por otro) no conserva sus permisos. Sin
  // alternativa en otra carpeta: la del Portal puede ser legible por otros usuarios de Windows.
  let file: string | null = codeFile();
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.rmSync(file, { force: true }); fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
  catch (e: any) { console.error(`[portal-ia] No se pudo escribir el código de vinculación en ${file}: ${e?.code ?? e?.message ?? e}`); file = null; }
  show(`\n[portal-ia] Código para vincular tu navegador como propietario: ${pending.code}  (válido hasta las ${until}, un solo uso)\n[portal-ia] ${file ? `También en: ${file}` : 'No se pudo escribir en ningún archivo: solo aquí.'}\n[portal-ia] Si no lo pediste tú, no lo uses: sin este código nadie puede autorizar en tu nombre.\n`);
  return { code: pending.code, expiresInSec: Math.round((pending.expiresAt - t) / 1000), file, problem: file ? null : `No se pudo escribir el archivo del código (${codeFile()}): solo aparece en la ventana donde arrancaste el Portal. Para otra carpeta de tu perfil, arranca el Portal con PORTAL_OWNER_CODE_FILE.` };
}

/** Canjear el código por una sesión de propietario (el secreto solo se entrega aquí, una vez). */
export function pairOwner(code: string, label: string | null = null): { token: string; expiresAt: string } {
  const t = Date.now();
  const given = normalize(code);
  const ok = !!pending && t < pending.expiresAt && given.length === GROUPS * 4 && crypto.timingSafeEqual(Buffer.from(sha(given)), Buffer.from(pending.hash));
  if (!ok) throw fail(401, 'Código no válido o caducado: cópialo tal como aparece en el archivo o en la ventana del Portal (si pasaron 5 minutos, genera otro).', 'pairing_invalid');
  forgetCode();
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(t + SESSION_MS).toISOString();
  ensure();
  platform.prepare('DELETE FROM owner_sessions WHERE expires_at < ?').run(new Date(t).toISOString());
  platform.prepare('INSERT INTO owner_sessions (token_hash, created_at, expires_at, label) VALUES (?, ?, ?, ?)').run(sha(token), new Date(t).toISOString(), expiresAt, label ? label.slice(0, 160) : null);
  return { token, expiresAt };
}

function tokenOf(req: FastifyRequest): string | null {
  const v = req.headers[OWNER_HEADER]; const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && /^[A-Za-z0-9_-]{40,64}$/.test(s) ? s : null;
}
export function isOwner(req: FastifyRequest): boolean {
  if (ownerExempt()) return true;
  if (!ownPort(req)) return false;
  const token = tokenOf(req); if (!token) return false;
  ensure();
  const h = sha(token); const r = platform.prepare('SELECT created_at, expires_at FROM owner_sessions WHERE token_hash = ?').get(h) as any;
  const t = Date.now(); if (!r || Date.parse(r.expires_at) <= t) return false;
  // Caducidad deslizante: usarla la renueva (como mucho una escritura al día) hasta 7 días sin usarla; y nunca más de 30
  // días desde que se vinculó (entonces hay que vincular de nuevo). Si no se puede renovar ahora, la sesión sigue valiendo.
  const cap = Date.parse(r.created_at) + MAX_LIFETIME_MS;
  if (t >= cap) return false;
  if (Date.parse(r.expires_at) - t < SESSION_MS - 24 * 3600_000) {
    try { platform.prepare('UPDATE owner_sessions SET expires_at = ? WHERE token_hash = ?').run(new Date(Math.min(t + SESSION_MS, cap)).toISOString(), h); } catch { /* base ocupada: se renovará en otro uso */ }
  }
  return true;
}
/**
 * Copia de un candidato en su vista previa (PORTAL_PREVIEW=1, proveedor de IA simulado, datos temporales y dentro del
 * contenedor sin red: PORTAL_INSIDE_SANDBOX, que fija services/preview.ts; ver scripts/preview-runner.mjs): es el código del candidato con datos simulados, no tu Portal; ahí no
 * hay nada del propietario que proteger y el código no se puede leer. Tu Portal (proveedor real o datos en data/) nunca lo
 * cumple, aunque alguien fije PORTAL_PREVIEW.
 */
export function ownerExempt(): boolean {
  if (process.env.PORTAL_PREVIEW !== '1' || process.env.PORTAL_MOCK_PROVIDER !== '1' || process.env.PORTAL_INSIDE_SANDBOX !== '1') return false;
  const tmp = path.resolve(os.tmpdir()).toLowerCase(); return path.resolve(config.dataDir).toLowerCase().startsWith(tmp + path.sep);
}
// Si se aplica, que se vea: una copia así no protege nada (no debe ser nunca tu Portal).
if (ownerExempt()) console.warn('[portal-ia] Copia de vista previa (PORTAL_PREVIEW=1, proveedor simulado, datos temporales): sin sesión de propietario.');
export function revokeOwner(req: FastifyRequest) {
  const token = tokenOf(req); if (!token) return; ensure();
  platform.prepare('DELETE FROM owner_sessions WHERE token_hash = ?').run(sha(token));
}
/** Cerrar TODAS las sesiones (p. ej. si sospechas que otra copia leyó una). */
export function revokeAllOwners(): number { ensure(); return Number(platform.prepare('DELETE FROM owner_sessions').run().changes); }
/** Para la interfaz: dónde se escribe el código (no es secreto). */
export const pairingState = () => ({ file: codeFile() });

/**
 * ¿La petición llega a la dirección del propio Portal (su puerto)? El puerto del Host debe ser aquel en el que la recibió
 * el servidor (el de su conexión; sin conexión real, el configurado): por la interfaz de desarrollo (Vite en 5173, el
 * puerto que usa en cualquier proyecto) el Host dice 5173 aunque llegue al 4310. Solo escuchando en el equipo (lo normal):
 * detrás de un proxy o en la red (PORTAL_HOST no local, decisión explícita de quien lo configura) el Host no lleva su puerto.
 */
const LOCAL_ONLY = /^(127\.\d+\.\d+\.\d+|localhost|::1)$/i.test(config.host);
// Direcciones con las que el propietario publica este Portal a propósito (PORTAL_ALLOWED_HOSTS, p. ej. tras un proxy local):
// también son la suya, pero EXACTAS (nombre y puerto tal como llegan en Host; un nombre sin puerto, solo sin puerto). Así
// otra aplicación en otro puerto de ese nombre no puede vincular ni actuar.
const OWN_HOSTS = (process.env.PORTAL_ALLOWED_HOSTS ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
const portHere = (req: FastifyRequest) => (req.socket as any)?.localPort || config.port;
function ownPort(req: FastifyRequest): boolean {
  if (!LOCAL_ONLY) return true;
  const host = String(req.headers.host ?? '').toLowerCase();
  if (OWN_HOSTS.includes(host)) return true;
  const m = host.match(/:(\d+)$/);
  return (m ? Number(m[1]) : 80) === portHere(req);
}
const hasBody = (req: FastifyRequest) => Number(req.headers['content-length'] ?? 0) > 0 || !!req.headers['transfer-encoding'];
/**
 * Formato y procedencia de los cambios: si llevan cuerpo, JSON o un archivo en flujo (application/octet-stream); nunca
 * un formulario, texto o multipart, los tipos que otra página puede enviar sin permiso del navegador. La dirección del
 * propio Portal y, si traen Origin, el mismo. Si algo falla responde y devuelve false: no se toca nada.
 */
export function sameOriginJson(req: FastifyRequest, reply: FastifyReply): boolean {
  if (ownerExempt()) return true;
  if (hasBody(req) && !/^application\/(json|octet-stream)\s*(;|$)/i.test(String(req.headers['content-type'] ?? ''))) { reply.code(415).send({ error: 'Esta acción solo se acepta desde el Portal (JSON o un archivo).', code: 'json_required' }); return false; }
  if (!ownPort(req)) { reply.code(403).send({ error: `Haz los cambios desde la dirección del Portal (http://127.0.0.1:${portHere(req)}); la interfaz de desarrollo u otra copia no pueden.`, code: 'foreign_port' }); return false; }
  const origin = req.headers.origin;
  if (origin) { let same = false; try { same = new URL(origin).host === req.headers.host; } catch { same = false; } if (!same) { reply.code(403).send({ error: 'Esta acción solo se acepta desde el propio Portal.', code: 'foreign_origin' }); return false; } }
  return true;
}
/** Guardia de los cambios del propietario: lo anterior y una sesión válida. */
export function requireOwner(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!sameOriginJson(req, reply)) return false;
  if (!isOwner(req)) { reply.code(401).send({ error: 'Para hacer cambios, vincula este navegador como propietario (el código de un solo uso está en un archivo de tu perfil).', code: 'owner_required' }); return false; }
  return true;
}

/**
 * Política del Portal: TODO cambio por la API (POST, PUT, PATCH, DELETE) exige la sesión del propietario, salvo estos,
 * que tienen su propia identificación. Por la ruta registrada (no por la dirección escrita), así que ni mayúsculas, ni
 * barras de más, ni una ruta nueva olvidada se la saltan. Leer no pide nada.
 * - Vincular y desvincular este navegador: el código de un solo uso es la identificación (y exigen JSON y mismo origen).
 * - El puente de los agentes (`/api/bridge/v1/*`, scripts/portal-mcp.mjs): un token por tarea o trabajador, con alcance.
 * - Dos lecturas por POST: la vista previa de un lote y la estimación de un encargo (no guardan nada ni llaman a la IA).
 */
const OPEN_ROUTES: RegExp[] = [/^\/api\/owner\/(pairing|pair|logout)$/, /^\/api\/bridge\/v1\//,
  // Lecturas que se piden por POST (calculan una vista previa con lo que envías; no guardan nada ni llaman a la IA).
  /^\/api\/workspaces\/:slug\/projects\/:projectId\/batches\/preview$/, /^\/api\/workspaces\/:slug\/delegations\/estimate$/];
const CHANGES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const ownerPolicyApplies = (method: string, route: string | undefined) => !!route && route.startsWith('/api/') && CHANGES.has(method) && !OPEN_ROUTES.some(r => r.test(route));
/** Las rutas que cambian algo sin la sesión del propietario (para revisarlas y probarlas). */
export const ownerOpenRoutes = () => OPEN_ROUTES.map(r => r.source);

/** Solo pruebas: olvida el código vigente. */
export function resetPairingForTests() { forgetCode(); }
