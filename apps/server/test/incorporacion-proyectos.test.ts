import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Cimientos para incorporar proyectos EXISTENTES (encargo «empresa autónoma», parte V): el descubrimiento solo lee
 * metadatos de su repositorio y propone un perfil (comandos, herramientas, documentación) sin ejecutar nada ni leer
 * secretos, y descubrir no autoriza nada; y la verificación mínima en el equipo ya no da por buena una comprobación que
 * no comprobó nada (antes un proyecto externo sin Docker se podía integrar sin verificar). Sin IA.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-incorp-'));
process.env.PORTAL_ALLOW_FOREIGN_REPO = '1';
process.env.LOG_LEVEL = 'warn';
const { runBootstrap } = await import('../src/routes/bootstrap.ts');
const { projectsRepo } = await import('../src/db/workspace.ts');
const { buildApp } = await import('./fixtures/owner-app.ts'); // con el propietario vinculado (todo cambio lo exige)
const { discoverProject, redactRemote } = await import('../src/services/projectDiscovery.ts');
const { runHostTypecheckMin } = await import('../src/services/sandbox.ts');
const { INTERNAL_WORKSPACE, classifyModel } = await import('@portal-ia/domain');
const { encryptSecret } = await import('../src/security/crypto.ts');
const { providersRepo } = await import('../src/db/platform.ts');
providersRepo.setCredential('anthropic', encryptSecret('sk-ant-test'), 'sk-ant-…test');
providersRepo.setConnected('anthropic', ['claude-sonnet-4-5'].map(id => classifyModel('anthropic', id)));
runBootstrap();
const S = INTERNAL_WORKSPACE.slug;
const app = await buildApp();
after(async () => { await app.close(); });

const SECRET = 'sk-live-NO-DEBE-SALIR-1234';
const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-incorp-ext-'));
const put = (rel: string, content: string) => { fs.mkdirSync(path.dirname(path.join(ext, rel)), { recursive: true }); fs.writeFileSync(path.join(ext, rel), content); };
put('package.json', JSON.stringify({ name: 'orbita', private: true, scripts: { dev: 'vite', lint: 'eslint .', test: 'vitest run', build: 'vite build' }, dependencies: { react: '18' }, devDependencies: { vite: '5', vitest: '1' } }));
put('pnpm-lock.yaml', 'lockfileVersion: 9\n');
put('tsconfig.json', '{}');
put('src/app.tsx', 'export const App = () => null;\n');
put('scripts/etl.py', 'print(1)\n');
put('.github/workflows/ci.yml', 'name: ci\n');
put('README.md', '# Órbita\n'); put('docs/arquitectura.md', '# Arquitectura\n');
put('.env.example', 'API_KEY=\n'); put('.mcp.json', '{"mcpServers":{}}'); put('Dockerfile', 'FROM node:22\n');
put('.gitignore', '.env\n'); put('.env', `API_KEY=${SECRET}\n`);
execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base && git remote add origin https://usuario:tok123@github.com/dueno/orbita.git', { cwd: ext });

test('descubrimiento de un proyecto existente: propone su perfil (pnpm, scripts, CI, docs, herramientas) sin ejecutar nada ni leer secretos; es una propuesta', async () => {
  const d = await discoverProject(ext);
  assert.equal(d.status, 'proposed', 'descubrir no es autorizar');
  assert.equal(d.git.isGit, true); assert.equal(d.git.branch, 'main');
  assert.deepEqual(d.git.remotes, [{ name: 'origin', url: 'https://github.com/dueno/orbita.git' }], 'sin credenciales en la URL del remoto');
  assert.equal(d.stack.packageManager, 'pnpm'); assert.ok(d.stack.languages.includes('TypeScript') && d.stack.languages.includes('Python'));
  assert.ok(d.stack.frameworks.includes('React') && d.stack.frameworks.includes('Vite') && d.stack.frameworks.includes('Vitest'));
  assert.equal(d.stack.containers, true);
  assert.deepEqual(d.proposedCommands, { install: 'pnpm install --frozen-lockfile', typecheck: 'pnpm exec tsc --noEmit', lint: 'pnpm run lint', test: 'pnpm test', build: 'pnpm run build' });
  assert.deepEqual(d.ci, ['.github/workflows/ci.yml']);
  assert.ok(d.docs.includes('README.md') && d.docs.includes('docs/arquitectura.md'));
  assert.ok(d.tooling.some(t => /MCP/.test(t)) && d.tooling.some(t => /\.env\.example/.test(t)));
  assert.ok(d.warnings.some(w => /pnpm/.test(w)) && d.warnings.some(w => /Python/.test(w)), 'dice qué no soporta aún el sandbox');
  assert.doesNotMatch(JSON.stringify(d), new RegExp(SECRET), 'el .env nunca se lee');
  assert.equal(redactRemote('https://x:y@host/r.git'), 'https://host/r.git');
  // Por la API, solo del repositorio YA registrado del proyecto.
  const project = projectsRepo(S).list()[0];
  projectsRepo(S).setRepository(project.id, ext, 'main');
  const r = await app.inject({ method: 'GET', url: `/api/workspaces/${S}/projects/${project.id}/discovery` });
  assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().proposedCommands.test, 'pnpm test');
  assert.doesNotMatch(r.body, new RegExp(SECRET));
});

test('verificación mínima en el equipo: un repositorio sin proyectos TypeScript conocidos NO cuenta como typecheck en verde', async () => {
  // El compilador es el del Portal (raíz del repositorio, dos niveles por encima de apps/server).
  const v = await runHostTypecheckMin(ext, path.resolve(process.cwd(), '..', '..'), 30_000);
  assert.notEqual(v.exitCode, 0); assert.equal(v.isolation, 'unavailable');
  assert.match(v.output, /No se comprobó nada/);
});
