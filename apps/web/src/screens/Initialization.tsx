import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BootstrapResult, UsageToday } from '@portal-ia/domain';
import { api, type ProjectFull } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { INIT_STEP_LABELS, INIT_STEP_ORDER } from '../lib/labels.ts';
import { Chip, Icon, Notice, Stepper, Wordmark } from '../components/ui.tsx';
import { RepoCard } from '../components/RepoCard.tsx';
import { AssessmentCard } from '../components/AssessmentCard.tsx';
import { OwnerBar } from '../components/OwnerPairing.tsx';
import { onOwnerChange, ownerToken } from '../lib/owner.ts';

export function Initialization() {
  const { status, refresh, navigate } = useApp();
  const [result, setResult] = useState<BootstrapResult | null>(null);
  const [shown, setShown] = useState(status.initialized ? 5 : 0); // pasos revelados progresivamente en la UI
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectFull | null>(null);
  const [treeNode, setTreeNode] = useState('ws');
  const started = useRef(false);
  const [usage, setUsage] = useState<UsageToday | null>(null);
  useEffect(() => {
    let alive = true; const slug = status.workspace?.slug ?? 'portal-ia';
    const tick = async () => { try { const u = await api.usageToday(slug); if (alive) setUsage(u); } catch { /* aún sin espacio */ } if (alive) setTimeout(tick, 4000); };
    void tick(); return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadProject = async () => {
    const ws = status.workspace?.slug ?? 'portal-ia';
    const ps = await api.projects(ws).catch(() => []);
    setProject(ps[0] ?? null);
  };

  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (started.current) return; started.current = true; void retry; // «retry»: vuelve a intentarlo tras vincular este navegador
    (async () => {
      try {
        const r = await api.bootstrap();  // real: crea espacio, proyecto, estructuras y 8 agentes (0 llamadas a IA)
        setResult(r);
        await refresh();
        await loadProject();
        if (r.alreadyInitialized) setShown(5);
        else { for (let i = 1; i <= 5; i++) { await new Promise(res => setTimeout(res, 450)); setShown(i); } }
      } catch (e: any) { setError(e.message); setShown(5); if (!ownerToken()) { const off = onOwnerChange(() => { if (ownerToken()) { off(); started.current = false; setError(null); setShown(0); setRetry(n => n + 1); } }); } }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retry]);

  const done = shown >= 5 && !!result;
  const registered = project?.repository ?? null;

  // HU-210 · El registro vive solo en RepoCard (la misma tarjeta del Resumen); aquí solo se recarga el proyecto.
  const onRepoChanged = async () => { const had = !!project?.repository; await loadProject(); if (!had) setTreeNode('repo'); };

  const tree = [
    { id: 'ws', d: 0, sq: 'tsq-ws', label: 'Empresa interna · Portal IA', meta: 'aislado', title: 'Empresa interna · Portal IA', body: `Empresa reservada para la plataforma. Su base de datos, conocimiento y agentes están separados de cualquier empresa o cliente que crees después.\nAlmacenamiento: ${result?.steps.find(s => s.id === 'workspace')?.detail ?? 'data/workspaces/portal-ia/portal-ia.sqlite'}` },
    { id: 'ws-agents', d: 1, sq: 'tsq-ws', label: 'Agentes de la empresa', meta: '3 · inactivos', title: 'Agentes de la empresa', body: 'Asistente de Empresa, Gestor Organizacional y Agente de Onboarding.\nCreados desde plantillas aprobadas y guardados en la base de la empresa. No realizan ninguna llamada a modelos hasta que los actives.' },
    { id: 'pj', d: 1, sq: 'tsq-pj', label: 'Proyecto · Desarrollo del Portal', meta: 'seleccionado', title: 'Proyecto · Desarrollo del Portal', body: project?.description ?? 'Proyecto interno cuyo objetivo es construir la propia plataforma.' },
    { id: 'obj', d: 2, sq: '', label: 'Objetivos', meta: String(project?.objectives.length ?? 3), title: 'Objetivos iniciales', body: (project?.objectives ?? []).map((o, i) => `0${i + 1} ${o.text}`).join('\n') || 'Cargando…' },
    { id: 'ctx', d: 2, sq: '', label: 'Contexto aprobado', meta: String(project?.context.length ?? 8), title: 'Contexto aprobado', body: (project?.context ?? []).map(c => c.label).join(' · ') || 'Cargando…' },
    { id: 'know', d: 2, sq: '', label: 'Conocimiento', meta: project?.knowledgeCount ? String(project.knowledgeCount) : 'vacío', title: 'Conocimiento del proyecto', body: 'Aún no hay documentos. Los agentes podrán guardar decisiones y notas aquí cuando se activen, dentro de su ámbito.' },
    { id: 'repo', d: 2, sq: registered ? 'tsq-ok' : 'tsq-warn', label: 'Repositorio del código', meta: registered ? 'registrado' : 'pendiente', title: 'Repositorio del código fuente', body: registered ? `Registrado en ${registered.path}${registered.branch ? ` (rama ${registered.branch})` : ''} con acceso de solo lectura. Escritura y ejecución requieren autorización por agente.` : 'Pendiente de autorización. Registrar el repositorio permite a los agentes del proyecto leer el código de Portal IA; no concede permisos de escritura ni de ejecución.' },
    { id: 'pj-agents', d: 2, sq: 'tsq-pj', label: 'Agentes del proyecto', meta: '5 · inactivos', title: 'Agentes del proyecto', body: 'Coordinador del Proyecto, Arquitecto de Software, Desarrollador Full Stack, Diseñador UX/UI y Especialista QA.\nReportan al Coordinador; el Coordinador reporta al Gestor Organizacional.' },
    { id: 'hist', d: 1, sq: '', label: 'Historial de ejecución', meta: '0 procesos', title: 'Historial de ejecución', body: 'Cada proceso autorizado quedará registrado aquí con sus tareas, su consumo de tokens y su costo.' }
  ];
  const sel = tree.find(n => n.id === treeNode) ?? tree[0];

  return (
    <div className="screen setup">
      <header className="setup-top">
        <Wordmark />
        <Stepper s1="is-done" s2={shown >= 4 ? 'is-done' : 'is-active'} s3={done ? 'is-done' : shown >= 4 ? 'is-active' : ''} />
        <div className="muted small mono" title="Consumo real registrado hoy en esta empresa">hoy · {usage?.calls ?? 0} llamadas a IA · {usage?.tokens ?? 0} tokens · {((usage?.costUsd ?? 0)).toFixed(2)} USD</div>
      </header>
      <OwnerBar />
      <main className="setup-main" style={{ display: 'flex', flexWrap: 'wrap', gap: 24, maxWidth: 1200, alignItems: 'flex-start', paddingTop: 40 }}>
        <div style={{ flex: '999 1 520px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="eyebrow">Pasos 2 y 3 de 3</div>
            <h1 className="h1" style={{ fontSize: 28 }}>{error ? 'No se pudo inicializar' : done ? 'Empresa interna preparada' : 'Preparando la empresa interna…'}</h1>
            <p className="med">{done ? 'Las estructuras ya existen. Registra el repositorio en la tarjeta de abajo; es la misma que verás en el Resumen. Después, si autorizas la evaluación inicial, el equipo analizará de verdad la idea, el código y el diseño del proyecto.' : 'Se crean las estructuras internas que la plataforma usará para gestionarse a sí misma. Todo ocurre localmente, sin llamadas a modelos de IA.'}</p>
          </div>
          {error && <Notice kind="err"><strong>Error.</strong> {error}</Notice>}

          <section className="card">
            <div className="card-h"><div className="h3">Inicialización</div>
              <Chip tone={done ? 'ok' : 'warn'} dot={done ? 'ok' : 'pulse'}>{done ? (result?.alreadyInitialized ? 'Ya estaba inicializado' : 'Completado · local') : `En curso · ${Math.min(shown + 1, 5)} de 5`}</Chip></div>
            <ol className="ilist">
              {INIT_STEP_ORDER.map((id, i) => {
                const d = shown > i, r = shown === i && !done, step = result?.steps.find(s => s.id === id);
                const lab = INIT_STEP_LABELS[id];
                return <li key={id} className={`ili ${d ? 'is-done' : r ? 'is-running' : 'is-pending'}`}>
                  <span className="ili-ic">{d ? Icon.check() : r ? <span className="spin" /> : <span className="mono">{i + 1}</span>}</span>
                  <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}><span style={{ fontWeight: 500 }}>{lab.title}</span><span className="small muted">{lab.sub}</span></span>
                  <span className="small mono muted">{d ? (step?.status === 'skipped' ? 'ya existía' : step?.detail && id === 'team' ? step.detail : 'local') : r ? 'en curso' : ''}</span>
                </li>;
              })}
            </ol>
            <div className="card-f sm13" style={{ display: 'flex', gap: 16, justifyContent: 'space-between', flexWrap: 'wrap' }}><span className="muted">Esta inicialización no llama a modelos de IA; el consumo real del día se muestra arriba y en cada proceso.</span><span className="mono">local</span></div>
          </section>

          {done && project && <RepoCard project={project} onChanged={onRepoChanged} />}

          {done && project && <AssessmentCard projectId={project.id} hasRepo={!!registered} />}

          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <Link className="btn btn-ghost" to="/configuracion/proveedor">Atrás</Link>
            <button className="btn btn-secondary" disabled={!done} onClick={() => navigate('/panel')}>Abrir el Resumen del proyecto sin evaluar {Icon.arrow()}</button>
          </div>
        </div>

        <aside style={{ flex: '1 1 320px', maxWidth: 400, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="card-h"><div className="h3">Estructura resultante</div><span className="small muted">Selecciona un elemento</span></div>
            <div className="card-b" style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 1 }}>
              {tree.map(n => <button key={n.id} className={`tnode ${n.id === sel.id ? 'is-selected' : ''}`} onClick={() => setTreeNode(n.id)} aria-pressed={n.id === sel.id} style={{ paddingLeft: 8 + n.d * 18 }}>
                <span className={`tsq ${n.sq}`} /><span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.label}</span><span className="small mono muted">{n.meta}</span></button>)}
            </div>
            <div className="card-f" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><div className="h3" style={{ fontSize: 13 }}>{sel.title}</div><p className="sm13 med" style={{ whiteSpace: 'pre-line', lineHeight: 1.5, wordBreak: 'break-word' }}>{sel.body}</p></div>
          </div>
        </aside>
      </main>

    </div>
  );
}
