import { Link } from 'react-router-dom';
import type { PhaseTransition } from '@portal-ia/domain';
import { useApp } from '../lib/store.ts';
import { Icon } from './ui.tsx';

/** Texto que «Solicitar evaluación del proyecto» deja preparado en el Asistente (el propietario lo envía; nada se gasta antes). */
export const EVALUATION_REQUEST = 'Solicito una evaluación del proyecto para la nueva etapa: que el Coordinador del Proyecto, junto con el Gestor Organizacional, revise la línea base y proponga (1) las primeras historias de mayor valor y (2) si la organización actual de agentes es suficiente, qué responsabilidades se solapan, qué capacidades faltan y si hacen falta agentes o departamentos nuevos (con plantillas aprobadas y permisos mínimos). Los cambios organizativos los apruebo yo.';

/**
 * Estado vacío del backlog: el equipo está listo para la etapa nueva. Tres caminos: hablar con el equipo, pedir una
 * evaluación (encargo autorizado) o crear la primera historia.
 */
export function TeamReady({ phase, onCreate }: { phase: PhaseTransition | null; onCreate: () => void }) {
  const { navigate } = useApp();
  return (
    <div className="empty" style={{ padding: '28px 16px 22px', gap: 10 }} data-testid="team-ready">
      <span className="empty-ic">{Icon.inbox()}</span>
      <div style={{ fontWeight: 600, color: '#1A1B1E', fontSize: 16 }}>No hay historias pendientes</div>
      <div className="sm13" style={{ maxWidth: '52ch' }}>Tu equipo está listo para comenzar una nueva etapa de desarrollo.{phase ? <> Etapa vigente: <strong>{phase.name}</strong>. El código existente es la base: está descrito en la <Link className="lnk" to="/conocimiento">línea base</Link>.</> : null}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 6 }}>
        <button className="btn btn-secondary btn-sm" onClick={() => navigate('/asistente')}>{Icon.user()}Hablar con mi equipo</button>
        <button className="btn btn-secondary btn-sm" onClick={() => navigate('/asistente', { state: { draft: EVALUATION_REQUEST } })}>{Icon.users()}Solicitar evaluación del proyecto</button>
        <button className="btn btn-primary btn-sm" onClick={onCreate}>{Icon.arrow()}Crear primera historia</button>
      </div>
      {phase && <div className="small muted" style={{ marginTop: 4 }}>El trabajo de la etapa anterior está en el <Link className="lnk" to="/archivo">archivo histórico</Link>.</div>}
    </div>
  );
}
