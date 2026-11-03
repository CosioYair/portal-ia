import { useEffect, useState } from 'react';
import { useApp } from '../lib/store.ts';
import { osApi, type CodexDetection, type CodexSettings } from '../lib/osApi.ts';
import { Chip, Notice, Spinner } from './ui.tsx';
import { Modal } from './Modal.tsx';

/**
 * Motores de IA (arneses): cuáles hay y si están disponibles; Codex se comprueba y se habilita aquí (con su autorización).
 * Elegir el motor de UN agente se hace en su panel (Configuración). Se abre desde la Oficina y desde Ajustes.
 */
export function HarnessDialog({ onClose }: { onClose: () => void }) {
  const { flash } = useApp();
  const [data, setData] = useState<{ harnesses: any[]; codex: { settings: CodexSettings; detection: CodexDetection | null } } | null>(null);
  const [busy, setBusy] = useState(false); const [auth, setAuth] = useState(false); const [error, setError] = useState<string | null>(null);
  const load = () => osApi.harnesses().then(setData).catch(e => setError(e.message));
  useEffect(() => { void load(); }, []);
  const detect = async () => { setBusy(true); setError(null); try { await osApi.detectCodex(); await load(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const toggle = async (enabled: boolean) => { setBusy(true); setError(null); try { await osApi.setCodex(enabled); await load(); flash(enabled ? 'Codex habilitado' : 'Codex deshabilitado'); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const det = data?.codex.detection;
  return <Modal title="Motores de IA (arneses)" wide onClose={onClose} footer={<button className="btn btn-primary" onClick={onClose}>Cerrar</button>}>
    <p className="small muted">Un motor de IA (arnés) es <strong>cómo</strong> trabaja un agente; no es el agente. El de cada agente se elige en su panel › Ajustes. Su identidad, instrucciones, habilidades y memoria son tuyas y se conservan al cambiar de arnés.</p>
    {error && <Notice kind="err">{error}</Notice>}
    {!data ? <Spinner /> : <div className="harness-cards">{data.harnesses.map(h => <div key={h.id} className="harness-card" style={{ cursor: 'default' }}>
      <strong>{h.name}</strong><span className="small muted">{h.vendor} · {h.billing === 'subscription' ? 'tu suscripción' : h.billing === 'api' ? 'API facturable' : 'no verificable'}</span>
      <span className="small">{h.summary}</span>
      <Chip xs tone={h.availability.available ? 'ok' : 'warn'}>{h.availability.available ? 'Disponible' : 'No disponible'}</Chip>
      {h.availability.reason && <span className="small muted">{h.availability.reason}</span>}
      {h.availability.detail && <span className="small mono muted">{h.availability.detail}</span>}
    </div>)}</div>}
    <section className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }} aria-labelledby="codex-h">
      <div className="h3" id="codex-h">Codex</div>
      {det ? <>
        <div className="small">{det.installed ? `Codex ${det.version ?? ''} · ${det.auth === 'chatgpt' ? 'sesión de ChatGPT' : det.auth === 'api_key' ? 'clave de API (facturable)' : 'sin sesión'}` : 'No instalado'} · comprobado {new Date(det.checkedAt).toLocaleString('es-MX')}</div>
        {det.exposedTools && <div className="small">Herramientas que expondría (comprobado sin llamar al modelo): {det.exposedTools.length ? det.exposedTools.join(', ') : 'ninguna'}</div>}
        {det.problems.map((p, i) => <Notice key={i} kind="warn">{p}</Notice>)}
        {det.restricted && det.billing === 'subscription' && <Notice kind="ok">Modo restringido verificado: sin herramientas, sin claves, carpeta vacía.</Notice>}
      </> : <p className="small muted">Aún no se ha comprobado. La comprobación no llama al modelo.</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void detect()}>{busy ? 'Comprobando…' : 'Comprobar Codex'}</button>
        {data?.codex.settings.enabled ? <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void toggle(false)}>Deshabilitar Codex</button>
          : <><label className="ck small"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} disabled={!det?.restricted} /> Autorizo que los agentes que yo elija trabajen con Codex y mi sesión de ChatGPT</label>
            <button className="btn btn-primary btn-sm" disabled={busy || !auth || !det?.restricted || det.billing !== 'subscription'} onClick={() => void toggle(true)}>Habilitar Codex</button></>}
      </div>
    </section>
  </Modal>;
}
