import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-lifecycle-'));
const { isProcessAlive } = await import('../src/services/lifecycle.ts');

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '../../..');
const FIXTURE = path.join(here, 'fixtures', 'lifecycle-server.ts');

interface Fixture { proc: ChildProcess; port: number; trackedPid: number; untrackedPid: number }

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
  });
}

function canBind(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function startFixture(extraEnv: Record<string, string> = {}): Promise<Fixture> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, PORTAL_PORT: String(port), PORTAL_HOST: '127.0.0.1', LOG_LEVEL: 'silent', ...extraEnv };
  if (!('PORTAL_SUPERVISED' in extraEnv)) delete env.PORTAL_SUPERVISED;
  const proc = spawn(process.execPath, ['--import', 'tsx', FIXTURE], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise<Fixture>((resolve, reject) => {
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('El servidor de prueba no arrancó a tiempo')); }, 30000);
    let buf = '';
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      for (const line of buf.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const info = JSON.parse(line);
          if (info.ready) { clearTimeout(timer); resolve({ proc, port, trackedPid: info.trackedPid, untrackedPid: info.untrackedPid }); return; }
        } catch { /* línea parcial */ }
      }
    });
    proc.once('exit', code => { clearTimeout(timer); reject(new Error(`El servidor de prueba terminó antes de estar listo (código ${code})`)); });
  });
}

async function waitExit(proc: ChildProcess, ms: number): Promise<number | null> {
  if (proc.exitCode !== null || proc.signalCode !== null) return proc.exitCode;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`El proceso no terminó en ${ms} ms`)), ms); });
  try { await Promise.race([once(proc, 'exit'), timeout]); } finally { clearTimeout(timer); }
  return proc.exitCode;
}

async function waitDead(pid: number, ms = 5000): Promise<boolean> {
  const limit = Date.now() + ms;
  while (Date.now() < limit) {
    if (!isProcessAlive(pid)) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return !isProcessAlive(pid);
}

function cleanup(fx: Fixture): void {
  for (const pid of [fx.proc.pid, fx.trackedPid, fx.untrackedPid]) {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* ya terminado */ } }
  }
}

async function assertFullyStopped(fx: Fixture): Promise<void> {
  assert.ok(await waitDead(fx.trackedPid), 'el hijo registrado sigue vivo');
  assert.ok(await waitDead(fx.untrackedPid), 'el hijo sin registrar sigue vivo');
  assert.equal(await canBind(fx.port), true, 'el puerto sigue ocupado');
}

const restart = (port: number, body: unknown) => fetch(`http://127.0.0.1:${port}/api/system/restart`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('reiniciar sin supervisor: apaga todo, libera el puerto y devuelve los comandos exactos', async t => {
  const fx = await startFixture();
  t.after(() => cleanup(fx));
  assert.ok(isProcessAlive(fx.trackedPid) && isProcessAlive(fx.untrackedPid));
  assert.equal(await canBind(fx.port), false, 'el puerto debería estar ocupado mientras el servidor corre');

  const rejected = await restart(fx.port, {});
  assert.equal(rejected.status, 400, 'sin confirmación explícita no se reinicia');
  assert.equal(fx.proc.exitCode, null);

  const res = await restart(fx.port, { confirm: true });
  assert.equal(res.status, 202);
  const outcome = await res.json() as { mode: string; port: number; cwd: string; commands: string[] };
  assert.equal(outcome.mode, 'shutdown');
  assert.equal(outcome.port, fx.port);
  assert.equal(outcome.cwd, REPO_ROOT);
  assert.deepEqual(outcome.commands, ['npm install', 'npm run build', 'npm start']);

  assert.equal(await waitExit(fx.proc, 8000), 0);
  await assertFullyStopped(fx);
});

test('reiniciar con conexiones keep-alive y una petición colgada abiertas no retiene el puerto', async t => {
  const fx = await startFixture();
  t.after(() => cleanup(fx));
  const agent = new http.Agent({ keepAlive: true });
  await new Promise<void>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: fx.port, path: '/api/health', agent }, r => { r.resume(); r.on('end', resolve); }).on('error', reject);
  });
  const hung = net.connect(fx.port, '127.0.0.1');
  hung.on('error', () => { /* esperado al cerrar el servidor */ });
  await once(hung, 'connect');
  hung.write('GET /api/health HTTP/1.1\r\nHost: localhost\r\n'); // petición incompleta: nunca termina

  const res = await restart(fx.port, { confirm: true });
  assert.equal(res.status, 202);
  assert.equal(await waitExit(fx.proc, 8000), 0);
  agent.destroy(); hung.destroy();
  await assertFullyStopped(fx);
});

test('con supervisor declarado el modo es «restarting» y el proceso sale con el código convenido (75)', async t => {
  const fx = await startFixture({ PORTAL_SUPERVISED: '1' });
  t.after(() => cleanup(fx));
  const res = await restart(fx.port, { confirm: true });
  assert.equal(res.status, 202);
  const outcome = await res.json() as { mode: string; commands: string[] };
  assert.equal(outcome.mode, 'restarting');
  assert.deepEqual(outcome.commands, []);
  assert.equal(await waitExit(fx.proc, 8000), 75);
  await assertFullyStopped(fx);
});

test('SIGTERM (como Ctrl+C) hace el mismo apagado limpio', { skip: process.platform === 'win32' }, async t => {
  const fx = await startFixture();
  t.after(() => cleanup(fx));
  fx.proc.kill('SIGTERM');
  assert.equal(await waitExit(fx.proc, 8000), 0);
  await assertFullyStopped(fx);
});
