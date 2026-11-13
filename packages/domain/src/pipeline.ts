import type { PipelineConfig, PipelinePauseKind } from './types.ts';
import { normalizeGauntlet, type GauntletConfig } from './gauntlet.ts';

declare module './types.ts' {
  interface PipelineStatus {
    /**
     * EN-027 · Reanudaciones seguidas que volvieron a la MISMA pausa (mismo tipo y mismo motivo normalizado) sin gastar
     * nada entre ambas. Opcional: los resultados guardados antes no lo tienen (equivale a 0).
     */
    repeatCount?: number;
  }
}

/** EN-027 · Motivo de pausa comparable: sin la parte «última ejecución …», sin horas ni espacios repetidos. */
export function normalizePauseReason(reason: string | null | undefined): string {
  return String(reason ?? '')
    .replace(/\s*[(·,;-]?\s*última ejecución[^)·\n]*\)?/gi, '')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** EN-027 · ¿Es la misma pausa? Mismo tipo y mismo motivo normalizado (no vacío). */
export function samePause(a: { pauseKind: PipelinePauseKind | null; reason: string | null } | null | undefined, b: { pauseKind: PipelinePauseKind | null; reason: string | null } | null | undefined): boolean {
  if (!a || !b || !a.pauseKind || a.pauseKind !== b.pauseKind) return false;
  const x = normalizePauseReason(a.reason); return !!x && x === normalizePauseReason(b.reason);
}

/** EN-027 · Nuevo valor de repeatCount: +1 si se repite la misma pausa sin gasto entre ambas; si no, 0. */
export function nextRepeatCount(prev: { pauseKind: PipelinePauseKind | null; reason: string | null; repeatCount?: number } | null | undefined, next: { pauseKind: PipelinePauseKind | null; reason: string | null }, spentBetween: boolean): number {
  return !spentBetween && samePause(prev, next) ? Math.max(0, Math.floor(Number(prev?.repeatCount) || 0)) + 1 : 0;
}

/**
 * Pipeline autorizado por defecto al ejecutar una historia desde la interfaz: aplicar en el worktree aislado, verificar
 * en sandbox (typecheck, test, build) y que QA evalúe la evidencia, con correcciones acotadas. Instalar dependencias con
 * red temporal NO está incluido salvo que el propietario lo marque. Integrar, reiniciar el Portal o publicar nunca
 * forman parte del pipeline: siguen siendo decisiones del propietario.
 */
export const DEFAULT_PIPELINE: PipelineConfig = {
  autoApply: true,
  autoVerify: true,
  commands: ['typecheck', 'test', 'build'],
  allowInstall: false,
  maxOutputRepairs: 1,
  maxCorrections: 2,
  maxIdenticalFailures: 2,
  maxDurationMin: 45,
  maxConsultations: 1,
  maxProviderRetries: 2,
  providerTimeoutSec: null,
  maxContinuations: 6
};

/** Límites duros: ni la interfaz ni la API pueden autorizar más que esto en un solo proceso. */
export const PIPELINE_LIMITS = { maxSubscriptionCalls: 2000, maxOutputRepairs: 3, maxCorrections: 5, maxIdenticalFailures: 3, maxDurationMin: 180, maxConsultations: 3, maxProviderRetries: 3, providerTimeoutSec: 900, maxContinuations: 12 } as const;

/** Normaliza una configuración recibida (valores fuera de rango se acotan; comandos desconocidos se descartan). */
export function normalizePipeline(input: (Partial<Omit<PipelineConfig, 'gauntlet'>> & { gauntlet?: Partial<GauntletConfig> | null }) | null | undefined): PipelineConfig {
  const c = { ...DEFAULT_PIPELINE, ...(input ?? {}) };
  const int = (v: unknown, min: number, max: number, def: number) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
  const order = ['typecheck', 'test', 'build'] as const;
  const commands = order.filter(k => Array.isArray(c.commands) && c.commands.includes(k));
  return {
    autoApply: !!c.autoApply,
    // Aplicar solo sin verificar no existe: QA no puede validar sin evidencia del sandbox.
    autoVerify: !!c.autoApply,
    commands: commands.length ? commands : ['typecheck'],
    allowInstall: !!c.allowInstall,
    maxOutputRepairs: int(c.maxOutputRepairs, 0, PIPELINE_LIMITS.maxOutputRepairs, DEFAULT_PIPELINE.maxOutputRepairs),
    maxCorrections: int(c.maxCorrections, 0, PIPELINE_LIMITS.maxCorrections, DEFAULT_PIPELINE.maxCorrections),
    maxIdenticalFailures: int(c.maxIdenticalFailures, 1, PIPELINE_LIMITS.maxIdenticalFailures, DEFAULT_PIPELINE.maxIdenticalFailures),
    maxDurationMin: int(c.maxDurationMin, 5, PIPELINE_LIMITS.maxDurationMin, DEFAULT_PIPELINE.maxDurationMin),
    maxConsultations: int(c.maxConsultations, 0, PIPELINE_LIMITS.maxConsultations, DEFAULT_PIPELINE.maxConsultations),
    maxProviderRetries: int(c.maxProviderRetries, 0, PIPELINE_LIMITS.maxProviderRetries, DEFAULT_PIPELINE.maxProviderRetries),
    providerTimeoutSec: c.providerTimeoutSec == null ? null : int(c.providerTimeoutSec, 5, PIPELINE_LIMITS.providerTimeoutSec, 0) || null,
    maxContinuations: int(c.maxContinuations, 0, PIPELINE_LIMITS.maxContinuations, DEFAULT_PIPELINE.maxContinuations!),
    gauntlet: normalizeGauntlet(c.gauntlet),
    ...(c.apiFallback === false ? { apiFallback: false } : {}),
    ...(c.maxSubscriptionCalls != null && Number(c.maxSubscriptionCalls) > 0 ? { maxSubscriptionCalls: int(c.maxSubscriptionCalls, 1, PIPELINE_LIMITS.maxSubscriptionCalls, 60) } : {}),
    ...(Array.isArray(c.backends) && c.backends.length ? { backends: c.backends.filter(b => b === 'api' || b === 'claude_code') } : {})
  };
}
