import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readProtectedReason, repoRoot } from './repoWrite.ts';

/**
 * Descubrimiento de un proyecto EXISTENTE (cimiento de la incorporación de proyectos, p. ej. Orbiventt): qué es, cómo se
 * construye y se prueba, qué herramientas y convenciones usa, sin ejecutar nada suyo ni llamar a la IA. Solo lee
 * metadatos (lista de archivos, manifiestos, nombres de flujos de CI) y nunca rutas protegidas (.env, credenciales…).
 *
 * Descubrir NO es autorizar: el resultado es una PROPUESTA (`status: 'proposed'`) de perfil del proyecto (comandos,
 * herramientas, documentación) que el propietario revisa; nada se configura ni se concede a los agentes por descubrirlo.
 */

const execFileP = promisify(execFile);
const MAX_LIST = 4000;

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
export interface ProjectDiscovery {
  status: 'proposed';
  root: string;
  git: { isGit: boolean; branch: string | null; remotes: { name: string; url: string | null }[]; branches: number };
  stack: { languages: string[]; packageManager: PackageManager | null; frameworks: string[]; monorepo: boolean; containers: boolean };
  /** Scripts declarados por el propio proyecto (no se ejecutan aquí). */
  scripts: Record<string, string>;
  /** Comandos que el perfil propondría para cada etapa (null si el proyecto no declara uno): los decide el propietario. */
  proposedCommands: Record<'install' | 'typecheck' | 'lint' | 'test' | 'build', string | null>;
  ci: string[];
  docs: string[];
  /** Integraciones declaradas en el repositorio (MCP, contenedores, entorno de ejemplo): solo su presencia, nunca su contenido secreto. */
  tooling: string[];
  warnings: string[];
}

const exists = (root: string, rel: string) => { try { return fs.existsSync(path.join(root, rel)); } catch { return false; } };
/** Lee un archivo de metadatos solo si NO es una ruta protegida (y con un tamaño acotado). */
function readMeta(root: string, rel: string, max = 200_000): string | null {
  if (readProtectedReason(rel)) return null;
  try { const abs = path.join(root, rel); const st = fs.statSync(abs); if (!st.isFile() || st.size > max) return null; return fs.readFileSync(abs, 'utf8'); } catch { return null; }
}
/** Sin credenciales en la URL de un remoto (https://usuario:token@host → https://host). */
export const redactRemote = (url: string | null) => url ? url.replace(/\/\/[^/@\s]+@/, '//') : null;

export async function discoverProject(repoPath: string): Promise<ProjectDiscovery> {
  const root = repoRoot(repoPath);
  const warnings: string[] = [];
  const git = async (args: string[]) => (await execFileP('git', args, { cwd: root, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
  const isGit = await git(['rev-parse', '--is-inside-work-tree']).then(x => x === 'true').catch(() => false);
  let files: string[] = [];
  if (isGit) files = (await git(['ls-files']).catch(() => '')).split(/\r?\n/).filter(Boolean).slice(0, MAX_LIST * 10);
  else { warnings.push('No es un repositorio git: el Portal trabaja con ramas y worktrees; inicialízalo antes de incorporarlo.'); try { files = fs.readdirSync(root).slice(0, MAX_LIST); } catch { /* carpeta ilegible */ } }
  const visible = files.filter(f => !readProtectedReason(f));
  const branch = isGit ? await git(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => null) : null;
  const remotes = isGit ? await Promise.all((await git(['remote']).catch(() => '')).split(/\r?\n/).filter(Boolean).map(async name => ({ name, url: redactRemote(await git(['remote', 'get-url', name]).catch(() => null)) }))) : [];
  const branches = isGit ? (await git(['branch', '--format=%(refname:short)']).catch(() => '')).split(/\r?\n/).filter(Boolean).length : 0;

  const pkgText = readMeta(root, 'package.json'); let pkg: any = null;
  try { pkg = pkgText ? JSON.parse(pkgText) : null; } catch { warnings.push('package.json no es JSON válido.'); }
  const packageManager: PackageManager | null = exists(root, 'pnpm-lock.yaml') ? 'pnpm' : exists(root, 'yarn.lock') ? 'yarn' : exists(root, 'bun.lockb') || exists(root, 'bun.lock') ? 'bun' : pkg ? 'npm' : null;
  const has = (re: RegExp) => visible.some(f => re.test(f));
  const languages = [
    has(/\.(ts|tsx)$/) ? 'TypeScript' : '', has(/\.(js|jsx|mjs|cjs)$/) ? 'JavaScript' : '', has(/\.py$/) ? 'Python' : '', has(/\.go$/) ? 'Go' : '',
    has(/\.rs$/) ? 'Rust' : '', has(/\.(java|kt)$/) ? 'Java/Kotlin' : '', has(/\.(cs|fs)$/) ? '.NET' : '', has(/\.(swift)$/) ? 'Swift' : '', has(/\.dart$/) ? 'Dart' : '', has(/\.php$/) ? 'PHP' : '', has(/\.rb$/) ? 'Ruby' : ''
  ].filter(Boolean);
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const frameworks = [['react', 'React'], ['next', 'Next.js'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['@angular/core', 'Angular'], ['express', 'Express'], ['fastify', 'Fastify'], ['@nestjs/core', 'NestJS'], ['vite', 'Vite'], ['react-native', 'React Native'], ['expo', 'Expo'], ['electron', 'Electron'], ['prisma', 'Prisma'], ['vitest', 'Vitest'], ['jest', 'Jest'], ['playwright', 'Playwright'], ['@playwright/test', 'Playwright']]
    .filter(([d]) => d in deps).map(([, n]) => n).filter((n, i, a) => a.indexOf(n) === i);
  if (exists(root, 'pubspec.yaml')) frameworks.push('Flutter');
  if (exists(root, 'manage.py')) frameworks.push('Django');
  const monorepo = !!pkg?.workspaces || exists(root, 'pnpm-workspace.yaml') || exists(root, 'turbo.json') || exists(root, 'nx.json') || exists(root, 'lerna.json');
  const containers = exists(root, 'Dockerfile') || has(/(^|\/)docker-compose[^/]*\.ya?ml$/) || has(/(^|\/)compose\.ya?ml$/);
  const scripts: Record<string, string> = Object.fromEntries(Object.entries(pkg?.scripts ?? {}).filter(([, v]) => typeof v === 'string').slice(0, 60)) as Record<string, string>;
  const run = (name: string) => !packageManager ? null : packageManager === 'npm' ? (name === 'test' ? 'npm test' : `npm run ${name}`) : `${packageManager} ${name === 'test' ? 'test' : `run ${name}`}`;
  const pick = (...names: string[]) => { const n = names.find(x => x in scripts); return n ? run(n) : null; };
  const install = !packageManager ? null : packageManager === 'npm' ? (exists(root, 'package-lock.json') ? 'npm ci' : 'npm install') : packageManager === 'pnpm' ? 'pnpm install --frozen-lockfile' : packageManager === 'yarn' ? 'yarn install --frozen-lockfile' : 'bun install --frozen-lockfile';
  const proposedCommands = {
    install,
    typecheck: pick('typecheck', 'type-check', 'tsc', 'check:types') ?? (exists(root, 'tsconfig.json') && packageManager ? `${packageManager === 'npm' ? 'npx' : packageManager === 'bun' ? 'bunx' : `${packageManager} exec`} tsc --noEmit` : null),
    lint: pick('lint', 'lint:all'),
    test: pick('test', 'test:unit', 'test:ci'),
    build: pick('build', 'compile')
  };
  if (!pkg && !languages.length) warnings.push('No se reconoce el tipo de proyecto: define sus comandos a mano en su perfil.');
  if (pkg && !proposedCommands.test) warnings.push('El proyecto no declara un script de pruebas: sin él, la verificación del Portal no puede comprobar su comportamiento.');
  if (pkg && packageManager !== 'npm') warnings.push(`Usa ${packageManager}: el sandbox actual del Portal solo instala con npm (perfil de proyecto pendiente en la hoja de ruta).`);
  if (languages.some(l => !['TypeScript', 'JavaScript'].includes(l))) warnings.push(`Incluye ${languages.filter(l => !['TypeScript', 'JavaScript'].includes(l)).join(', ')}: el sandbox actual es Node; esos comandos necesitan una imagen del proyecto (hoja de ruta).`);
  const ci = visible.filter(f => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f) || /^\.gitlab-ci\.ya?ml$/.test(f) || /^azure-pipelines\.ya?ml$/.test(f) || /^\.circleci\/config\.ya?ml$/.test(f)).slice(0, 30);
  const docs = visible.filter(f => /^(README|CONTRIBUTING|ARCHITECTURE|CHANGELOG|AGENTS|CLAUDE)(\.[a-z]+)?$/i.test(f) || /^docs\/[^/]+\.(md|mdx)$/i.test(f)).slice(0, 40);
  const tooling = [
    exists(root, '.mcp.json') ? 'servidores MCP del proyecto (.mcp.json; no se activan por descubrirlos)' : '',
    containers ? 'contenedores (Dockerfile / compose)' : '',
    has(/(^|\/)\.env\.(example|sample|template)$/) ? 'variables de entorno de ejemplo (.env.example; los .env reales nunca se leen)' : '',
    has(/(^|\/)(prisma\/schema\.prisma|migrations\/)/) ? 'migraciones de base de datos' : '',
    has(/(^|\/)(playwright|cypress)\.config\.[a-z]+$/) ? 'pruebas de navegador' : '',
    has(/(^|\/)(eas|app)\.json$/) ? 'configuración de compilación móvil' : ''
  ].filter(Boolean);
  if (files.length >= MAX_LIST * 10) warnings.push('Repositorio muy grande: el descubrimiento se limitó a los primeros archivos.');
  return { status: 'proposed', root, git: { isGit, branch, remotes, branches }, stack: { languages, packageManager, frameworks, monorepo, containers }, scripts, proposedCommands, ci, docs, tooling, warnings };
}
