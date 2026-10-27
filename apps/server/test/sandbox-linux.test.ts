import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/** M1 · Sandbox `linux-ns` (solo en Linux sin Docker): sin red, Portal/HOME/datos en solo lectura, worktree escribible. Se omite donde no aplique. */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-ns-'));
delete process.env.PORTAL_SANDBOX;
const { detectSandbox, runInSandbox } = await import('../src/services/sandbox.ts');
const st = await detectSandbox(true);

test('linux-ns: un script malicioso no puede escribir fuera del worktree ni salir a la red; el worktree sí es escribible', { skip: process.env.PORTAL_INSIDE_SANDBOX ? 'ya dentro de un sandbox' : st.available !== 'linux-ns' ? `sandbox disponible: ${st.available}` : false }, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-ns-repo-'));
  fs.writeFileSync(path.join(repo, 'README.md'), '# r\n'); execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm Base', { cwd: repo });
  const wt = path.resolve(repo, '..', `${path.basename(repo)}-worktrees`, 'p1'); fs.mkdirSync(path.dirname(wt), { recursive: true });
  execSync(`git -C "${repo}" worktree add -q --detach "${wt}" HEAD`);
  const home = os.homedir();
  const probe = `touch "${repo}/PWNED"; echo portal=$?; touch "${home}/PWNED-portal-ia"; echo home=$?; touch ./ok; echo wt=$?; touch "${process.env.PORTAL_DATA_DIR}/PWNED"; echo data=$?; node -e "fetch('https://example.com').then(()=>console.log('net=ok')).catch(()=>console.log('net=blocked'))"; node -e "const s=require('http').createServer((q,r)=>r.end('x')).listen(0,'127.0.0.1',()=>fetch('http://127.0.0.1:'+s.address().port).then(()=>{console.log('lo=ok');process.exit(0)}).catch(()=>{console.log('lo=down');process.exit(0)}))"`;
  fs.writeFileSync(path.join(wt, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: probe } }));
  const r = await runInSandbox(wt, repo, 'test', { timeoutMs: 60_000 });
  assert.equal(r.isolation, 'linux-ns');
  assert.match(r.output, /net=blocked/); assert.match(r.output, /wt=0/); assert.match(r.output, /lo=ok/, 'loopback disponible para las pruebas del repositorio');
  assert.equal(fs.existsSync(path.join(repo, 'PWNED')), false, 'la carpeta del Portal no se puede escribir');
  assert.equal(fs.existsSync(path.join(home, 'PWNED-portal-ia')), false, 'HOME no se puede escribir');
  assert.equal(fs.existsSync(path.join(process.env.PORTAL_DATA_DIR!, 'PWNED')), false, 'los datos no se pueden escribir');
  assert.equal(fs.existsSync(path.join(wt, 'ok')), true, 'el worktree sí');
  execSync(`git -C "${repo}" worktree remove --force "${wt}"`);
});
