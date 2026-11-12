import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * EN-026 · Lectura del repositorio para el equipo: portal_read_file por rango de líneas (literal, más allá de 200 KB, con
 * las mismas protecciones y el mismo presupuesto) y portal_search con la sangría original. Sin modelo ni servidor.
 */
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en026-'));
process.env.PORTAL_MOCK_PROVIDER = '1';
process.env.LOG_LEVEL = 'warn';
const here = path.dirname(fileURLToPath(import.meta.url));
const { isDenied, readTaskFile, searchTaskFiles, MAX_RANGE_LINES } = await import('../src/services/claudeCode/bridge.ts');

const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-en026-repo-'));
const root = path.join(outer, 'repo');
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.writeFileSync(path.join(outer, 'fuera.txt'), 'fuera de readRoot\n');
const SANGRIA = ['export function f(x: number) {', '  if (x > 0) {', '\t  return x;', '  }', '\treturn  -x;   ', '}'];
fs.writeFileSync(path.join(root, 'src/sangria.ts'), SANGRIA.join('\n') + '\n');
fs.writeFileSync(path.join(root, 'src/crlf.ts'), 'a\r\n  b\r\n');
fs.writeFileSync(path.join(root, 'src/larga.ts'), '    zzlarga' + 'y'.repeat(500) + '\n');
// Archivo de más de 200.000 bytes con una línea marcada (con sangría) más allá de ese punto.
const BIG = Array.from({ length: 5000 }, (_, i) => `fila ${String(i + 1).padStart(5, '0')} ${'x'.repeat(40)}`);
BIG[4499] = '\t    MARCA-LEJANA = 1;';
fs.writeFileSync(path.join(root, 'src/grande.ts'), BIG.join('\n') + '\n');
// Clave falsa construida en tiempo de ejecución (el escáner del parche no debe verla literal).
const KEY = 'sk-' + 'ant-' + 'api03-' + 'A'.repeat(40);
fs.writeFileSync(path.join(root, 'src/secreto-lejano.ts'), BIG.slice(0, 4500).join('\n') + `\nexport const k = '${KEY}';\n`);
fs.writeFileSync(path.join(root, 'src/secreto.ts'), `export const k = '${KEY}';\nexport const b = 2;\n`);
fs.writeFileSync(path.join(root, 'src/bin.dat'), Buffer.from([1, 2, 0, 3, 4]));
fs.writeFileSync(path.join(root, '.env'), 'PORTAL_X=1\n');
fs.mkdirSync(path.join(root, 'node_modules/m'), { recursive: true }); fs.writeFileSync(path.join(root, 'node_modules/m/index.js'), 'x\n');
fs.mkdirSync(path.join(root, '.git'), { recursive: true }); fs.writeFileSync(path.join(root, '.git/config'), '[core]\n');

const task = (extra: Record<string, unknown> = {}): any => ({ readRoot: root, ...extra });
const read = (t: any, rel: string, startLine?: number, endLine?: number): any => readTaskFile(t, rel, startLine === undefined && endLine === undefined ? undefined : { startLine, endLine });

test('EN-026.1 · rango exacto: solo esas líneas, literales (espacios y tabuladores) y con totalLines', () => {
  const r = read(task(), 'src/sangria.ts', 2, 5);
  assert.ok(!isDenied(r), JSON.stringify(r));
  assert.equal(r.path, 'src/sangria.ts');
  assert.equal(r.startLine, 2); assert.equal(r.endLine, 5); assert.equal(r.totalLines, 6); assert.equal(r.limited, false);
  assert.equal(r.content, SANGRIA.slice(1, 5).join('\n'));
  assert.ok(r.content.includes('\t  return x;') && r.content.endsWith('\treturn  -x;   '), 'sin trim');
  const c = read(task(), 'src/crlf.ts', 2, 2);
  assert.equal(c.content, '  b'); assert.equal(c.totalLines, 2); assert.equal(c.eol, 'crlf');
});

test('EN-026.2 · una línea más allá de los primeros 200.000 bytes se lee por rango', () => {
  assert.ok(Buffer.byteLength(BIG.slice(0, 4499).join('\n')) > 200_000, 'la línea marcada está más allá de 200 KB');
  const r = read(task(), 'src/grande.ts', 4500, 4500);
  assert.ok(!isDenied(r), JSON.stringify(r));
  assert.equal(r.content, '\t    MARCA-LEJANA = 1;'); assert.equal(r.totalLines, 5000);
});

test('EN-026.3 · sin rango, la respuesta es la de siempre ({ path, content, truncated } hasta MAX_FILE)', () => {
  const r = read(task(), 'src/grande.ts');
  assert.deepEqual(Object.keys(r).sort(), ['content', 'path', 'truncated']);
  assert.equal(r.truncated, true); assert.equal(r.content.length, 200_000);
  const s = read(task(), 'src/sangria.ts');
  assert.deepEqual(s, { path: 'src/sangria.ts', content: SANGRIA.join('\n') + '\n', truncated: false });
});

test('EN-026.4 · rango invertido o fuera del archivo: 416 con totalLines', () => {
  for (const [a, b] of [[5, 2], [7, undefined], [1, 99]] as const) {
    const r = read(task(), 'src/sangria.ts', a, b);
    assert.ok(isDenied(r), `${a}-${b}`); assert.equal(r.status, 416);
    assert.match(r.error, /totalLines 6/); assert.match(r.error, /6 líneas/);
  }
});

test('EN-026.5 · como mucho 400 líneas por llamada, con limited y nextStartLine', () => {
  assert.equal(MAX_RANGE_LINES, 400);
  const r = read(task(), 'src/grande.ts', 1, 1000);
  assert.equal(r.limited, true); assert.equal(r.endLine, 400); assert.equal(r.nextStartLine, 401);
  assert.equal(r.content.split('\n').length, 400); assert.match(r.note, /400 líneas/);
  const s = read(task(), 'src/grande.ts', 4801);
  assert.equal(s.endLine, 5000); assert.equal(s.limited, false); assert.equal(s.nextStartLine, undefined);
});

test('EN-026.6 · protecciones iguales con o sin rango: rutas protegidas, binario, secreto y readRoot', () => {
  for (const rel of ['.env', '.git/config', 'node_modules/m/index.js', '../fuera.txt']) {
    const a = read(task(), rel); const b = read(task(), rel, 1, 1);
    assert.ok(isDenied(a) && isDenied(b), rel); assert.equal(b.status, a.status, rel); assert.ok(b.status >= 400 && b.status !== 416, rel);
  }
  assert.equal(read(task(), 'src/bin.dat', 1, 1).status, 415); assert.equal(read(task(), 'src/bin.dat').status, 415);
  const s = read(task(), 'src/secreto.ts', 2, 2);
  assert.equal(s.status, 403, 'la línea pedida no tiene el secreto, pero el archivo sí'); assert.doesNotMatch(s.error, /AAAA/);
  assert.equal(read(task(), 'src/secreto.ts').status, 403);
  // Sin rango solo se leen los primeros 200 KB (diferencia aceptada); con rango se escanea el archivo entero.
  assert.equal(read(task(), 'src/secreto-lejano.ts', 1, 1).status, 403);
});

test('EN-026.7 · cada lectura con rango gasta presupuesto y queda en uses con la ruta y el rango', () => {
  const t = task({ toolBudget: 2 });
  assert.ok(!isDenied(read(t, './src/sangria.ts', 2, 3)));
  assert.ok(isDenied(read(t, '.env', 1, 1)), 'denegada, pero gasta');
  const over = read(t, 'src/sangria.ts', 1, 1);
  assert.equal(over.status, 429); assert.match(over.error, /presupuesto de herramientas agotado/i);
  assert.deepEqual(t.uses.map((u: any) => [u.tool, u.arg, u.ok, u.range]), [['portal_read_file', 'src/sangria.ts', true, '2-3'], ['portal_read_file', '.env', false, undefined]]);
});

test('EN-026.8 · portal_search devuelve cada línea con su sangría original, recortada a 300 caracteres', () => {
  const r: any = searchTaskFiles(task(), 'return x;');
  assert.ok(!isDenied(r), JSON.stringify(r));
  assert.deepEqual(r.matches.find((m: any) => m.path === 'src/sangria.ts'), { path: 'src/sangria.ts', line: 3, text: '\t  return x;' });
  const l: any = searchTaskFiles(task(), 'zzlarga');
  const m = l.matches.find((x: any) => x.path === 'src/larga.ts');
  assert.ok(m.text.startsWith('    zzlarga')); assert.equal(m.text.length, 300);
});

test('EN-026.9 · los textos de las herramientas mencionan el rango de líneas', () => {
  const mcp = fs.readFileSync(path.join(here, '../../../scripts/portal-mcp.mjs'), 'utf8');
  const block = mcp.slice(mcp.indexOf("name: 'portal_read_file'"), mcp.indexOf("name: 'portal_search'"));
  assert.match(block, /startLine: \{ type: 'integer', minimum: 1/); assert.match(block, /endLine: \{ type: 'integer', minimum: 1/);
  assert.match(block, /[Rr]ango opcional de líneas/); assert.match(block, /400 líneas/);
  const be = fs.readFileSync(path.join(here, '../src/services/claudeCode/backend.ts'), 'utf8');
  assert.match(be, /portal_read_file admite un rango de líneas/); assert.match(be, /startLine y endLine/);
});
