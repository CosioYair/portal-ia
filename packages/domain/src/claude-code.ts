// Conector «Claude Code — Local»: tipos compartidos entre backend y frontend.

/**
 * Backend de ejecución de un agente (su identidad, papel y permisos no cambian):
 * - `api`: el proveedor de API del agente (Anthropic u OpenAI), con presupuesto en USD.
 * - `claude-code`: el Portal lanza la CLI oficial de Claude Code (`claude -p`) con la sesión del propietario.
 * - `claude-code-terminal`: la tarea espera a que el propietario la atienda desde su propia consola de Claude Code
 *   conectada al Portal por el puente MCP.
 */
export type ExecutionBackend = 'api' | 'claude-code' | 'claude-code-terminal';

/** Origen de facturación que detecta el Portal (nunca se supone). */
export type ClaudeCodeBilling = 'subscription' | 'api' | 'cloud' | 'none' | 'unverified';

/** Resultado de detectar la CLI y su autenticación (`claude --version` y `claude auth status`, sin llamar al modelo). */
export interface ClaudeCodeDetection {
  checkedAt: string;
  installed: boolean;
  /** Ruta del ejecutable usado (no es secreta). */
  path: string | null;
  version: string | null;
  loggedIn: boolean | null;
  /** `authMethod` de `claude auth status`: none · claude.ai · oauth_token · api_key · api_key_helper · third_party. */
  authMethod: string | null;
  /** Plan informado por la CLI (pro, max, team, enterprise…), si lo informa. */
  subscriptionType: string | null;
  apiProvider: string | null;
  billing: ClaudeCodeBilling;
  /** Variables de credenciales presentes en el entorno del Portal: NO se reenvían a Claude Code (solo nombres). */
  portalEnvCredentials: string[];
  /** Conflictos y motivos de bloqueo, en lenguaje llano. */
  problems: string[];
  /** Funciones de la CLI comprobadas por su versión. */
  capabilities: string[];
}

export interface ClaudeCodeSettings {
  /** Desactivado hasta que el propietario lo conecte y autorice. */
  enabled: boolean;
  /** Ruta explícita de la CLI; null = detección automática. */
  cliPath: string | null;
  maxConcurrent: number;
  /** Duración máxima de cada ejecución (s). */
  maxDurationSec: number;
  /** Turnos máximos del agente dentro de una ejecución (`--max-turns`). */
  maxTurns: number;
  /** Lectura del repositorio del proceso a través del puente MCP del Portal (solo lectura, rutas protegidas excluidas). */
  repoRead: boolean;
  /**
   * Qué hacer si la suscripción no está disponible (límite alcanzado, sin sesión, conflicto de facturación):
   * `none` = pausar y esperar al propietario (por defecto) · `api` = usar el proveedor de API del agente, con su
   * presupuesto, solo porque el propietario lo autorizó aquí.
   */
  fallback: 'none' | 'api';
  /** Proyectos autorizados por espacio (slug → ids). */
  projects: Record<string, string[]>;
  authorizedAt: string | null;
  updatedAt: string | null;
}

export interface ClaudeCodeWorkerView {
  id: string;
  workspaceSlug: string;
  name: string;
  agentIds: string[];
  createdAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
  connected: boolean;
  /** Variables de credenciales que el puente vio en el entorno de la consola (solo nombres). */
  clientEnvCredentials: string[];
  clientVersion: string | null;
}

export type ClaudeCodeRunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted' | 'limit';

export interface ClaudeCodeRun {
  id: string;
  mode: 'cli' | 'terminal';
  projectId: string;
  processId: string | null;
  stepId: string | null;
  agentId: string;
  agentName: string;
  model: string;
  status: ClaudeCodeRunStatus;
  /** Origen de facturación comprobado al empezar (terminal: no verificable por el Portal). */
  billing: ClaudeCodeBilling;
  authMethod: string | null;
  subscriptionType: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  numTurns: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  /** Estimación de Claude Code de lo que costaría por API. NO es un cargo. */
  apiEquivalentUsd: number | null;
  error: string | null;
  /** Último aviso de límites que informó Claude Code (estado, reinicio), tal cual. */
  rateLimit: { status: string; resetsAt: number | null; utilization: number | null; errorCode: string | null } | null;
  progress: string | null;
}

export interface ClaudeCodeUsage {
  runs: number;
  failed: number;
  limited: number;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  /** Suma de estimaciones de Claude Code (equivalente a API). NO es dinero cobrado. */
  apiEquivalentUsd: number;
  lastRunAt: string | null;
}

export interface ClaudeCodeStatusView {
  settings: ClaudeCodeSettings;
  detection: ClaudeCodeDetection | null;
  /** Etiqueta del origen de ejecución para la interfaz. */
  sourceLabel: string;
  /** ¿Puede ejecutar ahora mismo de forma automática? (habilitado + suscripción verificada). */
  ready: boolean;
  readyReason: string;
  running: number;
}

export interface ClaudeCodeWorkspaceView {
  status: ClaudeCodeStatusView;
  projects: string[];
  agents: { id: string; name: string; projectId: string | null; provider: string; backend: ExecutionBackend }[];
  workers: ClaudeCodeWorkerView[];
  runs: ClaudeCodeRun[];
  usageToday: ClaudeCodeUsage;
  /** Instrucciones del puente para la consola (sin el token). */
  bridge: { command: string; args: string[]; portalUrl: string };
}

export const DEFAULT_CLAUDE_CODE_SETTINGS: ClaudeCodeSettings = {
  enabled: false, cliPath: null, maxConcurrent: 1, maxDurationSec: 900, maxTurns: 8, repoRead: true, fallback: 'none',
  projects: {}, authorizedAt: null, updatedAt: null
};

/** Etiqueta visible del origen de ejecución. */
export function backendLabel(backend: ExecutionBackend | null | undefined, billing?: ClaudeCodeBilling | null, provider?: string | null): string {
  if (!backend || backend === 'api') return provider === 'openai' ? 'OpenAI API' : 'Anthropic API';
  if (backend === 'claude-code-terminal') return 'Claude Code — Consola (no verificado)';
  if (billing === 'subscription') return 'Claude Code — Suscripción';
  if (billing === 'api') return 'Claude Code — Facturación API';
  if (billing === 'cloud') return 'Claude Code — Proveedor en la nube';
  if (billing === 'none') return 'Claude Code — Sin sesión';
  return 'Claude Code — No verificado';
}
