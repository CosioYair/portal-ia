import { Link } from 'react-router-dom';
import { Chip, Icon, Wordmark } from '../components/ui.tsx';

export function Welcome() {
  return (
    <div className="screen setup">
      <header className="setup-top"><Wordmark provisional /><div className="muted small mono">local · primera ejecución · v0.1</div></header>
      <main className="setup-main" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(440px, 100%), 1fr))', gap: 56, alignItems: 'center', maxWidth: 1140 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div className="eyebrow">Primera ejecución</div>
          <h1 className="h1">Configura tu espacio de trabajo local para equipos de agentes de IA</h1>
          <p className="lede">Portal IA te permite crear empresas y proyectos operados por agentes especializados, dentro de límites que tú apruebas. Todo se ejecuta y se guarda en este equipo.</p>
          <ol className="steps3">
            <li><span className="sn">1</span><span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><span style={{ fontWeight: 600 }}>Conectar un proveedor de IA</span><span className="sm13 muted">Claude (Anthropic) u OpenAI, con tu propia clave de API.</span></span></li>
            <li><span className="sn">2</span><span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><span style={{ fontWeight: 600 }}>Inicializar el espacio interno</span><span className="sm13 muted">Se crean el espacio «Portal IA» y el proyecto «Desarrollo del Portal».</span></span></li>
            <li><span className="sn">3</span><span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><span style={{ fontWeight: 600 }}>Preparar el equipo inicial</span><span className="sm13 muted">8 agentes configurados desde plantillas aprobadas, inactivos hasta que los actives.</span></span></li>
          </ol>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <Link className="btn btn-primary" to="/configuracion/proveedor">Conectar un proveedor de IA {Icon.arrow()}</Link>
            <span className="muted sm13">Unos dos minutos</span>
          </div>
          <div className="assure">{Icon.lock()}<span>Las credenciales se cifran en este equipo. No se realiza ninguna operación de IA con costo sin tu autorización explícita.</span></div>
        </div>
        <aside className="card" style={{ padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 14, boxShadow: '0 1px 2px rgba(26,27,30,.04), 0 12px 32px rgba(26,27,30,.06)' }}>
          <div className="eyebrow">Qué se creará</div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div className="mt-row"><span className="tsq tsq-ws" /><span style={{ flex: 1, fontWeight: 600 }}>Espacio interno · Portal IA</span><Chip tone="accent" xs>aislado</Chip></div>
            <div className="mt-row" style={{ paddingLeft: 22 }}><span className="tsq tsq-pj" /><span style={{ flex: 1, fontWeight: 500 }}>Proyecto · Desarrollo del Portal</span><Chip xs>interno</Chip></div>
            <div className="mt-row" style={{ paddingLeft: 44 }}><span className="tsq" /><span style={{ flex: 1 }}>Equipo inicial · 8 agentes</span><Chip xs dot="">inactivos</Chip></div>
            <div className="mt-row" style={{ paddingLeft: 44 }}><span className="tsq" /><span style={{ flex: 1 }}>Repositorio del código fuente</span><Chip tone="warn" xs>requiere autorización</Chip></div>
            <div className="mt-row" style={{ paddingLeft: 22 }}><span className="tsq" /><span style={{ flex: 1 }}>Empresas y clientes</span><Chip tone="soon" xs>más adelante</Chip></div>
          </div>
          <p className="sm13 med" style={{ lineHeight: 1.5 }}>Este espacio interno es el primer cliente de la plataforma: sus agentes trabajarán sobre el propio código de Portal IA, separados de cualquier empresa que crees después.</p>
        </aside>
      </main>
    </div>
  );
}
