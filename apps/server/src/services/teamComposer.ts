import type { Agent, Capability, TeamComposition, TeamMember, TeamOverride, TeamRole } from '@portal-ia/domain';
import { isRetired } from '@portal-ia/domain';

/** HU-159 · motivo con el que se excluye a un agente desactivado por una decisión organizativa (reversible). */
export const RETIRED_REASON = 'retirado por decisión organizativa';

/**
 * Compositor de equipos (M3). Determinista, sin llamadas a la IA: decide quién planifica, quién implementa, quién revisa
 * y qué especialistas aportan consulta en una historia, a partir de las CAPACIDADES declaradas de cada agente, sus
 * herramientas (el backend las exige después en la política) y su ámbito (solo agentes del proyecto o del espacio).
 * Cada miembro lleva el motivo de su selección; cada excluido, la razón. El propietario puede anular (añadir/quitar).
 */
const STOP = new Set(['para', 'como', 'desde', 'hasta', 'sobre', 'entre', 'cada', 'este', 'esta', 'estos', 'estas', 'cuando', 'donde', 'mejorar', 'mejora', 'nuevo', 'nueva', 'nuevos', 'nuevas', 'portal', 'proyecto', 'historia', 'historias', 'usuario', 'usuarios', 'propietario', 'equipo', 'agente', 'agentes', 'cambios', 'cambio', 'poder', 'hacer', 'tiene', 'tienen', 'debe', 'deben', 'segun', 'tras', 'todo', 'todos', 'toda', 'todas', 'parte', 'forma', 'tipo', 'caso', 'casos', 'tarea', 'tareas', 'archivo', 'archivos', 'codigo', 'pantalla', 'pantallas', 'boton', 'mostrar', 'muestra', 'ver', 'crear', 'permitir', 'anadir', 'agregar', 'quitar', 'solicitud', 'solicitudes', 'proceso', 'procesos', 'datos', 'lista', 'listas', 'campo', 'campos', 'formulario', 'texto', 'valor', 'valores', 'junto', 'dentro', 'fuera', 'misma', 'mismo', 'otra', 'otro', 'otros', 'otras', 'solo', 'sola', 'menos', 'mucho', 'poco', 'esperado', 'resultado', 'aceptacion', 'criterio', 'plan', 'planes', 'propone', 'proponer', 'revisa', 'revisar', 'realizar', 'cumplir', 'cumple']);
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tokens = (s: string) => new Set(norm(s).split(/[^a-z0-9]+/).map(t => t.replace(/(es|s)$/, '')).filter(t => t.length >= 4 && !STOP.has(t)));

function agentText(a: Agent): string {
  return [a.config.name, a.template.role, a.config.specialization, ...a.config.responsibilities, ...(a.config.capabilities ?? [])].join(' ');
}

export interface StoryText { title: string; criterion?: string; description?: string }

/** Coincidencias de vocabulario entre la historia y un agente (palabras distintivas: no comunes a la mayoría del equipo). */
export function matchScore(story: StoryText, agent: Agent, team: Agent[]): { score: number; words: string[] } {
  const st = tokens(`${story.title} ${story.criterion ?? ''} ${story.description ?? ''}`);
  const mine = tokens(agentText(agent));
  const others = team.filter(x => x.id !== agent.id).map(x => tokens(agentText(x)));
  const words: string[] = [];
  for (const w of st) {
    if (!mine.has(w)) continue;
    const common = others.filter(o => o.has(w)).length;
    if (team.length > 2 && common >= Math.ceil((team.length - 1) / 2)) continue; // palabra genérica del equipo
    words.push(w);
  }
  return { score: words.length, words };
}

const has = (a: Agent, c: Capability) => (a.config.capabilities ?? []).includes(c);
const tool = (a: Agent, t: string) => !!a.config.tools?.[t];

export function composeTeam(agents: Agent[], projectId: string, story: StoryText, opts: { skipQa?: boolean; override?: TeamOverride | null } = {}): TeamComposition {
  // Ámbito: agentes del proyecto; los de espacio solo entran por anulación manual.
  // Los agentes retirados (template.retiredAt) no participan nunca; se listan como excluidos con el motivo.
  const pool = agents.filter(a => a.projectId === projectId && !isRetired(a.template));
  const members: TeamMember[] = []; const excluded: TeamComposition['excluded'] = [];
  for (const a of agents) if (a.projectId === projectId && isRetired(a.template)) excluded.push({ agentId: a.id, agentName: a.config.name, reason: RETIRED_REASON });
  const used = new Set<string>();
  const pick = (role: TeamRole, cap: Capability, requiredTool: string | null, preferKey: string, label: string): TeamMember | null => {
    const cands = pool.filter(a => has(a, cap) && !used.has(a.id));
    const ok = cands.filter(a => !requiredTool || tool(a, requiredTool));
    for (const a of cands) if (requiredTool && !tool(a, requiredTool)) excluded.push({ agentId: a.id, agentName: a.config.name, reason: `tiene la capacidad «${cap}» pero le falta la herramienta «${requiredTool}»` });
    const chosen = ok.find(a => a.key === preferKey) ?? ok.sort((a, b) => a.config.name.localeCompare(b.config.name))[0];
    if (!chosen) return null;
    used.add(chosen.id);
    const m: TeamMember = { agentId: chosen.id, agentName: chosen.config.name, agentKey: chosen.key, role, capability: cap, model: chosen.config.model, reason: `${label}: capacidad «${cap}»${requiredTool ? ` y herramienta «${requiredTool}»` : ''}${chosen.key === preferKey ? ' (plantilla del rol)' : ''}` };
    members.push(m); return m;
  };
  pick('planner', 'planificar', null, 'pj-coordinador', 'Planifica');
  pick('implementer', 'implementar', 'write_repo', 'pj-dev', 'Implementa');
  if (!opts.skipQa) pick('reviewer', 'revisar_calidad', 'read_repo', 'pj-qa', 'Revisa');
  // Consultores por coincidencia de vocabulario (máx. 2), nunca el implementador/planificador ya elegidos.
  const consultCaps: Capability[] = ['consultar_arquitectura', 'consultar_ux', 'revisar_seguridad', 'consultar', 'documentar', 'generar_pruebas'];
  // Si el propietario omitió la revisión QA, el revisor no vuelve a entrar como consultor (ni su costo).
  const qaSkipped = (a: Agent) => !!opts.skipQa && has(a, 'revisar_calidad');
  for (const a of pool) if (!used.has(a.id) && qaSkipped(a)) { used.add(a.id); excluded.push({ agentId: a.id, agentName: a.config.name, reason: 'revisión QA omitida por el propietario' }); }
  const scored = pool.filter(a => !used.has(a.id) && consultCaps.some(c => has(a, c))).map(a => ({ a, m: matchScore(story, a, pool) })).filter(x => x.m.score >= 1).sort((x, y) => y.m.score - x.m.score || x.a.config.name.localeCompare(y.a.config.name));
  for (const { a, m } of scored.slice(0, 2)) {
    used.add(a.id);
    members.push({ agentId: a.id, agentName: a.config.name, agentKey: a.key, role: 'consultant', capability: consultCaps.find(c => has(a, c)) ?? null, model: a.config.model, reason: `Consulta: la historia menciona «${m.words.slice(0, 3).join('», «')}», dentro de su especialidad` });
  }
  for (const a of pool) if (!used.has(a.id) && !excluded.some(e => e.agentId === a.id)) excluded.push({ agentId: a.id, agentName: a.config.name, reason: (a.config.capabilities ?? []).length ? 'sin coincidencia con la historia' : 'sin capacidades declaradas' });
  // Anulación manual del propietario
  const ov = opts.override ?? null;
  if (ov) {
    for (const id of ov.remove ?? []) {
      const i = members.findIndex(m => m.agentId === id);
      if (i < 0) continue;
      if (members[i].role === 'planner' || members[i].role === 'implementer') continue; // imprescindibles
      const [r] = members.splice(i, 1); excluded.push({ agentId: r.agentId, agentName: r.agentName, reason: 'quitado por el propietario' });
    }
    for (const id of ov.add ?? []) {
      if (members.some(m => m.agentId === id)) continue;
      const a = agents.find(x => x.id === id); if (!a) continue;
      if (a.projectId && a.projectId !== projectId) continue; // fuera de ámbito: nunca
      if (isRetired(a.template)) { // retirado: tampoco por anulación manual
        if (!excluded.some(e => e.agentId === a.id)) excluded.push({ agentId: a.id, agentName: a.config.name, reason: RETIRED_REASON });
        continue;
      }
      const ex = excluded.findIndex(e => e.agentId === id); if (ex >= 0) excluded.splice(ex, 1);
      const cap = consultCaps.find(c => has(a, c)) ?? null;
      members.push({ agentId: a.id, agentName: a.config.name, agentKey: a.key, role: 'consultant', capability: cap, model: a.config.model, reason: 'añadido por el propietario', override: true });
    }
  }
  return { members, excluded, override: ov, aiCalls: 0 };
}

/** Orden de ejecución de los pasos: plan → consultas → implementación → revisión. */
export function orderedMembers(t: TeamComposition): TeamMember[] {
  const order: TeamRole[] = ['planner', 'consultant', 'implementer', 'reviewer'];
  return [...t.members].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
}
