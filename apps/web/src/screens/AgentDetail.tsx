import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Agent, AgentConfig, ClaudeCodeStatusView, ExecutionBackend, ProviderId } from '@portal-ia/domain';
import { backendLabel, CAPABILITIES, KNOWLEDGE, TOOLS } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { EFFORT_LABELS, KNOWLEDGE_LABELS, TOOL_LABELS, fmtUsd } from '../lib/labels.ts';
import { Shell } from '../components/Shell.tsx';
import { Avatar, Chip, Icon, KV, Notice } from '../components/ui.tsx';

export function AgentDetail() {
  const { agentId } = useParams();
  const { status, providers, flash, navigate } = useApp();
  const ws = status.workspace!;
  const [agents, setAgents] = useState<Agent[]>([]);
  const [draft, setDraft] = useState<AgentConfig | null>(null);
  const [newResp, setNewResp] = useState('');
  const [saving, setSaving] = useState(false);
  const [cc, setCc] = useState<ClaudeCodeStatusView | null>(null);
  const [backendPick, setBackendPick] = useState<ExecutionBackend | null>(null);
  useEffect(() => { api.claudeCode().then(setCc).catch(() => setCc(null)); }, []);
  useEffect(() => { setBackendPick(null); }, [agentId]);
  const [agentCc, setAgentCc] = useState<Awaited<ReturnType<typeof api.agentClaudeCode>> | null>(null);
  useEffect(() => { if (agentId) api.agentClaudeCode(ws.slug, agentId).then(setAgentCc).catch(() => setAgentCc(null)); }, [agentId, ws.slug]);

  const load = () => api.agents(ws.slug).then(list => setAgents(list.filter(a => a.scope === 'workspace' || a.projectId === status.project?.id)));
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.slug]);
  useEffect(() => { setDraft(null); setNewResp(''); }, [agentId]);
  const [stats, setStats] = useState<{ steps: number; done: number; failed: number; costUsd: number; byRole: Record<string, number>; lastAt: string | null } | null>(null);
  useEffect(() => { if (agentId) api.agentStats(ws.slug, agentId).then(setStats).catch(() => setStats(null)); }, [agentId, ws.slug]);
  const [tpl, setTpl] = useState<Awaited<ReturnType<typeof api.agentTemplate>> | null>(null);
  const [tplTo, setTplTo] = useState<string>('');
  const [tplBusy, setTplBusy] = useState(false);
  const loadTpl = (to?: string) => { if (agentId) api.agentTemplate(ws.slug, agentId, to).then(setTpl).catch(() => setTpl(null)); };
  useEffect(() => { setTplTo(''); loadTpl(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, ws.slug]);
  const changeVersion = async (v: string) => { if (!agentId) return; setTplBusy(true); try { await api.setAgentTemplateVersion(ws.slug, agentId, v); flash(`Agente ahora sigue ${v}`); setTplTo(''); loadTpl(); await load(); } catch (e: any) { flash(e.message, 'err'); } finally { setTplBusy(false); } };

  const agent = agents.find(a => a.id === agentId);
  const cfg = draft ?? agent?.config ?? null;
  const dirty = !!draft && !!agent && JSON.stringify(draft) !== JSON.stringify(agent.config);
  const edit = (patch: Partial<AgentConfig>) => cfg && setDraft({ ...cfg, ...patch });

  const prov = useMemo(() => providers.find(p => p.id === cfg?.provider), [providers, cfg?.provider]);
  const model = prov?.models.find(m => m.id === cfg?.model);
  const byKey = (k: string) => agents.find(a => a.key === k);
  const nameOf = (k: string) => byKey(k)?.config.name ?? k;
  const openKey = (k: string) => { const a = byKey(k); if (a) navigate(`/equipo/${a.id}`); };

  if (!agent || !cfg) return <Shell crumb="Equipo de IA"><main className="page"><span className="spin" aria-label="Cargando" /></main></Shell>;
  const wsScope = agent.scope === 'workspace';

  const save = async () => {
    if (!dirty || !draft) return;
    setSaving(true);
    try { await api.updateAgentConfig(ws.slug, agent.id, draft); await load(); setDraft(null); flash(`Configuración de ${draft.name} guardada`); }
    catch (e: any) { flash(e.message, 'err'); } finally { setSaving(false); }
  };
  const applyBackend = async () => {
    if (!backendPick) return;
    if (backendPick !== 'api' && !confirm(`¿Autorizas que «${agent.config.name}» ejecute sus pasos con ${backendPick === 'claude-code' ? 'Claude Code gestionado por el Portal' : 'tu consola de Claude Code'} (tu suscripción de Claude)?`)) return;
    try { await api.setAgentBackend(ws.slug, agent.id, backendPick); await load(); setBackendPick(null); flash(`Backend de ${agent.config.name}: ${backendLabel(backendPick, cc?.detection?.billing, agent.config.provider)}`); }
    catch (e: any) { flash(e.message, 'err'); }
  };
  const changeProvider = (pid: ProviderId) => {
    const p = providers.find(x => x.id === pid); if (!p) return;
    const tierModel = p.models.find(m => m.tier === agent.template.tier) ?? p.models[0];
    edit({ provider: pid, model: tierModel?.id ?? '', fallbacks: [] });
  };

  const rail = (a: Agent) => <button key={a.id} className={`rail-i ${a.id === agent.id ? 'is-active' : ''}`} onClick={() => navigate(`/equipo/${a.id}`)} aria-pressed={a.id === agent.id}>
    <Avatar initials={a.template.initials} ws={a.scope === 'workspace'} /><span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}><span style={{ fontWeight: 500, fontSize: 13 }}>{a.config.name}</span><span className="small muted">{a.template.role}</span></span></button>;
  const chipLink = (k: string) => <button key={k} className="chip" style={{ cursor: 'pointer', font: 'inherit', fontSize: 12, fontWeight: 500 }} onClick={() => openKey(k)}>{nameOf(k)}</button>;
  const toolsOn = TOOLS.filter(t => cfg.tools[t.id]).length;
  const knowOn = KNOWLEDGE.filter(k => cfg.knowledge[k.id]).length;
  const fbCount = cfg.fallbacks.filter(f => f !== cfg.model).length;

  return (
    <Shell crumb={<>Equipo de IA / {cfg.name}</>}>
      <main style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', flex: 1 }}>
        <aside style={{ flex: '1 1 260px', maxWidth: 290, borderRight: '1px solid #E5E3DC', padding: '16px 12px 24px', background: '#FAF9F6', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Link className="btn btn-ghost btn-sm" to="/equipo" style={{ justifyContent: 'flex-start', marginBottom: 6 }}>{Icon.back()}Equipo de IA</Link>
          <div className="side-sec">Agentes del espacio</div>{agents.filter(a => a.scope === 'workspace').map(rail)}
          <div className="side-sec">Proyecto · {status.project!.name}</div>{agents.filter(a => a.scope === 'project').map(rail)}
        </aside>
        <div className="page" style={{ flex: '999 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 'none' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
              <Avatar initials={agent.template.initials} ws={wsScope} lg />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <h1 className="h1" style={{ fontSize: 24 }}>{cfg.name}</h1><div className="med">{agent.template.role}</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><Chip tone={wsScope ? 'accent' : ''} xs>{wsScope ? 'Ámbito: espacio de trabajo' : 'Ámbito: proyecto'}</Chip><Chip xs dot={agent.status === 'active' ? 'ok' : ''}>Configurado · {agent.status === 'active' ? 'Activo' : 'Inactivo'}</Chip><Chip xs className="mono">{agent.templateId === 'tpl.custom@1' ? 'personalizado' : agent.templateId}</Chip></div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {agent.templateId === 'tpl.custom@1' && <button className="btn btn-ghost" style={{ color: '#B3261E' }} disabled={saving} onClick={async () => { if (!confirm(`¿Eliminar el agente «${agent.config.name}»? Esta acción no se puede deshacer.`)) return; try { await api.deleteAgent(ws.slug, agent.id); flash('Agente eliminado'); navigate('/equipo'); } catch (e: any) { flash(e.message, 'err'); } }}>Eliminar</button>}
              <button className="btn btn-ghost" onClick={() => setDraft(null)} disabled={!dirty || saving}>Descartar</button>
              <button className="btn btn-primary" onClick={save} disabled={!dirty || saving}>{saving ? 'Guardando…' : 'Guardar cambios'}</button>
            </div>
          </div>
          {dirty && <Notice kind="warn">Hay cambios sin guardar. Al guardar se actualiza la configuración del agente en la base local del espacio; no se activa ni realiza ninguna llamada a modelos.</Notice>}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))', gap: 20, alignItems: 'start' }}>
            <section className="card"><div className="card-h"><div className="h3">Identidad y rol</div></div>
              <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div><label className="label" htmlFor="ag-name">Nombre</label><input id="ag-name" className="input" value={cfg.name} onChange={e => edit({ name: e.target.value })} /></div>
                <div><label className="label" htmlFor="ag-role">Rol organizacional</label><input id="ag-role" className="input" value={agent.template.role} disabled /><div className="help">Definido por la plantilla aprobada.</div></div>
                <div><label className="label" htmlFor="ag-spec">Especialización</label><textarea id="ag-spec" className="input" value={cfg.specialization} onChange={e => edit({ specialization: e.target.value })} /></div>
              </div></section>

            <section className="card"><div className="card-h"><div className="h3">Responsabilidades</div><span className="small muted">{cfg.responsibilities.length} definida{cfg.responsibilities.length === 1 ? '' : 's'}</span></div>
              <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column' }}>
                  {cfg.responsibilities.map((t, i) => <li key={i} className="rrow"><span className="mono small muted">{String(i + 1).padStart(2, '0')}</span><span style={{ flex: 1 }}>{t}</span><button className="xbtn" onClick={() => edit({ responsibilities: cfg.responsibilities.filter((_, j) => j !== i) })} aria-label="Quitar responsabilidad">{Icon.x()}</button></li>)}
                </ul>
                <form style={{ display: 'flex', gap: 8 }} onSubmit={e => { e.preventDefault(); const t = newResp.trim(); if (!t) return; edit({ responsibilities: [...cfg.responsibilities, t] }); setNewResp(''); }}>
                  <input className="input" value={newResp} onChange={e => setNewResp(e.target.value)} placeholder="Añadir una responsabilidad…" aria-label="Nueva responsabilidad" style={{ flex: 1 }} />
                  <button className="btn btn-secondary" type="submit" disabled={!newResp.trim()}>Añadir</button>
                </form>
              </div></section>

            <section className="card"><div className="card-h"><div className="h3">Relaciones organizacionales</div></div>
              <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div><div className="label">Reporta a</div><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{agent.template.reportsTo === 'owner' ? <Chip>Tú · propietario del espacio</Chip> : chipLink(agent.template.reportsTo)}</div></div>
                <div><div className="label">Supervisa</div><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{agent.template.supervises.length ? agent.template.supervises.map(chipLink) : <span className="sm13 muted">No supervisa a otros agentes.</span>}</div></div>
                <div><div className="label">Colabora con</div><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{agent.template.collaborates.map(chipLink)}</div></div>
              </div></section>

            <section className="card"><div className="card-h"><div className="h3">Ámbito asignado</div><Chip tone={wsScope ? 'accent' : ''} xs>{wsScope ? 'Espacio de trabajo' : 'Proyecto'}</Chip></div>
              <div className="card-b">
                <KV k="Espacio de trabajo">{ws.name} · interno</KV>
                <KV k="Proyecto">{wsScope ? 'Todos los proyectos del espacio' : status.project!.name}</KV>
                <KV k="Fuera del ámbito"><Chip tone="err" xs>sin acceso</Chip></KV>
                <div className="help" style={{ marginTop: 10 }}>El ámbito limita el conocimiento, las herramientas y los agentes con los que puede interactuar. Se define al crear el agente y no es editable aquí.</div>
              </div></section>

            <section className="card"><div className="card-h"><div className="h3">Modelo preferido</div></div>
              <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div><label className="label" htmlFor="ag-prov">Proveedor</label>
                  <select id="ag-prov" className="input" value={cfg.provider} onChange={e => changeProvider(e.target.value as ProviderId)}>
                    {providers.map(p => <option key={p.id} value={p.id} disabled={p.status !== 'connected'}>{p.name} · {p.status === 'connected' ? 'conectado' : 'no conectado'}</option>)}
                  </select></div>
                <div><label className="label" htmlFor="ag-model">Modelo</label>
                  <select id="ag-model" className="input mono" value={cfg.model} onChange={e => edit({ model: e.target.value, fallbacks: cfg.fallbacks.filter(f => f !== e.target.value) })}>
                    {(prov?.models ?? []).map(m => <option key={m.id} value={m.id}>{m.name}  ·  {m.id}</option>)}
                  </select>
                  <div className="help">{model ? `${model.description} ${model.supportsEffort ? 'Admite esfuerzo de razonamiento ajustable.' : 'No admite ajuste de esfuerzo.'}` : 'Modelo no disponible en el proveedor conectado.'}</div></div>
              </div></section>

            <section className="card" id="backend"><div className="card-h"><div className="h3">Backend de ejecución</div><Chip xs tone={agent.config.backend && agent.config.backend !== 'api' ? 'accent' : ''}>{backendLabel(agent.config.backend, cc?.detection?.billing, agent.config.provider)}</Chip></div>
              <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <select className="input" style={{ flex: '1 1 260px' }} aria-label="Backend de ejecución" value={backendPick ?? agent.config.backend ?? 'api'} onChange={e => setBackendPick(e.target.value as ExecutionBackend)}>
                    <option value="api">API del proveedor · presupuesto en USD</option>
                    <option value="claude-code" disabled={!cc?.ready || agent.config.provider !== 'anthropic'}>Claude Code — gestionado por el Portal (suscripción)</option>
                    <option value="claude-code-terminal" disabled={!cc?.settings.enabled || agent.config.provider !== 'anthropic'}>Claude Code — tu consola (puente MCP)</option>
                  </select>
                  <button className="btn btn-secondary" disabled={!backendPick || backendPick === (agent.config.backend ?? 'api')} onClick={applyBackend}>Aplicar</button>
                </div>
                <div className="help">El backend solo decide dónde se ejecutan los pasos de los procesos autorizados (plan, implementación, correcciones y revisión de QA). La identidad, el papel, los permisos y el historial de este agente no cambian, y el resultado vuelve a él. El chat, el backlog y las lecciones siguen usando la API. {!cc?.settings.enabled && <>Para usar Claude Code, actívalo en <Link to="/configuracion/proveedor">Proveedores → Claude Code — Local</Link>.</>}</div>
                {agentCc && <div>
                  {agentCc.projects.map(p => { const name = status.project && p.id === status.project.id ? status.project.name : 'Otro proyecto'; return <KV key={p.id} k={`Claude Code en «${name}»`}>{p.authorized ? <Chip xs tone="ok">autorizado</Chip> : <><Chip xs tone="warn">NO autorizado: sus pasos se pausan</Chip> {agent.config.backend && agent.config.backend !== 'api' && <button className="lnk sm13" onClick={async () => { if (!confirm(`¿Autorizas el proyecto «${name}» para Claude Code?`)) return; try { await api.claudeCodeProjects(ws.slug, [...(agentCc.status.settings.projects[ws.slug] ?? []), p.id]); setAgentCc(await api.agentClaudeCode(ws.slug, agent.id)); flash(`«${name}» autorizado para Claude Code`); } catch (e: any) { flash(e.message, 'err'); } }}>Autorizar</button>}</>}</KV>; })}
                  {agent.config.backend === 'claude-code-terminal' && !agentCc.consoles.some(c => c.connected) && <Notice kind="warn"><strong>Ninguna consola conectada.</strong> «Tu consola» no trabaja sola: los pasos de este agente se pausan hasta que abras Claude Code con el puente del Portal. Para ejecución desatendida con tu suscripción, elige «Claude Code — gestionado por el Portal».</Notice>}
                  <KV k="Límites del conector">{agentCc.limits.maxConcurrent} a la vez · {Math.round(agentCc.limits.maxDurationSec / 60)} min · {agentCc.limits.maxTurns} turnos · {agentCc.limits.fallback === 'api' ? 'alternativa por API autorizada' : 'sin alternativa facturable'}</KV>
                  <KV k="Uso con Claude Code (suscripción)">{agentCc.usage.runs} ejecuciones · {agentCc.usage.tokensIn + agentCc.usage.tokensOut} tokens · {Math.round(agentCc.usage.durationMs / 1000)} s · equivalente estimado {fmtUsd(agentCc.usage.apiEquivalentUsd)} (no es un cargo)</KV>
                  <KV k="Gasto en la API (USD)">{stats ? fmtUsd(stats.costUsd) : '—'}</KV>
                  {agentCc.consoles.length > 0 && <KV k="Consolas">{agentCc.consoles.map(c => `${c.name}: ${c.expired ? 'caducada' : c.connected ? 'conectada' : 'desconectada'}`).join(' · ')}</KV>}
                  {agentCc.runs.filter(r => r.error).slice(0, 3).map(r => <Notice key={r.id} kind={r.status === 'limit' ? 'warn' : 'err'}><strong>{r.status === 'limit' ? 'Límite de uso' : r.status === 'interrupted' ? 'Interrumpida' : r.status === 'cancelled' ? 'Cancelada' : 'Error'}</strong> · {new Date(r.startedAt).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })} · {r.error!.slice(0, 220)} Lo hecho en el proceso se conserva; «Continuar» en el proceso la retoma.</Notice>)}
                </div>}
              </div></section>

            <section className="card"><div className="card-h"><div className="h3">Modelos alternativos autorizados</div><span className="small muted">{fbCount} autorizado{fbCount === 1 ? '' : 's'}</span></div>
              <div className="card-b" style={{ display: 'flex', flexDirection: 'column', maxHeight: 360, overflow: 'auto' }}>
                {providers.flatMap(p => p.models.map(m => { const pref = m.id === cfg.model; const disc = p.status !== 'connected' || p.id !== cfg.provider;
                  return <label key={p.id + m.id} className="krow"><input className="cb" type="checkbox" checked={cfg.fallbacks.includes(m.id) && !pref} disabled={pref || disc}
                    onChange={e => edit({ fallbacks: e.target.checked ? [...cfg.fallbacks, m.id] : cfg.fallbacks.filter(f => f !== m.id) })} />
                    <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}><span>{m.name}</span><span className="small muted">{pref ? 'modelo preferido' : p.status !== 'connected' ? 'proveedor no conectado' : p.id !== cfg.provider ? 'otro proveedor (próximamente)' : m.description}</span></span><span className="mono small muted">{p.name}</span></label>; }))}
                <div className="help" style={{ marginTop: 10 }}>Se usan solo si el modelo preferido no está disponible. Requieren un proveedor conectado.</div>
              </div></section>

            <section className="card"><div className="card-h"><div className="h3">Esfuerzo de razonamiento</div></div>
              <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="seg seg-lg" role="group" aria-label="Esfuerzo de razonamiento">
                  {(['low', 'medium', 'high'] as const).map(k => <button key={k} aria-pressed={cfg.effort === k} disabled={!model?.supportsEffort} onClick={() => edit({ effort: k })}>{EFFORT_LABELS[k]}</button>)}
                </div>
                <div className="help">{model?.supportsEffort ? `${model.name} admite esfuerzo ajustable. Un esfuerzo mayor mejora el razonamiento y aumenta el consumo de tokens.` : `${model?.name ?? 'El modelo'} no admite ajuste de esfuerzo; se usará su comportamiento predeterminado.`}</div>
              </div></section>

            <section className="card"><div className="card-h"><div className="h3">Límites de gasto</div></div>
              <div className="card-b" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))', gap: 14 }}>
                <div><label className="label" htmlFor="ag-limit">Límite mensual (USD)</label><input id="ag-limit" className="input mono" type="number" min={0} step={1} value={cfg.monthlyLimitUsd} onChange={e => edit({ monthlyLimitUsd: Number(e.target.value) })} /></div>
                <div><label className="label" htmlFor="ag-pertask">Autorización por encima de (USD por tarea)</label><input id="ag-pertask" className="input mono" type="number" min={0} step={0.5} value={cfg.perTaskAuthUsd} onChange={e => edit({ perTaskAuthUsd: Number(e.target.value) })} /></div>
                <div className="help" style={{ gridColumn: '1 / -1' }}>Los límites se aplican por agente y se combinan con los presupuestos por proceso (próximamente). Al alcanzarlos, el agente se detiene y solicita autorización.</div>
              </div></section>

            <section className="card" style={{ gridColumn: '1 / -1' }}><div className="card-h"><div><div className="h3">Capacidades y participación</div><div className="small muted">Las capacidades deciden su papel en cada historia (sin IA); la participación se calcula de los pasos ejecutados.</div></div><span className="small muted">{(cfg.capabilities ?? []).length} capacidades</span></div>
              <div className="card-b" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: 16 }}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {CAPABILITIES.map(c => { const on = (cfg.capabilities ?? []).includes(c.id); const needs = c.id === 'implementar' ? 'write_repo' : c.role === 'reviewer' || c.role === 'consultant' ? 'read_repo' : null; return <label key={c.id} className="krow"><input className="cb" type="checkbox" checked={on} onChange={e => edit({ capabilities: e.target.checked ? [...(cfg.capabilities ?? []), c.id] : (cfg.capabilities ?? []).filter(x => x !== c.id) })} /><span style={{ flex: 1 }}>{c.label}{needs && on && !cfg.tools[needs] ? <span className="small" style={{ color: '#9A1F18' }}> · falta la herramienta {needs}: el backend lo excluirá</span> : null}</span></label>; })}
                </div>
                <div>
                  <div className="label">Participación real</div>
                  {stats ? <div>
                    <KV k="Pasos ejecutados">{stats.steps} ({stats.done} correctos{stats.failed ? `, ${stats.failed} fallidos` : ''})</KV>
                    <KV k="Por papel">{Object.entries(stats.byRole).map(([r, n]) => `${r === 'planner' ? 'planificador' : r === 'implementer' ? 'implementador' : r === 'reviewer' ? 'revisor' : r === 'consultant' ? 'consultor' : r}: ${n}`).join(' · ') || '—'}</KV>
                    <KV k="Costo real acumulado"><span className="mono">{stats.costUsd.toFixed(4)} USD</span></KV>
                    <KV k="Última participación">{stats.lastAt ? new Date(stats.lastAt).toLocaleString() : 'nunca'}</KV>
                    {stats.steps === 0 && <div className="help" style={{ marginTop: 8 }}>Este agente aún no ha participado en ninguna historia. Entrará cuando una historia coincida con su especialidad o lo añadas manualmente al ejecutar.</div>}
                  </div> : <span className="small muted">Cargando…</span>}
                </div>
              </div></section>

            {tpl?.current && <section className="card" style={{ gridColumn: '1 / -1' }}><div className="card-h"><div><div className="h3">Plantilla y prácticas de la organización</div><div className="small muted">Las prácticas (lecciones promovidas) se inyectan en sus prompts. Las versiones nuevas solo se aplican cuando tú lo decides; puedes volver atrás.</div></div><Chip tone={tpl.latest && tpl.latest.id !== tpl.current.id ? 'warn' : 'ok'} xs>{tpl.current.id}{tpl.latest && tpl.latest.id !== tpl.current.id ? ` · disponible ${tpl.latest.id}` : ' · al día'}</Chip></div>
              <div className="card-b" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: 16 }}>
                <div><div className="label">Prácticas vigentes ({tpl.current.practices.length})</div>{tpl.current.practices.length ? <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>{tpl.current.practices.map(p => <li key={p.lessonId} className="sm13">{p.text}</li>)}</ol> : <span className="sm13 muted">Ninguna todavía. Valida lecciones en Conocimiento → Lecciones y promuévelas a práctica.</span>}
                  {tpl.history.length > 0 && <div className="small muted" style={{ marginTop: 10 }}>Historial: {tpl.history.map(h => `${h.fromVersion ?? '—'} → ${h.toVersion} (${new Date(h.at).toLocaleDateString()}, ${h.by})`).join(' · ')}</div>}</div>
                <div>
                  <div className="label">Cambiar de versión</div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <select className="input" style={{ maxWidth: 200 }} value={tplTo} onChange={e => { setTplTo(e.target.value); loadTpl(e.target.value || undefined); }}><option value="">— elegir versión —</option>{tpl.versions.filter(v => v.id !== tpl.current!.id).map(v => <option key={v.id} value={v.id}>{v.id} · {v.practices.length} práctica(s){tpl.latest?.id === v.id ? ' · última' : ''}</option>)}</select>
                  </div>
                  {tpl.diff && (tplTo ? tpl.diff.to === tplTo : true) && <div style={{ marginTop: 8 }}><div className="small muted">Diff {tpl.diff.from ?? '—'} → {tpl.diff.to}</div><pre className="mono" style={{ margin: '4px 0 8px', padding: 8, background: '#FAF9F6', borderRadius: 8, fontSize: 12, whiteSpace: 'pre-wrap' }}>{tpl.diff.diffMd}</pre>
                    <button className="btn btn-primary btn-sm" disabled={tplBusy} onClick={() => changeVersion(tpl.diff!.to)}>{tplBusy ? <span className="spin spin-light" /> : null}{tpl.diff.to > (tpl.current.id) ? `Actualizar a ${tpl.diff.to}` : `Volver a ${tpl.diff.to}`}</button></div>}
                  {!tpl.diff && !tplTo && <div className="help" style={{ marginTop: 8 }}>No hay versión más reciente que la que sigue este agente.</div>}
                </div>
              </div></section>}

            <section className="card" style={{ gridColumn: '1 / -1' }}><div className="card-h"><div className="h3">Herramientas y permisos</div><span className="small muted">{toolsOn} de {TOOLS.length} habilitadas</span></div>
              <div className="card-b" style={{ display: 'flex', flexDirection: 'column' }}>
                {TOOLS.map(t => <div key={t.id} className="trow"><input className="sw" type="checkbox" id={`tool-${t.id}`} checked={!!cfg.tools[t.id]} onChange={e => edit({ tools: { ...cfg.tools, [t.id]: e.target.checked } })} aria-label={TOOL_LABELS[t.id].name} />
                  <label htmlFor={`tool-${t.id}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, cursor: 'pointer', minWidth: 0 }}><span style={{ fontWeight: 500, fontSize: 13 }}>{TOOL_LABELS[t.id].name}</span><span className="small muted">{TOOL_LABELS[t.id].desc}</span></label>
                  <Chip tone={t.risk === 'auth' ? 'warn' : ''} xs>{t.risk === 'auth' ? 'requiere autorización' : 'local'}</Chip></div>)}
                <div style={{ marginTop: 14 }}><Notice kind="warn">Las herramientas marcadas con <strong>«requiere autorización»</strong> nunca se ejecutan de forma autónoma: cada uso se detiene hasta que lo apruebes, aunque el agente esté activo. Habilitarlas aquí solo las añade a su configuración.</Notice></div>
              </div></section>

            <section className="card"><div className="card-h"><div className="h3">Acceso a conocimiento</div><span className="small muted">{knowOn} de {KNOWLEDGE.length}</span></div>
              <div className="card-b" style={{ display: 'flex', flexDirection: 'column' }}>
                {KNOWLEDGE.map(k => <label key={k.id} className="krow"><input className="cb" type="checkbox" checked={!!cfg.knowledge[k.id]} onChange={e => edit({ knowledge: { ...cfg.knowledge, [k.id]: e.target.checked } })} /><span style={{ flex: 1 }}>{KNOWLEDGE_LABELS[k.id]}</span></label>)}
                <div className="help" style={{ marginTop: 10 }}>Solo conocimiento dentro de su ámbito. El repositorio se ofrece en modo lectura; su escritura es una herramienta aparte.</div>
              </div></section>

            <section className="card"><div className="card-h"><div className="h3">Criterios de evaluación</div><Chip tone="soon" xs>edición próximamente</Chip></div>
              <div className="card-b"><ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column' }}>{agent.template.evaluation.map((t, i) => <li key={i} className="rrow"><span className="mono small muted">{String(i + 1).padStart(2, '0')}</span><span>{t}</span></li>)}</ul>
                <div className="help" style={{ marginTop: 10 }}>Se usarán para medir el rendimiento del agente cuando existan ejecuciones.</div></div></section>

            <section className="card" style={{ gridColumn: '1 / -1' }}><div className="card-h"><div className="h3">Estado</div><Chip dot={agent.status === 'active' ? 'ok' : ''}>{agent.status === 'active' ? 'Activo' : 'Inactivo'} · configurado</Chip></div>
              <div className="card-b" style={{ display: 'flex', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><span className="small muted">Última actividad</span><span className="mono sm13">ninguna</span></div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><span className="small muted">Llamadas a modelos</span><span className="mono sm13">0</span></div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><span className="small muted">Costo acumulado</span><span className="mono sm13">{fmtUsd(0)}</span></div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><span className="small muted">Configuración</span><span className="mono sm13">{agent.configEdited ? `editada · ${new Date(agent.updatedAt).toLocaleString('es-MX')}` : 'plantilla sin cambios'}</span></div>
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}><span className="small muted" style={{ maxWidth: '36ch' }}>La activación requiere autorización de ejecución y un presupuesto aprobado. Se habilita en la siguiente historia de usuario.</span><button className="btn btn-secondary" disabled>Activar agente</button></div>
              </div></section>
          </div>
          <div><Link className="btn btn-ghost" to="/panel">Volver al panel</Link></div>
        </div>
      </main>
    </Shell>
  );
}
