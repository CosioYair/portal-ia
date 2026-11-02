#!/usr/bin/env node
// CLI de Codex SIMULADA para las pruebas del arnés (nunca llama a ningún modelo ni usa la red).
// Lee su guion de `fake-codex.scenario.json` (junto a este archivo) y registra cada invocación en `fake-codex.log.jsonl`
// (argumentos, prompt recibido por stdin y NOMBRES de las variables de entorno). Imita lo comprobado con la CLI real
// 0.166.0-alpha sin llamar al modelo: `--version`, `login status`, `features list`, `debug prompt-input` (lista de
// herramientas que expondría la sesión) y la salida JSONL documentada de `codex exec --json` con `-o <archivo>`.
// Escenarios: auth = chatgpt | api_key | none; tools = [] (restringido) o la lista de la versión real; exec = ok | tool | limit | fail | slow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sc = (() => { try { return JSON.parse(fs.readFileSync(path.join(here, 'fake-codex.scenario.json'), 'utf8')); } catch { return {}; } })();
const args = process.argv.slice(2);
const log = entry => fs.appendFileSync(path.join(here, 'fake-codex.log.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), args, envKeys: Object.keys(process.env).sort(), ...entry })}\n`);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

if (args[0] === '--version') { log({ kind: 'version' }); console.log(`codex-cli ${sc.version ?? '0.166.0-alpha.5.1'}`); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') {
  log({ kind: 'login' });
  const a = sc.auth ?? 'chatgpt';
  console.error(a === 'chatgpt' ? 'Logged in using ChatGPT' : a === 'api_key' ? 'Logged in using an API key - sk-***' : 'Not logged in');
  process.exit(a === 'none' ? 1 : 0);
}
if (args[0] === 'features' && args[1] === 'list') {
  log({ kind: 'features' });
  for (const f of ['shell_tool', 'unified_exec', 'multi_agent', 'plugins', 'apps', 'browser_use', 'computer_use', 'image_generation', 'hooks', 'code_mode_host', 'skill_search', 'memories', 'sleep_tool'])
    console.log(`${f.padEnd(40)} stable             true`);
  process.exit(0);
}
if (args[0] === 'debug' && args[1] === 'prompt-input') {
  log({ kind: 'prompt-input' });
  const tools = (sc.tools ?? []).map(name => ({ type: 'function', name, description: name, parameters: { type: 'object', properties: {} } }));
  console.log(JSON.stringify([
    { type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: 'functions', tools }] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: sc.skills ? '## Skills\n### Available skills\n- demo' : 'Instrucciones' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: args[args.length - 1] }] }
  ]));
  process.exit(0);
}
if (args[0] === 'exec') {
  let prompt = '';
  process.stdin.on('data', d => { prompt += d; });
  process.stdin.on('end', async () => {
    const mode = sc.exec ?? 'ok';
    log({ kind: 'exec', prompt, cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()) });
    const out = o => process.stdout.write(`${JSON.stringify(o)}\n`);
    out({ type: 'thread.started', thread_id: 'th_falso' }); out({ type: 'turn.started' });
    if (mode === 'slow') await new Promise(r => setTimeout(r, 30_000));
    if (mode === 'tool') { out({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'type C:\\secreto.txt' } }); await new Promise(r => setTimeout(r, 5000)); }
    if (mode === 'limit') { out({ type: 'turn.failed', error: { message: "You've hit your usage limit. Upgrade or try again later." } }); process.exit(1); }
    if (mode === 'fail') { console.error('Error: algo salió mal'); process.exit(2); }
    const marker = (prompt.match(/MARCA-[A-Z0-9-]+/g) ?? []).join(' ');
    const text = sc.reply ?? `Respuesta simulada de Codex.${marker ? ` Vi: ${marker}` : ''}`;
    out({ type: 'item.completed', item: { id: 'i2', type: 'reasoning', text: 'pensando' } });
    out({ type: 'item.completed', item: { id: 'i3', type: 'agent_message', text } });
    out({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 300 } });
    const o = opt('-o'); if (o) fs.writeFileSync(o, text);
    process.exit(0);
  });
} else { log({ kind: 'unknown' }); console.error('orden desconocida'); process.exit(64); }
