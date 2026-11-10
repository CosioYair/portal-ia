import { useCallback, useEffect, useRef } from 'react';
import { api } from '../lib/api.ts';
import { osApi } from '../lib/osApi.ts';
import { useApp } from '../lib/store.ts';
import { attentionChange, useLive } from '../lib/live.ts';
import { setAssistantPending, setAttention } from '../lib/uiBus.ts';

/**
 * Cifras de «lo que te espera» en la empresa seleccionada, una sola vez para toda la aplicación (sustituye al botón
 * flotante de Autorizaciones): decisiones de procesos (bandeja) y peticiones de los agentes que NO son de un proceso
 * (aprendizajes por verificar, mejoras, cambios en su carpeta, acciones del chat). Las propuestas abiertas del Asistente
 * llegan en la bandeja. Se piden al cambiar de empresa y cuando algo puede crear o cerrar una decisión, nunca en cada
 * navegación. Para lo segundo se usa el filtro compartido attentionChange (HU-189): avisos de la empresa sobre
 * procesos, encargos, lotes, agentes, backlog y el Asistente. Las propuestas del Asistente llevan la empresa, pero sus
 * mensajes y acciones del chat llegan sin ella y también se aceptan. Como mucho una petición cada 1,5 s, para reflejar
 * los cambios en menos de 3 s. Cada respuesta se descarta si la empresa ya no es la seleccionada.
 * Las acciones del chat que esperan aprobación (propose_*) no están en la bandeja: su cifra se pide a
 * GET /api/assistant/pending-count y se publica con setAssistantPending, sin depender de que el chat esté montado.
 */
const cache = new Map<string, { decisions: number; agentItems: number }>();
export function AttentionWatcher() {
  const { status } = useApp();
  const slug = status.workspace?.slug ?? null;
  const current = useRef(slug); current.current = slug;
  const load = useCallback(() => {
    if (!slug) return;
    const c = cache.get(slug); if (c) setAttention({ slug, ...c, known: true });
    void api.assistantPendingCount().then(r => setAssistantPending(r.count)).catch(() => { /* se conserva la última cifra */ });
    void Promise.all([api.inbox(slug).catch(() => null), osApi.office(slug, null).catch(() => null)]).then(([inbox, office]) => {
      const agentItems = office ? office.agents.reduce((n, a) => n + a.attention.filter(x => !x.processId).length, 0) : (cache.get(slug)?.agentItems ?? 0);
      const decisions = inbox ? inbox.length : (cache.get(slug)?.decisions ?? 0);
      cache.set(slug, { decisions, agentItems });
      if (current.current !== slug) return; // respuesta tardía de otra empresa
      setAttention({ slug, decisions, agentItems, known: !!(inbox && office) });
    });
  }, [slug]);
  useEffect(() => { load(); }, [load]);
  useLive(attentionChange(slug), load, { minMs: 1500, enabled: !!slug });
  return null;
}
