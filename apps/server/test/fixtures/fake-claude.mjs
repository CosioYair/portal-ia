#!/usr/bin/env node
// CLI de Claude Code SIMULADA para las pruebas del conector (nunca llama a ningún modelo ni usa la red externa).
// Lee su guion de `fake-claude.scenario.json` (junto a este archivo) y registra cada invocación en
// `fake-claude.log.jsonl`: argumentos, prompt, nombres de las variables de entorno recibidas y lo que hizo.
// Imita la salida documentada de `claude -p --output-format stream-json --verbose` y de `claude auth status`, y lo
// comprobado con la CLI real 2.1.311 sin llamar al modelo: --restricted delante de cualquier orden, «init» al leer el
// primer mensaje, un mensaje en blanco que no llega al modelo y «StructuredOutput» cuando se pide --json-schema.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scenarioFile = path.join(here, 'fake-claude.scenario.json');
const logFile = path.join(here, 'fake-claude.log.jsonl');
const sc = fs.existsSync(scenarioFile) ? JSON.parse(fs.readFileSync(scenarioFile, 'utf8')) : {};
const args = process.argv.slice(2);
const log = entry => fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, args, envKeys: Object.keys(process.env).sort(), ...entry })}\n`);
const out = obj => process.stdout.write(`${JSON.stringify(obj)}\n`);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const a = args.filter(x => x !== '--restricted');

if (a[0] === '--version') { log({ kind: 'version' }); console.log(`${sc.version ?? '2.1.311'} (Claude Code)`); process.exit(0); }
if (a[0] === 'auth' && a[1] === 'status') {
  log({ kind: 'auth' });
  const auth = sc.auth ?? 'subscription';
  if (auth === 'garbage') { console.log('esto no es JSON'); process.exit(0); }
  const base = { analyticsDisabled: false, projectsDirectory: 'x', configDirectory: 'x', email: 'propietario@example.com', orgId: 'org-1', orgName: 'Org' };
  const by = {
    subscription: { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' },
    oauth_token: { loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty', subscriptionType: 'pro' },
    api_key: { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' },
    api_key_helper: { loggedIn: true, authMethod: 'api_key_helper', apiProvider: 'firstParty' },
    third_party: { loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock' },
    none: { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' },
    unknown: { loggedIn: true, authMethod: 'quantum', apiProvider: 'firstParty' }
  };
  console.log(JSON.stringify({ ...base, ...(by[auth] ?? by.subscription) }));
  process.exit(auth === 'none' ? 1 : 0);
}
if (!a.includes('-p')) { log({ kind: 'unexpected' }); console.error('fake-claude: solo -p, --version y auth status'); process.exit(2); }

const system = opt('--system-prompt-file') ? fs.readFileSync(opt('--system-prompt-file'), 'utf8') : '';
const behavior = sc.behavior ?? 'ok';
const mcpFile = opt('--mcp-config');
const structured = args.includes('--json-schema');
const sessionTools = () => [...(structured ? ['StructuredOutput'] : []), ...(mcpFile ? (opt('--allowedTools') ?? '').split(',').filter(Boolean) : []), ...(behavior === 'foreign_tools' ? ['Bash', 'Read'] : []), ...(sc.extraTools ?? [])];
const init = () => ({
  type: 'system', subtype: 'init', session_id: 'sess-fake', uuid: 'u0', apiKeySource: sc.apiKeySource === null ? undefined : (sc.apiKeySource ?? 'none'),
  claude_code_version: sc.version ?? '2.1.311', cwd: process.cwd(), tools: sessionTools(), mcp_servers: mcpFile ? [{ name: 'portal', status: sc.mcpStatus ?? 'connected' }] : [],
  model: opt('--model') === 'haiku' ? 'claude-haiku-5-5' : opt('--model'), permissionMode: opt('--permission-mode'), plugins: [{ name: 'cc-plugin-telemetry', path: 'builtin' }]
});
const blankResult = () => ({ type: 'result', subtype: 'success', is_error: false, result: 'Blank prompt — the message was only whitespace, so nothing was sent to the model.', num_turns: sc.gateModelCall ? 1 : 0, duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: sc.gateModelCall ? 10 : 0, output_tokens: 0 }, session_id: 'sess-fake', permission_denials: [] });

let images = 0;
if (opt('--input-format') === 'stream-json') {
  let buf = ''; let started = false; let busy = false; const queue = [];
  const next = async () => {
    if (busy || !queue.length) return; busy = true;
    const msg = queue.shift(); const raw = msg?.message?.content;
    // Contenido en bloques (texto + imágenes en base64), como lo admite el CLI real: se registra cuántas imágenes llegan.
    const content = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';
    images = Array.isArray(raw) ? raw.filter(b => b?.type === 'image' && b?.source?.type === 'base64' && b.source.data).length : 0;
    if (!started) {
      started = true;
      if (behavior === 'malformed') { log({ kind: 'run', prompt: content, system, cwd: process.cwd(), behavior }); process.stdout.write('{"type":"system"\nesto no es json\n'); process.exit(0); }
      out(init());
    }
    if (!content.trim()) { log({ kind: 'blank' }); out({ type: 'system', subtype: 'informational' }); out(blankResult()); busy = false; return next(); }
    await run(content); busy = false; next();
  };
  process.stdin.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { queue.push(JSON.parse(l)); } catch { /* ignorar */ } } next(); });
  process.stdin.on('end', () => { const wait = setInterval(() => { if (!busy && !queue.length) { clearInterval(wait); process.exit(0); } }, 20); });
} else {
  const chunks = [];
  process.stdin.on('data', d => chunks.push(d));
  process.stdin.on('end', async () => { out(init()); await run(Buffer.concat(chunks).toString('utf8')); process.exit(0); });
}

async function run(prompt) {
  const entry = { kind: 'run', prompt, system, cwd: process.cwd(), behavior, images };
  if (behavior === 'hang') {
    fs.writeFileSync(path.join(here, 'fake-claude.pid'), String(process.pid));
    log(entry);
    await new Promise(() => setInterval(() => {}, 1000)); // espera hasta que la maten (plazo o cancelación)
  }
  if (behavior === 'overage') {
    // Uso adicional en plena llamada: si el Portal no la para, terminaría «bien» (y la prueba lo detectaría).
    log(entry);
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'overage', isUsingOverage: true, resetsAt: 1893456000 }, uuid: 'u1', session_id: 'sess-fake' });
    await new Promise(r => setTimeout(r, 300));
    out({ type: 'result', subtype: 'success', is_error: false, result: 'hecho', num_turns: 1, duration_ms: 50, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 5 }, session_id: 'sess-fake', permission_denials: [] });
    process.exit(0);
  }
  if (behavior === 'limit') {
    log(entry);
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1893456000, errorCode: sc.creditsRequired ? 'credits_required' : undefined }, uuid: 'u1', session_id: 'sess-fake' });
    out({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'Claude AI usage limit reached', num_turns: 1, duration_ms: 50, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, session_id: 'sess-fake', permission_denials: [] });
    process.exit(1);
  }
  if (behavior === 'error') {
    log(entry);
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['algo falló dentro de la ejecución'], num_turns: 1, duration_ms: 10, total_cost_usd: 0, usage: {}, session_id: 'sess-fake', permission_denials: [] });
    process.exit(1);
  }
  // Lectura por el puente MCP del Portal (servidor real de scripts/portal-mcp.mjs, API real del Portal).
  if (mcpFile && sc.mcpRead) entry.mcp = await useMcp(JSON.parse(fs.readFileSync(mcpFile, 'utf8')).mcpServers.portal, sc.mcpRead);
  const rule = (sc.rules ?? []).find(r => prompt.includes(r.match)) ?? null;
  entry.rule = rule?.match ?? null;
  log(entry);
  out({ type: 'assistant', message: { content: [...(entry.mcp ? [{ type: 'tool_use', name: 'mcp__portal__portal_read_file', input: {} }] : []), { type: 'text', text: '…' }] }, session_id: 'sess-fake' });
  if (sc.slowMs) await new Promise(r => setTimeout(r, sc.slowMs));
  // Turnos agotados (como la CLI real con --max-turns): explora con herramientas y termina sin respuesta, con su uso.
  if (rule?.maxTurns) {
    const limit = Number(opt('--max-turns')) || 8;
    for (let t = 0; t < limit; t++) out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: t % 3 ? 'mcp__portal__portal_read_file' : 'mcp__portal__portal_list_files', input: {} }] }, session_id: 'sess-fake' });
    out({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: limit + 1, duration_ms: 4321, total_cost_usd: 0.31, session_id: 'sess-fake', usage: { input_tokens: 9000, cache_read_input_tokens: 21000, output_tokens: 700 }, permission_denials: [] });
    return;
  }
  const text = rule?.text ?? sc.defaultText ?? 'Respuesta simulada.';
  out({
    type: 'result', subtype: 'success', is_error: false, result: rule?.structured ? '' : text, ...(rule?.structured ? { structured_output: rule.structured } : {}),
    stop_reason: rule?.stopReason ?? 'end_turn', num_turns: entry.mcp ? 2 : 1, duration_ms: 1234, total_cost_usd: 0.0421, session_id: 'sess-fake',
    usage: { input_tokens: 1200, cache_creation_input_tokens: 300, cache_read_input_tokens: 500, output_tokens: 400 }, permission_denials: []
  });
}

/** Cliente MCP mínimo: initialize → tools/list → tools/call de cada lectura pedida por el guion. */
function useMcp(server, reads) {
  return new Promise(resolve => {
    const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = ''; const waiting = new Map(); let next = 1;
    child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); waiting.get(m.id)?.(m); } catch { /* ignorar */ } } });
    const call = (method, params) => new Promise(r => { const id = next++; waiting.set(id, r); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
    (async () => {
      const initR = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const list = await call('tools/list', {});
      const results = [];
      for (const r of reads) {
        const res = await call('tools/call', { name: r.tool ?? 'portal_read_file', arguments: r.args ?? { path: r.path } });
        results.push({ request: r, isError: res.result?.isError ?? true, text: res.result?.content?.[0]?.text ?? JSON.stringify(res.error ?? null) });
      }
      child.stdin.end();
      resolve({ protocol: initR.result?.protocolVersion, tools: (list.result?.tools ?? []).map(t => t.name), results });
    })();
  });
}
