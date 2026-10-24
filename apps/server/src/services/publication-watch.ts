// Rol de vigilancia «Vigía de publicación»: determinista, solo lectura, sin modelos, sin red y sin coste.
// Verifica que un commit esté integrado en main y publicado en origin/main y registra el veredicto en la actividad.

import type { ActivityEntry, PublicationCheckActivity } from '@portal/contracts';
import { PublicationCheckActivitySchema } from '@portal/contracts';
import {
  PUBLICATION_WATCHER_ROLE,
  asCompanyId,
  evaluatePublication,
  redactCredentials
} from '@portal/domain';
import type { PublicationEvaluation } from '@portal/domain';
import { countLeftRight, gitSucceeds, resolveCommit } from './portal-sync.ts';

/** Entrada que el vigía entrega al registro de actividad (el registro añade id y fecha). */
export type PublicationActivityEntry = Omit<ActivityEntry, 'id' | 'createdAt'>;

/** Puerto de escritura en la actividad. Se implementa sobre el registro de actividad existente. */
export interface ActivityRecorder {
  record(entry: PublicationActivityEntry): Promise<void>;
}

export interface VerifyPublicationInput {
  readonly repoPath: string;
  readonly companyId: string;
  readonly storyId: string;
  /** Commit (SHA o referencia) cuya integración y publicación se verifican. */
  readonly commitSha: string;
  /** Rama que se aplicó o publicó (solo para el registro; por defecto «main»). */
  readonly branch?: string;
  /** Verdadero si la aplicación o publicación terminó con error: el vigía verifica igualmente. */
  readonly operationFailed?: boolean;
  readonly recorder: ActivityRecorder;
}

const MAIN_REF = 'refs/heads/main';
const REMOTE_MAIN_REF = 'refs/remotes/origin/main';

async function collectFacts(repoPath: string, commit: string) {
  const [mainSha, remoteSha] = await Promise.all([
    resolveCommit(repoPath, MAIN_REF),
    resolveCommit(repoPath, REMOTE_MAIN_REF)
  ]);
  const integratedInMain =
    mainSha !== null && (await gitSucceeds(repoPath, ['merge-base', '--is-ancestor', commit, MAIN_REF]));
  const publishedToRemote =
    remoteSha !== null &&
    (await gitSucceeds(repoPath, ['merge-base', '--is-ancestor', commit, REMOTE_MAIN_REF]));
  let mainDivergedFromRemote = false;
  if (mainSha !== null && remoteSha !== null) {
    const [ahead, behind] = await countLeftRight(repoPath, MAIN_REF, REMOTE_MAIN_REF);
    mainDivergedFromRemote = ahead > 0 && behind > 0;
  }
  return {
    integratedInMain,
    publishedToRemote,
    remoteTracked: remoteSha !== null,
    mainDivergedFromRemote
  };
}

async function evaluate(
  repoPath: string,
  commitRef: string
): Promise<{ commit: string; integratedInMain: boolean; publishedToRemote: boolean; result: PublicationEvaluation }> {
  const commit = await resolveCommit(repoPath, commitRef);
  if (commit === null) {
    return {
      commit: commitRef,
      integratedInMain: false,
      publishedToRemote: false,
      result: { verdict: 'pendiente', detail: 'No se encontró el commit en el repositorio local.' }
    };
  }
  const facts = await collectFacts(repoPath, commit);
  return {
    commit,
    integratedInMain: facts.integratedInMain,
    publishedToRemote: facts.publishedToRemote,
    result: evaluatePublication(facts)
  };
}

/**
 * Verifica la integración en main y la publicación en origin/main (última referencia conocida, sin red)
 * y registra el veredicto en la actividad. Nunca lanza: un fallo de git o del registro se traduce en un
 * veredicto «pendiente» y no bloquea ni revierte la publicación.
 */
export async function verifyPublication(input: VerifyPublicationInput): Promise<PublicationCheckActivity> {
  let outcome: Awaited<ReturnType<typeof evaluate>>;
  try {
    outcome = await evaluate(input.repoPath, input.commitSha);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'error desconocido';
    outcome = {
      commit: input.commitSha,
      integratedInMain: false,
      publishedToRemote: false,
      result: {
        verdict: 'pendiente',
        detail: `No se pudo comprobar el estado de git: ${redactCredentials(reason).slice(0, 300)}`
      }
    };
  }

  const check = PublicationCheckActivitySchema.parse({
    storyId: input.storyId.slice(0, 100),
    commitSha: outcome.commit.slice(0, 64),
    integratedInMain: outcome.integratedInMain,
    publishedToRemote: outcome.publishedToRemote,
    verdict: outcome.result.verdict,
    detail: outcome.result.detail
  });

  const prefix = input.operationFailed === true ? 'La aplicación o publicación falló. ' : '';
  const entry: PublicationActivityEntry = {
    companyId: asCompanyId(input.companyId),
    kind: 'publication.verified',
    branch: input.branch !== undefined && input.branch.length > 0 ? input.branch : 'main',
    remote: 'origin',
    status: check.verdict === 'ok' && input.operationFailed !== true ? 'ok' : 'error',
    message: redactCredentials(`${prefix}${check.storyId}: ${check.verdict}. ${check.detail}`).slice(0, 2000),
    actor: PUBLICATION_WATCHER_ROLE.name,
    storyId: check.storyId,
    commitSha: check.commitSha,
    verdict: check.verdict
  };

  try {
    await input.recorder.record(entry);
  } catch {
    // El registro nunca debe bloquear ni revertir la publicación.
  }
  return check;
}
