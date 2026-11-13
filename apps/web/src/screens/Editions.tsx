import { useCallback, useEffect, useState } from 'react';
import {
  canTransition, isLicenseExpired, EDITION_ACTION_EFFECT, EDITION_ACTION_LABEL, EDITION_STATUS_LABEL, INTERNAL_WORKSPACE,
  type EditionAction, type EditionLicenseStatus, type EditionView
} from '@portal-ia/domain';
import { Chip, Empty, Notice, Spinner } from '../components/ui.tsx';
import { ownerNeeded, ownerToken, setOwnerToken } from '../lib/owner.ts';

/**
 * HU-214 · Ediciones: copias distribuibles del Portal y su licencia local. Solo existen en el núcleo (Estudio).
 * Cada acción abre un diálogo de autorización del propietario y envía `authorized: true`; sin él, el servidor responde 403.
 * En la edición distribuible no se muestra ninguna acción.
 */
const BASE = `/api/workspaces/${encodeURIComponent(INTERNAL_WORKSPACE.slug)}/editions`;

async function call<T>(url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = body !== undefined ? { 'Content-Type': 'application/json' } : {};
  const owner = ownerToken(); if (owner) headers['X-Portal-Owner'] = owner;
  let res: Response;
  try { res = await fetch(url, { method: body !== undefined ? 'POST' : 'GET', headers, body: body !== undefined ? JSON.stringify(body) : undefined }); }
  catch { throw new Error('No se pudo contactar con el servidor del Portal.'); }
  const text = await res.text();
  let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (res.status === 401 && data?.code === 'owner_required') { if (owner) setOwnerToken(null); ownerNeeded(); }
  if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
  return data as T;
}

const STATUS_TONE: Record<EditionLicenseStatus, 'ok' | 'warn' | 'err'> = { active: 'ok', inactive: 'warn', revoked: 'err' };
const ROW_ACTIONS: Exclude<EditionAction, 'generate'>[] = ['renew', 'activate', 'deactivate', 'revoke'];
const fmtDate = (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'; };

interface Pending { action: EditionAction; edition: EditionView | null }

export function Editions() {
  const [phase, setPhase] = useState<'loading' | 'error' | 'ready'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [items, setItems] = useState<EditionView[]>([]);
  const [distributable, setDistributable] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase('loading'); setLoadError(null);
    try {
      const health = await call<{ edition?: string }>('/api/health');
      setDistributable(health?.edition === 'distributable');
      setItems(await call<EditionView[]>(BASE));
      setPhase('ready');
    } catch (e: any) { setLoadError(e?.message ?? 'No se pudieron cargar las ediciones.'); setPhase('error'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) setPending(null); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [pending, busy]);

  const open = (action: EditionAction, edition: EditionView | null) => { setDialogError(null); setDone(null); setPending({ action, edition }); };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true); setDialogError(null);
    try {
      const url = pending.edition ? `${BASE}/${encodeURIComponent(pending.edition.id)}/${pending.action}` : BASE;
      const res = await call<EditionView>(url, { authorized: true });
      setItems(prev => pending.edition ? prev.map(x => x.id === res.id ? res : x) : [res, ...prev]);
      setDone(`${EDITION_ACTION_LABEL[pending.action]}: hecho (edición ${res.version} · ${res.commit.slice(0, 7)}).`);
      setPending(null);
    } catch (e: any) { setDialogError(e?.message ?? 'No se pudo completar la acción.'); }
    finally { setBusy(false); }
  };

  const now = new Date();

  return (
    <main className="page" aria-labelledby="ed-title">
      <header className="page-head">
        <h1 id="ed-title">Ediciones</h1>
        <p className="muted">Copias distribuibles del Portal generadas desde este Estudio, con su versión, su commit y su licencia local.</p>
        {!distributable && phase === 'ready' && (
          <button type="button" className="btn" disabled={busy} onClick={() => open('generate', null)}>
            {busy && pending?.action === 'generate' ? 'Generando…' : EDITION_ACTION_LABEL.generate}
          </button>
        )}
      </header>

      {done && <div role="status"><Notice kind="ok">{done}</Notice></div>}
      {distributable && <Notice kind="info">Esta es la edición distribuible del Portal: aquí no se generan ni se gestionan ediciones. Esas acciones solo existen en la edición Estudio.</Notice>}

      {phase === 'loading' && <Spinner label="Cargando ediciones…" />}
      {phase === 'error' && (
        <div role="alert">
          <Notice kind="err">{loadError}</Notice>
          <button type="button" className="btn btn-sm" onClick={() => void load()}>Reintentar</button>
        </div>
      )}
      {phase === 'ready' && items.length === 0 && (
        <Empty icon={<span aria-hidden="true">▣</span>} title="Aún no hay ediciones" hint={distributable ? 'Las ediciones se generan desde la edición Estudio.' : 'Pulsa «Generar edición» para crear la primera copia distribuible desde el commit actual.'} />
      )}
      {phase === 'ready' && items.length > 0 && (
        <ul className="list" aria-label="Ediciones generadas">
          {items.map(ed => {
            const expired = isLicenseExpired(ed.license, now);
            return (
              <li key={ed.id} className="card">
                <article aria-label={`Edición ${ed.version}, commit ${ed.commit.slice(0, 7)}`}>
                  <h2>Versión {ed.version}</h2>
                  <dl>
                    <dt>Commit</dt><dd><code>{ed.commit.slice(0, 7)}</code></dd>
                    <dt>Licencia</dt>
                    <dd>
                      <code>{ed.license.id}</code>{' '}
                      <Chip tone={STATUS_TONE[ed.license.status]}>{EDITION_STATUS_LABEL[ed.license.status]}</Chip>
                      {expired && ed.license.status !== 'revoked' && <> <Chip tone="warn">Caducada</Chip></>}
                    </dd>
                    <dt>Caduca</dt><dd>{fmtDate(ed.license.expiresAt)}{ed.license.renewals > 0 ? ` · ${ed.license.renewals} renovación(es)` : ''}</dd>
                    <dt>Generada</dt><dd>{fmtDate(ed.createdAt)}</dd>
                  </dl>
                  {!distributable && (
                    <div className="row-actions" role="group" aria-label={`Acciones de la edición ${ed.version}`}>
                      {ROW_ACTIONS.filter(a => canTransition(ed.license.status, a)).map(a => (
                        <button key={a} type="button" className="btn btn-sm" disabled={busy} onClick={() => open(a, ed)}>{EDITION_ACTION_LABEL[a]}</button>
                      ))}
                      {ed.license.status === 'revoked' && <span className="muted">Revocada: no admite más acciones.</span>}
                    </div>
                  )}
                </article>
              </li>
            );
          })}
        </ul>
      )}

      {pending && !distributable && (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="ed-dialog-title" aria-describedby="ed-dialog-desc">
            <h2 id="ed-dialog-title">{EDITION_ACTION_LABEL[pending.action]}{pending.edition ? ` · versión ${pending.edition.version}` : ''}</h2>
            <p id="ed-dialog-desc">{EDITION_ACTION_EFFECT[pending.action]}</p>
            {pending.action === 'generate' && <Notice kind="info">Requisitos: árbol de trabajo sin cambios por confirmar y build de la interfaz del mismo commit. No llama a ningún modelo de IA.</Notice>}
            {pending.action === 'revoke' && <Notice kind="warn">Esta acción es irreversible: la edición no se podrá reactivar ni renovar.</Notice>}
            <p><strong>Autorización del propietario:</strong> al confirmar, autorizas esta acción y queda registrada en el historial.</p>
            {dialogError && <div role="alert"><Notice kind="err">{dialogError}</Notice></div>}
            <div className="row-actions">
              <button type="button" className="btn" disabled={busy} onClick={() => setPending(null)} autoFocus>Cancelar</button>
              <button type="button" className="btn" disabled={busy} onClick={() => void confirm()}>
                {busy ? (pending.action === 'generate' ? 'Generando…' : 'Aplicando…') : `Autorizar y ${EDITION_ACTION_LABEL[pending.action].toLowerCase()}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
