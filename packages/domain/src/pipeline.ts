import type { PipelineConfig } from './types.ts';

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
  providerTimeoutSec: null
};

/** Límites duros: ni la interfaz ni la API pueden autorizar más que esto en un solo proceso. */
export const PIPELINE_LIMITS = { maxOutputRepairs: 3, maxCorrections: 5, maxIdenticalFailures: 3, maxDurationMin: 180, maxConsultations: 3, maxProviderRetries: 3, providerTimeoutSec: 900 } as const;

/** Normaliza una configuración recibida (valores fuera de rango se acotan; comandos desconocidos se descartan). */
export function normalizePipeline(input: Partial<PipelineConfig> | null | undefined): PipelineConfig {
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
    providerTimeoutSec: c.providerTimeoutSec == null ? null : int(c.providerTimeoutSec, 5, PIPELINE_LIMITS.providerTimeoutSec, 0) || null
  };
}
