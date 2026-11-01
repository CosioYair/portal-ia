// Vista previa de un candidato de integración, DENTRO de su contenedor SIN red (ver apps/server/src/services/preview.ts).
// Es código de confianza del Portal en marcha (un archivo copiado, montado en solo lectura): compila y arranca el CANDIDATO
// (copia de solo lectura en /work) con datos temporales y el proveedor de IA simulado, y lo expone SOLO por un socket en el
// volumen compartido con el proxy (/run/pv/app.sock, un tmpfs de 1 MB). Nunca recibe credenciales ni el directorio de datos real del Portal.
// Uso: node preview-runner.mjs <portal|script>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

const profile = process.argv[2]; const PORT = 8080; const SOCK = '/run/pv/app.sock';
const log = m => console.log(`[vista previa] ${m}`);
const env = { ...process.env, HOME: '/tmp', TMPDIR: '/tmp', npm_config_cache: '/tmp/npm-cache', npm_config_update_notifier: 'false', CI: '1', FORCE_COLOR: '0' };
const run = (cmd, args, opts) => new Promise((resolve, reject) => {
  const c = spawn(cmd, args, { stdio: 'inherit', ...opts });
  c.on('error', reject); c.on('exit', code => code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} terminó con ${code}`)));
});
// Único camino de entrada: el socket del volumen compartido → el candidato en el loopback de este contenedor (sin red).
const bridge = () => {
  try { fs.unlinkSync(SOCK); } catch { /* no había */ }
  net.createServer(c => { const u = net.connect(PORT, '127.0.0.1'); c.pipe(u); u.pipe(c); c.on('error', () => u.destroy()); u.on('error', () => c.destroy()); }).listen(SOCK);
};

if (!fs.existsSync('/work/node_modules/.portal-ia-ready')) { log('faltan las dependencias Linux de este package-lock (verifica la historia en el sandbox con «install» primero).'); process.exit(86); }
try {
  if (profile === 'portal') {
    log('compilando la interfaz del candidato (npm run build)…');
    await run('npm', ['run', 'build'], { cwd: '/work', env });
    // Datos y worktrees en /tmp del contenedor (se pierden al detenerla); IA simulada; sin sandbox anidado ni Claude Code.
    const server = spawn(process.execPath, ['/work/node_modules/tsx/dist/cli.mjs', 'src/index.ts'], {
      cwd: '/work/apps/server', stdio: 'inherit',
      env: { ...env, PORTAL_HOST: '127.0.0.1', PORTAL_PORT: String(PORT), PORTAL_DATA_DIR: '/tmp/portal-data', PORTAL_WORKTREES_DIR: '/tmp/portal-worktrees', PORTAL_MOCK_PROVIDER: '1', PORTAL_SANDBOX: 'none', PORTAL_PREVIEW: '1', LOG_LEVEL: 'warn' }
    });
    server.on('exit', code => { log(`el servidor del candidato terminó (${code})`); process.exit(code ?? 1); });
    for (let i = 0; i < 240; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch { /* arrancando */ }
      await new Promise(r => setTimeout(r, 500));
    }
    // Espacio interno con sus agentes base, para que la interfaz no se quede en la bienvenida (sin datos reales): el
    // proveedor es el SIMULADO (PORTAL_MOCK_PROVIDER) con una clave ficticia que solo existe en esta copia temporal.
    const api = (method, p, body) => fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }).catch(() => null);
    await api('PUT', '/api/providers/anthropic/credential', { apiKey: 'sk-ant-VISTA-PREVIA-simulada-no-real-0000' });
    await api('POST', '/api/providers/anthropic/verify');
    await api('POST', '/api/bootstrap/internal');
    bridge();
    log('lista');
  } else if (profile === 'script') {
    log('arrancando «npm run preview» del candidato…');
    const c = spawn('npm', ['run', 'preview'], { cwd: '/work', stdio: 'inherit', env: { ...env, PORT: String(PORT), HOST: '127.0.0.1' } });
    c.on('exit', code => { log(`«npm run preview» terminó (${code})`); process.exit(code ?? 1); });
    bridge();
  } else { log(`perfil desconocido: ${profile}`); process.exit(2); }
} catch (e) { log(String(e?.message ?? e)); process.exit(1); }
