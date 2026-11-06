import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as D from '@portal-ia/domain';

/**
 * EN-010 · Exportar agentes externos: rutas del sistema frente a rutas privadas en los scripts, con la línea que bloquea.
 * Pruebas sobre las funciones puras de packages/domain (findLocalPaths, buildExternalBundle, validatePortableBundle).
 * Están aquí porque packages/domain no tiene un runner propio: el runner node --test vive en apps/server.
 *  - Un .py con C:\Windows\Fonts, C:\Program Files\LibreOffice, /usr/bin o /usr/share/fonts no genera problemas, y GUIA.md
 *    las lista en «Requisitos de la plataforma».
 *  - Bloquean, con la línea y el fragmento: el perfil del usuario, la carpeta original del agente, data/workspaces y la carpeta de
 *    datos del Portal. También bloquean, con la línea: los UUID, las rutas /api/ y las tablas internas. Los secretos siguen bloqueando.
 *  - Un «data/» genérico no bloquea. Los .py salen idénticos byte a byte (CRLF, tabulaciones, espacios finales).
 *  - El mensaje dice «Línea N» y sugiere pedírselo al agente en su chat (automejora con copia y Deshacer).
 */
const OPTS = { agentName: 'PDF Word Fiel', exportedAt: '2026-11-05T10:00:00.000Z', provenPlans: [] };
const BASE: Record<string, string> = { 'AGENTS.md': '# PDF Word Fiel\n\nConvierto PDF a Word editable.\n', 'skills/pdf/SKILL.md': '---\nname: pdf\ndescription: Convierte PDF a Word.\n---\n\n# pdf\n', 'skills/pdf/scripts/ok.py': 'print(1)\n' };
// Construido al ejecutarse: escrito tal cual, el puente del Portal omitiría este archivo.
const SECRET = 'sk-' + 'ant-api03-' + 'Q1w2E3r4'.repeat(6);
const SOURCE = String.raw`D:\Agentes\pdf-word-fiel`;
const DATA_DIR = String.raw`E:\PortalIA\datos`;
const PRIVATE: D.PrivatePath[] = [{ path: SOURCE, kind: 'source' }, { path: DATA_DIR, kind: 'portal-data' }];

/** Script con CRLF, tabulaciones y espacios finales que solo cita rutas genéricas del sistema y un «data/» genérico. */
const SYS_PY = [
  '# -*- coding: utf-8 -*-',
  String.raw`FUENTES = "C:\\Windows\\Fonts"`,
  String.raw`SOFFICE = r"C:\Program Files\LibreOffice\program\soffice.exe"`,
  'LINUX = "/usr/bin/soffice"',
  'FONTS = "/usr/share/fonts"   ',
  "\tsalida = os.path.join('data/', nombre)",
  'META = "metadata/x.json"\t',
  ''
].join('\r\n');
const SYS_PATH = 'skills/pdf/scripts/sistema.py';

/** La línea 3 es la que bloquea; las demás son inocuas. */
const at3 = (line: string) => ['import sys', 'import os', line, 'print("listo")', ''].join('\r\n');
const KINDS: { file: string; line: string; snippet: string; label: string }[] = [
  { file: 'perfil.py', line: String.raw`ENTRADA = r"C:\Users\yair\Desktop\x.pdf"`, snippet: String.raw`C:\Users\yair\Desktop\x.pdf`, label: 'tu perfil de usuario' },
  { file: 'home.py', line: 'DESTINO = "/home/ana/x"', snippet: '/home/ana/x', label: 'tu perfil de usuario' },
  { file: 'origen.py', line: String.raw`BASE = r"D:\Agentes\pdf-word-fiel\skills\x.py"`, snippet: String.raw`D:\Agentes\pdf-word-fiel\skills\x.py`, label: 'la carpeta original del agente' },
  { file: 'datos.py', line: 'DB = "data/workspaces/foo"', snippet: 'data/workspaces/foo', label: 'los datos del Portal' },
  { file: 'datadir.py', line: String.raw`X = r"E:\PortalIA\datos\evidence\a.json"`, snippet: String.raw`E:\PortalIA\datos\evidence\a.json`, label: 'los datos del Portal' }
];
const INTERNAL: { file: string; line: string; re: RegExp; line3: boolean }[] = [
  { file: 'uuid.py', line: 'ID = "123e4567-e89b-12d3-a456-426614174000"', re: /UUID/, line3: true },
  { file: 'api.py', line: 'URL = "/api/agents/x"', re: /rutas o tablas internas/, line3: true },
  { file: 'tablas.py', line: 'T = "agent_revisions"', re: /rutas o tablas internas/, line3: true },
  { file: 'clave.py', line: `KEY = "${SECRET}"`, re: /parece/, line3: false }
];
const scriptPath = (f: string) => `skills/pdf/scripts/${f}`;

test('findLocalPaths clasifica cada ruta con su línea', () => {
  const text = ['a = 1', String.raw`f = "C:\\Windows\\Fonts"`, 'h = "/home/ana/x"', String.raw`o = r"D:\otra\x.txt"`, 'd = "data/evidence/e.json"', "g = os.path.join('data/', x)", String.raw`s = r"D:\Agentes\pdf-word-fiel\a.py"`].join('\r\n');
  const hits = D.findLocalPaths(text, { privatePaths: PRIVATE }).map(h => [h.line, h.kind]);
  assert.deepEqual(hits, [[2, 'system'], [3, 'profile'], [4, 'other'], [5, 'portal-data'], [7, 'source']]);
  assert.deepEqual(D.findLocalPaths('x = "metadata/a"\ny = "./data/input.csv"\n'), [], '«data/» genérico no es una ruta del Portal');
});

test('rutas del sistema en un .py: no bloquean, el script sale byte a byte y GUIA.md las menciona', () => {
  const b = D.buildExternalBundle({ ...BASE, [SYS_PATH]: SYS_PY }, OPTS);
  assert.strictEqual(b[SYS_PATH], SYS_PY, 'el script sale idéntico (CRLF, tabulaciones y espacios finales)');
  assert.ok(Buffer.from(b[SYS_PATH]!, 'utf8').equals(Buffer.from(SYS_PY, 'utf8')), 'idéntico byte a byte');
  const problems = D.validatePortableBundle(b, { limits: D.EXTERNAL_BUNDLE_LIMITS, privatePaths: PRIVATE });
  assert.deepEqual(problems, [], JSON.stringify(problems));
  const g = b['GUIA.md']!;
  const req = g.split('## Requisitos de la plataforma')[1]?.split('\n## ')[0] ?? '';
  assert.ok(req, 'GUIA.md tiene «Requisitos de la plataforma»');
  for (const p of [String.raw`C:\Windows\Fonts`, String.raw`C:\Program Files\LibreOffice`, '/usr/bin/soffice', '/usr/share/fonts'])
    assert.ok(req.includes(p), `GUIA.md › Requisitos de la plataforma menciona ${p}:\n${req}`);
  assert.match(req, /Windows/); assert.match(req, /Linux y macOS/);
});

test('rutas privadas: bloquean con la línea, el fragmento y la sugerencia de pedirlo en el chat', () => {
  const snap: Record<string, string> = { ...BASE };
  for (const k of KINDS) snap[scriptPath(k.file)] = at3(k.line);
  const b = D.buildExternalBundle(snap, OPTS);
  const problems = D.validatePortableBundle(b, { limits: D.EXTERNAL_BUNDLE_LIMITS, privatePaths: PRIVATE });
  for (const k of KINDS) {
    const p = scriptPath(k.file);
    assert.strictEqual(b[p], snap[p], `${p}: se copia tal cual`);
    const pr = problems.filter(x => x.path === p);
    assert.equal(pr.length, 1, `${p}: ${JSON.stringify(problems)}`);
    assert.equal(pr[0]!.line, 3, `${p}: línea`);
    assert.equal(pr[0]!.snippet, k.snippet, `${p}: fragmento`);
    assert.ok(pr[0]!.message.includes('Línea 3'), pr[0]!.message);
    assert.ok(pr[0]!.message.includes(k.snippet), pr[0]!.message);
    assert.ok(pr[0]!.message.includes(k.label), `${p}: ${pr[0]!.message}`);
    assert.match(pr[0]!.hint ?? '', /chat/); assert.match(pr[0]!.hint ?? '', /línea 3/); assert.match(pr[0]!.hint ?? '', /Deshacer/);
  }
});

test('UUID, /api/, tablas internas y secretos siguen bloqueando (con la línea cuando aplica)', () => {
  const snap: Record<string, string> = { ...BASE };
  for (const k of INTERNAL) snap[scriptPath(k.file)] = at3(k.line);
  const b = D.buildExternalBundle(snap, OPTS);
  const problems = D.validatePortableBundle(b, { limits: D.EXTERNAL_BUNDLE_LIMITS, privatePaths: PRIVATE });
  for (const k of INTERNAL) {
    const p = scriptPath(k.file);
    const pr = problems.find(x => x.path === p && k.re.test(x.message));
    assert.ok(pr, `${p}: ${JSON.stringify(problems)}`);
    if (k.line3) assert.equal(pr!.line, 3, `${p}: línea`);
  }
  assert.ok(!JSON.stringify(problems).includes(SECRET), 'el motivo no repite el secreto');
});

test('fuera de los scripts, una ruta de unidad del sistema sigue bloqueando (AGENTS.md)', () => {
  const clean = D.buildExternalBundle(BASE, OPTS);
  assert.deepEqual(D.validatePortableBundle(clean, { limits: D.EXTERNAL_BUNDLE_LIMITS, privatePaths: PRIVATE }), []);
  const agents = `${clean['AGENTS.md']!}Fuentes en C:\\Windows\\Fonts\n`;
  const line = agents.split('\n').findIndex(l => l.includes('Fonts')) + 1;
  const problems = D.validatePortableBundle({ ...clean, 'AGENTS.md': agents }, { limits: D.EXTERNAL_BUNDLE_LIMITS });
  const pr = problems.find(x => x.path === 'AGENTS.md' && x.line === line);
  assert.ok(pr, JSON.stringify(problems));
  assert.equal(pr!.snippet, String.raw`C:\Windows\Fonts`);
});

test('«data/» genérico se conserva en los documentos y data/workspaces se limpia', () => {
  const b = D.buildExternalBundle({ ...BASE, 'AGENTS.md': '# X\n\nGuarda en data/salida.csv y nunca en data/workspaces/x.\n' }, OPTS);
  assert.ok(b['AGENTS.md']!.includes('data/salida.csv'), b['AGENTS.md']);
  assert.ok(!b['AGENTS.md']!.includes('data/workspaces'), b['AGENTS.md']);
  assert.deepEqual(D.validatePortableBundle(b, { limits: D.EXTERNAL_BUNDLE_LIMITS }), []);
});
