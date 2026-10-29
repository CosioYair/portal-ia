import { DEFAULT_CLAUDE_CODE_SETTINGS, type ClaudeCodeDetection, type ClaudeCodeSettings } from '@portal-ia/domain';
import { settingsRepo } from '../../db/platform.ts';

/**
 * Ajustes del conector «Claude Code — Local» (uno por instalación, en la base de plataforma). Desactivado por defecto:
 * solo el propietario lo activa, con autorización explícita y una suscripción verificada.
 */
const KEY = 'claude_code';
const DETECTION_KEY = 'claude_code.detection';

export function getClaudeCodeSettings(): ClaudeCodeSettings {
  try { return { ...DEFAULT_CLAUDE_CODE_SETTINGS, ...JSON.parse(settingsRepo.get(KEY) ?? '{}') }; }
  catch { return { ...DEFAULT_CLAUDE_CODE_SETTINGS }; }
}

export function saveClaudeCodeSettings(s: ClaudeCodeSettings): ClaudeCodeSettings {
  const next = { ...s, updatedAt: new Date().toISOString() };
  settingsRepo.set(KEY, JSON.stringify(next));
  return next;
}

/** Última detección guardada (para mostrarla tras reiniciar; la ejecución siempre vuelve a comprobar). */
export function savedDetection(): ClaudeCodeDetection | null {
  try { const raw = settingsRepo.get(DETECTION_KEY); return raw ? JSON.parse(raw) as ClaudeCodeDetection : null; } catch { return null; }
}
export function saveDetection(d: ClaudeCodeDetection) { settingsRepo.set(DETECTION_KEY, JSON.stringify(d)); }

/** ¿El proyecto está autorizado para el conector en este espacio? */
export function projectAuthorized(s: ClaudeCodeSettings, slug: string, projectId: string): boolean {
  return (s.projects[slug] ?? []).includes(projectId);
}
