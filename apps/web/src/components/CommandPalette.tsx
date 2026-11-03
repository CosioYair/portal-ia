import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { BacklogItem } from '@portal-ia/domain';
import { api } from '../lib/api.ts';
import { osApi, type OfficeAgent } from '../lib/osApi.ts';
import { useApp } from '../lib/store.ts';
import { OFFICE_VIEWS, SECTIONS, WORK_TABS } from '../lib/routes.ts';
import { Icon } from './ui.tsx';

/**
 * Buscar e ir a… (Ctrl+K). SOLO navega: pantallas, vistas, agentes e historias. Nunca ejecuta una acción, nunca marca
 * una autorización ni envía nada (lo que gasta o cambia algo se confirma en su pantalla, como siempre). Los textos se
 * pintan como texto (sin HTML), y las rutas se construyen con identificadores codificados.
 */
type Item = { id: string; group: string; label: string; hint?: string; to: string; icon: ReactNode; keywords: string };
/** Nombres antiguos y tareas frecuentes que también llevan a cada sección. */
const ALIASES: Record<string, string> = { decisiones: 'autorizaciones aprobar denegar pendientes bandeja', resumen: 'panel inicio proyecto', trabajo: 'backlog historias lotes ejecucion continua actividad procesos archivo', oficina: 'equipo agentes departamentos organizacion', ajustes: 'configuracion presupuestos proveedores sistema', asistente: 'pedir preguntar chat' };
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { status } = useApp(); const navigate = useNavigate();
  const slug = status.workspace?.slug ?? ''; const projectId = status.project?.id ?? null;
  const [q, setQ] = useState(''); const [sel, setSel] = useState(0);
  const [agents, setAgents] = useState<OfficeAgent[]>([]); const [stories, setStories] = useState<BacklogItem[]>([]);
  const input = useRef<HTMLInputElement>(null); const opener = useRef<Element | null>(document.activeElement);
  useEffect(() => { input.current?.focus(); }, []);
  // Atrás/Adelante o un cambio de empresa con la búsqueda abierta la cierran (nunca listas de otra empresa).
  const where = useLocation(); const openedAt = useRef({ key: where.key, slug });
  useEffect(() => { if (where.key !== openedAt.current.key || slug !== openedAt.current.slug) onClose(); }, [where.key, slug]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let live = true; setAgents([]); setStories([]);
    if (slug) void osApi.office(slug, projectId).then(o => { if (live) setAgents(o.agents.filter(a => a.state !== 'retired')); }).catch(() => undefined);
    if (slug && projectId) void api.backlog(slug, projectId).then(b => { if (live) setStories(b.filter(x => x.storyId)); }).catch(() => undefined);
    return () => { live = false; };
  }, [slug, projectId]);
  const close = () => { onClose(); (opener.current as HTMLElement | null)?.focus?.(); };
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const s of SECTIONS) if (!s.needsProject || projectId) out.push({ id: `s-${s.id}`, group: 'Ir a', label: s.label, hint: s.hint, to: s.path, icon: Icon.arrow(), keywords: `${s.label} ${s.hint} ${ALIASES[s.id] ?? ''}` });
    for (const v of OFFICE_VIEWS) if (v.to !== '/oficina') out.push({ id: `o-${v.view}`, group: 'Ir a', label: `Oficina › ${v.label}`, to: v.to, icon: Icon.building(), keywords: `oficina ${v.label} equipo agentes` });
    if (projectId) for (const t of WORK_TABS) out.push({ id: `w-${t.to}`, group: 'Ir a', label: `Trabajo › ${t.label}`, to: t.to, icon: Icon.kanban(), keywords: `trabajo ${t.label} ejecucion continua historias procesos` });
    if (projectId) out.push({ id: 'n-agent', group: 'Crear', label: 'Nuevo agente', hint: 'Abre el asistente de creación', to: '/oficina/nuevo-agente', icon: Icon.plus(), keywords: 'crear nuevo agente importar integrar' });
    if (projectId) out.push({ id: 'n-mant', group: 'Ir a', label: 'Revisión del proyecto: ramas y backlog', hint: 'Limpiar ramas, cerrar lo obsoleto', to: '/mantenimiento', icon: Icon.git(), keywords: 'revisar limpiar ramas github branches backlog obsoleto reconciliar worktrees mantenimiento' });
    if (projectId) out.push({ id: 'n-phase', group: 'Ir a', label: 'Etapas del proyecto', to: '/etapa', icon: Icon.history(), keywords: 'etapa nueva etapa linea base archivar' });
    out.push({ id: 'n-company', group: 'Crear', label: 'Nueva empresa o proyecto', hint: 'Ajustes › Empresas y proyectos', to: '/ajustes', icon: Icon.plus(), keywords: 'nueva empresa nuevo proyecto crear' });
    out.push({ id: 'n-ai', group: 'Ajustes', label: 'Motores de IA', hint: 'Claude Code, Codex y la API; habilitar Codex', to: '/ajustes?ver=motores', icon: Icon.bolt(), keywords: 'motor motores arnes arneses codex claude code api' });
    out.push({ id: 'n-prov', group: 'Ajustes', label: 'Proveedores y Claude Code', to: '/configuracion/proveedor', icon: Icon.plug(), keywords: 'proveedor proveedores clave api anthropic openai claude code suscripcion consola' });
    out.push({ id: 'n-budget', group: 'Ajustes', label: 'Presupuestos', to: '/presupuestos', icon: Icon.wallet(), keywords: 'presupuesto gasto limite' });
    for (const a of agents) out.push({ id: `a-${a.id}`, group: 'Agentes', label: a.name, hint: `${a.role} · ${a.department}`, to: `/oficina/agente/${encodeURIComponent(a.id)}/chat`, icon: Icon.agent(), keywords: `${a.name} ${a.role} ${a.department}` });
    for (const s of stories) out.push({ id: `h-${s.id}`, group: 'Historias', label: `${s.storyId} · ${s.title}`, to: `/historias/${encodeURIComponent(s.id)}`, icon: Icon.story(), keywords: `${s.storyId} ${s.title}` });
    return out;
  }, [agents, stories, projectId]);
  const words = norm(q).split(/\s+/).filter(Boolean);
  const rank = (i: Item) => { const l = norm(i.label); return l.startsWith(words.join(' ')) || l.split(/[\s›·]+/).some(x => x.startsWith(words[0])) ? 0 : words.every(w => l.includes(w)) ? 1 : 2; };
  const shown = (words.length
    ? items.filter(i => words.every(w => norm(i.keywords + ' ' + i.label).includes(w))).map((i, n) => ({ i, n, r: rank(i) })).sort((a, b) => a.r - b.r || a.n - b.n).map(x => x.i)
    : items.filter(i => i.group !== 'Historias')).slice(0, 40);
  useEffect(() => { setSel(0); }, [q]);
  const cur = Math.min(sel, Math.max(0, shown.length - 1));
  const go = (i: Item | undefined) => { if (!i) return; onClose(); navigate(i.to); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(v => Math.min(shown.length - 1, v + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(v => Math.max(0, v - 1)); }
    else if (e.key === 'Home') { setSel(0); } else if (e.key === 'End') { setSel(shown.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); go(shown[cur]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') e.preventDefault(); // el foco se queda en el campo (diálogo modal; las flechas recorren los resultados)
  };
  const curId = shown[cur]?.id;
  useEffect(() => { if (curId) document.getElementById(`cmdk-${curId}`)?.scrollIntoView({ block: 'nearest' }); }, [curId]);
  const groups: { name: string; key: string; items: { i: Item; k: number }[] }[] = [];
  shown.forEach((i, k) => { let g = groups.find(x => x.name === i.group); if (!g) { g = { name: i.group, key: String(groups.length), items: [] }; groups.push(g); } g.items.push({ i, k }); });
  return <div className="cmdk-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="cmdk" role="dialog" aria-modal="true" aria-label="Buscar e ir a">
      <div className="cmdk-input">{Icon.search(18)}
        <input ref={input} role="combobox" aria-expanded="true" aria-controls="cmdk-list" aria-autocomplete="list" aria-activedescendant={shown[cur] ? `cmdk-${shown[cur].id}` : undefined}
          aria-label="Buscar pantallas, agentes e historias" placeholder="Buscar pantallas, agentes, historias…" value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey} />
        <kbd className="kbd">Esc</kbd>
      </div>
      <span className="sr-only" role="status">{q ? `${shown.length} resultado${shown.length === 1 ? '' : 's'}` : ''}</span>
      <ul id="cmdk-list" className="cmdk-list" role="listbox" aria-label="Resultados" tabIndex={-1}>
        {shown.length === 0 && <li className="cmdk-empty" role="presentation">Sin resultados para «{q}».</li>}
        {groups.map(g => <li key={g.name} role="presentation"><div role="group" aria-labelledby={`cmdk-g-${g.key}`}>
          <div className="cmdk-group" id={`cmdk-g-${g.key}`} role="presentation">{g.name}</div>
          {g.items.map(({ i, k }) => <div key={i.id} id={`cmdk-${i.id}`} role="option" aria-selected={k === cur} className="cmdk-item" onMouseEnter={() => setSel(k)} onClick={() => go(i)}>
            {i.icon}<span>{i.label}</span>{i.hint && <span className="cmdk-hint">{i.hint}</span>}
          </div>)}
        </div></li>)}
      </ul>
      <div className="cmdk-foot"><span><kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> moverse</span><span><kbd className="kbd">Enter</kbd> ir</span><span>Solo te lleva: lo que gasta o cambia algo se confirma en su pantalla.</span></div>
    </div>
  </div>;
}
