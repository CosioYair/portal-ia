import crypto from 'node:crypto';
import { seriesStat, type CallMetric, type CallMetricsSummary } from '@portal-ia/domain';
import { workspaceDb } from './workspace.ts';

/**
 * Telemetría de llamadas (v0.14): una fila por llamada al modelo de un paso de proceso. Tabla aditiva; se crea al usarla.
 * Solo medidas (sin prompts ni respuestas).
 */
const ready = new Set<string>();
function db(slug: string) {
  const d = workspaceDb(slug);
  if (!ready.has(slug)) {
    d.exec(`CREATE TABLE IF NOT EXISTS call_metrics (
      id TEXT PRIMARY KEY, process_id TEXT, step_id TEXT, agent_id TEXT, role TEXT, operation TEXT, backend TEXT, model TEXT,
      attempt INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
      wait_ms INTEGER NOT NULL DEFAULT 0, build_ms INTEGER NOT NULL DEFAULT 0, system_chars INTEGER NOT NULL DEFAULT 0, prompt_chars INTEGER NOT NULL DEFAULT 0,
      context_json TEXT, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER, turns INTEGER,
      tools_json TEXT, prompt_hash TEXT NOT NULL, error_class TEXT
    );
    CREATE INDEX IF NOT EXISTS call_metrics_process ON call_metrics(process_id);
    CREATE INDEX IF NOT EXISTS call_metrics_started ON call_metrics(started_at);`);
    ready.add(slug);
  }
  return d;
}

export const promptHash = (system: string, user: string) => crypto.createHash('sha1').update(system).update('\u0000').update(user).digest('hex').slice(0, 16);

const map = (r: any): CallMetric => ({
  id: r.id, processId: r.process_id, stepId: r.step_id, agentId: r.agent_id, role: r.role, operation: r.operation, backend: r.backend, model: r.model,
  attempt: r.attempt, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at, waitMs: r.wait_ms, buildMs: r.build_ms,
  systemChars: r.system_chars, promptChars: r.prompt_chars, context: r.context_json ? JSON.parse(r.context_json) : [], tokensIn: r.tokens_in, tokensOut: r.tokens_out,
  cacheReadTokens: r.cache_read_tokens, turns: r.turns, tools: r.tools_json ? JSON.parse(r.tools_json) : null, promptHash: r.prompt_hash, errorClass: r.error_class
});

export function callMetricsRepo(slug: string) {
  const d = db(slug);
  return {
    record(m: Omit<CallMetric, 'id'>): void {
      try {
        d.prepare(`INSERT INTO call_metrics (id, process_id, step_id, agent_id, role, operation, backend, model, attempt, status, started_at, finished_at, wait_ms, build_ms, system_chars, prompt_chars, context_json, tokens_in, tokens_out, cache_read_tokens, turns, tools_json, prompt_hash, error_class)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(crypto.randomUUID(), m.processId, m.stepId, m.agentId, m.role, m.operation, m.backend, m.model, m.attempt, m.status, m.startedAt, m.finishedAt,
            Math.max(0, Math.round(m.waitMs)), Math.max(0, Math.round(m.buildMs)), m.systemChars, m.promptChars, m.context.length ? JSON.stringify(m.context) : null,
            m.tokensIn, m.tokensOut, m.cacheReadTokens, m.turns, m.tools ? JSON.stringify(m.tools) : null, m.promptHash, m.errorClass);
      } catch { /* la telemetría nunca rompe una llamada */ }
    },
    list(f: { since?: string | null; processId?: string | null; processIds?: string[] | null } = {}): CallMetric[] {
      const where: string[] = []; const args: any[] = [];
      if (f.since) { where.push('started_at >= ?'); args.push(f.since); }
      if (f.processId) { where.push('process_id = ?'); args.push(f.processId); }
      if (f.processIds?.length) { where.push(`process_id IN (${f.processIds.map(() => '?').join(',')})`); args.push(...f.processIds); }
      return (d.prepare(`SELECT * FROM call_metrics ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at`).all(...args) as any[]).map(map);
    }
  };
}

/** Resumen medible: p50/p95 por papel y origen, modelo frente a Portal, llamadas repetidas, fallos y lecturas del repositorio. */
export function summarizeCalls(rows: CallMetric[], since: string | null = null): CallMetricsSummary {
  const group = <T,>(key: (m: CallMetric) => string) => rows.reduce((acc, m) => { (acc[key(m)] ??= []).push(m); return acc; }, {} as Record<string, CallMetric[]>);
  const reads = (m: CallMetric) => Object.entries(m.tools ?? {}).filter(([t]) => /read_file|list_files|knowledge/.test(t)).reduce((a, [, n]) => a + n, 0);
  const byRole = Object.fromEntries(Object.entries(group(m => m.role ?? 'otro')).map(([k, v]) => {
    const tin = v.reduce((a, m) => a + m.tokensIn, 0); const cached = v.reduce((a, m) => a + (m.cacheReadTokens ?? 0), 0); const known = v.some(m => m.cacheReadTokens !== null);
    return [k, { calls: v.length, failed: v.filter(m => m.status === 'failed').length, waitMs: seriesStat(v.map(m => m.waitMs)), buildMs: seriesStat(v.map(m => m.buildMs)), tokensIn: seriesStat(v.map(m => m.tokensIn)), tokensOut: seriesStat(v.map(m => m.tokensOut)), cacheShare: known && tin ? +(cached / tin).toFixed(3) : null, turns: seriesStat(v.map(m => m.turns)), toolCalls: v.reduce((a, m) => a + Object.values(m.tools ?? {}).reduce((x, y) => x + y, 0), 0), promptChars: seriesStat(v.map(m => m.systemChars + m.promptChars)) }];
  }));
  const byBackend = Object.fromEntries(Object.entries(group(m => m.backend ?? 'api')).map(([k, v]) => [k, { calls: v.length, waitMs: seriesStat(v.map(m => m.waitMs)), tokensIn: seriesStat(v.map(m => m.tokensIn)) }]));
  const dup = group(m => `${m.processId ?? '-'}|${m.promptHash}`);
  const duplicates = Object.values(dup).filter(v => v.length > 1).map(v => ({ processId: v[0].processId, promptHash: v[0].promptHash, count: v.length, role: v[0].role, operation: v[0].operation }));
  const failures = rows.filter(m => m.status === 'failed').reduce((acc, m) => { const k = m.errorClass ?? 'desconocido'; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {} as Record<string, number>);
  // Partes del contexto agrupadas por tipo («Archivo: src/a.ts» → «Archivo»): lo que más ocupa es lo primero que acotar.
  const kind = (s: string) => /^[\w.@-]+(\/[\w.@-]+)+$/.test(s.trim()) ? 'contenido de archivo' : s.split(':')[0].trim();
  const contextBySource = Object.fromEntries(Object.entries(group(m => m.role ?? 'otro')).map(([role, v]) => {
    const acc = new Map<string, { calls: Set<string>; chars: number }>();
    for (const m of v) for (const c of m.context ?? []) { const k = kind(c.source); const e = acc.get(k) ?? { calls: new Set<string>(), chars: 0 }; e.calls.add(m.id); e.chars += c.chars; acc.set(k, e); }
    return [role, Array.from(acc, ([source, e]) => ({ source, calls: e.calls.size, avgChars: Math.round(e.chars / e.calls.size) })).sort((a, b) => b.avgChars * b.calls - a.avgChars * a.calls).slice(0, 8)];
  }));
  return {
    since, calls: rows.length, failed: rows.filter(m => m.status === 'failed').length, byRole, byBackend, contextBySource,
    split: { modelMs: rows.reduce((a, m) => a + m.waitMs, 0), portalMs: rows.reduce((a, m) => a + m.buildMs, 0) },
    duplicates, failures, repoReads: { total: rows.reduce((a, m) => a + reads(m), 0), callsWithReads: rows.filter(m => reads(m) > 0).length }
  };
}
