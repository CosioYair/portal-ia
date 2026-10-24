// Publica una rama local en el remoto «origin» usando la sesión de git ya configurada.
// No lee, recibe ni guarda tokens. Git se ejecuta siempre sin shell.
// OJO: esta historia no incluye autorización (motor de políticas, HU-008): no exponer en ruta ni UI aún.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isValidBranchName, redactCredentials } from '@portal/domain';
import type { ActivityEntry } from '@portal/contracts';
import type { ActivityLog } from './activity-log.ts';

export interface PublishBranchInput {
  readonly repoPath: string;
  readonly branch: string;
  readonly companyId: string;
  readonly log: ActivityLog;
  readonly timeoutMs?: number;
}

export interface PublishBranchResult {
  readonly ok: boolean;
  readonly branch: string;
  readonly message: string;
}

interface GitOutput {
  readonly ok: boolean;
  readonly stdout: string;
  readonly detail: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_MESSAGE = 2000;

function git(args: string[], cwd: string, timeout: number): Promise<GitOutput> {
  return new Promise((resolve) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    execFile('git', args, { cwd, env, timeout, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const detail = error?.killed ? 'tiempo de espera agotado' : stderr.trim() || error?.message || '';
      resolve({ ok: error === null, stdout, detail });
    });
  });
}

function aparece(stdout: string, branch: string): boolean {
  return stdout.split('\n').some((linea) => linea.trim().endsWith(`\trefs/heads/${branch}`));
}

async function intentar(input: PublishBranchInput): Promise<{ ok: boolean; message: string }> {
  const { repoPath, branch } = input;
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!isValidBranchName(branch)) {
    return { ok: false, message: 'Nombre de rama inválido: no se ejecutó git.' };
  }
  // La URL del remoto no se registra: solo se comprueba que exista.
  const remoto = await git(['remote', 'get-url', 'origin'], repoPath, timeout);
  if (!remoto.ok) {
    return { ok: false, message: 'El repositorio no tiene un remoto «origin» configurado.' };
  }
  const push = await git(['push', '--set-upstream', 'origin', branch], repoPath, timeout);
  if (!push.ok) {
    return { ok: false, message: `Falló git push: ${push.detail}` };
  }
  const check = await git(['ls-remote', '--heads', 'origin', branch], repoPath, timeout);
  if (!check.ok || !aparece(check.stdout, branch)) {
    return { ok: false, message: 'El push terminó, pero la rama no aparece en origin.' };
  }
  return { ok: true, message: `Rama ${branch} publicada en origin.` };
}

/** Publica la rama y deja siempre una entrada en el registro de actividad (éxito o error). */
export async function publishBranch(input: PublishBranchInput): Promise<PublishBranchResult> {
  const resultado = await intentar(input);
  const message = redactCredentials(resultado.message).slice(0, MAX_MESSAGE);
  const rama = redactCredentials(input.branch).slice(0, 255) || '(vacía)';
  const entry: ActivityEntry = {
    id: randomUUID(),
    companyId: input.companyId,
    kind: 'branch.published',
    branch: rama,
    remote: 'origin',
    status: resultado.ok ? 'ok' : 'error',
    message,
    createdAt: new Date().toISOString()
  };
  await input.log.append(entry);
  return { ok: resultado.ok, branch: rama, message };
}
