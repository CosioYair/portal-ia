import { Link } from 'react-router-dom';
import { useApp } from '../lib/store.ts';
import { Shell } from '../components/Shell.tsx';
import { BudgetMeter } from '../components/BudgetMeter.tsx';
import { Icon, Notice } from '../components/ui.tsx';
import { PageHeader } from '../components/kit.tsx';

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
        <PageHeader icon={Icon.wallet()} tone="settings" eyebrow={<Link className="lnk" to="/ajustes">Ajustes</Link>} title="Presupuestos"
          description="Tres controles distintos del gasto. Fijar un presupuesto no consume IA y pide confirmación." />
        <section className="card" aria-label="Presupuestos mensuales">
          <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <strong className="sm13">1 · Presupuesto mensual de la empresa y del proyecto</strong>
            <span className="small muted">Límite, gasto, reservas y saldo del mes. El gasto de las historias aún no se descuenta de aquí: lo controla el punto 2.</span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: 12 }}>
              <BudgetMeter level="company" scopeId={ws.slug} title={`Empresa · ${ws.name}`} />
              {project && <BudgetMeter level="project" scopeId={project.id} workspace={ws.slug} title={`Proyecto · ${project.name}`} />}
            </div>
          </div>
        </section>
        <section className="card" aria-label="Presupuesto de cada proceso">
          <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <strong className="sm13">2 · Presupuesto de cada proceso (historias y encargos)</strong>
            <span className="small">Máximo de API que fijas al autorizar un proceso; si no alcanza, se pausa. Un error de «presupuesto no positivo» en las pruebas se refiere a este.</span>
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
        <Notice kind="info">El límite mensual del Asistente se configura en su ficha avanzada (Ajustes › Asistente de Empresa).</Notice>
      </main>
    </Shell>
  );
}
