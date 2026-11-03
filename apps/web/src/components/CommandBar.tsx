import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
      // El nombre (o la primera palabra del nombre) más largo que coincide con lo escrito tras «@»: «@Arquitecto revisa…».
      const after = norm(t.slice(1));
      const cands = agents.flatMap(x => [norm(x.name), norm(x.name).split(/[\s,]+/)[0]].map(k => ({ x, k }))).filter(c => c.k.length >= 2 && after.startsWith(c.k) && /^($|[\s,:])/.test(after.slice(c.k.length)));
      const best = cands.sort((p, q) => q.k.length - p.k.length)[0];
      if (best) return { kind: 'agent' as const, label: `Conversar con ${best.x.name}`, id: best.x.id, rest: t.slice(1 + best.k.length).replace(/^[\s,:]+/, '') };
    }
    const dm = norm(t).match(/^(?:equipo de |departamento de |el equipo de |el departamento de )?([^,:]{2,40})[,:]/);
    if (dm) { const d = departments.find(x => norm(x.name) === dm[1].trim()); if (d) return { kind: 'department' as const, label: `Petición al departamento ${d.name}`, dep: d, rest: t.replace(/^[^,:]+[,:]\s*/, '') }; }
    return { kind: 'assistant' as const, label: 'El Asistente lo estudia y te propone cómo hacerlo' };
  }, [text, agents, departments]);
  const go = () => {
    if (!route) return;
    if (route.kind === 'agent') { sessionStorage.setItem(`portal-ia.chat.prefill.${route.id}`, route.rest); onAgent(route.id); }
    else if (route.kind === 'department') { sessionStorage.setItem(`portal-ia.dep.prefill.${route.dep.slug}`, route.rest); onDepartment(route.dep); }
    else navigate('/asistente', { state: { draft: text.trim() } });
    setText('');
  };
  return <div>
    <form className="cmd-bar" onSubmit={e => { e.preventDefault(); go(); }} role="search" aria-label="Pide algo a tu empresa">
      <label className="sr" htmlFor="cmd">Pide algo a tu empresa</label>
      <input id="cmd" className="input" value={text} onChange={e => setText(e.target.value)} placeholder="Pide algo a tu empresa… («@Arquitecto revisa…», «Marketing: investiga…» o cualquier idea)" autoComplete="off" />
      <button className="btn btn-primary" type="submit" disabled={!route}>Enviar</button>
    </form>
    <div className="cmd-route" aria-live="polite">{route ? `→ ${route.label}` : ''}</div>
  </div>;
}
