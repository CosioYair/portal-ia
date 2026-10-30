import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Ningún git que lance el Portal ejecuta hooks del repositorio (commits en worktrees, integraciones en main, lecturas del
 * puente): un agente podría haber modificado un hook versionado (p. ej. de husky) y se ejecutaría en el equipo, fuera del
 * sandbox. Se aplica a todo el proceso con las variables estándar de git (GIT_CONFIG_*), apuntando a una carpeta vacía
 * propia de este proceso. La verificación del código ocurre en Docker, no en hooks. PORTAL_GIT_HOOKS=1 lo desactiva.
 */
export const NO_HOOKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ia-sin-hooks-'));
if (process.env.PORTAL_GIT_HOOKS !== '1' && !process.env.PORTAL_GIT_NO_HOOKS_SET) {
  const n = Number(process.env.GIT_CONFIG_COUNT ?? 0) || 0;
  process.env[`GIT_CONFIG_KEY_${n}`] = 'core.hooksPath';
  process.env[`GIT_CONFIG_VALUE_${n}`] = NO_HOOKS_DIR;
  process.env.GIT_CONFIG_COUNT = String(n + 1);
  process.env.PORTAL_GIT_NO_HOOKS_SET = '1';
}
