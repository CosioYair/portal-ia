import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Prueba de seguridad de las rutas protegidas (secretos SINTÉTICOS, repositorio temporal). Cada archivo protegido lleva un
 * marcador único que el detector de secretos NO reconoce: si se deniega, es por la ruta. Se intentan todas las formas
 * alternativas de nombrarlo (mayúsculas, nombres cortos 8.3 reales, flujos alternativos, punto o espacio final, «..»,
 * absolutas, \\?\, uniones que salen de la carpeta) por TODOS los caminos de lectura del Portal: portal_read_file,
 * portal_search, portal_diff, la lista de archivos, el contexto que el pipeline envía a los modelos, la validación de
 * escritura y la ruta HTTP del puente (con codificación de URL). Un archivo normal es el control positivo.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-sec-'));
process.env.LOG_LEVEL = 'warn';
const bridge = await import('../src/services/claudeCode/bridge.ts');
const { readRepoFile, safeRelPath, writablePath: wp } = await import('../src/services/repoWrite.ts');
const { buildApp } = await import('../src/app.ts');
const app = await buildApp();
after(async () => { await app.close(); });

const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-sec-repo-')));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-sec-fuera-'));
const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: repo, windowsHide: true }).toString();
const M = (k: string) => `MARCADOR-SINTETICO-${k}-9c1e`;
const put = (rel: string, content: string) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), content); };
git('init', '-q', '-b', 'main');
put('src/a.ts', 'export const a = 1; // CONTROL-POSITIVO\n');
put('.npmrc', `# ${M('NPMRC')}\n`); put('secrets/clave.txt', `${M('SECRETS')}\n`);
git('add', '-A'); git('add', '-f', '.npmrc', 'secrets/clave.txt'); git('commit', '-qm', 'base');
git('config', 'portal.marcador', M('GITCONFIG'));
put('.env', `CLAVE=${M('ENV')}\n`); put('.env.local', `CLAVE=${M('ENVLOCAL')}\n`);
put('.claude/settings.json', `{"m":"${M('CLAUDE')}"}\n`); put('.ssh/id_rsa', `${M('SSH')}\n`);
put('data/x.txt', `${M('DATA')}\n`); put('.netrc', `${M('NETRC')}\n`); put('.git-credentials', `${M('GITCRED')}\n`); put('src/.git/config', `${M('NESTEDGIT')}\n`); put('node_modules/x/index.js', `// ${M('NODEMODULES')}\n`);
put('.npmrc', `# ${M('NPMRC')}\n# ${M('NPMRC2')}\n`); put('secrets/clave.txt', `${M('SECRETS')}\n${M('SECRETS2')}\n`); // cambios sin confirmar
fs.writeFileSync(path.join(outside, 'fuera.txt'), `${M('FUERA')}\n`);
let junction = false; try { fs.symlinkSync(outside, path.join(repo, 'src', 'enlace'), 'junction'); junction = true; } catch (e: any) { if (e.code !== 'EPERM') throw e; }
let ads = false; if (process.platform === 'win32') { try { fs.writeFileSync(path.join(repo, 'src', 'a.ts:oculto'), `${M('ADS')}\n`); ads = true; } catch { /* sin NTFS */ } }

/** Nombres cortos 8.3 REALES del volumen (si el sistema los genera), leídos con `dir /x`. */
function shortNames(dir: string): Map<string, string> {
  const out = new Map<string, string>(); if (process.platform !== 'win32') return out;
  try { for (const l of execFileSync('cmd.exe', ['/d', '/c', 'dir', '/x', '/a'], { cwd: dir, encoding: 'latin1', windowsHide: true }).split(/\r?\n/)) { const m = l.match(/\s(\S+~\d\S*)\s+(\S.*)$/); if (m) out.set(m[2].trim(), m[1]); } } catch { /* sin cmd */ }
  return out;
}
const sn = shortNames(repo);
const s = (name: string) => sn.get(name);

const protectedFiles: { rel: string; marker: string; writeForbidden: boolean }[] = [
  { rel: '.env', marker: M('ENV'), writeForbidden: true }, { rel: '.env.local', marker: M('ENVLOCAL'), writeForbidden: true },
  { rel: '.git/config', marker: M('GITCONFIG'), writeForbidden: true }, { rel: 'data/x.txt', marker: M('DATA'), writeForbidden: true },
  { rel: 'node_modules/x/index.js', marker: M('NODEMODULES'), writeForbidden: true }, { rel: '.npmrc', marker: M('NPMRC'), writeForbidden: true },
  { rel: 'secrets/clave.txt', marker: M('SECRETS'), writeForbidden: true }, { rel: '.claude/settings.json', marker: M('CLAUDE'), writeForbidden: true },
  { rel: '.ssh/id_rsa', marker: M('SSH'), writeForbidden: true }, { rel: '.netrc', marker: M('NETRC'), writeForbidden: true },
  { rel: '.git-credentials', marker: M('GITCRED'), writeForbidden: true }, { rel: 'src/.git/config', marker: M('NESTEDGIT'), writeForbidden: true }
];
/** Todas las formas de nombrar un archivo protegido. */
function aliases(rel: string): string[] {
  const parts = rel.split('/'); const first = parts[0]; const rest = parts.slice(1).join('/');
  const join = (head: string) => rest ? `${head}/${rest}` : head;
  const out = new Set<string>([rel, rel.toUpperCase(), join(first.toUpperCase()), `./${rel}`, `.\\${rel.replace(/\//g, '\\')}`, `src/../${rel}`, `/${rel}`,
    path.join(repo, rel), `\\\\?\\${path.join(repo, rel)}`, `${rel}.`, `${rel} `, `${rel}::$DATA`, `${rel}:$DATA`, join(`${first}.`), join(`${first} `)]);
  if (s(first)) { out.add(join(s(first)!)); out.add(join(s(first)!.toLowerCase())); }
  if (junction) out.add(`src/enlace/../../${rel}`);
  return [...out];
}
const allMarkers = [...protectedFiles.map(f => f.marker), M('NPMRC2'), M('SECRETS2'), M('FUERA'), M('ADS')];
const leaks = (x: unknown) => { const t = typeof x === 'string' ? x : JSON.stringify(x); return allMarkers.filter(m => t.includes(m)); };
/** La búsqueda devuelve la consulta tal cual: lo que importa es todo lo DEMÁS (coincidencias y omitidos). */
const searchLeaks = (x: any) => { const o = typeof x === 'string' ? (() => { try { return JSON.parse(x); } catch { return x; } })() : x; if (o && typeof o === 'object') delete o.query; return leaks(o); };
const task = { id: 'sec', slug: 'portal-ia', projectId: 'p', readRoot: repo } as any;

test('control positivo: un archivo normal SÍ se lee por cada camino (la prueba ejercita las herramientas de verdad)', () => {
  const r = bridge.readTaskFile(task, 'src/a.ts') as any; assert.ok(!bridge.isDenied(r)); assert.match(r.content, /CONTROL-POSITIVO/);
  assert.match(readRepoFile(repo, 'src/a.ts') ?? '', /CONTROL-POSITIVO/);
  assert.equal((bridge.searchTaskFiles(task, 'CONTROL-POSITIVO') as any).matches[0].path, 'src/a.ts');
  assert.ok((bridge.listTaskFiles(task) as any).files.includes('src/a.ts'));
  assert.equal(safeRelPath('src/nuevo.ts'), 'src/nuevo.ts');
  // Las acciones del propietario (su corrección externa, resolver un conflicto) no quedan bloqueadas por la lista de credenciales.
  assert.equal(safeRelPath('.npmrc'), '.npmrc'); assert.ok(wp(repo, 'secrets/nuevo.txt', { agent: false }));
  assert.equal(safeRelPath('.env.dist'), '.env.dist'); assert.ok(wp(repo, '.env-dist'), 'una plantilla .env-dist tampoco es un secreto');
  console.log(`nombres cortos reales: ${[...sn.entries()].map(([l, x]) => `${l}→${x}`).join(', ') || 'ninguno (volumen sin 8.3)'} · unión: ${junction} · flujo alternativo: ${ads}`);
});

test('ningún archivo protegido se lee con NINGUNA forma de nombrarlo, por ningún camino de lectura', () => {
  let tried = 0;
  for (const f of protectedFiles) {
    for (const a of aliases(f.rel)) {
      tried++;
      const r = bridge.readTaskFile(task, a);
      assert.ok(bridge.isDenied(r), `portal_read_file «${a}» debía denegarse`); assert.deepEqual(leaks(r), [], `portal_read_file «${a}»`);
      assert.equal(readRepoFile(repo, a), null, `contexto del pipeline «${a}»`);
      if (f.writeForbidden) assert.throws(() => wp(repo, a), Error, `escritura de un agente «${a}»`);
    }
  }
  for (const a of ['src/enlace/fuera.txt', 'src/a.ts:oculto', 'src/a.ts::$DATA', '../fuera.txt', path.join(outside, 'fuera.txt')]) {
    assert.ok(bridge.isDenied(bridge.readTaskFile(task, a)), a); assert.equal(readRepoFile(repo, a), null, a);
  }
  assert.ok(tried >= protectedFiles.length * 12, `${tried} intentos`);
});

test('búsqueda, diferencias y lista: ningún marcador sale, aunque se busque literalmente', () => {
  for (const q of ['MARCADOR-SINTETICO', ...allMarkers, 'CLAVE=']) { const r = bridge.searchTaskFiles(task, q); assert.deepEqual(searchLeaks(r), [], q); assert.equal((r as any).matches?.length ?? 0, 0, q); }
  for (const dir of ['', '.git', 'DATA', 'SECRETS', '.claude', 'src/enlace']) { const r = bridge.searchTaskFiles(task, 'MARCADOR', { dir }); assert.deepEqual(searchLeaks(r), [], `dir ${dir}`); }
  const w = bridge.taskDiff(task, 'working'); assert.deepEqual(leaks(w), [], 'diff working');
  assert.ok((w as any).omitted.some((o: any) => o.path === '.npmrc') && (w as any).omitted.some((o: any) => o.path === 'secrets/clave.txt'), 'lo protegido modificado se omite y se dice');
  const list = bridge.listTaskFiles(task) as any;
  for (const f of protectedFiles) assert.ok(!list.files.some((x: string) => x.toLowerCase() === f.rel.toLowerCase()), `lista: ${f.rel}`);
  for (const d of ['.git', 'data', 'SECRETS', '.claude']) assert.ok(bridge.isDenied(bridge.listTaskFiles(task, d)), `lista de ${d}`);
});

test('por HTTP (como lo usa la CLI por MCP): rutas codificadas y alias tampoco devuelven nada protegido', async () => {
  const job = bridge.registerJobTask({ slug: 'portal-ia', projectId: 'p', processId: null, stepId: null, agentId: 'a', agentName: 'A', role: 'reviewer', title: 'sec', mode: 'cli', system: '', prompt: '', schema: null, readRoot: repo, runId: 'r-sec' });
  const h = { authorization: `Bearer ${job.token}` };
  try {
    const vectors = [...new Set(protectedFiles.flatMap(f => aliases(f.rel)))];
    for (const v of vectors) {
      for (const enc of [encodeURIComponent(v), encodeURIComponent(v).replace(/\./g, '%2e'), encodeURIComponent(encodeURIComponent(v))]) {
        const r = await app.inject({ method: 'GET', url: `/api/bridge/v1/tasks/current/file?path=${enc}`, headers: h });
        assert.ok(r.statusCode >= 400 && r.statusCode < 500, `${v} → ${r.statusCode}`); assert.deepEqual(leaks(r.body), [], v);
      }
    }
    const ok = await app.inject({ method: 'GET', url: '/api/bridge/v1/tasks/current/file?path=src%2Fa.ts', headers: h });
    assert.equal(ok.statusCode, 200); assert.match(ok.body, /CONTROL-POSITIVO/);
    for (const q of ['MARCADOR-SINTETICO', M('ENV')]) { const r = await app.inject({ method: 'GET', url: `/api/bridge/v1/tasks/current/search?q=${encodeURIComponent(q)}`, headers: h }); assert.deepEqual(searchLeaks(r.body), [], q); }
    for (const range of ['working', 'branch']) { const r = await app.inject({ method: 'GET', url: `/api/bridge/v1/tasks/current/diff?range=${range}`, headers: h }); assert.deepEqual(leaks(r.body), [], range); }
  } finally { job.done(); }
});

test('escrituras: ningún enlace o unión saca una escritura o un borrado de la carpeta', async () => {
  const { writablePath } = await import('../src/services/repoWrite.ts');
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-sec-wt-')); const fuera = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-sec-victima-'));
  fs.writeFileSync(path.join(fuera, 'victima.txt'), 'ORIGINAL');
  let linked = false; try { fs.symlinkSync(fuera, path.join(wt, 'enlace'), 'junction'); linked = true; } catch (e: any) { if (e.code !== 'EPERM') throw e; }
  if (linked) {
    assert.throws(() => writablePath(wt, 'enlace/victima.txt'), /enlace/); assert.throws(() => writablePath(wt, 'enlace/nuevo.txt'), /enlace/);
    assert.equal(fs.readFileSync(path.join(fuera, 'victima.txt'), 'utf8'), 'ORIGINAL');
  }
  assert.ok(writablePath(wt, 'src/nuevo.ts').endsWith(path.join('src', 'nuevo.ts')), 'lo normal sí');
});

test('commits: lo que deja lo ejecutado en el sandbox en rutas protegidas no entra en el commit del Portal', async () => {
  const { commitInWorktree, annotateChanges } = await import('../src/services/repoWrite.ts');
  const r3 = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-sec-commit-'));
  const g3 = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: r3, windowsHide: true }).toString();
  g3('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(r3, 'README.md'), 'x\n'); g3('add', '-A'); g3('commit', '-qm', 'base');
  // Como si los hubiera escrito una prueba ejecutada en el sandbox (el worktree se monta con escritura):
  fs.writeFileSync(path.join(r3, '.npmrc'), '//registro/:_authToken=SINTETICO\n'); fs.mkdirSync(path.join(r3, '.claude')); fs.writeFileSync(path.join(r3, '.claude', 'settings.json'), '{}');
  fs.writeFileSync(path.join(r3, '.env.local'), 'CLAVE=sintetica\n');
  await commitInWorktree(r3, annotateChanges(r3, [{ path: 'src/a.ts', action: 'create', content: 'export const a = 1;\n' }]), 'corrección');
  assert.deepEqual(g3('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean), ['src/a.ts'], 'solo lo validado');
  assert.ok(fs.existsSync(path.join(r3, '.npmrc')) && g3('status', '--porcelain').includes('.npmrc'), 'lo protegido queda sin confirmar en el worktree');
});

// Dentro del sandbox del Portal /tmp es un tmpfs «noexec»: git ignora todo hook y el control positivo no puede pasar. Ahí se
// omite y lo dice; los commits del Portal se hacen en el equipo, donde esta prueba sí se ejecuta.
const tmpExec = process.platform === 'win32' || (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-sec-exec-')); const f = path.join(d, 'x.sh'); fs.writeFileSync(f, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  try { execFileSync(f); return true; } catch { return false; } finally { fs.rmSync(d, { recursive: true, force: true }); }
})();
test('escrituras: los hooks del repositorio no se ejecutan en los commits del Portal', { skip: tmpExec ? false : 'el directorio temporal no permite ejecutar scripts (noexec): git ignoraría el hook también en el control' }, async () => {
  const { applyChanges, annotateChanges } = await import('../src/services/repoWrite.ts');
  // Un hook versionado (como los de husky) que un agente hubiera editado NO se ejecuta en los commits del Portal.
  const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-sec-hooks-')); const marca = path.join(os.tmpdir(), `portal-ia-hook-${Date.now()}.txt`);
  const g2 = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: r2, windowsHide: true }).toString();
  g2('init', '-q', '-b', 'main'); fs.mkdirSync(path.join(r2, '.githooks'));
  fs.writeFileSync(path.join(r2, '.githooks', 'pre-commit'), `#!/bin/sh\necho ejecutado > "${marca.replace(/\\/g, '/')}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(r2, 'README.md'), 'x\n'); g2('add', '-A'); g2('commit', '-qm', 'base'); g2('config', 'core.hooksPath', '.githooks');
  const changes = annotateChanges(r2, [{ path: 'src/b.ts', action: 'create', content: 'export const b = 1;\n' }]);
  await applyChanges(r2, 'portal-ia/hu-998', changes, 'HU-998', { processId: 'p-hooks' });
  assert.ok(!fs.existsSync(marca), 'el hook no se ejecutó');
  // Control: el mismo hook SÍ se ejecuta con un git normal (la prueba es real).
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_CONFIG_')));
  fs.writeFileSync(path.join(r2, 'c.txt'), 'c'); execFileSync('git', ['add', '-A'], { cwd: r2, env }); execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'control'], { cwd: r2, env, windowsHide: true });
  assert.ok(fs.existsSync(marca), 'control: con hooks activos, el hook se ejecuta'); fs.rmSync(marca, { force: true });
});
