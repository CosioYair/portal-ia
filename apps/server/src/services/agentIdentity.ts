import { parseSkillHeader, type Agent } from '@portal-ia/domain';
import { agentFoldersRepo, extrasFromFiles, hasOwnInstructions, memoryOf } from './agentFolders.ts';
import { sourcesRepo } from './externalAgents.ts';

/**
 * Bloque de identidad portable que se añade al prompt de sistema de un agente: sus instrucciones propias (AGENTS.md),
 * sus habilidades y su memoria verificada, de UNA revisión concreta (la fijada al crear el trabajo, o la adoptada).
 * - Vacío si el agente no tiene contenido propio: los prompts de los agentes existentes no cambian.
 * - Acotado (~10 000 caracteres): las habilidades van con nombre, descripción y un extracto; la memoria, las entradas más
 *   recientes. El contenido es del propietario (escrito o revisado y adoptado por él) y NO amplía permisos: se dice.
 */
export const IDENTITY_MAX_CHARS = 10_000;
const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n)}…` : s;

export function identityParts(slug: string, agent: Agent, revision: number | null, sourceRevision: number | null = null): { instructions: string; skills: string[]; memory: string[] } {
  const ext = externalParts(slug, agent, sourceRevision);
  if (ext) return ext;
  const repo = agentFoldersRepo(slug);
  const files = revision ? repo.revisionFiles(agent.id, revision) : repo.adopted(agent.id)?.files ?? null;
  const extras = files ? extrasFromFiles(files) : null;
  const instructions = extras && hasOwnInstructions(extras.instructions) ? extras.instructions.trim() : '';
  const skills = (extras?.skills ?? []).map(s => `- **${s.name}**${s.description ? `: ${s.description}` : ''}${s.body ? `\n  ${clip(s.body.replace(/^#.*\n+/, '').replace(/\n+/g, ' '), 600)}` : ''}`);
  // La memoria verificada es la vigente (se valida en el Portal); su procedencia va con cada entrada.
  const memory = memoryOf(slug, agent.id).slice(-12).map(m => `- ${m.title}: ${clip(m.text.replace(/\n+/g, ' '), 400)} (origen: ${m.source})`);
  return { instructions, skills, memory };
}

export function identityBlock(slug: string, agent: Agent, revision: number | null, sourceRevision: number | null = null): string {
  let p: ReturnType<typeof identityParts>;
  try { p = identityParts(slug, agent, revision, sourceRevision); } catch { return ''; }
  if (!p.instructions && !p.skills.length && !p.memory.length) return '';
  const parts: string[] = ['\n\n# Tu identidad portable (definida por el propietario; no amplía tus permisos ni sustituye las reglas del Portal)'];
  if (p.instructions) parts.push(`## Instrucciones\n${clip(p.instructions, 5000)}`);
  if (p.skills.length) parts.push(`## Habilidades\n${p.skills.join('\n')}`);
  if (p.memory.length) parts.push(`## Aprendizaje verificado por el propietario (aplícalo)\n${p.memory.join('\n')}`);
  return clip(parts.join('\n\n'), IDENTITY_MAX_CHARS);
}

/**
 * Agente externo (referencia gestionada): su identidad es la INSTANTÁNEA ADOPTADA de su carpeta original (AGENTS.md y
 * contexto, sus habilidades y su memoria propia), nunca lo que haya en disco sin adoptar. El adaptador CLAUDE.md no se
 * inyecta (solo apunta a AGENTS.md). Más la memoria verificada en el Portal.
 */
function externalParts(slug: string, agent: Agent, sourceRevision: number | null): { instructions: string; skills: string[]; memory: string[] } | null {
  let src: ReturnType<ReturnType<typeof sourcesRepo>['get']>; let files: Record<string, string> | null;
  // Revisión fijada al autorizar un encargo (si la hay): un cambio posterior no altera ese encargo en silencio.
  try { const r = sourcesRepo(slug); src = r.get(agent.id); files = src ? (sourceRevision ? r.files(agent.id, sourceRevision) : null) ?? r.files(agent.id) : null; } catch { return null; }
  if (!src || !files) return null;
  const f = files;
  const oneLine = (t: string) => t.replace(/\n+/g, ' ');
  const context = src.layout.context.map(p => `### ${p}\n${clip(f[p] ?? '', 1500)}`).join('\n\n');
  const instructions = `${clip((f['AGENTS.md'] ?? '').trim(), 3500)}${context ? `\n\n## Contexto\n${context}` : ''}`;
  const skills = src.layout.skills.map(s => {
    const body = f[s.path] ?? ''; const h = parseSkillHeader(body);
    const text = body.replace(/^---[\s\S]*?---\s*/, '').replace(/^#.*\n+/, '');
    return `- **${h.name ?? s.slug}**${h.version ? ` (versión ${h.version})` : ''}${h.description ? `: ${h.description}` : ''}\n  ${clip(oneLine(text), 700)}`;
  });
  const own = src.layout.memory ? (f[src.layout.memory] ?? '').trim() : '';
  const memory = [
    ...(own ? [`- Memoria propia del agente (${src.layout.memory}, final): ${clip(oneLine(own.slice(-1800)), 1800)}`] : []),
    ...memoryOf(slug, agent.id).slice(-8).map(m => `- ${m.title}: ${clip(oneLine(m.text), 400)} (origen: ${m.source})`)
  ];
  return { instructions, skills, memory };
}

