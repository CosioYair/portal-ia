import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Agent, AgentContextScope } from '@portal-ia/domain';
import { workplaceLabel } from '@portal-ia/domain';
import { ContextScopeChips } from './AgentWizard.tsx';
import { api } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { EFFORT_LABELS } from '../lib/labels.ts';
import type { OfficeAgent } from '../lib/osApi.ts';
import { Avatar, Chip, Icon } from '../components/ui.tsx';
import { STATE_TEXT } from '../components/AgentFigure.tsx';
import { OrgEvaluationPanel } from '../components/OrgEvaluationPanel.tsx';
import { GauntletProposal } from '../components/Gauntlet.tsx';
import { Disclosure } from '../components/Disclosure.tsx';

/**
 * Oficina › Organización (antes «Equipo de IA»): quién reporta a quién, relaciones y configuración, evaluar la
 * organización y el Evaluador Gauntlet. El estado de cada agente es el REAL de la Oficina (calculado en el servidor);
 * cada agente se abre en su panel, y su ficha avanzada sigue en Configuración › Ajustes avanzados.
 */
export function OrganizationView({ office, onOpen }: { office: OfficeAgent[]; onOpen: (agentId: string, tab?: string) => void }) {
  const { status, providers } = useApp();
  const ws = status.workspace!;
  const [agents, setAgents] = useState<Agent[]>([]);
  const [evalOpen, setEvalOpen] = useState(false);
  // El organigrama abre centrado en su raíz (el propietario), no en una esquina vacía.
  const orgBox = useRef<HTMLDivElement>(null);
  useEffect(() => { const b = orgBox.current; if (b && agents.length) b.scrollLeft = Math.max(0, (b.scrollWidth - b.clientWidth) / 2); }, [agents.length]);
  const reload = () => api.agents(ws.slug).then(list => setAgents(list.filter(a => a.scope === 'workspace' || a.projectId === status.project?.id)));
  useEffect(() => { void reload(); }, [ws.slug, status.project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const byKey = (k: string) => agents.find(a => a.key === k);
  const stateOf = (id: string) => office.find(o => o.id === id)?.state ?? null;
  // Ámbito real (contextScope), no Template.scope: el del agente o, si no viene, el de la vista de la Oficina.
  const contextOf = (a: Agent): AgentContextScope | null => a.contextScope ?? office.find(o => o.id === a.id)?.contextScope ?? null;
  const companyName = ws.name ?? null;
  const model = (a: Agent) => providers.find(p => p.id === a.config.provider)?.models.find(m => m.id === a.config.model);
  // Retirado = desactivado de forma reversible por una propuesta aceptada (template.retiredAt), sin borrar la fila.
  const retiredAt = (a: Agent): string | null => (a.template as unknown as { retiredAt?: string | null }).retiredAt ?? null;
  const isRetired = (a: Agent) => !!retiredAt(a);
  const retiredLabel = (a: Agent) => {
    const at = retiredAt(a); if (!at) return 'Retirado';
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? 'Retirado' : `Retirado · ${d.toLocaleDateString('es-ES')}`;
  };
  const stateChip = (a: Agent) => { const st = stateOf(a.id); return isRetired(a) ? <Chip xs>{retiredLabel(a)}</Chip> : <span className={`state-pill state-${st ?? 'idle'}`}>{STATE_TEXT[st ?? 'idle']}</span>; };

  // Organigrama dinámico: se construye desde las relaciones reales «reporta a», así los agentes nuevos aparecen en su sitio.
  const childrenOf = (parentKey: string) => agents.filter(a => a.template.reportsTo === parentKey).sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'workspace' ? -1 : 1) || a.createdAt.localeCompare(b.createdAt));
  const Children = ({ parentKey, depth = 0 }: { parentKey: string; depth?: number }) => {
    const kids = childrenOf(parentKey); if (!kids.length || depth > 6) return null;
    return <ul>{kids.map(k => <li key={k.id}><Node k={k.key} /><Children parentKey={k.key} depth={depth + 1} /></li>)}</ul>;
  };
  const Node = ({ k }: { k: string }) => {
    const a = byKey(k); if (!a) return <div className="onode onode-missing" />;
    const company = a.scope === 'workspace';
    return <button className={`onode${isRetired(a) ? ' onode-retired' : ''}`} onClick={() => onOpen(a.id, 'configuracion')} title={isRetired(a) ? retiredLabel(a) : `Abrir el panel de ${a.config.name}`}>
      <span className="onode-top"><Avatar initials={a.template.initials} ws={company} /><ContextScopeChips scope={contextOf(a)} companyName={companyName} /></span>
      <span className="onode-name">{a.config.name}</span><span className="small muted">{a.template.role}</span>
      <span className="small muted">Trabaja en: {workplaceLabel(a.scope).toLowerCase()}</span>
      <span className="onode-foot">{stateChip(a)}<span className="small mono muted" style={{ marginLeft: 'auto' }}>{model(a)?.name ?? a.config.model}</span></span>
    </button>;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="section-title">
        <div><h2 className="h2">Organización de la empresa y del proyecto</h2><p className="med lede-2l">Quién reporta a quién. Ningún agente consume créditos hasta que autorices su trabajo.</p>
          <p className="small muted" style={{ margin: '4px 0 0' }}>{agents.length} agentes · {agents.filter(a => a.scope === 'workspace').length} trabajan en toda la empresa · {agents.filter(a => a.scope === 'project').length} en el proyecto{agents.some(isRetired) ? ` · ${agents.filter(isRetired).length} retirados` : ''}</p></div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setEvalOpen(o => !o)} aria-expanded={evalOpen}>{Icon.org()}Evaluar organización</button>
          <Link className="btn btn-ghost btn-sm" to="/equipo/nuevo" title="Formulario con todos los campos (requiere proveedor de API)">Formulario completo de agente</Link>
        </div>
      </div>
      {evalOpen && <OrgEvaluationPanel slug={ws.slug} defaultProjectId={status.project?.id ?? null} onClose={() => setEvalOpen(false)} />}
      <Disclosure title="Más información">
        <p className="sm13 med" style={{ lineHeight: 1.5, maxWidth: '78ch' }}>Ningún agente llama a modelos ni consume créditos hasta que autorices su trabajo. Abre un agente para revisar o editar su configuración; sus ajustes avanzados (modelo, límites, capacidades) están en su panel › Configuración.</p>
      </Disclosure>

      <section className="card">
        <div className="card-h"><div className="h3">Estructura organizativa</div><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><span className="small muted">Ámbito:</span><Chip xs>Proyecto</Chip><Chip tone="accent" xs>Empresa</Chip><Chip tone="ok" xs>General</Chip><Chip xs>Retirado</Chip></div></div>
        <div ref={orgBox} className="card-b org-scroll" tabIndex={0} aria-label="Organigrama (desplázate para ver todo)">
          <ul className="org"><li>
            <div className="onode-owner"><span className="avatar" style={{ width: 28, height: 28 }}>{Icon.user(13)}</span><span style={{ display: 'flex', flexDirection: 'column' }}><span style={{ fontWeight: 600, fontSize: 13, color: 'var(--color-text)' }}>Tú</span><span className="small muted">Propietario de la empresa</span></span></div>
            <Children parentKey="owner" />
          </li></ul>
        </div>
      </section>

      {status.project && <GauntletProposal slug={ws.slug} projectId={status.project.id} onCreated={() => void reload()} />}

      <section className="card">
        <div className="card-h"><div className="h3">Relaciones y configuración</div><span className="small muted">Se edita en el panel de cada agente</span></div>
        <div style={{ overflowX: 'auto' }}><table className="tbl tbl-cards">
          <thead><tr><th>Agente</th><th>Rol</th><th>Ámbito</th><th>Dónde trabaja</th><th>Reporta a</th><th>Modelo preferido</th><th>Esfuerzo</th><th>Estado</th></tr></thead>
          <tbody>{agents.map(a => { const m = model(a); return <tr key={a.id} className={isRetired(a) ? 'row-retired' : undefined}>
            <td data-label="Agente"><button className="lnk" onClick={() => onOpen(a.id, 'configuracion')}>{a.config.name}</button></td><td data-label="Rol" className="med">{a.template.role}</td>
            <td data-label="Ámbito"><ContextScopeChips scope={contextOf(a)} companyName={companyName} /></td>
            <td data-label="Dónde trabaja" className="med">{workplaceLabel(a.scope)}</td>
            <td data-label="Reporta a" className="med">{a.template.reportsTo === 'owner' ? 'Tú (propietario)' : byKey(a.template.reportsTo)?.config.name ?? a.template.reportsTo}</td>
            <td data-label="Modelo" className="mono" style={{ fontSize: 12 }}>{m?.name ?? a.config.model}</td><td data-label="Esfuerzo" className="med">{m?.supportsEffort ? EFFORT_LABELS[a.config.effort] : 'no aplica'}</td>
            <td data-label="Estado">{stateChip(a)}</td></tr>; })}</tbody>
        </table></div>
      </section>
    </div>
  );
}
