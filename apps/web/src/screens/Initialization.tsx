import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BootstrapResult, UsageToday } from '@portal-ia/domain';
import { api, type ProjectFull } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { INIT_STEP_LABELS, INIT_STEP_ORDER } from '../lib/labels.ts';
import { Chip, Icon, Notice, Stepper, Wordmark } from '../components/ui.tsx';
import { FolderPicker } from '../components/FolderPicker.tsx';
import { AssessmentCard } from '../components/AssessmentCard.tsx';

export function Initialization() {
  const { status, refresh, flash, navigate } = useApp();
  const [result, setResult] = useState<BootstrapResult | null>(null);
  const [shown, setShown] = useState(status.initialized ? 5 : 0); // pasos revelados progresivamente en la UI
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectFull | null>(null);
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [repoGit, setRepoGit] = useState<{ isGit: boolean; branch: string | null } | null>(null);
  const [repoAuth, setRepoAuth] = useState(false);
  const [picker, setPicker] = useState(false);
  const [registering, setRegistering] = useState(false);
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

  useEffect(() => {
    if (started.current) return; started.current = true;
    (async () => {
      try {
        const r = await api.bootstrap();  // real: crea espacio, proyecto, estructuras y 8 agentes (0 llamadas a IA)
        setResult(r);
        await refresh();
        await loadProject();
        if (r.alreadyInitialized) setShown(5);
        else { for (let i = 1; i <= 5; i++) { await new Promise(res => setTimeout(res, 450)); setShown(i); } }
      } catch (e: any) { setError(e.message); setShown(5); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const done = shown >= 5 && !!result;
  const registered = project?.repository ?? null;

  const register = async () => {
    if (!project || !repoPath || !repoAuth) return;
    setRegistering(true);
    try {
      await api.registerRepository(project.workspaceSlug, project.id, repoPath);
      await loadProject(); setTreeNode('repo'); flash('Repositorio registrado con acceso de solo lectura');
    } catch (e: any) { flash(e.message, 'err'); } finally { setRegistering(false); }
  };

  const tree = [
    { id: 'ws', d: 0, sq: 'tsq-ws', label: 'Espacio interno · Portal IA', meta: 'aislado', title: 'Espacio interno · Portal IA', body: `Espacio de trabajo reservado para la plataforma. Su base de datos, conocimiento y agentes están separados de cualquier empresa o cliente que crees después.\nAlmacenamiento: ${result?.steps.find(s => s.id === 'workspace')?.detail ?? 'data/workspaces/portal-ia/portal-ia.sqlite'}` },
    { id: 'ws-agents', d: 1, sq: 'tsq-ws', label: 'Agentes del espacio', meta: '3 · inactivos', title: 'Agentes del espacio', body: 'Asistente de Empresa, Gestor Organizacional y Agente de Onboarding.\nCreados desde plantillas aprobadas y guardados en la base del espacio. No realizan ninguna llamada a modelos hasta que los actives.' },
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
        <div className="muted small mono" title="Consumo real registrado hoy en este espacio">hoy · {usage?.calls ?? 0} llamadas a IA · {usage?.tokens ?? 0} tokens · {((usage?.costUsd ?? 0)).toFixed(2)} USD</div>
      </header>
      <main className="setup-main" style={{ display: 'flex', flexWrap: 'wrap', gap: 24, maxWidth: 1200, alignItems: 'flex-start', paddingTop: 40 }}>
        <div style={{ flex: '999 1 520px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="eyebrow">Pasos 2 y 3 de 3</div>
            <h1 className="h1" style={{ fontSize: 28 }}>{error ? 'No se pudo inicializar' : done ? 'Espacio interno inicializado' : 'Inicializando el espacio interno…'}</h1>
            <p className="med">{done ? 'Las estructuras ya existen. Ahora, si registras el repositorio y autorizas la evaluación inicial, el equipo analizará de verdad la idea, el código y el diseño del proyecto.' : 'Se crean las estructuras internas que la plataforma usará para gestionarse a sí misma. Todo ocurre localmente, sin llamadas a modelos de IA.'}</p>
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

          <section className="card">
            <div className="card-h">
              <div><div className="h3">Repositorio del código fuente</div><div className="small muted">Acción opcional que requiere tu autorización explícita.</div></div>
              <Chip tone={registered ? 'ok' : 'warn'}>{registered ? 'Registrado · solo lectura' : 'Pendiente de autorización'}</Chip>
            </div>
            <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {registered ? (
                <Notice kind="ok"><strong>Repositorio registrado</strong> en <span className="mono">{registered.path}</span>{registered.branch && <> (rama <span className="mono">{registered.branch}</span>)</>} con acceso de solo lectura. Escritura y ejecución requieren autorización por agente.</Notice>
              ) : (<>
                <p className="sm13 med" style={{ lineHeight: 1.5 }}>Registrar el repositorio permite que los agentes del proyecto lean el código de Portal IA cuando se active el equipo. El registro no concede permisos de escritura ni de ejecución: esos se autorizan por separado en cada agente.</p>
                <div>
                  <label className="label" htmlFor="repo-path">Carpeta local del repositorio</label>
                  <div className="pathfield">
                    <input id="repo-path" className="input mono" value={repoPath ?? ''} placeholder="Ninguna carpeta seleccionada" readOnly aria-describedby="repo-path-help" />
                    <button className="btn btn-secondary" onClick={() => setPicker(true)} disabled={!done}>{Icon.folder()}{repoPath ? 'Cambiar…' : 'Examinar…'}</button>
                  </div>
                  <div className="help" id="repo-path-help">{repoPath ? (repoGit?.isGit ? `Repositorio git detectado${repoGit.branch ? ` · rama ${repoGit.branch}` : ''}.` : 'La carpeta seleccionada no contiene un repositorio git.') : 'Las rutas locales se eligen con el selector de carpetas; no se escriben a mano.'}</div>
                </div>
                <label className="ck"><input className="cb" type="checkbox" checked={repoAuth} disabled={!repoPath} onChange={e => setRepoAuth(e.target.checked)} /><span>Autorizo que el proyecto <strong>Desarrollo del Portal</strong> registre este repositorio con acceso de <strong>solo lectura</strong>. Ningún agente modificará archivos sin una autorización posterior.</span></label>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button className="btn btn-secondary" onClick={register} disabled={!repoAuth || !repoPath || registering || !project}>{Icon.git()}{registering ? 'Registrando…' : 'Registrar repositorio'}</button>
                  <span className="small muted">También puedes hacerlo más tarde desde el panel del proyecto.</span>
                </div>
              </>)}
            </div>
          </section>

          {done && project && <AssessmentCard projectId={project.id} hasRepo={!!registered} />}

          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <Link className="btn btn-ghost" to="/configuracion/proveedor">Atrás</Link>
            <button className="btn btn-secondary" disabled={!done} onClick={() => navigate('/panel')}>Abrir el panel del proyecto sin evaluar {Icon.arrow()}</button>
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

      {picker && <FolderPicker title="Seleccionar carpeta del repositorio" hint="Elige la carpeta local que contiene el código de Portal IA. Solo se puede registrar una carpeta con repositorio git."
        initialPath={repoPath} requireGit
        onSelect={(p, info) => { setRepoPath(p); setRepoGit(info); setRepoAuth(false); setPicker(false); }}
        onClose={() => setPicker(false)} />}
    </div>
  );
}
