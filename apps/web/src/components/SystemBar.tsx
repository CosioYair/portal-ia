import { useEffect, useRef, useState } from 'react';
import type { SystemStatus } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { Icon } from './ui.tsx';

/**
 * Aviso de sincronización del propio Portal: si el código del repositorio cambió desde que arrancó (historias integradas),
 * indica si basta recargar o hace falta reconstruir y reiniciar, y lo hace con tu autorización.
 */
export function SystemBar() {
  const [st, setSt] = useState<SystemStatus | null>(null);
  const [auth, setAuth] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'updating' | 'restarting' | 'stopped' | 'failed'>('idle');
  const [outcome, setOutcome] = useState<SystemStatus['update'] extends infer U ? (U extends { outcome?: infer O } ? O : never) : never>(null);
  const [log, setLog] = useState('');
  const [showLog, setShowLog] = useState(false);
  // HU-164: la barra es una sola línea; los detalles y la confirmación se abren debajo, de uno en uno.
  const [open, setOpen] = useState<'none' | 'details' | 'confirm'>('none');
  const authRef = useRef<HTMLInputElement | null>(null);
  const startedRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try { const s = await api.systemStatus(); if (!alive) return; setSt(s); if (!startedRef.current) startedRef.current = s.startedAt; if (s.update?.status === 'running') { setPhase('updating'); setLog(s.update.log); } else if (s.update?.status === 'failed' && phase === 'updating') { setPhase('failed'); setLog(s.update.log); } }
      catch { /* servidor reiniciando o ausente */ }
      if (alive) setTimeout(tick, phase === 'updating' ? 1500 : 30_000);
    };
    void tick(); const onFocus = () => void tick(); window.addEventListener('focus', onFocus);
    return () => { alive = false; window.removeEventListener('focus', onFocus); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Al abrir la confirmación con «Actualizar», el foco pasa a la casilla obligatoria.
  useEffect(() => { if (open === 'confirm') authRef.current?.focus(); }, [open]);

  const update = async () => {
    setPhase('updating'); setLog(''); setShowLog(true);
    try {
      const r = await api.systemUpdate({ restart: true });
      setOutcome(r.update.outcome ?? null);
      const manual = r.update.outcome?.mode === 'shutdown';
      // Seguir el log hasta que termine; luego esperar al reinicio (startedAt distinto) y recargar — o, sin supervisor, mostrar los comandos.
      let misses = 0;
      for (let i = 0; i < 600; i++) {
        await new Promise(r => setTimeout(r, 1500));
        let s: SystemStatus | null = null; try { s = await api.systemStatus(); misses = 0; } catch { s = null; misses++; }
        if (s?.update?.status === 'running') { setLog(s.update.log); continue; }
        if (s?.update?.status === 'failed') { setLog(s.update.log); setPhase('failed'); return; }
        if (s?.update?.status === 'done' && s.startedAt === startedRef.current) { setLog(s.update.log); setPhase(manual ? 'stopped' : 'restarting'); continue; }
        if (s && s.startedAt !== startedRef.current) { location.reload(); return; }
        if (!s) { setPhase(manual ? 'stopped' : 'restarting'); if (manual && misses >= 2) return; continue; }
      }
    } catch (e: any) { setLog(l => `${l}\n✖ ${e.message}`); setPhase('failed'); }
  };

  if (!st || (st.action === 'none' && phase === 'idle')) return null;
  const restart = st.action === 'restart';
  const toggle = (p: 'details' | 'confirm') => setOpen(o => (o === p ? 'none' : p));
  const busy = phase === 'updating' || phase === 'restarting';
  return (
    <div className="sysbar">
      <div className={`sysbar-line${phase === 'failed' ? ' sysbar-err' : ''}`} role="status" aria-label="Cambios sin activar">
        {busy ? <span className="spin" aria-hidden="true" /> : Icon.warn()}
        <span className="sysbar-text">
          {phase === 'idle' && <strong>Hay cambios sin activar</strong>}
          {phase === 'updating' && 'Reconstruyendo… (puede tardar un par de minutos)'}
          {phase === 'restarting' && 'Reiniciando el Portal… la página se recargará sola.'}
          {phase === 'stopped' && <><strong>El Portal se ha reconstruido y apagado</strong>: arráncalo a mano (comandos en Detalles)</>}
          {phase === 'failed' && <><strong>La actualización falló</strong>: revisa el registro en Detalles</>}
        </span>
        <span className="sysbar-sep" aria-hidden="true">·</span>
        <button className="btn btn-ghost btn-sm" aria-expanded={open === 'details'} onClick={() => toggle('details')}>Detalles</button>
        {phase === 'idle' && <><span className="sysbar-sep" aria-hidden="true">·</span><button className="btn btn-primary btn-sm" aria-expanded={open === 'confirm'} onClick={() => toggle('confirm')}>Actualizar</button></>}
        {phase === 'failed' && <><span className="sysbar-sep" aria-hidden="true">·</span><button className="btn btn-ghost btn-sm" onClick={() => { setAuth(false); setPhase('idle'); setOpen('confirm'); }}>Reintentar</button></>}
      </div>
      {open === 'details' && <div className="sysbar-panel" id="sysbar-details">
        <div>
          <strong>{st.startCommit === st.headCommit ? 'La interfaz servida se construyó con un commit anterior' : 'El código del Portal cambió desde que arrancó'}</strong> ({st.changedFiles.length} archivo(s){st.stories.length ? ` · ${st.stories.join(', ')}` : ''}; servidor {st.startCommit} · interfaz {st.buildCommit ?? '?'} · repositorio {st.headCommit}).{' '}
          {restart ? 'Hace falta reconstruir y reiniciar para que los cambios entren en funcionamiento (hasta entonces las historias integradas no están activas).' : 'Basta reconstruir la interfaz y recargar el navegador.'}
        </div>
        {phase === 'failed' && <span>La actualización falló. Revisa el registro y, si hace falta, ejecuta <span className="mono">npm run build</span> a mano.</span>}
        {phase === 'stopped' && <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span><strong>El Portal se ha reconstruido y apagado</strong> (no corre bajo el supervisor, así que no puede relanzarse solo). Arráncalo desde la carpeta <span className="mono">{outcome?.cwd}</span> con:</span><pre className="mono" style={{ margin: 0, padding: 8, background: '#1A1B1E', color: '#E5E3DC', borderRadius: 8 }}>{(outcome?.commands ?? ['npm start']).join('\n')}</pre><span className="muted">Con <span className="mono">npm start</span> (supervisor incluido desde v0.10) el próximo reinicio será automático.</span></div>}
        {log && <div className="sysbar-actions"><button className="lnk sm13" aria-expanded={showLog} onClick={() => setShowLog(v => !v)}>{showLog ? 'ocultar registro' : 'ver registro'}</button></div>}
        {showLog && log && <pre className="mono" style={{ margin: 0, padding: 10, background: '#1A1B1E', color: '#E5E3DC', borderRadius: 8, fontSize: 11.5, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{log.slice(-6000)}</pre>}
      </div>}
      {open === 'confirm' && phase === 'idle' && <div className="sysbar-panel" id="sysbar-confirm">
        <label className="ck"><input ref={authRef} className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /><span>Autorizo ejecutar <span className="mono">npm install</span> (si cambiaron dependencias), <span className="mono">npm run build</span>{restart ? ' y reiniciar el servidor del Portal' : ''} en la carpeta de esta instalación.</span></label>
        <div className="sysbar-actions">
          <button className="btn btn-primary btn-sm" onClick={update} disabled={!auth}>{Icon.arrow()}{restart ? 'Reconstruir y reiniciar el Portal' : 'Reconstruir y recargar'}</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setOpen('none')}>Cancelar</button>
        </div>
      </div>}
    </div>
  );
}
