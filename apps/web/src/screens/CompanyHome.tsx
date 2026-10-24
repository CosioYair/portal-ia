import { useState } from 'react';
import { api } from '../lib/api.ts';
import { useApp } from '../lib/store.ts';
import { Shell } from '../components/Shell.tsx';
import { Empty, Icon, Notice } from '../components/ui.tsx';

/** Empresa sin proyectos: crear el primero. Los agentes del proyecto se crean desde las plantillas (sin IA). */
export function CompanyHome() {
  const { status, select, flash, navigate } = useApp();
  const ws = status.workspace!;
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    if (name.trim().length < 2) return; setBusy(true); setError(null);
    try { const p = await api.createProject(ws.slug, name.trim(), desc.trim()); await select(ws.slug, p.id); flash(`Proyecto «${p.name}» creado con su equipo de 5 agentes (inactivos)`); navigate('/panel'); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Shell crumb="Sin proyecto">
      <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 760 }}>
        <div><div className="eyebrow">Empresa</div><h1 className="h1" style={{ fontSize: 26 }}>{ws.name}</h1></div>
        <Empty icon={Icon.inbox()} title="Esta empresa aún no tiene proyectos" hint="Crea el primero: recibirá su Coordinador, Arquitecto, Desarrollador, Diseñador y QA desde las plantillas aprobadas, todos inactivos." style={{ padding: '24px 0 8px' }} />
        {error && <Notice kind="err">{error}</Notice>}
        <section className="card card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div><label className="label" htmlFor="p-name">Nombre del proyecto</label><input id="p-name" className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Ej.: Tienda en línea" /></div>
          <div><label className="label" htmlFor="p-desc">Descripción (qué se construye y para quién)</label><textarea id="p-desc" className="input" value={desc} onChange={e => setDesc(e.target.value)} /></div>
          <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={create} disabled={busy || name.trim().length < 2}>{busy ? 'Creando…' : 'Crear proyecto'}</button>
        </section>
      </main>
    </Shell>
  );
}
