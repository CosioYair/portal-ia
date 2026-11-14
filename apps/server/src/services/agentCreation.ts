import fs from 'node:fs';
import path from 'node:path';
import { CAPABILITIES, DEFAULT_CONTEXT_SCOPE, contextScopeFromPortable, contextScopeOptions, normalizeContextScope, type AgentContextScope, EXTERNAL_BUNDLE_LIMITS, KNOWLEDGE, TOOLS, buildExternalBundle, buildPortableBundle, isIdentityPath, validatePortableBundle, definitionToFiles, filesToDefinition, slugify, type Agent, type AgentConfig, type Capability, type ExecutionBackend, type PortableFiles, type PortableKnowledge, type PortableSkill, type ProviderId, type ReasoningEffort, type TeamRole, clampEffort } from '@portal-ia/domain';
import { config, REPO_ROOT } from '../config.ts';
import { agentsRepo, projectsRepo } from '../db/workspace.ts';
import { departmentsRepo } from './departments.ts';
import { agentFoldersRepo, definitionFor, agentDefaultInstructions, hashFiles, readFolder, registerAgentFolder, writeRevision, adoptedExtras, companyNameOf, contextScopeOf, GENERAL_ONLY_SCOPE, importScopePreview, applyImportedContextScope, applyImportedPersonalName, type AgentExtras } from './agentFolders.ts';
import { harnessAvailability, harnessModels } from './harness/index.ts';
import { inheritLatestTemplate } from './agentTemplates.ts';
import { recordAgentEvent } from './agentEvents.ts';
import { lessonsFor, lessonsRepo } from './lessons.ts';
import { expandHome, isAllowed } from '../routes/fs.ts';
import { monotonicNow } from '../clock.ts';
import { zipBuffers } from './zipFile.ts';

/**
 * Creación de agentes sin código (asistente de la oficina), importación de carpetas portables y exportación.
 * - El propietario elige explícitamente el arnés (nada se queda por defecto en la API facturable) y concede los permisos.
 * - Lo que pida una carpeta importada (arnés, herramientas, autonomía) es solo una PETICIÓN que se muestra; el agente nace
 *   con lo que el propietario conceda en la confirmación. La memoria importada llega como «propuesta» (sin verificar).
 * - El id del agente importado es siempre nuevo (el de la carpeta se ignora).
 */
export interface WizardInput {
  name: string; role: string; summary: string; responsibilities: string[]; deliverables: string[];
  department: string; departmentPurpose?: string | null;
  scope: 'workspace' | 'project'; projectId: string | null;
  harness: ExecutionBackend; model: string; provider?: ProviderId | null; effort: ReasoningEffort;
  tools: string[]; knowledge: string[]; capabilities: Capability[]; autonomy: 'ask' | 'within_scope';
  instructions?: string | null; skills?: PortableSkill[]; references?: PortableKnowledge[];
  initials?: string | null; authorized: boolean;
  /** CAMBIOS.md de una carpeta o ZIP importado (se conserva tal cual). */
  changelog?: string | null;
  /** HU-204 · Texto de «¿Qué debería conseguir este agente?». Solo para la trazabilidad: nunca concede permisos. */
  need?: string | null;
  /** EN-014 · Ámbito (Proyecto/Empresa/General, combinables). Sin valor: DEFAULT_CONTEXT_SCOPE (Empresa + General). */
  contextScope?: { project?: { id: string; name?: string } | null; company: boolean; general: boolean } | AgentContextScope | null;
}

/** EN-014 · Valida el ámbito pedido (al menos una opción; el proyecto debe existir en este espacio). */
function resolveContextScope(slug: string, raw: WizardInput['contextScope']): AgentContextScope {
  if (!raw) return DEFAULT_CONTEXT_SCOPE;
  let project: { id: string; name: string } | null = null;
  if (raw.project?.id) {
    const p = projectsRepo(slug).get(raw.project.id);
    if (!p) throw Object.assign(new Error('El proyecto del ámbito no existe en este Portal: elige otro o quita «Proyecto».'), { statusCode: 400 });
    project = { id: p.id, name: (p as { name?: string }).name ?? raw.project.name ?? '' };
  }
  const scope = normalizeContextScope({ project, company: raw.company === true, general: raw.general === true }, project);
  if (!scope || !contextScopeOptions(scope).length) throw Object.assign(new Error('Elige al menos un ámbito: Proyecto, Empresa o General.'), { statusCode: 400 });
  return scope;
}

/** HU-204 · Slug de la referencia con la necesidad original: knowledge/necesidad-original.md en la carpeta portable. */
export const NEED_REFERENCE_SLUG = 'necesidad-original';
const NEED_MAX = 4000;

/** HU-204 · Referencia con el texto de la necesidad, o null si no hay texto. Sin IA ni IO. */
export function needReference(need: string | null | undefined, at: string = new Date().toISOString()): PortableKnowledge | null {
  const text = (need ?? '').trim().slice(0, NEED_MAX);
  if (!text) return null;
  const quoted = text.split(/\r?\n/).map(l => `> ${l}`).join('\n');
  return {
    slug: NEED_REFERENCE_SLUG, title: 'Necesidad original',
    body: `# Necesidad original\n\nTexto con el que el propietario pidió este agente (${at.slice(0, 10)}). Se guarda para la trazabilidad; no concede permisos ni herramientas.\n\n${quoted}\n`
  } as PortableKnowledge;
}

const initialsOf = (name: string) => name.split(/\s+/).filter(w => w.length > 2 && !/^(de|del|la|el|los|las|y|en|para)$/i.test(w)).map(w => w[0]!.toUpperCase()).slice(0, 2).join('') || name.slice(0, 2).toUpperCase();

function validate(slug: string, i: WizardInput): { provider: ProviderId } {
  if (!i.authorized) throw Object.assign(new Error('Crear un agente con un arnés de ejecución requiere tu confirmación explícita.'), { statusCode: 403 });
  if (i.name.trim().length < 2 || i.role.trim().length < 2) throw Object.assign(new Error('El agente necesita nombre y papel.'), { statusCode: 400 });
  if (i.scope === 'project' && (!i.projectId || !projectsRepo(slug).get(i.projectId))) throw Object.assign(new Error('Elige el proyecto del agente.'), { statusCode: 400 });
  for (const t of i.tools) if (!TOOLS.some(x => x.id === t)) throw Object.assign(new Error(`Herramienta desconocida: ${t}`), { statusCode: 400 });
  for (const k of i.knowledge) if (!KNOWLEDGE.some(x => x.id === k)) throw Object.assign(new Error(`Fuente de conocimiento desconocida: ${k}`), { statusCode: 400 });
  for (const c of i.capabilities) if (!CAPABILITIES.some(x => x.id === c)) throw Object.assign(new Error(`Capacidad desconocida: ${c}`), { statusCode: 400 });
  const provider: ProviderId = i.harness === 'codex' ? 'openai' : i.harness === 'api' ? (i.provider ?? 'anthropic') : 'anthropic';
  const av = harnessAvailability(i.harness, i.harness === 'api' ? provider : null);
  if (!av.available) throw Object.assign(new Error(`${av.reason ?? 'Ese arnés no está disponible.'} Elige otro arnés para crear el agente.`), { statusCode: 409 });
  const models = harnessModels(i.harness, provider).find(m => m.provider === provider)?.models ?? [];
  if (!i.model || (models.length && !models.some(m => m.id === i.model))) throw Object.assign(new Error(`El modelo «${i.model}» no está disponible con ese arnés.`), { statusCode: 400 });
  return { provider };
}

export async function createAgentFromWizard(slug: string, i: WizardInput, source: 'created' | 'import' = 'created', importNote = 'Importado desde una carpeta (revisado por el propietario)', prepare?: (agent: Agent) => void): Promise<Agent> {
  const { provider } = validate(slug, i);
  const contextScope = resolveContextScope(slug, i.contextScope);
  const agents = agentsRepo(slug); const deps = departmentsRepo(slug);
  const dep = deps.materialize({ name: i.department.trim() || 'Dirección', purpose: i.departmentPurpose ?? undefined });
  const coord = deps.coordinatorOf(dep.slug);
  let key = `${i.scope === 'project' ? 'pj' : 'ws'}-${slugify(i.name).slice(0, 40)}`; let n = 2;
  while (agents.keyExists(key)) key = `${key.replace(/-\d+$/, '')}-${n++}`;
  const cfg: AgentConfig = {
    name: i.name.trim(), specialization: i.summary.trim(), responsibilities: i.responsibilities.map(r => r.trim()).filter(Boolean).slice(0, 30),
    provider, model: i.model, fallbacks: [], effort: clampEffort(provider, i.model, i.effort), effortApplied: true,
    tools: Object.fromEntries(i.tools.map(t => [t, true])), knowledge: Object.fromEntries(i.knowledge.map(k => [k, true])),
    monthlyLimitUsd: i.harness === 'api' ? 20 : 0, perTaskAuthUsd: i.harness === 'api' ? 2 : 0, capabilities: i.capabilities, backend: i.harness
  };
  const created = agents.createCustom({
    key, scope: i.scope, projectId: i.scope === 'project' ? i.projectId : null, config: cfg,
    template: { initials: (i.initials || initialsOf(i.name)).slice(0, 2).toUpperCase(), role: i.role.trim(), reportsTo: coord && (coord.scope === 'workspace' || coord.projectId === (i.scope === 'project' ? i.projectId : null)) ? coord.key : 'owner', supervises: [], collaborates: [], evaluation: i.deliverables.slice(0, 5), tier: 'mid', department: dep.name } as Agent['template']
  });
  // EN-014 · El ámbito se guarda ANTES de generar la carpeta: AGENTS.md por defecto, habilidades base y agent.yaml lo usan.
  const inherited = inheritLatestTemplate(slug, created);
  const scoped = agentsRepo(slug).setContextScope(inherited.id, contextScope);
  // EN-015 · El nombre propio de un paquete importado se valida y guarda ANTES de la carpeta: AGENTS.md y agent.yaml lo llevan.
  if (prepare) prepare(scoped);
  const agent = agentsRepo(slug).get(scoped.id) ?? scoped;
  // Carpeta portable: identidad + lo propio (instrucciones, habilidades, referencias, entregables, autonomía).
  registerAgentFolder(slug, agent);
  // EN-013 · Sin instrucciones propias, el AGENTS.md por defecto se genera sin IA a partir de los datos reales del agente
  // ya creado (papel, especialización, responsabilidades, a quién reporta y habilidades según las herramientas concedidas).
  // Un AGENTS.md importado con la marca de por defecto también se regenera en definitionFor con los datos de ESTE agente.
  // Uno sin la marca (propio) se conserva tal cual. Las instrucciones nunca conceden permisos: estos salen solo de la fila.
  // HU-204 · La necesidad del propietario queda en knowledge/necesidad-original.md (carpeta portable e historial de revisiones).
  const needRef = source === 'created' ? needReference(i.need) : null;
  const references = (i.references ?? []).map(k => ({ ...k, slug: slugify(k.slug || k.title).slice(0, 60) })).filter(k => !needRef || k.slug !== NEED_REFERENCE_SLUG);
  const extras: AgentExtras = {
    instructions: i.instructions?.trim() ? i.instructions.trim() : agentDefaultInstructions(slug, agent),
    skills: (i.skills ?? []).map(s => ({ ...s, slug: slugify(s.slug || s.name).slice(0, 60) })), memory: [], knowledge: needRef ? [...references, needRef] : references,
    deliverables: i.deliverables.map(d => d.trim()).filter(Boolean).slice(0, 20), autonomy: i.autonomy,
    changelog: i.changelog?.trim() ? i.changelog : undefined
  };
  await writeRevision(slug, agent.id, definitionToFiles(definitionFor(slug, agent, extras)), source === 'import' ? 'import' : 'created', source === 'import' ? importNote : 'Creado con el asistente de la oficina');
  recordAgentEvent(slug, agent.id, source === 'import' ? 'imported' : 'created', { harness: i.harness, model: i.model, department: dep.name, tools: i.tools, autonomy: i.autonomy, scope: i.scope, ...(needRef ? { need: (i.need ?? '').trim().slice(0, NEED_MAX) } : {}) });
  return agentsRepo(slug).get(agent.id)!;
}

// ---------------------------------------------------------------- Importar y exportar

/** Carpeta local elegida por el propietario: absoluta, en un disco local (sin rutas UNC), permitida, sin enlaces. */
export function localDir(p: string, opts: { mustExist?: boolean } = {}): string {
  const raw = expandHome(p.trim());
  if (/^(\\\\|\/\/)/.test(raw)) throw Object.assign(new Error('No se admiten rutas de red (\\\\servidor\\…): elige una carpeta de tu equipo.'), { statusCode: 400 });
  if (!path.isAbsolute(raw)) throw Object.assign(new Error('Elige la carpeta con el selector (ruta absoluta).'), { statusCode: 400 });
  const abs = path.resolve(raw);
  if (!isAllowed(abs)) throw Object.assign(new Error('Ruta fuera de las carpetas permitidas'), { statusCode: 403 });
  if (opts.mustExist !== false) {
    let st: fs.Stats; try { st = fs.lstatSync(abs); } catch { throw Object.assign(new Error('La carpeta no existe.'), { statusCode: 404 }); }
    if (st.isSymbolicLink() || !st.isDirectory()) throw Object.assign(new Error('Elige una carpeta normal (no un enlace).'), { statusCode: 400 });
  }
  const real = (p: string) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const target = fs.existsSync(abs) ? real(abs) : path.join(real(path.dirname(abs)), path.basename(abs));
  if (/^(\\\\|\/\/)/.test(target)) throw Object.assign(new Error('Esa carpeta está en una unidad de red: elige una carpeta de tu equipo.'), { statusCode: 400 });
  const inside = (root: string) => { const r = path.relative(real(root).toLowerCase(), target.toLowerCase()); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  if (inside(config.dataDir)) throw Object.assign(new Error('Esa carpeta pertenece a los datos internos del Portal.'), { statusCode: 403 });
  return target;
}

export function importPreview(slug: string, dir: string) {
  const abs = localDir(dir);
  const { files, ignored } = readFolder(abs);
  // Archivos con más de un enlace físico pueden apuntar fuera de la carpeta: se rechazan.
  for (const rel of Object.keys(files)) { try { if (fs.statSync(path.join(abs, ...rel.split('/'))).nlink > 1) throw Object.assign(new Error(`${rel} es un enlace físico: copia la carpeta antes de importarla.`), { statusCode: 400 }); } catch (e: any) { if (e.statusCode) throw e; } }
  const parsed = filesToDefinition(files);
  const d = parsed.definition;
  return {
    path: abs, hash: hashFiles(files), files: Object.keys(files).sort(), ignored, problems: parsed.problems,
    ok: !!d && !parsed.problems.some(p => p.blocking),
    // EN-014 · Ámbito que tendrá el agente nuevo (sin ámbito declarado: General); avisa sin bloquear si el proyecto no existe.
    contextScope: importScopePreview(slug, files, null),
    agent: d ? { name: d.manifest.name, role: d.manifest.role, summary: d.manifest.summary, department: d.manifest.department, responsibilities: d.manifest.responsibilities, deliverables: d.manifest.deliverables, capabilities: d.manifest.capabilities.filter(c => CAPABILITIES.some(x => x.id === c)) } : null,
    requests: d ? { harness: d.manifest.harness.preferred, model: d.manifest.harness.model, tools: d.manifest.permissions.tools, autonomy: d.manifest.permissions.autonomy } : null,
    // Todo lo que llegaría a sus prompts, para leerlo ANTES de importar (instrucciones, habilidades y referencias completas).
    instructions: d?.instructions ?? '', skills: d?.skills.map(s => ({ slug: s.slug, name: s.name, description: s.description, body: s.body })) ?? [],
    memory: d?.memory.map(m => ({ title: m.title, text: m.text })) ?? [], references: d?.knowledge.map(k => ({ slug: k.slug, title: k.title, body: k.body })) ?? [],
    note: 'Lo que la carpeta pide (arnés, herramientas, autonomía) no se concede solo: tú eliges lo que concedes. Su memoria llega como propuesta, sin verificar. El agente recibe un identificador nuevo.'
  };
}

/** Lo que concede el propietario al importar un agente nuevo (arnés, permisos, departamento…): nunca sale de la carpeta. */
export type ImportGrant = Omit<WizardInput, 'name' | 'role' | 'summary' | 'responsibilities' | 'deliverables' | 'instructions' | 'skills' | 'references' | 'capabilities' | 'changelog'> & { capabilities?: Capability[] | null };

export async function importConfirm(slug: string, dir: string, expectHash: string, grant: ImportGrant): Promise<Agent> {
  const abs = localDir(dir);
  const { files } = readFolder(abs);
  if (hashFiles(files) !== expectHash) throw Object.assign(new Error('La carpeta cambió desde la vista previa: vuelve a revisarla.'), { statusCode: 409 });
  return importFromFiles(slug, files, abs, grant);
}

/**
 * Crea un agente NUEVO a partir de archivos portables ya leídos (de una carpeta o de un ZIP). `origin` describe de dónde
 * vienen (se guarda en la evidencia de la memoria propuesta). El id de la carpeta se ignora: el agente recibe uno nuevo.
 */
export async function importFromFiles(slug: string, files: PortableFiles, origin: string, grant: ImportGrant, note = 'Importado desde una carpeta (revisado por el propietario)', onWarning?: (warning: string) => void): Promise<Agent> {
  const parsed = filesToDefinition(files);
  if (!parsed.definition || parsed.problems.some(p => p.blocking)) throw Object.assign(new Error(`No se puede importar: ${parsed.problems.filter(p => p.blocking).map(p => `${p.path} — ${p.message}`).join(' · ')}`), { statusCode: 400 });
  const d = parsed.definition;
  // EN-014 · El ámbito declarado en agent.yaml se respeta; un ZIP o una carpeta antiguos sin él dejan al agente nuevo como General.
  let importedScope: AgentContextScope = GENERAL_ONLY_SCOPE;
  if (d.manifest.contextScope) {
    const s0 = contextScopeFromPortable(d.manifest.contextScope).scope;
    // Un proyecto que no existe en este Portal se avisa en la vista previa pero no bloquea: se quita del ámbito.
    const s: AgentContextScope = s0.project && !projectsRepo(slug).get(s0.project.id) ? { ...s0, project: null } : s0;
    importedScope = contextScopeOptions(s).length ? s : GENERAL_ONLY_SCOPE;
  }
  const agent = await createAgentFromWizard(slug, {
    ...grant, contextScope: importedScope, name: d.manifest.name, role: d.manifest.role, summary: d.manifest.summary, responsibilities: d.manifest.responsibilities, deliverables: d.manifest.deliverables,
    capabilities: grant.capabilities ?? [],
    instructions: d.instructions, skills: d.skills, references: d.knowledge, initials: d.manifest.initials, changelog: d.changelog ?? null
  }, 'import', note, a => {
    // EN-015 · Se conserva manifest.personalName si es válido y único en la empresa; si choca, aviso sin bloquear.
    const r = applyImportedPersonalName(slug, a.id, files);
    if (r.warning) onWarning?.(r.warning);
  });
  // EN-014 · Mismo criterio que la vista previa (ZIP y carpeta): ámbito declarado o, si no lo trae, General.
  applyImportedContextScope(slug, agent.id, files, true);
  // La memoria de la carpeta llega como PROPUESTA (el propietario la verifica o la descarta).
  const lessons = lessonsRepo(slug); const ts = monotonicNow();
  for (const m of d.memory.slice(0, 50)) {
    const l = lessons.insert({ projectId: null, role: null, tags: ['importada'], status: 'proposed', version: 1, parentId: null, title: m.title.slice(0, 120) || 'Aprendizaje importado', detector: 'import', evidence: { processId: null, processTitle: null, stepId: null, agentId: agent.id, agentName: agent.config.name, file: null, detail: `Importado de ${origin} (${m.source || 'sin origen'}) el ${ts.slice(0, 10)}; sin verificar.`, at: ts }, rootCause: null, correctiveAction: null, lessonText: m.text, source: 'import', promotedTo: null, dedupeKey: null, agentId: agent.id });
    void l;
  }
  return agent;
}

/** Papel de equipo del agente para las lecciones (el mismo filtro de rol que usa la inyección en los prompts). */
function teamRoleOf(a: Agent): TeamRole | null {
  const t = `${a.key} ${a.template?.role ?? ''}`.toLowerCase();
  if (/coordinador|planific|planner/.test(t)) return 'planner' as TeamRole;
  if (/\bqa\b|revis|calidad|reviewer/.test(t)) return 'reviewer' as TeamRole;
  if (/desarroll|implement|ingenier|developer/.test(t)) return 'implementer' as TeamRole;
  if (/consult|especialista|curador|diseñ/.test(t)) return 'consultant' as TeamRole;
  return null;
}

/**
 * EN-007 · Lecciones validadas de su papel (lessonsFor: la misma consulta que las inyecta en los prompts). Si no hay
 * ninguna, no se crea el archivo. El paquete limpia las rutas y los UUID de knowledge/ con el mismo scrub que el resto.
 */
function roleLessons(slug: string, a: Agent): string | null {
  try {
    const ls = lessonsFor(slug, { projectId: a.projectId ?? null, role: teamRoleOf(a), tags: [] }).filter(l => (l.lessonText ?? '').trim());
    if (!ls.length) return null;
    return `# Lecciones del papel\n\nLecciones validadas por el propietario que el Portal inyecta en los prompts de este papel. Son obligatorias.\n\n${ls.map((l, i) => `${i + 1}. ${l.lessonText!.trim().replace(/\s+/g, ' ')}`).join('\n')}\n`;
  } catch { return null; }
}

/** Archivos de la revisión adoptada (o la que se generaría) para descargar como paquete. */
export async function exportFiles(slug: string, agentId: string): Promise<{ folder: string; files: PortableFiles; kind: 'internal' | 'external'; sourceRoot?: string; base?: { n: number | null; hash: string | null } }> {
  const a = agentsRepo(slug).get(agentId); if (!a) throw Object.assign(new Error('Agente no encontrado'), { statusCode: 404 });
  // EN-007 · Agente externo: su revisión adoptada (lo que admite isIdentityPath), no definitionFor. Import diferido:
  // externalAgents.ts importa este módulo.
  const ext = await import('./externalAgents.ts');
  const src = ext.externalSource(slug, agentId);
  if (src) {
    const snap = ext.sourcesRepo(slug).files(agentId) ?? {};
    const files: PortableFiles = {};
    for (const p of Object.keys(snap).sort()) if (isIdentityPath(p)) files[p] = snap[p]!;
    return { folder: slugify(path.basename(src.root)).slice(0, 60) || slugify(a.config.name).slice(0, 60) || 'agente', files, kind: 'external', sourceRoot: src.root, base: { n: src.revision, hash: src.adoptedHash } };
  }
  const f = agentFoldersRepo(slug).folderOf(agentId);
  const ad = f ? agentFoldersRepo(slug).adopted(agentId) : null;
  const base = ad?.files ?? definitionToFiles(definitionFor(slug, a, adoptedExtras(slug, a)));
  const lessons = roleLessons(slug, a);
  const files: PortableFiles = lessons ? { ...base, 'knowledge/lecciones-del-papel.md': lessons } : base;
  return { folder: f?.folder ?? slugify(`${a.key}-${a.id.slice(0, 8)}`), files, kind: 'internal', base: { n: ad?.n ?? null, hash: ad ? hashFiles(ad.files) : null } };
}

export interface ExportReadiness { ok: boolean; kind: 'internal' | 'external'; problems: unknown[]; files: string[]; bytes: number; manifest: unknown; excluded: string[]; warnings: string[] }
/** Vista previa de la exportación: qué lleva, qué necesita fuera y qué lo impide (si algo). Sin IA, sin efectos. */
export async function exportReadiness(slug: string, agentId: string): Promise<ExportReadiness> { return (await exportBundle(slug, agentId, { dryRun: true })).readiness!; }

/**
 * Paquete portable autosuficiente (portal-ia/agent-bundle@2) en un ZIP en memoria: la carpeta adoptada, limpia de datos
 * internos, más AUTOMEJORA.md, CAMBIOS.md, GUIA.md y scripts/anotar-cambio.mjs. Si queda algún secreto o dato interno
 * (id del agente, UUID, rutas locales o de data/, rutas /api/, tablas), se niega con 409 y la lista de problemas.
 */
export async function exportBundle(slug: string, agentId: string, opts: { dryRun?: boolean } = {}): Promise<{ fileName: string; zip: Buffer; files: string[]; readiness?: ExportReadiness }> {
  const a = agentsRepo(slug).get(agentId); if (!a) throw Object.assign(new Error('Agente no encontrado'), { statusCode: 404 });
  const { files, kind, sourceRoot, base } = await exportFiles(slug, agentId);
  // Si la historia «Automejora desde el chat» deja un CAMBIOS.md en la carpeta, se conserva su historial.
  const changelog = typeof files['CAMBIOS.md'] === 'string' ? files['CAMBIOS.md'] : null;
  const exportedAt = new Date().toISOString();
  // EN-014 · Ámbito y nombres reales; con solo General el paquete no lleva el nombre de la empresa ni del proyecto.
  const contextScope = contextScopeOf(slug, a);
  const companyName = contextScope?.company ? companyNameOf(slug) : null;
  const projectName = contextScope?.project?.name ?? null;
  let bundle: PortableFiles; let enrichWarnings: string[] = []; let manifestOut: unknown = null;
  if (kind === 'external') {
    // EN-007 · Revisión adoptada con los scripts sin tocar, más los planes que ya funcionaron por SHA-256 del PDF.
    const { provenPlansForExport } = await import('./documentJobs.ts');
    bundle = buildExternalBundle(files, { agentName: a.config.name, role: a.template?.role ?? null, summary: a.config.specialization ?? null, exportedAt, changelog, provenPlans: provenPlansForExport(slug, agentId, files), contextScope, companyName, projectName });
  } else bundle = buildPortableBundle(files, { agentName: a.config.name, exportedAt, changelog, contextScope, companyName, projectName });
  // Portal IA 3 · El paquete tiene que poder ejecutarse fuera: manifiesto, versiones fijadas, comprobación de entorno y
  // la herramienta con la que el Portal valida su trabajo. Todo pasa después por la misma validación (sin secretos ni rutas).
  {
    const { enrichBundle } = await import('./portablePackage.ts');
    const { bundleIdOf } = await import('./agentZipImport.ts');
    const dj = kind === 'external' ? await import('./documentJobs.ts') : null;
    const src = kind === 'external' ? (await import('./externalAgents.ts')).externalSource(slug, agentId) : null;
    const enriched = await enrichBundle(bundle, { agentId, name: a.config.name, kind, exportedAt, bundleId: bundleIdOf(agentId), sourceRoot: sourceRoot ?? null, grants: src ? { runScripts: !!src.grants.runScripts, writeDocuments: !!src.grants.writeDocuments } : null }, {
      probe: names => (dj ? dj.pythonPackageVersions(names) : Promise.resolve({ python: null, versions: {} })),
      validationTool: () => (dj ? dj.portalValidationTool() : null)
    });
    bundle = enriched.files; enrichWarnings = enriched.warnings; manifestOut = enriched.manifest;
  }
  // Nunca se entrega un ZIP parcial: cualquier problema (secreto, ruta local, dato interno o tamaño) niega TODO con 409.
  // EN-010 · En los externos, su carpeta original y la de datos del Portal son rutas privadas: nunca salen en el paquete.
  const privatePaths = kind === 'external'
    ? [...(sourceRoot ? [{ path: sourceRoot, kind: 'source' as const }] : []), ...(config.dataDir ? [{ path: config.dataDir, kind: 'portal-data' as const }] : [])]
    : undefined;
  const problems = validatePortableBundle(bundle, { forbidden: [a.id], limits: kind === 'external' ? EXTERNAL_BUNDLE_LIMITS : undefined, privatePaths });
  // Portal IA 3 · «¿Está listo para exportar?»: la MISMA preparación y validación que la descarga, sin generar el ZIP
  // ni registrar nada. Así lo que se enseña antes de exportar es exactamente lo que se exportará.
  if (opts.dryRun) {
    const names0 = Object.keys(bundle).sort();
    const excluded = kind === 'external'
      ? ['Tus documentos y entregables', 'La bandeja de entrada', 'Las dependencias instaladas (viajan sus versiones, no los archivos)', 'Copias de seguridad', 'Credenciales y datos internos del Portal']
      : ['El arnés, el modelo y los permisos (los decide quien lo use)', 'Memoria sin verificar', 'Credenciales y datos internos del Portal'];
    return { fileName: '', zip: Buffer.alloc(0), files: names0, readiness: { ok: problems.length === 0, kind, problems, files: names0, bytes: names0.reduce((n, k) => n + Buffer.byteLength(bundle[k]!, 'utf8'), 0), manifest: manifestOut, excluded, warnings: enrichWarnings } };
  }
  if (problems.length) {
    const list = problems.map(p => (p.path ? `${p.path}${p.line ? `:${p.line}` : ''} — ${p.message}` : p.message));
    const hint = problems.find(p => p.hint)?.hint;
    throw Object.assign(new Error(`No se puede exportar el paquete: ${list.slice(0, 5).join(' · ')}${list.length > 5 ? ` (y ${list.length - 5} más)` : ''}${hint ? `. ${hint}` : ''}`), { statusCode: 409, payload: { problems } });
  }
  const names = Object.keys(bundle);
  // Portal IA 3 · Marcador de exportación: permite que este paquete vuelva a SU agente y saber qué cambió fuera. No lleva
  // el id interno ni el nombre del espacio. Va fuera de la validación: lo escribe el Portal, no el agente.
  const { exportMarker, ZIP_EXPORT_MARKER } = await import('./agentZipImport.ts');
  const marker = exportMarker(a.id, base ?? { n: null, hash: null }, bundle, exportedAt);
  const zip = zipBuffers([...names.map(name => ({ name, data: Buffer.from(bundle[name]!, 'utf8') })), { name: ZIP_EXPORT_MARKER, data: Buffer.from(marker, 'utf8') }]);
  const fileName = `${slugify(a.config.name).slice(0, 60) || 'agente'}-paquete-portable.zip`;
  recordAgentEvent(slug, agentId, 'exported', { format: 'zip', files: names.length, bytes: zip.length });
  return { fileName, zip, files: names };
}

/** Copia la carpeta del agente a una carpeta elegida por el propietario (nunca sobrescribe). */
export async function exportTo(slug: string, agentId: string, destDir: string): Promise<string> {
  const dest = localDir(destDir);
  const inside = (root: string) => { let r0 = root; try { r0 = fs.realpathSync.native(root); } catch { /* tal cual */ } const r = path.relative(r0.toLowerCase(), dest.toLowerCase()); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  if (inside(REPO_ROOT)) throw Object.assign(new Error('Elige una carpeta fuera de la instalación del Portal.'), { statusCode: 403 });
  const { folder, files } = await exportFiles(slug, agentId);
  const target = path.join(dest, folder);
  if (fs.existsSync(target)) throw Object.assign(new Error(`Ya existe ${target}: elige otra carpeta (no se sobrescribe nada).`), { statusCode: 409 });
  // Creación exclusiva: nunca se sigue un enlace ni se sobrescribe nada que aparezca a la vez.
  fs.mkdirSync(target);
  for (const [rel, content] of Object.entries(files)) { const p = path.join(target, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); if (fs.realpathSync.native(path.dirname(p)).toLowerCase().indexOf(fs.realpathSync.native(target).toLowerCase()) !== 0) throw Object.assign(new Error('Ruta de exportación no válida.'), { statusCode: 400 }); fs.writeFileSync(p, content, { encoding: 'utf8', flag: 'wx' }); }
  recordAgentEvent(slug, agentId, 'exported', { to: target });
  return target;
}
