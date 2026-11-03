import { Link } from 'react-router-dom';
import { Chip, Icon, Wordmark } from '../components/ui.tsx';
import { OfficeBuilding } from '../components/illustrations.tsx';

/** Primera ejecución: qué es el Portal, los tres pasos y qué se creará (nada consume IA hasta que lo autorices). */
export function Welcome() {
  return (
    <div className="screen setup">
      <header className="setup-top"><Wordmark provisional /><div className="muted small mono">local · primera ejecución</div></header>
      <main className="setup-main" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(440px, 100%), 1fr))', gap: 56, alignItems: 'center', maxWidth: 1140 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div className="eyebrow">Primera ejecución</div>
          <h1 className="h1">Tu empresa de agentes de IA, en este equipo</h1>
          <p className="lede">Portal IA te permite crear empresas y proyectos operados por agentes especializados, dentro de límites que tú apruebas. Todo se ejecuta y se guarda en este equipo.</p>
          <ol className="steps3">
            <li><span className="sn">1</span><span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><span style={{ fontWeight: 600 }}>Conectar un proveedor de IA</span><span className="sm13 muted">Claude (Anthropic) u OpenAI, con tu propia clave de API. Después podrás usar también tu suscripción de Claude Code.</span></span></li>
            <li><span className="sn">2</span><span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><span style={{ fontWeight: 600 }}>Preparar la empresa interna</span><span className="sm13 muted">Se crean la empresa «Portal IA» y el proyecto «Desarrollo del Portal».</span></span></li>
            <li><span className="sn">3</span><span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><span style={{ fontWeight: 600 }}>Preparar el equipo inicial</span><span className="sm13 muted">8 agentes configurados desde plantillas aprobadas; ninguno trabaja hasta que autorices su trabajo.</span></span></li>
          </ol>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <Link className="btn btn-primary" to="/configuracion/proveedor">Conectar un proveedor de IA {Icon.arrow()}</Link>
            <span className="muted sm13">Unos dos minutos</span>
          </div>
          <div className="assure">{Icon.lock()}<span>Las credenciales se cifran en este equipo. No se realiza ninguna operación de IA con costo sin tu autorización explícita.</span></div>
        </div>
        <aside className="card welcome-card">
          <OfficeBuilding size={260} className="welcome-art" />
          <div className="eyebrow">Qué se creará</div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div className="mt-row"><span className="tsq tsq-ws" /><span style={{ flex: 1, fontWeight: 600 }}>Empresa interna · Portal IA</span><Chip tone="accent" xs>aislada</Chip></div>
            <div className="mt-row" style={{ paddingLeft: 22 }}><span className="tsq tsq-pj" /><span style={{ flex: 1, fontWeight: 500 }}>Proyecto · Desarrollo del Portal</span><Chip xs>interno</Chip></div>
            <div className="mt-row" style={{ paddingLeft: 44 }}><span className="tsq" /><span style={{ flex: 1 }}>Equipo inicial · 8 agentes</span><Chip xs>sin trabajo asignado</Chip></div>
            <div className="mt-row" style={{ paddingLeft: 44 }}><span className="tsq" /><span style={{ flex: 1 }}>Repositorio del código fuente</span><Chip tone="warn" xs>requiere autorización</Chip></div>
            <div className="mt-row" style={{ paddingLeft: 22 }}><span className="tsq" /><span style={{ flex: 1 }}>Tus empresas y proyectos</span><Chip xs>cuando quieras</Chip></div>
          </div>
          <p className="sm13 med" style={{ lineHeight: 1.5 }}>La empresa interna es el primer cliente de la plataforma: sus agentes trabajan sobre el propio código de Portal IA, separados de cualquier empresa que crees después.</p>
        </aside>
      </main>
    </div>
  );
}
