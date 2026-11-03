import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import { OWNER_NEEDED, ownerNeeded, onOwnerChange, ownerToken, setOwnerToken } from '../lib/owner.ts';
import { useApp } from '../lib/store.ts';
import { Modal } from './Modal.tsx';
import { Icon, Notice } from './ui.tsx';

/**
 * Estado del propietario compartido por toda la página (una sola consulta, no una por tarjeta). Sin conexión no se da por
 * cerrada la sesión: se mantiene lo último sabido y se reintenta.
 */
interface OwnerInfo { owner: boolean | null; file: string | null }
let info: OwnerInfo = { owner: ownerToken() ? null : false, file: null };
let loaded = false; let inflight = false; let again = false; let retry: number | null = null;
const subs = new Set<() => void>();
const set = (p: Partial<OwnerInfo>) => { info = { ...info, ...p }; subs.forEach(f => f()); };
function refresh() {
  if (inflight) { again = true; return; }
  inflight = true; loaded = true;
  if (!ownerToken()) set({ owner: false });
  api.ownerSession()
    .then(s => { if (!s.owner && ownerToken()) setOwnerToken(null); set({ owner: s.owner, file: s.file }); })
    .catch(() => { if (retry === null) retry = window.setTimeout(() => { retry = null; refresh(); }, 5000); })
    .finally(() => { inflight = false; if (again) { again = false; refresh(); } });
}
onOwnerChange(refresh);

function useOwnerInfo(): OwnerInfo {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force(n => n + 1); subs.add(f); if (!loaded) refresh(); return () => { subs.delete(f); }; }, []);
  return info;
}
/** ¿Este navegador está vinculado como propietario? null mientras se comprueba. */
export function useOwner(): boolean | null { return useOwnerInfo().owner; }

/** La interfaz de desarrollo (Vite, puerto 5173) no puede vincular ni hacer cambios: el servidor solo los acepta en su dirección. */
const DEV_UI = import.meta.env.DEV;

const SYM = '[A-HJ-NP-Z2-9]';
// Sin límites de palabra: un campo de una línea quita los saltos de lo pegado y el código queda pegado al texto de alrededor.
const GROUPED = new RegExp(`${SYM}{4}(?:-${SYM}{4}){4}`);
const RAW = new RegExp(`^${SYM}{20}$`);
/** Lo pegado del archivo o de la ventana (con el texto de alrededor, espacios, sin guiones o en minúsculas) queda como el código. */
function cleanCode(v: string): string {
  const up = v.toUpperCase(); const m = up.match(GROUPED);
  if (m) return m[0];
  const raw = up.replace(/[\s-]/g, '');
  return RAW.test(raw) ? raw.match(/.{4}/g)!.join('-') : v;
}

/**
 * Vincular este navegador como propietario: el Portal genera un código de un solo uso y lo deja en un archivo de tu perfil
 * y en la ventana donde lo arrancaste (nunca en esta página); al pegarlo, este navegador puede hacer cambios.
 */
export function OwnerPairing({ id: given, onPaired }: { id?: string; onPaired?: () => void }) {
  const { file } = useOwnerInfo();
  const [asked, setAsked] = useState<{ file: string | null; problem: string | null } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const auto = useId(); const id = given ?? auto;
  const where = asked ? asked.file : file;
  const focusCode = () => requestAnimationFrame(() => { const el = document.getElementById(`${id}-code`) as HTMLInputElement | null; el?.focus(); el?.select(); });
  const ask = async () => {
    setBusy(true); setError(null);
    try { const r = await api.requestOwnerCode(); setAsked({ file: r.file, problem: r.problem }); focusCode(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const pair = async () => {
    if (!code.trim()) { setError('Pega el código.'); focusCode(); return; }
    setBusy(true); setError(null);
    try { const r = await api.pairOwner(code); setOwnerToken(r.token); setCode(''); onPaired?.(); }
    catch (e: any) { setError(e.message); focusCode(); } finally { setBusy(false); }
  };
  const copy = async () => { if (!where) return; try { await navigator.clipboard.writeText(where); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { /* sin portapapeles: la ruta se ve escrita */ } };
  if (DEV_UI) return <Notice kind="info">En la interfaz de desarrollo (puerto 5173) no se pueden hacer cambios ni vincular este navegador: abre el Portal en <span className="mono">http://127.0.0.1:4310</span>.</Notice>;
  return <div id={id} className="owner-pair" role="group" aria-labelledby={`${id}-h`} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <div id={`${id}-h`} className="small">Así nadie más (otro programa o página de este equipo) puede hacer cambios en tu nombre. El código es de un solo uso, vale 5 minutos y nunca aparece en esta página; la vinculación dura 7 días desde el último uso.</div>
    <ol className="small" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <li><button id={`${id}-gen`} type="button" className={asked ? 'btn btn-ghost btn-sm' : 'btn btn-primary btn-sm'} disabled={busy} onClick={() => void ask()}>{busy && !asked ? <span className="spin spin-light" /> : Icon.shield()}{asked ? 'Generar el código otra vez' : 'Generar un código'}</button></li>
      <li>Abre el archivo {where ? <><span className="mono" style={{ wordBreak: 'break-all' }}>{where}</span> <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy()}>{copied ? 'Ruta copiada' : 'Copiar ruta'}</button></> : 'que se indica al generarlo'} (Win+R, pega la ruta e Intro) y copia el código. Si tienes a la vista la ventana donde arrancaste el Portal (<span className="mono">npm start</span>), también aparece allí.</li>
      <li>Pégalo aquí y pulsa «Vincular».</li>
    </ol>
    {asked?.problem && <Notice kind="warn">{asked.problem}</Notice>}
    <form style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }} onSubmit={e => { e.preventDefault(); void pair(); }}>
      <label className="small" htmlFor={`${id}-code`}>Código</label>
      <input id={`${id}-code`} className="input mono" style={{ width: 290, maxWidth: '100%', textTransform: 'uppercase' }} value={code} maxLength={200} autoComplete="one-time-code" spellCheck={false} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" aria-invalid={!!error || undefined} aria-describedby={error ? `${id}-err` : undefined} onChange={e => setCode(cleanCode(e.target.value))} />
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !asked}>{busy && asked ? <span className="spin spin-light" /> : null}Vincular</button>
    </form>
    {error && <div id={`${id}-err`} role="alert"><Notice kind="warn">{error}</Notice></div>}
  </div>;
}

/**
 * Diálogo para vincular, por encima de todo (también de otro diálogo abierto): lo abre cualquier acción que pida la sesión
 * del propietario (401) o el aviso «Vincular este navegador». Al cerrarlo o vincular, el foco vuelve a donde estaba (la
 * acción que querías hacer).
 */
export function OwnerDialogHost() {
  const owner = useOwner(); const { flash } = useApp();
  const [open, setOpen] = useState(false);
  // El último control usado fuera de este diálogo (el que pidió la sesión): al cerrar o vincular, el foco vuelve a él.
  const last = useRef<HTMLElement | null>(null);
  useEffect(() => { const f = (e: FocusEvent) => { const t = e.target as HTMLElement | null; if (t && t !== document.body && !t.closest('.owner-pair, [aria-label="Vincular este navegador como propietario"]')) last.current = t; }; document.addEventListener('focusin', f); return () => document.removeEventListener('focusin', f); }, []);
  useEffect(() => { const f = () => { if (info.owner !== true) setOpen(true); }; window.addEventListener(OWNER_NEEDED, f); return () => window.removeEventListener(OWNER_NEEDED, f); }, []);
  useEffect(() => { if (owner === true) setOpen(false); }, [owner]);
  const close = () => {
    setOpen(false);
    window.setTimeout(() => { const el = last.current; (el?.isConnected && !el.matches(':disabled') ? el : document.getElementById('contenido') ?? document.querySelector<HTMLElement>('main h1, main'))?.focus(); }, 0);
  };
  if (!open) return null;
  return <Modal title="Vincular este navegador como propietario" onClose={close} footer={<button type="button" className="btn btn-ghost" onClick={close}>Cerrar</button>}>
    <OwnerPairing id="owner-pair" onPaired={() => { close(); flash('Navegador vinculado: vuelve a pulsar la acción que querías hacer.'); }} />
  </Modal>;
}

/** Aviso permanente (en todas las pantallas) mientras este navegador no está vinculado: se puede consultar todo, cambiar no. */
export function OwnerBar() {
  const owner = useOwner();
  if (owner !== false) return null;
  return <div id="owner-bar" className="owner-bar" role="region" aria-label="Propietario de este navegador">
    {Icon.lock()}{DEV_UI ? <span>Interfaz de desarrollo: solo lectura. Para hacer cambios, abre el Portal en http://127.0.0.1:4310.</span> : <>
      <span className="owner-bar-long">Este navegador no está vinculado como propietario: puedes consultarlo todo, pero para hacer cambios (autorizar, integrar, cerrar, configurar…) vincúlalo con un código de un solo uso.</span>
      <span className="owner-bar-short">Solo lectura: vincula este navegador para hacer cambios.</span></>}
    {!DEV_UI && <button type="button" className="btn btn-primary btn-sm" onClick={() => ownerNeeded()}>Vincular este navegador</button>}
  </div>;
}

/** Vinculado: desvincular este navegador o todos (p. ej. si sospechas de otra copia). Dice el resultado y deja el foco a la vista. */
export function OwnerStatus() {
  const { flash } = useApp();
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const out = async (all: boolean) => {
    setBusy(true); setError(null);
    try {
      if (all) { const r = await api.ownerLogoutAll(); flash(`Sesiones cerradas: ${r.closed}. Para hacer cambios, vuelve a vincular este navegador.`); }
      else { await api.ownerLogout(); flash('Este navegador ya no está vinculado como propietario.'); }
      setOwnerToken(null); requestAnimationFrame(() => document.getElementById('owner-bar')?.querySelector<HTMLElement>('button')?.focus());
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void out(false)}>Desvincular este navegador</button>
    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void out(true)}>Desvincular todos los navegadores (también este)</button>
    {error && <div role="alert" style={{ width: '100%' }}><Notice kind="err">{error}</Notice></div>}
  </div>;
}
