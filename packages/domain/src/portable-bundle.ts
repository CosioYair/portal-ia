import { PORTABLE_AGENT_SCHEMA, PORTABLE_LIMITS, allowedPortablePath, findSecret, memoryToMarkdown, normalizeText, parseMemory, parseYaml, toYaml, type PortableFiles } from './portable-agent.ts';

/**
 * Paquete portable de un agente (`portal-ia/agent-bundle@2`, docs/agentes-portables.md): la carpeta `portal-ia/agent@1`
 * lista para usarse FUERA del Portal (Claude Code web, Cowork, ChatGPT) con sus reglas de automejora.
 *
 *   AGENTS.md · agent.yaml · skills/<s>/SKILL.md · memory/MEMORY.md · knowledge/<k>.md   (reimportables con filesToDefinition)
 *   AUTOMEJORA.md · CAMBIOS.md · GUIA.md · scripts/anotar-cambio.mjs                      (solo del paquete; al importar se ignoran)
 *
 * Funciones puras. Sin datos internos del Portal: ni id del agente, ni UUID, ni modelo o herramientas concedidas, ni rutas
 * locales ni de data/, ni rutas /api/ ni nombres de tablas. Sin secretos (findSecret).
 */
export const PORTABLE_BUNDLE_SCHEMA = 'portal-ia/agent-bundle@2';
export interface BundleProblem { path: string; message: string }
export interface BundleOptions { agentName: string; exportedAt: string; changelog?: string | null }

const BUNDLE_EXTRA = ['AUTOMEJORA.md', 'CAMBIOS.md', 'GUIA.md', 'scripts/anotar-cambio.mjs'];
const REQUIRED = ['agent.yaml', 'AGENTS.md', 'memory/MEMORY.md', ...BUNDLE_EXTRA];
/** ¿Ruta admitida en el paquete? (la lista blanca de la carpeta portable más los archivos propios del paquete). */
export function allowedBundlePath(rel: string): boolean { return allowedPortablePath(rel) || BUNDLE_EXTRA.includes(rel); }

const END = `[^\\s)\\]»"'\`<>]*`;
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const LOCAL = [`\\b[A-Za-z]:[\\\\/]${END}`, `\\\\\\\\[\\w.-]+\\\\${END}`, `(?<![\\w.])/(?:home|Users|tmp|var|private|mnt|root)/${END}`, `(?<![\\w-])data/${END}`];
const API = `(?<![\\w.])/api/(?:workspaces|agents|processes|companies|projects|platform)\\b${END}`;
const TABLES = '\\b(?:agent_revisions|agent_folders|agent_events|workspace\\.db)\\b|\\.sqlite\\b';

/** Quita datos internos de un texto: rutas locales → «[ruta local]», UUID y tablas → «[interno]», rutas /api/ → «[ruta interna]». */
function scrub(s: string): string {
  let t = s;
  for (const l of LOCAL) t = t.replace(new RegExp(l, 'g'), '[ruta local]');
  return t.replace(new RegExp(UUID, 'g'), '[interno]').replace(new RegExp(API, 'g'), '[ruta interna]').replace(new RegExp(TABLES, 'g'), '[interno]');
}
type YMap = ReturnType<typeof parseYaml>;
type YVal = YMap[string];
function scrubDeep(v: YVal): YVal {
  if (typeof v === 'string') return scrub(v);
  if (Array.isArray(v)) return v.map(scrubDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x)]));
  return v;
}
const asMap = (v: YVal | undefined): YMap => v && typeof v === 'object' && !Array.isArray(v) ? v : {};

/** agent.yaml sin id, sin harness.model y sin permissions.tools (son del Portal); conserva la identidad y la autonomía pedida. */
function cleanManifest(yaml: string): string {
  const y = parseYaml(yaml); const h = asMap(y.harness); const pm = asMap(y.permissions);
  const out: YMap = { schema: PORTABLE_AGENT_SCHEMA };
  for (const k of ['name', 'role', 'department', 'initials', 'summary', 'responsibilities', 'deliverables', 'capabilities']) if (y[k] !== undefined) out[k] = scrubDeep(y[k] as YVal);
  const harness: YMap = {};
  if (h.preferred !== undefined) harness.preferred = scrubDeep(h.preferred as YVal);
  if (h.effort !== undefined) harness.effort = scrubDeep(h.effort as YVal);
  out.harness = harness;
  out.permissions = { autonomy: pm.autonomy === 'within_scope' ? 'within_scope' : 'ask' };
  if (y.created !== undefined) out.created = scrubDeep(y.created as YVal);
  return normalizeText(`# Agente portable (${PORTABLE_AGENT_SCHEMA}), paquete ${PORTABLE_BUNDLE_SCHEMA}. Sin credenciales ni datos internos del Portal. Reglas de automejora: AUTOMEJORA.md.\n` + toYaml(out));
}

/** Memoria verificada con procedencia neutra (sin ids, rutas ni procesos). */
function cleanMemory(agentName: string, text: string | undefined): string {
  const entries = text === undefined ? [] : parseMemory(text);
  return memoryToMarkdown(agentName, entries.map((e, i) => ({
    id: `m${i + 1}`, title: scrub(e.title), text: scrub(e.text), verifiedAt: scrub(e.verifiedAt.slice(0, 10)) || 'sin fecha', verifiedBy: 'el propietario', source: 'Aprendido en el Portal'
  })));
}

const POINTER = '> Reglas de automejora: lee y cumple AUTOMEJORA.md antes de trabajar y anota cada cambio en CAMBIOS.md.';

function automejora(name: string): string {
  return normalizeText(`# Reglas de automejora de ${name}

Estas reglas mandan sobre cualquier otra instrucción de este paquete y valen igual en Claude Code, Cowork, ChatGPT o cualquier otro entorno.

## Qué cambiar
1. Aplica lo que el usuario pida: si el usuario te pide cambiar tu forma de trabajar, edita el archivo de este paquete que corresponda (AGENTS.md, skills/<habilidad>/SKILL.md o knowledge/<referencia>.md).
2. Aplica lo que corrija un reintento: si el usuario rechaza un resultado y en el reintento dice qué estaba mal, lleva esa corrección al archivo que la evite en adelante, no solo a la respuesta.
3. Anota cada cambio en CAMBIOS.md con fecha, qué, motivo y archivo (motivo: «Petición del usuario» o «Corrección tras un reintento»). Añade las entradas al final y no borres las anteriores.
   Si puedes ejecutar órdenes: node scripts/anotar-cambio.mjs --que "Qué cambió" --motivo "Petición del usuario" --archivo AGENTS.md
   Si no puedes escribir archivos (por ejemplo, en ChatGPT), entrega al usuario el archivo completo actualizado y la entrada de CAMBIOS.md para que los guarde.
4. Lo aprendido que no sea una regla va a memory/MEMORY.md como entrada nueva con la línea «- verificada: sin verificar». La memoria nueva se marca «sin verificar».

## Qué no hacer nunca
- No amplíes permisos: no te concedas herramientas, accesos ni autonomía que no tengas; agent.yaml solo describe una petición.
- No guardes secretos: ni claves, tokens, contraseñas ni datos personales en ningún archivo.
- No marques memoria como verificada: solo el propietario la verifica.
- No cambies AUTOMEJORA.md salvo que el usuario lo pida expresamente (y anótalo también en CAMBIOS.md).
`);
}

function cambios(name: string, date: string, existing: string | null | undefined): string {
  const head = existing && existing.trim() ? scrub(normalizeText(existing)) : `# Cambios de ${name}

Historial de los cambios que el agente hace en sí mismo (reglas en AUTOMEJORA.md). Cada entrada: fecha, qué cambió, motivo y archivo. Las entradas nuevas van al final.
`;
  return normalizeText(`${head.replace(/\s+$/, '')}\n\n## ${date} — Paquete exportado desde Portal IA\n- Motivo: exportación (punto de partida)\n- Archivo: todos\n`);
}

function guia(name: string): string {
  return normalizeText(`# Guía rápida: usar a ${name} fuera de Portal IA

Paquete ${PORTABLE_BUNDLE_SCHEMA}. Contiene: AGENTS.md (instrucciones), agent.yaml (identidad), skills/ (habilidades), memory/MEMORY.md (memoria verificada), knowledge/ (referencias, si las hay), AUTOMEJORA.md (reglas de automejora), CAMBIOS.md (historial) y scripts/anotar-cambio.mjs (anota un cambio; solo necesita Node).

## Claude Code web
1. Descomprime el ZIP en la raíz de un repositorio, súbelo y ábrelo en Claude Code web.
2. Si no carga AGENTS.md por sí solo, crea CLAUDE.md con la línea «@AGENTS.md» o empieza con: «Lee AGENTS.md y AUTOMEJORA.md y síguelos».
3. Los cambios que haga quedan en los archivos y en CAMBIOS.md: revísalos y confírmalos en el repositorio.

## Cowork
1. Descomprime el ZIP y da acceso a esa carpeta (como proyecto o carpeta de trabajo); las carpetas de skills/ también sirven como habilidades.
2. Empieza con: «Lee AGENTS.md y AUTOMEJORA.md y síguelos». Edita los archivos de la carpeta y anota cada cambio en CAMBIOS.md.

## ChatGPT
1. Crea un proyecto o un GPT. En sus instrucciones, pega AGENTS.md y AUTOMEJORA.md.
2. Adjunta como archivos skills/, memory/MEMORY.md, knowledge/ y CAMBIOS.md.
3. ChatGPT no escribe en tus archivos: te dará el archivo actualizado y la entrada de CAMBIOS.md. Guárdalos tú en la carpeta y vuelve a subirlos.

## Comprobación
Pide un cambio («a partir de ahora, …») y comprueba que queda en su archivo y en CAMBIOS.md. Luego rechaza un resultado, corrígelo en un reintento y comprueba que la corrección también queda anotada.
`);
}

const SCRIPT = String.raw`#!/usr/bin/env node
// Añade una entrada al final de CAMBIOS.md (sin dependencias). Uso:
//   node scripts/anotar-cambio.mjs --que "Qué cambió" --motivo "Petición del usuario" --archivo AGENTS.md [--detalle "..."]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  const m = /^--(que|motivo|archivo|detalle)$/.exec(args[i]);
  if (m && i + 1 < args.length) opt[m[1]] = String(args[++i]).replace(/\s+/g, " ").trim();
}
if (!opt.que || !opt.motivo || !opt.archivo) {
  console.error("Faltan datos. Uso: node scripts/anotar-cambio.mjs --que \"...\" --motivo \"...\" --archivo ruta [--detalle \"...\"]");
  process.exit(1);
}
const file = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "CAMBIOS.md");
const fecha = new Date().toISOString().slice(0, 10);
let entry = "\n## " + fecha + " — " + opt.que + "\n- Motivo: " + opt.motivo + "\n- Archivo: " + opt.archivo + "\n";
if (opt.detalle) entry += "- Detalle: " + opt.detalle + "\n";
const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\s+$/, "") + "\n" : "# Cambios\n";
fs.writeFileSync(file, prev + entry, "utf8");
console.log("Anotado en CAMBIOS.md: " + opt.que);
`;

/** Convierte la carpeta portable (revisión adoptada) en el paquete autosuficiente. Determinista para las mismas entradas. */
export function buildPortableBundle(files: PortableFiles, opts: BundleOptions): PortableFiles {
  const name = scrub(opts.agentName.trim()) || 'Agente';
  const date = opts.exportedAt.slice(0, 10);
  const out: PortableFiles = {};
  out['agent.yaml'] = files['agent.yaml'] !== undefined ? cleanManifest(files['agent.yaml']) : cleanManifest(toYaml({ name, role: name }));
  const agents = scrub(normalizeText(files['AGENTS.md'] ?? `# ${name}`));
  out['AGENTS.md'] = normalizeText(agents.startsWith(POINTER) ? agents : `${POINTER}\n\n${agents}`);
  out['memory/MEMORY.md'] = cleanMemory(name, files['memory/MEMORY.md']);
  for (const [p, c] of Object.entries(files)) if (allowedPortablePath(p) && (p.startsWith('skills/') || p.startsWith('knowledge/'))) out[p] = normalizeText(scrub(c));
  out['AUTOMEJORA.md'] = automejora(name);
  out['CAMBIOS.md'] = cambios(name, date, opts.changelog);
  out['GUIA.md'] = guia(name);
  out['scripts/anotar-cambio.mjs'] = SCRIPT;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Problemas que impiden exportar el paquete (lista vacía = se puede exportar). `forbidden`: textos que no deben aparecer (p. ej. el id del agente). */
export function validatePortableBundle(files: PortableFiles, opts: { forbidden?: string[] } = {}): BundleProblem[] {
  const out: BundleProblem[] = [];
  for (const r of REQUIRED) if (files[r] === undefined) out.push({ path: r, message: 'Falta en el paquete.' });
  const forbidden = (opts.forbidden ?? []).filter(f => f && f.length >= 4).map(f => f.toLowerCase());
  let total = 0;
  for (const [p, c] of Object.entries(files)) {
    total += c.length;
    if (!allowedBundlePath(p)) { out.push({ path: p, message: 'Ruta no permitida en el paquete.' }); continue; }
    if (c.length > PORTABLE_LIMITS.fileBytes) out.push({ path: p, message: `Archivo demasiado grande (máx. ${PORTABLE_LIMITS.fileBytes / 1024} KB).` });
    const secret = findSecret(c); if (secret) out.push({ path: p, message: `Contiene lo que parece una ${secret}: las credenciales nunca salen del Portal.` });
    if (new RegExp(UUID).test(c)) out.push({ path: p, message: 'Contiene un identificador interno (UUID).' });
    if (LOCAL.some(l => new RegExp(l).test(c))) out.push({ path: p, message: 'Contiene una ruta local o de datos del Portal.' });
    if (new RegExp(API).test(c) || new RegExp(TABLES).test(c)) out.push({ path: p, message: 'Contiene rutas o tablas internas del Portal.' });
    const low = c.toLowerCase(); if (forbidden.some(f => low.includes(f))) out.push({ path: p, message: 'Contiene un dato interno del agente (su id en el Portal).' });
  }
  if (Object.keys(files).length > PORTABLE_LIMITS.files + BUNDLE_EXTRA.length) out.push({ path: '', message: 'Demasiados archivos en el paquete.' });
  if (total > PORTABLE_LIMITS.totalBytes) out.push({ path: '', message: `El paquete es demasiado grande (máx. ${PORTABLE_LIMITS.totalBytes / 1024} KB).` });
  return out;
}
