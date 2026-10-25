import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { manualTestStepKey } from '@portal-ia/domain';
import type { ManualTestFeedbackView, ManualTestStepFeedback, ManualTestStepRef, ManualTestStepResult, Process } from '@portal-ia/domain';
import { config } from '../config.ts';
import { workspacesRepo } from '../db/platform.ts';
import { processesRepo } from '../db/workspace.ts';

export class ProcessNotFoundError extends Error {
  constructor(message = 'Proceso no encontrado') { super(message); this.name = 'ProcessNotFoundError'; }
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const handles = new Map<string, DatabaseSync>();

/** Base SQLite del feedback de un espacio (un archivo por espacio; esquema idempotente). */
function openDb(slug: string): DatabaseSync {
  const cached = handles.get(slug);
  if (cached) return cached;
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(config.dataDir, `${slug}.manual-feedback.sqlite`));
  db.exec(`CREATE TABLE IF NOT EXISTS manual_test_feedback (
    process_id TEXT NOT NULL,
    step_key   TEXT NOT NULL,
    result     TEXT CHECK (result IS NULL OR result IN ('ok','fail','observation')),
    comment    TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (process_id, step_key)
  )`);
  handles.set(slug, db);
  return db;
}

/** Cierra las conexiones abiertas (pruebas: simula cerrar y reabrir la app). */
export function closeManualTestFeedbackDbs(): void {
  for (const db of handles.values()) { try { db.close(); } catch { /* ya cerrada */ } }
  handles.clear();
}

/** Pasos de la prueba manual del proceso, con su clave estable. */
export function manualTestStepsOf(process: Pick<Process, 'result'>): ManualTestStepRef[] {
  const steps = process.result?.manualTest?.steps ?? [];
  return steps.map((text, index) => ({ stepKey: manualTestStepKey(index, text), index, text }));
}

function requireProcess(slug: string, processId: string): Process {
  if (!SLUG_RE.test(slug) || !workspacesRepo.get(slug)) throw new ProcessNotFoundError('Empresa no encontrada');
  const proc = processesRepo(slug).get(processId);
  if (!proc) throw new ProcessNotFoundError();
  return proc;
}

type Row = { process_id: string; step_key: string; result: string | null; comment: string; updated_at: string };
const toItem = (r: Row): ManualTestStepFeedback => ({
  processId: r.process_id, stepKey: r.step_key, result: r.result as ManualTestStepResult | null, comment: r.comment, updatedAt: r.updated_at
});

export function listFeedback(slug: string, processId: string): ManualTestFeedbackView {
  const proc = requireProcess(slug, processId);
  const rows = openDb(slug).prepare('SELECT process_id, step_key, result, comment, updated_at FROM manual_test_feedback WHERE process_id = ? ORDER BY step_key').all(processId) as unknown as Row[];
  return { steps: manualTestStepsOf(proc), items: rows.map(toItem) };
}

/** Guarda (upsert) el feedback de un paso. Resultado null con comentario vacío borra la fila y devuelve null. */
export function upsertStepFeedback(slug: string, processId: string, stepKey: string, input: { result: ManualTestStepResult | null; comment: string }): ManualTestStepFeedback | null {
  requireProcess(slug, processId);
  const db = openDb(slug);
  if (input.result === null && input.comment.trim() === '') {
    db.prepare('DELETE FROM manual_test_feedback WHERE process_id = ? AND step_key = ?').run(processId, stepKey);
    return null;
  }
  const updatedAt = new Date().toISOString();
  db.prepare(`INSERT INTO manual_test_feedback (process_id, step_key, result, comment, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(process_id, step_key) DO UPDATE SET result = excluded.result, comment = excluded.comment, updated_at = excluded.updated_at`)
    .run(processId, stepKey, input.result, input.comment, updatedAt);
  return { processId, stepKey, result: input.result, comment: input.comment, updatedAt };
}
