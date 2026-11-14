import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripBundleNotices, CAPABILITIES, PORTABLE_LIMITS, allowedBundlePath, allowedPortablePath, applyMergeResolutions, baseSkillTool, changelogSinceExport, definitionToFiles, filesToDefinition, findSecret, isBaseSkill, lastExportMark, mergePortableFiles, normalizeText, stripZipRoot } from '@portal-ia/domain';
import type { Agent, LessonStatus, PortableFiles, PortableMergeConflict, PortableMergeResult, PortableSkill } from '@portal-ia/domain';
import { listZip, readZipEntry } from './zipFile.ts';
import { agentsRepo } from '../db/workspace.ts';
import { DEFAULT_INSTRUCTIONS_MARK, adoptedExtras, agentFoldersRepo, applyImportedPersonalName, definitionFor, grantedTools, hashFiles, importScopePreview, notAdoptedChanges, restoreRevision, syncAgentFolder, writeImportedRevision, type AgentRevision, type RowPatch } from './agentFolders.ts';
import { importFromFiles, type ImportGrant } from './agentCreation.ts';
import { lessonsRepo } from './lessons.ts';
import { externalSource } from './externalAgents.ts';
import { agentEvents, recordAgentEvent } from './agentEvents.ts';
import { monotonicNow } from '../clock.ts';

/**
 * Importar un agente desde un ZIP (docs/agentes-portables.md).
 * - El ZIP se valida entero ANTES de nada: una entrada con problema (recorrido, ruta absoluta, enlace, cifrado…), una ruta
 *   fuera de la lista blanca, un duplicado, un texto no UTF-8 o algo con aspecto de secreto lo rechazan completo (400).
 * - Agente nuevo (su id no existe en este espacio, o el marcador es de otro espacio): flujo de importación de siempre, con lo
 *   que conceda el propietario (arnés, permisos, departamento).
 * - Agente existente: fusión a tres bandas por archivo (base = revisión exportada, ours = adoptada, theirs = ZIP). Lo que
 *   solo cambió fuera se adopta como revisión 'import' con Deshacer; lo que cambió en ambos lados es un conflicto que decide
 *   el propietario. Arnés, modelo, esfuerzo, herramientas, autonomía, capacidades e id nunca se adoptan.
 * - MEMORY.md no se fusiona como texto: sus entradas nuevas pasan a ser lecciones DETECTADAS del agente, pendientes de tu
 *   verificación (nunca validadas solas; Deshacer las retira). Reimportar el mismo ZIP no las duplica.
 * - EN-011: la vista previa y el resultado traen `learned` («Qué trae y qué aprendió»): habilidades nuevas o cambiadas (las
 *   base solo informativas), memoria nueva y entradas de CAMBIOS.md posteriores a la marca de exportación.
 * Sin llamadas a modelos: ninguna acción tiene costo.
 */
const MEM = 'memory/MEMORY.md';
const CHANGELOG = 'CAMBIOS.md';
/** Marcador opcional de la exportación (exento de la lista blanca, no forma parte de la carpeta). */
export const ZIP_EXPORT_MARKER = 'portal-export.json';
export const ZIP_UPLOAD_MAX = 2 * 1024 * 1024;
const STAGE_TTL_MS = 30 * 60 * 1000;
const STAGE_MAX = 20;

const fail = (message: string, statusCode: number, payload?: Record<string, unknown>) => Object.assign(new Error(message), { statusCode, ...(payload ? { payload } : {}) });
type EventKind = Parameters<typeof recordAgentEvent>[2];
const event = (slug: string, agentId: string, kind: string, detail: Record<string, unknown>) => recordAgentEvent(slug, agentId, kind as EventKind, detail);
type LessonPatch = Parameters<ReturnType<typeof lessonsRepo>['update']>[1];

export interface ZipMarker { workspace: string | null; agentId: string | null; n: number | null; hash: string | null; exportedAt: string | null;
  /** Portal IA 3 · Identificador portable del agente (no es su id interno) y huella de cada archivo tal como se exportó. */
  bundle: string | null; files: Record<string, string> | null }

/**
 * Portal IA 3 · Identificador portable de un agente: estable, derivado de su id interno pero sin revelarlo. Permite que
 * el paquete que se exporta vuelva a SU agente (antes el paquete no llevaba ni id ni marcador y siempre entraba como nuevo).
 */
export const bundleIdOf = (agentId: string): string => `pa-${crypto.createHash('sha256').update(`portal-ia/agent/${agentId}`).digest('hex').slice(0, 24)}`;
const fileHash = (text: string): string => crypto.createHash('sha256').update(normalizeText(text)).digest('hex');
/** Marcador que acompaña al paquete exportado: sin id interno, sin nombre del espacio, sin rutas. */
export function exportMarker(agentId: string, base: { n: number | null; hash: string | null }, bundle: PortableFiles, exportedAt: string): string {
  const files: Record<string, string> = {};
  for (const p of Object.keys(bundle).sort()) files[p] = fileHash(bundle[p]!);
  return `${JSON.stringify({ schema: 2, bundle: bundleIdOf(agentId), n: base.n, hash: base.hash, exportedAt, files }, null, 2)}\n`;
}

// ---------------------------------------------------------------- Lectura defensiva

export function readAgentZip(file: string): { files: PortableFiles; marker: ZipMarker | null; changelog: string | null } {
  let listing: ReturnType<typeof listZip>;
  try { listing = listZip(file, { maxEntries: 200, maxEntryBytes: PORTABLE_LIMITS.fileBytes, maxRatio: 200 }); }
  catch (e: any) { throw fail(e?.message ?? 'No es un ZIP válido.', e?.statusCode ?? 400); }
  const problems: string[] = [];
  for (const e of listing.entries) if (e.problem) problems.push(`${e.name}: ${e.problem}`);
  const entries = listing.entries.filter(e => !e.isDir);
  const { paths } = stripZipRoot(entries.map(e => e.name));
  const files: PortableFiles = {}; let marker: ZipMarker | null = null;
  const extra = { changelog: null as string | null };
  const seen = new Set<string>(); let total = 0; let tooBig = false;
  const dec = new TextDecoder('utf-8', { fatal: true });
  entries.forEach((e, i) => {
    const rel = paths[i] ?? e.name;
    if (e.problem || tooBig) return;
    const key = rel.toLowerCase();
    if (seen.has(key)) { problems.push(`${rel}: está repetido en el ZIP`); return; }
    seen.add(key);
    const isMarker = rel === ZIP_EXPORT_MARKER;
    // EN-007 · Archivos propios del paquete portable (GUIA.md, AUTOMEJORA.md, PLANES.json, contexto/, memoria/, scripts de
    // habilidades de un externo…): no forman parte de la carpeta portal-ia/agent@1 y se ignoran al importar, sin bloquear.
    if (!isMarker && !allowedPortablePath(rel) && allowedBundlePath(rel)) {
      // CAMBIOS.md solo se lee para el resumen «Qué trae y qué aprendió» (no entra en la carpeta); si no es texto válido o
      // parece contener un secreto, se ignora sin bloquear.
      if (rel === CHANGELOG) { try { const t = dec.decode(readZipEntry(file, e)); if (!findSecret(t)) extra.changelog = normalizeText(t); } catch { /* se ignora */ } }
      return;
    }
    if (!isMarker && !allowedPortablePath(rel)) { problems.push(`${rel}: fuera de la carpeta del agente (no está entre los archivos permitidos)`); return; }
    total += e.usize;
    if (total > PORTABLE_LIMITS.totalBytes) { tooBig = true; problems.push(`El contenido supera ${PORTABLE_LIMITS.totalBytes / 1024} KB`); return; }
    let text: string;
    try { text = dec.decode(readZipEntry(file, e)); } catch (x: any) { problems.push(x?.statusCode ? x.message : `${rel}: no es texto UTF-8`); return; }
    const secret = findSecret(text);
    if (secret) { problems.push(`${rel}: contiene lo que parece una ${secret}`); return; }
    if (isMarker) marker = parseMarker(text); else files[rel] = normalizeText(text);
  });
  if (Object.keys(files).length > PORTABLE_LIMITS.files) problems.push(`Demasiados archivos (máx. ${PORTABLE_LIMITS.files})`);
  if (!problems.length && files['agent.yaml'] === undefined) problems.push('Falta agent.yaml: no parece la carpeta de un agente');
  if (problems.length) throw fail(`El ZIP no se puede importar: ${problems.slice(0, 5).join(' · ')}${problems.length > 5 ? ` (y ${problems.length - 5} más)` : ''}.`, 400, { problems });
  return { files, marker, changelog: files[CHANGELOG] ?? extra.changelog };
}

function parseMarker(text: string): ZipMarker | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const s = (v: unknown) => typeof v === 'string' && v.length <= 200 ? v : null;
    const fh = j.files && typeof j.files === 'object' && !Array.isArray(j.files) ? Object.fromEntries(Object.entries(j.files as Record<string, unknown>).filter(([k, v]) => k.length <= 300 && typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)).slice(0, 400)) as Record<string, string> : null;
    return { workspace: s(j.workspace), agentId: s(j.agentId), n: typeof j.n === 'number' && Number.isInteger(j.n) && j.n > 0 ? j.n : null, hash: s(j.hash), exportedAt: s(j.exportedAt), bundle: s(j.bundle), files: fh };
  } catch { return null; }
}

// ---------------------------------------------------------------- ZIP en espera entre vista previa y confirmación

const staged = new Map<string, { slug: string; dir: string; file: string; name: string; hash: string; expires: number }>();
function sweep() {
  const t = Date.now();
  for (const [k, v] of staged) if (v.expires < t) { try { fs.rmSync(v.dir, { recursive: true, force: true }); } catch { /* temporal */ } staged.delete(k); }
}
function stage(slug: string, uploaded: string, name: string, hash: string): string {
  sweep();
  while (staged.size >= STAGE_MAX) { const first = staged.keys().next().value as string; unstage(first); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pia-zipimp-')); const file = path.join(dir, 'agente.zip');
  fs.copyFileSync(uploaded, file);
  const token = crypto.randomBytes(16).toString('hex');
  staged.set(token, { slug, dir, file, name, hash, expires: Date.now() + STAGE_TTL_MS });
  return token;
}
function unstage(token: string) { const s = staged.get(token); if (!s) return; try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch { /* temporal */ } staged.delete(token); }

// ---------------------------------------------------------------- Fusión

/** Repone en agent.yaml lo que nunca se adopta (id, arnés, permisos, capacidades, fecha) con lo del Portal, en forma canónica. */
function alignYaml(files: PortableFiles, ours: PortableFiles): PortableFiles {
  if (files['agent.yaml'] === undefined) return files;
  const o = filesToDefinition(ours).definition; const d = filesToDefinition(files).definition;
  if (!o || !d) return files;
  const manifest = { ...d.manifest, id: o.manifest.id, harness: o.manifest.harness, permissions: o.manifest.permissions, capabilities: o.manifest.capabilities, createdAt: o.manifest.createdAt };
  const yaml = definitionToFiles({ ...d, manifest })['agent.yaml'];
  return yaml === undefined ? files : { ...files, 'agent.yaml': yaml };
}
/**
 * HU-213 · Fusión a tres bandas por archivo, compartida con la actualización de la Edición (editionUpdate.ts).
 * base = la última versión común, ours = la local, theirs = la que llega. Los choques quedan en `conflicts`, sin pisar nada.
 */
export function mergeThreeWay(base: PortableFiles, ours: PortableFiles, theirs: PortableFiles): PortableMergeResult {
  return mergePortableFiles(base, ours, theirs);
}
const withoutMem = (f: PortableFiles): PortableFiles => { const { [MEM]: _m, ...rest } = f; return rest; };
const memKey = (t: string) => normalizeText(t).trim().toLowerCase();

interface MergePlan { adoptedN: number | null; base: { n: number | null; how: 'marcador' | 'parecido' | 'sin-base' }; ours: PortableFiles; result: PortableMergeResult; newMemory: { id: string; title: string; text: string; source: string }[]; notAdopted: string[] }

function baseFor(slug: string, agentId: string, theirs: PortableFiles, marker: ZipMarker | null): { n: number | null; files: PortableFiles; how: MergePlan['base']['how'] } {
  const repo = agentFoldersRepo(slug);
  if (marker?.n && (!marker.agentId || marker.agentId === agentId)) {
    const f = repo.revisionFiles(agentId, marker.n);
    if (f && (!marker.hash || hashFiles(f) === marker.hash)) return { n: marker.n, files: f, how: 'marcador' };
  }
  // Sin marcador fiable: la revisión con más archivos idénticos al ZIP. Si empatan gana la MÁS ANTIGUA (las revisiones
  // llegan de la más reciente a la más antigua): una base más antigua solo puede convertir adopciones en conflictos, nunca
  // al revés, así que un cambio hecho en el Portal tras exportar no se pisa en silencio con lo de fuera.
  let best: { n: number; files: PortableFiles; score: number } | null = null;
  for (const r of repo.revisions(agentId).slice(0, 200)) {
    if (r.state === 'writing' || r.state === 'abandoned') continue;
    const f = repo.revisionFiles(agentId, r.n); if (!f) continue;
    let score = 0; for (const p of Object.keys(theirs)) if (f[p] !== undefined && normalizeText(f[p]!) === normalizeText(theirs[p]!)) score++;
    if (!best || score >= best.score) best = { n: r.n, files: f, score };
  }
  return best && best.score > 0 ? { n: best.n, files: best.files, how: 'parecido' } : { n: null, files: {}, how: 'sin-base' };
}

/**
 * Portal IA 3 · Lo que llega de un paquete exportado, listo para fusionar. El paquete no es la carpeta tal cual: al
 * exportar se limpia (sin id, sin rutas ni datos internos) y se le añaden avisos. Con la huella de cada archivo se sabe
 * con exactitud qué NO cambió fuera: eso se trata como «sin cambios» (vale el texto del Portal) y solo lo que de verdad
 * se editó fuera entra en la fusión. Un archivo generado por el paquete que no cambió no se adopta.
 */
export function incomingFromBundle(theirs: PortableFiles, marker: ZipMarker | null, base: PortableFiles): PortableFiles {
  if (!marker?.files) return theirs;
  const out: PortableFiles = {};
  for (const [p, text] of Object.entries(theirs)) {
    const unchanged = marker.files[p] !== undefined && marker.files[p] === fileHash(text);
    if (unchanged) { if (base[p] !== undefined) out[p] = base[p]!; continue; }
    out[p] = p === 'AGENTS.md' ? stripBundleNotices(text) : text;
  }
  // Lo que el paquete no trae pero estaba en la base y no forma parte de un paquete (nunca se exportó) se conserva.
  for (const [p, text] of Object.entries(base)) if (out[p] === undefined && theirs[p] === undefined && marker.files[p] === undefined) out[p] = text;
  return out;
}

function planMerge(slug: string, a: Agent, theirs0: PortableFiles, marker: ZipMarker | null): MergePlan {
  const repo = agentFoldersRepo(slug); const adopted = repo.adopted(a.id);
  const ours0 = adopted?.files ?? definitionToFiles(definitionFor(slug, a, adoptedExtras(slug, a)));
  const base = baseFor(slug, a.id, theirs0, marker);
  const theirs = incomingFromBundle(theirs0, marker, base.files);
  const result = mergeThreeWay(withoutMem(alignYaml(base.files, ours0)), withoutMem(alignYaml(ours0, ours0)), withoutMem(alignYaml(theirs, ours0)));
  // Memoria: entradas del ZIP que no estaban al exportar ni existen ya en el Portal.
  const baseMem = new Set((filesToDefinition(base.files).definition?.memory ?? []).map(m => memKey(`${m.title}\n${m.text}`)));
  // Cualquier entrada que ya tenga el agente (verificada, pendiente o retirada): reimportar el mismo ZIP no duplica nada.
  const known = lessonsRepo(slug).listForAgent(a.id);
  const knownIds = new Set(known.map(l => l.id)); const knownText = new Set(known.flatMap(l => [memKey(l.lessonText ?? ''), memKey(`${l.title}\n${l.lessonText ?? ''}`)]));
  const newMemory = (filesToDefinition(theirs).definition?.memory ?? [])
    .filter(m => m.text.trim() && !knownIds.has(m.id) && !knownText.has(memKey(m.text)) && !knownText.has(memKey(`${m.title}\n${m.text}`)) && !baseMem.has(memKey(`${m.title}\n${m.text}`)))
    .slice(0, 50).map(m => ({ id: m.id, title: m.title, text: m.text, source: m.source }));
  const notAdopted = notAdoptedChanges(ours0, theirs).filter(s => !s.startsWith('Memoria:'));
  return { adoptedN: adopted?.n ?? null, base: { n: base.n, how: base.how }, ours: ours0, result, newMemory, notAdopted };
}

/** El agente del ZIP existe en ESTE espacio (un marcador de otro espacio lo trata como nuevo: nunca se adopta uno ajeno). */
function existingAgent(slug: string, files: PortableFiles, marker: ZipMarker | null): Agent | null {
  if (marker?.workspace && marker.workspace !== slug) return null;
  const id = filesToDefinition(files).definition?.manifest.id ?? null;
  if (id) return agentsRepo(slug).get(id) ?? null;
  // Paquete exportado (sin id interno): se reconoce por su identificador portable.
  if (marker?.bundle) return agentsRepo(slug).list().find(a => bundleIdOf(a.id) === marker.bundle) ?? null;
  return null;
}

// ---------------------------------------------------------------- Qué trae y qué aprendió (sin IA)

export interface LearnedSkill { slug: string; name: string; description: string; base: boolean; note: string | null }
export interface ImportLearned {
  skillsNew: LearnedSkill[]; skillsChanged: LearnedSkill[]; memoryNew: { title: string; text: string }[];
  changelogSince: { heading: string; text: string }[]; changelogMark: string | null; warnings: string[]
}

/**
 * Resumen determinista de lo que trae el ZIP frente a la revisión adoptada (`ours`; vacío para un agente nuevo).
 * `granted` = herramientas concedidas (null si el agente es nuevo y aún no tiene ninguna). Las habilidades base solo se
 * muestran como información: nunca se adoptan ni conceden nada.
 */
function learnedSummary(theirs: PortableFiles, ours: PortableFiles, granted: string[] | null, memoryNew: { title: string; text: string }[], changelog: string | null): ImportLearned {
  const mine = new Map((filesToDefinition(ours).definition?.skills ?? []).map(s => [s.slug, s] as const));
  const grantedSet = granted ? new Set(granted) : null;
  const warnings: string[] = [];
  const view = (s: PortableSkill): LearnedSkill => {
    const base = isBaseSkill(s.slug); let note: string | null = null;
    if (base) {
      const tool = baseSkillTool(s.slug);
      if (!tool) note = 'Nombre reservado a las habilidades base que no corresponde a ninguna herramienta: no se adopta ni concede nada.';
      else if (!grantedSet) note = `Habilidad base: solo aparecerá si concedes la herramienta «${tool}»; por sí sola no concede nada.`;
      else if (grantedSet.has(tool)) note = 'Habilidad base: sale de una herramienta concedida en Configuración; se muestra solo como información.';
      else note = `Habilidad base de una herramienta no concedida («${tool}»): no se adopta ni concede nada.`;
      if (!tool || (grantedSet && !grantedSet.has(tool))) warnings.push(`skills/${s.slug}: ${note}`);
    }
    return { slug: s.slug, name: s.name, description: s.description, base, note };
  };
  const same = (a: PortableSkill, b: PortableSkill) => a.name === b.name && a.description === b.description && normalizeText(a.body).trim() === normalizeText(b.body).trim();
  const skillsNew: LearnedSkill[] = []; const skillsChanged: LearnedSkill[] = [];
  const theirSkills = [...(filesToDefinition(theirs).definition?.skills ?? [])].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const s of theirSkills) {
    const cur = mine.get(s.slug);
    if (!cur) skillsNew.push(view(s)); else if (!same(cur, s)) skillsChanged.push(view(s));
  }
  const since = changelog ? changelogSinceExport(changelog) : [];
  return {
    skillsNew, skillsChanged, memoryNew: memoryNew.slice(0, 50).map(m => ({ title: m.title, text: m.text })),
    changelogSince: since.slice(0, 50).map(e => ({ heading: e.heading.slice(0, 200), text: e.text.slice(0, 2000) })),
    changelogMark: changelog ? lastExportMark(changelog) : null, warnings
  };
}

// ---------------------------------------------------------------- Vista previa

const NOTE_NEW = 'Agente nuevo: lo que pide el ZIP (arnés, herramientas, autonomía) no se concede solo; tú eliges. Su memoria llega como propuesta, sin verificar. Recibe un identificador nuevo.';
const NOTE_EXISTING = 'Lo que solo cambió fuera (instrucciones, habilidades, referencias, CAMBIOS.md) se adopta como revisión nueva y puedes deshacerlo. La memoria nueva llega pendiente de tu verificación. Arnés, modelo, esfuerzo, herramientas, autonomía, capacidades e id nunca se toman del ZIP: se cambian en Configuración.';

export function previewZipImport(slug: string, uploaded: string, name: string) {
  const { files, marker, changelog } = readAgentZip(uploaded);
  const hash = hashFiles(files);
  const parsed = filesToDefinition(files); const d = parsed.definition;
  const ok = !!d && !parsed.problems.some(p => p.blocking);
  const existing = existingAgent(slug, files, marker);
  // Portal IA 3: el paquete de un agente con carpeta propia vuelve a SU carpeta (con sus programas), no por aqui: esta
  // via lo convertiria en un agente nuevo sin sus scripts.
  if (existing && externalSource(slug, existing.id)) throw fail(`Este paquete es de ${existing.config.name}, un agente con carpeta propia. Importalo desde su ficha: Ajustes > Origen > «Importar paquete mejorado».`, 409, { code: 'external_agent', agentId: existing.id });
  const token = stage(slug, uploaded, name, hash);
  // EN-014 · Ámbito que quedará tras importar (declarado en agent.yaml o, en un ZIP antiguo, el del agente existente o
  // General si es nuevo). Un proyecto que no existe en este Portal solo se avisa: no bloquea.
  const contextScope = importScopePreview(slug, files, existing);
  const common = {
    token, hash, name, ok, files: Object.keys(files).sort(), problems: parsed.problems, contextScope,
    agent: d ? { name: d.manifest.name, role: d.manifest.role, summary: d.manifest.summary, department: d.manifest.department, responsibilities: d.manifest.responsibilities, deliverables: d.manifest.deliverables, capabilities: d.manifest.capabilities.filter(c => CAPABILITIES.some(x => x.id === c)) } : null,
    requests: d ? { harness: d.manifest.harness.preferred, model: d.manifest.harness.model, tools: d.manifest.permissions.tools, autonomy: d.manifest.permissions.autonomy } : null,
    instructions: d?.instructions ?? '', skills: d?.skills.map(s => ({ slug: s.slug, name: s.name, description: s.description, body: s.body })) ?? [],
    memory: d?.memory.map(m => ({ title: m.title, text: m.text })) ?? [], references: d?.knowledge.map(k => ({ slug: k.slug, title: k.title, body: k.body })) ?? []
  };
  if (!existing) {
    const learned = learnedSummary(files, {}, null, (d?.memory ?? []).map(m => ({ title: m.title, text: m.text })), changelog);
    return { ...common, mode: 'nuevo' as const, agentId: null, adoptedN: null, base: null, adopted: [] as string[], conflicts: [] as PortableMergeConflict[], newMemory: [] as { title: string; text: string }[], notAdopted: [] as string[], upToDate: false, note: NOTE_NEW, learned };
  }
  const plan = planMerge(slug, existing, files, marker);
  // MEMORY.md no se fusiona como texto (es la proyección de las lecciones); si el ZIP trae memoria nueva, se adopta como
  // lecciones pendientes de tu verificación y así se muestra en la vista previa.
  const adopted = [...plan.result.adopted, ...(plan.newMemory.length && !plan.result.adopted.includes(MEM) ? [MEM] : [])];
  return {
    ...common, mode: 'existente' as const, agentId: existing.id, adoptedN: plan.adoptedN, base: plan.base, adopted, conflicts: plan.result.conflicts,
    newMemory: plan.newMemory.map(m => ({ title: m.title, text: m.text })), notAdopted: plan.notAdopted,
    upToDate: !adopted.length && !plan.result.conflicts.length && !plan.newMemory.length, note: NOTE_EXISTING,
    learned: learnedSummary(files, plan.ours, grantedTools(existing), plan.newMemory, changelog)
  };
}

// ---------------------------------------------------------------- Confirmación y Deshacer

function setLessons(slug: string, ids: string[], status: LessonStatus) {
  const repo = lessonsRepo(slug);
  for (const id of ids) { try { repo.update(id, { status } as LessonPatch); } catch { /* se informa el error original */ } }
}

export interface ZipConfirmInput { token: string; hash: string; resolutions: Record<string, 'portal' | 'zip'>; grant?: ImportGrant | undefined }

export async function applyZipImport(slug: string, input: ZipConfirmInput, onRowFor: (agentId: string) => (p: RowPatch) => void) {
  sweep();
  const st = staged.get(input.token);
  if (!st || st.slug !== slug) throw fail('La vista previa caducó: vuelve a subir el ZIP.', 410);
  const { files, marker, changelog } = readAgentZip(st.file);
  if (hashFiles(files) !== input.hash || st.hash !== input.hash) throw fail('El ZIP cambió desde la vista previa: vuelve a revisarlo.', 409);
  let existing = existingAgent(slug, files, marker);
  if (!existing) {
    if (!input.grant) throw fail('Para un agente nuevo elige arnés, permisos y departamento.', 400);
    const nameWarnings: string[] = [];
    const agent = await importFromFiles(slug, files, `ZIP «${st.name || 'agente.zip'}»`, input.grant, 'Importado desde ZIP (revisado por el propietario)', w => { nameWarnings.push(w); });
    event(slug, agent.id, 'imported_zip', { mode: 'nuevo', hash: input.hash });
    unstage(input.token);
    const learned = learnedSummary(files, {}, null, (filesToDefinition(files).definition?.memory ?? []).map(m => ({ title: m.title, text: m.text })), changelog);
    learned.warnings.push(...nameWarnings);
    return { mode: 'nuevo' as const, agent, revision: null as AgentRevision | null, undo: null, adopted: [] as string[], notAdopted: [] as string[], upToDate: false, memoryPending: 0, learned };
  }
  if (!agentFoldersRepo(slug).adopted(existing.id)) { await syncAgentFolder(slug, existing); existing = agentsRepo(slug).get(existing.id)!; }
  const plan = planMerge(slug, existing, files, marker);
  const { files: merged, unresolved } = applyMergeResolutions(plan.result, input.resolutions);
  if (unresolved.length) throw fail('Hay archivos que cambiaron también en el Portal desde la exportación: elige qué versión quedarse en cada uno.', 409, { conflicts: plan.result.conflicts.filter(c => unresolved.includes(c.path)) });
  if (plan.ours[MEM] !== undefined) merged[MEM] = plan.ours[MEM]!;
  const fromZip = plan.result.conflicts.filter(c => input.resolutions[c.path] === 'zip').map(c => c.path);
  const adopted = [...plan.result.adopted, ...fromZip];
  // Portal IA 3 · Instrucciones editadas FUERA: dejan de ser «las de por defecto». Sin esto, si el texto conservaba la marca
  // de «instrucciones por defecto», el Portal las regeneraba y lo aprendido fuera se perdía sin avisar.
  if (adopted.includes('AGENTS.md') && merged['AGENTS.md']?.includes(DEFAULT_INSTRUCTIONS_MARK)) {
    merged['AGENTS.md'] = normalizeText(merged['AGENTS.md'].split('\n').filter(l => l.trim() !== DEFAULT_INSTRUCTIONS_MARK).join('\n'));
  }
  const target = existing;
  const zipName = st.name || 'agente.zip';
  const learned = learnedSummary(files, plan.ours, grantedTools(target), plan.newMemory, changelog);
  // Memoria nueva → lecciones DETECTADAS del agente (pendientes de tu verificación): no entran en MEMORY.md ni en los prompts.
  const createPending = (): string[] => {
    const lessons = lessonsRepo(slug); const ts = monotonicNow(); const ids: string[] = [];
    for (const m of plan.newMemory) {
      const l = lessons.insert({ projectId: null, role: null, tags: ['importada', 'zip', 'sin-verificar'], status: 'detected', version: 1, parentId: null, title: m.title.slice(0, 120) || 'Aprendizaje importado', detector: 'import', evidence: { processId: null, processTitle: null, stepId: null, agentId: target.id, agentName: target.config.name, file: null, detail: `Importada del ZIP (sin verificar) «${zipName}» · origen: ${m.source || 'sin origen'} · ${ts.slice(0, 10)}`, at: ts }, rootCause: null, correctiveAction: null, lessonText: m.text.slice(0, 2000), source: 'import', promotedTo: null, dedupeKey: null, agentId: target.id });
      if (l) ids.push(l.id);
    }
    return ids;
  };
  if (!adopted.length) {
    const lessonIds = createPending();
    if (lessonIds.length) event(slug, target.id, 'imported_zip', { mode: 'existente', revision: null, previous: plan.adoptedN, lessonIds, adopted, hash: input.hash, base: plan.base.n });
    unstage(input.token);
    return { mode: 'existente' as const, agent: target, revision: null as AgentRevision | null, undo: null, adopted, notAdopted: plan.notAdopted, upToDate: !lessonIds.length, memoryPending: lessonIds.length, learned };
  }
  const r = await writeImportedRevision(slug, target.id, merged, plan.adoptedN, onRowFor(target.id));
  // EN-015 · Nombre propio de la revisión adoptada (idempotente): si choca o no es válido, aviso sin bloquear.
  const pn = applyImportedPersonalName(slug, target.id, merged);
  if (pn.warning) learned.warnings.push(pn.warning);
  const lessonIds = createPending();
  event(slug, target.id, 'imported_zip', { mode: 'existente', revision: r.revision.n, previous: r.previousN, lessonIds, adopted, resolved: input.resolutions, hash: input.hash, base: plan.base.n });
  unstage(input.token);
  return {
    mode: 'existente' as const, agent: agentsRepo(slug).get(target.id)!, revision: r.revision,
    undo: r.created && r.previousN ? { n: r.previousN, importN: r.revision.n, lessonIds } : null, adopted, notAdopted: plan.notAdopted,
    upToDate: !r.created && !lessonIds.length, memoryPending: lessonIds.length, learned
  };
}

/** Deshacer: vuelve a la revisión anterior (nueva revisión 'restore') y retira la memoria creada por esa importación. */
export async function undoZipImport(slug: string, agentId: string, importN: number, onRow: (p: RowPatch) => void) {
  const repo = agentFoldersRepo(slug); const f = repo.folderOf(agentId);
  const rev = repo.revisions(agentId).find(x => x.n === importN);
  const ev = agentEvents(slug, agentId, 200).find(e => e.kind === 'imported_zip' && (e.detail as Record<string, unknown>)?.revision === importN);
  if (!rev || rev.source !== 'import' || !ev) throw fail('Esa revisión no es una importación desde ZIP.', 404);
  if (!f || f.adoptedN !== importN) throw fail('Ya no se puede deshacer: el agente cambió después de esa importación.', 409);
  const detail = (ev.detail ?? {}) as Record<string, unknown>;
  const previous = typeof detail.previous === 'number' ? detail.previous : null;
  if (!previous) throw fail('No hay revisión anterior a la que volver.', 409);
  const lessonIds = Array.isArray(detail.lessonIds) ? detail.lessonIds.filter((x): x is string => typeof x === 'string') : [];
  const lessonsNow = lessonsRepo(slug);
  const before = lessonIds.map(id => ({ id, status: lessonsNow.get(id)?.status ?? null }));
  // Retirar la memoria importada con los estados que ya existen: validada → obsoleta, pendiente → rechazada (como agentLearning).
  for (const b of before) if (b.status) setLessons(slug, [b.id], b.status === 'validated' ? 'obsolete' : 'rejected');
  let r: AgentRevision;
  try { r = await restoreRevision(slug, agentId, previous, onRow); }
  catch (e) { for (const b of before) if (b.status) setLessons(slug, [b.id], b.status); throw e; }
  event(slug, agentId, 'imported_zip_undone', { importN, to: previous, revision: r.n, lessonIds });
  return { revision: r, retired: lessonIds.length };
}
