// HU-212 · Probar la Edición en la misma máquina (editionSandbox.ts). Sin IA.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  EDITION_SANDBOX_URL, buildEditionEnv, editionSandboxOutput, editionSandboxStatus, resolveEditionSandboxPaths,
  startEditionSandbox, stopEditionSandbox, type SpawnFn
} from '../src/services/editionSandbox.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(here, '..');
const INSTALL_ROOT = path.resolve(here, '../../..');
const SERVICE_FILE = path.join(SERVER_DIR, 'src', 'services', 'editionSandbox.ts');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hu212-'));
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function canListen(): Promise<boolean> {
  return new Promise(res => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.listen({ host: '127.0.0.1', port: 4320, exclusive: true }, () => s.close(() => res(true)));
  });
}
function isDead(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
}
async function waitFor(fn: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(250); }
  return fn();
}
function snapshot(dir: string): Record<string, { hash: string; mtime: number }> {
  const out: Record<string, { hash: string; mtime: number }> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name); const st = fs.statSync(p);
      if (e.isDirectory()) { out[path.relative(dir, p) + '/'] = { hash: 'dir', mtime: st.mtimeMs }; walk(p); }
      else out[path.relative(dir, p)] = { hash: sha(fs.readFileSync(p)), mtime: st.mtimeMs };
    }
  };
  walk(dir); return out;
}
const codeOf = (e: unknown) => (e as { code?: string }).code;

// ---------- Entorno ----------

test('buildEditionEnv fija puerto, host, edición y rutas propias, y vacía las claves de proveedor', () => {
  const paths = { root: path.join(TMP, 'sb'), dataDir: path.join(TMP, 'sb', 'data'), worktreesDir: path.join(TMP, 'sb', 'worktrees') };
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, PORTAL_DATA_DIR: path.join(TMP, 'estudio-data'), PORTAL_PORT: '4310', PORTAL_EDITION: 'studio',
    ANTHROPIC_API_KEY: 'valor-de-prueba', OPENAI_API_KEY: 'valor-de-prueba', OTRO_API_KEY: 'x',
    PORTAL_PREVIEW_PORT: '4400', PORTAL_MAIN_BRANCH: 'main'
  };
  const env = buildEditionEnv(base, paths);
  assert.equal(env.PORTAL_EDITION, 'distributable');
  assert.equal(env.PORTAL_PORT, '4320');
  assert.equal(env.PORTAL_HOST, '127.0.0.1');
  assert.equal(env.PORTAL_DATA_DIR, paths.dataDir);
  assert.equal(env.PORTAL_WORKTREES_DIR, paths.worktreesDir);
  assert.equal(env.ANTHROPIC_API_KEY, '', 'definida y vacía: el .env del Estudio no la rellena');
  assert.equal(env.OPENAI_API_KEY, '');
  assert.equal(env.OTRO_API_KEY, '');
  assert.equal('PORTAL_PREVIEW_PORT' in env, false);
  assert.equal('PORTAL_MAIN_BRANCH' in env, false);
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(base.PORTAL_DATA_DIR, path.join(TMP, 'estudio-data'), 'no muta el entorno base');
});

// ---------- Rutas ----------

test('resolveEditionSandboxPaths: por defecto <instalación>-edicion y rechaza carpetas peligrosas (unsafe_dir)', () => {
  const inst = path.join(TMP, 'inst'); const studio = path.join(inst, 'data');
  fs.mkdirSync(studio, { recursive: true });
  const def = resolveEditionSandboxPaths({ installRoot: inst, studioDataDir: studio });
  assert.equal(def.dataDir, path.join(TMP, 'inst-edicion', 'data'));
  assert.equal(def.worktreesDir, path.join(TMP, 'inst-edicion', 'worktrees'));
  const ok = resolveEditionSandboxPaths({ installRoot: inst, studioDataDir: studio, override: path.join(TMP, 'fuera') });
  assert.equal(ok.dataDir, path.join(TMP, 'fuera', 'data'));
  const external = path.join(TMP, 'estudio-externo'); fs.mkdirSync(external, { recursive: true });
  const bad: Array<[string, string]> = [
    [studio, studio], [path.join(studio, 'sub'), studio], [TMP, studio], [path.join(inst, 'otra'), studio],
    [external, external], [path.join(external, 'dentro'), external]
  ];
  for (const [override, studioDataDir] of bad) {
    assert.throws(() => resolveEditionSandboxPaths({ installRoot: inst, studioDataDir, override }),
      (e: unknown) => codeOf(e) === 'unsafe_dir' && /no permitida/.test((e as Error).message), `debe rechazar ${override}`);
  }
  assert.equal(fs.existsSync(path.join(TMP, 'fuera')), false, 'resolver rutas no crea carpetas');
});

// ---------- port_busy ----------

/** Ocupa 127.0.0.1:4320 de verdad; reintenta si otro programa lo usa un instante. Devuelve el servidor escuchando o null. */
async function occupy4320(ms = 10_000): Promise<net.Server | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = net.createServer();
    const ok = await new Promise<boolean>(res => {
      s.once('error', () => res(false));
      s.listen({ host: '127.0.0.1', port: 4320, exclusive: true }, () => res(true));
    });
    if (ok && s.listening) return s;
    s.close(); await sleep(200);
  }
  return null;
}

test('port_busy: con el 4320 ocupado falla en español sin spawn ni carpetas', async () => {
  const blocker = await occupy4320();
  assert.ok(blocker, 'la prueba debe poder ocupar 127.0.0.1:4320 para comprobar port_busy');
  assert.equal(blocker.listening, true, 'el bloqueador escucha en 4320 antes de arrancar');
  const override = path.join(TMP, 'sb-busy'); let calls = 0;
  const spy: SpawnFn = () => { calls++; throw new Error('no debe llamarse'); };
  try {
    await assert.rejects(startEditionSandbox({ installRoot: path.join(TMP, 'inst'), studioDataDir: path.join(TMP, 'inst', 'data'), override, spawnFn: spy, log: () => undefined }),
      (e: unknown) => codeOf(e) === 'port_busy' && /4320/.test((e as Error).message) && /ocupado/.test((e as Error).message));
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(override), false);
    assert.equal(editionSandboxStatus().running, false);
  } finally { await new Promise<void>(res => blocker.close(() => res())); }
});

// ---------- already_running (hijo simulado) ----------

test('already_running: la segunda llamada falla en español y no vuelve a lanzar', async t => {
  if (!(await canListen())) { t.skip('el puerto 4320 está ocupado por otro programa'); return; }
  let calls = 0;
  const fake: SpawnFn = (_cmd, _args, options) => {
    calls++;
    const dataDir = (options.env as NodeJS.ProcessEnv).PORTAL_DATA_DIR!;
    fs.writeFileSync(path.join(dataDir, '.master.key'), Buffer.alloc(32, 3).toString('hex'));
    const child = new EventEmitter() as EventEmitter & { pid: number; stdout: null; stderr: null; kill: () => boolean };
    child.pid = 999_999; child.stdout = null; child.stderr = null;
    child.kill = () => { setImmediate(() => child.emit('exit', 0)); return true; };
    return child as unknown as ChildProcess;
  };
  const common = { installRoot: path.join(TMP, 'inst'), studioDataDir: path.join(TMP, 'inst', 'data'), override: path.join(TMP, 'sb-fake'), spawnFn: fake, log: () => undefined, health: async () => true };
  const info = await startEditionSandbox(common);
  assert.equal(info.url, EDITION_SANDBOX_URL);
  assert.equal(info.ownKey, true);
  assert.equal(editionSandboxStatus().running, true);
  await assert.rejects(startEditionSandbox(common),
    (e: unknown) => codeOf(e) === 'already_running' && /ya está en marcha/.test((e as Error).message));
  assert.equal(calls, 1);
  assert.equal(await stopEditionSandbox(), true);
  assert.equal(editionSandboxStatus().running, false);
});

// ---------- Guardián ----------

test('guardián: editionSandbox.ts no importa config.ts ni repoWrite.ts ni usa REPO_ROOT', () => {
  const src = fs.readFileSync(SERVICE_FILE, 'utf8');
  assert.doesNotMatch(src, /\bREPO_ROOT\b/);
  assert.doesNotMatch(src, /from\s+['"][^'"]*config\.ts['"]/);
  assert.doesNotMatch(src, /from\s+['"][^'"]*repoWrite\.ts['"]/);
  const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
  assert.ok(imports.every(i => i.startsWith('node:')), `solo módulos node:*; hay: ${imports.join(', ')}`);
});

test('guardián: importar editionSandbox.ts en otro proceso no toca la carpeta de datos', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hu212-guard-'));
  const helper = path.join(empty, '..', `hu212-guard-${process.pid}.mjs`);
  fs.writeFileSync(helper, `await import(${JSON.stringify(pathToFileURL(SERVICE_FILE).href)});\n`);
  const code = await new Promise<number | null>(res => {
    const p = spawn(process.execPath, ['--import', 'tsx', helper], { cwd: SERVER_DIR, env: { ...process.env, PORTAL_DATA_DIR: empty }, stdio: 'ignore', windowsHide: true });
    p.once('exit', c => res(c));
  });
  fs.rmSync(helper, { force: true });
  assert.equal(code, 0);
  assert.deepEqual(fs.readdirSync(empty), [], 'sin workspaces/, .schema-version ni backups/');
});

// ---------- Integración: la Edición real ----------

const distMissing = !fs.existsSync(path.join(INSTALL_ROOT, 'apps', 'web', 'dist'));
const busyBefore = !(await canListen());
const skipReason = busyBefore ? 'el puerto 4320 ya estaba ocupado' : distMissing ? 'falta apps/web/dist (npm run build)' : false;

test('integración: arranca en 4320 con clave propia, sin filtrar claves y sin tocar el data/ del Estudio; stop libera pid y puerto', { skip: skipReason, timeout: 240_000 }, async () => {
  const studio = path.join(TMP, 'estudio-data'); fs.mkdirSync(studio, { recursive: true });
  const seeded = Buffer.alloc(32, 7).toString('hex');
  fs.writeFileSync(path.join(studio, '.master.key'), seeded);
  fs.writeFileSync(path.join(studio, 'marcador.txt'), 'estudio');
  const before = snapshot(studio);
  const override = path.join(TMP, 'sb-real'); const logs: string[] = []; const errors: unknown[] = [];
  const info = await startEditionSandbox({ installRoot: INSTALL_ROOT, studioDataDir: studio, override, log: m => logs.push(m), startTimeoutMs: 180_000 });
  let pid = info.pid;
  try {
    const r = await fetch(`${EDITION_SANDBOX_URL}/api/health`);
    assert.equal(r.ok, true);
    const body = await r.json().catch(() => null) as { edition?: unknown; config?: { edition?: unknown } } | null;
    const edition = body?.edition ?? body?.config?.edition;
    if (typeof edition === 'string') assert.equal(edition, 'distributable');
    const keyFile = path.join(info.dataDir, '.master.key');
    assert.ok(fs.existsSync(keyFile), 'la Edición crea su propia .master.key');
    const raw = fs.readFileSync(keyFile); const text = raw.toString('utf8').trim();
    assert.notEqual(sha(text), sha(seeded), 'la clave de la Edición es distinta de la del Estudio');
    await startEditionSandbox({ installRoot: INSTALL_ROOT, studioDataDir: studio, override, log: m => logs.push(m) }).catch(e => errors.push(e));
    assert.equal(codeOf(errors[0]), 'already_running');
    try { resolveEditionSandboxPaths({ installRoot: INSTALL_ROOT, studioDataDir: studio, override: studio }); } catch (e) { errors.push(e); }
    const forbidden = [seeded, Buffer.from(seeded).toString('base64'), sha(seeded), sha(Buffer.from(seeded, 'hex')),
      text, raw.toString('hex'), raw.toString('base64'), sha(text), sha(raw)].filter(s => s.length >= 16);
    const haystack = [...logs, ...editionSandboxOutput(), ...errors.map(e => `${(e as Error).message}\n${JSON.stringify(e)}`)].join('\n');
    for (const f of forbidden) assert.equal(haystack.includes(f), false, 'una clave o su hash aparece en logs, salida o errores');
    assert.ok(logs.some(l => /clave propia: sí/.test(l)));
  } finally {
    assert.equal(await stopEditionSandbox(), true);
  }
  assert.ok(pid, 'el hijo tenía pid');
  assert.ok(await waitFor(() => isDead(pid!), 10_000), 'el hijo ha muerto (ESRCH)');
  assert.ok(await waitFor(canListen, 10_000), 'el 4320 queda libre');
  assert.equal(editionSandboxStatus().running, false);
  assert.deepEqual(snapshot(studio), before, 'el data/ del Estudio queda idéntico (archivos, contenido y mtimes)');
  pid = null;
});

test('integración: si el proceso padre sale, el hijo muere y el 4320 queda libre', { skip: skipReason, timeout: 240_000 }, async () => {
  const studio = path.join(TMP, 'estudio-data-2'); fs.mkdirSync(studio, { recursive: true });
  const helper = path.join(os.tmpdir(), `hu212-padre-${process.pid}.mjs`);
  fs.writeFileSync(helper, [
    `const m = await import(${JSON.stringify(pathToFileURL(SERVICE_FILE).href)});`,
    `const info = await m.startEditionSandbox({ installRoot: ${JSON.stringify(INSTALL_ROOT)}, studioDataDir: ${JSON.stringify(studio)}, override: ${JSON.stringify(path.join(TMP, 'sb-padre'))}, log: () => {}, startTimeoutMs: 180000 });`,
    `console.log('PID:' + info.pid);`,
    `process.exit(0);`
  ].join('\n'));
  let out = '';
  const parentCode = await new Promise<number | null>(res => {
    const p = spawn(process.execPath, ['--import', 'tsx', helper], { cwd: SERVER_DIR, env: process.env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    p.stdout?.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    p.once('exit', c => res(c));
  });
  fs.rmSync(helper, { force: true });
  assert.equal(parentCode, 0);
  const m = out.match(/PID:(\d+)/);
  assert.ok(m, 'el padre imprimió el pid del hijo');
  const pid = Number(m[1]);
  assert.ok(await waitFor(() => isDead(pid), 15_000), 'el hijo murió tras la salida del padre (ESRCH)');
  assert.ok(await waitFor(canListen, 15_000), 'el 4320 queda libre');
});

test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });
