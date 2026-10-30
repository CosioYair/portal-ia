import { decideGauntlet, GAUNTLET_SCHEMA, GAUNTLET_TEMPLATE, gauntletOverhead, isRetired, normalizeGauntlet, recommendGauntlet, type Agent, type GauntletConfig, type GauntletFinding, type GauntletRound, type GauntletState, type IssueSeverity, type PipelineConfig, type Process } from '@portal-ia/domain';
import { settingsRepo, providersRepo } from '../db/platform.ts';
import { agentsRepo, backlogRepo, processesRepo, projectsRepo } from '../db/workspace.ts';
import { buildAgentConfig } from '../routes/bootstrap.ts';
import { inheritLatestTemplate } from './agentTemplates.ts';
import { clip } from './devOutput.ts';
import { testsEvidence, verificationEvidence } from './qaGate.ts';
import { sys } from './storyPrompts.ts';
import { emit, PipelinePause, pipelineOf, sinceApplied, stepCall, updateResult, type StoryRunCtx } from './storyPipeline.ts';

/**
 * Evaluación Gauntlet en el pipeline existente (ver packages/domain/src/gauntlet.ts para el método y la relación con
 * QA). Aquí: modo por proyecto y por tarea, recomendación sin IA, el Evaluador en el equipo autorizado, el paquete de
 * evaluación con contexto NUEVO (sin la explicación del constructor), la puerta de evidencia y la etapa acotada.
 */

const fail = (statusCode: number, message: string, code: string) => Object.assign(new Error(message), { statusCode, code });
const now = () => new Date().toISOString();
/** Versión del encargo del Evaluador (plantilla de prompt versionada: cambia si cambia su contrato). */
export const GAUNTLET_PROMPT_VERSION = 'gauntlet-eval@1';

// ---------------------------------------------------------------- Modo por proyecto (predeterminado) y por tarea

const KEY = (slug: string, projectId: string) => `gauntlet:${slug}:${projectId}`;
export function projectGauntlet(slug: string, projectId: string): GauntletConfig {
  try { return normalizeGauntlet(JSON.parse(settingsRepo.get(KEY(slug, projectId)) ?? 'null')); } catch { return normalizeGauntlet(null); }
}
export function setProjectGauntlet(slug: string, projectId: string, g: Partial<GauntletConfig>): GauntletConfig {
  const n = normalizeGauntlet(g); settingsRepo.set(KEY(slug, projectId), JSON.stringify(n)); return n;
}

/** Evaluador del proyecto (capacidad evaluar_gauntlet, no retirado). */
export function projectEvaluator(slug: string, projectId: string): Agent | null {
  return agentsRepo(slug).list().find(a => a.projectId === projectId && !isRetired(a.template) && (a.config.capabilities ?? []).includes('evaluar_gauntlet') && !!a.config.tools?.read_repo) ?? null;
}

/** Recomendación (sin IA) y sobrecoste del modo para una historia, para mostrarlos ANTES de autorizar. */
export function gauntletAdvice(slug: string, projectId: string, itemId: string) {
  const item = backlogRepo(slug).get(itemId);
  if (!item) throw fail(404, 'Historia no encontrada.', 'not_found');
  const procs = processesRepo(slug).listAll(projectId).filter(p => p.backlogItemId === itemId && p.kind === 'story_execution');
  const qaRejections = procs.filter(p => p.result?.review?.verdict === 'rejected').length;
  const evaluator = projectEvaluator(slug, projectId);
  const rec = recommendGauntlet({ hasEvaluator: !!evaluator, estimate: item.estimate ?? null, text: `${item.title} ${item.criterion ?? ''} ${item.description ?? ''}`, iterations: procs.length, qaRejections });
  const def = projectGauntlet(slug, projectId);
  return { projectDefault: def, recommended: rec, evaluator: evaluator ? { id: evaluator.id, name: evaluator.config.name, model: evaluator.config.model } : null, overhead: { standard: gauntletOverhead(normalizeGauntlet({ mode: 'standard' })), deep: gauntletOverhead(normalizeGauntlet({ mode: 'deep' })) } };
}

/**
 * Alinea el paso del Evaluador con el modo autorizado: con Gauntlet, el Evaluador del proyecto entra en el equipo
 * autorizado (paso trazable); sin él, su paso planificado queda omitido. Nunca el implementador.
 */
export function syncEvaluatorStep(slug: string, processId: string, g: GauntletConfig): { evaluator: Agent | null; note: string | null } {
  const procs = processesRepo(slug); const proc = procs.get(processId)!;
  const step = proc.steps.find(s => s.role === 'evaluator');
  if (g.mode === 'off') {
    if (step && step.status === 'pending') procs.stepFinish(step.id, 'skipped', { error: 'Gauntlet desactivado al autorizar: no se evalúa.' });
    return { evaluator: null, note: null };
  }
  const dev = proc.steps.find(s => s.role === 'implementer')?.agentId;
  if (step && step.agentId === dev) {
    if (step.status === 'pending') procs.stepFinish(step.id, 'skipped', { error: 'El Evaluador no puede ser quien implementa: no se autoevalúa.' });
    return { evaluator: null, note: 'El Evaluador es el mismo agente que implementa: no se autoevalúa.' };
  }
  if (step) return { evaluator: agentsRepo(slug).get(step.agentId) ?? null, note: null };
  const ev = projectEvaluator(slug, proc.projectId);
  if (!ev) return { evaluator: null, note: 'No hay un Evaluador Gauntlet en el proyecto: se aplica la verificación y QA de siempre.' };
  if (ev.id === dev) return { evaluator: null, note: 'El Evaluador es el mismo agente que implementa: no se autoevalúa.' };
  procs.addStep(processId, { agentId: ev.id, agentName: ev.config.name, title: 'Evaluación Gauntlet (independiente)', model: ev.config.model, role: 'evaluator', reason: `Evalúa de forma independiente (modo ${g.mode})` });
  return { evaluator: ev, note: null };
}

/**
 * Aprobación organizativa del propietario: crea el Evaluador Gauntlet en el proyecto a partir de la plantilla
 * propuesta (versionada), con su capacidad, herramientas mínimas (solo lectura) y su jefe (Coordinador del proyecto).
 */
export function createEvaluator(slug: string, projectId: string, opts: { model?: string | null; effort?: 'low' | 'medium' | 'high' | null } = {}): Agent {
  const project = projectsRepo(slug).get(projectId); if (!project) throw fail(404, 'Proyecto no encontrado.', 'not_found');
  const existing = projectEvaluator(slug, projectId); if (existing) throw fail(409, `El proyecto ya tiene su Evaluador Gauntlet (${existing.config.name}).`, 'exists');
  const agents = agentsRepo(slug);
  if (agents.byKey(GAUNTLET_TEMPLATE.key, projectId)) throw fail(409, 'Ya existe un agente con la clave del Evaluador en este proyecto (quizá retirado): reactívalo en vez de crear otro.', 'exists');
  const qa = agents.byKey('pj-qa', projectId); const coord = agents.byKey('pj-coordinador', projectId);
  const provider = (qa?.config.provider ?? 'anthropic') as any; const prow = providersRepo.get(provider);
  if (!prow || prow.status !== 'connected') throw fail(409, 'Conecta el proveedor antes de crear agentes.', 'no_provider');
  const models = (() => { try { return JSON.parse((prow as any).models_json ?? '[]'); } catch { return []; } })();
  const config = buildAgentConfig(GAUNTLET_TEMPLATE, provider, models, qa?.config.model ?? (prow as any).default_model ?? null);
  if (opts.model) config.model = opts.model; if (opts.effort) config.effort = opts.effort;
  // Mismo origen de ejecución que QA (p. ej. Claude Code): no se cambia de origen facturable sin decisión del propietario.
  if (qa?.config.backend) config.backend = qa.config.backend;
  const a = agents.createFromTemplate(GAUNTLET_TEMPLATE, projectId, config);
  if (coord && !coord.template.supervises.includes(a.key)) agents.updateTemplateMeta(coord.id, { ...coord.template, supervises: [...coord.template.supervises, a.key] });
  return inheritLatestTemplate(slug, a);
}

// ---------------------------------------------------------------- Paquete de evaluación (contexto nuevo)

/**
 * Lo que recibe el Evaluador: objetivo, criterios, restricciones, evidencia objetiva y el resultado real (diff). NO
 * recibe el resumen del constructor, sus consultas ni el razonamiento del plan: las afirmaciones del equipo van aparte,
 * marcadas como algo a comprobar, no como prueba.
 */
export function gauntletPrompt(ctx: StoryRunCtx, proc: Process, cfg: PipelineConfig, previous: GauntletRound[]): string {
  const r = proc.result!; const item = ctx.item;
  const criteria = Array.from(new Set([...(ctx.plan?.acceptance ?? []), ...(item.criterion ? [item.criterion] : [])].map(c => c.trim()).filter(Boolean)));
  const verifs = sinceApplied(r);
  const evidence = cfg.commands.map(c => { const v = verifs.filter(x => x.command === c).at(-1); return v ? `- ${c}: ${v.exitCode === 0 ? 'en verde' : `FALLA (código ${v.exitCode})`} · ${v.isolation ?? '?'}\n${clip(verificationEvidence(v), 1200).split('\n').map(l => `  ${l}`).join('\n')}` : `- ${c}: sin ejecutar sobre este commit`; }).join('\n');
  const deliverables = r.manifest ? r.manifest.deliverables.map(d => `- ${d.path} (${d.kind}): ${d.status}${d.planned ? '' : ' · fuera del plan'}`).join('\n') : (ctx.plan?.filesToChange ?? []).map(f => `- ${f}`).join('\n');
  const diff = r.changes.filter(c => !c.error).map(c => `## ${c.path} (${c.action})\n\`\`\`diff\n${clip(c.diff ?? "", 12_000)}\n\`\`\``).join('\n\n');
  const claims = [r.userFacing ? `Para el propietario: ${clip(r.userFacing, 1500)}` : '', r.manualTest?.steps?.length ? `Prueba manual propuesta:\n${r.manualTest.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : ''].filter(Boolean).join('\n');
  // Si el equipo discutió una brecha con evidencia, el Evaluador la ve como afirmación a comprobar (no como prueba).
  const disputes = (r.manifest?.disputes ?? []).filter(d => /^\[Gauntlet/.test(d.finding)).slice(-4).map(d => `- Sobre «${clip(d.finding, 200)}»${d.file ? ` (${d.file})` : ''}: ${clip(d.answer, 800)}`).join('\n');
  const prev = previous.length ? previous.map(p => `- Ronda ${p.round} (commit ${p.commit ?? '?'}): ${p.largestGap ?? 'sin brecha principal'} · ${p.decision === 'correct' ? 'se pidió una corrección dirigida' : p.reason}${p.findings.filter(f => !f.unsupported && f.severity !== 'minor').map(f => `\n  · [${f.severity}] ${f.text}${f.file ? ` (${f.file})` : ''}`).join('')}`).join('\n') : '';
  return `Evalúa de forma INDEPENDIENTE el resultado de esta historia (${GAUNTLET_PROMPT_VERSION}). No recibes la explicación del equipo que la construyó, a propósito: juzga el resultado real y su evidencia.
# Objetivo
${item.storyId} · ${item.title}
${item.description ? `${clip(item.description, 2000)}\n` : ''}# Criterios de aceptación (evalúa CADA uno)
${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n') || '(la historia no tiene criterios explícitos: dilo en limitations y evalúa contra el objetivo)'}
# Restricciones
- Solo cuenta lo que está en el resultado (diff) y en la evidencia objetiva; no lo que se dice de él.
- Entregables planificados:
${deliverables || '- (sin plan de archivos)'}
# Evidencia objetiva (sandbox, sin IA)
${evidence}
${testsEvidence(verifs) ? `${clip(testsEvidence(verifs), 2500)}\n` : ''}${claims || disputes ? `# Afirmaciones del equipo (NO son evidencia: compruébalas contra el diff y la evidencia)\n${[claims, disputes ? `El equipo discute brechas anteriores:\n${disputes}` : ''].filter(Boolean).join('\n')}\n` : ''}${prev ? `# Rondas anteriores (comprueba si la brecha señalada sigue)\n${prev}\n` : ''}# El resultado: diff de la historia
${clip(diff, 45_000) || '(sin cambios)'}

# Reglas
- Cada hallazgo necesita evidencia concreta: archivo:línea, un fragmento del diff o la salida de la verificación. Sin evidencia, no es un hallazgo: anótalo en limitations.
- severity: blocking (un criterio no se cumple o hay un defecto que el propietario notaría), major (se cumple a medias o con un defecto relevante), minor (mejora que no cambia el resultado).
- criteria: un elemento por criterio con status met | partial | unmet | unverifiable y la evidencia que lo respalda.
- largestGap: la brecha más importante que queda, en una frase (o null si no queda ninguna).
- anotherRoundWorthIt: true solo si corregir lo pendiente cambia de verdad el resultado.
- Lo que no puedas comprobar con esta evidencia (p. ej. el aspecto visual sin capturas): márcalo unverifiable y dilo en limitations; no inventes certeza.
- No reescribas ni rediseñes: señala lo que falla y lo esperado, para una corrección dirigida.`;
}

/** Sistema del Evaluador: el de su papel en el proyecto más su carta (independencia y evidencia). */
export function gauntletSystem(ev: Agent, ctx: StoryRunCtx): string {
  return `${sys(ev, ctx.project, ctx.item)}

# Carta del Evaluador Gauntlet
Eres un crítico independiente: no implementas lo que evalúas y no te fías de explicaciones; juzgas el resultado real contra el estándar acordado (criterios de aceptación) con evidencia. Señala la brecha más importante primero.`;
}

// ---------------------------------------------------------------- Puerta de evidencia (determinista)

const SEV: Record<string, GauntletFinding['severity']> = { blocking: 'blocking', major: 'major', minor: 'minor' };
/** Interpreta la salida del Evaluador y aplica la puerta: un hallazgo sin evidencia concreta no motiva correcciones. */
export function parseGauntlet(text: string): Pick<GauntletRound, 'verdict' | 'criteria' | 'findings' | 'largestGap' | 'anotherRoundWorthIt' | 'limitations'> {
  let j: any = null;
  try { j = JSON.parse(text); } catch { const m = text.match(/\{[\s\S]*\}/); if (m) { try { j = JSON.parse(m[0]); } catch { j = null; } } }
  if (!j || typeof j !== 'object') return { verdict: 'cannot_evaluate', criteria: [], findings: [], largestGap: null, anotherRoundWorthIt: false, limitations: ['El Evaluador no devolvió una evaluación legible.'] };
  const findings: GauntletFinding[] = (Array.isArray(j.findings) ? j.findings : []).slice(0, 12).map((f: any) => {
    const evidence = typeof f?.evidence === 'string' && f.evidence.trim().length >= 6 ? f.evidence.trim().slice(0, 1500) : null;
    const file = typeof f?.file === 'string' && f.file.trim() ? f.file.trim().slice(0, 300) : null;
    return { severity: SEV[f?.severity] ?? 'minor', criterion: typeof f?.criterion === 'string' ? f.criterion.slice(0, 300) : null, text: String(f?.text ?? '').slice(0, 800), file, evidence, expected: typeof f?.expected === 'string' ? f.expected.slice(0, 600) : null, unsupported: !evidence };
  }).filter((f: GauntletFinding) => f.text.trim());
  const criteria = (Array.isArray(j.criteria) ? j.criteria : []).slice(0, 30).map((c: any) => ({ criterion: String(c?.criterion ?? '').slice(0, 400), status: ['met', 'partial', 'unmet', 'unverifiable'].includes(c?.status) ? c.status : 'unverifiable', evidence: String(c?.evidence ?? '').slice(0, 800) }));
  let verdict: GauntletRound['verdict'] = ['pass', 'gaps', 'cannot_evaluate'].includes(j.verdict) ? j.verdict : 'cannot_evaluate';
  // Coherencia: «pass» con un criterio incumplido o un bloqueante con evidencia no es pass.
  if (verdict === 'pass' && (criteria.some((c: any) => c.status === 'unmet') || findings.some(f => f.severity === 'blocking' && !f.unsupported))) verdict = 'gaps';
  const limitations = [...(Array.isArray(j.limitations) ? j.limitations.map(String) : []), ...findings.filter(f => f.unsupported && f.severity !== 'minor').map(f => `Hallazgo sin evidencia (no se corrige): ${f.text}`)].slice(0, 12);
  return { verdict, criteria, findings, largestGap: typeof j.largestGap === 'string' && j.largestGap.trim() ? j.largestGap.trim().slice(0, 500) : null, anotherRoundWorthIt: !!j.anotherRoundWorthIt, limitations };
}

/** Hallazgo del Evaluador → hallazgo de una corrección dirigida (para startRound; lo corrige el constructor, no el Evaluador). */
export const toCorrection = (f: GauntletFinding): { severity: IssueSeverity; text: string; file: string | null; evidence: string | null; expected: string | null } =>
  ({ severity: f.severity === 'blocking' ? 'alta' : 'media', text: `[Gauntlet${f.criterion ? ` · ${clip(f.criterion, 80)}` : ''}] ${f.text}`, file: f.file, evidence: f.evidence, expected: f.expected });

// ---------------------------------------------------------------- Etapa

/**
 * Tras la aprobación de QA (o tras una corrección del Evaluador): una ronda del Evaluador sobre el commit actual y la
 * decisión determinista. Devuelve 'verified' (sin nada que corregir o con lo pendiente documentado), 'correct' (se
 * abre una corrección dirigida) o lanza una pausa 'gauntlet' si quedan brechas bloqueantes al detenerse.
 */
export async function gauntletStage(ctx: StoryRunCtx, cfg: PipelineConfig): Promise<{ outcome: 'verified' | 'correct'; toFix: GauntletFinding[]; state: GauntletState | null }> {
  const g = normalizeGauntlet(cfg.gauntlet);
  const procs = processesRepo(ctx.slug); const proc = procs.get(ctx.processId)!; const r = proc.result!;
  const save = (s: GauntletState) => updateResult(ctx.slug, ctx.processId, x => ({ ...x, gauntlet: s }));
  if (g.mode === 'off') {
    // El propietario siguió sin más evaluación tras una detención: queda registrado (las brechas siguen en el informe).
    if (r.gauntlet?.status === 'stopped') { const s = { ...r.gauntlet, status: 'waived' as const, pendingReeval: false, reason: `El propietario continuó sin más evaluación. Pendiente documentado: ${r.gauntlet.reason ?? ''}` }; save(s); emit(ctx, 'gauntlet', s.reason); return { outcome: 'verified', toFix: [], state: s }; }
    return { outcome: 'verified', toFix: [], state: r.gauntlet ?? null };
  }
  const commit = r.applied?.commit ?? null;
  const state: GauntletState = r.gauntlet ?? { mode: g.mode, maxRounds: g.maxRounds, rounds: [], status: 'pending', reason: null, pendingReeval: false, qaApprovedCommit: commit };
  // Ya evaluado este commit con una decisión final: no se repite la evaluación (ni se paga otra vez).
  const last = state.rounds.at(-1);
  if (last && last.commit === commit && state.status !== 'pending') {
    if (state.status === 'stopped') {
      // El propietario concedió más rondas: se decide otra vez con la MISMA evaluación (sin pagar otra) y, si cabe, se corrige.
      const d = decideGauntlet(g, state.rounds.map((x, i) => i === state.rounds.length - 1 ? { ...x, decision: 'stop' as const } : x), cfg.maxCorrections - pipelineOf(ctx.slug, ctx.processId).corrections, { ownerGranted: true });
      if (d.decision === 'correct') {
        const rounds = state.rounds.map((x, i) => i === state.rounds.length - 1 ? { ...x, decision: 'correct' as const, reason: `El propietario concedió otra corrección dirigida. ${d.reason}` } : x);
        save({ ...state, mode: g.mode, maxRounds: g.maxRounds, rounds, status: 'pending', reason: d.reason, pendingReeval: true });
        return { outcome: 'correct', toFix: d.toFix, state: { ...state, rounds, status: 'pending', pendingReeval: true } };
      }
      throw new PipelinePause('gauntlet', `El Evaluador Gauntlet ya evaluó este commit y quedan brechas bloqueantes: ${state.reason ?? ''}`);
    }
    return { outcome: 'verified', toFix: [], state };
  }
  const evStep = proc.steps.find(s => s.role === 'evaluator');
  const ev = evStep ? agentsRepo(ctx.slug).get(evStep.agentId) ?? null : null;
  if (!ev || ev.id === ctx.dev.id) {
    const s = { ...state, status: 'skipped' as const, reason: !ev ? 'No hay un Evaluador Gauntlet en el equipo autorizado: se aplicó la verificación y QA de siempre.' : 'El Evaluador es el mismo agente que implementó: no se autoevalúa.' };
    save(s); emit(ctx, 'gauntlet', `Gauntlet (${g.mode}) no aplicado: ${s.reason}`);
    return { outcome: 'verified', toFix: [], state: s };
  }
  const round = state.rounds.length + 1;
  emit(ctx, 'gauntlet', `${ev.config.name} evalúa de forma independiente (Gauntlet ${g.mode}, ronda ${round}): criterios de aceptación contra el resultado real y su evidencia.`, { phase: 'qa', aiCall: true });
  const pending = proc.steps.find(s => s.role === 'evaluator' && s.status === 'pending');
  const res = await stepCall(ctx, ev, 'evaluator', pending ? `Evaluación Gauntlet (ronda ${round})` : `Evaluación Gauntlet (ronda ${round}, tras corrección)`, `Gauntlet ${g.mode}: evaluación independiente del commit ${commit ?? '?'}`, gauntletSystem(ev, ctx), gauntletPrompt(ctx, proc, cfg, state.rounds), 6000, pending?.id, GAUNTLET_SCHEMA as any, `Evaluación Gauntlet ronda ${round}`);
  const parsed = parseGauntlet(res.text);
  const p = pipelineOf(ctx.slug, ctx.processId);
  const rr: GauntletRound = { round, commit, at: now(), evaluatorId: ev.id, evaluatorName: ev.config.name, stepId: res.stepId, ...parsed, decision: 'pass', reason: '', costUsd: res.costUsd, tokensIn: res.inputTokens };
  const d = decideGauntlet(g, [...state.rounds, rr], cfg.maxCorrections - p.corrections);
  rr.decision = d.decision; rr.reason = d.reason;
  const next: GauntletState = { ...state, mode: g.mode, maxRounds: g.maxRounds, rounds: [...state.rounds, rr], status: d.decision === 'correct' ? 'pending' : d.status, reason: d.reason, pendingReeval: d.decision === 'correct' };
  save(next);
  const met = rr.criteria.filter(c => c.status === 'met').length;
  emit(ctx, 'gauntlet', `Gauntlet ronda ${round}: ${met} de ${rr.criteria.length} criterio(s) cumplidos con evidencia · ${rr.findings.filter(f => !f.unsupported).length} hallazgo(s) con evidencia. ${d.reason}`, { costUsd: res.costUsd, detail: [rr.largestGap ? `Brecha principal: ${rr.largestGap}` : null, ...rr.limitations.map(l => `Limitación: ${l}`)].filter(Boolean).join(' · ') || null });
  if (d.decision === 'correct') return { outcome: 'correct', toFix: d.toFix, state: next };
  if (d.status === 'stopped') throw new PipelinePause('gauntlet', `El Evaluador Gauntlet se detuvo con brechas bloqueantes: ${d.reason} Pendiente: ${d.toFix.map(f => `${f.text}${f.file ? ` (${f.file})` : ''}`).join(' · ')}. Lo hecho se conserva; decides tú.`);
  return { outcome: 'verified', toFix: [], state: next };
}
