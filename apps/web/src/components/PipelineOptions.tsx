import type { PipelineConfig } from '@portal-ia/domain';
import { PIPELINE_LIMITS } from '@portal-ia/domain';

export interface TeamLine { agentName: string; role: string; model: string; effort?: string | null; tools?: string[] }

const EFFORT: Record<string, string> = { low: 'bajo', medium: 'medio', high: 'alto' };
const CMD: Record<string, string> = { typecheck: 'typecheck', test: 'pruebas', build: 'compilación' };

/**
 * Qué incluye la autorización de una historia: el pipeline autónomo (aplicar en worktree, verificar en sandbox, QA con
 * evidencia, correcciones acotadas) y sus límites. Lo que NUNCA hace solo: integrar en main, reiniciar el Portal, publicar.
 */
export function PipelineOptions({ value, onChange, team, repo, compact }: { value: PipelineConfig; onChange: (v: PipelineConfig) => void; team?: TeamLine[]; repo?: string | null; compact?: boolean }) {
  const set = (patch: Partial<PipelineConfig>) => onChange({ ...value, ...patch });
  const num = (k: 'maxOutputRepairs' | 'maxCorrections' | 'maxIdenticalFailures' | 'maxDurationMin', min: number, max: number) =>
    <input className="input mono" type="number" min={min} max={max} value={value[k]} onChange={e => set({ [k]: Math.max(min, Math.min(max, Math.floor(Number(e.target.value) || min))) } as Partial<PipelineConfig>)} style={{ width: 72, height: 30 }} aria-label={k} />;
  return (
    <div className="pipe-opts" style={{ display: 'flex', flexDirection: 'column', gap: 8, border: '1px solid #E4E2DC', borderRadius: 10, padding: '10px 12px', background: '#FBFAF7' }} data-testid="pipeline-options">
      <label className="ck"><input className="cb" type="checkbox" checked={value.autoApply} onChange={e => set({ autoApply: e.target.checked, autoVerify: e.target.checked })} />
        <span><strong>Completar el ciclo técnico sin interrupciones</strong>: el equipo aplica los cambios en un worktree aislado, verifica en el sandbox, QA valida con la evidencia y corrige errores rutinarios dentro de este presupuesto. Te avisa al terminar.</span></label>
      {value.autoApply && <>
        <div className="small" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="muted">Verificación:</span>
          {(['typecheck', 'test', 'build'] as const).map(c => <label key={c} className="ck" style={{ gap: 4 }}><input className="cb" type="checkbox" checked={value.commands.includes(c)} onChange={e => set({ commands: e.target.checked ? (['typecheck', 'test', 'build'] as const).filter(x => x === c || value.commands.includes(x)) : value.commands.filter(x => x !== c) })} /><span>{CMD[c]}</span></label>)}
        </div>
        <label className="ck"><input className="cb" type="checkbox" checked={value.allowInstall} onChange={e => set({ allowInstall: e.target.checked })} />
          <span>Si faltan dependencias en el sandbox, <strong>instalarlas con red temporal</strong> (solo durante la instalación, sin scripts del repositorio). Sin esto, el proceso se pausa y te lo pide.</span></label>
        {!compact && <div className="small" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>Correcciones máx. {num('maxCorrections', 0, PIPELINE_LIMITS.maxCorrections)}</label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>Reparaciones de formato {num('maxOutputRepairs', 0, PIPELINE_LIMITS.maxOutputRepairs)}</label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>Mismo fallo tolerado {num('maxIdenticalFailures', 1, PIPELINE_LIMITS.maxIdenticalFailures)}</label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>Duración máx. (min) {num('maxDurationMin', 5, PIPELINE_LIMITS.maxDurationMin)}</label>
        </div>}
      </>}
      {team && team.length > 0 && <details><summary className="small" style={{ cursor: 'pointer' }}>Qué autorizas exactamente</summary>
        <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {team.map((t, i) => <li key={i}><strong>{t.agentName}</strong> ({t.role}) · <span className="mono">{t.model}</span>{t.effort ? ` · razonamiento ${EFFORT[t.effort] ?? t.effort}` : ''}{t.tools?.length ? ` · herramientas: ${t.tools.join(', ')}` : ''}</li>)}
          {repo && <li>Repositorio: <span className="mono">{repo}</span> · los cambios se escriben solo en el worktree del proceso; tu carpeta no cambia de rama.</li>}
          <li>{value.autoApply ? `Automático: aplicar, ${value.commands.map(c => CMD[c]).join(', ')}${value.allowInstall ? ', instalar dependencias (red temporal)' : ''}, QA con evidencia, hasta ${value.maxCorrections} corrección(es) y ${value.maxOutputRepairs} reparación(es) de formato; se detiene si el mismo fallo se repite más de ${value.maxIdenticalFailures} vez/veces o a los ${value.maxDurationMin} min.` : 'Manual: cada paso (aplicar, verificar, integrar) lo autorizas tú.'}</li>
          <li>Nunca automático: integrar en main, reiniciar el Portal, publicar en GitHub. El presupuesto es un máximo: antes de cada llamada a la IA se comprueba que alcanza; si no, se pausa sin gastar.</li>
        </ul></details>}
    </div>
  );
}
