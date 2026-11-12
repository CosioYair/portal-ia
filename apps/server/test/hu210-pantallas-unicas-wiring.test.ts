import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// HU-210 · Pantallas únicas: una tarjeta para registrar el repositorio, un asistente de creación y una configuración por
// agente; las rutas antiguas redirigen. Lectura estática de fuentes: sin IA, red ni costo.
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(webSrc, rel), 'utf8');
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : /\.tsx?$/.test(d.name) ? [p] : [];
  });
}
const rel = (p: string) => path.relative(webSrc, p).split(path.sep).join('/');
const sources = walk(webSrc).map(p => ({ file: rel(p), src: fs.readFileSync(p, 'utf8') }));

test('repositorio: solo RepoCard llama a api.registerRepository y siempre tras la casilla de solo lectura', () => {
  const callers = sources.filter(s => s.src.includes('api.registerRepository(')).map(s => s.file);
  assert.deepEqual(callers, ['components/RepoCard.tsx']);
  const card = read('components/RepoCard.tsx');
  assert.match(card, /if \(!repoPath \|\| !regAuth\) return;/, 'sin autorización no se registra');
  assert.match(card, /disabled=\{!regAuth \|\| !repoPath \|\| busy !== null\}/, 'el botón espera a la casilla');
  assert.match(card, /<strong>solo lectura<\/strong>/);
  assert.match(card, /<FolderPicker [^>]*requireGit/s, 'el selector exige un repositorio git');
  assert.match(card, /Registrar repositorio/);
});

test('repositorio: Inicialización y Resumen muestran la misma tarjeta, sin selector propio', () => {
  for (const f of ['screens/Initialization.tsx', 'screens/Dashboard.tsx']) {
    const src = read(f);
    assert.match(src, /import \{ RepoCard \} from '\.\.\/components\/RepoCard\.tsx';/, f);
    assert.match(src, /<RepoCard project=\{project\} onChanged=\{/, f);
    assert.doesNotMatch(src, /<FolderPicker|registerRepository/, `${f}: el registro vive solo en RepoCard`);
  }
  assert.match(read('screens/Initialization.tsx'), /es la misma que verás en el Resumen/);
});

test('crear agentes: un único asistente; AgentCreate desaparece y /equipo/nuevo redirige a él', () => {
  assert.equal(fs.existsSync(path.join(webSrc, 'screens/AgentCreate.tsx')), false, 'AgentCreate.tsx ya no existe');
  const app = read('App.tsx');
  assert.doesNotMatch(app, /screens\/AgentCreate\.tsx|screens\/AgentDetail\.tsx/, 'App no carga las pantallas antiguas');
  assert.match(app, /path="\/oficina\/nuevo-agente" element=\{guard\(<AgentWizard \/>\)\}/);
  assert.match(app, /path="\/equipo\/nuevo" element=\{<Redirect to="\/oficina\/nuevo-agente" \/>\}/);
});

test('configurar agentes: /equipo/:agentId redirige a la configuración del panel conservando ?… y #…', () => {
  const app = read('App.tsx');
  assert.match(app, /path="\/equipo\/:agentId" element=\{<AgentRedirect \/>\}/);
  const fn = app.slice(app.indexOf('function AgentRedirect'), app.indexOf('function PaletteHost'));
  assert.match(fn, /useParams\(\)/);
  assert.match(fn, /`\/oficina\/agente\/\$\{encodeURIComponent\(agentId \?\? ''\)\}\/configuracion`/);
  assert.match(app, /<Navigate to=\{to \+ search \+ hash\} replace \/>/, 'conserva parámetros y ancla, con replace');
});

test('configurar agentes: los bloques avanzados se editan dentro de Ajustes › Configuración', () => {
  const panel = read('components/AgentPanel.tsx');
  assert.match(panel, /import \{ AgentAdvancedSettings \} from '\.\.\/screens\/AgentDetail\.tsx';/);
  assert.match(panel, /<AgentAdvancedSettings /);
  const detail = read('screens/AgentDetail.tsx');
  assert.match(detail, /export function AgentAdvancedSettings\(/);
  assert.doesNotMatch(detail, /export function AgentDetail\(|<Shell/, 'ya no es una pantalla propia');
  for (const k of ['api.updateAgentConfig', 'capabilities', 'EFFORT_LEVELS', 'TOOLS']) assert.ok(detail.includes(k), `edita ${k}`);
});

test('ningún enlace del front apunta a /equipo/… ni cita «Ajustes avanzados»', () => {
  for (const s of sources.filter(x => x.file !== 'App.tsx'))
    assert.doesNotMatch(s.src, /\/equipo\/(nuevo\b|\$\{)/, `${s.file}: enlaza una ruta antigua de /equipo/`);
  for (const f of ['components/StoryFlowPanel.tsx', 'screens/Settings.tsx', 'components/AgentPanel.tsx', 'screens/Team.tsx'])
    assert.doesNotMatch(read(f), /Ajustes avanzados/, f);
});
