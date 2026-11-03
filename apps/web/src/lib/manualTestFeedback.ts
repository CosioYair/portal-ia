import type { ManualTestFeedbackView, ManualTestStepFeedback, ManualTestStepResult } from '@portal-ia/domain';
import { noteOwnerResponse, ownerHeaders } from './owner.ts';

export interface StepFeedbackPayload { result: ManualTestStepResult | null; comment: string; }

const base = (slug: string, processId: string) =>
  `/api/workspaces/${encodeURIComponent(slug)}/processes/${encodeURIComponent(processId)}/manual-test-feedback`;

async function readError(r: Response): Promise<string> {
  try { const j = await r.json() as { error?: string }; if (j.error) return j.error; } catch { /* sin cuerpo */ }
  return `Error ${r.status}`;
}

export async function getManualTestFeedback(slug: string, processId: string): Promise<ManualTestFeedbackView> {
  const r = await fetch(base(slug, processId));
  if (!r.ok) throw new Error(await readError(r));
  return r.json() as Promise<ManualTestFeedbackView>;
}

export async function saveManualTestStepFeedback(slug: string, processId: string, stepKey: string, payload: StepFeedbackPayload): Promise<{ item: ManualTestStepFeedback | null }> {
  const r = await fetch(`${base(slug, processId)}/${encodeURIComponent(stepKey)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json', ...ownerHeaders() }, body: JSON.stringify(payload)
  });
  if (!r.ok) { const body = await r.clone().json().catch(() => null); noteOwnerResponse(r.status, body); throw new Error(await readError(r)); }
  return r.json() as Promise<{ item: ManualTestStepFeedback | null }>;
}
