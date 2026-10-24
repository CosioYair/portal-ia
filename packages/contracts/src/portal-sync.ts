// Contratos de la sincronización del Portal: estado de git, aviso de reinicio y verificación de publicación.

import { z } from 'zod';
import { CHANGE_ACTIONS, CHANGE_AREAS, PUBLICATION_VERDICTS } from '@portal/domain';
import { IsoDateTimeSchema } from './common.ts';

const CountSchema = z.number().int().nonnegative();

/** Estado de sincronización del repositorio del Portal (solo referencias locales, sin red). */
export const PortalSyncStatusSchema = z
  .object({
    /** Rama activa; null si HEAD está suelto (detached). */
    activeBranch: z.string().min(1).nullable(),
    detached: z.boolean(),
    headSha: z.string().min(7).max(64),
    /** Null si no existe la rama main local. */
    mainSha: z.string().min(7).max(64).nullable(),
    branchMatchesMain: z.boolean(),
    aheadOfMain: CountSchema,
    behindMain: CountSchema,
    remote: z
      .object({
        /** Existe refs/remotes/origin/main. */
        tracked: z.boolean(),
        remoteMainSha: z.string().min(7).max(64).nullable(),
        /** main local está completamente contenida en origin/main. */
        published: z.boolean(),
        /** Commits de main local que origin/main no tiene. */
        ahead: CountSchema,
        /** Commits de origin/main que main local no tiene. */
        behind: CountSchema
      })
      .strict(),
    checkedAt: IsoDateTimeSchema
  })
  .strict();

/** Aviso de reinicio o recarga tras cambios aplicados al propio Portal desde el arranque. */
export const RestartNoticeSchema = z
  .object({
    action: z.enum(CHANGE_ACTIONS),
    /** Historias (HU-NNN) citadas en los commits posteriores al arranque del servidor. */
    affectedStories: z.array(z.string().regex(/^HU-\d+$/)).max(500),
    changedAreas: z.array(z.enum(CHANGE_AREAS)).max(CHANGE_AREAS.length),
    /** HEAD que tenía el repositorio cuando arrancó el servidor. */
    bootHeadSha: z.string().min(7).max(64),
    currentHeadSha: z.string().min(7).max(64)
  })
  .strict();

/** Resultado de la verificación del Vigía de publicación para un commit. */
export const PublicationCheckActivitySchema = z
  .object({
    storyId: z.string().min(1).max(100),
    commitSha: z.string().min(1).max(64),
    integratedInMain: z.boolean(),
    publishedToRemote: z.boolean(),
    verdict: z.enum(PUBLICATION_VERDICTS),
    detail: z.string().min(1).max(1000)
  })
  .strict();

export type PortalSyncStatus = z.infer<typeof PortalSyncStatusSchema>;
export type RestartNotice = z.infer<typeof RestartNoticeSchema>;
export type PublicationCheckActivity = z.infer<typeof PublicationCheckActivitySchema>;
