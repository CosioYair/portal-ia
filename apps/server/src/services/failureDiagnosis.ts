import { execFileSync } from 'node:child_process';
import type { ExecutionResult, VerificationRun } from '@portal-ia/domain';
import { clip } from './devOutput.ts';
import { diagnosticsFor, filesIn } from './diagnostics.ts';
import { readRepoFile } from './repoWrite.ts';

/**
 * Diagnóstico enfocado de un fallo del sandbox para la corrección dirigida (sin IA). HU-155: el Desarrollador corrigió
 * nueve veces una prueba que comparaba el catálogo con las rutas reales del servidor sin ver nunca esas rutas, y la prueba
 * solo enseñaba el primer elemento que fallaba. Aquí se le da lo que necesita para corregir la causa: prueba y mensaje
 * exactos, el código de la aserción, los archivos que cita el fallo, el índice real de rutas cuando el fallo habla de
 * rutas (con prefijos de registro), los fallos anteriores del mismo caso y qué tipo de fallo parece.
 */

const ANSI = /\u001b\[[0-9;]*m/g;
const plain = (s: string) => s.replace(ANSI, '').replace(/\r/g, '');
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Clase del resultado de node --test: `hook` = falla la preparación de una suite (before/after) y sus pruebas quedan
 * canceladas sin ejecutarse; `cancelled` = cancelada por su suite padre (NO es un fallo propio: la causa está en el padre
 * o en el fin del proceso de pruebas); `timeout` = plazo de la prueba agotado; `assertion` = fallo propio de la prueba.
 */
export type FailingKind = 'assertion' | 'hook' | 'cancelled' | 'timeout';
export interface FailingTest { name: string; message: string; file: string | null; line: number | null; kind?: FailingKind }

/**
 * Pruebas que fallan, con el mensaje completo, el archivo y la línea de la aserción (TAP de node --test). Primero las
 * causas (aserciones, preparación de suites, plazos) y, solo si no hay ninguna a la vista, las canceladas por su padre.
 * HU-159: las 8 pruebas canceladas por un `before` que fallaba llenaban la lista y la causa (la suite) quedaba fuera.
 */
export function failingTests(run: Pick<VerificationRun, 'command' | 'output'>, max = 8): FailingTest[] {
  if (run.command !== 'test') return diagnosticsFor(run).slice(0, max).map(d => ({ name: `${d.file ?? run.command}${d.line ? `:${d.line}` : ''}${d.code ? ` ${d.code}` : ''}`, message: d.text, file: d.file ?? null, line: d.line ?? null, kind: 'assertion' as const }));
  const lines = plain(run.output).split('\n'); const all: FailingTest[] = [];
  // TAP de node --test: todo fallo propio trae `failureType` y su error. Un bloque sin ninguno de los dos es un bloque
  // RECORTADO (HU-159: el recorte antiguo cortaba bloques de canceladas tras `location:`), no la prueba de un fallo.
  const nodeTap = /^\s*failureType: '/m.test(run.output);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)not ok \d+ - (.+?)\s*(#.*)?$/); if (!m || TEST_FILE.test(m[2])) continue;
    const indent = m[1].length; let message = ''; let file: string | null = null; const frames: { file: string; line: number }[] = [];
    let failureType: string | null = null; let isSuite = false; const stack: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (/^\s*(not )?ok \d+ /.test(l) && (l.match(/^\s*/)?.[0].length ?? 0) <= indent) break;
      const ft = l.match(/^\s*failureType: '(\w+)'/); if (ft && !failureType) failureType = ft[1];
      if (/^\s*type: 'suite'/.test(l)) isSuite = true;
      // Pila: marcos del repositorio (no de node:internal) para decir DÓNDE falla, también fuera del archivo de prueba.
      const fr = l.match(/^\s+(?:async )?([^\s(][^()]*?)?\s*\(?(?:\/work\/)?((?:[\w@.-]+\/)+[\w@.-]+\.[cm]?[jt]sx?):(\d+):\d+\)?\s*$/);
      if (fr && !/node:internal|node_modules\//.test(l) && stack.length < 5) stack.push(`${fr[1] ? `${fr[1].trim()} ` : ''}(${fr[2]}:${fr[3]})`);
      const e = l.match(/^(\s*)error: (?:(\|-|>-|\||>)|'(.*)'|"(.*)"|(.*))\s*$/);
      if (e && !message) {
        if (e[2]) { const pad = e[1].length; const buf: string[] = []; for (let k = j + 1; k < lines.length; k++) { const x = lines[k]; if (x.trim() && (x.match(/^\s*/)?.[0].length ?? 0) <= pad) break; if (/^\s*\+ actual - expected/.test(x)) break; if (x.trim()) buf.push(x.trim()); } message = buf.join(' '); }
        else message = (e[3] ?? e[4] ?? e[5] ?? '').replace(/''/g, "'").trim();
      }
      const loc = l.match(/location: '(.+?):\d+:\d+'/); if (loc) { if (!file) file = loc[1].replace(/^\/work\//, ''); continue; }
      // La línea de la aserción sale de la pila (location es dónde se declara la prueba, no dónde falla).
      for (const f of l.matchAll(/(?:\/work\/)?((?:[\w@.-]+\/)*[\w@.-]+\.(?:test|spec)\.[cm]?[jt]sx?):(\d+):\d+/g)) frames.push({ file: f[1], line: Number(f[2]) });
    }
    // Un contenedor (suite sin error propio, o prueba que falla solo porque fallan sus hijas) no es una causa: lo son sus hijas.
    if (failureType === 'subtestsFailed' || (isSuite && !failureType && !message)) continue;
    if (nodeTap && !failureType && !message) continue;
    const kind: FailingKind = failureType === 'cancelledByParent' ? 'cancelled' : failureType === 'hookFailed' ? 'hook' : failureType === 'testTimeoutFailure' ? 'timeout' : 'assertion';
    const frame = frames.find(f => f.file === file) ?? frames[0];
    const name = kind === 'hook' ? `${m[2]} (preparación de la ${isSuite ? 'suite' : 'prueba'}: before/after)` : m[2];
    const where = kind === 'hook' && stack.length ? ` · pila: ${stack.join(' ← ')}` : '';
    all.push({ name, message: `${message}${where}`.slice(0, 900), file: file ?? frame?.file ?? null, line: frame?.line ?? null, kind });
  }
  // Primero las causas; las canceladas solo si no hay ninguna causa a la vista (y entonces se dicen canceladas, no fallidas).
  const causes = all.filter(f => f.kind !== 'cancelled');
  const out = (causes.length ? causes : all).slice(0, max);
  if (!out.length) for (const d of diagnosticsFor(run).slice(0, max)) out.push({ name: d.text.split(' — ')[0], message: d.text.split(' — ').slice(1).join(' — '), file: d.file ?? null, line: null, kind: 'assertion' });
  return out;
}

/**
 * Unidades de corrección PENDIENTES (sin ningún intento) planificadas a partir de un «test» que solo tenía pruebas
 * canceladas: no corrigen nada real (HU-159: «Corrección 5» apuntaba a una prueba cancelada por el `before` de su suite).
 * Al continuar se sustituyen, sin IA, por una nueva verificación que muestre la causa.
 */
export function staleCorrectionUnits(r: ExecutionResult | null | undefined): string[] {
  const man = r?.manifest; if (!man || !r?.applied) return [];
  const lastTest = r.verifications.filter(v => v.command === 'test').at(-1);
  if (!lastTest || !testRunSummary(lastTest).onlyCancellations) return [];
  return man.units.filter(u => u.kind === 'correction' && u.source === 'verification' && u.status === 'pending' && !u.attempts && (u.findings ?? []).every(f => /^test falla/.test(f.text))).map(u => u.id);
}

/** Resumen de una ejecución de «test»: cuántas pruebas fallan de verdad y cuántas solo se cancelaron. */
export function testRunSummary(run: Pick<VerificationRun, 'command' | 'output'>): { failed: number; cancelled: number; causes: FailingTest[]; onlyCancellations: boolean } {
  const out = plain(run.output);
  const num = (k: string) => Number(out.match(new RegExp(`^(?:#|ℹ) ${k} (\\d+)`, 'm'))?.[1] ?? 0);
  const failing = run.command === 'test' ? failingTests(run, 50) : [];
  const causes = failing.filter(f => f.kind !== 'cancelled');
  const cancelled = num('cancelled') || failing.filter(f => f.kind === 'cancelled').length;
  return { failed: num('fail'), cancelled, causes, onlyCancellations: run.command === 'test' && !causes.length && cancelled > 0 };
}

// ---------------------------------------------------------------- Índice real de rutas HTTP

export interface RouteDecl { method: string; path: string; declared: string; file: string; line: number; prefix: { value: string; file: string; line: number } | null }

const DECL = /\.(get|post|put|patch|delete|head|options|all)\s*(?:<[^()]*?>)?\s*\(\s*(['"`])(\/[^'"`\s]*)\2/g;
const ROUTE_OBJ = /\.route\s*\(\s*\{([\s\S]{0,600}?)\}\s*\)/g;
const PREFIX = /\.register\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*\{[^}]*?\bprefix\s*:\s*(['"`])([^'"`]+)\2/g;
const FN = /(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/g;
const lineAt = (src: string, i: number) => src.slice(0, i).split('\n').length;
const joinPath = (prefix: string, p: string) => (`/${prefix}/${p}`).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
const segs = (p: string) => p.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').map(s => /^[:{*]|^\$\{/.test(s) ? ':' : s);

/** ¿Una ruta declarada (`:param`) sirve la ruta citada (`:x`, `{x}` o un valor concreto)? */
export function routeMatches(declared: string, route: string): boolean {
  const a = segs(declared), b = segs(route);
  return a.length === b.length && a.every((s, i) => s === ':' || b[i] === ':' || s === b[i]);
}

/** Archivos del repositorio que pueden declarar rutas (git ls-files; sin pruebas ni dependencias). */
function routeFiles(root: string): string[] {
  let all: string[] = [];
  try { all = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, windowsHide: true }).split('\n').filter(Boolean); } catch { return []; }
  return all.filter(f => /\.[cm]?[jt]sx?$/.test(f) && !TEST_FILE.test(f) && !/(^|\/)(node_modules|dist|build|coverage)\//.test(f) && /(^|\/)(routes?|api|server|app|plugins?|index|main)(\/|\.|$)/i.test(f)).slice(0, 400);
}

/**
 * Rutas declaradas en el código (Fastify/Express: `.get('/x'`, `.route({ method, url })`), con el prefijo con que se
 * registra el plugin que las declara (`register(plugin, { prefix })`). Estático y aproximado, pero de solo lectura y sin IA.
 */
export function routeIndex(root: string, files: string[] = routeFiles(root)): RouteDecl[] {
  const sources = files.map(f => ({ file: f, src: readRepoFile(root, f, 300_000) ?? '' })).filter(x => x.src);
  const prefixes = new Map<string, { value: string; file: string; line: number }>();
  for (const { file, src } of sources) for (const m of src.matchAll(PREFIX)) prefixes.set(m[1], { value: m[3], file, line: lineAt(src, m.index!) });
  const out: RouteDecl[] = [];
  for (const { file, src } of sources) {
    const fns = Array.from(src.matchAll(FN)).map(m => ({ name: m[1] ?? m[2], at: m.index! }));
    const owner = (i: number) => fns.filter(f => f.at < i).at(-1)?.name ?? null;
    const add = (method: string, p: string, i: number) => {
      const name = owner(i); const pre = name ? prefixes.get(name) ?? null : null;
      out.push({ method: method.toUpperCase(), path: pre ? joinPath(pre.value, p) : p, declared: p, file, line: lineAt(src, i), prefix: pre });
    };
    for (const m of src.matchAll(DECL)) add(m[1], m[3], m.index!);
    for (const m of src.matchAll(ROUTE_OBJ)) {
      const method = m[1].match(/method\s*:\s*(['"`])(\w+)\1/)?.[2]; const url = m[1].match(/(?:url|path)\s*:\s*(['"`])(\/[^'"`]*)\1/)?.[2];
      if (method && url) add(method, url, m.index!);
    }
  }
  return out;
}

/** Rutas HTTP citadas en un texto (no rutas de archivo): `/api/…` o con parámetros (`:id`, `{id}`). */
export function routesIn(text: string): string[] {
  const found = Array.from(plain(text).matchAll(/(?<![\w.:/-])\/[\w-]+(?:\/[\w\-.:{}]+)+/g)).map(m => m[0].replace(/[.,;:)]+$/, ''));
  return Array.from(new Set(found.filter(r => !/\.[a-z]{1,5}$/i.test(r) && !r.startsWith('/work/') && (r.startsWith('/api/') || /\/[:{]/.test(r))))).slice(0, 8);
}

function similar(index: RouteDecl[], route: string, n = 4): RouteDecl[] {
  const want = segs(route).filter(s => s && s !== ':');
  return index.map(r => ({ r, score: segs(r.path).filter(s => s && s !== ':' && want.includes(s)).length }))
    .filter(x => x.score > 1 || (x.score === 1 && want.length <= 2)).sort((a, b) => b.score - a.score).slice(0, n).map(x => x.r);
}

// ---------------------------------------------------------------- Diagnóstico

export type FailureKind = 'environment' | 'existing_test' | 'integration' | 'missing_route' | 'brittle_assertion' | 'repository_contract' | 'partial_progress' | 'no_progress' | 'implementation'
  /** La preparación de una suite (before/after) falla: sus pruebas no llegaron a ejecutarse. */
  | 'test_setup'
  /** Solo hay pruebas canceladas, sin un fallo propio a la vista: posible fin del proceso de pruebas o plazo (no es código). */
  | 'test_runner';
export interface FailureDiagnosis {
  command: string; exitCode: number | null; isolation: string;
  failing: FailingTest[];
  kinds: { kind: FailureKind; why: string }[];
  previous: { at: string; name: string; message: string }[];
  routes: { mentioned: string[]; found: RouteDecl[]; missing: { route: string; similar: RouteDecl[] }[]; related: RouteDecl[] } | null;
  files: string[];
  testCode: { file: string; from: number; code: string } | null;
}
export interface DiagnosisInput {
  root: string | null; run: VerificationRun;
  /** Ejecuciones fallidas anteriores del mismo comando (más antigua primero). */
  previous: VerificationRun[];
  /** Archivos que la historia creó (no existían en la base) y entregables del plan. */
  storyCreated: string[]; planned: string[];
  /** Archivos de la unidad (ya van completos en el encargo). */
  unitFiles: string[];
  index?: RouteDecl[];
}

const ENV = /ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ENOSPC|ENOMEM|out of memory|Cannot find package '(?![.\/])|spawn \S+ ENOENT|Faltan las dependencias/i;
const INTEGRATION = /does not provide an export named|is not a function|is not a constructor|Cannot find module '\.{1,2}\/|ERR_MODULE_NOT_FOUND|is not defined\b/;

export function diagnoseFailure(input: DiagnosisInput): FailureDiagnosis {
  const { root, run } = input;
  const failing = failingTests(run);
  const kinds: FailureDiagnosis['kinds'] = [];
  const text = failing.map(f => `${f.name} ${f.message}`).join('\n');
  if (run.exitCode === null || run.exitCode === 86 || run.isolation === 'unavailable' || ENV.test(run.output.slice(-20_000))) kinds.push({ kind: 'environment', why: 'parece un fallo del entorno (red, dependencias, memoria o sandbox), no del código: no cambies el código por esto' });
  const existing = Array.from(new Set(failing.map(f => f.file).filter((f): f is string => !!f && TEST_FILE.test(f) && !input.storyCreated.includes(f) && !input.planned.includes(f))));
  if (existing.length) kinds.push({ kind: 'existing_test', why: `${existing.join(', ')} ya existía y no es un entregable de esta historia: NO la modifiques para que pase (eso debilitaría la verificación); corrige el código que la rompe` });
  const hooks = failing.filter(f => f.kind === 'hook');
  if (hooks.length) kinds.push({ kind: 'test_setup', why: `la PREPARACIÓN de la prueba falla (${hooks.map(h => `«${clip(h.name, 90)}»`).join(', ')}): sus pruebas quedaron canceladas sin ejecutarse, así que no hay aserciones de la implementación que corregir. Corrige la preparación (por ejemplo, usar las funciones reales del Portal para crear datos de prueba en vez de suponer nombres o campos), según la pila del error` });
  if (failing.length && failing.every(f => f.kind === 'cancelled')) kinds.push({ kind: 'test_runner', why: 'solo hay pruebas CANCELADAS y la causa no está en la salida (posible fin del proceso de pruebas, plazo o salida recortada): no es un fallo de la implementación; hay que repetir la verificación sin IA para ver la causa antes de corregir nada' });
  if (INTEGRATION.test(text)) kinds.push({ kind: 'integration', why: 'lo que la prueba importa o llama no existe o no coincide (nombre exportado, ruta del módulo o firma): alinea el módulo con lo que se usa' });
  let routes: FailureDiagnosis['routes'] = null;
  const mentioned = routesIn(text);
  if (mentioned.length && root) {
    const index = input.index ?? routeIndex(root);
    const found: RouteDecl[] = []; const missing: { route: string; similar: RouteDecl[] }[] = [];
    for (const r of mentioned) { const hit = index.filter(x => routeMatches(x.path, r)); if (hit.length) found.push(...hit); else missing.push({ route: r, similar: similar(index, r) }); }
    const prefixed = found.filter(x => x.prefix);
    if (prefixed.length) kinds.push({ kind: 'brittle_assertion', why: `${prefixed.map(x => `${x.method} ${x.path}`).join(', ')} SÍ existe: se registra con prefijo (${prefixed.map(x => `${x.prefix!.file}:${x.prefix!.line}`).join(', ')}) y el texto literal no aparece en el archivo de rutas. Comprobar el literal es frágil: valida la ruta efectiva (registro de Fastify con hasRoute o una petición inject). No añadas una ruta duplicada ni quites la comprobación` });
    if (missing.length) kinds.push({ kind: 'missing_route', why: `${missing.map(m => m.route).join(', ')} no está declarada en el código (índice real abajo). Si el código o la prueba suponen esa ruta, usa la real; créala solo si el plan lo pide` });
    const related = Array.from(new Set([...found, ...missing.flatMap(m => m.similar)])).slice(0, 20);
    // Contexto de las rutas del mismo ámbito: el primer segmento tras /api (p. ej. todas las de /api/workspaces/:slug/…).
    const scopes = new Set(mentioned.map(r => segs(r).slice(0, 3).join('/')));
    const sameScope = index.filter(x => x.method === 'GET' && scopes.has(segs(x.path).slice(0, 3).join('/')) && !related.includes(x)).slice(0, 40);
    routes = { mentioned, found, missing, related: [...related, ...sameScope].slice(0, 60) };
  }
  const testFile = failing.find(f => f.file && TEST_FILE.test(f.file))?.file ?? null;
  const testSrc = root && testFile ? readRepoFile(root, testFile, 300_000) : null;
  if (testSrc && /\b(readFileSync|readdirSync|readFile)\s*\(/.test(testSrc) && (filesIn(text).length || mentioned.length)) kinds.push({ kind: 'repository_contract', why: 'la prueba compara con archivos reales del repositorio: usa los archivos y el índice incluidos abajo; no supongas rutas, campos ni números de línea' });
  // Historial del mismo caso: ¿mismo mensaje (sin progreso) o el mismo caso con otro elemento (un elemento cada vez)?
  const previous: FailureDiagnosis['previous'] = [];
  for (const v of input.previous) for (const f of failingTests(v)) if (failing.some(x => x.name === f.name)) previous.push({ at: v.startedAt, name: f.name, message: f.message });
  const last = new Map<string, string>(); for (const p of previous) last.set(p.name, p.message);
  const same = failing.filter(f => last.has(f.name) && last.get(f.name) === f.message);
  const moved = failing.filter(f => last.has(f.name) && last.get(f.name) !== f.message);
  if (same.length) kinds.push({ kind: 'no_progress', why: `la corrección anterior no cambió este fallo (${same.map(f => `«${clip(f.name, 80)}»`).join(', ')}): cambia de enfoque y busca la causa en el código real; si la prueba exige algo que contradice el criterio de aceptación o el código real, no la debilites: responde SIN CAMBIOS con la evidencia y decide el propietario` });
  if (moved.length) kinds.push({ kind: 'partial_progress', why: `el mismo caso falla ahora con otro elemento (${moved.map(f => `antes: «${clip(last.get(f.name)!, 140)}»`).join('; ')}): la prueba se detiene en el primer elemento que falla. Corrige TODOS los elementos del mismo tipo contra el código real, no solo el citado` });
  if (!kinds.some(k => ['environment', 'existing_test', 'integration', 'missing_route', 'brittle_assertion', 'test_setup', 'test_runner'].includes(k.kind))) kinds.push({ kind: 'implementation', why: 'defecto de implementación: corrige el código (o la prueba nueva de esta historia, si es ella la que está mal) para que la comprobación pase sin debilitarla' });
  const files = Array.from(new Set([...filesIn(`${text}\n${run.output.slice(-4_000)}`), ...(testFile ? [testFile] : [])]))
    .filter(f => !input.unitFiles.includes(f) && !/node_modules\//.test(f) && root && readRepoFile(root, f, 1) !== null).slice(0, 4);
  const at = failing.find(f => f.file === testFile)?.line ?? null;
  const testCode = testSrc && testFile && at ? (() => { const all = testSrc.replace(/\r\n/g, '\n').split('\n'); const from = Math.max(1, at - 20); return { file: testFile, from, code: all.slice(from - 1, at + 8).map((l, i) => `${String(from + i).padStart(4)}| ${l}`).join('\n') }; })() : null;
  return { command: run.command, exitCode: run.exitCode, isolation: run.isolation ?? 'sandbox', failing, kinds, previous: previous.slice(-6), routes, files, testCode };
}

const fmt = (r: RouteDecl) => `- ${r.method} ${r.path} — ${r.file}:${r.line}${r.prefix ? ` (declarada «${r.declared}» con prefijo «${r.prefix.value}» de ${r.prefix.file}:${r.prefix.line})` : ''}`;

/** Sección del encargo de corrección: compacta y con presupuesto propio (no repite los archivos de la unidad). */
export function diagnosisPrompt(d: FailureDiagnosis, root: string | null, budget = 16_000): string {
  const parts: string[] = [`# Diagnóstico enfocado (automático, sin IA)
Comando: npm run ${d.command} en el sandbox (${d.isolation}) → ${d.exitCode === null ? 'no terminó' : `código ${d.exitCode}`}
Lo que falla:
${d.failing.map(f => `- «${f.name}»${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}${f.message ? `\n  ${f.message}` : ''}`).join('\n') || '- (sin detalle: ver la evidencia)'}
Tipo de fallo:
${d.kinds.map(k => `- [${k.kind}] ${k.why}`).join('\n')}`];
  if (d.previous.length) parts.push(`Fallos anteriores de este mismo caso (no repitas lo que ya no funcionó):\n${d.previous.map(p => `- ${p.at.slice(11, 19)} «${clip(p.name, 80)}»: ${clip(p.message, 220)}`).join('\n')}`);
  if (d.routes) {
    if (d.routes.missing.length) parts.push(`Rutas citadas que NO existen en el código:\n${d.routes.missing.map(m => `- ${m.route}${m.similar.length ? ` · parecidas reales: ${m.similar.map(s => `${s.method} ${s.path} (${s.file}:${s.line})`).join('; ')}` : ''}`).join('\n')}`);
    parts.push(`Rutas reales relacionadas (índice del código; método, ruta efectiva y declaración):\n${d.routes.related.map(fmt).join('\n') || '- (ninguna)'}`);
  }
  if (d.testCode) parts.push(`## Código de la prueba que falla (${d.testCode.file}, desde la línea ${d.testCode.from})\n\`\`\`\n${d.testCode.code}\n\`\`\``);
  let left = budget - parts.join('\n\n').length;
  for (const f of d.files) {
    if (left < 800 || !root) break;
    const c = readRepoFile(root, f, 200_000); if (c === null) continue;
    const t = clip(c, Math.min(5_000, left - 200)); left -= t.length + 80;
    parts.push(`## ${f} (citado por el fallo; contenido actual, solo lectura)\n\`\`\`\n${t}\n\`\`\``);
  }
  return parts.join('\n\n');
}
