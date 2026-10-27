import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { RuntimeCheck, RuntimeCheckResult } from '@portal-ia/domain';
import { config } from '../config.ts';

/**
 * Verificación en ejecución (M2): una vez ACTIVADO un cambio (servidor reiniciado con el merge y web reconstruida),
 * el Portal se comprueba a sí mismo contra el proceso en marcha:
 *  - `http`: GET a una ruta del propio Portal; la respuesta debe contener el texto (o cumplir la expresión regular).
 *  - `ui`: abre la ruta con un navegador (Playwright, si está instalado) y comprueba que el elemento contiene el texto;
 *    guarda una captura como evidencia en data/evidence/<processId>/. Sin Playwright → `skipped` (nunca «ok» sin prueba).
 * Ninguna comprobación se da por buena sin evidencia: el resultado guarda el extracto o la captura.
 */
export function evidenceDir(processId: string): string {
  const d = path.join(config.dataDir, 'evidence', processId.replace(/[^A-Za-z0-9-]/g, '_'));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function baseUrl(): string { return process.env.PORTAL_SELF_URL ?? `http://127.0.0.1:${config.port}`; }

/** Comprobaciones mínimas que se añaden siempre para el proyecto interno: el Portal responde y sirve la interfaz nueva. */
export function defaultChecks(): RuntimeCheck[] {
  return [
    { kind: 'http', path: '/api/health', selector: null, expect: 'ok' },
    { kind: 'http', path: '/api/system/status', selector: null, expect: '/"buildCommit":"[0-9a-f]{7,}"/' }
  ];
}

export function matches(text: string, expect: string): boolean {
  const re = expect.match(/^\/(.+)\/([a-z]*)$/);
  if (re) { try { return new RegExp(re[1], re[2].replace('g', '')).test(text); } catch { return text.includes(expect); } }
  return text.includes(expect);
}

async function httpCheck(c: RuntimeCheck, dir: string, i: number): Promise<RuntimeCheckResult> {
  const at = new Date().toISOString(); const url = baseUrl() + c.path;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15_000);
    const res = await fetch(url, { signal: ctl.signal, headers: { 'cache-control': 'no-cache' } }); clearTimeout(t);
    const body = await res.text();
    const ok = res.ok && matches(body, c.expect);
    const file = path.join(dir, `check-${i + 1}-http.txt`);
    fs.writeFileSync(file, `GET ${url}\nHTTP ${res.status}\n\n${body.slice(0, 200_000)}`);
    return { check: c, status: ok ? 'ok' : 'fail', detail: ok ? `HTTP ${res.status}, la respuesta contiene lo esperado.` : `HTTP ${res.status}; ${res.ok ? 'la respuesta no contiene lo esperado' : 'error del servidor'}. Extracto: ${body.slice(0, 300).replace(/\s+/g, ' ')}`, evidence: file, at };
  } catch (e: any) { return { check: c, status: 'fail', detail: `No se pudo consultar ${url}: ${e.message}`, evidence: null, at }; }
}

let playwrightMod: any | null | undefined;
function loadPlaywright(): any | null {
  if (playwrightMod !== undefined) return playwrightMod;
  try { const req = createRequire(import.meta.url); playwrightMod = req('playwright'); }
  catch { try { const req = createRequire(import.meta.url); playwrightMod = req(process.env.PORTAL_PLAYWRIGHT ?? '/opt/npm-tools/node_modules/playwright/index.mjs'); } catch { playwrightMod = null; } }
  return playwrightMod;
}

async function uiCheck(c: RuntimeCheck, dir: string, i: number): Promise<RuntimeCheckResult> {
  const at = new Date().toISOString(); const url = baseUrl() + c.path;
  const pw = loadPlaywright();
  if (!pw?.chromium) return { check: c, status: 'skipped', detail: 'Playwright no está instalado: la comprobación de interfaz queda pendiente (no se da por buena). Instálalo con «npm i -D playwright && npx playwright install chromium» para habilitarla.', evidence: null, at };
  let browser: any = null;
  try {
    browser = await pw.chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    const sel = c.selector || 'body';
    let text = '';
    try { await page.waitForSelector(sel, { timeout: 10_000 }); text = (await page.locator(sel).first().innerText()) ?? ''; } catch { text = ''; }
    const file = path.join(dir, `check-${i + 1}-ui.png`);
    await page.screenshot({ path: file, fullPage: false });
    const ok = !!text && matches(text, c.expect);
    return { check: c, status: ok ? 'ok' : 'fail', detail: ok ? `«${sel}» contiene lo esperado. Captura guardada.` : (text ? `«${sel}» no contiene lo esperado. Texto encontrado: ${text.slice(0, 200).replace(/\s+/g, ' ')}` : `No se encontró «${sel}» en ${c.path}.`), evidence: file, at };
  } catch (e: any) { return { check: c, status: 'fail', detail: `Error abriendo ${url}: ${e.message}`, evidence: null, at }; }
  finally { if (browser) await browser.close().catch(() => undefined); }
}

export async function runRuntimeChecks(processId: string, checks: RuntimeCheck[]): Promise<RuntimeCheckResult[]> {
  const dir = evidenceDir(processId);
  const out: RuntimeCheckResult[] = [];
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i];
    out.push(c.kind === 'http' ? await httpCheck(c, dir, i) : await uiCheck(c, dir, i));
  }
  return out;
}

/** true solo si hay comprobaciones y ninguna falló ni quedó pendiente. */
export function runtimeVerified(rc: { checks: RuntimeCheck[]; results: RuntimeCheckResult[]; ranAt: string | null } | null | undefined): boolean {
  return !!rc && !!rc.ranAt && rc.results.length > 0 && rc.results.length >= rc.checks.length && rc.results.every(r => r.status === 'ok');
}
