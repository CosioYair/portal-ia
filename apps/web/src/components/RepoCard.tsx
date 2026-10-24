import { useEffect, useState } from 'react';
import type { RepoStatus } from '@portal-ia/domain';
import { api, type ProjectFull } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { Chip, Icon, KV, Notice } from '../components/ui.tsx';

/**
 * Repositorio del proyecto: estado git real y las operaciones del flujo (crear main, remoto, publicar main,
 * usar la carpeta de esta instalación). Todo lo que escribe en git pide autorización explícita.
 */
export function RepoCard({ project, onPick, onChanged }: { project: ProjectFull; onPick: () => void; onChanged: () => Promise<void> | void }) {
  const { status, flash } = useApp();
  const ws = status.workspace!;
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
  useEffect(() => { api.health().then(h => setPortalRoot(h.repoRoot)).catch(() => null); }, []);
  const act = async (key: string, fn: () => Promise<string>) => { setBusy(key); setErr(null); try { const msg = await fn(); flash(msg); await load(); await onChanged(); } catch (e: any) { setErr(e.message); } finally { setBusy(null); setAuth(false); } };
  const useInstall = () => act('install', async () => { await api.registerRepository(ws.slug, project.id, st?.portalRoot ?? portalRoot!); return 'Repositorio registrado: la carpeta de esta instalación'; });

  if (!project.repository) {
    return <section className="card">
      <div className="card-h"><div><div className="h3">Repositorio del código fuente</div><div className="small muted">Sin él los agentes no pueden leer ni proponer cambios.</div></div><Chip tone="warn">no registrado</Chip></div>
      <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {internal && portalRoot && <Notice kind="info"><strong>Recomendado para el proyecto interno:</strong> registrar la carpeta desde la que corre este Portal (<span className="mono">{portalRoot}</span>). Así las historias mejoran <em>este</em> Portal y no una copia.</Notice>}
        {err && <Notice kind="err">{err}</Notice>}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {internal && portalRoot && <button className="btn btn-primary" onClick={useInstall} disabled={busy !== null}>{busy === 'install' ? <span className="spin spin-light" /> : Icon.git()}Usar la carpeta de esta instalación</button>}
          <button className="btn btn-secondary" onClick={onPick} disabled={busy !== null}>{Icon.folder()}Elegir otra carpeta…</button>
          <span className="small muted">Acceso de solo lectura; escribir requiere autorización por uso.</span>
        </div>
      </div>
    </section>;
  }

  const foreign = internal && st && !st.isPortalRuntime;
  const mainMissing = st && st.isGit && st.hasCommits && !st.hasMain;
  const neverPublished = st?.mainBranch && st.remote && st.aheadOfRemote === -1;
  return <section className="card">
    <div className="card-h"><div><div className="h3">Repositorio</div><div className="small muted mono" style={{ wordBreak: 'break-all' }}>{project.repository.path}</div></div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {st && <Chip xs tone={st.dirty ? 'warn' : 'ok'}>{st.dirty ? `${st.dirtyFiles} cambio(s) sin confirmar` : 'árbol limpio'}</Chip>}
        {st?.branch && <Chip xs className="mono">rama {st.branch}</Chip>}
        {st && (st.remote ? <Chip xs tone={st.aheadOfRemote === -1 ? 'warn' : st.aheadOfRemote ? 'accent' : 'ok'}>{st.aheadOfRemote === -1 ? 'main sin publicar' : st.aheadOfRemote ? `${st.aheadOfRemote} commit(s) por publicar` : st.behindRemote ? `${st.behindRemote} por detrás del remoto` : 'publicado'}</Chip> : <Chip xs tone="warn">sin remoto</Chip>)}
      </div></div>
    <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {err && <Notice kind="err">{err}</Notice>}
      {foreign && <Notice kind="err"><strong>Este repositorio no es la carpeta desde la que corre el Portal</strong> (<span className="mono">{st.portalRoot}</span>). Las historias ejecutadas aquí construyen un proyecto paralelo que nunca llega a este Portal; por eso no se ven las mejoras. La ejecución de historias queda detenida hasta corregirlo.
        <div style={{ marginTop: 8 }}><button className="btn btn-primary btn-sm" onClick={useInstall} disabled={busy !== null}>{busy === 'install' ? <span className="spin spin-light" /> : Icon.git()}Usar la carpeta de esta instalación</button></div></Notice>}
      {st && !st.isGit && <Notice kind="err">La carpeta ya no contiene un repositorio git.</Notice>}
      {st && st.isGit && !st.hasCommits && <Notice kind="warn">El repositorio no tiene commits. Confirma el código actual (<span className="mono">git add -A && git commit -m "Base"</span>) para que exista una base sobre la que trabajar.</Notice>}
      {mainMissing && <Notice kind="warn"><strong>No existe la rama principal <span className="mono">main</span>.</strong> Las historias deben partir de main e integrarse en main. Puedes crearla ahora a partir de la rama activa (<span className="mono">{st.branch}</span>).</Notice>}
      {st?.hasMain && st.branch && st.branch !== st.mainBranch && <Notice kind="info">La rama activa es <span className="mono">{st.branch}</span>; la principal es <span className="mono">{st.mainBranch}</span>. Las historias nuevas parten de <span className="mono">{st.mainBranch}</span> automáticamente.</Notice>}
      {st?.storyBranches.length ? <KV k="Ramas de historias">{st.storyBranches.length} (<span className="mono">{st.storyBranches.slice(0, 3).join(', ')}{st.storyBranches.length > 3 ? ', …' : ''}</span>)</KV> : null}
      {st && <KV k="Último commit"><span className="mono">{st.headCommit ?? '—'}</span></KV>}
      <div><label className="label" htmlFor="remote-url">Remoto (GitHub)</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input id="remote-url" className="input mono" style={{ flex: 1, minWidth: 260 }} value={remoteUrl} onChange={e => setRemoteUrl(e.target.value)} placeholder="https://github.com/usuario/repositorio.git" />
          <button className="btn btn-secondary btn-sm" onClick={() => act('remote', async () => { const r = await api.repoSetRemote(ws.slug, project.id, remoteUrl); return `Remoto ${r.remote} → ${r.url}`; })} disabled={!auth || busy !== null || remoteUrl.trim().length < 8}>{busy === 'remote' ? <span className="spin" /> : null}{st?.remote ? 'Cambiar remoto' : 'Añadir remoto'}</button>
        </div></div>
      <label className="ck"><input className="cb" type="checkbox" checked={auth} onChange={e => setAuth(e.target.checked)} /><span>Autorizo la operación git seleccionada sobre este repositorio (crear rama principal, configurar remoto o publicar <span className="mono">{st?.mainBranch ?? 'main'}</span> con <span className="mono">git push</span>).</span></label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {mainMissing && <button className="btn btn-primary btn-sm" onClick={() => act('main', async () => { const r = await api.repoInitMain(ws.slug, project.id); return `Rama ${r.mainBranch} creada desde ${r.from}`; })} disabled={!auth || busy !== null}>{busy === 'main' ? <span className="spin spin-light" /> : Icon.git()}Crear rama main desde {st.branch}</button>}
        {st?.hasMain && <button className={`btn btn-sm ${neverPublished || st.aheadOfRemote ? 'btn-primary' : 'btn-secondary'}`} onClick={() => act('publish', async () => { const r = await api.repoPublishMain(ws.slug, project.id); return `${r.branches.join(', ')} publicada en ${r.remote}`; })} disabled={!auth || busy !== null || !st.remote}>{busy === 'publish' ? <span className="spin" /> : null}Publicar {st.mainBranch} en el remoto</button>}
        <button className="btn btn-ghost btn-sm" onClick={onPick} disabled={busy !== null}>{Icon.folder()}Cambiar carpeta…</button>
        <button className="btn btn-ghost btn-sm" onClick={load} disabled={busy !== null}>Actualizar estado</button>
      </div>
      <div className="help">Flujo: cada historia crea su rama desde <span className="mono">{st?.mainBranch ?? 'main'}</span> → revisas el diff → aplicar → verificar → integrar en <span className="mono">{st?.mainBranch ?? 'main'}</span> → publicar. En GitHub, fija <span className="mono">main</span> como rama por defecto (Settings → Branches).</div>
    </div>
  </section>;
}
