#!/usr/bin/env node
// Puente MCP (stdio) entre Claude Code y Portal IA. Sin dependencias: solo Node.
//
// Claude Code lo lanza como servidor MCP local. Cada herramienta llama a la API del puente del Portal
// (`/api/bridge/v1/*`) con el token de PORTAL_BRIDGE_TOKEN; el Portal decide el alcance a partir del token
// (espacio, agentes, tarea) y nunca a partir de los argumentos que envía el modelo.
//
// Variables:
//   PORTAL_URL           dirección del Portal (por defecto http://127.0.0.1:4310)
//   PORTAL_BRIDGE_TOKEN  token de una consola autorizada (o de UNA ejecución gestionada por el Portal)
//   PORTAL_BRIDGE_MODE   «worker» (consola del propietario, por defecto) o «job» (ejecución gestionada)
//
// Registro en la consola del propietario (la orden exacta, con el token, la muestra el Portal al crear la consola):
//   claude mcp add --scope user portal-ia -e PORTAL_URL=… -e PORTAL_BRIDGE_TOKEN=… -- node scripts/portal-mcp.mjs
import { createInterface } from 'node:readline';

const BASE = (process.env.PORTAL_URL || 'http://127.0.0.1:4310').replace(/\/+$/, '');
const TOKEN = process.env.PORTAL_BRIDGE_TOKEN || '';
const MODE = process.env.PORTAL_BRIDGE_MODE === 'job' ? 'job' : 'worker';
const VERSION = '1.0.0';
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const CREDENTIAL_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

async function api(method, path, body) {
  if (!TOKEN) throw new Error('Falta PORTAL_BRIDGE_TOKEN: crea una consola en Portal IA (Proveedores → Claude Code) y registra el puente con la orden que muestra.');
  const init = { method, headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(30_000) };
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(BASE + path, init); }
  catch (e) { throw new Error(`No se pudo contactar con Portal IA en ${BASE}: ${e?.message ?? e}. ¿Está en marcha?`); }
  const text = await res.text(); let json = null;
  try { json = JSON.parse(text); } catch { /* no es JSON */ }
  if (!res.ok) throw new Error(json?.error || `El Portal respondió ${res.status}.`);
  return json;
}

const enc = encodeURIComponent;
const taskArg = { task_id: { type: 'string', description: 'Identificador de la tarea (de portal_list_tasks).' } };
const jobOnlyCurrent = a => (MODE === 'job' ? 'current' : String(a?.task_id ?? ''));

const TOOLS = [
  { name: 'portal_whoami', worker: true, readOnly: true, description: 'Muestra a qué empresa y a qué agentes del Portal representa esta consola.', inputSchema: { type: 'object', properties: {} },
    run: () => api('POST', '/api/bridge/v1/hello', { client: clientInfo() }) },
  { name: 'portal_list_tasks', worker: true, readOnly: true, description: 'Lista las tareas autorizadas pendientes para los agentes de esta consola.', inputSchema: { type: 'object', properties: {} },
    run: () => api('GET', '/api/bridge/v1/tasks') },
  { name: 'portal_claim_task', worker: true, readOnly: false, description: 'Toma una tarea para atenderla y devuelve el encargo completo del agente (instrucciones, petición y formato esperado).', inputSchema: { type: 'object', properties: taskArg, required: ['task_id'] },
    run: a => api('POST', `/api/bridge/v1/tasks/${enc(a.task_id)}/claim`, {}) },
  { name: 'portal_task_context', worker: false, readOnly: true, description: 'Contexto autorizado de la tarea: empresa, proyecto, identidad y responsabilidades del agente.', inputSchema: { type: 'object', properties: MODE === 'job' ? {} : taskArg, required: MODE === 'job' ? [] : ['task_id'] },
    run: a => api('GET', `/api/bridge/v1/tasks/${enc(jobOnlyCurrent(a))}`) },
  { name: 'portal_list_files', worker: false, readOnly: true, description: 'Lista archivos de la carpeta de trabajo de la tarea (solo lectura; rutas protegidas excluidas).', inputSchema: { type: 'object', properties: { ...(MODE === 'job' ? {} : taskArg), dir: { type: 'string', description: 'Subcarpeta relativa (opcional).' } }, required: MODE === 'job' ? [] : ['task_id'] },
    run: a => api('GET', `/api/bridge/v1/tasks/${enc(jobOnlyCurrent(a))}/files?dir=${enc(a?.dir ?? '')}`) },
  { name: 'portal_read_file', worker: false, readOnly: true, description: 'Lee un archivo de la carpeta de trabajo de la tarea (solo lectura; sin .env, claves, .git ni node_modules).', inputSchema: { type: 'object', properties: { ...(MODE === 'job' ? {} : taskArg), path: { type: 'string', description: 'Ruta relativa del archivo.' } }, required: MODE === 'job' ? ['path'] : ['task_id', 'path'] },
    run: a => api('GET', `/api/bridge/v1/tasks/${enc(jobOnlyCurrent(a))}/file?path=${enc(a?.path ?? '')}`) },
  { name: 'portal_search', worker: false, readOnly: true, description: 'Busca un texto LITERAL en los archivos de la carpeta de trabajo de la tarea (solo lectura; rutas protegidas, binarios y archivos con secretos se omiten). Devuelve ruta, línea y texto (el código antes que pruebas y documentación; como mucho 20 líneas por archivo, con el total por archivo). Si se recorta, acota con «dir» o una consulta más concreta.', inputSchema: { type: 'object', properties: { ...(MODE === 'job' ? {} : taskArg), query: { type: 'string', description: 'Texto a buscar (2–200 caracteres, literal).' }, dir: { type: 'string', description: 'Subcarpeta relativa (opcional).' }, case_sensitive: { type: 'boolean' } }, required: MODE === 'job' ? ['query'] : ['task_id', 'query'] },
    run: a => api('GET', `/api/bridge/v1/tasks/${enc(jobOnlyCurrent(a))}/search?q=${enc(typeof a?.query === 'string' ? a.query : '')}&dir=${enc(typeof a?.dir === 'string' ? a.dir : '')}&case=${a?.case_sensitive === true ? '1' : '0'}`) },
  { name: 'portal_diff', worker: false, readOnly: true, description: 'Cambios de la carpeta de trabajo de la tarea (solo lectura): «working» = sin confirmar (incluidos archivos nuevos); «branch» = lo que la rama añade sobre la base del proyecto. Rutas protegidas y diferencias con secretos se omiten.', inputSchema: { type: 'object', properties: { ...(MODE === 'job' ? {} : taskArg), range: { type: 'string', enum: ['working', 'branch'] } }, required: MODE === 'job' ? [] : ['task_id'] },
    run: a => api('GET', `/api/bridge/v1/tasks/${enc(jobOnlyCurrent(a))}/diff?range=${a?.range === 'branch' ? 'branch' : 'working'}`) },
  { name: 'portal_knowledge', worker: false, readOnly: true, description: 'Conocimiento aprobado del proyecto de la tarea.', inputSchema: { type: 'object', properties: MODE === 'job' ? {} : taskArg, required: MODE === 'job' ? [] : ['task_id'] },
    run: a => api('GET', `/api/bridge/v1/tasks/${enc(jobOnlyCurrent(a))}/knowledge`) },
  { name: 'portal_report_progress', worker: false, readOnly: false, description: 'Informa al Portal del avance de la tarea (se muestra en el proceso).', inputSchema: { type: 'object', properties: { ...(MODE === 'job' ? {} : taskArg), message: { type: 'string' } }, required: MODE === 'job' ? ['message'] : ['task_id', 'message'] },
    run: a => api('POST', `/api/bridge/v1/tasks/${enc(jobOnlyCurrent(a))}/progress`, { message: String(a?.message ?? '') }) },
  { name: 'portal_submit_result', worker: true, readOnly: false, description: 'Entrega el resultado de la tarea en el formato que pide su encargo (implementación propuesta, veredicto de revisión, plan…). El Portal lo valida, lo aplica en el worktree aislado y lo verifica.', inputSchema: { type: 'object', properties: { ...taskArg, text: { type: 'string', description: 'Respuesta completa del agente.' } }, required: ['task_id', 'text'] },
    run: a => api('POST', `/api/bridge/v1/tasks/${enc(a.task_id)}/result`, { text: String(a?.text ?? '') }) },
  { name: 'portal_report_blocker', worker: true, readOnly: false, description: 'Declara que la tarea no se puede completar y por qué (el proceso se pausa para el propietario).', inputSchema: { type: 'object', properties: { ...taskArg, reason: { type: 'string' } }, required: ['task_id', 'reason'] },
    run: a => api('POST', `/api/bridge/v1/tasks/${enc(a.task_id)}/blocker`, { reason: String(a?.reason ?? '') }) }
].filter(t => MODE === 'worker' || !t.worker);

const INSTRUCTIONS = MODE === 'job'
  ? 'Herramientas de solo lectura del Portal para la tarea en curso. No escriben archivos ni ejecutan órdenes.'
  : 'Puente con Portal IA. Flujo: portal_list_tasks → portal_claim_task → (portal_read_file, portal_knowledge, portal_report_progress) → portal_submit_result con la respuesta en el formato pedido, o portal_report_blocker. Actúas como el agente del Portal que indica la tarea. El Portal valida y aplica los cambios en su worktree aislado: no edites el repositorio directamente para una tarea del Portal.';

function clientInfo() {
  return { version: VERSION, envCredentials: CREDENTIAL_VARS.filter(k => (process.env[k] ?? '').trim() !== '') };
}

const out = msg => process.stdout.write(`${JSON.stringify(msg)}\n`);

async function handle(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    if (msg && msg.id !== undefined) out({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32600, message: 'Petición no válida' } });
    return;
  }
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    if (method === 'initialize') {
      const wanted = params?.protocolVersion;
      return out({ jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOLS.includes(wanted) ? wanted : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'portal-ia', version: VERSION }, instructions: INSTRUCTIONS } });
    }
    if (method === 'ping') return isRequest ? out({ jsonrpc: '2.0', id, result: {} }) : undefined;
    if (method === 'tools/list') {
      return out({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: t.readOnly, destructiveHint: false, openWorldHint: false } })) } });
    }
    if (method === 'tools/call') {
      const tool = TOOLS.find(t => t.name === params?.name);
      if (!tool) return out({ jsonrpc: '2.0', id, error: { code: -32602, message: `Herramienta desconocida: ${params?.name}` } });
      try {
        const r = await tool.run(params?.arguments ?? {});
        // JSON compacto: la sangría solo gastaba contexto (y turnos) del modelo.
        return out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(r) }], isError: false } });
      } catch (e) {
        return out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e?.message ?? e}` }], isError: true } });
      }
    }
    if (method.startsWith('notifications/')) return;
    if (isRequest) out({ jsonrpc: '2.0', id, error: { code: -32601, message: `Método no soportado: ${method}` } });
  } catch (e) {
    if (isRequest) out({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e?.message ?? e) } });
  }
}

// Presencia de la consola: latido cada 15 s mientras Claude Code mantiene vivo el puente.
let beat = null;
if (MODE === 'worker' && TOKEN) {
  api('POST', '/api/bridge/v1/hello', { client: clientInfo() }).catch(e => process.stderr.write(`[portal-ia] ${e.message}\n`));
  beat = setInterval(() => { api('POST', '/api/bridge/v1/heartbeat', {}).catch(() => { /* el Portal puede estar reiniciándose */ }); }, 15_000);
}

const pending = new Set();
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON no válido' } }); return; }
  for (const m of Array.isArray(msg) ? msg : [msg]) { const p = handle(m); pending.add(p); p.finally(() => pending.delete(p)); }
});
rl.on('close', async () => {
  if (beat) clearInterval(beat);
  await Promise.allSettled([...pending]);
  if (MODE === 'worker' && TOKEN) { try { await api('POST', '/api/bridge/v1/bye', {}); } catch { /* sin Portal */ } }
  process.exit(0);
});
