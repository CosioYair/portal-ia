import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Agent, AgentConfig, AgentContextScope, ProviderId } from '@portal-ia/domain';
import { CAPABILITIES, KNOWLEDGE, TOOLS, EFFORT_LEVELS, effortLevelsFor, clampEffort, contextScopeLabel } from '@portal-ia/domain';
import { ContextScopeChips, ContextScopeFields, scopeIsEmpty } from './AgentWizard.tsx';
import { api } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { EFFORT_LABELS, KNOWLEDGE_LABELS, TOOL_LABELS, fmtUsd } from '../lib/labels.ts';
import { Chip, DraftNote, Icon, KV, Notice } from '../components/ui.tsx';
import { draftKey, fingerprint, useDraft } from '../lib/persist.ts';

/**
 * HU-210 · Ajustes avanzados de un agente, incrustados en su panel de la Oficina (Ajustes › Configuración): ámbito, rol,
 * modelo, herramientas y conocimiento, límites, capacidades, plantilla y evaluación. Ya no es una pantalla propia:
 * /equipo/:id redirige a /oficina/agente/:id/configuracion. El motor de IA se cambia en el bloque «Motor de IA» del panel.
 * Guardar no llama a modelos ni gasta.
 */
export function AgentAdvancedSettings({ slug, agentId, onChanged }: { slug: string; agentId: string; onChanged?: () => void }) {
  const { status, providers, flash, navigate } = useApp();
  const ws = { ...status.workspace!, slug };
  const [agents, setAgents] = useState<Agent[]>([]);
  const [newResp, setNewResp] = useState('');
  const [saving, setSaving] = useState(false);
  const [agentCc, setAgentCc] = useState<Awaited<ReturnType<typeof api.agentClaudeCode>> | null>(null);
  useEffect(() => { if (agentId) api.agentClaudeCode(ws.slug, agentId).then(setAgentCc).catch(() => setAgentCc(null)); }, [agentId, ws.slug]);

  const load = () => api.agents(ws.slug).then(list => setAgents(list.filter(a => a.scope === 'workspace' || a.projectId === status.project?.id)));
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.slug]);
  useEffect(() => { setNewResp(''); }, [agentId]);
  const [stats, setStats] = useState<{ steps: number; done: number; failed: number; costUsd: number; byRole: Record<string, number>; lastAt: string | null } | null>(null);
  useEffect(() => { if (agentId) api.agentStats(ws.slug, agentId).then(setStats).catch(() => setStats(null)); }, [agentId, ws.slug]);
  const [tpl, setTpl] = useState<Awaited<ReturnType<typeof api.agentTemplate>> | null>(null);
  const [tplTo, setTplTo] = useState<string>('');
  const [tplBusy, setTplBusy] = useState(false);
  const loadTpl = (to?: string) => { if (agentId) api.agentTemplate(ws.slug, agentId, to).then(setTpl).catch(() => setTpl(null)); };
  // EN-014 · Ámbito: se guarda aparte de la configuración (no toca herramientas, permisos ni costo).
  const [scopePick, setScopePick] = useState<AgentContextScope | null>(null);
  const [scopeBusy, setScopeBusy] = useState(false);
  useEffect(() => { setScopePick(null); }, [agentId]);
  useEffect(() => { setTplTo(''); loadTpl(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, ws.slug]);
  const changeVersion = async (v: string) => { if (!agentId) return; setTplBusy(true); try { await api.setAgentTemplateVersion(ws.slug, agentId, v); flash(`Agente ahora sigue ${v}`); setTplTo(''); loadTpl(); await load(); } catch (e: any) { flash(e.message, 'err'); } finally { setTplBusy(false); } };

  const agent = agents.find(a => a.id === agentId);
  // Los cambios sin guardar sobreviven a recargar (por empresa y agente). El borrador guarda SOLO los campos que tocaste
  // (`mine`): se muestran y se guardan sobre la configuración actual, así lo que cambió mientras tanto (p. ej. el backend o
  // la versión de plantilla) no se pisa, y volver un campo a su valor anterior también se guarda. Un campo que vuelve a
  // ser igual al del servidor deja de ser tuyo (no pisaría un cambio posterior).
  const cfgDraft = useDraft<{ mine: Partial<AgentConfig> } | null>(draftKey('agente.config', ws.slug, agent ? agentId : null), null, { base: agent ? fingerprint(agent.config) : null });
  const mine: Partial<AgentConfig> = cfgDraft.value?.mine ?? {};
  const cfg: AgentConfig | null = agent ? { ...agent.config, ...mine } : null;
  const dirty = !!agent && JSON.stringify(cfg) !== JSON.stringify(agent.config);
  const edit = (patch: Partial<AgentConfig>) => {
    if (agent) cfgDraft.set(d => {
      const next: Record<string, unknown> = { ...(d?.mine ?? {}), ...patch };
      for (const k of Object.keys(patch) as (keyof AgentConfig)[]) if (JSON.stringify(next[k]) === JSON.stringify(agent.config[k])) delete next[k];
      return { mine: next as Partial<AgentConfig> };
    });
  };
  const discardDraft = cfgDraft.clear;

  const prov = useMemo(() => providers.find(p => p.id === cfg?.provider), [providers, cfg?.provider]);
  const model = prov?.models.find(m => m.id === cfg?.model);
  // Niveles que admite el modelo (xhigh y max no existen en todos). Con Claude Code el esfuerzo lo recibe la CLI aunque el
  // catálogo de la API no esté conectado; con la API, solo si el modelo del catálogo lo admite.
  const effortLevels: string[] = cfg ? effortLevelsFor(cfg.provider, cfg.model) : [];
  const effortAdjustable = agent?.config.backend === 'claude-code' || !!model?.supportsEffort;
  if (!agent || !cfg) return <span className="spin" aria-label="Cargando" />;

  const save = async () => {
    if (!dirty || !cfg) return;
    setSaving(true);
    try { await api.updateAgentConfig(ws.slug, agent.id, cfg); await load(); discardDraft(); api.agentClaudeCode(ws.slug, agent.id).then(setAgentCc).catch(() => undefined); flash(`Configuración de ${cfg.name} guardada`); onChanged?.(); }
    catch (e: any) { flash(e.message, 'err'); } finally { setSaving(false); }
  };
  const remove = async () => {
    if (!confirm(`¿Eliminar el agente «${agent.config.name}»? Esta acción no se puede deshacer.`)) return;
    try { await api.deleteAgent(ws.slug, agent.id); flash('Agente eliminado'); navigate('/oficina/organizacion'); onChanged?.(); } catch (e: any) { flash(e.message, 'err'); }
  };
  const currentScope: AgentContextScope | null = agent.contextScope ?? null;
  const scopeValue: AgentContextScope = scopePick ?? currentScope ?? { project: null, company: false, general: false };
  const scopeDirty = !!scopePick && JSON.stringify(scopePick) !== JSON.stringify(currentScope);
  const scopeProjects = status.project ? [{ id: status.project.id, name: status.project.name }] : [];
  const companyName = (ws as { name?: string }).name ?? null;
  const saveScope = async () => {
    if (!scopePick || scopeIsEmpty(scopePick)) return;
    setScopeBusy(true);
    try { await api.setAgentContextScope(ws.slug, agent.id, scopePick); await load(); setScopePick(null); onChanged?.(); flash(`Ámbito de ${agent.config.name}: ${contextScopeLabel(scopePick)}. Sus herramientas y permisos no cambian.`); }
    catch (e: any) { flash(e.message, 'err'); } finally { setScopeBusy(false); }
  };
  const changeProvider = (pid: ProviderId) => {
    const p = providers.find(x => x.id === pid); if (!p) return;
    const tierModel = p.models.find(m => m.tier === agent.template.tier) ?? p.models[0];
    edit({ provider: pid, model: tierModel?.id ?? '', fallbacks: [] });
  };

  const toolsOn = TOOLS.filter(t => cfg.tools[t.id]).length;
  const knowOn = KNOWLEDGE.filter(k => cfg.knowledge[k.id]).length;
  const fbCount = cfg.fallbacks.filter(f => f !== cfg.model).length;

  const modelName = model?.name ?? cfg.model;

  return (
    <div className="agent-advanced" style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <p className="small muted" style={{ margin: 0 }}>Cada sección está plegada y muestra su dato clave. Guardar actualiza la configuración en la base local de la empresa; no llama a modelos ni gasta.</p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost btn-sm" onClick={discardDraft} disabled={!dirty || saving}>Descartar</button>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={!dirty || saving}>{saving ? 'Guardando…' : 'Guardar cambios'}</button>
      </div>
      <DraftNote status={dirty ? cfgDraft.status : 'idle'} stale={cfgDraft.stale} />
      {dirty && <Notice kind="warn">Hay cambios sin guardar. Al guardar se actualiza la configuración del agente en la base local de la empresa; no se activa ni realiza ninguna llamada a modelos.</Notice>}

            <Sec title={<>Ámbito</>} hint={currentScope ? contextScopeLabel(currentScope) : 'sin definir'} open>
              <div className="chip-row chip-row-start"><ContextScopeChips scope={currentScope} companyName={companyName} /></div>
              <div className="help">Decide, sin IA, el contexto de sus instrucciones por defecto, sus habilidades base y su paquete exportado. No cambia «Dónde trabaja en el Portal» (se ve en la cabecera del panel) ni sus herramientas y permisos.</div>
              <ContextScopeFields value={scopeValue} onChange={setScopePick} projects={scopeProjects} companyName={companyName} idPrefix="cfg-scope" />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="btn btn-primary btn-sm" disabled={!scopeDirty || scopeBusy || scopeIsEmpty(scopeValue)} onClick={() => void saveScope()}>{scopeBusy ? <span className="spin spin-light" /> : null}Guardar ámbito</button>
                {scopeDirty && <button className="btn btn-ghost btn-sm" disabled={scopeBusy} onClick={() => setScopePick(null)}>Descartar</button>}
                {scopeDirty && scopeIsEmpty(scopeValue) && <span className="small muted">Elige al menos una opción para guardar.</span>}
              </div>
            </Sec>

            <Sec title="Rol y responsabilidades" hint={`${cfg.responsibilities.length} responsabilidad${cfg.responsibilities.length === 1 ? '' : 'es'}`}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div><label className="label" htmlFor="ag-name">Nombre</label><input id="ag-name" className="input" value={cfg.name} onChange={e => edit({ name: e.target.value })} /></div>
                <div><label className="label" htmlFor="ag-role">Rol organizacional</label><input id="ag-role" className="input" value={agent.template.role} disabled /><div className="help">Definido por la plantilla aprobada.</div></div>
                <div><label className="label" htmlFor="ag-spec">Especialización</label><textarea id="ag-spec" className="input" value={cfg.specialization} onChange={e => edit({ specialization: e.target.value })} /></div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}><div className="label">Responsabilidades ({cfg.responsibilities.length})</div>
                <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column' }}>
                  {cfg.responsibilities.map((t, i) => <li key={i} className="rrow"><span className="mono small muted">{String(i + 1).padStart(2, '0')}</span><span style={{ flex: 1 }}>{t}</span><button className="xbtn" onClick={() => edit({ responsibilities: cfg.responsibilities.filter((_, j) => j !== i) })} aria-label="Quitar responsabilidad">{Icon.x()}</button></li>)}
                </ul>
                <form style={{ display: 'flex', gap: 8 }} onSubmit={e => { e.preventDefault(); const t = newResp.trim(); if (!t) return; edit({ responsibilities: [...cfg.responsibilities, t] }); setNewResp(''); }}>
                  <input className="input" value={newResp} onChange={e => setNewResp(e.target.value)} placeholder="Añadir una responsabilidad…" aria-label="Nueva responsabilidad" style={{ flex: 1 }} />
                  <button className="btn btn-secondary" type="submit" disabled={!newResp.trim()}>Añadir</button>
                </form>
              </div></Sec>

            <Sec title="Modelo y motor de IA" hint={`${modelName}${fbCount ? ` · ${fbCount} alternativo${fbCount === 1 ? '' : 's'}` : ''}`}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div><label className="label" htmlFor="ag-prov">Proveedor</label>
                  <select id="ag-prov" className="input" value={cfg.provider} onChange={e => changeProvider(e.target.value as ProviderId)}>
                    {providers.map(p => <option key={p.id} value={p.id} disabled={p.status !== 'connected'}>{p.name} · {p.status === 'connected' ? 'conectado' : 'no conectado'}</option>)}
                  </select></div>
                <div><label className="label" htmlFor="ag-model">Modelo</label>
                  <select id="ag-model" className="input mono" value={cfg.model} onChange={e => edit({ model: e.target.value, fallbacks: cfg.fallbacks.filter(f => f !== e.target.value), effort: clampEffort(cfg.provider, e.target.value, cfg.effort) })}>
                    {(prov?.models ?? []).map(m => <option key={m.id} value={m.id}>{m.name}  ·  {m.id}</option>)}
                  </select>
                  <div className="help">{model ? `${model.description} ${model.supportsEffort ? 'Admite esfuerzo de razonamiento ajustable.' : 'No admite ajuste de esfuerzo.'}` : 'Modelo no disponible en el proveedor conectado.'}</div></div>
              </div>
              <div id="backend" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="label">Motor de IA</div>
                <div className="help">El motor se cambia arriba, en «Motor de IA (cómo trabaja)», con tu autorización explícita. Aquí ves su estado con Claude Code. Para usar Claude Code, actívalo en <Link to="/configuracion/proveedor#claude-code">Proveedores → Claude Code — Local</Link>.</div>
                {agentCc && <div>
                  {agentCc.projects.map(p => { const name = status.project && p.id === status.project.id ? status.project.name : 'Otro proyecto'; return <KV key={p.id} k={`Claude Code en «${name}»`}>{p.authorized ? <Chip xs tone="ok">autorizado</Chip> : <><Chip xs tone="warn">NO autorizado: sus pasos se pausan</Chip> {agent.config.backend && agent.config.backend !== 'api' && <button className="lnk sm13" onClick={async () => { if (!confirm(`¿Autorizas el proyecto «${name}» para Claude Code?`)) return; try { await api.claudeCodeProjects(ws.slug, [...(agentCc.status.settings.projects[ws.slug] ?? []), p.id]); const fresh = await api.agentClaudeCode(ws.slug, agent.id); setAgentCc(fresh); if (fresh.projects.find(x => x.id === p.id)?.authorized) flash(`«${name}» autorizado para Claude Code (comprobado en la configuración guardada)`); else flash(`No quedó guardado: «${name}» sigue sin autorizar para Claude Code.`, 'err'); } catch (e: any) { flash(e.message, 'err'); } }}>Autorizar</button>}</>}</KV>; })}
                  {agent.config.backend === 'claude-code-terminal' && !agentCc.consoles.some(c => c.connected) && <Notice kind="warn"><strong>Ninguna consola conectada.</strong> «Tu consola» no trabaja sola: los pasos de este agente se pausan hasta que abras Claude Code con el puente del Portal. Para ejecución desatendida con tu suscripción, elige «Claude Code — gestionado por el Portal».</Notice>}
                  <KV k="Límites del conector">{agentCc.limits.maxConcurrent} a la vez · {Math.round(agentCc.limits.maxDurationSec / 60)} min · {agentCc.limits.maxTurns} turnos · {agentCc.limits.fallback === 'api' ? 'alternativa por API autorizada' : 'sin alternativa facturable'}</KV>
                  <KV k="Uso con Claude Code (suscripción)">{agentCc.usage.runs} ejecuciones · {agentCc.usage.tokensIn + agentCc.usage.tokensOut} tokens · {Math.round(agentCc.usage.durationMs / 1000)} s · equivalente estimado {fmtUsd(agentCc.usage.apiEquivalentUsd)} (no es un cargo)</KV>
                  <KV k="Gasto en la API (USD)">{stats ? fmtUsd(stats.costUsd) : '—'}</KV>
                  {agentCc.consoles.length > 0 && <KV k="Consolas">{agentCc.consoles.map(c => `${c.name}: ${c.expired ? 'caducada' : c.connected ? 'conectada' : 'desconectada'}`).join(' · ')}</KV>}
                  {agentCc.runs.filter(r => r.error).slice(0, 3).map(r => <Notice key={r.id} kind={r.status === 'limit' ? 'warn' : 'err'}><strong>{r.status === 'limit' ? 'Límite de uso' : r.status === 'interrupted' ? 'Interrumpida' : r.status === 'cancelled' ? 'Cancelada' : 'Error'}</strong> · {new Date(r.startedAt).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })} · {r.error!.slice(0, 220)} Lo hecho en el proceso se conserva; «Continuar» en el proceso la retoma.</Notice>)}
                </div>}
              </div>
              <div><div className="label">Modelos alternativos autorizados ({fbCount})</div>
              <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 360, overflow: 'auto' }}>
                {providers.flatMap(p => p.models.map(m => { const pref = m.id === cfg.model; const disc = p.status !== 'connected' || p.id !== cfg.provider;
                  return <label key={p.id + m.id} className="krow"><input className="cb" type="checkbox" checked={cfg.fallbacks.includes(m.id) && !pref} disabled={pref || disc}
                    onChange={e => edit({ fallbacks: e.target.checked ? [...cfg.fallbacks, m.id] : cfg.fallbacks.filter(f => f !== m.id) })} />
                    <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}><span>{m.name}</span><span className="small muted">{pref ? 'modelo preferido' : p.status !== 'connected' ? 'proveedor no conectado' : p.id !== cfg.provider ? 'otro proveedor (próximamente)' : m.description}</span></span><span className="mono small muted">{p.name}</span></label>; }))}
                <div className="help" style={{ marginTop: 10 }}>Se usan solo si el modelo preferido no está disponible. Requieren un proveedor conectado.</div>
              </div></div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}><div className="label">Esfuerzo de razonamiento</div>
                <div className="seg seg-lg" role="group" aria-label="Esfuerzo de razonamiento">
                  {EFFORT_LEVELS.map(k => { const ok = effortAdjustable && effortLevels.includes(k); return <button key={k} aria-pressed={cfg.effort === k} disabled={!ok} title={ok ? undefined : `${cfg.model} no admite este nivel`} onClick={() => edit({ effort: k, effortApplied: true })}>{EFFORT_LABELS[k]}</button>; })}
                </div>
                <div className="help">{effortAdjustable ? `${model?.name ?? cfg.model} admite: ${effortLevels.map(k => EFFORT_LABELS[k].toLowerCase()).join(', ')}${EFFORT_LEVELS.some(k => !effortLevels.includes(k)) ? ` (no admite: ${EFFORT_LEVELS.filter(k => !effortLevels.includes(k)).map(k => EFFORT_LABELS[k].toLowerCase()).join(', ')})` : ''}. Un esfuerzo mayor mejora el razonamiento, pero tarda más y consume más (Muy alto y Máximo, notablemente más de tu suscripción con Claude Code).` : `${model?.name ?? 'El modelo'} no admite ajuste de esfuerzo; se usará su comportamiento predeterminado.`}</div>
                {agentCc?.invocation && <div className="small" role="status" style={{ padding: '8px 10px', background: 'var(--color-surface-alt)', borderRadius: 8 }}><strong>Invocación real:</strong> {agentCc.invocation.note}{dirty && mine.effort ? ' (al guardar se aplicará el nivel elegido)' : ''}</div>}
              </div></Sec>

            <Sec title="Herramientas y conocimiento" hint={`${toolsOn} de ${TOOLS.length} herramientas · ${knowOn} de ${KNOWLEDGE.length} fuentes`}>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {TOOLS.map(t => <div key={t.id} className="trow"><input className="sw" type="checkbox" id={`tool-${t.id}`} checked={!!cfg.tools[t.id]} onChange={e => edit({ tools: { ...cfg.tools, [t.id]: e.target.checked } })} aria-label={TOOL_LABELS[t.id].name} />
                  <label htmlFor={`tool-${t.id}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, cursor: 'pointer', minWidth: 0 }}><span style={{ fontWeight: 500, fontSize: 13 }}>{TOOL_LABELS[t.id].name}</span><span className="small muted">{TOOL_LABELS[t.id].desc}</span></label>
                  <Chip tone={t.risk === 'auth' ? 'warn' : ''} xs>{t.risk === 'auth' ? 'requiere autorización' : 'local'}</Chip></div>)}
                <div style={{ marginTop: 14 }}><Notice kind="warn">Las herramientas marcadas con <strong>«requiere autorización»</strong> nunca se ejecutan de forma autónoma: cada uso se detiene hasta que lo apruebes, aunque el agente esté activo. Habilitarlas aquí solo las añade a su configuración.</Notice></div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}><div className="label">Acceso a conocimiento</div>
                {KNOWLEDGE.map(k => <label key={k.id} className="krow"><input className="cb" type="checkbox" checked={!!cfg.knowledge[k.id]} onChange={e => edit({ knowledge: { ...cfg.knowledge, [k.id]: e.target.checked } })} /><span style={{ flex: 1 }}>{KNOWLEDGE_LABELS[k.id]}</span></label>)}
                <div className="help" style={{ marginTop: 10 }}>Solo conocimiento de donde trabaja en el Portal. El repositorio se ofrece en modo lectura; su escritura es una herramienta aparte.</div>
              </div>
            </Sec>

            <Sec title="Límites de gasto" hint={`${fmtUsd(cfg.monthlyLimitUsd)} al mes · autorización desde ${fmtUsd(cfg.perTaskAuthUsd)} por tarea`}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))', gap: 14 }}>
                <div><label className="label" htmlFor="ag-limit">Límite mensual (USD)</label><input id="ag-limit" className="input mono" type="number" min={0} step={1} value={cfg.monthlyLimitUsd} onChange={e => edit({ monthlyLimitUsd: Number(e.target.value) })} /></div>
                <div><label className="label" htmlFor="ag-pertask">Autorización por encima de (USD por tarea)</label><input id="ag-pertask" className="input mono" type="number" min={0} step={0.5} value={cfg.perTaskAuthUsd} onChange={e => edit({ perTaskAuthUsd: Number(e.target.value) })} /></div>
                <div className="help" style={{ gridColumn: '1 / -1' }}>Los límites se aplican por agente y se combinan con los presupuestos por proceso (próximamente). Al alcanzarlos, el agente se detiene y solicita autorización.</div>
              </div></Sec>

            <Sec title="Capacidades y participación" hint={`${(cfg.capabilities ?? []).length} capacidades${stats ? ` · ${stats.steps} pasos` : ''}`}>
              <div className="help">Las capacidades deciden su papel en cada historia (sin IA); la participación se calcula de los pasos ejecutados.</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: 16 }}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {CAPABILITIES.map(c => { const on = (cfg.capabilities ?? []).includes(c.id); const needs = c.id === 'implementar' ? 'write_repo' : c.role === 'reviewer' || c.role === 'consultant' ? 'read_repo' : null; return <label key={c.id} className="krow"><input className="cb" type="checkbox" checked={on} onChange={e => edit({ capabilities: e.target.checked ? [...(cfg.capabilities ?? []), c.id] : (cfg.capabilities ?? []).filter(x => x !== c.id) })} /><span style={{ flex: 1 }}>{c.label}{needs && on && !cfg.tools[needs] ? <span className="small" style={{ color: 'var(--color-err-text)' }}> · falta la herramienta {needs}: el backend lo excluirá</span> : null}</span></label>; })}
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
              </div></Sec>

            {tpl?.current && <Sec title="Plantilla y prácticas" hint={`${tpl.current.id}${tpl.latest && tpl.latest.id !== tpl.current.id ? ` · disponible ${tpl.latest.id}` : ' · al día'} · ${tpl.current.practices.length} práctica(s)`}>
              <div className="help">Las prácticas (lecciones promovidas) se inyectan en sus prompts. Las versiones nuevas solo se aplican cuando tú lo decides; puedes volver atrás.</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: 16 }}>
                <div><div className="label">Prácticas vigentes ({tpl.current.practices.length})</div>{tpl.current.practices.length ? <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>{tpl.current.practices.map(p => <li key={p.lessonId} className="sm13">{p.text}</li>)}</ol> : <span className="sm13 muted">Ninguna todavía. Valida lecciones en Conocimiento → Lecciones y promuévelas a práctica.</span>}
                  {tpl.history.length > 0 && <div className="small muted" style={{ marginTop: 10 }}>Historial: {tpl.history.map(h => `${h.fromVersion ?? '—'} → ${h.toVersion} (${new Date(h.at).toLocaleDateString()}, ${h.by})`).join(' · ')}</div>}</div>
                <div>
                  <div className="label">Cambiar de versión</div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <select className="input" style={{ maxWidth: 200 }} value={tplTo} onChange={e => { setTplTo(e.target.value); loadTpl(e.target.value || undefined); }}><option value="">— elegir versión —</option>{tpl.versions.filter(v => v.id !== tpl.current!.id).map(v => <option key={v.id} value={v.id}>{v.id} · {v.practices.length} práctica(s){tpl.latest?.id === v.id ? ' · última' : ''}</option>)}</select>
                  </div>
                  {tpl.diff && (tplTo ? tpl.diff.to === tplTo : true) && <div style={{ marginTop: 8 }}><div className="small muted">Diff {tpl.diff.from ?? '—'} → {tpl.diff.to}</div><pre className="mono" style={{ margin: '4px 0 8px', padding: 8, background: 'var(--color-surface-alt)', borderRadius: 8, fontSize: 12, whiteSpace: 'pre-wrap' }}>{tpl.diff.diffMd}</pre>
                    <button className="btn btn-primary btn-sm" disabled={tplBusy} onClick={() => changeVersion(tpl.diff!.to)}>{tplBusy ? <span className="spin spin-light" /> : null}{tpl.diff.to > (tpl.current.id) ? `Actualizar a ${tpl.diff.to}` : `Volver a ${tpl.diff.to}`}</button></div>}
                  {!tpl.diff && !tplTo && <div className="help" style={{ marginTop: 8 }}>No hay versión más reciente que la que sigue este agente.</div>}
                </div>
              </div></Sec>}

            <Sec title="Criterios de evaluación" hint={`${agent.template.evaluation.length} criterio${agent.template.evaluation.length === 1 ? '' : 's'} · edición próximamente`}>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column' }}>{agent.template.evaluation.map((t, i) => <li key={i} className="rrow"><span className="mono small muted">{String(i + 1).padStart(2, '0')}</span><span>{t}</span></li>)}</ul>
              <div className="help">Se usarán para medir el rendimiento del agente cuando existan ejecuciones.</div>
            </Sec>

            <div className="small muted">Configuración: <span className="mono">{agent.configEdited ? `editada · ${new Date(agent.updatedAt).toLocaleString('es-MX')}` : 'plantilla sin cambios'}</span></div>

            {agent.templateId === 'tpl.custom@1' && <section aria-labelledby="adv-risk" style={{ borderTop: '1px solid var(--color-border)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="h3" id="adv-risk">Zona de riesgo</div>
              <div className="small muted">Eliminar el agente no se puede deshacer.</div>
              <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start', color: 'var(--color-err-text)' }} disabled={saving} onClick={() => void remove()}>{Icon.x()} Eliminar agente</button>
            </section>}
    </div>
  );
}

/** Sección plegable de una sola columna (cabe en el panel estrecho): el resumen muestra el dato clave sin abrirla. */
function Sec({ title, hint, open, children }: { title: ReactNode; hint?: ReactNode; open?: boolean; children: ReactNode }) {
  return <details className="agent-adv-sec" open={open || undefined} style={{ borderTop: '1px solid var(--color-border)', paddingTop: 10 }}>
    <summary style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}><span className="h3">{title}</span>{hint != null && <span className="small muted">{hint}</span>}</summary>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 10, minWidth: 0 }}>{children}</div>
  </details>;
}
