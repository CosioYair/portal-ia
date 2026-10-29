import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Agent } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { EFFORT_LABELS } from '../lib/labels.ts';
import { Shell } from '../components/Shell.tsx';
import { Avatar, Chip, Icon, Notice } from '../components/ui.tsx';
import { OrgEvaluationPanel } from '../components/OrgEvaluationPanel.tsx';

export function Team() {
  const { status, providers, navigate } = useApp();
  const ws = status.workspace!;
  const [agents, setAgents] = useState<Agent[]>([]);
  const [evalOpen, setEvalOpen] = useState(false);
  useEffect(() => { api.agents(ws.slug).then(list => setAgents(list.filter(a => a.scope === 'workspace' || a.projectId === status.project?.id))); }, [ws.slug, status.project?.id]);

  const byKey = (k: string) => agents.find(a => a.key === k);
  const model = (a: Agent) => providers.find(p => p.id === a.config.provider)?.models.find(m => m.id === a.config.model);
  const active = agents.filter(a => a.status === 'active').length;

  // Organigrama dinámico: se construye desde las relaciones reales «reporta a», así los agentes nuevos aparecen en su sitio.
  const childrenOf = (parentKey: string) => agents.filter(a => a.template.reportsTo === parentKey).sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'workspace' ? -1 : 1) || a.createdAt.localeCompare(b.createdAt));
  const Children = ({ parentKey, depth = 0 }: { parentKey: string; depth?: number }) => {
    const kids = childrenOf(parentKey); if (!kids.length || depth > 6) return null;
    return <ul>{kids.map(k => <li key={k.id}><Node k={k.key} /><Children parentKey={k.key} depth={depth + 1} /></li>)}</ul>;
  };
  const Node = ({ k }: { k: string }) => {
    const a = byKey(k); if (!a) return <div className="onode" style={{ opacity: .4 }} />;
    const ws = a.scope === 'workspace';
    return <button className="onode" onClick={() => navigate(`/equipo/${a.id}`)}>
      <span className="onode-top"><Avatar initials={a.template.initials} ws={ws} /><Chip tone={ws ? 'accent' : ''} xs>{ws ? 'Espacio' : 'Proyecto'}</Chip></span>
      <span className="onode-name">{a.config.name}</span><span className="small muted">{a.template.role}</span>
      <span className="onode-foot"><span className={`dot ${a.status === 'active' ? 'dot-ok' : ''}`} /><span className="small muted">{a.status === 'active' ? 'Activo' : 'Inactivo'}</span><span className="small mono muted" style={{ marginLeft: 'auto' }}>{model(a)?.short ?? a.config.model}</span></span>
    </button>;
  };

  return (
    <Shell crumb="Equipo de IA">
      <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="eyebrow">Equipo de IA</div>
            <h1 className="h1" style={{ fontSize: 26 }}>Organización del espacio y del proyecto</h1>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><Chip tone="accent">{agents.filter(a => a.scope === 'workspace').length} agentes del espacio</Chip><Chip>{agents.filter(a => a.scope === 'project').length} agentes del proyecto</Chip><Chip dot={active ? 'ok' : ''}>{active} activos · {agents.length} configurados</Chip></div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}><button className="btn btn-secondary" onClick={() => setEvalOpen(o => !o)} aria-expanded={evalOpen}>{Icon.org()}Evaluar organización</button><Link className="btn btn-secondary" to="/equipo/nuevo">{Icon.arrow()}Nuevo agente especializado</Link><button className="btn btn-primary" disabled title="Requiere autorización de ejecución y presupuesto aprobado">Activar equipo</button></div>
        </div>
        {evalOpen && <OrgEvaluationPanel slug={ws.slug} defaultProjectId={status.project?.id ?? null} onClose={() => setEvalOpen(false)} />}
        <Notice kind="info">Todos los agentes están <strong>configurados pero inactivos</strong>. Ningún agente realiza llamadas a modelos ni consume créditos hasta que lo actives y autorices su ejecución. Selecciona un agente para revisar o editar su configuración.</Notice>

        <section className="card">
          <div className="card-h"><div className="h3">Estructura organizativa</div><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><Chip tone="accent" xs>Espacio</Chip><Chip xs>Proyecto</Chip><Chip xs dot="">Inactivo</Chip></div></div>
          <div className="card-b" style={{ overflowX: 'auto', padding: '24px 18px 28px' }}>
            <ul className="org"><li>
              <div className="onode-owner"><span className="avatar" style={{ width: 28, height: 28 }}>{Icon.user(13)}</span><span style={{ display: 'flex', flexDirection: 'column' }}><span style={{ fontWeight: 600, fontSize: 13, color: '#1A1B1E' }}>Tú</span><span className="small muted">Propietario del espacio</span></span></div>
              <Children parentKey="owner" />
            </li></ul>
          </div>
        </section>

        <section className="card">
          <div className="card-h"><div className="h3">Relaciones y configuración</div><span className="small muted">Editable desde cada agente</span></div>
          <div style={{ overflowX: 'auto' }}><table className="tbl">
            <thead><tr><th>Agente</th><th>Rol</th><th>Ámbito</th><th>Reporta a</th><th>Modelo preferido</th><th>Esfuerzo</th><th>Estado</th></tr></thead>
            <tbody>{agents.map(a => { const m = model(a); const ws = a.scope === 'workspace'; return <tr key={a.id}>
              <td><button className="lnk" onClick={() => navigate(`/equipo/${a.id}`)}>{a.config.name}</button></td><td className="med">{a.template.role}</td>
              <td><Chip tone={ws ? 'accent' : ''} xs>{ws ? 'Espacio' : 'Proyecto'}</Chip></td>
              <td className="med">{a.template.reportsTo === 'owner' ? 'Tú (propietario)' : byKey(a.template.reportsTo)?.config.name ?? a.template.reportsTo}</td>
              <td className="mono" style={{ fontSize: 12 }}>{m?.name ?? a.config.model}</td><td className="med">{m?.supportsEffort ? EFFORT_LABELS[a.config.effort] : 'no aplica'}</td>
              <td><Chip xs dot={a.status === 'active' ? 'ok' : ''}>{a.status === 'active' ? 'Activo' : 'Inactivo'}</Chip></td></tr>; })}</tbody>
          </table></div>
        </section>
      </main>
    </Shell>
  );
}
