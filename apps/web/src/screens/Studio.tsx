import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { StudioFormat } from '@portal-ia/domain';
import { STUDIO_FORMATS } from '@portal-ia/domain';
import { fmtTime, studioApi, type StudioProjectSummary, type StudioProviderInfo, type StudioStatus } from '../lib/studioApi.ts';
import { useApp } from '../lib/store.ts';
import { Shell } from '../components/Shell.tsx';
import { Modal } from '../components/Modal.tsx';
import { Disclosure } from '../components/Disclosure.tsx';
import { Chip, Icon, Notice, Spinner } from '../components/ui.tsx';
import { EmptyState, PageHeader } from '../components/kit.tsx';
import '../studio.css';

/**
 * Portal IA 4 · Estudio: tus proyectos de vídeo. Crear, abrir, duplicar y quitar. Dice con claridad si el motor de
 * vídeo de esta máquina está listo y en qué estado real está cada capacidad de IA (ninguna se anuncia sin estar probada).
 */
const STATE_LABEL: Record<StudioProviderInfo['state'], { text: string; tone: '' | 'ok' | 'warn' | 'accent' }> = {
  verified: { text: 'Disponible y comprobado', tone: 'ok' }, configured_untested: { text: 'Conectado, sin probar', tone: 'warn' },
  requires_connection: { text: 'Necesita que conectes tu cuenta', tone: '' }, requires_paid_auth: { text: 'Necesita tu autorización de gasto', tone: 'warn' }, unsupported: { text: 'No disponible', tone: '' }
};

export function Studio() {
  const { status, flash, navigate } = useApp(); const slug = status.workspace!.slug;
  const [list, setList] = useState<StudioProjectSummary[] | null>(null); const [info, setInfo] = useState<StudioStatus | null>(null);
  const [err, setErr] = useState<string | null>(null); const [creating, setCreating] = useState(false); const [removing, setRemoving] = useState<StudioProjectSummary | null>(null);
  const [name, setName] = useState(''); const [format, setFormat] = useState<StudioFormat>('landscape'); const [busy, setBusy] = useState(false);
  const load = () => studioApi.list(slug).then(setList).catch(e => setErr(e.message));
  useEffect(() => { void load(); studioApi.status(slug).then(setInfo).catch(() => undefined); }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps
  const create = async () => { if (!name.trim()) return; setBusy(true); setErr(null); try { const f = await studioApi.create(slug, name.trim(), format); navigate(`/estudio/${f.project.id}`); } catch (e: any) { setErr(e.message); setBusy(false); } };
  const duplicate = async (p: StudioProjectSummary) => { try { await studioApi.duplicate(slug, p.id); flash(`Copia de «${p.name}» creada`); await load(); } catch (e: any) { setErr(e.message); } };
  const remove = async () => { if (!removing) return; try { await studioApi.remove(slug, removing.id); flash(`«${removing.name}» se quitó de la lista`); setRemoving(null); await load(); } catch (e: any) { setErr(e.message); setRemoving(null); } };
  const engine = info?.engine;

  return <Shell crumb="Estudio">
    <div className="st-home">
      <PageHeader icon={Icon.layers()} tone="work" title="Estudio" description="Monta vídeos con tus clips, imágenes, música y texto, y expórtalos en MP4. Todo se procesa en esta máquina."
        actions={<button className="btn btn-primary" onClick={() => { setName(''); setCreating(true); }}>{Icon.plus()} Nuevo proyecto</button>} />
      {err && <Notice kind="err">{err}</Notice>}
      {engine && engine.state !== 'ready' && <Notice kind="warn"><strong>El motor de vídeo no está listo.</strong> {engine.detail} Puedes preparar proyectos, pero no importar medios ni exportar hasta arreglarlo. <span className="small">{engine.state === 'no_docker' ? engine.hint : <>Hay que construir una vez la imagen de vídeo (ver <em>Ajustes › Sistema</em>): <code>{engine.hint}</code></>}</span> <button className="btn btn-secondary btn-sm" onClick={() => studioApi.status(slug, true).then(setInfo)}>Comprobar de nuevo</button></Notice>}

      {!list ? <Spinner /> : list.length === 0
        ? <EmptyState title="Aún no tienes ningún vídeo" action={<button className="btn btn-primary" onClick={() => setCreating(true)}>{Icon.plus()} Crear el primero</button>}>Crea un proyecto, añade tus medios y móntalos en la línea de tiempo. Se guarda solo.</EmptyState>
        : <ul className="st-plain st-projects">{list.map(p => <li key={p.id} className="st-project">
          <Link className="st-project-main" to={`/estudio/${p.id}`}>
            <span className={`st-project-shape st-shape-${p.format}`} aria-hidden="true" />
            <span className="st-project-text"><strong>{p.name}</strong><span className="small muted">{STUDIO_FORMATS[p.format].label} {STUDIO_FORMATS[p.format].ratio} · {p.clips ? `${fmtTime(p.duration)} · ${p.clips} ${p.clips === 1 ? 'fragmento' : 'fragmentos'}` : 'vacío'} · cambiado el {new Date(p.updatedAt).toLocaleDateString()}</span></span>
          </Link>
          <div className="st-project-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => void duplicate(p)}>Duplicar</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setRemoving(p)} aria-label={`Quitar «${p.name}»`}>Quitar</button>
          </div>
        </li>)}</ul>}

      {info && <Disclosure title="Qué puede hacer el Estudio con IA" hint="Estado real de cada capacidad">
        <p className="small muted">El editor funciona entero sin IA. Generar vídeo con IA usa servicios de pago de terceros: no están incluidos en tu suscripción de Claude y nunca se usan sin tu conexión y tu autorización de gasto.</p>
        <ul className="st-plain st-providers">{info.providers.map(p => <li key={p.id} className="st-provider">
          <div className="st-provider-top"><strong>{p.name}</strong><Chip tone={STATE_LABEL[p.state].tone} xs>{STATE_LABEL[p.state].text}</Chip></div>
          <p className="small" style={{ margin: 0 }}>{p.note}{p.priceHint ? ` Precio orientativo: ${p.priceHint}.` : ''}</p>
        </li>)}</ul>
      </Disclosure>}
    </div>

    {creating && <Modal title="Nuevo proyecto de vídeo" onClose={() => setCreating(false)} footer={<><button className="btn btn-ghost" onClick={() => setCreating(false)}>Cancelar</button><button className="btn btn-primary" onClick={create} disabled={busy || !name.trim()}>{busy ? 'Creando…' : 'Crear y abrir'}</button></>}>
      <div><label className="label" htmlFor="st-new-name">Nombre</label><input id="st-new-name" className="input" style={{ width: '100%' }} value={name} maxLength={120} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void create(); }} placeholder="Por ejemplo: Presentación del producto" /></div>
      <fieldset className="st-fs"><legend className="label">Formato</legend>
        <div className="st-formats">{(Object.keys(STUDIO_FORMATS) as StudioFormat[]).map(f => <label key={f} className={`st-formatopt${format === f ? ' is-on' : ''}`}><input type="radio" name="st-format" className="sr-only" checked={format === f} onChange={() => setFormat(f)} /><span className={`st-project-shape st-shape-${f}`} aria-hidden="true" /><span><strong>{STUDIO_FORMATS[f].label}</strong><br /><span className="small muted">{STUDIO_FORMATS[f].ratio}{f === 'portrait' ? ' · móvil, reels' : f === 'square' ? ' · redes' : ' · pantalla'}</span></span></label>)}</div>
      </fieldset>
      <p className="small muted" style={{ margin: 0 }}>Podrás cambiar el formato después.</p>
    </Modal>}
    {removing && <Modal title="Quitar el proyecto" onClose={() => setRemoving(null)} footer={<><button className="btn btn-ghost" onClick={() => setRemoving(null)}>Cancelar</button><button className="btn btn-danger" onClick={remove}>Quitar de la lista</button></>}>
      <p style={{ margin: 0 }}>«{removing.name}» dejará de aparecer en el Estudio. Sus medios y los vídeos exportados se conservan en el disco.</p>
    </Modal>}
  </Shell>;
}
