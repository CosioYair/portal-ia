import { useEffect, useRef, useState } from 'react';
import { slugify, type AgentWizardDraft, type PortableSkill } from '@portal-ia/domain';
import { wizardDraft, wizardDraftEstimate, type WizardDraftEstimate, type WizardDraftResult } from '../lib/api.ts';
import { Notice, Spinner } from './ui.tsx';

/**
 * HU-204 · «Redactar con IA» en «Nuevo agente». Primero se estima sin gasto (motor y costo) y SOLO tras pulsar
 * «Autorizar y redactar» se hace una llamada al Agente de Onboarding. La propuesta se revisa por partes (Aceptar, Editar,
 * Descartar) y al asistente solo llegan las partes aceptadas. La IA nunca propone ni concede permisos, herramientas, arnés,
 * modelo ni autonomía: esos pasos del asistente no reciben nada de aquí.
 */
type PartKey = keyof AgentWizardDraft;
type Decision = 'pending' | 'accepted' | 'discarded';
type Phase = 'estimating' | 'awaiting' | 'calling' | 'ready' | 'error';

const PARTS: { key: PartKey; label: string }[] = [
  { key: 'role', label: 'Papel' },
  { key: 'summary', label: 'En qué te ayuda' },
  { key: 'responsibilities', label: 'Responsabilidades' },
  { key: 'deliverables', label: 'Entregables' },
  { key: 'skills', label: 'Habilidades' },
  { key: 'instructions', label: 'Instrucciones (AGENTS.md)' }
];
const ALL_PENDING: Record<PartKey, Decision> = { role: 'pending', summary: 'pending', responsibilities: 'pending', deliverables: 'pending', skills: 'pending', instructions: 'pending' };

export interface DraftApplied {
  parts: Partial<AgentWizardDraft>;
  costUsd: number; costKind: 'subscription' | 'usd'; byAgent: string;
}

/** Tope en USD autorizado para la llamada: 0 con suscripción; con API, 1,5 × la estimación (mínimo 0,05 USD). */
export const draftCap = (e: WizardDraftEstimate): number => e.costKind === 'usd' ? Math.max(0.05, Math.ceil(e.estimatedUsd * 150) / 100) : 0;

const costText = (e: WizardDraftEstimate) => e.costKind === 'subscription'
  ? '1 llamada de tu suscripción (0 USD de API)'
  : `≈ ${e.estimatedUsd.toFixed(3)} USD de API (tope ${draftCap(e).toFixed(2)} USD)`;

function hasContent(v: AgentWizardDraft, k: PartKey): boolean {
  const x = v[k];
  return Array.isArray(x) ? x.length > 0 : typeof x === 'string' && x.trim().length > 0;
}

/** Limpia las habilidades editadas: sin nombre se descartan y los slugs quedan únicos. */
function tidySkills(list: PortableSkill[]): PortableSkill[] {
  const seen = new Set<string>(); const out: PortableSkill[] = [];
  for (const s of list) {
    const name = s.name.trim(); if (!name) continue;
    const base = slugify(s.slug || name) || 'habilidad'; let slug = base; let n = 2;
    while (seen.has(slug)) slug = `${base}-${n++}`;
    seen.add(slug); out.push({ ...s, slug, name, description: s.description.trim(), body: s.body.trim() });
  }
  return out;
}

export function AgentDraftReview({ slug, need, onApply, onClose }: { slug: string; need: string; onApply: (r: DraftApplied) => void; onClose: () => void }) {
  const [text] = useState(need.trim());
  const [phase, setPhase] = useState<Phase>('estimating');
  const [est, setEst] = useState<WizardDraftEstimate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<WizardDraftResult | null>(null);
  const [value, setValue] = useState<AgentWizardDraft | null>(null);
  const [decision, setDecision] = useState<Record<PartKey, Decision>>(ALL_PENDING);
  const [editing, setEditing] = useState<PartKey | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let alive = true;
    wizardDraftEstimate(slug, text).then(e => { if (alive) { setEst(e); setPhase('awaiting'); } }).catch((e: any) => { if (alive) { setErr(e?.message ?? String(e)); setPhase('error'); } });
    return () => { alive = false; };
  }, [slug, text]);
  useEffect(() => { if (phase === 'ready') heading.current?.focus(); }, [phase]);

  const authorize = async () => {
    if (!est) return;
    setPhase('calling'); setErr(null);
    try {
      const r = await wizardDraft(slug, text, draftCap(est));
      setRes(r); setValue(r.draft); setDecision(ALL_PENDING); setEditing(null); setPhase('ready');
    } catch (e: any) { setErr(e?.message ?? String(e)); setPhase('error'); }
  };
  const decide = (k: PartKey, v: Decision) => { setDecision(d => ({ ...d, [k]: v })); if (v !== 'pending' && editing === k) setEditing(null); };
  const patch = (p: Partial<AgentWizardDraft>) => setValue(v => (v ? { ...v, ...p } : v));
  const visible = value ? PARTS.filter(p => hasContent(value, p.key)) : [];
  const accepted = visible.filter(p => decision[p.key] === 'accepted');

  const apply = () => {
    if (!value || !res || !est) return;
    const parts: Partial<AgentWizardDraft> = {};
    for (const { key } of accepted) {
      if (key === 'role') parts.role = value.role.trim();
      else if (key === 'summary') parts.summary = value.summary.trim();
      else if (key === 'responsibilities') parts.responsibilities = value.responsibilities.map(s => s.trim()).filter(Boolean);
      else if (key === 'deliverables') parts.deliverables = value.deliverables.map(s => s.trim()).filter(Boolean);
      else if (key === 'skills') parts.skills = tidySkills(value.skills);
      else if (key === 'instructions') parts.instructions = value.instructions.trim();
    }
    onApply({ parts, costUsd: res.costUsd, costKind: est.costKind, byAgent: res.byAgent });
  };

  const listEditor = (k: 'responsibilities' | 'deliverables', label: string) =>
    <textarea className="input" rows={5} aria-label={`${label} (una por línea)`} value={value![k].join('\n')} onChange={e => patch({ [k]: e.target.value.split('\n') } as Partial<AgentWizardDraft>)} />;

  const preview = (k: PartKey) => {
    const v = value!;
    if (k === 'role' || k === 'summary') return <div className="small">{v[k]}</div>;
    if (k === 'responsibilities' || k === 'deliverables') return <ul className="small" style={{ margin: 0 }}>{v[k].filter(Boolean).map((x, i) => <li key={i}>{x}</li>)}</ul>;
    if (k === 'skills') return <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{v.skills.map((s, i) => <details key={i}><summary className="small"><strong>{s.name}</strong>{s.description ? ` — ${s.description}` : ''}</summary><div className="file-view">{s.body || '(sin contenido)'}</div></details>)}</div>;
    return <div className="file-view">{v.instructions}</div>;
  };

  const editor = (k: PartKey) => {
    const v = value!;
    if (k === 'role') return <input className="input" aria-label="Papel" value={v.role} onChange={e => patch({ role: e.target.value })} />;
    if (k === 'summary') return <textarea className="input" rows={3} aria-label="En qué te ayuda" value={v.summary} onChange={e => patch({ summary: e.target.value })} />;
    if (k === 'responsibilities') return listEditor('responsibilities', 'Responsabilidades');
    if (k === 'deliverables') return listEditor('deliverables', 'Entregables');
    if (k === 'instructions') return <textarea className="input" rows={10} aria-label="Instrucciones (AGENTS.md)" value={v.instructions} onChange={e => patch({ instructions: e.target.value })} />;
    const setSkill = (i: number, p: Partial<PortableSkill>) => patch({ skills: v.skills.map((s, j) => (j === i ? { ...s, ...p } : s)) });
    return <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {v.skills.map((s, i) => <div key={i} className="card" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input className="input" aria-label={`Nombre de la habilidad ${i + 1}`} value={s.name} onChange={e => setSkill(i, { name: e.target.value })} />
        <input className="input" aria-label={`Descripción de la habilidad ${i + 1}`} value={s.description} onChange={e => setSkill(i, { description: e.target.value })} />
        <textarea className="input" rows={5} aria-label={`Contenido de la habilidad ${i + 1}`} value={s.body} onChange={e => setSkill(i, { body: e.target.value })} />
        <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => patch({ skills: v.skills.filter((_, j) => j !== i) })}>Quitar esta habilidad</button>
      </div>)}
    </div>;
  };

  return <section className="card" aria-label="Redactar con IA" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
    <div className="h3">Redactar con IA</div>

    {phase === 'estimating' && <div className="small" role="status"><Spinner /> Calculando el motor y el costo (sin llamar a ningún modelo)…</div>}

    {(phase === 'awaiting' || phase === 'calling') && est && <>
      <div className="small">
        <div><strong>Motor:</strong> {est.byAgent} · {est.label} · modelo {est.model}</div>
        <div><strong>Costo:</strong> {costText(est)}</div>
      </div>
      <p className="small muted" style={{ margin: 0 }}>Propone papel, resumen, responsabilidades, entregables, habilidades e instrucciones a partir de tu texto. No propone ni concede permisos, herramientas, arnés ni autonomía: eso lo eliges tú. No se llama a nada hasta que lo autorices.</p>
      {phase === 'calling'
        ? <div className="small" role="status"><Spinner /> Redactando con {est.byAgent}…</div>
        : <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void authorize()}>Autorizar y redactar</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Ahora no</button>
        </div>}
    </>}

    {phase === 'error' && <>
      <Notice kind="err">{err ?? 'No se pudo redactar con IA.'}</Notice>
      <span className="small muted">Puedes seguir sin IA: los perfiles sugeridos y las instrucciones por defecto funcionan igual y sin gasto.</span>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>Seguir sin IA</button>
        {est && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void authorize()}>Reintentar ({costText(est)})</button>}
      </div>
    </>}

    {phase === 'ready' && value && res && <>
      <h4 className="h3" tabIndex={-1} ref={heading} style={{ margin: 0 }}>Propuesta lista</h4>
      <div className="small muted">Redactada por {res.byAgent} · {res.tokensIn + res.tokensOut} tokens · {est?.costKind === 'subscription' ? 'tu suscripción (0 USD de API)' : `${res.costUsd.toFixed(4)} USD de API`}. Acepta, edita o descarta cada parte; solo se aplican las aceptadas.</div>
      {res.discarded.length > 0 && <Notice kind="info">Se descartó lo que la IA no puede proponer: {res.discarded.join(', ')}.</Notice>}
      {visible.map(({ key, label }) => <div key={key} className="card" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 6, opacity: decision[key] === 'discarded' ? 0.55 : 1 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <strong className="small">{label} <span className="muted">· {decision[key] === 'accepted' ? '✓ aceptada' : decision[key] === 'discarded' ? '✕ descartada' : 'por revisar'}</span></strong>
          <span style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn btn-secondary btn-sm" aria-pressed={decision[key] === 'accepted'} onClick={() => decide(key, decision[key] === 'accepted' ? 'pending' : 'accepted')}>Aceptar</button>
            <button type="button" className="btn btn-ghost btn-sm" aria-expanded={editing === key} onClick={() => { setEditing(editing === key ? null : key); if (decision[key] === 'discarded') decide(key, 'pending'); }}>{editing === key ? 'Cerrar edición' : 'Editar'}</button>
            <button type="button" className="btn btn-ghost btn-sm" aria-pressed={decision[key] === 'discarded'} onClick={() => decide(key, decision[key] === 'discarded' ? 'pending' : 'discarded')}>Descartar</button>
          </span>
        </div>
        {editing === key ? editor(key) : preview(key)}
      </div>)}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDecision(d => { const n = { ...d }; for (const p of visible) if (n[p.key] !== 'discarded') n[p.key] = 'accepted'; return n; })}>Aceptar las no descartadas</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!accepted.length} onClick={apply}>Aplicar las partes aceptadas ({accepted.length})</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Descartar la propuesta</button>
      </div>
    </>}
  </section>;
}
