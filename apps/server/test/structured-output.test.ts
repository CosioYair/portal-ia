import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Salida estructurada nativa en los adaptadores reales (sin red: `fetch` sustituido en la prueba). Comprueba la forma
 * exacta de la petición, la lectura de la respuesta y la vuelta atrás de UNA vez si el proveedor rechaza el parámetro.
 */
const { anthropicAdapter, openaiAdapter } = await import('@portal-ia/ai-adapters');
const schema = { name: 'veredicto_qa', schema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false } };
const base = { model: 'm', system: 's', user: 'u', maxTokens: 100, effort: 'low' as const, supportsEffort: false };

function stubFetch(responses: { status: number; body: any }[]) {
  const sent: any[] = []; const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => { sent.push(JSON.parse(init.body)); const r = responses.shift()!; return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } }); }) as any;
  return { sent, restore: () => { globalThis.fetch = orig; } };
}

test('Anthropic: fuerza la herramienta con el esquema y devuelve su entrada como JSON', async () => {
  const f = stubFetch([{ status: 200, body: { content: [{ type: 'tool_use', id: 't1', name: 'veredicto_qa', input: { verdict: 'approved' } }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'tool_use' } }]);
  try {
    const r = await anthropicAdapter.complete('k', undefined, { ...base, responseSchema: schema });
    assert.deepEqual(f.sent[0].tools, [{ name: 'veredicto_qa', description: 'Devuelve el resultado estructurado.', input_schema: schema.schema }]);
    assert.deepEqual(f.sent[0].tool_choice, { type: 'tool', name: 'veredicto_qa' });
    assert.equal(r.text, '{"verdict":"approved"}'); assert.equal(r.outputTokens, 5);
  } finally { f.restore(); }
});

test('Anthropic: con razonamiento extendido no fuerza herramienta (incompatible); el JSON va en el texto', async () => {
  const f = stubFetch([{ status: 200, body: { content: [{ type: 'text', text: '{"verdict":"rejected"}' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' } }]);
  try {
    const r = await anthropicAdapter.complete('k', undefined, { ...base, effort: 'high', supportsEffort: true, responseSchema: schema });
    assert.equal(f.sent[0].tools, undefined); assert.ok(f.sent[0].thinking); assert.equal(r.text, '{"verdict":"rejected"}');
  } finally { f.restore(); }
});

test('OpenAI: response_format json_schema estricto; si el modelo no lo admite (400), repite UNA vez sin él', async () => {
  const ok = stubFetch([{ status: 200, body: { choices: [{ message: { content: '{"verdict":"approved"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } } }]);
  try {
    const r = await openaiAdapter.complete('k', undefined, { ...base, responseSchema: schema });
    assert.deepEqual(ok.sent[0].response_format, { type: 'json_schema', json_schema: { name: 'veredicto_qa', schema: schema.schema, strict: true } });
    assert.equal(r.text, '{"verdict":"approved"}');
  } finally { ok.restore(); }
  const fb = stubFetch([{ status: 400, body: { error: { message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model." } } }, { status: 200, body: { choices: [{ message: { content: '{"verdict":"rejected"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } } }]);
  try {
    const r = await openaiAdapter.complete('k', undefined, { ...base, responseSchema: schema });
    assert.equal(fb.sent.length, 2); assert.equal(fb.sent[1].response_format, undefined); assert.equal(r.text, '{"verdict":"rejected"}');
  } finally { fb.restore(); }
});

test('sin esquema: las peticiones no cambian (compatibilidad)', async () => {
  const a = stubFetch([{ status: 200, body: { content: [{ type: 'text', text: 'hola' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' } }]);
  try { await anthropicAdapter.complete('k', undefined, base); assert.equal(a.sent[0].tools, undefined); assert.equal(a.sent[0].tool_choice, undefined); } finally { a.restore(); }
  const o = stubFetch([{ status: 200, body: { choices: [{ message: { content: 'hola' }, finish_reason: 'stop' }], usage: {} } }]);
  try { await openaiAdapter.complete('k', undefined, base); assert.equal(o.sent[0].response_format, undefined); } finally { o.restore(); }
});
