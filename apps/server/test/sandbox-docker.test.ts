import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';

/**
 * M1 · Sandbox `docker`. Las pruebas de construcción de la orden no necesitan Docker; la de aislamiento real se
 * ejecuta solo si el Portal detecta el sandbox `docker` (motor Linux + imagen portal-ia-sandbox:1).
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-docker-'));
delete process.env.PORTAL_SANDBOX;
const { buildDockerRunArgs, dockerCliEnv, dockerMountArg, depsVolumeName, detectSandbox, runInSandbox, DEFAULT_SANDBOX_IMAGE, SANDBOX_IMAGE, DEPS_MISSING_EXIT } = await import('../src/services/sandbox.ts');

const spec = (over: Partial<Parameters<typeof buildDockerRunArgs>[0]> = {}) => ({ worktree: 'C:\\Mis Proyectos\\Portal IA-worktrees\\p1', command: 'test', script: 'npm test', image: 'portal-ia-sandbox:1', volume: 'portal-ia-nm-abc', allowNetwork: false, name: 'portal-ia-sbx-x', ...over });
/** Valores que siguen a cada aparición de una opción. */
const values = (args: string[], flag: string) => args.flatMap((a, i) => a === flag ? [args[i + 1]] : []);

test('docker: imagen por defecto portal-ia-sandbox:1, sustituible con PORTAL_SANDBOX_IMAGE', () => {
  assert.equal(DEFAULT_SANDBOX_IMAGE, 'portal-ia-sandbox:1');
  assert.equal(SANDBOX_IMAGE, process.env.PORTAL_SANDBOX_IMAGE || 'portal-ia-sandbox:1');
  const args = buildDockerRunArgs(spec({ image: 'mi/imagen:2' }));
  assert.equal(args[args.indexOf('-w') + 2], 'mi/imagen:2');
  assert.deepEqual(values(args, '--pull'), ['never'], 'nunca descarga una imagen en silencio');
});

test('docker: sin red salvo install con red confirmada', () => {
  assert.deepEqual(values(buildDockerRunArgs(spec()), '--network'), ['none']);
  assert.deepEqual(values(buildDockerRunArgs(spec({ allowNetwork: true })), '--network'), ['none'], 'test no obtiene red aunque se pida');
  assert.deepEqual(values(buildDockerRunArgs(spec({ command: 'install', script: 'npm ci' })), '--network'), ['none']);
  assert.deepEqual(values(buildDockerRunArgs(spec({ command: 'install', script: 'npm ci', allowNetwork: true })), '--network'), ['bridge']);
});

test('docker: endurecimiento (usuario sin privilegios, sin capacidades, raíz de solo lectura, límites, init)', () => {
  const args = buildDockerRunArgs(spec());
  for (const f of ['--rm', '--init', '--read-only']) assert.ok(args.includes(f), f);
  assert.deepEqual(values(args, '--user'), ['1000:1000']);
  assert.deepEqual(values(args, '--cap-drop'), ['ALL']);
  assert.deepEqual(values(args, '--security-opt'), ['no-new-privileges']);
  assert.deepEqual(values(args, '--memory'), ['2g']); assert.deepEqual(values(args, '--pids-limit'), ['512']);
  assert.deepEqual(values(args, '--name'), ['portal-ia-sbx-x']);
  assert.ok(!args.includes('-v') && !args.includes('--volume'), 'solo --mount, nunca -v con rutas de Windows');
  assert.ok(!args.some(a => a === '--privileged' || a.startsWith('--network=host')));
});

test('docker: el contenedor solo recibe variables explícitas CLAVE=valor (ninguna del Portal)', () => {
  const envArgs = values(buildDockerRunArgs(spec()), '-e');
  assert.ok(envArgs.every(e => /^[A-Za-z_][A-Za-z0-9_]*=/.test(e)), '«-e CLAVE» sin valor copiaría la variable del equipo');
  assert.deepEqual(envArgs.map(e => e.split('=')[0]).sort(), ['CI', 'FORCE_COLOR', 'HOME', 'PORTAL_INSIDE_SANDBOX', 'TMPDIR', 'npm_config_cache', 'npm_config_update_notifier']);
  assert.ok(!values(buildDockerRunArgs(spec()), '--env-file').length);
});

test('docker: worktree con --mount bind (ruta con unidad y espacios); dependencias en volumen de solo lectura salvo install', () => {
  const args = buildDockerRunArgs(spec());
  const mounts = values(args, '--mount');
  assert.ok(mounts.includes(`type=bind,source=${path.resolve('C:\\Mis Proyectos\\Portal IA-worktrees\\p1')},target=/work`), mounts.join('\n'));
  assert.ok(mounts.includes('type=volume,source=portal-ia-nm-abc,target=/work/node_modules,readonly'));
  for (const c of ['.vite-temp', '.vite', '.cache']) assert.ok(mounts.includes(`type=tmpfs,target=/work/node_modules/${c},tmpfs-mode=1777`), c);
  assert.ok(mounts.includes('type=tmpfs,target=/tmp,tmpfs-mode=1777'));
  const script = args.at(-1)!;
  assert.match(script, /^if \[ ! -f node_modules\/\.portal-ia-ready \]/); assert.match(script, new RegExp(`exit ${DEPS_MISSING_EXIT}; fi; npm test$`));

  const inst = buildDockerRunArgs(spec({ command: 'install', script: 'npm ci --ignore-scripts', allowNetwork: true }));
  const im = values(inst, '--mount');
  assert.ok(im.includes('type=volume,source=portal-ia-nm-abc,target=/work/node_modules'), 'install escribe en el volumen');
  assert.ok(!im.some(m => m.includes('node_modules/.vite')), 'sin tmpfs de cachés al instalar');
  assert.match(inst.at(-1)!, /^npm ci --ignore-scripts && mkdir -p node_modules\/\.vite-temp node_modules\/\.vite node_modules\/\.cache && touch node_modules\/\.portal-ia-ready$/);
});

test('docker: --mount escapa en CSV las rutas con comas o comillas', () => {
  assert.equal(dockerMountArg({ type: 'bind', source: 'C:\\a,b\\c', target: '/work' }), 'type=bind,"source=C:\\a,b\\c",target=/work');
  assert.equal(dockerMountArg({ type: 'bind', source: 'C:\\x "y"', target: '/work', readonly: true }), 'type=bind,"source=C:\\x ""y""",target=/work,readonly');
});

test('docker: volumen de dependencias por package-lock e imagen; CRLF y LF comparten volumen', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-lock-')); const b = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-lock-'));
  fs.writeFileSync(path.join(a, 'package-lock.json'), '{\n  "x": 1\n}\n'); fs.writeFileSync(path.join(b, 'package-lock.json'), '{\r\n  "x": 1\r\n}\r\n');
  assert.match(depsVolumeName(a, 'img:1'), /^portal-ia-nm-[0-9a-f]{16}$/);
  assert.equal(depsVolumeName(a, 'img:1'), depsVolumeName(b, 'img:1'));
  assert.notEqual(depsVolumeName(a, 'img:1'), depsVolumeName(a, 'img:2'), 'otra imagen (otro Node) no reutiliza binarios');
  fs.writeFileSync(path.join(b, 'package-lock.json'), '{"x": 2}');
  assert.notEqual(depsVolumeName(a, 'img:1'), depsVolumeName(b, 'img:1'));
});

test('docker: el CLI recibe las variables de Windows que necesita y ninguna otra', () => {
  const host = { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\y', APPDATA: 'C:\\Users\\y\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\y\\AppData\\Local', ProgramData: 'C:\\ProgramData', DOCKER_HOST: '', ANTHROPIC_API_KEY: 'sk-ant-secreto', PORTAL_DATA_DIR: 'C:\\data', PORTAL_MASTER_KEY: 'x' };
  const win = dockerCliEnv(host, 'win32');
  assert.deepEqual(win, { PATH: 'C:\\bin', SYSTEMROOT: 'C:\\Windows', USERPROFILE: 'C:\\Users\\y', APPDATA: 'C:\\Users\\y\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\y\\AppData\\Local', ProgramData: 'C:\\ProgramData' });
  const lin = dockerCliEnv({ PATH: '/usr/bin', HOME: '/home/y', DOCKER_HOST: 'unix:///run/docker.sock', USERPROFILE: 'x', ANTHROPIC_API_KEY: 'k' }, 'linux');
  assert.deepEqual(lin, { PATH: '/usr/bin', HOME: '/home/y', DOCKER_HOST: 'unix:///run/docker.sock' });
});

// ---- Aislamiento real (requiere Docker Desktop / motor Linux y la imagen) ----
const st = await detectSandbox(true);

test('docker: un script malicioso no ve el Portal ni los datos, no escribe fuera del worktree ni sale a la red; el worktree sí es escribible', { skip: process.env.PORTAL_INSIDE_SANDBOX ? 'ya dentro de un sandbox' : st.available !== 'docker' ? `sandbox disponible: ${st.available}` : false, timeout: 180_000 }, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-docker-repo-'));
  fs.writeFileSync(path.join(repo, 'README.md'), '# r\n'); execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo });
  const wt = path.resolve(repo, '..', `${path.basename(repo)}-worktrees`, 'p1'); fs.mkdirSync(path.dirname(wt), { recursive: true });
  execSync(`git -C "${repo}" worktree add -q --detach "${wt}" HEAD`);
  // Centinelas en la carpeta del «Portal» y en los datos: si el contenedor los encuentra, están montados.
  const sentinel = `centinela-portal-ia-${Date.now()}`;
  fs.writeFileSync(path.join(repo, sentinel), 'x'); fs.writeFileSync(path.join(process.env.PORTAL_DATA_DIR!, sentinel), 'x');
  process.env.PORTAL_PROBE_SECRET = 'no-debe-entrar';
  const probe = [
    `echo found=$(find / -path /proc -prune -o -name ${sentinel} -print 2>/dev/null | wc -l)`,
    'touch ../ESCAPE 2>/dev/null; echo parent=$?', 'touch /ESCAPE 2>/dev/null; echo root=$?',
    'touch node_modules/PWNED 2>/dev/null; echo nm=$?', 'touch ./ok; echo wt=$?',
    'echo secret=${PORTAL_PROBE_SECRET:-none} profile=${USERPROFILE:-none}',
    `node -e "fetch('https://example.com').then(()=>console.log('net=ok')).catch(()=>console.log('net=blocked'))"`,
    `node -e "const s=require('http').createServer((q,r)=>r.end('x')).listen(0,'127.0.0.1',()=>fetch('http://127.0.0.1:'+s.address().port).then(()=>{console.log('lo=ok');process.exit(0)}).catch(()=>{console.log('lo=down');process.exit(0)}))"`,
  ].join('; ');
  fs.writeFileSync(path.join(wt, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: probe } }));
  fs.writeFileSync(path.join(wt, 'package-lock.json'), JSON.stringify({ name: 'x', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'x', version: '1.0.0' } } }));
  const volume = depsVolumeName(wt);
  try {
    // Sin dependencias instaladas, test no se ejecuta.
    const before = await runInSandbox(wt, repo, 'test', { timeoutMs: 120_000 });
    assert.equal(before.isolation, 'docker'); assert.equal(before.exitCode, DEPS_MISSING_EXIT, before.output);
    // install sin dependencias externas: no necesita red (y no la tiene sin confirmarla).
    const inst = await runInSandbox(wt, repo, 'install', { timeoutMs: 120_000 });
    assert.equal(inst.exitCode, 0, inst.output); assert.match(inst.output, /red desactivada/);
    const r = await runInSandbox(wt, repo, 'test', { timeoutMs: 120_000 });
    assert.equal(r.exitCode, 0, r.output);
    assert.match(r.output, /found=0/, 'ni la carpeta del Portal ni los datos están montados');
    assert.match(r.output, /parent=1/); assert.match(r.output, /root=1/);
    assert.match(r.output, /nm=1/, 'las dependencias compartidas son de solo lectura');
    assert.match(r.output, /wt=0/);
    assert.match(r.output, /secret=none profile=none/, 'no entra ninguna variable del equipo');
    assert.match(r.output, /net=blocked/); assert.match(r.output, /lo=ok/, 'loopback disponible para las pruebas del repositorio');
    assert.equal(fs.existsSync(path.join(wt, 'ok')), true, 'el worktree sí');
    assert.equal(fs.existsSync(path.join(path.dirname(wt), 'ESCAPE')), false);
  } finally {
    delete process.env.PORTAL_PROBE_SECRET;
    try { execFileSync('docker', ['volume', 'rm', '-f', volume], { stdio: 'ignore' }); } catch { /* sin volumen */ }
    execSync(`git -C "${repo}" worktree remove --force "${wt}"`);
  }
});
