import type { Agent } from '@portal-ia/domain';
import { agentsRepo, processesRepo } from '../db/workspace.ts';

/**
 * Política de ejecución (única puerta hacia procesos externos y git de escritura).
 *
 * Toda operación con efectos fuera de la base de datos pasa por `requirePolicy()`:
 *  - comprueba el nivel de la operación (local / auth / external) y que la autorización exigida esté presente;
 *  - si la operación la realiza un agente, comprueba que su `config.tools` incluya la herramienta necesaria y que el
 *    agente pertenezca al proyecto del proceso (ámbito);
 *  - registra cada ticket concedido o denegado en `execution_history` (kind `policy:*`) para auditoría.
 * Lo que no está en la tabla no existe: no hay forma de ejecutar otra cosa desde el Portal.
 */
export type PolicyOp =
  | 'read_repo' | 'write_worktree' | 'sandbox_exec' | 'install_deps' | 'host_typecheck_min'
  | 'git_merge' | 'git_push' | 'restart_portal' | 'delete_worktree' | 'runtime_check' | 'ai_call' | 'phase_transition';

export type PolicyLevel = 'local' | 'auth' | 'external';

const OPS: Record<PolicyOp, { level: PolicyLevel; tool: string | null; label: string }> = {
  read_repo: { level: 'local', tool: 'read_repo', label: 'Lectura del repositorio' },
  write_worktree: { level: 'auth', tool: 'write_repo', label: 'Escritura en el worktree del proceso' },
  sandbox_exec: { level: 'auth', tool: 'sandbox_exec', label: 'Ejecución en sandbox' },
  install_deps: { level: 'auth', tool: 'install_deps', label: 'Instalación de dependencias en sandbox' },
  host_typecheck_min: { level: 'auth', tool: null, label: 'Verificación mínima en el equipo (tsc --noEmit)' },
  git_merge: { level: 'auth', tool: null, label: 'Integración en la rama principal' },
  git_push: { level: 'external', tool: null, label: 'Publicación en el remoto' },
  restart_portal: { level: 'auth', tool: null, label: 'Reconstrucción y reinicio del Portal' },
  delete_worktree: { level: 'auth', tool: null, label: 'Limpieza de worktree' },
  runtime_check: { level: 'auth', tool: null, label: 'Verificación en ejecución contra el Portal en marcha' },
  ai_call: { level: 'auth', tool: null, label: 'Llamada a un modelo de IA' },
  phase_transition: { level: 'auth', tool: null, label: 'Inicio de etapa: archivo reversible del trabajo activo' }
};

export interface PolicyContext {
  slug: string;
  processId?: string | null;
  agentId?: string | null;
  /** Autorización explícita del propietario para esta operación (por uso) o para el proceso (presupuesto). */
  authorized?: boolean;
  /** Para ai_call: el proceso debe estar autorizado y con presupuesto; para operaciones de agente, ámbito de proyecto. */
  projectId?: string | null;
  /** Para ai_call: por dónde va la llamada. Con la suscripción de Claude Code no hay USD que agotar (la limita su tope de llamadas). */
  route?: 'api' | 'claude-code';
}

export class PolicyError extends Error { statusCode = 403; code: string; constructor(code: string, message: string) { super(message); this.code = code; } }

export interface PolicyTicket { op: PolicyOp; level: PolicyLevel; agent: Agent | null; grantedAt: string }

/** Comprueba y registra. Lanza PolicyError (403) si no procede. */
export function requirePolicy(op: PolicyOp, ctx: PolicyContext): PolicyTicket {
  const def = OPS[op];
  const procs = processesRepo(ctx.slug);
  const log = (status: 'granted' | 'denied', reason?: string) => {
    try { procs.logExecution({ projectId: ctx.projectId ?? '', agentId: ctx.agentId ?? '', kind: `policy:${op}:${status}${reason ? `:${reason}` : ''}`, status: status === 'granted' ? 'done' : 'failed', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: new Date().toISOString() }); } catch { /* auditoría no debe romper la operación */ }
  };
  if (def.level !== 'local' && !ctx.authorized) { log('denied', 'sin_autorizacion'); throw new PolicyError('authorization_required', `«${def.label}» requiere autorización explícita del propietario.`); }
  let agent: Agent | null = null;
  if (ctx.agentId) {
    agent = agentsRepo(ctx.slug).get(ctx.agentId) ?? null;
    if (!agent) { log('denied', 'agente_desconocido'); throw new PolicyError('unknown_agent', 'El agente indicado no existe en este espacio.'); }
    if (def.tool && !agent.config.tools?.[def.tool]) { log('denied', `sin_herramienta_${def.tool}`); throw new PolicyError('tool_not_granted', `El agente «${agent.config.name}» no tiene la herramienta «${def.tool}» necesaria para «${def.label}».`); }
    if (ctx.projectId && agent.scope === 'project' && agent.projectId !== ctx.projectId) { log('denied', 'fuera_de_ambito'); throw new PolicyError('out_of_scope', `El agente «${agent.config.name}» pertenece a otro proyecto: no puede operar aquí.`); }
  }
  if (op === 'ai_call' && ctx.processId) {
    const p = procs.get(ctx.processId);
    if (!p || p.status !== 'running') { log('denied', 'proceso_no_autorizado'); throw new PolicyError('process_not_running', 'Solo un proceso autorizado y en ejecución puede llamar a un modelo.'); }
    if (ctx.route !== 'claude-code' && p.spentUsd >= p.budgetUsd) { log('denied', 'presupuesto_agotado'); throw new PolicyError('budget_exhausted', `Presupuesto agotado (${p.spentUsd.toFixed(2)} de ${p.budgetUsd.toFixed(2)} USD).`); }
  }
  log('granted');
  return { op, level: def.level, agent, grantedAt: new Date().toISOString() };
}

export function policyTable() { return Object.entries(OPS).map(([op, d]) => ({ op, ...d })); }
