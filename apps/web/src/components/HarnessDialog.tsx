import { useEffect, useState } from 'react';
import { useApp } from '../lib/store.ts';
import { osApi, type CodexDetection, type CodexSettings, type ModelRule, type ModelRuleStatus } from '../lib/osApi.ts';
import { INTERNAL_SLUG } from '../lib/routes.ts';
import { Chip, Notice, Spinner } from './ui.tsx';
import { Modal } from './Modal.tsx';

/**
 * Motores de IA (arneses): cuáles hay y si están disponibles; Codex se comprueba y se habilita aquí (con su autorización).
 * Elegir el motor de UN agente se hace en su panel (Configuración). Se abre desde la Oficina y desde Ajustes.
 */
export function HarnessDialog({ onClose, modelRule }: { onClose: () => void; modelRule?: ModelRuleStatus | null }) {
  const { flash } = useApp();
  // EN-028 · Regla de modelo de Portal IA: aquí solo se lee (se cambia en Ajustes → Regla de modelo, con confirmación).
  const [rule, setRule] = useState<ModelRule | null | undefined>(undefined);
  useEffect(() => { void osApi.getModelRule(INTERNAL_SLUG).then(v => setRule(v.rule)).catch(() => setRule(null)); }, []);
  const ruleOn = !!rule?.active;
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
    {modelRule && <Notice kind={modelRule.applies ? 'ok' : 'warn'}>{modelRule.reason}</Notice>}
    <section className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }} aria-labelledby="model-rule-h">
      <div className="h3" id="model-rule-h">Regla de modelo de Portal IA</div>
      {rule === undefined ? <span className="small muted">Comprobando la regla…</span>
        : ruleOn ? <>
          <span className="small">Activa: los agentes de Portal IA con Claude Code, Claude Code en terminal o la API de Anthropic usan «{rule!.model}» en cada llamada, desde la siguiente.</span>
          <span className="small muted">No se aplica a los agentes con Codex (ChatGPT) ni con OpenAI u otro proveedor que no sea Anthropic: su modelo no cambia. Tampoco a otras empresas.</span>
        </> : <span className="small muted">No está activa: cada agente usa el modelo de su Configuración. Se activa en Ajustes → Regla de modelo de Portal IA.</span>}
    </section>
    {!data ? <Spinner /> : <div className="harness-cards">{data.harnesses.map(h => <div key={h.id} className="harness-card" style={{ cursor: 'default' }}>
      <strong>{h.name}</strong><span className="small muted">{h.vendor} · {h.billing === 'subscription' ? 'tu suscripción' : h.billing === 'api' ? 'API facturable' : 'no verificable'}</span>
      <span className="small">{h.summary}</span>
      <Chip xs tone={h.availability.available ? 'ok' : 'warn'}>{h.availability.available ? 'Disponible' : 'No disponible'}</Chip>
      {h.availability.reason && <span className="small muted">{h.availability.reason}</span>}
      {h.availability.detail && <span className="small mono muted">{h.availability.detail}</span>}
      {ruleOn && h.id === 'codex' && <span className="small muted">La regla de modelo de Portal IA no se aplica a este arnés: usa Codex (ChatGPT), no un modelo de Anthropic.</span>}
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
