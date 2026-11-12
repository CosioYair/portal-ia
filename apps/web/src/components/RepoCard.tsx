import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import type { RepoStatus } from '@portal-ia/domain';
import { api, type ProjectFull } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { Chip, Icon, KV, Notice } from '../components/ui.tsx';
import { FolderPicker } from './FolderPicker.tsx';

/**
 * HU-210 · Única tarjeta del repositorio (Resumen e Inicialización): registro con selector de carpeta git y autorización
 * explícita de solo lectura (también para «la carpeta de esta instalación»), estado git real y las operaciones del flujo
 * (crear main, remoto, publicar main). Todo lo que escribe en git pide autorización explícita.
 */
export function RepoCard({ project, onChanged }: { project: ProjectFull; onChanged: () => Promise<void> | void }) {
  const { flash } = useApp();
  // El espacio sale del proyecto: en Inicialización la tarjeta puede montarse antes de que el estado global lo tenga.
  const ws = { slug: project.workspaceSlug };
  const internal = ws.slug === 'portal-ia';
  const [st, setSt] = useState<(RepoStatus & { portalRoot: string }) | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [auth, setAuth] = useState(false);

  const load = async () => { if (!project.repository) { setSt(null); return; } try { const s = await api.repoStatus(ws.slug, project.id); setSt(s); setRemoteUrl(s.remoteUrl ?? ''); setErr(null); } catch (e: any) { setErr(e.message); } };
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, project.repository?.path]);

  const [portalRoot, setPortalRoot] = useState<string | null>(null);
  const [sandbox, setSandbox] = useState<{ available: string; detail: string } | null>(null);
  useEffect(() => { api.health().then(h => setPortalRoot(h.repoRoot)).catch(() => null); if (internal) api.systemSandbox().then(setSandbox).catch(() => null); }, [internal]);
  const act = async (key: string, fn: () => Promise<string>) => { setBusy(key); setErr(null); try { const msg = await fn(); flash(msg); await load(); await onChanged(); } catch (e: any) { setErr(e.message); } finally { setBusy(null); setAuth(false); } };
  // HU-210 · Registro: un único sitio de la interfaz llama a api.registerRepository, siempre tras la casilla de solo lectura.
  const [picker, setPicker] = useState(false);
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [repoGit, setRepoGit] = useState<{ isGit: boolean; branch: string | null } | null>(null);
  const [regAuth, setRegAuth] = useState(false);
  const installRoot = st?.portalRoot ?? portalRoot;
  const choose = (p: string, info: { isGit: boolean; branch: string | null } | null) => { setRepoPath(p); setRepoGit(info); setRegAuth(false); setPicker(false); setErr(null); };
  const useInstall = () => { if (installRoot) choose(installRoot, null); };
  const register = () => {
    if (!repoPath || !regAuth) return;
    const path = repoPath;
    void act('register', async () => {
      await api.registerRepository(ws.slug, project.id, path);
      setRepoPath(null); setRepoGit(null); setRegAuth(false);
      return path === installRoot ? 'Repositorio registrado: la carpeta de esta instalación' : 'Repositorio registrado con acceso de solo lectura';
    });
  };
  const pathId = `repo-path-${project.id}`;
  const pathHelp = !repoPath ? 'Las rutas locales se eligen con el selector de carpetas; no se escriben a mano.'
    : repoPath === installRoot && !repoGit ? 'Carpeta desde la que corre este Portal.'
    : repoGit?.isGit ? `Repositorio git detectado${repoGit.branch ? ` · rama ${repoGit.branch}` : ''}.` : 'La carpeta seleccionada no contiene un repositorio git.';
  const regBlock = <>
    <div>
      <label className="label" htmlFor={pathId}>Carpeta local del repositorio</label>
      <div className="pathfield">
        <input id={pathId} className="input mono" value={repoPath ?? ''} placeholder="Ninguna carpeta seleccionada" readOnly aria-describedby={`${pathId}-help`} />
        <button className="btn btn-secondary" onClick={() => setPicker(true)} disabled={busy !== null}>{Icon.folder()}{repoPath ? 'Cambiar…' : 'Elegir carpeta…'}</button>
      </div>
      <div className="help" id={`${pathId}-help`}>{pathHelp}</div>
    </div>
    <label className="ck"><input className="cb" type="checkbox" checked={regAuth} disabled={!repoPath} onChange={e => setRegAuth(e.target.checked)} /><span>Autorizo que el Portal lea esta carpeta (<strong>solo lectura</strong>; escribir pedirá autorización por uso).</span></label>
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <button className="btn btn-primary" onClick={register} disabled={!regAuth || !repoPath || busy !== null}>{busy === 'register' ? <span className="spin spin-light" /> : Icon.git()}Registrar repositorio</button>
      {repoPath && <button className="btn btn-ghost" onClick={() => { setRepoPath(null); setRepoGit(null); setRegAuth(false); }} disabled={busy !== null}>Cancelar</button>}
    </div>
  </>;
  const pickerEl = picker ? <FolderPicker title="Seleccionar carpeta del repositorio" hint="Elige la carpeta local que contiene el código del proyecto. Solo se puede registrar una carpeta con repositorio git; el registro se autoriza después en la tarjeta."
    initialPath={repoPath} requireGit
    onSelect={(p, info) => choose(p, info)}
    onClose={() => setPicker(false)} /> : null;

  if (!project.repository) {
    return <><section className="card" aria-label="Repositorio del código fuente">
      <div className="card-h"><div><div className="h3">Repositorio del código fuente</div><div className="small muted">Sin él los agentes no pueden leer ni proponer cambios.</div></div><Chip tone="warn">no registrado</Chip></div>
      <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p className="sm13 med" style={{ lineHeight: 1.5 }}>Registrar el repositorio permite que los agentes del proyecto lean el código. No concede permisos de escritura ni de ejecución: esos se autorizan por separado en cada uso.</p>
        {internal && portalRoot && <Notice kind="info"><strong>Recomendado para el proyecto interno:</strong> registrar la carpeta desde la que corre este Portal (<span className="mono">{portalRoot}</span>). Así las historias mejoran <em>este</em> Portal y no una copia.
          {repoPath !== installRoot && <div style={{ marginTop: 8 }}><button className="btn btn-secondary btn-sm" onClick={useInstall} disabled={busy !== null}>{Icon.git()}Usar la carpeta de esta instalación</button></div>}</Notice>}
        <div aria-live="polite">{err && <Notice kind="err">{err}</Notice>}</div>
        {regBlock}
      </div>
    </section>{pickerEl}</>;
  }

  const foreign = internal && st && !st.isPortalRuntime;
  const mainMissing = st && st.isGit && st.hasCommits && !st.hasMain;
  const neverPublished = st?.mainBranch && st.remote && st.aheadOfRemote === -1;
  return <><section className="card" aria-label="Repositorio del código fuente">
    <div className="card-h"><div><div className="h3">Repositorio del código fuente</div><div className="small muted mono" style={{ wordBreak: 'break-all' }}>{project.repository.path}</div></div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {st && <Chip xs tone={st.dirty ? 'warn' : 'ok'}>{st.dirty ? `${st.dirtyFiles} cambio(s) sin confirmar` : 'árbol limpio'}</Chip>}
        {st?.branch && <Chip xs className="mono">rama {st.branch}</Chip>}
        {st && (st.remote ? <Chip xs tone={st.aheadOfRemote === -1 ? 'warn' : st.aheadOfRemote ? 'accent' : 'ok'}>{st.aheadOfRemote === -1 ? 'main sin publicar' : st.aheadOfRemote ? `${st.aheadOfRemote} commit(s) por publicar` : st.behindRemote ? `${st.behindRemote} por detrás del remoto` : 'publicado'}</Chip> : <Chip xs tone="warn">sin remoto</Chip>)}
      </div></div>
    <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div aria-live="polite">{err && <Notice kind="err">{err}</Notice>}</div>
      {repoPath && <section aria-label="Cambiar la carpeta registrada" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Notice kind="info">Vas a sustituir la carpeta registrada. Revisa la nueva carpeta y autoriza su lectura para registrarla.</Notice>
        {regBlock}
      </section>}
      {foreign && <Notice kind="err"><strong>Este repositorio no es la carpeta desde la que corre el Portal</strong> (<span className="mono">{st.portalRoot}</span>). Las historias ejecutadas aquí construyen un proyecto paralelo que nunca llega a este Portal; por eso no se ven las mejoras. La ejecución de historias queda detenida hasta corregirlo.
        <div style={{ marginTop: 8 }}><button className="btn btn-primary btn-sm" onClick={useInstall} disabled={busy !== null || repoPath === installRoot}>{Icon.git()}Usar la carpeta de esta instalación</button></div></Notice>}
      {st && !st.isGit && <Notice kind="err">La carpeta ya no contiene un repositorio git.</Notice>}
      {st?.dirty && st.eolOnly && <Notice kind="warn"><strong>{st.dirtyFiles} archivo(s) aparecen modificados solo por finales de línea</strong> (CRLF/LF, típico en Windows). Eso bloquea aplicar historias. Se arregla con un clic: fija <span className="mono">.gitattributes</span>, renormaliza y confirma.
        <div style={{ marginTop: 8 }}><button className="btn btn-primary btn-sm" onClick={() => act('eol', async () => { const r = await api.repoNormalizeEol(ws.slug, project.id); return r.commit ? `Finales de línea normalizados (${r.files} archivos, commit ${r.commit})` : 'No había nada que normalizar'; })} disabled={busy !== null}>{busy === 'eol' ? <span className="spin spin-light" /> : Icon.git()}Normalizar finales de línea</button></div></Notice>}
      {st?.dirty && !st.eolOnly && <Notice kind="info"><strong>{st.dirtyFiles} archivo(s) con cambios sin confirmar.</strong> Las historias se aplican en worktrees aislados, así que no se bloquean; pero integrar en <span className="mono">{st.mainBranch ?? 'main'}</span> exige que los archivos que toca la historia no tengan cambios locales.</Notice>}
      {st && st.isGit && !st.hasCommits && <Notice kind="warn">El repositorio no tiene commits. Confirma el código actual (<span className="mono">git add -A && git commit -m "Base"</span>) para que exista una base sobre la que trabajar.</Notice>}
      {mainMissing && <Notice kind="warn"><strong>No existe la rama principal <span className="mono">main</span>.</strong> Las historias deben partir de main e integrarse en main. Puedes crearla ahora a partir de la rama activa (<span className="mono">{st.branch}</span>).</Notice>}
      {st?.hasMain && st.branch && st.branch !== st.mainBranch && <Notice kind="info">La rama activa es <span className="mono">{st.branch}</span>; la principal es <span className="mono">{st.mainBranch}</span>. Las historias nuevas parten de <span className="mono">{st.mainBranch}</span> automáticamente.</Notice>}
      {st?.storyBranches.length ? <KV k="Ramas de historias">{st.storyBranches.length} (<span className="mono">{st.storyBranches.slice(0, 3).join(', ')}{st.storyBranches.length > 3 ? ', …' : ''}</span>)</KV> : null}
      {st && <KV k="Último commit"><span className="mono">{st.headCommit ?? '—'}</span></KV>}
      <div><label className="label" htmlFor="remote-url">Remoto (GitHub)</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input id="remote-url" className="input mono" style={{ flex: 1, minWidth: 260 }} value={remoteUrl} onChange={e => setRemoteUrl(e.target.value)} placeholder="https://github.com/usuario/repositorio.git" />
          <button className="btn btn-secondary btn-sm" onClick={() => act('remote', async () => { const r = await api.repoSetRemote(ws.slug, project.id, remoteUrl, st?.remoteUrl ?? null); return `Remoto ${r.remote} → ${r.url}`; })} disabled={!auth || busy !== null || remoteUrl.trim().length < 8}>{busy === 'remote' ? <span className="spin" /> : null}{st?.remote ? 'Cambiar remoto' : 'Añadir remoto'}</button>
        </div></div>
      <label className="ck"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /><span>Autorizo la operación git seleccionada sobre este repositorio (crear rama principal, configurar remoto o publicar <span className="mono">{st?.mainBranch ?? 'main'}</span> con <span className="mono">git push</span>).</span></label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {mainMissing && <button className="btn btn-primary btn-sm" onClick={() => act('main', async () => { const r = await api.repoInitMain(ws.slug, project.id); return `Rama ${r.mainBranch} creada desde ${r.from}`; })} disabled={!auth || busy !== null}>{busy === 'main' ? <span className="spin spin-light" /> : Icon.git()}Crear rama main desde {st.branch}</button>}
        {st?.hasMain && <button className={`btn btn-sm ${neverPublished || st.aheadOfRemote ? 'btn-primary' : 'btn-secondary'}`} onClick={() => act('publish', async () => { const r = await api.repoPublishMain(ws.slug, project.id, st!.mainCommit ?? '', st!.remoteUrl ?? null); return `${r.branches.join(', ')} publicada en ${r.remote}`; })} disabled={!auth || busy !== null || !st.remote}>{busy === 'publish' ? <span className="spin" /> : null}Publicar {st.mainBranch} en el remoto</button>}
        <Link className="btn btn-secondary btn-sm" to="/mantenimiento">{Icon.history()}Revisar ramas y backlog</Link>
        <button className="btn btn-ghost btn-sm" onClick={() => setPicker(true)} disabled={busy !== null}>{Icon.folder()}Cambiar carpeta…</button>
        <button className="btn btn-ghost btn-sm" onClick={load} disabled={busy !== null}>Actualizar estado</button>
      </div>
      {internal && sandbox && <KV k="Sandbox"><Chip xs tone={sandbox.available === 'unavailable' ? 'warn' : 'ok'}>{sandbox.available === 'unavailable' ? 'no disponible' : sandbox.available}</Chip> <span className="small muted">{sandbox.detail}</span></KV>}
      <div className="help">Flujo: cada historia crea su rama desde <span className="mono">{st?.mainBranch ?? 'main'}</span> en un worktree aislado → revisas el diff → aplicar → verificar en sandbox → integrar en <span className="mono">{st?.mainBranch ?? 'main'}</span>{internal ? ' → reconstruir y reiniciar → comprobar en ejecución' : ''} → probar → cerrar. Publicar en GitHub es opcional.</div>
    </div>
  </section>{pickerEl}</>;
}
