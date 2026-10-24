// Envoltorio del flujo de publicación existente: publica la rama y, en éxito o en fallo,
// deja que el Vigía de publicación verifique y registre el resultado sin alterarlo.

import { publishBranch } from './git-publish.ts';
import { resolveCommit } from './portal-sync.ts';
import type { PortalSyncService } from './portal-sync.ts';
import { verifyPublication } from './publication-watch.ts';
import type { ActivityRecorder } from './publication-watch.ts';

type PublishInput = Parameters<typeof publishBranch>[0];
type PublishResult = Awaited<ReturnType<typeof publishBranch>>;

export interface WatchedPublishInput extends PublishInput {
  readonly storyId: string;
  readonly recorder: ActivityRecorder;
  /** Si se indica, se descarta su caché tras publicar para que el indicador se actualice al momento. */
  readonly sync?: PortalSyncService;
}

export async function publishBranchWatched(input: WatchedPublishInput): Promise<PublishResult> {
  const { storyId, recorder, sync, ...publishInput } = input;
  const result = await publishBranch(publishInput);
  try {
    const commit = (await resolveCommit(input.repoPath, input.branch)) ?? input.branch;
    await verifyPublication({
      repoPath: input.repoPath,
      companyId: input.companyId,
      storyId,
      commitSha: commit,
      branch: input.branch,
      operationFailed: !result.ok,
      recorder
    });
  } finally {
    sync?.invalidate();
  }
  return result;
}
