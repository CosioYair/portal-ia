import type { ClaudeCodeRateLimit, ClaudeCodeUsageReport } from '@portal-ia/domain';
import { settingsRepo } from '../../db/platform.ts';
import { monotonicNow } from '../../clock.ts';

/**
 * Lo que el CLI oficial informa de los límites de la suscripción (ver ClaudeCodeRateLimit). Es de la CUENTA, no de un
 * espacio: se guarda en la base de plataforma con su hora. Solo se actualiza cuando se hace una llamada, así que nunca se
 * presenta como saldo en vivo ni se convierte en «llamadas restantes».
 */
const KEY = 'claude_code.last_rate_limit';
const ACK = 'claude_code.overage_ack';
/** Último informe con uso adicional: el bloqueo persiste aunque lleguen informes posteriores sin la marca. */
const OVERAGE_AT = 'claude_code.overage_at';

export function saveUsageReport(rl: ClaudeCodeRateLimit, source: string) {
  const receivedAt = monotonicNow();
  settingsRepo.set(KEY, JSON.stringify({ ...rl, receivedAt, source } satisfies ClaudeCodeUsageReport));
  if (rl.overage) settingsRepo.set(OVERAGE_AT, receivedAt);
}
export function lastUsageReport(): ClaudeCodeUsageReport | null {
  try { const raw = settingsRepo.get(KEY); return raw ? JSON.parse(raw) as ClaudeCodeUsageReport : null; } catch { return null; }
}
/**
 * El propietario reconoce el último informe (uso adicional «overage», o un límite que ya se renovó antes de lo que dijo
 * el CLI): ese informe deja de impedir empezar trabajo. Un informe nuevo del CLI vuelve a contar.
 */
export function acknowledgeUsageReport(): ClaudeCodeUsageReport | null { const r = lastUsageReport(); settingsRepo.set(ACK, monotonicNow()); return r; }
const acknowledgedSince = (at: string | null | undefined) => { const ack = settingsRepo.get(ACK); return !!ack && !!at && ack >= at; };

const hhmm = (iso: string) => new Date(iso).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
const resets = (s: number | null) => s ? new Date(s * 1000).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : null;

/**
 * ¿Se puede EMPEZAR trabajo nuevo con la suscripción? Falla de forma segura: un límite confirmado y aún no renovado, o
 * un indicio de uso adicional sin tu reconocimiento, lo impiden (y lo dicen). Sin informe, no se inventa nada: se puede
 * empezar y el propio CLI pausará si llega al límite.
 */
export function subscriptionGate(now = Date.now()): { ok: true; warning: string | null; report: ClaudeCodeUsageReport | null } | { ok: false; reason: string; report: ClaudeCodeUsageReport } {
  const r = lastUsageReport(); if (!r) return { ok: true, warning: null, report: null };
  const acknowledged = acknowledgedSince(r.receivedAt);
  const overAt = settingsRepo.get(OVERAGE_AT);
  if (overAt && !acknowledgedSince(overAt) && !r.overage) return { ok: false, report: r, reason: `Claude Code informó uso adicional («overage», ${hhmm(overAt)}), que podría facturarse aparte según tu cuenta. No se empieza trabajo nuevo con la suscripción hasta que lo reconozcas.` };
  if (r.overage && !acknowledged) return { ok: false, report: r, reason: `El último informe de Claude Code (${hhmm(r.receivedAt)}) indica uso adicional («overage»), que podría facturarse aparte según tu cuenta. No se empieza trabajo nuevo con la suscripción hasta que lo reconozcas (Proveedores → Claude Code).` };
  if (r.status === 'rejected' && !acknowledged && (r.resetsAt === null || r.resetsAt * 1000 > now)) return { ok: false, report: r, reason: `La suscripción de Claude alcanzó su límite (último informe de Claude Code, ${hhmm(r.receivedAt)})${r.resetsAt ? `; se renueva hacia ${resets(r.resetsAt)}` : ''}. No se empieza trabajo nuevo con la suscripción hasta entonces (o hasta que confirmes en Proveedores → Claude Code que ya se renovó); lo hecho se conserva.` };
  if (r.status === 'allowed_warning') return { ok: true, report: r, warning: `Último informe de Claude Code (${hhmm(r.receivedAt)}): cerca del límite${r.utilization !== null ? ` (${Math.round(r.utilization * 100)} % de la ventana ${r.rateLimitType ?? ''}, según el CLI)` : ''}.` };
  return { ok: true, warning: null, report: r };
}
