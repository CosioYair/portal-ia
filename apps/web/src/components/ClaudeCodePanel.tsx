import { useEffect, useState } from 'react';
import type { ClaudeCodeWorkspaceView, ExecutionBackend } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { fmtUsd } from '../lib/labels.ts';
import { Chip, KV, Notice } from './ui.tsx';

const AUTH: Record<string, string> = {
  'claude.ai': 'Cuenta de Claude (suscripción)', oauth_token: 'Token de suscripción (setup-token)', api_key: 'Clave de API (facturación por uso)',
  api_key_helper: 'apiKeyHelper (facturación por uso)', third_party: 'Proveedor en la nube', none: 'Sin sesión'
};
const BACKENDS: { id: ExecutionBackend; label: string }[] = [
  { id: 'api', label: 'API del proveedor' },
  { id: 'claude-code', label: 'Claude Code (gestionado)' },
  { id: 'claude-code-terminal', label: 'Claude Code (tu consola)' }
];
const RUN: Record<string, string> = { running: 'en curso', done: 'completada', failed: 'fallida', cancelled: 'cancelada', interrupted: 'interrumpida', limit: 'límite de uso', queued: 'en cola' };
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' }) : '—';
/** Argumento de consola entre comillas si lo necesita (rutas con espacios). */
const q = (a: string) => /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;

/**
 * Conector «Claude Code — Local» (Proveedores). Todo cambio con efecto es una autorización explícita del propietario:
 * activar, autorizar proyectos, asignar el backend a un agente, crear una consola o permitir la API como alternativa.
 */
export function ClaudeCodePanel() {
  const { status, projects, flash } = useApp();
  const slug = status.workspace?.slug ?? null;
  const [view, setView] = useState<ClaudeCodeWorkspaceView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [limits, setLimits] = useState<{ maxConcurrent: number; maxDurationMin: number; maxTurns: number; repoRead: boolean; cliPath: string } | null>(null);
  const [workerName, setWorkerName] = useState('Mi consola de Claude Code');
  const [workerAgents, setWorkerAgents] = useState<string[]>([]);
  const [workerConsent, setWorkerConsent] = useState(false);
  const [created, setCreated] = useState<{ token: string; command: string } | null>(null);
  const [smoke, setSmoke] = useState<string | null>(null);

  const load = async () => {
    if (!slug) return;
    const v = await api.claudeCodeWorkspace(slug); setView(v);
    setLimits(l => l ?? { maxConcurrent: v.status.settings.maxConcurrent, maxDurationMin: Math.round(v.status.settings.maxDurationSec / 60), maxTurns: v.status.settings.maxTurns, repoRead: v.status.settings.repoRead, cliPath: v.status.settings.cliPath ?? '' });
  };
  useEffect(() => { void load().catch(() => undefined); const t = setInterval(() => { void load().catch(() => undefined); }, 10_000); return () => clearInterval(t); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);
  const act = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try { await fn(); await load(); if (ok) flash(ok); } catch (e: any) { flash(e.message, 'err'); } finally { setBusy(null); }
  };
  if (!slug || !view || !limits) return null;
  const st = view.status; const d = st.detection; const s = st.settings;
  const tone = st.ready ? 'ok' : s.enabled ? 'warn' : '';
  const authorizedProjects = new Set(view.projects);
  const terminalAgents = view.agents.filter(a => a.backend === 'claude-code-terminal');

  return (
    <section className="card" id="claude-code">
      <div className="card-h">
        <div><div className="h3">Claude Code — Local</div><div className="small muted">Tu instalación de Claude Code como backend de ejecución de agentes concretos, con tu suscripción. Coexiste con las conexiones de API.</div></div>
        <Chip tone={tone} dot={st.ready ? 'ok' : s.enabled ? 'warn' : ''}>{st.ready ? 'Activo' : s.enabled ? 'Bloqueado' : 'Desactivado'}</Chip>
      </div>
      <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <KV k="Instalación">{d ? (d.installed ? `Instalado · v${d.version ?? '?'}` : 'No instalado') : 'Sin comprobar'}</KV>
          {d?.path && <KV k="Ejecutable"><span className="mono small">{d.path}</span></KV>}
          <KV k="Autenticación">{d?.authMethod ? AUTH[d.authMethod] ?? d.authMethod : 'No verificada'}{d?.subscriptionType ? ` · plan ${d.subscriptionType}` : ''}</KV>
          <KV k="Origen de ejecución"><Chip xs tone={d?.billing === 'subscription' ? 'ok' : 'warn'}>{st.sourceLabel}</Chip></KV>
          <KV k="Comprobado">{when(d?.checkedAt ?? null)}</KV>
          {d?.probe && <KV k="Configuración real (sin llamar al modelo)">{d.probe.ok ? `modo restringido · origen de la clave «${d.probe.apiKeySource}» · herramientas: ${d.probe.tools.map(t => t.replace(/^mcp__portal__/, '')).join(', ') || 'ninguna'} · plugins incluidos en Claude Code: ${d.probe.plugins.length}` : `no superada: ${d.probe.problem}`}</KV>}
          <KV k="En curso ahora">{st.running} ejecución(es)</KV>
        </div>
        {d?.problems.map((p, i) => <Notice key={i} kind="warn">{p}</Notice>)}
        <Notice kind="info"><strong>La suscripción no es gratis.</strong> Cada ejecución consume los límites de uso de tu plan de Claude, igual que usar Claude Code a mano. Anthropic indica que el uso de <span className="mono">claude -p</span> cuenta contra esos límites y se reserva cobrar a tus «usage credits» el uso desde herramientas de terceros: si tienes activado el uso adicional, puede haber cargos que el Portal no ve. Revísalo en claude.ai → Ajustes → Uso. El Portal nunca activa uso adicional ni compra créditos, y no inventa la cuota restante.</Notice>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" disabled={busy !== null} onClick={() => act('detect', () => api.claudeCodeDetect(), 'Instalación y sesión comprobadas (sin usar el modelo)')}>{busy === 'detect' ? 'Comprobando…' : 'Comprobar instalación y sesión'}</button>
          {d?.billing === 'subscription' && <button className="btn btn-ghost" disabled={busy !== null} onClick={() => { if (confirm('Prueba de humo: UNA llamada real a tu suscripción (modelo haiku, 1 turno, sin herramientas ni datos del proyecto, texto «Respond with exactly the word OK.»). ¿La autorizas?')) void act('smoke', async () => { const r = await api.claudeCodeSmokeTest(); setSmoke(`Respuesta «${r.answer}» · sesión ${r.authMethod ?? '?'}${r.subscriptionType ? ` (${r.subscriptionType})` : ''} · origen de la clave al arrancar: ${r.apiKeySource ?? 'sin dato'} · ${r.tokensIn + r.tokensOut} tokens · ${Math.round(r.durationMs / 1000)} s · presupuesto de API descontado: ${fmtUsd(r.apiBudgetChargedUsd)}. Comprueba la facturación en claude.ai → Ajustes → Uso y en la consola de la API.`); }, 'Prueba de humo completada'); }}>{busy === 'smoke' ? 'Probando…' : 'Prueba de humo (1 llamada real)'}</button>}
          {s.enabled
            ? <button className="btn btn-ghost" disabled={busy !== null} onClick={() => act('off', () => api.claudeCodeSettings({ enabled: false }), 'Claude Code desactivado: ningún agente se ejecutará con él')}>Desactivar</button>
            : <>
                <label className="krow" style={{ flex: '1 1 320px' }}><input className="cb" type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
                  <span className="small">Autorizo que el Portal ejecute Claude Code con mi suscripción para los agentes y proyectos que autorice, sin herramientas propias y con lectura solo a través del Portal.</span></label>
                <button className="btn btn-primary" disabled={!consent || busy !== null || d?.billing !== 'subscription'} onClick={() => act('on', () => api.claudeCodeSettings({ enabled: true, authorized: true }), 'Claude Code activado')}>Activar</button>
              </>}
        </div>

        {smoke && <Notice kind="ok"><strong>Prueba de humo.</strong> {smoke}</Notice>}
        {s.enabled && <>
          <div className="h3" style={{ fontSize: 14 }}>Límites de ejecución</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: 12 }}>
            <div><label className="label" htmlFor="cc-conc">Ejecuciones a la vez</label><input id="cc-conc" className="input" type="number" min={1} max={4} value={limits.maxConcurrent} onChange={e => setLimits({ ...limits, maxConcurrent: Number(e.target.value) })} /></div>
            <div><label className="label" htmlFor="cc-dur">Duración máxima (min)</label><input id="cc-dur" className="input" type="number" min={1} max={60} value={limits.maxDurationMin} onChange={e => setLimits({ ...limits, maxDurationMin: Number(e.target.value) })} /></div>
            <div><label className="label" htmlFor="cc-turns">Turnos máximos</label><input id="cc-turns" className="input" type="number" min={1} max={50} value={limits.maxTurns} onChange={e => setLimits({ ...limits, maxTurns: Number(e.target.value) })} /></div>
          </div>
          <label className="krow"><input className="cb" type="checkbox" checked={limits.repoRead} onChange={e => setLimits({ ...limits, repoRead: e.target.checked })} />
            <span className="small">Permitir lectura de la carpeta del proceso a través del Portal (solo lectura; sin .env, claves, .git, node_modules ni data/).</span></label>
          <div><label className="label" htmlFor="cc-path">Ruta de la CLI <span className="muted" style={{ fontWeight: 400 }}>· opcional</span></label>
            <input id="cc-path" className="input mono" value={limits.cliPath} onChange={e => setLimits({ ...limits, cliPath: e.target.value })} placeholder="Detección automática" spellCheck={false} /></div>
          <div><button className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => act('limits', () => api.claudeCodeSettings({ maxConcurrent: limits.maxConcurrent, maxDurationSec: limits.maxDurationMin * 60, maxTurns: limits.maxTurns, repoRead: limits.repoRead, cliPath: limits.cliPath.trim() || null }), 'Límites guardados')}>Guardar límites</button></div>

          <div className="h3" style={{ fontSize: 14 }}>Si la suscripción no está disponible</div>
          <label className="krow"><input className="rd" type="radio" name="cc-fb" checked={s.fallback === 'none'} onChange={() => act('fb', () => api.claudeCodeSettings({ fallback: 'none' }), 'Se pausará y esperará tu decisión')} />
            <span className="small"><strong>Pausar y esperar</strong> (recomendado): lo hecho se conserva y el proceso espera a la renovación o a tu decisión.</span></label>
          <label className="krow"><input className="rd" type="radio" name="cc-fb" checked={s.fallback === 'api'} onChange={() => { if (confirm('¿Autorizas que, si Claude Code no está disponible, el agente use la API de su proveedor? Esa llamada se FACTURA y descuenta del presupuesto del proceso.')) void act('fb', () => api.claudeCodeSettings({ fallback: 'api', authorized: true }), 'Alternativa por API autorizada'); }} />
            <span className="small"><strong>Usar la API del agente</strong> (facturable, con el presupuesto del proceso). Solo con tu autorización.</span></label>

          <div className="h3" style={{ fontSize: 14 }}>Proyectos autorizados · {status.workspace?.name}</div>
          {projects.map(p => (
            <label key={p.id} className="krow"><input className="cb" type="checkbox" checked={authorizedProjects.has(p.id)} disabled={busy !== null}
              onChange={e => act('proj', () => api.claudeCodeProjects(slug, e.target.checked ? [...authorizedProjects, p.id] : [...authorizedProjects].filter(x => x !== p.id)), e.target.checked ? `«${p.name}» autorizado para Claude Code` : `«${p.name}» ya no usa Claude Code`)} />
              <span className="small">{p.name}</span></label>
          ))}

          <div className="h3" style={{ fontSize: 14 }}>Agentes</div>
          <div className="help" style={{ marginTop: -8 }}>El backend solo decide dónde se ejecutan los pasos de los procesos autorizados (plan, implementación, correcciones y revisión de QA). La identidad, el papel, los permisos y el historial del agente no cambian. El chat, el backlog y las lecciones siguen usando la API.</div>
          {view.agents.map(a => (
            <div key={a.id} className="krow" style={{ alignItems: 'center' }}>
              <span style={{ flex: 1, minWidth: 0 }} className="small">{a.name}{a.provider !== 'anthropic' && <span className="muted"> · {a.provider} (solo API)</span>}</span>
              <select className="input" style={{ maxWidth: 240 }} value={a.backend} disabled={busy !== null || a.provider !== 'anthropic'} aria-label={`Backend de ${a.name}`}
                onChange={e => { const b = e.target.value as ExecutionBackend; if (b === 'api' || confirm(`¿Autorizas que «${a.name}» ejecute sus pasos con ${b === 'claude-code' ? 'Claude Code gestionado por el Portal' : 'tu consola de Claude Code'} (tu suscripción)?`)) void act('agent', () => api.setAgentBackend(slug, a.id, b), `Backend de ${a.name} actualizado`); }}>
                {BACKENDS.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
            </div>
          ))}

          <div className="h3" style={{ fontSize: 14 }}>Tu consola de Claude Code</div>
          <div className="help" style={{ marginTop: -8 }}>Abre Claude Code como siempre: con el puente del Portal registrado, pide «muéstrame mis tareas del Portal», toma una y entrega el resultado. El Portal valida, aplica en el worktree aislado, verifica en Docker y pasa por QA. Una sola consola puede atender a varios agentes.</div>
          {view.workers.filter(w => !w.revokedAt).map(w => (
            <div key={w.id} className="krow" style={{ alignItems: 'center' }}>
              <Chip xs tone={w.connected ? 'ok' : ''} dot={w.connected ? 'ok' : ''}>{w.connected ? 'Conectada' : 'Desconectada'}</Chip>
              <span className="small" style={{ flex: 1 }}>{w.name} · {w.agentIds.map(id => view.agents.find(a => a.id === id)?.name ?? id).join(', ')} · última señal {when(w.lastSeenAt)} · {w.expired ? <span style={{ color: '#8A2B2B' }}>caducada</span> : `caduca ${when(w.expiresAt)}`}
                {w.clientEnvCredentials.length > 0 && <span style={{ color: '#7A4A00' }}> · tu consola tiene {w.clientEnvCredentials.join(', ')}: podría facturar por API</span>}</span>
              <button className="lnk sm13" onClick={() => { if (confirm(`¿Revocar «${w.name}»? Su token deja de funcionar al instante.`)) void act('rev', () => api.revokeClaudeCodeWorker(slug, w.id), 'Consola revocada'); }}>Revocar</button>
            </div>
          ))}
          {created && <Notice kind="ok"><strong>Consola creada.</strong> Ejecuta estas órdenes en una terminal (el token solo se muestra ahora). El puente queda registrado SOLO en esa carpeta: abre Claude Code allí para atender tareas del Portal; tus otros proyectos no lo ven. Caduca en 30 días.<div className="mono small" style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap', marginTop: 6, userSelect: 'all' }}>{created.command}</div>
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 6 }} onClick={() => { void navigator.clipboard?.writeText(created.command); flash('Orden copiada'); }}>Copiar orden</button></Notice>}
          {terminalAgents.length === 0
            ? <div className="small muted">Para crear una consola, asigna primero «tu consola» como backend de algún agente.</div>
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input className="input" value={workerName} onChange={e => setWorkerName(e.target.value)} aria-label="Nombre de la consola" />
                {terminalAgents.map(a => <label key={a.id} className="krow"><input className="cb" type="checkbox" checked={workerAgents.includes(a.id)} onChange={e => setWorkerAgents(e.target.checked ? [...workerAgents, a.id] : workerAgents.filter(x => x !== a.id))} /><span className="small">{a.name}</span></label>)}
                <label className="krow"><input className="cb" type="checkbox" checked={workerConsent} onChange={e => setWorkerConsent(e.target.checked)} /><span className="small">Autorizo que esta consola reciba las tareas de esos agentes y lea, solo lectura, la carpeta de trabajo de cada tarea.</span></label>
                <div><button className="btn btn-primary btn-sm" disabled={!workerConsent || !workerAgents.length || busy !== null}
                  onClick={() => act('worker', async () => { const r = await api.createClaudeCodeWorker(slug, workerName, workerAgents); setCreated({ token: r.token, command: [`mkdir ${q(r.setup.cwd)}`, `cd ${q(r.setup.cwd)}`, [r.setup.command, ...r.setup.args].map(q).join(' ')].join('\n') }); setWorkerConsent(false); }, 'Consola autorizada')}>Crear consola</button></div>
              </div>}
        </>}

        <div className="h3" style={{ fontSize: 14 }}>Uso de hoy con Claude Code</div>
        <div>
          <KV k="Ejecuciones">{view.usageToday.runs} · {view.usageToday.failed} fallidas · {view.usageToday.limited} por límite de uso</KV>
          <KV k="Tiempo">{Math.round(view.usageToday.durationMs / 1000)} s</KV>
          <KV k="Tokens (informados por Claude Code)">{view.usageToday.tokensIn} entrada · {view.usageToday.tokensOut} salida</KV>
          <KV k="Equivalente por API (estimación, NO es un cargo)">{fmtUsd(view.usageToday.apiEquivalentUsd)}</KV>
          <KV k="Presupuesto de API descontado">{fmtUsd(0)}</KV>
        </div>
        {view.runs.length > 0 && <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflow: 'auto' }}>
          {view.runs.map(r => <div key={r.id} className="small" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span className="mono muted">{when(r.startedAt)}</span><span>{r.agentName}</span><span className="muted">{r.mode === 'cli' ? 'gestionado' : 'consola'} · {RUN[r.status] ?? r.status}</span>
            {r.durationMs != null && <span className="muted">{Math.round(r.durationMs / 1000)} s</span>}{r.tokensIn != null && <span className="muted">{r.tokensIn + (r.tokensOut ?? 0)} tokens</span>}
            {r.apiEquivalentUsd != null && <span className="muted">≈ {fmtUsd(r.apiEquivalentUsd)} equivalente</span>}{r.error && <span style={{ color: '#8A2B2B' }}>{r.error.slice(0, 140)}</span>}
          </div>)}
        </div>}
      </div>
    </section>
  );
}
