import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Agent, AgentConfig, ProviderId, Scope } from '@portal-ia/domain';
import { CAPABILITIES, KNOWLEDGE, TOOLS } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { EFFORT_LABELS, KNOWLEDGE_LABELS, TOOL_LABELS, fmtUsd } from '../lib/labels.ts';
import { Shell } from '../components/Shell.tsx';
import { Chip, DraftNote, Icon, Notice } from '../components/ui.tsx';
import { draftKey, useDraft } from '../lib/persist.ts';

/** Alta de un agente especializado. Manual, o con propuesta del Agente de Onboarding (1 llamada real autorizada). */
export function AgentCreate() {
  const { status, providers, flash, navigate } = useApp();
  const ws = status.workspace!; const project = status.project!;
  const connected = providers.filter(p => p.status === 'connected');
  const [agents, setAgents] = useState<Agent[]>([]);
  useEffect(() => { api.agents(ws.slug).then(list => setAgents(list.filter(a => a.scope === 'workspace' || a.projectId === status.project?.id))); }, [ws.slug, status.project?.id]);

  const defaultProvider = connected[0];
  // Borrador del agente nuevo (por empresa y proyecto): sobrevive a recargar. La autorización de la propuesta con IA, no.
  const formDraft = useDraft(draftKey('agente.nuevo', ws.slug, project.id), {
    scope: 'project' as Scope, name: '', role: '', reportsTo: 'pj-coordinador', collab: [] as string[], evaluation: ['', '', ''], desc: '',
    cfg: {
      name: '', specialization: '', responsibilities: [], provider: (defaultProvider?.id ?? 'anthropic') as ProviderId,
      model: defaultProvider?.defaultModel ?? defaultProvider?.models[0]?.id ?? '', fallbacks: [], effort: 'medium', tools: { delegate: true }, knowledge: { objectives: true, context: true }, capabilities: ['consultar'],
      monthlyLimitUsd: 20, perTaskAuthUsd: 2
    } as AgentConfig
  });
  type Form = typeof formDraft.value;
  const field = <K extends keyof Form>(k: K) => (v: Form[K] | ((p: Form[K]) => Form[K])) => formDraft.set(d => ({ ...d, [k]: typeof v === 'function' ? (v as (p: Form[K]) => Form[K])(d[k]) : v }));
  const { scope, name, role, reportsTo, collab, evaluation, cfg, desc } = formDraft.value;
  const setScope = field('scope'); const setName = field('name'); const setRole = field('role'); const setReportsTo = field('reportsTo');
  const setCollab = field('collab'); const setEvaluation = field('evaluation'); const setCfg = field('cfg'); const setDesc = field('desc');
  const [newResp, setNewResp] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Propuesta con IA
  const [est, setEst] = useState<{ model: string; byAgent: string; estimatedUsd: number } | null>(null);
  const [auth, setAuth] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [rationale, setRationale] = useState<string | null>(null);
  const [draftCost, setDraftCost] = useState<string | null>(null);
  useEffect(() => { api.draftEstimate(ws.slug).then(setEst).catch(() => setEst(null)); }, [ws.slug]);

  const prov = useMemo(() => providers.find(p => p.id === cfg.provider), [providers, cfg.provider]);
  const model = prov?.models.find(m => m.id === cfg.model);
  const edit = (patch: Partial<AgentConfig>) => setCfg(c => ({ ...c, ...patch }));
  const candidates = agents.filter(a => scope === 'workspace' ? a.scope === 'workspace' : true);

  const propose = async () => {
    if (!auth || desc.trim().length < 10) return; setDrafting(true); setError(null);
    try {
      const r = await api.draftAgent(ws.slug, desc.trim(), scope, Math.max(0.05, (est?.estimatedUsd ?? 0.05) * 3));
      const p = r.proposal;
      if (p.name) { setName(p.name); }
      if (p.role) setRole(p.role);
      if (p.reportsTo) setReportsTo(p.reportsTo);
      if (p.collaborates) setCollab(p.collaborates);
      if (p.evaluation?.length) setEvaluation([...p.evaluation, '', ''].slice(0, Math.max(3, p.evaluation.length)));
      setCfg(c => ({ ...c, ...p.config, name: p.name ?? c.name, tools: p.config.tools ?? c.tools, knowledge: p.config.knowledge ?? c.knowledge, fallbacks: [] } as AgentConfig));
      setRationale((p as any).rationale ?? null);
      setDraftCost(`${r.inputTokens + r.outputTokens} tokens · ${fmtUsd(r.costUsd)} · ${r.byAgent} (${r.model})`);
      flash('Propuesta generada: revísala y ajústala antes de crear');
    } catch (e: any) { setError(e.message); } finally { setDrafting(false); setAuth(false); }
  };

  const create = async () => {
    setError(null); setSaving(true);
    try {
      const a = await api.createAgent(ws.slug, {
        scope, projectId: scope === 'project' ? project.id : null, name: name.trim(), role: role.trim(), reportsTo, collaborates: collab,
        evaluation: evaluation.map(e => e.trim()).filter(Boolean), config: { ...cfg, name: name.trim(), responsibilities: cfg.responsibilities.filter(Boolean) }
      });
      formDraft.clear(); flash(`Agente «${a.config.name}» creado · inactivo`); navigate(`/equipo/${a.id}`);
    } catch (e: any) { setError(e.message); } finally { setSaving(false); }
  };

  const valid = name.trim().length >= 2 && role.trim().length >= 2 && cfg.specialization.trim().length > 0 && cfg.responsibilities.length > 0 && !!cfg.model && !!prov && prov.status === 'connected';

  return (
    <Shell crumb={<>Equipo de IA / Nuevo agente</>}>
      <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <DraftNote status={formDraft.status === 'restored' || formDraft.status === 'error' ? formDraft.status : 'idle'} onDiscard={formDraft.clear} />
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Link className="lnk sm13" to="/equipo">← Equipo de IA</Link>
            <h1 className="h1" style={{ fontSize: 26 }}>Nuevo agente especializado</h1>
            <p className="med" style={{ maxWidth: '70ch' }}>Define identidad, ámbito, relaciones, modelo y permisos. Se crea <strong>inactivo</strong>, sin ninguna llamada a modelos, y podrás editarlo después. Si quieres, el Agente de Onboarding puede proponerte la configuración.</p>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Link className="btn btn-ghost" to="/equipo">Cancelar</Link>
            <button className="btn btn-primary" onClick={create} disabled={!valid || saving}>{saving ? 'Creando…' : 'Crear agente'}</button>
          </div>
        </div>
        {error && <Notice kind="err">{error}</Notice>}
        {!connected.length && <Notice kind="warn">Necesitas un proveedor conectado para asignar modelo al agente. <Link className="lnk" to="/configuracion/proveedor">Conectar proveedor</Link>.</Notice>}

        <section className="card">
          <div className="card-h"><div><div className="h3">Proponer con IA</div><div className="small muted">El Agente de Onboarding redacta la configuración a partir de tu descripción. Tú revisas y decides.</div></div><Chip tone="warn" xs>consume IA · requiere autorización</Chip></div>
          <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <textarea className="input" value={desc} onChange={e => setDesc(e.target.value)} placeholder="Ej.: Un agente que redacte y mantenga la documentación técnica del proyecto a partir del código, con acceso de lectura al repositorio y sin permisos de ejecución." aria-label="Descripción del agente" />
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <label className="ck" style={{ flex: 1, minWidth: 260 }}><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} disabled={!est} /><span>Autorizo <strong>una</strong> llamada de {est?.byAgent ?? 'Agente de Onboarding'} ({est ? <span className="mono">{est.model}</span> : '—'}) con costo estimado <strong>≈ {fmtUsd(est?.estimatedUsd ?? 0)}</strong> (tope {fmtUsd(Math.max(0.05, (est?.estimatedUsd ?? 0.05) * 3))}).</span></label>
              <button className="btn btn-secondary" onClick={propose} disabled={!auth || drafting || desc.trim().length < 10}>{drafting ? <span className="spin" /> : Icon.arrow()}{drafting ? 'Proponiendo…' : 'Generar propuesta'}</button>
            </div>
            {draftCost && <Notice kind="ok"><strong>Propuesta aplicada al formulario.</strong> Consumo real: <span className="mono">{draftCost}</span>. {rationale && <>Razonamiento del agente: {rationale}</>}</Notice>}
          </div>
        </section>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))', gap: 20, alignItems: 'start' }}>
          <section className="card"><div className="card-h"><div className="h3">Identidad y ámbito</div></div>
            <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div><div className="label">Ámbito</div><div className="seg" role="group" aria-label="Ámbito">
                <button aria-pressed={scope === 'project'} onClick={() => { setScope('project'); setReportsTo('pj-coordinador'); }}>Proyecto · {project.name}</button>
                <button aria-pressed={scope === 'workspace'} onClick={() => { setScope('workspace'); setReportsTo('ws-gestor'); }}>Espacio · {ws.name}</button></div>
                <div className="help">{scope === 'project' ? 'Solo accede al conocimiento y agentes de este proyecto.' : 'Accede a todos los proyectos del espacio.'}</div></div>
              <div><label className="label" htmlFor="n-name">Nombre</label><input id="n-name" className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Ej.: Documentador Técnico" /></div>
              <div><label className="label" htmlFor="n-role">Rol organizacional</label><input id="n-role" className="input" value={role} onChange={e => setRole(e.target.value)} placeholder="Ej.: Documentación y comunicación técnica" /></div>
              <div><label className="label" htmlFor="n-spec">Especialización</label><textarea id="n-spec" className="input" value={cfg.specialization} onChange={e => edit({ specialization: e.target.value })} placeholder="Qué hace y qué no hace este agente." /></div>
            </div></section>

          <section className="card"><div className="card-h"><div className="h3">Responsabilidades</div><span className="small muted">{cfg.responsibilities.length} definidas</span></div>
            <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column' }}>
                {cfg.responsibilities.map((t, i) => <li key={i} className="rrow"><span className="mono small muted">{String(i + 1).padStart(2, '0')}</span><span style={{ flex: 1 }}>{t}</span><button className="xbtn" onClick={() => edit({ responsibilities: cfg.responsibilities.filter((_, j) => j !== i) })} aria-label="Quitar">{Icon.x()}</button></li>)}
                {!cfg.responsibilities.length && <li className="muted sm13">Añade al menos una responsabilidad.</li>}
              </ul>
              <form style={{ display: 'flex', gap: 8 }} onSubmit={e => { e.preventDefault(); const t = newResp.trim(); if (!t) return; edit({ responsibilities: [...cfg.responsibilities, t] }); setNewResp(''); }}>
                <input className="input" value={newResp} onChange={e => setNewResp(e.target.value)} placeholder="Añadir una responsabilidad…" aria-label="Nueva responsabilidad" style={{ flex: 1 }} /><button className="btn btn-secondary" type="submit" disabled={!newResp.trim()}>Añadir</button>
              </form>
            </div></section>

          <section className="card"><div className="card-h"><div className="h3">Relaciones organizacionales</div></div>
            <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div><label className="label" htmlFor="n-boss">Reporta a</label><select id="n-boss" className="input" value={reportsTo} onChange={e => setReportsTo(e.target.value)}>
                <option value="owner">Tú · propietario del espacio</option>
                {candidates.map(a => <option key={a.id} value={a.key}>{a.config.name} · {a.template.role}</option>)}</select></div>
              <div><div className="label">Colabora con</div><div style={{ display: 'flex', flexDirection: 'column' }}>
                {candidates.map(a => <label key={a.id} className="krow"><input className="cb" type="checkbox" checked={collab.includes(a.key)} onChange={e => setCollab(e.target.checked ? [...collab, a.key] : collab.filter(k => k !== a.key))} /><span style={{ flex: 1 }}>{a.config.name}</span><span className="small muted">{a.template.role}</span></label>)}
              </div></div>
            </div></section>

          <section className="card"><div className="card-h"><div className="h3">Modelo y esfuerzo</div></div>
            <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div><label className="label" htmlFor="n-prov">Proveedor</label><select id="n-prov" className="input" value={cfg.provider} onChange={e => { const p = providers.find(x => x.id === e.target.value)!; edit({ provider: p.id, model: p.defaultModel ?? p.models[0]?.id ?? '' }); }}>
                {providers.map(p => <option key={p.id} value={p.id} disabled={p.status !== 'connected'}>{p.name} · {p.status === 'connected' ? 'conectado' : 'no conectado'}</option>)}</select></div>
              <div><label className="label" htmlFor="n-model">Modelo preferido</label><select id="n-model" className="input mono" value={cfg.model} onChange={e => edit({ model: e.target.value })}>{(prov?.models ?? []).map(m => <option key={m.id} value={m.id}>{m.name}  ·  {m.id}</option>)}</select>
                <div className="help">{model ? `${model.description} ${model.supportsEffort ? 'Admite esfuerzo ajustable.' : 'No admite ajuste de esfuerzo.'}` : ''}</div></div>
              <div><div className="label">Esfuerzo de razonamiento</div><div className="seg" role="group">{(['low', 'medium', 'high'] as const).map(k => <button key={k} aria-pressed={cfg.effort === k} disabled={!model?.supportsEffort} onClick={() => edit({ effort: k })}>{EFFORT_LABELS[k]}</button>)}</div></div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))', gap: 14 }}>
                <div><label className="label" htmlFor="n-limit">Límite mensual (USD)</label><input id="n-limit" className="input mono" type="number" min={0} step={1} value={cfg.monthlyLimitUsd} onChange={e => edit({ monthlyLimitUsd: Number(e.target.value) })} /></div>
                <div><label className="label" htmlFor="n-pertask">Autorización por encima de (USD/tarea)</label><input id="n-pertask" className="input mono" type="number" min={0} step={0.5} value={cfg.perTaskAuthUsd} onChange={e => edit({ perTaskAuthUsd: Number(e.target.value) })} /></div>
              </div>
            </div></section>

          <section className="card"><div className="card-h"><div><div className="h3">Capacidades</div><div className="small muted">Deciden su papel en cada historia (sin IA): quién planifica, implementa, revisa o consulta.</div></div><span className="small muted">{(cfg.capabilities ?? []).length} de {CAPABILITIES.length}</span></div>
            <div className="card-b" style={{ display: 'flex', flexDirection: 'column' }}>
              {CAPABILITIES.map(c => { const on = (cfg.capabilities ?? []).includes(c.id); const needs = c.id === 'implementar' ? 'write_repo' : c.role === 'reviewer' || c.role === 'consultant' ? 'read_repo' : null; return <label key={c.id} className="krow"><input className="cb" type="checkbox" checked={on} onChange={e => edit({ capabilities: e.target.checked ? [...(cfg.capabilities ?? []), c.id] : (cfg.capabilities ?? []).filter(x => x !== c.id) })} /><span style={{ flex: 1 }}>{c.label} <span className="small muted">· {c.role === 'planner' ? 'planificador' : c.role === 'implementer' ? 'implementador' : c.role === 'reviewer' ? 'revisor' : 'consultor'}{needs && !cfg.tools[needs] && on ? ` · necesita la herramienta ${needs}` : ''}</span></span></label>; })}
            </div></section>

          <section className="card"><div className="card-h"><div className="h3">Herramientas y permisos</div><span className="small muted">{TOOLS.filter(t => cfg.tools[t.id]).length} de {TOOLS.length}</span></div>
            <div className="card-b" style={{ display: 'flex', flexDirection: 'column' }}>
              {TOOLS.map(t => <div key={t.id} className="trow"><input className="sw" type="checkbox" id={`n-tool-${t.id}`} checked={!!cfg.tools[t.id]} onChange={e => edit({ tools: { ...cfg.tools, [t.id]: e.target.checked } })} aria-label={TOOL_LABELS[t.id].name} />
                <label htmlFor={`n-tool-${t.id}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, cursor: 'pointer', minWidth: 0 }}><span style={{ fontWeight: 500, fontSize: 13 }}>{TOOL_LABELS[t.id].name}</span><span className="small muted">{TOOL_LABELS[t.id].desc}</span></label>
                <Chip tone={t.risk === 'auth' ? 'warn' : ''} xs>{t.risk === 'auth' ? 'requiere autorización' : 'local'}</Chip></div>)}
            </div></section>

          <section className="card"><div className="card-h"><div className="h3">Conocimiento y evaluación</div></div>
            <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', flexDirection: 'column' }}>{KNOWLEDGE.map(k => <label key={k.id} className="krow"><input className="cb" type="checkbox" checked={!!cfg.knowledge[k.id]} onChange={e => edit({ knowledge: { ...cfg.knowledge, [k.id]: e.target.checked } })} /><span style={{ flex: 1 }}>{KNOWLEDGE_LABELS[k.id]}</span></label>)}</div>
              <div><div className="label">Criterios de evaluación</div><div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{evaluation.map((v, i) => <input key={i} className="input" value={v} onChange={e => setEvaluation(evaluation.map((x, j) => j === i ? e.target.value : x))} placeholder={`Criterio ${i + 1}`} aria-label={`Criterio ${i + 1}`} />)}</div>
                <button className="lnk small" style={{ marginTop: 6 }} onClick={() => setEvaluation([...evaluation, ''])}>Añadir criterio</button></div>
            </div></section>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}><Link className="btn btn-ghost" to="/equipo">Cancelar</Link><button className="btn btn-primary" onClick={create} disabled={!valid || saving}>{saving ? 'Creando…' : 'Crear agente'}</button></div>
      </main>
    </Shell>
  );
}
