import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { resolveAgentMention } from '@portal-ia/domain';
import { officeDisplayName } from '../lib/osApi.ts';
import type { Department, OfficeAgent } from '../lib/osApi.ts';

/**
 * Barra de órdenes: «@Nombre …» abre la conversación con ese agente; «Marketing: …» (o «Equipo de Marketing, …») prepara
 * una petición a ese departamento; cualquier otra cosa va al Asistente, que decide si basta una respuesta, un agente, un
 * encargo o una historia. La ruta se muestra antes de enviar; nada se ejecuta sin tu confirmación.
 */
export function CommandBar({ agents, departments, onAgent, onDepartment }: { agents: OfficeAgent[]; departments: Department[]; onAgent: (id: string) => void; onDepartment: (d: Department) => void }) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const route = useMemo(() => {
    const t = text.trim(); if (!t) return null;
    if (t.startsWith('@')) {
      // «@Lucía revisa…» o «@Arquitecto revisa…»: resolución pura en el dominio (resolveAgentMention, con NFC).
      // Si la coincidencia encaja con varios agentes, elige el propietario.
      const m = resolveAgentMention(t, agents);
      if (m?.kind === 'agent') return { kind: 'agent' as const, label: `Conversar con ${officeDisplayName(m.agent)}`, id: m.agent.id, rest: m.rest };
      if (m?.kind === 'ambiguous') return { kind: 'ambiguous' as const, label: `«@${m.mention}» coincide con ${m.options.length} agentes: elige con quién conversar`, options: m.options, rest: m.rest };
    }
    const dm = norm(t).match(/^(?:equipo de |departamento de |el equipo de |el departamento de )?([^,:]{2,40})[,:]/);
    if (dm) { const d = departments.find(x => norm(x.name) === dm[1].trim()); if (d) return { kind: 'department' as const, label: `Petición al departamento ${d.name}`, dep: d, rest: t.replace(/^[^,:]+[,:]\s*/, '') }; }
    return { kind: 'assistant' as const, label: 'El Asistente lo estudia y te propone cómo hacerlo' };
  }, [text, agents, departments]);
  const openAgent = (id: string, rest: string) => { sessionStorage.setItem(`portal-ia.chat.prefill.${id}`, rest); onAgent(id); setText(''); };
  const go = () => {
    if (!route || route.kind === 'ambiguous') return;
    if (route.kind === 'agent') { sessionStorage.setItem(`portal-ia.chat.prefill.${route.id}`, route.rest); onAgent(route.id); }
    else if (route.kind === 'department') { sessionStorage.setItem(`portal-ia.dep.prefill.${route.dep.slug}`, route.rest); onDepartment(route.dep); }
    else navigate('/asistente', { state: { draft: text.trim() } });
    setText('');
  };
  return <div>
    <form className="cmd-bar" onSubmit={e => { e.preventDefault(); go(); }} role="search" aria-label="Pide algo a tu empresa">
      <label className="sr" htmlFor="cmd">Pide algo a tu empresa</label>
      <input id="cmd" className="input" value={text} onChange={e => setText(e.target.value)} placeholder="Pide algo a tu empresa… («@Arquitecto revisa…», «Marketing: investiga…» o cualquier idea)" autoComplete="off" />
      <button className="btn btn-primary" type="submit" disabled={!route || route.kind === 'ambiguous'}>Enviar</button>
    </form>
    <div className="cmd-route" aria-live="polite">{route ? `→ ${route.label}` : ''}</div>
    {route?.kind === 'ambiguous' && <div className="cmd-route" role="group" aria-label="Elige el agente">
      {route.options.map(a => <button key={a.id} type="button" className="btn" onClick={() => openAgent(a.id, route.rest)}>{officeDisplayName(a)}</button>)}
    </div>}
  </div>;
}
