import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { Agent, CheckState, CompletenessGate, Deliverable, DeliverableKind, DeliveryCheck, DeliveryProgress, DevOutputAssessment, IssueSeverity, PipelineConfig, Process, ProposedChange, QaFinding, StoryManifest, StoryPlan, VerificationRun, WorkUnit } from '@portal-ia/domain';
import { estimatePricing } from '@portal-ia/ai-adapters';
import { processesRepo } from '../db/workspace.ts';
import { clip, type ParsedDevOutput } from './devOutput.ts';
import { diagnosticsFor, filesIn } from './diagnostics.ts';
import { requirePolicy } from './executionPolicy.ts';
import { applyChanges, changesSinceBase, commitInWorktree, hashText, readRepoFile, safeRelPath } from './repoWrite.ts';
import { diagnoseFailure, diagnosisPrompt, failingTests, staleCorrectionUnits } from './failureDiagnosis.ts';
import { verificationEvidence, zeroTests } from './qaGate.ts';
import { DEV_MAX_TOKENS, DROP_FORMAT, FILE_FORMAT, PATCH_ONLY_FORMAT, UNIT_FORMAT, sys } from './storyPrompts.ts';
import { agentHeadroom, attemptsSummary, checkCancelled, checkDuration, emit, isTruncatedStop, pickConsultant, PipelinePause, pipelineOf, settleUnit, sinceApplied, retryForeignFailure, stepCall, updatePipeline, updateResult, verifyStage, type DevOutput, type Settled, type StoryRunCtx } from './storyPipeline.ts';

/**
 * Entrega INCREMENTAL de una historia (pipeline autorizado con aplicación automática).
 *
 * Antes (HU-155) el Desarrollador debía entregar la historia entera en UNA respuesta: con 8 archivos y el razonamiento
 * oculto del modelo consumiendo la misma salida, la respuesta se cortaba; la «reparación» pedía solo el archivo cortado
 * (los que nunca empezó se perdían), QA pagaba por descubrir lo que faltaba y cada corrección volvía a reescribir archivos
 * enteros hasta cortarse otra vez.
 *
 * Ahora el plan del Coordinador se convierte en un MANIFIESTO de entregables y en UNIDADES de trabajo acotadas (un
 * archivo, unos pocos relacionados o una pieza verificable), cada una dimensionada para caber holgadamente en una
 * respuesta. Cada unidad se aplica en el worktree en cuanto llega (commit propio): es un punto de control duradero que
 * sobrevive a reinicios y que nunca se regenera. Una respuesta cortada se CONTINÚA por el archivo cortado (contador
 * propio); un fallo de formato se repara dentro de la unidad; las correcciones de QA y de la verificación son unidades
 * DIRIGIDAS (solo los archivos y hallazgos afectados, con parches). Antes de pagar a QA, una comprobación determinista
 * mira lo que el motor ya sabe (entregables que faltan, JSON roto, contenido omitido, pruebas que el script no ejecuta).
 */

const now = () => new Date().toISOString();
const TOKENS_PER_LINE = 12;
/** Texto previsto por unidad (tokens): deja sitio al razonamiento oculto y al formato dentro de una sola respuesta. */
export const UNIT_TEXT_BUDGET = 6000;
const KIND_LINES: Record<DeliverableKind, number> = { code: 160, test: 120, docs: 80, config: 20 };
const RANK: Record<DeliverableKind, number> = { code: 0, config: 1, test: 2, docs: 3 };
const LABEL: Record<DeliverableKind, string> = { code: 'Código', config: 'Configuración', test: 'Pruebas', docs: 'Documentación' };
const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/i;
const clean = (p: string) => p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^[`'"]+|[`'"]+$/g, '');
const base = (p: string) => p.split('/').pop() ?? p;

/** Punto de entrada de pruebas (lo que el script «test» debe ejecutar); un ayudante o un fixture en test/ no lo es. */
export const isTestEntry = (p: string) => /\.(test|spec)\.[cm]?[jt]sx?$/i.test(p);

export function kindOf(p: string): DeliverableKind {
  if (/(^|\/)(test|tests|__tests__)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$/i.test(p)) return 'test';
  if (/\.(md|mdx|txt|rst)$/i.test(p) || /^docs\//i.test(p)) return 'docs';
  if (/(^|\/)(package\.json|tsconfig[^/]*\.json|\.[^/]+rc)$|\.(json|ya?ml|toml)$|\.config\.[cm]?[jt]s$/i.test(p)) return 'config';
  return 'code';
}

// ---------------------------------------------------------------- Manifiesto y unidades

const manifestOf = (ctx: StoryRunCtx): StoryManifest => processesRepo(ctx.slug).get(ctx.processId)!.result!.manifest!;
const resultOf = (ctx: StoryRunCtx) => processesRepo(ctx.slug).get(ctx.processId)!.result!;
/** Lee-modifica-escribe el manifiesto (siempre desde el último estado guardado: es el punto de control). */
function saveManifest(ctx: StoryRunCtx, fn: (m: StoryManifest) => void) {
  updateResult(ctx.slug, ctx.processId, r => { const m: StoryManifest = JSON.parse(JSON.stringify(r.manifest)); fn(m); return { ...r, manifest: m }; });
}
const unitOf = (ctx: StoryRunCtx, id: string) => manifestOf(ctx).units.find(u => u.id === id)!;
function setUnit(ctx: StoryRunCtx, id: string, patch: Partial<WorkUnit> | ((u: WorkUnit) => void)) {
  saveManifest(ctx, m => { const u = m.units.find(x => x.id === id)!; if (typeof patch === 'function') patch(u); else Object.assign(u, patch); });
}
const worktreeOf = (ctx: StoryRunCtx) => { const wt = resultOf(ctx).applied?.worktree; return wt && fs.existsSync(wt) ? wt : null; };
const basePathOf = (ctx: StoryRunCtx) => worktreeOf(ctx) ?? ctx.repoPath;
const linesOf = (text: string | null) => text === null ? 0 : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length;

function purposeFor(file: string, tasks: string[], summary: string): string {
  const b = base(file).replace(/\.[^.]+$/, '').toLowerCase();
  return tasks.map(String).find(t => t.toLowerCase().includes(file.toLowerCase()) || t.toLowerCase().includes(b)) ?? String(summary).slice(0, 200);
}
/** Criterios de aceptación relacionados con la unidad (por vocabulario); si ninguno coincide, todos. */
function relevantAcceptance(acceptance: string[], text: string): string[] {
  const words = new Set((text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]{5,}/g) ?? []));
  const hit = acceptance.map(String).filter(a => (a.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]{5,}/g) ?? []).some(w => words.has(w)));
  return (hit.length ? hit : acceptance.map(String)).slice(0, 10);
}
/** Costo previsto de una llamada de unidad: entrada aproximada + texto previsto + la mitad del margen de razonamiento. */
function unitUsd(agent: Agent, inputTokens: number, outputTokens: number): number {
  const p = estimatePricing(agent.config.provider, agent.config.model);
  return (inputTokens * p.inPerM + (outputTokens + agentHeadroom(agent) * 0.5) * p.outPerM) / 1_000_000;
}
const unitMaxTokens = (u: WorkUnit) => Math.min(DEV_MAX_TOKENS, Math.max(4000, Math.ceil(u.estimatedOutputTokens * 1.6) + 1000));

function newUnit(ctx: StoryRunCtx, agent: Agent, id: string, u: Pick<WorkUnit, 'kind' | 'title' | 'purpose' | 'files' | 'dependsOn' | 'estimatedOutputTokens'> & Partial<WorkUnit>): WorkUnit {
  const plan = ctx.plan;
  const ctxChars = u.files.reduce((s, f) => s + Math.min(40_000, readRepoFile(basePathOf(ctx), f, 40_000)?.length ?? 0), 0) + 24_000;
  return {
    id, kind: u.kind, title: u.title.slice(0, 160), purpose: u.purpose.slice(0, 600), files: u.files, acceptance: u.acceptance ?? relevantAcceptance(plan?.acceptance ?? [], `${u.purpose} ${u.files.join(' ')}`), dependsOn: u.dependsOn,
    agentId: agent.id, agentName: agent.config.name, role: 'implementer', status: 'pending', attempts: 0, continuations: 0, repairs: 0,
    estimatedOutputTokens: u.estimatedOutputTokens, estimatedUsd: unitUsd(agent, 2500 + Math.ceil(ctxChars / 3.5), u.estimatedOutputTokens), costUsd: 0, stepIds: [],
    source: u.source ?? 'plan', findings: u.findings, round: u.round, error: null, startedAt: null, finishedAt: null
  };
}

/** Del plan del Coordinador al manifiesto: entregables (con su tamaño previsto) agrupados en unidades que caben en una respuesta. */
export function buildManifest(ctx: StoryRunCtx): StoryManifest {
  const plan = ctx.plan!;
  const planned = new Map<string, { purpose?: string; kind?: DeliverableKind; estimatedLines?: number }>();
  for (const d of Array.isArray(plan.deliverables) ? plan.deliverables : []) if (d && typeof d.path === 'string' && clean(d.path)) planned.set(clean(d.path), d);
  for (const f of plan.filesToChange) if (typeof f === 'string' && clean(f) && !planned.has(clean(f))) planned.set(clean(f), {});
  const deliverables: Deliverable[] = Array.from(planned, ([p, d]) => {
    const kind = d.kind && d.kind in RANK ? d.kind : kindOf(p);
    const existing = readRepoFile(ctx.repoPath, p, 400_000);
    // Archivo existente: se modifica con un parche (salida pequeña); nuevo: el tamaño que prevé el Coordinador o uno típico.
    const lines = existing === null ? Math.max(5, Math.min(2000, Math.round(Number(d.estimatedLines)) || KIND_LINES[kind])) : Math.min(140, Math.ceil(linesOf(existing) * 0.2) + 15);
    return { path: p, purpose: String(d.purpose || purposeFor(p, plan.tasks, plan.summary)).slice(0, 300), kind, planned: true, status: 'pending', unitId: null, commit: null, lines: null, estimatedLines: lines, note: null };
  });
  const order = deliverables.map((d, i) => ({ d, i })).sort((a, b) => RANK[a.d.kind] - RANK[b.d.kind] || a.i - b.i).map(x => x.d);
  const est = (g: Deliverable[]) => g.reduce((s, y) => s + y.estimatedLines * TOKENS_PER_LINE, 0);
  const groups: Deliverable[][] = [];
  for (const d of order) {
    const g = groups.at(-1);
    if (g && g.length < 3 && RANK[g[0].kind] === RANK[d.kind] && est(g) + d.estimatedLines * TOKENS_PER_LINE <= UNIT_TEXT_BUDGET) g.push(d); else groups.push([d]);
  }
  const units = groups.map((g, i) => {
    const id = `u${i + 1}`; g.forEach(d => { d.unitId = id; });
    return newUnit(ctx, ctx.dev, id, { kind: 'build', title: `${LABEL[g[0].kind]}: ${g.map(d => base(d.path)).join(', ')}`, purpose: g.map(d => `${base(d.path)}: ${d.purpose}`).join(' · '), files: g.map(d => d.path), dependsOn: i ? [`u${i}`] : [], estimatedOutputTokens: est(g) + 400 });
  });
  return { version: 1, deliverables, units, unitOutputBudget: UNIT_TEXT_BUDGET, rounds: [], gate: null, createdAt: now() };
}

/** Entregables por historia: más se explica y se pide dividir (nunca se descartan en silencio). */
export const MAX_DELIVERABLES = 16;
/**
 * ¿Se puede ejecutar el plan por partes? null = sí. Si no trae entregables, trae demasiados o rutas que no se pueden
 * escribir (protegidas, absolutas, con «..» o comodines), se explica ANTES de gastar en consultas o unidades.
 */
export function planProblem(plan: StoryPlan): string | null {
  const paths = Array.from(new Set([...(plan.deliverables ?? []).map(d => clean(d.path)), ...plan.filesToChange.map(clean)])).filter(Boolean);
  if (!paths.length) return 'El Coordinador no entregó un plan con archivos, tampoco al pedírselo otra vez en formato compacto. No se implementa a ciegas: una respuesta con la historia entera es lo que se cortó en HU-155. Reformula o acota la historia (nueva iteración) o vuelve a ejecutarla.';
  if (paths.length > MAX_DELIVERABLES) return `El plan tiene ${paths.length} archivos; una historia admite hasta ${MAX_DELIVERABLES} para entregarse por partes con garantías. No se descartó ninguno: divide la historia (nueva iteración). Archivos: ${paths.join(', ')}.`;
  const bad = paths.map(p => { if (/[*?<>|"]/.test(p)) return `${p} (ruta con comodines o caracteres no válidos)`; try { safeRelPath(p); return null; } catch (e: any) { return `${p} (${e.message})`; } }).filter(Boolean);
  if (bad.length) return `El plan incluye rutas que no se pueden escribir: ${bad.join(' · ')}. No se empieza: corrige el plan (nueva iteración) o acota la historia.`;
  return null;
}

/**
 * Inicio de la entrega incremental: guarda el manifiesto (punto de control) y comprueba ANTES de gastar que el
 * presupuesto alcanza para implementar todas las unidades; si no, pausa sin llamar a la IA.
 */
export function startIncremental(ctx: StoryRunCtx, plannedStepId?: string | null) {
  const man = buildManifest(ctx);
  // El paso «Implementación» planificado pasa a ser la primera unidad (mismo agente; un paso por llamada a partir de ahí).
  if (plannedStepId && man.units[0]) { man.units[0].reservedStepId = plannedStepId; processesRepo(ctx.slug).renameStep(plannedStepId, `Unidad 1 de ${man.units.length}: ${man.units[0].title}`.slice(0, 180), `Entrega incremental (unidad 1 de ${man.units.length}): ${man.units[0].files.join(', ')}`.slice(0, 300)); }
  updateResult(ctx.slug, ctx.processId, r => ({ ...r, manifest: man }));
  const total = man.units.reduce((s, u) => s + u.estimatedUsd, 0);
  emit(ctx, 'unit', `Plan dividido en ${man.units.length} unidad(es) de trabajo para ${man.deliverables.length} entregable(s). Cada unidad se aplica y se conserva al terminar; ninguna respuesta tiene que contener la historia entera.`, { phase: 'implementing', detail: `${man.units.map((u, i) => `${i + 1}. ${u.title}`).join(' · ')} — ≈ ${total.toFixed(2)} USD estimados para implementarlas (sin QA ni correcciones).` });
  const p = processesRepo(ctx.slug).get(ctx.processId)!;
  const remaining = p.budgetUsd - p.spentUsd - (p.unconfirmedUsd ?? 0);
  if (total > remaining) throw new PipelinePause('budget', `El plan necesita ≈ ${total.toFixed(2)} USD solo para implementar sus ${man.units.length} unidades y quedan ${Math.max(0, remaining).toFixed(2)} USD autorizados. No se empieza para no dejar la historia a medias; el plan y el manifiesto se conservan. Autoriza más presupuesto («Continuar») o acota la historia.`);
}

// ---------------------------------------------------------------- Contexto selectivo de cada unidad

/** Estructura del repositorio SOLO alrededor de los archivos de la unidad (no el árbol entero en cada llamada). */
function neighborhood(basePath: string, files: string[]): string {
  const dirs = Array.from(new Set(files.map(f => path.posix.dirname(f))));
  const out: string[] = [];
  for (let d of dirs.slice(0, 4)) {
    while (d !== '.' && !fs.existsSync(path.join(basePath, d))) d = path.posix.dirname(d);
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(basePath, d), { withFileTypes: true }).filter(e => e.name !== 'node_modules' && !e.name.startsWith('.git')).map(e => e.name + (e.isDirectory() ? '/' : '')).slice(0, 30); } catch { /* sin acceso */ }
    out.push(`${d === '.' ? '(raíz)' : d}/: ${names.join(', ') || '(vacío)'}`);
  }
  return out.join('\n');
}
const numbered = (c: string) => c.replace(/\r\n/g, '\n').split('\n').map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join('\n');

/** Archivos de contexto de una unidad: los suyos completos; los ya entregados que usa y los del plan, recortados. */
function unitContext(ctx: StoryRunCtx, man: StoryManifest, unit: WorkUnit, files: string[]): string {
  const bp = basePathOf(ctx); const parts: string[] = []; let budget = 60_000;
  const add = (label: string, c: string, max: number) => { if (budget <= 0) return; const t = clip(c, Math.min(max, budget)); budget -= t.length; parts.push(`## ${label}\n\`\`\`\n${t}\n\`\`\``); };
  for (const f of files) { const c = readRepoFile(bp, f, 60_000); if (c === null) parts.push(`## ${f}\n(no existe aún: créalo)`); else add(`${f} (contenido actual, ${linesOf(c)} líneas)`, c, 40_000); }
  // Lo ya entregado por unidades anteriores: las pruebas y la documentación necesitan el código real (la documentación, con números de línea para citar archivo:línea).
  // Configuración: basta la lista de lo entregado (rutas); correcciones: solo lo que la prueba o la documentación necesitan citar.
  const kind = man.deliverables.find(d => d.path === files[0])?.kind ?? kindOf(files[0] ?? '');
  const wants = (d: Deliverable) => kind === 'config' ? false : kind === 'docs' ? d.kind !== 'docs' : unit.kind === 'correction' ? kind === 'test' && d.kind === 'code' : d.kind === 'code';
  const done = man.deliverables.filter(d => d.status === 'delivered' && !files.includes(d.path) && wants(d)).sort((a, b) => RANK[a.kind] - RANK[b.kind]);
  for (const d of done) { const c = readRepoFile(bp, d.path, 40_000); if (c !== null) add(`${d.path} (ya entregado${kind === 'docs' ? ', con números de línea' : ''})`, kind === 'docs' ? numbered(c) : c, kind === 'code' ? 10_000 : 14_000); }
  if (kind === 'code' || kind === 'config') {
    // Referencias del plan: completas para la primera unidad; en las demás, solo las que la unidad nombra (no se repite el mismo contexto en cada llamada).
    const first = man.units.find(u => (u.source ?? 'plan') === 'plan')?.id === unit.id;
    const text = `${unit.purpose} ${files.join(' ')}`.toLowerCase();
    const refs = (ctx.plan?.filesToRead ?? []).filter(f => !files.includes(f)).filter(f => first || text.includes(f.toLowerCase()) || text.includes(base(f).replace(/\.[^.]+$/, '').toLowerCase()));
    for (const f of refs.slice(0, first ? 6 : 3)) { const c = readRepoFile(bp, f, 20_000); if (c !== null) add(`${f} (referencia del plan, recortado)`, c, 6_000); }
  }
  return parts.join('\n\n');
}

function unitLabel(man: StoryManifest, unit: WorkUnit): string {
  if (unit.source === 'plan' || !unit.source) { const plan = man.units.filter(u => (u.source ?? 'plan') === 'plan'); return `unidad ${plan.findIndex(u => u.id === unit.id) + 1} de ${plan.length}`; }
  return `corrección ${unit.round !== undefined ? unit.round + 1 : ''}`.trim();
}

function buildPrompt(ctx: StoryRunCtx, man: StoryManifest, unit: WorkUnit, files: string[], strategy: string | null): string {
  const plan = ctx.plan!; const label = unitLabel(man, unit);
  const bp = basePathOf(ctx);
  const planUnits = man.units.filter(u => (u.source ?? 'plan') === 'plan');
  const last = unit.source === 'plan' && planUnits.at(-1)?.id === unit.id;
  const del = (f: string) => man.deliverables.find(d => d.path === f);
  const done = man.deliverables.filter(d => d.status === 'delivered' && !files.includes(d.path));
  const later = man.deliverables.filter(d => d.status === 'pending' && !files.includes(d.path));
  return `Implementa la historia por partes. Esta es la ${label}: «${unit.title}». Entrega SOLO los archivos de esta unidad; cada unidad se aplica y se conserva al terminar, y lo demás se pide en otras unidades.
# Esta unidad
Objetivo: ${unit.purpose}
Archivos (tu ámbito autorizado):
${files.map(f => { const d = del(f); const exists = readRepoFile(bp, f, 1) !== null; return `- ${exists ? 'modificar con patch' : 'crear'} ${f}${d ? `: ${d.purpose} (≈ ${d.estimatedLines} líneas)` : ''}`; }).join('\n')}
${unit.findings?.length ? `Hallazgos que debe resolver:\n${unit.findings.map(f => `- [${f.severity}] ${f.text}${f.expected ? ` · esperado: ${f.expected}` : ''}`).join('\n')}\n` : ''}Criterios de aceptación que cubre:
${unit.acceptance.map(a => `- ${a}`).join('\n') || '- (los de la historia)'}
# Ya entregado (NO lo repitas; si necesitas cambiarlo, usa patch sobre su contenido actual)
${done.map(d => `- ${d.path} (${d.lines ?? '?'} líneas)`).join('\n') || '- (nada todavía)'}
# Pendiente para unidades posteriores (no lo hagas ahora)
${later.map(d => `- ${d.path}: ${d.purpose}`).join('\n') || '- (nada)'}
# Plan del Coordinador (resumen)
${plan.summary}
${plan.tasks.length ? `Tareas: ${plan.tasks.slice(0, 12).map((t, i) => `${i + 1}) ${t}`).join(' ')}` : ''}
${ctx.consultText ? clip(ctx.consultText, 3_000) : ''}${ctx.iterText ? clip(ctx.iterText, 4_000) : ''}${strategy ? `\n# Qué cambia en este intento\n${strategy}\n` : ''}
# Estructura del repositorio alrededor de estos archivos
${neighborhood(bp, files)}
# Contenido de los archivos relevantes
${unitContext(ctx, man, unit, files)}

Tamaño: esta unidad debería ocupar ≈ ${unit.estimatedOutputTokens} tokens de texto. Escribe los archivos completos y en orden; no resumas ni omitas código («...»). Si un archivo es muy largo y la respuesta se corta, se te pedirá continuar exactamente donde quedó. Para archivos existentes usa patch con fragmentos EXACTOS; para nuevos, el contenido íntegro (create). Respeta las convenciones.
Si un archivo planificado NO hace falta (existe una alternativa equivalente), no lo inventes: decláralo con DESCARTE y un motivo verificable; el alcance y los criterios de aceptación no los cambias tú (QA lo revisa).

FORMATO DE RESPUESTA (texto plano, sin JSON ni bloques de código alrededor de los archivos):
${last ? `${FILE_FORMAT}\n${DROP_FORMAT}` : UNIT_FORMAT}`;
}

/**
 * Diagnóstico enfocado del fallo del sandbox que originó la ronda: la última verificación fallida y las anteriores del
 * mismo comando (para ver si hay progreso). Sin IA; lee el worktree actual.
 */
function verificationDiagnosis(ctx: StoryRunCtx, man: StoryManifest, unit: WorkUnit): string {
  const r = resultOf(ctx); const runs = r.verifications ?? [];
  const i = runs.map(v => v.exitCode !== 0).lastIndexOf(true); if (i < 0) return '';
  const run = runs[i];
  const previous = runs.slice(0, i).filter(v => v.command === run.command && v.exitCode !== 0 && v.exitCode !== null).slice(-5);
  const storyCreated = (r.changes ?? []).filter(c => !c.error && c.action === 'create').map(c => c.path);
  const d = diagnoseFailure({ root: worktreeOf(ctx), run, previous, storyCreated, planned: man.deliverables.filter(x => x.planned).map(x => x.path), unitFiles: unit.files });
  return diagnosisPrompt(d, worktreeOf(ctx));
}

function correctionPrompt(ctx: StoryRunCtx, man: StoryManifest, unit: WorkUnit, strategy: string | null): string {
  const bp = basePathOf(ctx);
  const p = pipelineOf(ctx.slug, ctx.processId);
  const tries = attemptsSummary(p).slice(-4);
  const diagnosis = unit.source === 'verification' ? verificationDiagnosis(ctx, man, unit) : '';
  return `Corrige la implementación de esta historia: corrección dirigida («${unit.title}»). Tus cambios ya están aplicados en el worktree y se conservan; NO rehagas lo que funciona ni reescribas archivos enteros: usa patch con fragmentos EXACTOS del contenido actual que se muestra. Corrige SOLO lo de abajo.
# Qué hay que corregir (evidencia real)
${(unit.findings ?? []).map(f => `- [${f.severity}] ${f.text}${f.file ? ` (${f.file})` : ''}${f.evidence ? `\n  evidencia: ${clip(f.evidence, 1_500).split('\n').join('\n  ')}` : ''}${f.expected ? `\n  esperado: ${f.expected}` : ''}`).join('\n')}
${diagnosis ? `${diagnosis}\n` : ''}${strategy ? `# Qué cambia en este intento\n${strategy}\n` : ''}${tries.length ? `# Intentos anteriores (no repitas lo que ya falló)\n${tries.map(t => `- ${t}`).join('\n')}\n` : ''}# Criterios de aceptación de la historia
${(ctx.plan?.acceptance ?? []).map(a => `- ${a}`).join('\n') || `- ${ctx.item.criterion || '(los de la historia)'}`}
# Plan del Coordinador (resumen)
${ctx.plan ? ctx.plan.summary : '(sin plan)'}
# Archivos implicados — contenido ACTUAL del worktree
${unitContext(ctx, man, unit, unit.files.filter(f => readRepoFile(bp, f, 1) !== null || !unit.files.some(g => g !== f)))}

FORMATO DE RESPUESTA:
${PATCH_ONLY_FORMAT}
${DROP_FORMAT}
${unit.source === 'qa' ? '(si un hallazgo de QA es incorrecto, no inventes cambios: responde solo con === RESUMEN === y === SIN CAMBIOS === seguido de la evidencia concreta —archivo:línea, fragmento o salida—; QA lo volverá a evaluar una vez)' : '(es un fallo objetivo del sandbox o de la comprobación previa: corrígelo; si la causa está en otro archivo, parchea ese archivo. Una prueba que ya existía y no está en el plan no se modifica para que pase. Si la comprobación exige algo que contradice el criterio de aceptación o el código real, no la debilites ni inventes: responde solo con === RESUMEN === y === SIN CAMBIOS === con la evidencia concreta y el propietario decide)'}`;
}

function unitRepairPrompt(ctx: StoryRunCtx, unit: WorkUnit, prompt: string, a: DevOutputAssessment, previous: string, ok: ProposedChange[], bad: ProposedChange[]): string {
  return `Tu entrega anterior para esta historia no se pudo convertir en cambios aplicables (${unit.title}). NO repitas el análisis: repara la ENTREGA de esta unidad.
# Diagnóstico (automático, sin IA)
Tipo: ${a.kind}
${a.reasons.map(r => `- ${r}`).join('\n') || '- (sin detalle)'}
${bad.length ? `Cambios que no encajan en el código actual:\n${bad.map(c => `- ${c.path}: ${c.error}`).join('\n')}\n` : ''}${ok.length ? `# Ya recibidos y válidos (se conservan; NO los repitas)\n${ok.map(c => `- ${c.action} ${c.path}`).join('\n')}\n` : ''}# Tu respuesta anterior (recortada)
${clip(previous, 12_000)}

# Encargo original de la unidad
${clip(prompt, 30_000)}`;
}

// ---------------------------------------------------------------- Validación de artefactos

let tsMod: any | undefined;
/** Sintaxis de un archivo de código (TypeScript/JavaScript) o JSON. null = válido o no comprobable. */
export function syntaxProblem(file: string, content: string): string | null {
  if (/\.json$/i.test(file)) { try { JSON.parse(content); return null; } catch (e: any) { return `JSON no válido: ${String(e.message).slice(0, 160)}`; } }
  if (!CODE_EXT.test(file)) return null;
  if (tsMod === undefined) { try { tsMod = createRequire(import.meta.url)('typescript'); } catch { tsMod = null; } }
  if (!tsMod) return null;
  const sf = tsMod.createSourceFile(file, content, tsMod.ScriptTarget.Latest, true, /x$/i.test(file) ? tsMod.ScriptKind.TSX : undefined);
  const d = (sf as any).parseDiagnostics?.[0];
  if (!d) return null;
  const { line } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
  return `sintaxis no válida en la línea ${line + 1}: ${tsMod.flattenDiagnosticMessageText(d.messageText, ' ').slice(0, 160)}`;
}

// ---------------------------------------------------------------- Ejecución de una unidad

/** Continuación del archivo cortado: solo ese archivo, desde la última línea completa; contador propio (no consume correcciones). */
async function continueFile(ctx: StoryRunCtx, cfg: PipelineConfig, unitId: string, prompt: string, partial: NonNullable<ParsedDevOutput['truncatedPartial']>): Promise<DevOutput | null> {
  const unit = unitOf(ctx, unitId); const p = pipelineOf(ctx.slug, ctx.processId);
  const used = p.continuations ?? 0; const perFile = unit.continued?.[partial.path] ?? 0;
  const max = cfg.maxContinuations ?? 6;
  checkDuration(ctx, cfg);
  if (used >= max || perFile >= 2) {
    emit(ctx, 'continuation', `«${partial.path}» sigue sin caber en una respuesta tras ${perFile} continuación(es); no se piden más (${used} de ${max} en este proceso).`, { detail: unit.title });
    return null;
  }
  // La última línea casi seguro quedó a medias: se descarta y se pide reescribirla entera (unión determinista, sin solapes).
  const lines = partial.body.replace(/\r\n/g, '\n').split('\n');
  const keep = lines.slice(0, -1); const cut = lines.at(-1) ?? '';
  emit(ctx, 'continuation', `La respuesta se cortó por longitud dentro de «${partial.path}». Se pide SOLO la continuación de ese archivo; lo ya recibido se conserva. No consume correcciones ni reparaciones.`, { phase: 'implementing', aiCall: true, detail: `${unit.title} · ${keep.length} líneas recibidas · continuación ${perFile + 1} de 2 para este archivo (${used + 1} de ${max} en el proceso)` });
  const user = `Continúa el archivo «${partial.path}» (${unit.title}). Tu respuesta anterior se cortó por el límite de longitud dentro de este archivo; lo demás que entregaste llegó completo y se conserva.
# Lo que llevas escrito de «${partial.path}» (${keep.length} líneas completas)
\`\`\`
${clip(keep.join('\n'), 40_000)}
\`\`\`
${cut.trim() ? `La línea siguiente quedó a medias («${cut.slice(0, 160)}»): empieza reescribiéndola ENTERA.` : 'Empieza en la línea siguiente.'}
Escribe SOLO el resto de «${partial.path}»: sin repetir lo anterior, sin saludos ni explicaciones y sin abrir otro bloque de archivo. Termina con la línea «=== FIN ARCHIVO ===». Si tampoco cabe ahora, llega hasta donde puedas: se te pedirá el resto.
${partial.op === 'patch' ? 'Es un parche: sigue el bloque BUSCAR/REEMPLAZAR donde quedó, con los mismos marcadores.\n' : ''}
# Encargo de la unidad (para el contexto)
${clip(prompt, 12_000)}`;
  const res = await stepCall(ctx, ctx.dev, 'implementer', `Continuación de ${base(partial.path)} (${unit.title})`.slice(0, 160), `La respuesta se cortó dentro de ${partial.path}`, sys(ctx.dev, ctx.project, ctx.item), user, DEV_MAX_TOKENS, undefined, undefined, `Continuación ${perFile + 1} de 2 del archivo ${partial.path}`);
  // Los contadores suben con la llamada HECHA: una pausa (presupuesto, duración) antes de llamar no gasta la continuación.
  updatePipeline(ctx.slug, ctx.processId, { continuations: (pipelineOf(ctx.slug, ctx.processId).continuations ?? 0) + 1 });
  setUnit(ctx, unitId, u => { u.stepIds.push(res.stepId); u.costUsd += res.costUsd; u.continuations++; u.continued = { ...(u.continued ?? {}), [partial.path]: (u.continued?.[partial.path] ?? 0) + 1 }; });
  const prefix = `=== ARCHIVO: ${partial.path} | ${partial.op} ===\n${keep.join('\n')}${keep.length ? '\n' : ''}`;
  return { text: stitch(prefix, res.text), stopReason: res.stopReason, refusal: res.refusal ?? null, stepId: res.stepId, prefix };
}

/**
 * Une lo recibido de un archivo cortado (prefijo: cabecera + líneas completas) con su continuación: sin la valla de código,
 * sin una cabecera ARCHIVO repetida y sin las últimas líneas repetidas. Igual en vivo y al reanudar (relectura de salidas).
 */
export function stitch(prefix: string, raw: string): string {
  const keep = prefix.replace(/\r\n/g, '\n').split('\n').slice(1, -1);
  let cont = raw.replace(/\r\n/g, '\n').replace(/^\s*```[\w-]*\n/, '');
  cont = cont.replace(/^[ \t>*#_`]*={2,}\s*(?:ARCHIVO|FILE)\s*:[^\n]*\n/i, '');
  for (let k = Math.min(5, keep.length); k > 0; k--) { const tail = keep.slice(-k).join('\n'); if (tail.trim() && cont.startsWith(tail + '\n')) { cont = cont.slice(tail.length + 1); break; } }
  return prefix + cont;
}

/** Escribe en el worktree lo validado de una unidad (primer commit: crea el worktree aislado) y actualiza el diff acumulado. */
async function commitUnit(ctx: StoryRunCtx, unit: WorkUnit, label: string, valid: ProposedChange[]): Promise<{ commit: string | null; files: string[] }> {
  requirePolicy('write_worktree', { slug: ctx.slug, processId: ctx.processId, agentId: unit.agentId, projectId: ctx.project.id, authorized: true });
  const r = resultOf(ctx);
  let commit: string; let files: string[];
  const msg = `${ctx.item.storyId}: ${label} — ${unit.title}\n\nEntrega incremental del equipo de agentes de Portal IA (pipeline autorizado).\nProceso: ${ctx.processId}`;
  if (!r.applied) {
    const a = await applyChanges(ctx.repoPath, `portal-ia/${ctx.item.storyId.toLowerCase()}`, valid, msg, { processId: ctx.processId });
    commit = a.commit; files = a.files;
    updateResult(ctx.slug, ctx.processId, x => ({ ...x, applied: { ...a, appliedAt: now() } }));
  } else {
    try { const c = await commitInWorktree(r.applied.worktree!, valid, msg); commit = c.commit; files = c.files; }
    catch (e: any) { if (e?.code === 'no_effect') return { commit: null, files: [] }; throw e; }
    updateResult(ctx.slug, ctx.processId, x => ({ ...x, applied: { ...x.applied!, commit, files: Array.from(new Set([...x.applied!.files, ...files])), appliedAt: now() } }));
  }
  const wt = resultOf(ctx).applied!.worktree!;
  const all = await changesSinceBase(ctx.repoPath, wt);
  updateResult(ctx.slug, ctx.processId, x => ({ ...x, changes: all }));
  processesRepo(ctx.slug).logExecution({ projectId: ctx.project.id, agentId: unit.agentId, kind: 'repo_write', status: 'done', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: now() });
  emit(ctx, 'apply', `${label[0].toUpperCase()}${label.slice(1)} aplicada en el worktree aislado (rama ${resultOf(ctx).applied!.branch}, commit ${commit}). Tu carpeta del Portal no cambia.`, { phase: 'applying', detail: files.join(', ') });
  return { commit, files };
}

/** Lo que el propietario ve en la revisión: resumen por unidad y las secciones para él (de la última unidad que las traiga). */
function mergeMeta(ctx: StoryRunCtx, unit: WorkUnit, meta: ParsedDevOutput) {
  updateResult(ctx.slug, ctx.processId, r => ({
    ...r,
    implementationSummary: [r.implementationSummary, meta.summary ? `• ${unit.title}: ${meta.summary}${meta.notes && unit.kind === 'build' ? ` (${clip(meta.notes, 400)})` : ''}` : null].filter(Boolean).join('\n'),
    userFacing: meta.userFacing || r.userFacing || null,
    manualTest: meta.manualSteps.length ? { steps: meta.manualSteps, checks: meta.manualSteps.map(() => false), note: null } : r.manualTest ?? null,
    runtimeChecks: meta.runtimeChecks.length ? { checks: meta.runtimeChecks, results: [], ranAt: null } : r.runtimeChecks ?? null,
    verifyCommands: (() => { const v = meta.verify.filter(c => ['typecheck', 'test', 'build'].includes(c)); return v.length ? v : r.verifyCommands?.length ? r.verifyCommands : ['typecheck']; })()
  }));
}

/**
 * Reglas de ámbito sobre lo entregado (antes de escribir): no se regenera un archivo terminado en otra unidad (solo
 * parches), una corrección no reescribe entero un archivo grande y un archivo reconstruido por continuaciones (o un JSON)
 * debe ser sintácticamente válido. Una prueba que ya existía y no está en el plan no se modifica (salvo para restaurarla):
 * hacerla pasar cambiándola debilitaría la verificación (HU-155). Lo demás (otros entregables pendientes, archivos fuera
 * del plan) se acepta y se anota.
 */
function scopeCheck(man: StoryManifest, unit: WorkUnit, s: Settled, base: ProposedChange[]): ProposedChange[] {
  const full = new Set(s.raw.filter(c => c.action === 'create' || c.action === 'modify').map(c => clean(c.path)));
  return s.changes.map(c => {
    if (c.error) return c;
    const d = man.deliverables.find(x => x.path === c.path);
    const prior = base.find(x => x.path === c.path);
    const existingTest = isTestEntry(c.path) && (c.before > 0 || c.action === 'delete') && prior?.action !== 'create' && !d?.planned;
    const restores = !!prior?.baseHash && c.content !== null && hashText(c.content.replace(/\r\n/g, '\n')) === prior.baseHash;
    if (existingTest && !restores) return { ...c, error: `«${c.path}» es una prueba que ya existía y no está en el plan: no se modifica para que pase (debilitaría la verificación). Corrige el código que la rompe; si esta historia debe cambiar esa prueba, el propietario la añade al plan. Restaurar su contenido original sí se permite.` };
    if (full.has(c.path) && c.before > 0 && d?.status === 'delivered' && d.unitId !== unit.id) return { ...c, error: `Ya se entregó en otra unidad (${d.unitId}): no se regenera un archivo terminado. Para cambiarlo, usa patch sobre su contenido actual.` };
    if (full.has(c.path) && unit.kind === 'correction' && c.before >= 60) return { ...c, error: `Una corrección no reescribe entero un archivo de ${c.before} líneas (regeneraría trabajo hecho y la respuesta puede cortarse): usa patch con fragmentos exactos.` };
    const stitched = (unit.continued?.[c.path] ?? 0) > 0;
    const bad = c.content !== null && (stitched || /\.json$/i.test(c.path)) ? syntaxProblem(c.path, c.content) : null;
    if (bad) return { ...c, error: `${stitched ? 'El archivo reconstruido a partir de continuaciones' : 'El archivo'} no es válido (${bad}): no se aplica.` };
    return c;
  });
}

/** Aplica lo válido de una unidad y actualiza el manifiesto con la evidencia (commit, líneas, descartes). */
async function applyUnit(ctx: StoryRunCtx, unitId: string, s: Settled): Promise<{ files: string[]; dropped: string[]; problems: string[] }> {
  const man = manifestOf(ctx); const unit = unitOf(ctx, unitId); const label = unitLabel(man, unit);
  const changes = scopeCheck(man, unit, s, (resultOf(ctx).changes ?? []).filter(c => !c.error));
  const valid = changes.filter(c => !c.error);
  const { commit, files } = valid.length ? await commitUnit(ctx, unit, label, valid) : { commit: null, files: [] as string[] };
  const wt = worktreeOf(ctx);
  const deletes = new Set(valid.filter(c => c.action === 'delete').map(c => c.path));
  const dropped: string[] = [];
  saveManifest(ctx, m => {
    for (const f of files) {
      let d = m.deliverables.find(x => x.path === f);
      if (!d) { d = { path: f, purpose: 'Añadido por el equipo durante la implementación (fuera del plan).', kind: kindOf(f), planned: false, status: 'pending', unitId: unit.id, commit: null, lines: null, estimatedLines: 0, note: null }; m.deliverables.push(d); }
      // Un borrado del plan está entregado cuando el archivo ya no existe (no se vuelve a pedir «crearlo»).
      const exists = wt ? fs.existsSync(path.join(wt, f)) : false;
      const ok = exists || deletes.has(f);
      Object.assign(d, { status: ok ? 'delivered' : 'pending', commit, lines: exists ? linesOf(readRepoFile(wt!, f, 400_000)) : 0, note: exists ? null : deletes.has(f) ? 'eliminado (según el plan)' : 'borrado' });
      if (d.status === 'delivered' && (!d.unitId || m.units.find(x => x.id === d!.unitId)?.status !== 'done')) d.unitId = unit.id;
    }
    // Un descarte solo cuenta si cambia de verdad un entregable (no uno ya entregado).
    for (const dr of s.drops) { const d = m.deliverables.find(x => x.path === dr.path); if (d && d.status !== 'delivered' && d.status !== 'dropped') { d.status = 'dropped'; d.note = dr.reason; dropped.push(d.path); } }
    const u = m.units.find(x => x.id === unitId)!; u.applied = Array.from(new Set([...(u.applied ?? []), ...files])); if (dropped.length) u.dropped = Array.from(new Set([...(u.dropped ?? []), ...dropped]));
    if (dropped.length) m.gate = null;
    const flagged = changes.filter(c => c.error || c.warning).map(c => ({ path: c.path, error: c.error ?? null, warning: c.warning ?? null, unitId, at: now() }));
    if (flagged.length) m.rejected = [...(m.rejected ?? []), ...flagged].slice(-60);
  });
  mergeMeta(ctx, unit, s.meta);
  // Lo rechazado por las reglas de ámbito queda registrado (evidencia para el propietario y para las lecciones).
  const scoped = changes.filter((c, i) => c.error && !s.changes[i].error);
  if (scoped.length) emit(ctx, 'unit', `${label[0].toUpperCase()}${label.slice(1)}: se rechazó ${scoped.length} cambio(s) por las reglas de entrega (lo demás se aplicó).`, { detail: scoped.map(c => `${c.path}: ${c.error}`).join(' · ') });
  if (dropped.length) emit(ctx, 'unit', `${ctx.dev.config.name} justifica que ${dropped.length} entregable(s) del plan no hacen falta: ${dropped.join(', ')}. QA lo revisará (no cambia los criterios de aceptación).`, { detail: s.drops.filter(d => dropped.includes(d.path)).map(d => `${d.path}: ${clip(d.reason, 200)}`).join(' · ') });
  const ignoredDrops = s.drops.filter(d => !dropped.includes(d.path)).map(d => `${d.path}: el DESCARTE no aplica (ya está entregado; para cambiarlo usa patch, para discutir un hallazgo usa SIN CAMBIOS)`);
  const problems = [...changes.filter(c => c.error).map(c => `${c.path}: ${c.error}`), ...(s.truncatedFile ? [`${s.truncatedFile}: la respuesta se cortó dentro de este archivo y no llegó completo`] : []), ...ignoredDrops, ...(files.length || dropped.length ? [] : s.assessment.reasons.slice(0, 3))];
  return { files, dropped, problems };
}

/** Resultado de una llamada sin texto con la salida agotada: todo se fue en razonamiento oculto (pagado). Cambia de estrategia o se detiene. */
function outputExhausted(ctx: StoryRunCtx, unitId: string, outputTokens: number, costUsd: number): string | null {
  const unit = unitOf(ctx, unitId); const p = pipelineOf(ctx.slug, ctx.processId);
  updatePipeline(ctx.slug, ctx.processId, { continuations: (p.continuations ?? 0) + 1 });
  const n = (unit.exhausted ?? 0) + 1;
  setUnit(ctx, unitId, { exhausted: n, attempts: 0 }); // el siguiente intento es con otra estrategia: cuenta de nuevo
  emit(ctx, 'continuation', `El modelo agotó toda su salida (${outputTokens} tokens facturados) sin escribir nada: se fue en razonamiento interno. No se repite igual.`, { costUsd, detail: unit.title });
  const pending = unit.files.filter(f => manifestOf(ctx).deliverables.find(d => d.path === f)?.status === 'pending');
  if (unit.kind === 'build' && pending.length > 1) {
    // Estrategia nueva: dividir la unidad (un archivo ahora, el resto en unidades propias a continuación).
    saveManifest(ctx, m => {
      const i = m.units.findIndex(x => x.id === unitId); const u = m.units[i];
      const rest = pending.slice(1).map((f, k) => newUnit(ctx, ctx.dev, `${u.id}-${k + 2}`, { kind: 'build', title: `${LABEL[kindOf(f)]}: ${base(f)}`, purpose: m.deliverables.find(d => d.path === f)?.purpose ?? u.purpose, files: [f], dependsOn: [u.id], estimatedOutputTokens: (m.deliverables.find(d => d.path === f)?.estimatedLines ?? 80) * TOKENS_PER_LINE + 300, source: u.source }));
      u.files = [pending[0], ...u.files.filter(f => !pending.includes(f))]; u.estimatedOutputTokens = (m.deliverables.find(d => d.path === pending[0])?.estimatedLines ?? 80) * TOKENS_PER_LINE + 300;
      for (const r of rest) { const d = m.deliverables.find(x => x.path === r.files[0]); if (d) d.unitId = r.id; }
      m.units.splice(i + 1, 0, ...rest);
    });
    emit(ctx, 'unit', `La unidad «${unit.title}» se divide: ${pending[0]} ahora y ${pending.length - 1} archivo(s) en unidades propias.`, { detail: pending.slice(1).join(', ') });
    return 'La vez anterior agotaste toda la salida razonando sin escribir nada. Esta unidad ahora es UN solo archivo: ve directo al formato de respuesta y escríbelo.';
  }
  if (n >= 2) {
    setUnit(ctx, unitId, { status: 'failed', error: 'El modelo agotó dos veces toda la salida en razonamiento interno sin entregar texto.', finishedAt: now() });
    if (unit.kind === 'correction') return null;
    throw new PipelinePause('too_large', `«${unit.title}»: el modelo ${ctx.dev.config.model} agotó dos veces toda su salida en razonamiento interno sin entregar texto (${outputTokens} tokens facturados la última vez). No se insiste. Recomendación: bajar el esfuerzo de razonamiento de ${ctx.dev.config.name} (Equipo → agente) o dividir este entregable en partes más pequeñas. Lo entregado se conserva.`);
  }
  return 'La vez anterior agotaste toda la salida razonando sin escribir nada. Ve directo al formato de respuesta: escribe los archivos ya; no hace falta un análisis largo.';
}

/**
 * Ejecuta una unidad hasta terminarla o agotar sus intentos (2, el segundo con una estrategia distinta). Una unidad del
 * plan que no se puede entregar detiene el pipeline con explicación; una de corrección deja que la ronda decida.
 * Al reanudar, primero se releen las salidas ya pagadas del intento en curso (no se vuelve a llamar por lo mismo).
 */
async function runUnit(ctx: StoryRunCtx, cfg: PipelineConfig, unitId: string): Promise<void> {
  try { await runUnitInner(ctx, cfg, unitId); }
  catch (e) {
    // Pausa, cancelación o fallo del proveedor: la unidad queda pendiente de retomar (con sus salidas ya pagadas registradas).
    try { if (unitOf(ctx, unitId).status === 'running') setUnit(ctx, unitId, { status: 'pending' }); } catch { /* sin manifiesto */ }
    throw e;
  }
}
async function runUnitInner(ctx: StoryRunCtx, cfg: PipelineConfig, unitId: string): Promise<void> {
  let unit = unitOf(ctx, unitId);
  const man0 = manifestOf(ctx); const label = unitLabel(man0, unit);
  const agent = ctx.team.find(a => a.id === unit.agentId) ?? ctx.dev;
  const isCorrection = unit.kind === 'correction';
  setUnit(ctx, unitId, { status: 'running', startedAt: unit.startedAt ?? now() });
  if (!unit.outputs?.length) emit(ctx, 'unit', `${label[0].toUpperCase()}${label.slice(1)}: ${unit.title} — ${agent.config.name}.`, { phase: isCorrection ? 'correcting' : 'implementing', aiCall: true, detail: `${unit.files.join(', ')} · ≈ ${unit.estimatedUsd.toFixed(2)} USD estimados` });
  let strategy: string | null = unit.error ? `Intento anterior: ${unit.error}` : null;
  for (;;) {
    checkCancelled(ctx); checkDuration(ctx, cfg);
    unit = unitOf(ctx, unitId); const man = manifestOf(ctx);
    const files = isCorrection ? unit.files : unit.files.filter(f => !['delivered', 'dropped'].includes(man.deliverables.find(d => d.path === f)?.status ?? 'pending'));
    if (!isCorrection && !files.length) break;
    const prompt = isCorrection ? correctionPrompt(ctx, man, unit, strategy) : buildPrompt(ctx, man, unit, files, strategy);
    const hooks = {
      continueFile: (partial: NonNullable<ParsedDevOutput['truncatedPartial']>) => continueFile(ctx, cfg, unitId, prompt, partial),
      repairPrompt: (a: DevOutputAssessment, previous: string, ok: ProposedChange[], bad: ProposedChange[]) => unitRepairPrompt(ctx, unitOf(ctx, unitId), prompt, a, previous, ok, bad),
      // Formato: una reparación por unidad de construcción; en una corrección, el segundo intento (con otra estrategia) ya lo cubre.
      canRepair: () => !isCorrection && unitOf(ctx, unitId).repairs < 1 && pipelineOf(ctx.slug, ctx.processId).outputRepairs < cfg.maxOutputRepairs + manifestOf(ctx).units.length,
      onRepair: () => setUnit(ctx, unitId, u => { u.repairs++; }),
      relevant: (p: string) => isCorrection ? unitOf(ctx, unitId).files.includes(p) : manifestOf(ctx).deliverables.find(d => d.path === p)?.status !== 'delivered',
      record: (o: DevOutput) => { if (o.stepId) setUnit(ctx, unitId, u => { u.outputs = [...(u.outputs ?? []), { stepId: o.stepId!, stopReason: o.stopReason, prefix: o.prefix ?? null }]; if (!u.stepIds.includes(o.stepId!)) u.stepIds.push(o.stepId!); }); }
    };
    // Reanudar: las salidas ya pagadas de este intento se releen antes de volver a llamar.
    const steps = processesRepo(ctx.slug).get(ctx.processId)!.steps;
    let outputs: DevOutput[] = (unit.outputs ?? []).map(o => { const s = steps.find(x => x.id === o.stepId); return s?.outputMd != null ? { text: o.prefix ? stitch(o.prefix, s.outputMd) : s.outputMd, stopReason: o.stopReason, stepId: o.stepId, prefix: o.prefix ?? null } : null; }).filter(Boolean) as DevOutput[];
    if (!outputs.length) {
      const n = unit.attempts + 1;
      const title = isCorrection ? `Corrección ${(unit.round ?? 0) + 1}${man.units.filter(u => u.round === unit.round).length > 1 ? `.${man.units.filter(u => u.round === unit.round).findIndex(u => u.id === unitId) + 1}` : ''}${n > 1 ? ` (intento ${n})` : ''}` : `Unidad ${label.replace(/^unidad /, '')}: ${unit.title}${n > 1 ? ` (intento ${n})` : ''}`;
      const reuse = unit.reservedStepId && !unit.attempts && processesRepo(ctx.slug).get(ctx.processId)!.steps.find(x => x.id === unit.reservedStepId)?.status === 'pending' ? unit.reservedStepId : undefined;
      const res = await stepCall(ctx, agent, 'implementer', title.slice(0, 180), isCorrection ? `Corrección dirigida: ${(unit.findings ?? [])[0]?.text.slice(0, 120) ?? unit.title}` : `Entrega incremental (${label}): ${unit.files.join(', ')}`.slice(0, 300), sys(agent, ctx.project, ctx.item), prompt, unitMaxTokens(unit), reuse);
      setUnit(ctx, unitId, u => { u.attempts++; u.stepIds.push(res.stepId); u.costUsd += res.costUsd; });
      if (isCorrection) updatePipeline(ctx.slug, ctx.processId, { correctionAttempts: (pipelineOf(ctx.slug, ctx.processId).correctionAttempts ?? 0) + 1 });
      if (isTruncatedStop(res.stopReason) && !res.text.trim()) { const next = outputExhausted(ctx, unitId, res.outputTokens, res.costUsd); if (next === null) return; strategy = next; continue; }
      outputs = [{ text: res.text, stopReason: res.stopReason, refusal: res.refusal ?? null, stepId: res.stepId }];
      hooks.record(outputs[0]);
    }
    ctx.unit = { prompt, files, basePath: basePathOf(ctx), label };
    let s: Settled;
    try { s = await settleUnit(ctx, outputs, cfg, hooks); } finally { ctx.unit = null; }
    const { files: applied, dropped, problems } = await applyUnit(ctx, unitId, s);
    unit = unitOf(ctx, unitId);
    // Nuevo intento (o terminado): las salidas de este intento ya no se releen.
    setUnit(ctx, unitId, { outputs: [] });
    const missing = isCorrection ? [] : unit.files.filter(f => manifestOf(ctx).deliverables.find(d => d.path === f)?.status === 'pending');
    // Corrección que discute el hallazgo con evidencia (SIN CAMBIOS): resultado válido que QA vuelve a evaluar.
    const answer = isCorrection && unit.source === 'qa' && !applied.length && !dropped.length && s.outcome === 'no_changes' && s.meta.noChanges ? s.meta.noChanges.slice(0, 1500) : null;
    if (isCorrection && unit.source !== 'qa' && s.outcome === 'no_changes' && s.meta.noChanges) {
      // Un fallo objetivo no se discute con QA; pero si el Desarrollador sostiene CON EVIDENCIA que la comprobación exige algo
      // que contradice el criterio o el código real, repetir la llamada no lo arregla: decide el propietario (sin debilitar la prueba).
      if (EVIDENCE.test(s.meta.noChanges)) {
        const why = `${ctx.dev.config.name} no cambia el código: sostiene que la comprobación exige algo que contradice el criterio o el código real. Su evidencia: «${clip(s.meta.noChanges, 600)}»`;
        setUnit(ctx, unitId, { status: 'failed', error: why, finishedAt: now() });
        emit(ctx, 'correction', `«${clip(unit.title, 120)}»: el Desarrollador argumenta con evidencia que la comprobación no es correcta; no se paga otro intento. Decide el propietario.`, { detail: clip(s.meta.noChanges, 400) });
        return;
      }
      problems.push('Este fallo viene de una comprobación objetiva (sandbox o comprobación previa): no se discute, se corrige; si la comprobación contradice el criterio o el código real, dilo con evidencia concreta (archivo:línea, fragmento o salida).');
    }
    const disputed = answer && EVIDENCE.test(answer) ? answer : null;
    if (answer && !disputed) problems.push('La discusión del hallazgo no cita evidencia concreta (archivo:línea, un fragmento del código o la salida de una verificación): así no se puede comprobar.');
    if (disputed) { setUnit(ctx, unitId, { disputed }); saveManifest(ctx, m => { m.disputes = [...(m.disputes ?? []), ...(unit.findings ?? []).map(f => ({ file: f.file, finding: f.text, answer: disputed, round: unit.round ?? 0, at: now() }))]; }); emit(ctx, 'correction', `${ctx.dev.config.name} discute el hallazgo «${clip((unit.findings ?? [])[0]?.text ?? unit.title, 120)}» con evidencia, sin cambiar el código. QA lo volverá a evaluar.`, { detail: clip(disputed, 400) }); }
    const done = isCorrection ? applied.length > 0 || dropped.length > 0 || !!disputed : !missing.length;
    if (done) { setUnit(ctx, unitId, { status: 'done', error: null, finishedAt: now() }); return; }
    const why = problems.slice(0, 4).join(' · ') || `${s.assessment.kind}: sin cambios aplicables`;
    if (unit.attempts >= 2) {
      setUnit(ctx, unitId, { status: 'failed', error: why, finishedAt: now() });
      if (!isCorrection) {
        saveManifest(ctx, m => { for (const f of missing) { const d = m.deliverables.find(x => x.path === f); if (d) { d.status = 'failed'; d.note = why.slice(0, 300); } } });
        throw new PipelinePause('incomplete', `${label[0].toUpperCase()}${label.slice(1)} («${unit.title}»): ${ctx.dev.config.name} no entregó ${missing.join(', ')} tras ${unit.attempts} intentos con estrategias distintas (${why}). Lo entregado hasta ahora está aplicado y se conserva; no se llama a QA con la historia incompleta. Recomendación: revisa el motivo, acota ese entregable o divídelo en módulos más pequeños y continúa.`);
      }
      emit(ctx, 'correction', `La corrección «${unit.title}» no produjo cambios aplicables tras ${unit.attempts} intentos.`, { detail: why });
      return;
    }
    setUnit(ctx, unitId, { error: why });
    // Estrategia distinta en el segundo intento: instrucciones concretas con el motivo real; si hay un especialista del equipo, se le consulta una vez.
    if (isCorrection) {
      strategy = `Tu intento anterior no produjo ningún cambio aplicable: ${why}. Esta vez: SOLO bloques patch pequeños copiados EXACTAMENTE del contenido actual mostrado; no reescribas archivos enteros; un archivo nuevo, solo si falta del todo.`;
      const advice = await consultOnce(ctx, cfg, unit, why);
      if (advice) strategy += `\n${advice}`;
    } else {
      strategy = `Faltan ${missing.join(', ')} de esta unidad (${why}). Entrega SOLO esos archivos ahora; si alguno de verdad no hace falta (lo cubre otro archivo), decláralo con DESCARTE y el motivo en vez de omitirlo.${s.truncatedFile || /cortó|reconstruido/.test(why) ? ' Si un archivo no cabe en una respuesta, divídelo en dos módulos más pequeños (y ajusta los imports); los módulos nuevos se aceptan.' : ''}`;
    }
  }
  setUnit(ctx, unitId, { status: 'done', error: null, finishedAt: now() });
}

/** Evidencia verificable en una discusión: una ruta (con línea), un fragmento entre comillas o la salida de un comando. */
const EVIDENCE = /[\w./-]+\.[A-Za-z]{1,6}(?::\d+)?|l[ií]nea \d+|`[^`]{3,}`|«[^»]{3,}»|"[^"]{6,}"|exit(?:Code)? \d|c[oó]digo \d/i;
const words = (t: string) => new Set((t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]{4,}/g) ?? []));
/** ¿QA repite un hallazgo que el equipo ya discutió? (mismo archivo y la mitad de las palabras en común). */
function sameFinding(d: { file: string | null; finding: string }, f: { file: string | null; text: string }): boolean {
  if ((d.file ? clean(d.file) : null) !== (f.file ? clean(f.file) : null)) return false;
  const a = words(d.finding), b = words(f.text); if (!a.size || !b.size) return false;
  let common = 0; for (const w of a) if (b.has(w)) common++;
  return common / Math.min(a.size, b.size) >= 0.5;
}

/** Cambio de estrategia: un especialista del equipo AUTORIZADO responde una vez (si queda margen de consultas). */
async function consultOnce(ctx: StoryRunCtx, cfg: PipelineConfig, unit: WorkUnit, why: string): Promise<string | null> {
  const p = pipelineOf(ctx.slug, ctx.processId);
  if ((p.consultations ?? []).length >= cfg.maxConsultations) return null;
  const question = `¿Cómo corregir «${(unit.findings ?? [])[0]?.text ?? unit.title}» en ${unit.files.join(', ')}? El intento anterior falló: ${why}`;
  const who = pickConsultant(ctx.team, ctx.dev.id, { type: 'information', need: `${unit.title} ${(unit.findings ?? []).map(f => f.text).join(' ')}`, question, consult: null, declared: false });
  if (!who) return null;
  updatePipeline(ctx.slug, ctx.processId, { consultations: [...(p.consultations ?? []), { at: now(), agentName: who.config.name, question: question.slice(0, 300) }] });
  emit(ctx, 'info', `La corrección «${unit.title}» falló una vez: se consulta a ${who.config.name} (${who.template.role}, del equipo autorizado) antes de reintentar con otra estrategia.`, { phase: 'correcting', aiCall: true });
  const res = await stepCall(ctx, who, 'consultant', `Consulta de ${ctx.dev.config.name}: ${unit.title}`.slice(0, 160), 'Una corrección no produjo cambios aplicables', sys(who, ctx.project, ctx.item), `${ctx.dev.config.name} necesita tu criterio para corregir esto (3-8 puntos concretos; archivos y funciones exactos; no escribas el código completo; si no lo sabes, dilo).
# Qué hay que corregir
${(unit.findings ?? []).map(f => `- [${f.severity}] ${f.text}${f.file ? ` (${f.file})` : ''}`).join('\n')}
# Por qué falló el intento anterior
${why}
# Archivos
${unit.files.map(f => { const c = readRepoFile(basePathOf(ctx), f, 20_000); return c === null ? `## ${f}\n(no existe)` : `## ${f}\n\`\`\`\n${clip(c, 8_000)}\n\`\`\``; }).join('\n\n')}`, 2500);
  return `Criterio de ${who.config.name} (${who.template.role}): ${clip(res.text.trim(), 3_000)}`;
}

// ---------------------------------------------------------------- Rondas de corrección dirigidas

type Finding = NonNullable<WorkUnit['findings']>[number];

/** Hallazgos de una verificación que falla, por archivo (con la evidencia real del sandbox). */
export function verificationFindings(v: VerificationRun): Finding[] {
  // «test»: las CAUSAS (aserción, preparación de la suite con su pila, plazo), nunca los nombres de las pruebas que su
  // suite canceló (HU-159: la corrección apuntaba a una prueba cancelada y el `before` que fallaba quedaba fuera).
  const causes = v.command === 'test' ? failingTests(v).filter(t => t.kind && t.kind !== 'cancelled') : [];
  const what = { hook: 'falla la preparación', timeout: 'plazo agotado en', assertion: 'falla' } as Record<string, string>;
  const d = causes.length ? causes.map(t => ({ file: t.file, line: t.line, code: null, text: `${what[t.kind!] ?? 'falla'} «${t.name}»: ${t.message}` })) : diagnosticsFor(v);
  const ev = verificationEvidence(v);
  const byFile = new Map<string, string[]>();
  for (const x of d) { const k = x.file ?? ''; byFile.set(k, [...(byFile.get(k) ?? []), `${x.line ? `línea ${x.line}: ` : ''}${x.code ? `${x.code} ` : ''}${x.text}`]); }
  if (!byFile.size) byFile.set(filesIn(v.output)[0] ?? '', [`${v.command} falla en el sandbox`]);
  return Array.from(byFile, ([file, texts]) => ({ severity: 'alta' as IssueSeverity, text: `${v.command} falla: ${texts.slice(0, 4).join(' · ')}`, file: file || null, evidence: ev, expected: `${v.command} en verde en el sandbox` }));
}

/**
 * Agrupa hallazgos en unidades dirigidas: por archivo (como mucho 3 hallazgos y 6 unidades por ronda). Un entregable del
 * plan que no está en el worktree se ENTREGA (unidad de construcción), no se «parchea».
 */
export function startRound(ctx: StoryRunCtx, cfg: PipelineConfig, source: 'qa' | 'verification' | 'completeness', findings: (Finding | QaFinding)[]) {
  const man = manifestOf(ctx); const wt = worktreeOf(ctx);
  // Un intercambio por hallazgo: si QA mantiene lo que el equipo ya discutió con evidencia, decide el propietario (sin bucle pagado).
  const persisting = source === 'qa' ? findings.filter(f => (man.disputes ?? []).some(d => sameFinding(d, { file: f.file ?? null, text: f.text }))) : [];
  if (persisting.length) {
    const lines = persisting.map(f => { const d = (man.disputes ?? []).find(x => sameFinding(x, { file: f.file ?? null, text: f.text }))!; return `QA: «${clip(f.text, 200)}»${f.file ? ` (${f.file})` : ''} — equipo: «${clip(d.answer, 300)}»`; });
    throw new PipelinePause('disagreement', `QA mantiene ${persisting.length} hallazgo(s) que el equipo ya discutió con evidencia${findings.length > persisting.length ? ` (y ${findings.length - persisting.length} más)` : ''}. No se repite el intercambio (cada vuelta se paga): decides tú con la evidencia. ${lines.join(' · ')}`);
  }
  const round = man.rounds.length;
  const byFile = new Map<string, Finding[]>();
  const changed = (resultOf(ctx).changes ?? []).filter(c => !c.error).map(c => c.path);
  const resolve = resolver(wt, [...changed, ...man.deliverables.map(d => d.path)]);
  for (const f of findings) {
    const raw = f.file ? clean(f.file) : (filesIn(`${f.text} ${f.evidence ?? ''}`)[0] ?? '');
    const file = raw ? resolve(raw) : '';
    // Una ruta que no existe y no es un entregable no da una unidad útil: el hallazgo va con el código cambiado.
    const key = file && (man.deliverables.some(d => d.path === file) || (wt && fs.existsSync(path.join(wt, file)))) ? file : '*';
    byFile.set(key, [...(byFile.get(key) ?? []), { severity: f.severity, text: f.text, file: file || null, evidence: f.evidence ?? null, expected: (f as any).expected ?? null }]);
  }
  // Sin archivo: se asocia a los archivos de código cambiados (como mucho 3).
  const general = byFile.get('*'); byFile.delete('*');
  if (general?.length) { const target = changed.filter(p => CODE_EXT.test(p)).slice(0, 3); const k = target[0] ?? changed[0] ?? ''; if (k) byFile.set(k, [...(byFile.get(k) ?? []), ...general]); }
  const groups = Array.from(byFile, ([file, fs2]) => ({ file, findings: fs2.slice(0, 3) })).slice(0, 6);
  if (!groups.length) throw new PipelinePause('qa', 'Los hallazgos no permiten identificar qué archivo corregir; decide tú con la evidencia.');
  const units: WorkUnit[] = groups.map((g, i) => {
    const d = man.deliverables.find(x => x.path === g.file);
    const missing = !!d && d.status !== 'dropped' && !(wt && fs.existsSync(path.join(wt, g.file)));
    const id = `r${round + 1}-${i + 1}`;
    return missing
      ? newUnit(ctx, ctx.dev, id, { kind: 'build', title: `Entregar ${base(g.file)}`, purpose: d!.purpose, files: [g.file], dependsOn: [], estimatedOutputTokens: d!.estimatedLines * TOKENS_PER_LINE + 400, source, findings: g.findings, round })
      : newUnit(ctx, ctx.dev, id, { kind: 'correction', title: `${base(g.file)}: ${g.findings[0].text}`.slice(0, 120), purpose: g.findings.map(f => f.text).join(' · '), files: [g.file], dependsOn: [], estimatedOutputTokens: 1500, source, findings: g.findings, round });
  });
  saveManifest(ctx, m => { m.rounds.push({ at: now(), source, units: units.length, applied: 0 }); m.units.push(...units); for (const u of units) if (u.kind === 'build') { const d = m.deliverables.find(x => x.path === u.files[0]); if (d) { d.status = 'pending'; d.unitId = u.id; } } });
  emit(ctx, 'unit', `Corrección dirigida (${source === 'qa' ? 'hallazgos de QA' : source === 'verification' ? 'verificación del sandbox' : 'comprobación previa a QA'}): ${units.length} unidad(es), solo los archivos afectados. Lo que ya funciona no se regenera.`, { phase: 'correcting', detail: units.map(u => `${u.files[0]}: ${u.findings?.length ?? 0} hallazgo(s)`).join(' · ') });
}

/**
 * Resuelve la ruta de un hallazgo contra el worktree: tal cual si existe; si no, el único archivo cambiado, entregable o
 * rastreado por git que termina en ella (p. ej. «src/x.ts» de tsc ejecutado dentro de «apps/server» → «apps/server/src/x.ts»).
 */
function resolver(wt: string | null, known: string[]): (file: string) => string {
  let tracked: string[] | null = null;
  return (file: string) => {
    if (known.includes(file) || (wt && fs.existsSync(path.join(wt, file)))) return file;
    const suffix = `/${file}`;
    const hit = Array.from(new Set(known)).filter(k => k.endsWith(suffix));
    if (hit.length === 1) return hit[0];
    if (wt && tracked === null) { try { tracked = execFileSync('git', ['ls-files'], { cwd: wt, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).split('\n').filter(Boolean); } catch { tracked = []; } }
    const t = (tracked ?? []).filter(k => k.endsWith(suffix));
    return t.length === 1 ? t[0] : file;
  };
}

/**
 * Cierra una ronda: si aplicó cambios cuenta como corrección (se vuelve a verificar y QA reevalúa); si no produjo NADA
 * aplicable tras los intentos de cada unidad, se detiene en vez de repetir lo mismo (cada intento se paga).
 */
function closeRound(ctx: StoryRunCtx, round: number) {
  const man = manifestOf(ctx); const units = man.units.filter(u => u.round === round);
  const applied = units.filter(u => (u.applied ?? []).length).length;
  const dropped = units.some(u => u.status === 'done' && !(u.applied ?? []).length && ((u.dropped ?? []).length || !!u.disputed));
  saveManifest(ctx, m => { const r = m.rounds[round]; if (r) r.applied = applied; });
  const p = pipelineOf(ctx.slug, ctx.processId);
  if (applied || dropped) {
    const n = p.corrections + 1;
    const commit = resultOf(ctx).applied?.commit ?? '';
    updatePipeline(ctx.slug, ctx.processId, { corrections: n, ...(dropped && !applied ? { lastQaCommit: null } : {}) });
    emit(ctx, 'correction', applied ? `Corrección ${n} aplicada (commit ${commit}). Se repite la verificación.` : `Corrección ${n}: sin cambios en el código; el equipo descarta o discute hallazgos con evidencia y QA vuelve a evaluar.`, { detail: units.flatMap(u => u.applied ?? []).join(', ') || units.map(u => u.disputed ? `${u.title}: ${clip(u.disputed, 200)}` : (u.dropped ?? []).join(', ')).filter(Boolean).join(' · ') });
    return;
  }
  updatePipeline(ctx.slug, ctx.processId, { ineffectiveRounds: (p.ineffectiveRounds ?? 0) + 1 });
  const why = units.map(u => `${u.title}: ${u.error ?? 'sin cambios'}`).join(' · ');
  throw new PipelinePause('repeated_failure', `La corrección no produjo ningún cambio aplicable tras ${units.reduce((s, u) => s + u.attempts, 0)} intento(s) con estrategias distintas (${clip(why, 600)}). El equipo se detiene en vez de repetir lo mismo; lo hecho se conserva. No cuenta como corrección aplicada.`);
}

// ---------------------------------------------------------------- Comprobación determinista previa a QA

/** Glob → fuente de expresión regular, en una pasada: «**\/» = cualquier número de carpetas, «**» = cualquier cosa, «*» = dentro de una carpeta. */
export function globSource(g: string): string {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*' && g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
    else if (c === '*' && g[i + 1] === '*') { re += '.*'; i += 1; }
    else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+^${}()|[\]\\/]/, '\\$&');
  }
  return re;
}

/** Script «test» del package.json más cercano a la prueba y si su ruta/patrón la incluye (null = no comprobable). */
export function testDiscovered(wt: string, file: string): { ok: boolean; script: string } | null {
  let dir = path.posix.dirname(file);
  for (;;) {
    const pj = path.join(wt, dir, 'package.json');
    if (fs.existsSync(pj)) {
      let script = ''; try { script = String(JSON.parse(fs.readFileSync(pj, 'utf8'))?.scripts?.test ?? ''); } catch { return null; }
      const tokens = script.split(/\s+/).map(t => t.replace(/^['"]|['"]$/g, '')).filter(t => t && !t.startsWith('-') && !t.includes('=') && (t.includes('/') || t.includes('*')) && !/^(node|npx|tsx|vitest|jest|mocha)$/.test(t));
      if (!tokens.length) return null;
      const rel = dir === '.' ? file : path.posix.relative(dir, file);
      const checkable = tokens.filter(t => !/[{}?[\]!]/.test(t));
      if (!checkable.length) return null;
      const ok = checkable.some(t => { const g = t.replace(/^\.\//, ''); const re = new RegExp(`^${globSource(g)}${g.endsWith('/') || !/[.*]/.test(base(g)) ? '' : '$'}`); return re.test(rel) || (!/[*]/.test(g) && rel.startsWith(g.replace(/\/?$/, '/'))); });
      // Si alguna ruta del script no se pudo interpretar, podría ser la que incluye la prueba: no se afirma nada.
      if (!ok && checkable.length < tokens.length) return null;
      return { ok, script };
    }
    if (dir === '.' || !dir) return null;
    dir = path.posix.dirname(dir);
  }
}

export function completenessGate(ctx: StoryRunCtx): CompletenessGate {
  const man = manifestOf(ctx); const r = resultOf(ctx); const wt = worktreeOf(ctx);
  const changed = new Map((r.changes ?? []).filter(c => !c.error).map(c => [c.path, c]));
  const missing = man.deliverables.filter(d => d.planned && d.status !== 'dropped' && !changed.has(d.path)).map(d => d.path);
  const invalid: CompletenessGate['invalid'] = [];
  const notes: string[] = [];
  for (const [p, c] of changed) {
    if (c.action === 'delete' || !wt) continue;
    const text = readRepoFile(wt, p, 400_000); if (text === null) continue;
    const syn = /\.json$/i.test(p) ? syntaxProblem(p, text) : null; if (syn) invalid.push({ path: p, problem: syn });
    if (/^(<{7}|>{7})( |$)/m.test(text)) invalid.push({ path: p, problem: 'contiene marcadores de conflicto de git' });
    if (CODE_EXT.test(p) && /^\s*(?:\/\/|\/\*)\s*\.\.\.\s*(?:\*\/)?\s*$|\/\/\s*\.\.\.\s*(?:resto|rest|existing|c[oó]digo existente|igual que antes)/im.test(text)) invalid.push({ path: p, problem: 'contiene contenido omitido («...»): no es un archivo completo' });
    if (isTestEntry(p)) { const t = testDiscovered(wt, p); if (t && !t.ok) invalid.push({ path: p, problem: `el script «test» no ejecuta esta prueba (${t.script})` }); }
  }
  const testsChanged = Array.from(changed.keys()).filter(p => kindOf(p) === 'test');
  const newCode = Array.from(changed.values()).filter(c => c.action === 'create' && kindOf(c.path) === 'code' && CODE_EXT.test(c.path));
  if (newCode.length && !testsChanged.length) notes.push(`Código nuevo sin pruebas nuevas en el diff: ${newCode.map(c => c.path).join(', ')}.`);
  const dropped = man.deliverables.filter(d => d.status === 'dropped').map(d => ({ path: d.path, reason: d.note ?? '' }));
  const extra = Array.from(changed.keys()).filter(p => !man.deliverables.some(d => d.path === p && d.planned));
  return { at: now(), commit: r.applied?.commit ?? null, ok: !missing.length && !invalid.length, missing, invalid, dropped, extra, testsChanged, notes };
}

// ---------------------------------------------------------------- Ejecución real de las pruebas nuevas

/** Un archivo de prueba se ejecutó si alguno de sus casos aparece en la salida de «test»; si no se puede saber, se dice. */
export function testFileExecuted(content: string | null, output: string | null): { state: CheckState; detail: string } {
  if (content === null) return { state: 'undetermined', detail: 'no se pudo leer el archivo' };
  const names = Array.from(content.matchAll(/\b(?:test|it|describe)(?:\.\w+)?\s*\(\s*(['"`])((?:(?!\1)[^\\\n]){3,140})\1/g)).map(m => m[2]);
  if (output === null) return { state: 'undetermined', detail: 'no hay una ejecución de «test» en verde sobre este commit' };
  if (!names.length) return { state: 'undetermined', detail: 'no se encontraron nombres de casos en el archivo' };
  const seen = names.filter(n => output.includes(n));
  if (seen.length) return { state: 'passed', detail: `${seen.length} de ${names.length} caso(s) aparecen en la salida de «test»` };
  // Salida recortada sin todas las líneas de resultado: que no aparezca no prueba que no se ejecutara.
  if (/caracteres omitidos/.test(output) && !/los nombres de todas las pruebas superadas/.test(output)) return { state: 'undetermined', detail: 'la salida de «test» se recortó y no conserva los nombres de todas las pruebas superadas' };
  const listsTests = /^\s*(?:ok|not ok) \d+ - |^\s*[✔✓√] |^# Subtest: |\bpassing\b/m.test(output);
  return listsTests ? { state: 'failed', detail: `la salida de «test» lista otras pruebas, pero ninguno de sus ${names.length} caso(s)` } : { state: 'undetermined', detail: 'la salida de «test» no muestra los nombres de los casos' };
}

/**
 * Tras una verificación en verde y ANTES de pagar a QA: las pruebas nuevas, ¿se ejecutaron? Una que no se ejecutó es un
 * fallo objetivo (corrección dirigida sin QA); una indeterminada se declara como tal (nunca cuenta como evidencia).
 */
/** Evidencia de ejecución de las pruebas nuevas sobre el commit actual (sin IA): se guarda en el manifiesto y se anuncia. */
export function testEvidence(ctx: StoryRunCtx, cfg: PipelineConfig): { notRun: { path: string; detail: string }[]; run: VerificationRun | null } | null {
  const r = resultOf(ctx); const man = manifestOf(ctx); const wt = worktreeOf(ctx);
  if (!r.applied || !wt || man.testRun?.commit === r.applied.commit) return null;
  const run = sinceApplied(r).filter(v => v.command === 'test' && v.exitCode === 0).at(-1) ?? null;
  const tests = (r.changes ?? []).filter(c => !c.error && c.action !== 'delete' && isTestEntry(c.path)).map(c => c.path);
  const results = tests.map(p => ({ path: p, ...testFileExecuted(readRepoFile(wt, p, 200_000), cfg.commands.includes('test') ? run?.output ?? null : null) }));
  saveManifest(ctx, m => { m.testRun = { commit: r.applied!.commit, at: now(), results }; });
  if (!results.length) return null;
  const notRun = results.filter(x => x.state === 'failed'); const unknown = results.filter(x => x.state === 'undetermined');
  emit(ctx, 'gate', notRun.length ? `${notRun.length} prueba(s) nueva(s) no se ejecutaron en el sandbox: se corrigen antes de pagar a QA.` : unknown.length ? `No se pudo determinar si ${unknown.length} prueba(s) nueva(s) se ejecutaron; QA lo sabrá (no cuenta como evidencia).` : `Las ${results.length} prueba(s) nueva(s) se ejecutaron en el sandbox.`, { phase: 'verifying', detail: results.map(x => `${x.path}: ${x.detail}`).join(' · ') });
  return { notRun, run };
}

export function afterVerification(ctx: StoryRunCtx, cfg: PipelineConfig): boolean {
  const t = testEvidence(ctx, cfg); if (!t?.notRun.length) return false;
  const { notRun, run } = t;
  if (pipelineOf(ctx.slug, ctx.processId).corrections >= cfg.maxCorrections) throw new PipelinePause('incomplete', `${notRun.length} prueba(s) nueva(s) no se ejecutaron en el sandbox y no quedan correcciones autorizadas. No se paga a QA sin esa evidencia; lo hecho se conserva.`);
  startRound(ctx, cfg, 'completeness', notRun.map(x => ({ severity: 'alta' as IssueSeverity, text: `La prueba ${x.path} no se ejecutó en el sandbox: ${x.detail}`, file: x.path, evidence: clip(run?.output ?? '', 1_200), expected: 'que el script «test» la ejecute (ubicación del archivo o patrón del script)' })));
  return true;
}

/** Estado explícito de cada comprobación: superada, fallida, no aplica o no determinada. */
export function deliveryChecks(p: Process): DeliveryCheck[] {
  const r = p.result; if (!r) return [];
  const cmds = r.pipeline?.config.commands ?? [];
  const since = r.applied ? (r.verifications ?? []).filter(v => new Date(v.startedAt).getTime() >= new Date(r.applied!.appliedAt).getTime()) : [];
  const out: DeliveryCheck[] = (['typecheck', 'test', 'build'] as const).map(cmd => {
    if (!cmds.includes(cmd)) return { name: cmd, state: 'not_applicable' as CheckState, detail: 'no se pidió en esta autorización' };
    const v = since.filter(x => x.command === cmd).at(-1);
    if (!v) return { name: cmd, state: 'undetermined' as CheckState, detail: 'aún no se ejecutó sobre el último commit' };
    if (v.exitCode === 0) return cmd === 'test' && zeroTests(v.output) ? { name: cmd, state: 'undetermined' as CheckState, detail: 'terminó sin ejecutar ninguna prueba' } : { name: cmd, state: 'passed' as CheckState, detail: `${v.isolation ?? 'sandbox'} · ${Math.round(v.durationMs / 1000)} s` };
    if (v.exitCode === null || v.exitCode === 86 || v.isolation === 'unavailable') return { name: cmd, state: 'undetermined' as CheckState, detail: 'el entorno no permitió completarla' };
    return { name: cmd, state: 'failed' as CheckState, detail: `código ${v.exitCode}` };
  });
  const man = r.manifest; const tr = man?.testRun && man.testRun.commit === r.applied?.commit ? man.testRun : null;
  const hasTests = (r.changes ?? []).some(c => !c.error && c.action !== 'delete' && isTestEntry(c.path));
  const st: CheckState = !hasTests ? 'not_applicable' : !tr ? 'undetermined' : tr.results.some(x => x.state === 'failed') ? 'failed' : tr.results.some(x => x.state === 'undetermined') ? 'undetermined' : 'passed';
  out.push({ name: 'pruebas nuevas ejecutadas', state: st, detail: !hasTests ? 'sin pruebas nuevas en el diff' : !tr ? 'aún sin comprobar sobre el último commit' : tr.results.map(x => `${x.path}: ${x.detail}`).join(' · ') });
  return out;
}

// ---------------------------------------------------------------- Avance (lo llama el pipeline en cada vuelta)

/**
 * Lo que la entrega incremental tiene pendiente antes de verificar: unidades (del plan o de una ronda de corrección) y la
 * comprobación determinista. Devuelve true si hizo algo (el pipeline vuelve a empezar la vuelta).
 */
export async function advanceUnits(ctx: StoryRunCtx, cfg: PipelineConfig): Promise<boolean> {
  const isPending = (u: WorkUnit) => u.status === 'pending' || u.status === 'running';
  // Correcciones planificadas con pruebas solo canceladas (sin la causa a la vista): se sustituyen sin IA y sin gastar
  // corrección por una nueva verificación de «test», que muestra la causa; con ella se planifica una corrección dirigida.
  const stale = staleCorrectionUnits(resultOf(ctx));
  if (stale.length) {
    const titles = manifestOf(ctx).units.filter(u => stale.includes(u.id)).map(u => u.title);
    saveManifest(ctx, m => { for (const u of m.units) if (stale.includes(u.id)) { u.status = 'skipped'; u.error = 'Sustituida sin IA: se planificó con pruebas canceladas por su suite, sin un fallo propio a la vista. Se repite «test» para ver la causa real.'; u.finishedAt = now(); } });
    // Pasos «Corrección N» que se crearon y nunca llegaron a llamar a la IA (antes de que la puerta de Claude Code se
    // comprobara primero): se cierran como omitidos, costo 0, para que no parezcan trabajo pendiente.
    const live = new Set(manifestOf(ctx).units.filter(u => !stale.includes(u.id)).flatMap(u => [...u.stepIds, u.reservedStepId ?? '']));
    const procs = processesRepo(ctx.slug);
    for (const st of procs.get(ctx.processId)!.steps) if (st.status === 'pending' && !st.outputMd && !st.costUsd && /^Corrección/.test(st.title) && !live.has(st.id)) procs.stepFinish(st.id, 'skipped', { error: 'No llegó a llamar a la IA (se detuvo antes por Claude Code). Sustituido sin IA por una nueva verificación; costo 0.' });
    emit(ctx, 'unit', `${stale.length} corrección(es) pendiente(s) sustituida(s) sin IA: se planificaron con pruebas canceladas (no son fallos propios). Antes de pagar una corrección se repite «test» para ver la causa real.`, { phase: 'verifying', detail: titles.join(' · ') });
  }
  if (manifestOf(ctx).units.some(isPending)) {
    const rounds = new Set<number>();
    for (let guard = 0; guard < 200; guard++) {
      const next = manifestOf(ctx).units.find(isPending); if (!next) break;
      checkCancelled(ctx); checkDuration(ctx, cfg);
      if (next.round !== undefined) rounds.add(next.round);
      await runUnit(ctx, cfg, next.id);
    }
    for (const r of rounds) closeRound(ctx, r);
    return true;
  }
  const r = resultOf(ctx);
  if (!r.applied) {
    const drops = manifestOf(ctx).deliverables.filter(d => d.status === 'dropped');
    throw new PipelinePause('no_changes', drops.length ? `El equipo concluye que los entregables del plan no hacen falta: ${drops.map(d => `${d.path} (${clip(d.note ?? '', 160)})`).join(' · ')}. Revisa la justificación.` : 'Las unidades terminaron sin ningún cambio aplicable.');
  }
  const man = manifestOf(ctx);
  if (man.gate?.commit === r.applied.commit) return false;
  const gate = completenessGate(ctx);
  saveManifest(ctx, m => { m.gate = gate; });
  const delivered = man.deliverables.filter(d => d.planned && d.status !== 'dropped').length - gate.missing.length;
  emit(ctx, 'gate', gate.ok ? `Comprobación previa a QA (sin IA): ${delivered} de ${delivered + gate.missing.length} entregables del plan en el worktree, sin problemas objetivos.` : `Comprobación previa a QA (sin IA): ${gate.missing.length} entregable(s) sin entregar y ${gate.invalid.length} problema(s) objetivos. Se resuelven antes de pagar a QA.`, { phase: 'verifying', detail: [...gate.missing.map(m => `falta ${m}`), ...gate.invalid.map(i => `${i.path}: ${i.problem}`), ...gate.notes].join(' · ') || null });
  if (gate.ok) return false;
  if (pipelineOf(ctx.slug, ctx.processId).corrections >= cfg.maxCorrections) throw new PipelinePause('incomplete', `La comprobación previa a QA encontró ${gate.missing.length} entregable(s) sin entregar y ${gate.invalid.length} problema(s), y no quedan correcciones autorizadas (${cfg.maxCorrections}). No se paga a QA por una entrega incompleta; lo hecho se conserva.`);
  startRound(ctx, cfg, 'completeness', [
    ...gate.missing.map(f => ({ severity: 'alta' as IssueSeverity, text: `Falta el entregable del plan ${f}`, file: f, evidence: 'No está en el diff del worktree (comprobación determinista).', expected: man.deliverables.find(d => d.path === f)?.purpose ?? null })),
    ...gate.invalid.map(i => ({ severity: 'alta' as IssueSeverity, text: `${i.path}: ${i.problem}`, file: i.path, evidence: 'Comprobación determinista previa a QA.', expected: null }))
  ]);
  return true;
}

/**
 * Comprobaciones objetivas SIN IA sobre el commit actual (tras registrar una corrección externa): completitud del plan,
 * verificación en el sandbox y evidencia de las pruebas nuevas. Nunca abre una ronda de corrección ni llama a QA.
 */
export async function objectiveChecks(ctx: StoryRunCtx, cfg: PipelineConfig): Promise<{ gate: CompletenessGate | null; failed: VerificationRun | null; notRun: string[] }> {
  let gate: CompletenessGate | null = null;
  if (resultOf(ctx).manifest) {
    const g = completenessGate(ctx); gate = g; saveManifest(ctx, m => { m.gate = g; });
    emit(ctx, 'gate', g.ok ? 'Comprobación previa a QA (sin IA): todos los entregables del plan están en el worktree, sin problemas objetivos.' : `Comprobación previa a QA (sin IA): ${g.missing.length} entregable(s) sin entregar y ${g.invalid.length} problema(s) objetivos.`, { phase: 'verifying', detail: [...g.missing.map(m => `falta ${m}`), ...g.invalid.map(i => `${i.path}: ${i.problem}`)].join(' · ') || null });
  }
  let failed = cfg.autoVerify ? await verifyStage(ctx, cfg) : null;
  // Igual que en el pipeline: si solo fallan pruebas ajenas a la historia, «test» se repite una vez (sin IA).
  if (failed && await retryForeignFailure(ctx, failed)) failed = await verifyStage(ctx, cfg);
  const t = !failed && resultOf(ctx).manifest ? testEvidence(ctx, cfg) : null;
  return { gate, failed, notRun: t?.notRun.map(x => x.path) ?? [] };
}

/** Al continuar tras una pausa por entrega incompleta, las unidades fallidas del plan vuelven a intentarse (con su motivo). */
export function prepareResume(ctx: StoryRunCtx) {
  const man = processesRepo(ctx.slug).get(ctx.processId)?.result?.manifest; if (!man) return;
  if (man.gate && !man.gate.ok) saveManifest(ctx, m => { m.gate = null; });
  if (!man.units.some(u => u.status === 'failed' && u.kind === 'build')) return;
  saveManifest(ctx, m => {
    for (const u of m.units) if (u.status === 'failed' && u.kind === 'build') { u.status = 'pending'; u.attempts = 0; u.exhausted = 0; u.outputs = []; }
    for (const d of m.deliverables) if (d.status === 'failed') d.status = 'pending';
  });
}

// ---------------------------------------------------------------- Resumen para la interfaz

export function deliveryProgress(p: Process): DeliveryProgress | null {
  const r = p.result; const man = r?.manifest; if (!r || !man) return null;
  const pl = r.pipeline;
  const planned = man.deliverables.filter(d => d.planned);
  const delivered = planned.filter(d => d.status === 'delivered').length;
  const since = r.applied ? (r.verifications ?? []).filter(v => new Date(v.startedAt).getTime() >= new Date(r.applied!.appliedAt).getTime()) : [];
  const last = (c: string) => since.filter(v => v.command === c).at(-1);
  const comp = ['typecheck', 'build'].map(last).filter(Boolean) as VerificationRun[];
  const compiles = !comp.length ? null : comp.every(v => v.exitCode === 0) ? true : comp.some(v => v.exitCode !== 0 && v.exitCode !== null && v.exitCode !== 86 && v.isolation !== 'unavailable') ? false : null;
  const complete = planned.every(d => d.status === 'delivered' || d.status === 'dropped') && (!man.gate || man.gate.commit !== r.applied?.commit || man.gate.ok);
  const qaApproved = r.review?.verdict === 'approved' && !!r.applied && pl?.lastQaCommit === r.applied.commit;
  const running = p.status === 'running' ? man.units.find(u => u.status === 'running') ?? man.units.find(u => u.status === 'pending') : undefined;
  const corrUnits = man.units.filter(u => u.source && u.source !== 'plan');
  const pendingUsd = man.units.filter(u => u.status === 'pending' || u.status === 'running').reduce((s, u) => s + u.estimatedUsd, 0);
  const qaSteps = p.steps.filter(s => s.role === 'reviewer' && s.status === 'done' && s.costUsd > 0);
  const qaUsd = qaApproved ? 0 : qaSteps.length ? qaSteps.reduce((s, x) => s + x.costUsd, 0) / qaSteps.length : 0.25;
  const paused = pl && (pl.state === 'paused' || pl.state === 'stopped');
  const planUnits = man.units.filter(u => (u.source ?? 'plan') === 'plan');
  const next = p.status === 'running'
    ? running ? `${running.kind === 'correction' ? 'Corrección dirigida' : 'Entregar'} «${running.title}» (${running.agentName})` : pl?.phase === 'verifying' || pl?.phase === 'installing' ? 'Verificar en el sandbox (typecheck, pruebas, build)' : pl?.phase === 'qa' ? 'Revisión de QA con la evidencia' : 'El equipo trabaja'
    : qaApproved ? 'Tu revisión: el diff y la evidencia están listos (integrar sigue siendo decisión tuya)'
    : paused ? 'Decide en «Problema actual»: continuar, acotar o rechazar' : 'Revisar el resultado';
  return {
    deliverables: man.deliverables.map(d => ({ path: d.path, kind: d.kind, status: d.status, planned: d.planned, note: d.note, unit: d.unitId, lines: d.lines })),
    delivered, total: planned.length,
    units: { done: man.units.filter(u => u.status === 'done').length, total: man.units.length },
    currentUnit: running ? { title: running.title, agentName: running.agentName, kind: running.kind, index: (running.source ?? 'plan') === 'plan' ? planUnits.findIndex(u => u.id === running.id) + 1 : man.units.findIndex(u => u.id === running.id) + 1, total: (running.source ?? 'plan') === 'plan' ? planUnits.length : man.units.length } : null,
    levels: { compiles, complete, qaApproved },
    checks: deliveryChecks(p),
    corrections: { applied: pl?.corrections ?? 0, max: pl?.config.maxCorrections ?? 0, requested: corrUnits.length, ineffective: pl?.ineffectiveRounds ?? 0, attempts: pl?.correctionAttempts ?? 0 },
    continuations: pl?.continuations ?? 0,
    spentUsd: p.spentUsd,
    remainingEstimateUsd: Number((pendingUsd + qaUsd).toFixed(4)),
    blocker: paused ? pl!.reason : null,
    next
  };
}

