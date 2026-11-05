import fs from 'node:fs';
import path from 'node:path';
import { CAPABILITIES, KNOWLEDGE, TOOLS, definitionToFiles, filesToDefinition, slugify, type Agent, type AgentConfig, type Capability, type ExecutionBackend, type PortableFiles, type PortableKnowledge, type PortableSkill, type ProviderId, type ReasoningEffort, clampEffort } from '@portal-ia/domain';
import { config, REPO_ROOT } from '../config.ts';
import { agentsRepo, projectsRepo } from '../db/workspace.ts';
import { departmentsRepo } from './departments.ts';
import { agentFoldersRepo, definitionFor, defaultInstructions, hashFiles, readFolder, registerAgentFolder, writeRevision, adoptedExtras, type AgentExtras } from './agentFolders.ts';
import { harnessAvailability, harnessModels } from './harness/index.ts';
import { inheritLatestTemplate } from './agentTemplates.ts';
import { recordAgentEvent } from './agentEvents.ts';
import { lessonsRepo } from './lessons.ts';
import { expandHome, isAllowed } from '../routes/fs.ts';
import { monotonicNow } from '../clock.ts';

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

export async function createAgentFromWizard(slug: string, i: WizardInput, source: 'created' | 'import' = 'created', importNote = 'Importado desde una carpeta (revisado por el propietario)'): Promise<Agent> {
  const { provider } = validate(slug, i);
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
  const agent = inheritLatestTemplate(slug, created);
  // Carpeta portable: identidad + lo propio (instrucciones, habilidades, referencias, entregables, autonomía).
  registerAgentFolder(slug, agent);
  const extras: AgentExtras = {
    instructions: i.instructions?.trim() ? i.instructions.trim() : defaultInstructions(cfg.name, cfg.specialization),
    skills: (i.skills ?? []).map(s => ({ ...s, slug: slugify(s.slug || s.name).slice(0, 60) })), memory: [], knowledge: (i.references ?? []).map(k => ({ ...k, slug: slugify(k.slug || k.title).slice(0, 60) })),
    deliverables: i.deliverables.map(d => d.trim()).filter(Boolean).slice(0, 20), autonomy: i.autonomy,
    changelog: i.changelog?.trim() ? i.changelog : undefined
  };
  await writeRevision(slug, agent.id, definitionToFiles(definitionFor(slug, agent, extras)), source === 'import' ? 'import' : 'created', source === 'import' ? importNote : 'Creado con el asistente de la oficina');
  recordAgentEvent(slug, agent.id, source === 'import' ? 'imported' : 'created', { harness: i.harness, model: i.model, department: dep.name, tools: i.tools, autonomy: i.autonomy, scope: i.scope });
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
export async function importFromFiles(slug: string, files: PortableFiles, origin: string, grant: ImportGrant, note = 'Importado desde una carpeta (revisado por el propietario)'): Promise<Agent> {
  const parsed = filesToDefinition(files);
  if (!parsed.definition || parsed.problems.some(p => p.blocking)) throw Object.assign(new Error(`No se puede importar: ${parsed.problems.filter(p => p.blocking).map(p => `${p.path} — ${p.message}`).join(' · ')}`), { statusCode: 400 });
  const d = parsed.definition;
  const agent = await createAgentFromWizard(slug, {
    ...grant, name: d.manifest.name, role: d.manifest.role, summary: d.manifest.summary, responsibilities: d.manifest.responsibilities, deliverables: d.manifest.deliverables,
    capabilities: grant.capabilities ?? [],
    instructions: d.instructions, skills: d.skills, references: d.knowledge, initials: d.manifest.initials, changelog: d.changelog ?? null
  }, 'import', note);
  // La memoria de la carpeta llega como PROPUESTA (el propietario la verifica o la descarta).
  const lessons = lessonsRepo(slug); const ts = monotonicNow();
  for (const m of d.memory.slice(0, 50)) {
    const l = lessons.insert({ projectId: null, role: null, tags: ['importada'], status: 'proposed', version: 1, parentId: null, title: m.title.slice(0, 120) || 'Aprendizaje importado', detector: 'import', evidence: { processId: null, processTitle: null, stepId: null, agentId: agent.id, agentName: agent.config.name, file: null, detail: `Importado de ${origin} (${m.source || 'sin origen'}) el ${ts.slice(0, 10)}; sin verificar.`, at: ts }, rootCause: null, correctiveAction: null, lessonText: m.text, source: 'import', promotedTo: null, dedupeKey: null, agentId: agent.id });
    void l;
  }
  return agent;
}

/** Archivos de la revisión adoptada (o la que se generaría) para descargar como paquete. */
export async function exportFiles(slug: string, agentId: string): Promise<{ folder: string; files: PortableFiles }> {
  const a = agentsRepo(slug).get(agentId); if (!a) throw Object.assign(new Error('Agente no encontrado'), { statusCode: 404 });
  const f = agentFoldersRepo(slug).folderOf(agentId);
  const ad = f ? agentFoldersRepo(slug).adopted(agentId) : null;
  const files = ad?.files ?? definitionToFiles(definitionFor(slug, a, adoptedExtras(slug, a)));
  return { folder: f?.folder ?? slugify(`${a.key}-${a.id.slice(0, 8)}`), files };
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
