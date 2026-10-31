import { Link } from 'react-router-dom';
import { useApp } from '../lib/store.ts';
import { Shell } from '../components/Shell.tsx';
import { BudgetMeter } from '../components/BudgetMeter.tsx';
import { Notice } from '../components/ui.tsx';

/**
 * Presupuestos: los presupuestos mensuales de la empresa y del proyecto (HU-138, el subsistema que ya existe) y dónde se
 * controla cada otro tipo de gasto, para no confundirlos: el presupuesto que autorizas en cada proceso y el uso de la
 * suscripción de Claude Code (que no se cobra en USD).
 */
export function Budgets() {
  const { status } = useApp();
  const ws = status.workspace!; const project = status.project;
  return (
    <Shell crumb="Presupuestos">
      <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 980 }} aria-label="Presupuestos">
        <div>
          <h1 className="h2" style={{ margin: 0 }}>Presupuestos</h1>
          <p className="lede lede-2l" style={{ margin: '4px 0 0' }}>Tres controles distintos del gasto. Fijar un presupuesto no consume IA y pide confirmación.</p>
        </div>
        <section className="card" aria-label="Presupuestos mensuales">
          <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <strong className="sm13">1 · Presupuesto mensual de la empresa y del proyecto</strong>
            <span className="small muted">Límite, gasto, reservas y saldo del mes. El gasto de las historias aún no se descuenta de aquí: lo controla el punto 2.</span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
              <BudgetMeter level="company" scopeId={ws.slug} title={`Empresa · ${ws.name}`} />
              {project && <BudgetMeter level="project" scopeId={project.id} workspace={ws.slug} title={`Proyecto · ${project.name}`} />}
            </div>
          </div>
        </section>
        <section className="card" aria-label="Presupuesto de cada proceso">
          <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <strong className="sm13">2 · Presupuesto de cada proceso (historias y encargos)</strong>
            <span className="small">Máximo de API que fijas al autorizar o continuar un proceso. Si no alcanza, el proceso se pausa y ofrece continuar con más.</span>
            <Link className="lnk small" to="/actividad">Ver los procesos y su gasto (Actividad)</Link>
          </div>
        </section>
        <section className="card" aria-label="Suscripción de Claude Code">
          <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <strong className="sm13">3 · Claude Code — Local (tu suscripción)</strong>
            <span className="small">Usa tu suscripción de Claude: 0 USD de API y no descuenta de los presupuestos anteriores.</span>
            <Link className="lnk small" to="/configuracion/proveedor#claude-code">Proveedores → Claude Code — Local: límites (llamadas por día, turnos, concurrencia) y proyectos autorizados</Link>
          </div>
        </section>
        <Notice kind="info">El límite mensual del Asistente se configura en su agente (Equipo de IA → Asistente).</Notice>
      </main>
    </Shell>
  );
}
