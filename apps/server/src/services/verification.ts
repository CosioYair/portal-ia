import fs from 'node:fs';
import path from 'node:path';
import type { VerificationRun } from '@portal-ia/domain';
import { processesRepo, projectsRepo } from '../db/workspace.ts';
import { requirePolicy } from './executionPolicy.ts';
import { recordDetections } from './lessons.ts';
import { worktreePathFor } from './repoWrite.ts';
import { DEPS_MISSING_EXIT, detectSandbox, runInSandbox, type SandboxStatus } from './sandbox.ts';

export type VerifyCommand = 'install' | 'typecheck' | 'test' | 'build';

/**
 * Dependencias del sandbox. Solo las pruebas sustituyen esto (p. ej. para comprobar el orden del pipeline sin Docker);
 * en el Portal siempre son detectSandbox / runInSandbox.
 */
export const sandboxDeps: {
  detect: (force?: boolean) => Promise<SandboxStatus>;
  run: (worktree: string, repoRoot: string, command: string, opts: { allowNetwork?: boolean }) => Promise<VerificationRun>;
} = { detect: detectSandbox, run: runInSandbox };

/**
 * Ejecuta un comando permitido en el sandbox sobre el worktree del proceso y guarda la ejecución (historial completo).
 * La usan la ruta «Verificar» (autorización por uso) y el pipeline autorizado del proceso (autorización del proceso).
 * Lanza errores con statusCode/code.
 */
export async function runVerification(slug: string, id: string, command: VerifyCommand, allowNetwork: boolean): Promise<VerificationRun> {
  const fail = (statusCode: number, error: string, code?: string) => Object.assign(new Error(error), { statusCode, code });
  const procs = processesRepo(slug); const proc = procs.get(id);
  if (!proc || !proc.result) throw fail(404, 'Proceso no encontrado');
  if (!proc.result.applied) throw fail(409, 'Primero aplica los cambios: la verificación corre sobre el worktree del proceso.');
  const repo = projectsRepo(slug).repository(proc.projectId);
  if (!repo) throw fail(409, 'No hay repositorio registrado.');
  const wt = proc.result.applied.worktree ?? worktreePathFor(repo.path, id);
  if (!proc.result.applied.worktree) throw fail(409, `Esta iteración se aplicó antes de v0.12, directamente en tu carpeta (rama ${proc.result.applied.branch}), y no puede verificarse en sandbox. Ciérrala como resuelta si la historia ya funciona, o descártala y prepara una nueva iteración desde el Resumen.`, 'legacy_applied');
  if (!fs.existsSync(wt)) throw fail(409, 'El worktree del proceso ya no existe (¿se integró o se limpió?). Descarta esta iteración y prepara una nueva desde el Resumen.');
  const op = command === 'install' ? 'install_deps' : command === 'typecheck' && (await sandboxDeps.detect()).available === 'unavailable' ? 'host_typecheck_min' : 'sandbox_exec';
  const qa = proc.steps.find(s => /calidad|QA/i.test(s.title)) ?? proc.steps[1];
  // La verificación la autoriza el propietario (por uso o en la autorización del proceso): la política comprueba nivel y autorización.
  requirePolicy(op, { slug, processId: id, agentId: null, projectId: proc.projectId, authorized: true });
  // Instalar dependencias exige red: solo con autorización explícita.
  if (command === 'install' && !allowNetwork) throw fail(409, 'Instalar dependencias necesita red dentro del sandbox. Revisa el diff de package.json y confirma «Permitir red solo para install».', 'network_confirmation_required');
  const run = await sandboxDeps.run(wt, path.resolve(repo.path), command, { allowNetwork });
  const cur = procs.get(id)!;
  procs.setResult(id, { ...cur.result!, verifications: [...cur.result!.verifications, run] });
  procs.logExecution({ projectId: proc.projectId, agentId: qa?.agentId ?? '', kind: `verify:${command}:${run.isolation}`, status: run.exitCode === 0 ? 'done' : 'failed', tokensIn: 0, tokensOut: 0, cost: 0, startedAt: run.startedAt });
  // Faltar dependencias (86) es un problema del entorno, no del código: no genera lección.
  if (run.exitCode !== 0 && run.isolation !== 'unavailable' && run.exitCode !== DEPS_MISSING_EXIT) recordDetections(slug, id, repo.path);
  return run;
}
