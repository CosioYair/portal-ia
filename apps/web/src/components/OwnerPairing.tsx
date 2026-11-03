import { useEffect, useId, useState } from 'react';
import { api } from '../lib/api.ts';
import { onOwnerChange, ownerToken, setOwnerToken } from '../lib/owner.ts';
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
 * y en la ventana donde lo arrancaste (nunca en esta página); al pegarlo, este navegador puede decidir revisiones y
 * operaciones del Asistente.
 */
export function OwnerPairing({ what, compact = false, id: given, onPaired }: { what: string; compact?: boolean; id?: string; onPaired?: () => void }) {
  const { file } = useOwnerInfo();
  const [asked, setAsked] = useState<{ file: string | null; problem: string | null } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const auto = useId(); const id = given ?? auto;
  const where = asked ? asked.file : file;
  const ask = async () => {
    setBusy(true); setError(null);
    try { const r = await api.requestOwnerCode(); setAsked({ file: r.file, problem: r.problem }); requestAnimationFrame(() => (document.getElementById(`${id}-code`) as HTMLInputElement | null)?.focus()); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const pair = async () => {
    if (!code.trim()) { setError('Pega el código.'); return; }
    setBusy(true); setError(null);
    try { const r = await api.pairOwner(code); setOwnerToken(r.token); setCode(''); onPaired?.(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const copy = async () => { if (!where) return; try { await navigator.clipboard.writeText(where); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { /* sin portapapeles: la ruta se ve escrita */ } };
  return <div id={id} className="owner-pair" role="group" aria-labelledby={`${id}-h`} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: compact ? 8 : 12, border: '1px solid var(--color-divider)', borderRadius: 8, background: 'var(--color-surface-alt)' }}>
    <div id={`${id}-h`} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>{Icon.lock()}<strong className={compact ? 'small' : undefined}>Vincula este navegador como propietario para {what}</strong></div>
    <div className="small">Así nadie más (otro programa o página de este equipo) puede decidir en tu nombre. Se hace una vez por navegador: el Portal genera un código de un solo uso (válido 5 minutos) que nunca aparece en esta página.</div>
    <ol className="small" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <li>Pulsa «Generar un código».</li>
      <li>Ábrelo en el archivo {where ? <><span className="mono" style={{ wordBreak: 'break-all' }}>{where}</span> <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy()}>{copied ? 'Ruta copiada' : 'Copiar ruta'}</button></> : 'que se indica al generarlo'} (pega la ruta en Inicio › Ejecutar, Win+R) o, si sigue abierta, en la ventana donde arrancaste el Portal (<span className="mono">npm start</span>).</li>
      <li>Cópialo y pégalo aquí (o escríbelo) y pulsa «Vincular».</li>
    </ol>
    {asked?.problem && <Notice kind="warn">{asked.problem}</Notice>}
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <button type="button" className={asked ? 'btn btn-ghost btn-sm' : 'btn btn-secondary btn-sm'} disabled={busy} onClick={() => void ask()}>{busy && !asked ? <span className="spin" /> : Icon.shield()}{asked ? 'Generar o mostrar otra vez' : 'Generar un código'}</button>
    </div>
    {asked && <form style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }} onSubmit={e => { e.preventDefault(); void pair(); }}>
      <label className="small" htmlFor={`${id}-code`}>Código</label>
      <input id={`${id}-code`} className="input mono" style={{ width: 290, maxWidth: '100%', textTransform: 'uppercase' }} value={code} maxLength={200} autoComplete="one-time-code" spellCheck={false} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" aria-invalid={!!error || undefined} aria-describedby={error ? `${id}-err` : undefined} onChange={e => setCode(cleanCode(e.target.value))} />
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? <span className="spin spin-light" /> : null}Vincular</button>
    </form>}
    {error && <div id={`${id}-err`} role="alert"><Notice kind="warn">{error}</Notice></div>}
  </div>;
}

/** Vinculado: dilo y permite desvincular este navegador o cerrar todas las sesiones (p. ej. si sospechas de otra copia). */
export function OwnerStatus() {
  const [busy, setBusy] = useState(false);
  const out = async (all: boolean) => { setBusy(true); try { await (all ? api.ownerLogoutAll() : api.ownerLogout()); } catch { /* aunque falle, este navegador la olvida */ } setOwnerToken(null); setBusy(false); };
  return <div className="small muted" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>{Icon.shield()}<span>Este navegador está vinculado como propietario.</span>
    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void out(false)}>Desvincular</button>
    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void out(true)}>Cerrar todas las sesiones</button></div>;
}
