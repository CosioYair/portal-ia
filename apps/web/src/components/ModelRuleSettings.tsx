import { useEffect, useState } from 'react';
import { osApi, type ModelRule } from '../lib/osApi.ts';

/**
 * EN-028 · Regla de modelo de Portal IA: todos los agentes Anthropic de la empresa interna usan el modelo elegido en cada
 * llamada, desde la siguiente (los pasos en curso no cambian). No se aplica a Codex ni a otros proveedores, ni a otras
 * empresas. Activarla o cambiarla pide tu confirmación. Guardar no llama a ninguna IA ni tiene costo.
 */
export function ModelRuleSettings({ slug }: { slug: string }) {
  const [rule, setRule] = useState<ModelRule | null>(null);
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [model, setModel] = useState('');
  const [active, setActive] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<'loading' | 'idle' | 'saving' | 'saved' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  const apply = (r: ModelRule | null) => { setRule(r); setModel(r?.model ?? ''); setActive(r?.active ?? false); };
  useEffect(() => {
    setState('loading');
    void osApi.getModelRule(slug).then(v => { setModels(v.models); apply(v.rule); setState('idle'); }).catch((e: Error) => { setError(e.message); setState('error'); });
  }, [slug]);

  const busy = state === 'loading' || state === 'saving';
  const dirty = model.trim() !== (rule?.model ?? '') || active !== (rule?.active ?? false);
  const valid = model.trim().length > 0;
  const save = () => {
    setConfirming(false); setState('saving'); setError(null);
    osApi.setModelRule(slug, model.trim(), active)
      .then(r => { apply(r.rule); setState('saved'); })
      .catch((e: Error) => { setError(e.message); setState('error'); });
  };
  const known = models.some(m => m.id === model.trim());

  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="regla-modelo-ajustes">
    <p style={{ margin: 0 }}>Con la regla activa, cada llamada de un agente de Portal IA con Claude Code o la API de Anthropic usa este modelo, y los agentes nuevos se crean con él. No se aplica a agentes con Codex o con otro proveedor: su Configuración dice por qué. Al exportar un agente, sale con el modelo predeterminado.</p>
    <p style={{ margin: 0 }}>Estado: <strong>{state === 'loading' ? 'cargando…' : rule?.active ? `activa con «${rule.model}»` : rule ? `desactivada (modelo guardado: «${rule.model}»)` : 'sin regla'}</strong>{rule?.confirmedAt ? <> · confirmada el {new Date(rule.confirmedAt).toLocaleString('es')}</> : null}</p>
    <label htmlFor="regla-modelo">Modelo de la regla</label>
    {models.length
      ? <select id="regla-modelo" className="input" value={known ? model.trim() : ''} disabled={busy} onChange={e => { setModel(e.target.value); if (state === 'saved' || state === 'error') setState('idle'); }}>
          <option value="">Elige un modelo de Anthropic…</option>
          {models.map(m => <option key={m.id} value={m.id}>{m.name} ({m.id})</option>)}
        </select>
      : <input id="regla-modelo" className="input" type="text" value={model} disabled={busy} placeholder="Id del modelo de Anthropic" onChange={e => { setModel(e.target.value); if (state === 'saved' || state === 'error') setState('idle'); }} />}
    {!models.length && state !== 'loading' && <span className="muted">No hay lista de modelos de Anthropic conectada: el id se comprueba al guardar y en cada llamada.</span>}
    {rule && !known && models.length > 0 && rule.model && <span role="alert">El modelo guardado «{rule.model}» no está en la lista de Anthropic: las llamadas fallarán con un aviso y no se usará otro modelo.</span>}
    <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input type="checkbox" checked={active} disabled={busy} onChange={e => { setActive(e.target.checked); if (state === 'saved' || state === 'error') setState('idle'); }} />
      Regla activa
    </label>
    <p role="status" aria-live="polite" style={{ margin: 0 }}>{state === 'loading' ? 'Cargando…' : state === 'saving' ? 'Guardando…' : state === 'saved' ? 'Guardado. Se aplica desde la siguiente llamada.' : state === 'error' ? `Error: ${error ?? 'no se pudo guardar.'}` : null}</p>
    {confirming
      ? <div role="alertdialog" aria-labelledby="regla-modelo-confirmar" className="card" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 12 }}>
          <strong id="regla-modelo-confirmar">{active ? `¿Activar la regla con «${model.trim()}»?` : '¿Guardar la regla desactivada?'}</strong>
          <span>{active ? 'Todos los agentes Anthropic de Portal IA usarán este modelo desde la siguiente llamada. Los pasos en curso no cambian. Los agentes con Codex u otro proveedor y las demás empresas no cambian.' : 'Los agentes volverán a usar su propio modelo desde la siguiente llamada.'} Guardar no tiene costo.</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary btn-sm" onClick={save}>Confirmar</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(false)}>Cancelar</button>
          </div>
        </div>
      : <div><button type="button" className="btn btn-secondary btn-sm" disabled={busy || !valid || !dirty} onClick={() => setConfirming(true)}>{state === 'saving' ? 'Guardando…' : 'Guardar regla…'}</button></div>}
  </div>;
}
