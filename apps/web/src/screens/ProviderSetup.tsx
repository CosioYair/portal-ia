import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ProviderId, ProviderView } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { Chip, Icon, KV, Notice, Stepper, Wordmark } from '../components/ui.tsx';
import { ClaudeCodePanel } from '../components/ClaudeCodePanel.tsx';

const CONN: Record<ProviderView['status'], { label: string; tone: '' | 'warn' | 'ok' | 'err'; dot: '' | 'pulse' | 'ok' | 'err' }> = {
  not_configured: { label: 'Sin configurar', tone: '', dot: '' },
  connecting: { label: 'Verificando…', tone: 'warn', dot: 'pulse' },
  connected: { label: 'Conectada', tone: 'ok', dot: 'ok' },
  failed: { label: 'Error de conexión', tone: 'err', dot: 'err' }
};

export function ProviderSetup() {
  const { status, providers, refresh, flash, navigate } = useApp();
  const setupDone = status.initialized;
  const [providerId, setProviderId] = useState<ProviderId>(() => (providers.find(p => p.status === 'connected')?.id ?? providers.find(p => p.credentialHint)?.id ?? 'anthropic'));
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [workspaceId, setWorkspaceId] = useState('');
  const [busy, setBusy] = useState<'save' | 'verify' | 'model' | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const view = useMemo(() => providers.find(p => p.id === providerId)!, [providers, providerId]);
  const uiStatus: ProviderView['status'] = busy === 'verify' ? 'connecting' : view.status;
  const ui = CONN[uiStatus];

  useEffect(() => { setKey(''); setLocalError(null); setWorkspaceId(providers.find(p => p.id === providerId)?.workspaceId ?? ''); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  const verify = async () => {
    setLocalError(null); setBusy('verify');
    try {
      const wsId = providerId === 'anthropic' ? (workspaceId.trim() || null) : null;
      if (key.trim()) { await api.saveCredential(providerId, key.trim(), wsId); setKey(''); }
      else if (!view.credentialHint) { setLocalError('Introduce una clave de API.'); setBusy(null); return; }
      else if (wsId !== (view.workspaceId ?? null)) await api.saveProviderSettings(providerId, wsId);
      const v = await api.verify(providerId);
      await refresh();
      if (v.status === 'connected') flash(`Conexión con ${v.name} verificada · ${v.models.length} modelos disponibles`);
    } catch (e: any) { setLocalError(e.message); }
    finally { setBusy(null); }
  };

  const pickModel = async (modelId: string) => {
    setBusy('model');
    try { await api.setDefaultModel(providerId, modelId); await refresh(); } catch (e: any) { setLocalError(e.message); } finally { setBusy(null); }
  };

  const forget = async () => {
    if (!confirm(`¿Eliminar la credencial guardada de ${view.name}? Tendrás que introducir una nueva para volver a conectar.`)) return;
    await api.deleteCredential(providerId); await refresh(); flash('Credencial eliminada de este equipo');
  };

  const canContinue = view.status === 'connected' && !!view.defaultModel;
  const timeline = [
    { label: 'Proveedor seleccionado', cls: 'is-done', meta: view.name },
    { label: 'Credencial guardada (cifrada)', cls: view.credentialHint || key ? 'is-done' : '', meta: view.credentialHint ?? (key ? 'pendiente de guardar' : 'pendiente') },
    { label: 'Conexión verificada', cls: uiStatus === 'connected' ? 'is-done' : uiStatus === 'failed' ? 'is-fail' : uiStatus === 'connecting' ? 'is-run' : '', meta: uiStatus === 'connected' ? `ok · ${new Date(view.verifiedAt!).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}` : uiStatus === 'failed' ? (view.lastError?.httpStatus ? String(view.lastError.httpStatus) : 'error') : uiStatus === 'connecting' ? 'en curso' : 'pendiente' },
    { label: 'Modelo predeterminado', cls: view.defaultModel ? 'is-done' : '', meta: view.models.find(m => m.id === view.defaultModel)?.short ?? 'pendiente' }
  ];

  return (
    <div className="screen setup">
      <header className="setup-top">
        <Wordmark />
        {setupDone ? <Link className="btn btn-ghost btn-sm" to="/panel">Volver al panel</Link> : <Stepper s1="is-active" s2="" s3="" />}
        <div className="muted small mono">consumo de IA en este paso · 0 tokens</div>
      </header>
      <main className="setup-main" style={{ display: 'flex', flexWrap: 'wrap', gap: 24, maxWidth: 1200, alignItems: 'flex-start', paddingTop: 40 }}>
        <div style={{ flex: '999 1 520px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="eyebrow">{setupDone ? 'Proveedores de IA' : 'Paso 1 de 3'}</div>
            <h1 className="h1" style={{ fontSize: 28 }}>Conecta un proveedor de IA</h1>
            <p className="med">Portal IA necesita al menos un proveedor para que los agentes puedan trabajar. La conexión se verifica con una sola solicitud y no inicia ningún proceso.</p>
          </div>

          <section className="card">
            <div className="card-h"><div><div className="h3">Proveedor</div><div className="small muted">Elige con qué proveedor conectarás este espacio. Puedes conectar varios.</div></div></div>
            <div className="card-b" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(230px, 100%), 1fr))', gap: 12 }}>
              {providers.map(p => (
                <button key={p.id} className={`pcard ${p.id === providerId ? 'is-selected' : ''}`} onClick={() => setProviderId(p.id)} aria-pressed={p.id === providerId}>
                  <span className="plogo mono">{p.name[0]}</span>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, paddingRight: 20 }}>
                    <span style={{ fontWeight: 600 }}>{p.name}</span>
                    <span className="small muted">{p.id === 'anthropic' ? 'Modelos Claude a través de la API de Anthropic.' : 'Modelos GPT a través de la API de OpenAI.'}</span>
                    {p.status === 'connected' && <Chip tone="ok" xs dot="ok" className="small" >conectado</Chip>}
                  </span>
                  <span className="pcheck">{Icon.check(12)}</span>
                </button>
              ))}
              <button className="pcard" disabled>
                <span className="plogo mono" style={{ background: 'transparent', border: '1px dashed #CFCCC3' }}>+</span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}><span style={{ fontWeight: 600 }}>Otro proveedor</span><span className="small muted">Disponible más adelante gracias a los adaptadores independientes del proveedor.</span></span>
              </button>
            </div>
          </section>

          <section className="card">
            <div className="card-h">
              <div><div className="h3">Credencial de {view.name}</div><div className="small muted">Clave de API creada en {view.consoleHost}.</div></div>
              <Chip tone={ui.tone} dot={ui.dot}>{ui.label}</Chip>
            </div>
            <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <label className="label" htmlFor="api-key">Clave de API</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input id="api-key" className="input mono" type={showKey ? 'text' : 'password'} value={key} onChange={e => setKey(e.target.value)}
                    placeholder={view.credentialHint ? `Guardada: ${view.credentialHint} · escribe otra para sustituirla` : view.keyHint} autoComplete="off" spellCheck={false} style={{ flex: 1 }} />
                  <button className="btn btn-secondary" onClick={() => setShowKey(s => !s)} aria-pressed={showKey}>{showKey ? 'Ocultar' : 'Mostrar'}</button>
                </div>
                <div className="help">Una suscripción de consumo (por ejemplo Claude.ai o ChatGPT) no incluye acceso a la API. Necesitas una clave creada en la consola de desarrolladores del proveedor; su uso se factura aparte.</div>
              </div>
              {providerId === 'anthropic' && (
                <div>
                  <label className="label" htmlFor="ws-id">ID del workspace de Anthropic <span className="muted" style={{ fontWeight: 400 }}>· opcional</span></label>
                  <input id="ws-id" className="input mono" value={workspaceId} onChange={e => setWorkspaceId(e.target.value)} placeholder="wrkspc_…" autoComplete="off" spellCheck={false} />
                  {workspaceId.trim() && !/^wrkspc_/.test(workspaceId.trim()) && <div className="help" style={{ color: '#7A4A00' }}>Ese valor no parece un ID de workspace: debe empezar por <span className="mono">wrkspc_</span>. El identificador con guiones de la URL de la consola no sirve.</div>}
                  <div className="help">Solo necesario si tu clave no está asociada a un workspace (por ejemplo, claves de usuario <span className="mono">sk-ant-usr-…</span>). Lo encuentras en console.anthropic.com → Settings → Workspaces. Las claves creadas dentro de un workspace (<span className="mono">sk-ant-api03-…</span>) no lo necesitan.</div>
                </div>
              )}
              <Notice kind="info"><strong>Almacenamiento seguro.</strong> La clave se cifra (AES-256-GCM) y se guarda únicamente en este equipo. Solo se envía al proveedor seleccionado para autenticar las solicitudes; nunca a terceros ni a servidores de Portal IA, y nunca vuelve a mostrarse completa.</Notice>
              {(localError || (view.status === 'failed' && view.lastError && busy !== 'verify')) && (
                <Notice kind="err"><strong>No se pudo verificar la conexión.</strong> {localError ?? view.lastError!.message} {view.lastError?.code === 'invalid_key' && 'Comprueba la clave y vuelve a intentarlo.'}</Notice>
              )}
              {view.status === 'connected' && busy !== 'verify' && <Notice kind="ok"><strong>Conexión verificada.</strong> Se consultó la lista de modelos disponibles ({view.models.length}). No se ejecutó ninguna generación ni se inició ningún agente.</Notice>}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div>{view.credentialHint && <button className="lnk sm13" onClick={forget}>Eliminar credencial guardada</button>}</div>
                <button className="btn btn-primary" onClick={verify} disabled={busy !== null || (!key.trim() && !view.credentialHint)}>
                  {busy === 'verify' && <span className="spin spin-light" aria-hidden="true" />}
                  {busy === 'verify' ? 'Verificando conexión…' : view.status === 'connected' ? (key.trim() ? 'Guardar y verificar' : 'Verificar de nuevo') : view.status === 'failed' ? 'Reintentar verificación' : 'Verificar conexión'}
                </button>
              </div>
            </div>
          </section>

          {view.status === 'connected' && (
            <section className="card">
              <div className="card-h">
                <div><div className="h3">Modelo predeterminado</div><div className="small muted">Valor inicial del espacio. Cada agente podrá tener su propio modelo y esfuerzo.</div></div>
                <Chip xs className="mono">{view.models.length} modelos · lista del proveedor</Chip>
              </div>
              <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 420, overflow: 'auto' }}>
                {view.models.map(m => (
                  <label key={m.id} className={`mrow ${m.id === view.defaultModel ? 'is-selected' : ''}`}>
                    <input className="rd" type="radio" name="default-model" value={m.id} checked={m.id === view.defaultModel} onChange={() => pickModel(m.id)} disabled={busy === 'model'} />
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}><span style={{ fontWeight: 600 }}>{m.name}</span><span className="mono small muted">{m.id}</span></span>
                      <span className="small muted">{m.description}</span>
                    </span>
                    <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      {m.supportsEffort && <Chip xs>razonamiento ajustable</Chip>}
                      <span className="cost" role="img" aria-label={`Costo relativo ${m.relativeCost} de 3`}>{[1, 2, 3].map(n => <span key={n} className={`cb1 ${m.relativeCost >= n ? 'on' : ''}`} />)}</span>
                    </span>
                  </label>
                ))}
              </div>
            </section>
          )}

          {setupDone && <ClaudeCodePanel />}

          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <Link className="btn btn-ghost" to={setupDone ? '/panel' : '/'}>{setupDone ? 'Cancelar' : 'Atrás'}</Link>
            <button className="btn btn-primary" disabled={!canContinue} onClick={() => navigate(setupDone ? '/panel' : '/configuracion/inicializar')}>
              {setupDone ? 'Volver al panel' : 'Continuar · Inicializar espacio interno'}
            </button>
          </div>
        </div>

        <aside style={{ flex: '1 1 300px', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card"><div className="card-h"><div className="h3">Estado de la conexión</div></div>
            <div className="card-b" style={{ padding: '6px 18px' }}><ul className="tl">
              {timeline.map(t => <li key={t.label} className={`tl-i ${t.cls}`}><span className="tl-dot" /><span style={{ flex: 1 }}>{t.label}</span><span className="mono small muted">{t.meta}</span></li>)}
            </ul></div></div>
          <div className="card card-b" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="h3">Qué hace la verificación</div>
            <p className="sm13 med" style={{ lineHeight: 1.5 }}>Una única solicitud al proveedor para comprobar la credencial y obtener los modelos disponibles. No genera texto, no crea agentes y no inicia ningún proceso.</p>
            <KV k="Llamadas a la API">1 · listado de modelos</KV>
            <KV k="Generación de texto">ninguna</KV>
          </div>
          <div className="card card-b" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="h3">Independiente del proveedor</div>
            <p className="sm13 med" style={{ lineHeight: 1.5 }}>Portal IA usa un adaptador por proveedor. Puedes conectar varios y asignar modelos distintos a cada agente.</p>
          </div>
        </aside>
      </main>
    </div>
  );
}
