import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BacklogItem, KnowledgeDoc, PhaseTransition, PhaseTransitionPreview, PreservedCounts, Process, ProjectArchive } from '@portal-ia/domain';
import { INTERNAL_WORKSPACE } from '@portal-ia/domain';
import { platform } from '../db/platform.ts';
import { agentsRepo, backlogRepo, knowledgeRepo, processesRepo, projectsRepo, workspaceDb } from '../db/workspace.ts';
import { REPO_ROOT } from '../config.ts';
import { expandHome } from '../routes/fs.ts';
import { isActiveJob } from './activeJobs.ts';
import { requirePolicy } from './executionPolicy.ts';
import { decisionsFromProcess } from './inbox.ts';
import { lessonsRepo } from './lessons.ts';
import { repoStatus } from './repoStatus.ts';
import { VERSION } from './system.ts';
import { runGit } from './worktree.ts';
import { monotonicNow } from '../clock.ts';

/**
 * Etapas operativas: empezar de cero el trabajo ACTIVO sin perder el conocimiento de la organización.
 *
 * Iniciar una etapa (solo el propietario, con autorización explícita y sin procesos en ejecución):
 *  - marca como archivadas (`archived_at`, `archive_id`) todas las historias y procesos activos del proyecto. Nada se
 *    borra: las filas, sus pasos, conversaciones, tareas, feedback, costos y lecciones siguen en la base; solo salen del
 *    flujo activo (backlog, actividad, bandeja, panel, recomendaciones del asistente);
 *  - escribe en Conocimiento una línea base versionada (docs/linea-base.md del repositorio + estado git y organizativo
 *    leído en ese momento, sin IA), separando hechos verificados de propuestas históricas;
 *  - registra la transición (quién, cuándo, commit, qué se archivó, qué se conservó).
 * No toca git (ni ramas, ni worktrees, ni merges), ni agentes, ni lecciones, ni presupuestos, ni el historial de uso.
 * Es reversible: «revertir» devuelve al flujo activo exactamente lo que archivó esa transición; una historia concreta
 * también puede restaurarse desde el archivo.
 */
export const DEFAULT_PHASE_NAME = 'Portal IA — Inicio de operación organizada';
const BASELINE_PREFIX = 'Línea base';
const now = monotonicNow;

export const isBaselineDoc = (d: Pick<KnowledgeDoc, 'title'>) => d.title.startsWith(BASELINE_PREFIX);

function ensureTables(slug: string) {
  const db = workspaceDb(slug);
  db.exec(`CREATE TABLE IF NOT EXISTS phase_transitions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, started_at TEXT NOT NULL, started_by TEXT NOT NULL,
    git_head TEXT, git_branch TEXT, baseline_doc_id TEXT, summary_json TEXT NOT NULL, reverted_at TEXT, revert_reason TEXT
  )`);
  return db;
}

const mapTransition = (r: any): PhaseTransition => ({ id: r.id, projectId: r.project_id, name: r.name, startedAt: r.started_at, startedBy: r.started_by, gitHead: r.git_head, gitBranch: r.git_branch, baselineDocId: r.baseline_doc_id, summary: JSON.parse(r.summary_json), revertedAt: r.reverted_at, revertReason: r.revert_reason });

export function listTransitions(slug: string, projectId: string): PhaseTransition[] {
  return (ensureTables(slug).prepare(`SELECT * FROM phase_transitions WHERE project_id = ? ORDER BY started_at DESC`).all(projectId) as any[]).map(mapTransition);
}

/** Etapa vigente: la última transición no revertida. */
export function currentPhase(slug: string, projectId: string): PhaseTransition | null {
  return listTransitions(slug, projectId).find(t => !t.revertedAt) ?? null;
}

function countRows(db: { prepare: (s: string) => any }, table: string, where = '', ...args: any[]): number {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  if (!exists) return 0;
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`).get(...args) as any).n);
}

export function preservedCounts(slug: string, projectId: string): PreservedCounts {
  const db = workspaceDb(slug);
  const lessons = lessonsRepo(slug).list(projectId);
  const cost = db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM execution_history`).get() as any;
  return {
    agents: countRows(db, 'agents'),
    knowledgeDocs: countRows(db, 'knowledge', 'project_id = ?', projectId),
    lessonsValidated: lessons.filter(l => l.status === 'validated').length,
    lessonsPending: lessons.filter(l => l.status === 'detected' || l.status === 'proposed').length,
    lessonsOther: lessons.filter(l => l.status !== 'validated' && l.status !== 'detected' && l.status !== 'proposed').length,
    templates: countRows(db, 'agent_templates'),
    storyMessages: countRows(db, 'story_threads'),
    storyTasks: countRows(db, 'story_tasks'),
    manualTestFeedback: countRows(db, 'manual_test_feedback'),
    assistantMessages: countRows(platform, 'assistant_messages'),
    executionHistory: countRows(db, 'execution_history'),
    recordedCostUsd: Number(cost.c ?? 0)
  };
}

function repoPathOf(slug: string, projectId: string): string | null {
  const repo = projectsRepo(slug).repository(projectId);
  return repo ? path.resolve(expandHome(repo.path)) : null;
}

async function gitSnapshot(repoPath: string | null): Promise<PhaseTransitionPreview['git']> {
  const empty = { repoPath, branch: null, head: null, headSubject: null, dirty: null, aheadOfRemote: null, unmergedBranches: [], worktrees: [] };
  if (!repoPath || !fs.existsSync(repoPath)) return empty;
  try {
    const st = await repoStatus(repoPath);
    if (!st.isGit) return empty;
    const main = st.mainBranch ?? 'main';
    const headSubject = (await runGit(repoPath, ['log', '-1', '--format=%s']).catch(() => '')).trim() || null;
    const unmergedBranches: { name: string; ahead: number }[] = [];
    for (const b of st.storyBranches) {
      const ahead = parseInt((await runGit(repoPath, ['rev-list', '--count', `${main}..${b}`]).catch(() => '0')).trim(), 10) || 0;
      if (ahead > 0) unmergedBranches.push({ name: b, ahead });
    }
    const worktrees: { path: string; branch: string | null; dirty: boolean }[] = [];
    const porcelain = await runGit(repoPath, ['worktree', 'list', '--porcelain']).catch(() => '');
    for (const block of porcelain.split(/\n\s*\n/)) {
      const wt = block.match(/^worktree (.+)$/m)?.[1]?.trim(); if (!wt || path.resolve(wt).toLowerCase() === repoPath.toLowerCase()) continue;
      const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1]?.trim() ?? null;
      const dirty = fs.existsSync(wt) ? (await runGit(wt, ['status', '--porcelain']).catch(() => '')).trim().length > 0 : false;
      worktrees.push({ path: wt, branch, dirty });
    }
    return { repoPath, branch: st.branch, head: st.headCommit, headSubject, dirty: st.dirty, aheadOfRemote: st.aheadOfRemote, unmergedBranches, worktrees };
  } catch { return empty; }
}

const tally = (xs: string[]) => xs.reduce<Record<string, number>>((acc, k) => { acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});

/** Texto estático de la línea base: docs/linea-base.md del repositorio del proyecto (o de esta instalación en el espacio interno). */
function staticBaseline(slug: string, projectId: string): string {
  const candidates = [repoPathOf(slug, projectId), slug === INTERNAL_WORKSPACE.slug ? REPO_ROOT : null].filter(Boolean) as string[];
  for (const root of candidates) {
    const f = path.join(root, 'docs', 'linea-base.md');
    try { if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').trim(); } catch { /* siguiente */ }
  }
  return '';
}

/** Línea base completa (sin IA): documento del repositorio + estado leído ahora, con la procedencia de cada parte. */
export function buildBaseline(slug: string, projectId: string, name: string, git: PhaseTransitionPreview['git'], archived: { stories: BacklogItem[]; processes: Process[] }, preserved: PreservedCounts, at: string): string {
  const project = projectsRepo(slug).get(projectId)!;
  const objectives = projectsRepo(slug).objectives(projectId).map(o => o.text);
  const agents = agentsRepo(slug).list().filter(a => a.scope === 'workspace' || a.projectId === projectId);
  const byKey = new Map(agents.map(a => [a.key, a.config.name]));
  const validated = lessonsRepo(slug).list(projectId, 'validated');
  const done = archived.stories.filter(s => s.status === 'done');
  const integrated = archived.processes.filter(p => p.kind === 'story_execution' && p.result?.merged);
  const lines: string[] = [];
  lines.push(`# ${BASELINE_PREFIX} del proyecto «${project.name}» · ${name}`);
  lines.push('');
  lines.push(`Registrada el ${at.slice(0, 10)} al iniciar la etapa «${name}», por decisión del propietario. Documento generado sin IA. Procedencia: (A) datos leídos de git y de la base del Portal en ese momento; (B) el documento versionado \`docs/linea-base.md\` del repositorio; (C) registro histórico de la etapa anterior. Solo (A) y (B) son hechos verificados; (C) son propuestas y planes históricos, no prueba de funcionalidad.`);
  lines.push('');
  lines.push('**El backlog activo empieza vacío en esta etapa. Eso NO significa que el proyecto no tenga implementación: el código existente en la rama principal es la base verificada sobre la que se trabaja.**');
  lines.push('');
  lines.push('## (A) Estado verificado al iniciar la etapa');
  lines.push('');
  lines.push(`- Versión del Portal: ${VERSION}.`);
  lines.push(`- Repositorio: ${git.repoPath ?? 'no registrado'}${git.branch ? ` · rama ${git.branch}` : ''}${git.head ? ` · HEAD \`${git.head.slice(0, 12)}\`${git.headSubject ? ` («${git.headSubject}»)` : ''}` : ''}${git.aheadOfRemote ? ` · ${git.aheadOfRemote} commit(s) sin publicar` : git.aheadOfRemote === 0 ? ' · sincronizada con el remoto' : ''}${git.dirty ? ' · con cambios sin confirmar' : ''}.`);
  lines.push(`- Ramas de historia con commits fuera de la rama principal (conservadas, no integradas): ${git.unmergedBranches.length ? git.unmergedBranches.map(b => `${b.name} (+${b.ahead})`).join(', ') : 'ninguna'}.`);
  lines.push(`- Worktrees de procesos: ${git.worktrees.length ? git.worktrees.map(w => `${w.path}${w.dirty ? ' (con cambios)' : ''}`).join(', ') : 'ninguno'}.`);
  lines.push(`- Objetivos del proyecto: ${objectives.length ? objectives.join(' · ') : '—'}.`);
  lines.push(`- Conservado: ${preserved.agents} agentes, ${preserved.knowledgeDocs} documentos de conocimiento, ${preserved.lessonsValidated} lecciones validadas (${preserved.lessonsPending} pendientes de revisar, que NO son conocimiento validado), ${preserved.templates} plantillas, ${preserved.storyMessages} mensajes de historias, ${preserved.assistantMessages} mensajes del asistente, ${preserved.executionHistory} registros de uso (${preserved.recordedCostUsd.toFixed(2)} USD registrados).`);
  lines.push('');
  lines.push('### Organización actual (agentes, papeles y jerarquía)');
  for (const a of agents) {
    const tools = Object.entries(a.config.tools ?? {}).filter(([, v]) => v).map(([k]) => k);
    const reports = a.template.reportsTo === 'owner' ? 'el propietario' : byKey.get(a.template.reportsTo) ?? a.template.reportsTo;
    lines.push(`- ${a.config.name} (${a.template.role}; clave ${a.key}; ${a.scope === 'workspace' ? 'espacio' : 'proyecto'}; reporta a ${reports}; modelo ${a.config.model}${a.templateVersion ? `; plantilla ${a.templateVersion}` : ''}${tools.length ? `; herramientas: ${tools.join(', ')}` : ''}).`);
  }
  lines.push('');
  lines.push('### Lecciones validadas (vigentes; se inyectan en los prompts por papel)');
  lines.push(validated.length ? validated.map(l => `- ${l.title}${l.role ? ` [${l.role}]` : ''}: ${(l.lessonText ?? l.correctiveAction ?? '').replace(/\s+/g, ' ').slice(0, 300)}`).join('\n') : '- (ninguna validada todavía)');
  lines.push('');
  const st = staticBaseline(slug, projectId);
  if (st) { lines.push('## (B) Línea base versionada del repositorio (docs/linea-base.md)'); lines.push(''); lines.push(st.replace(/^# .*\n+/, '')); lines.push(''); }
  lines.push('## (C) Registro histórico de la etapa anterior (archivado, consultable)');
  lines.push('');
  lines.push(`Se archivaron ${archived.stories.length} historias (${Object.entries(tally(archived.stories.map(s => s.status))).map(([k, v]) => `${v} ${k}`).join(', ') || 'ninguna'}) y ${archived.processes.length} procesos. No son trabajo pendiente. Su contenido es histórico: describe lo que se planificó o se intentó, no garantiza qué está implementado; lo implementado es lo que está en la rama principal (A).`);
  if (done.length) lines.push(`Historias cerradas en la etapa anterior: ${done.map(s => `${s.storyId} ${s.title}`).join(' · ').slice(0, 3000)}.`);
  if (integrated.length) lines.push(`Procesos integrados en la rama principal: ${integrated.map(p => p.title).join(' · ').slice(0, 2000)}.`);
  return lines.join('\n');
}

export async function previewTransition(slug: string, projectId: string, name = DEFAULT_PHASE_NAME): Promise<PhaseTransitionPreview> {
  if (!projectsRepo(slug).get(projectId)) throw Object.assign(new Error('Proyecto no encontrado'), { statusCode: 404 });
  const stories = backlogRepo(slug).list(projectId);
  const procs = processesRepo(slug).list(projectId);
  const running = procs.filter(p => p.status === 'running');
  const git = await gitSnapshot(repoPathOf(slug, projectId));
  const preserved = preservedCounts(slug, projectId);
  const blockers: string[] = [];
  if (running.length) blockers.push(`Hay ${running.length} proceso(s) marcados en ejecución. Cancélalo(s) desde su pantalla (tu decisión) o espera a que terminen; un proceso en marcha no se archiva.`);
  return {
    phaseName: name, current: currentPhase(slug, projectId),
    stories: { total: stories.length, byStatus: tally(stories.map(s => s.status)) },
    processes: { total: procs.length, byStatus: tally(procs.map(p => p.status)) },
    pendingDecisions: procs.flatMap(p => decisionsFromProcess(slug, p)).map(d => ({ kind: d.kind, processId: d.processId, title: d.title })),
    running: running.map(p => ({ id: p.id, title: p.title, orphan: !isActiveJob(p.id) })),
    git, preserved,
    baselinePreview: buildBaseline(slug, projectId, name, git, { stories, processes: procs }, preserved, now()),
    canStart: blockers.length === 0, blockers
  };
}

/** Inicia la etapa: archiva lo activo (reversible), registra la línea base y la transición. Autorizado por el propietario. */
export async function startPhase(slug: string, projectId: string, opts: { name?: string; authorized?: boolean }): Promise<PhaseTransition> {
  const name = (opts.name ?? '').trim() || DEFAULT_PHASE_NAME;
  requirePolicy('phase_transition', { slug, projectId, authorized: opts.authorized === true });
  const preview = await previewTransition(slug, projectId, name);
  if (!preview.canStart) throw Object.assign(new Error(preview.blockers.join(' ')), { statusCode: 409, code: 'running_processes', running: preview.running });
  const db = ensureTables(slug);
  const id = crypto.randomUUID(); const at = now();
  const stories = backlogRepo(slug).list(projectId);
  const procs = processesRepo(slug).list(projectId);
  const prevBaselines = knowledgeRepo(slug).list(projectId).filter(isBaselineDoc).length;
  const body = buildBaseline(slug, projectId, name, preview.git, { stories, processes: procs }, preview.preserved, at);
  const title = `${BASELINE_PREFIX} · ${name} (v${VERSION}${preview.git.head ? `, ${preview.git.head.slice(0, 7)}` : ''})`;
  const summary = {
    archivedStories: stories.map(s => ({ id: s.id, storyId: s.storyId, title: s.title, status: s.status })),
    archivedProcesses: procs.map(p => ({ id: p.id, title: p.title, kind: p.kind, status: p.status })),
    clearedDecisions: preview.pendingDecisions, preserved: preview.preserved, unmergedBranches: preview.git.unmergedBranches, version: VERSION
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    // Dentro de la transacción: si un proceso empezó entre la vista previa y aquí, no se archiva y se aborta.
    const runningNow = db.prepare(`SELECT COUNT(*) AS n FROM processes WHERE project_id = ? AND archived_at IS NULL AND status = 'running'`).get(projectId) as any;
    if (Number(runningNow.n) > 0) throw Object.assign(new Error('Un proceso empezó a ejecutarse: vuelve a revisar la vista previa.'), { statusCode: 409, code: 'running_processes' });
    db.prepare(`UPDATE backlog_items SET archived_at = ?, archive_id = ? WHERE project_id = ? AND archived_at IS NULL`).run(at, id, projectId);
    db.prepare(`UPDATE processes SET archived_at = ?, archive_id = ? WHERE project_id = ? AND archived_at IS NULL AND status <> 'running'`).run(at, id, projectId);
    const doc = knowledgeRepo(slug).add({ projectId, title, body, authorAgentId: null, authorAgentName: 'Portal IA (registro sin IA)', processId: null, version: prevBaselines + 1 });
    db.prepare(`INSERT INTO phase_transitions (id, project_id, name, started_at, started_by, git_head, git_branch, baseline_doc_id, summary_json) VALUES (?, ?, ?, ?, 'owner', ?, ?, ?, ?)`)
      .run(id, projectId, name, at, preview.git.head, preview.git.branch, doc.id, JSON.stringify(summary));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return listTransitions(slug, projectId).find(t => t.id === id)!;
}

/** Revierte la etapa vigente: lo que ESA transición archivó vuelve al flujo activo. La línea base queda en Conocimiento. */
export function revertPhase(slug: string, projectId: string, transitionId: string, opts: { authorized?: boolean; reason?: string }): PhaseTransition {
  requirePolicy('phase_transition', { slug, projectId, authorized: opts.authorized === true });
  const cur = currentPhase(slug, projectId);
  if (!cur || cur.id !== transitionId) throw Object.assign(new Error('Solo se puede revertir la etapa vigente.'), { statusCode: 409, code: 'not_current' });
  const db = ensureTables(slug); const at = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE backlog_items SET archived_at = NULL, archive_id = NULL WHERE archive_id = ?`).run(transitionId);
    db.prepare(`UPDATE processes SET archived_at = NULL, archive_id = NULL WHERE archive_id = ?`).run(transitionId);
    db.prepare(`UPDATE phase_transitions SET reverted_at = ?, revert_reason = ? WHERE id = ?`).run(at, (opts.reason ?? '').slice(0, 500) || null, transitionId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return listTransitions(slug, projectId).find(t => t.id === transitionId)!;
}

/** Devuelve UNA historia archivada (y sus procesos de la misma transición) al backlog activo. Mantiene su id. */
export function restoreStory(slug: string, itemId: string, opts: { authorized?: boolean }): BacklogItem {
  const it = backlogRepo(slug).get(itemId);
  if (!it) throw Object.assign(new Error('Historia no encontrada'), { statusCode: 404 });
  if (!it.archivedAt) throw Object.assign(new Error('La historia no está archivada.'), { statusCode: 409, code: 'not_archived' });
  requirePolicy('phase_transition', { slug, projectId: it.projectId, authorized: opts.authorized === true });
  const db = workspaceDb(slug);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE processes SET archived_at = NULL, archive_id = NULL WHERE backlog_item_id = ? AND archive_id IS ?`).run(it.id, it.archiveId ?? null);
    db.prepare(`UPDATE backlog_items SET archived_at = NULL, archive_id = NULL, description = ?, updated_at = ? WHERE id = ?`)
      .run(`${it.description ? it.description + '\n' : ''}[${now().slice(0, 10)}] Restaurada desde el archivo por el propietario.`, now(), it.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return backlogRepo(slug).get(it.id)!;
}

export function projectArchive(slug: string, projectId: string): ProjectArchive {
  return { transitions: listTransitions(slug, projectId), stories: backlogRepo(slug).listArchived(projectId), processes: processesRepo(slug).listArchived(projectId) };
}

/**
 * Contexto de etapa para los prompts de los agentes y del asistente: la etapa vigente y su línea base, para que un
 * backlog vacío no se confunda con un proyecto sin implementación. Vacío si no hay etapa.
 */
export function phaseContext(slug: string, projectId: string, maxChars = 8000): string {
  let cur: PhaseTransition | null = null;
  try { cur = currentPhase(slug, projectId); } catch { return ''; }
  if (!cur) return '';
  const doc = cur.baselineDocId ? knowledgeRepo(slug).get(cur.baselineDocId) : undefined;
  const head = `# Etapa vigente: «${cur.name}» (desde ${cur.startedAt.slice(0, 10)}, iniciada por el propietario)
El trabajo activo se reinició al empezar esta etapa: ${cur.summary.archivedStories.length} historias y ${cur.summary.archivedProcesses.length} procesos de la etapa anterior están ARCHIVADOS (histórico consultable, no son trabajo pendiente; no los propongas para ejecutar salvo que el propietario los restaure). El proyecto SÍ tiene implementación: el código de la rama principal${cur.gitHead ? ` (commit ${cur.gitHead.slice(0, 7)} al iniciar la etapa)` : ''} es la base verificada. Los nuevos ids de historia continúan la numeración; nunca reutilices uno archivado.`;
  if (!doc) return head;
  const room = Math.max(0, maxChars - head.length - 120);
  return `${head}\n## Línea base («${doc.title}», en Conocimiento)\n${doc.body.length > room ? `${doc.body.slice(0, room)}\n…(continúa en Conocimiento)` : doc.body}`;
}

/** Para el asistente global: etapa de cada proyecto de cada empresa (sin cuerpo completo). */
export function phaseLine(slug: string, projectId: string): string | null {
  try { const cur = currentPhase(slug, projectId); return cur ? `Etapa vigente «${cur.name}» desde ${cur.startedAt.slice(0, 10)}; ${cur.summary.archivedStories.length} historias y ${cur.summary.archivedProcesses.length} procesos de la etapa anterior archivados (no son trabajo pendiente).` : null; } catch { return null; }
}
