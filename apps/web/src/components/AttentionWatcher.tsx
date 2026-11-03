import { useCallback, useEffect, useRef } from 'react';
import { api } from '../lib/api.ts';
import { osApi } from '../lib/osApi.ts';
import { useApp } from '../lib/store.ts';
import { useLive } from '../lib/live.ts';
import { setAttention } from '../lib/uiBus.ts';

/**
 * Cifras de «lo que te espera» en la empresa seleccionada, una sola vez para toda la aplicación (sustituye al botón
 * flotante de Autorizaciones): decisiones de procesos (bandeja) y peticiones de los agentes que NO son de un proceso
 * (aprendizajes por verificar, mejoras, cambios en su carpeta, acciones del chat). Las propuestas del Asistente las
 * anota su panel. Se piden al cambiar de empresa y cuando algo puede crear o cerrar una decisión (tiempo real), nunca
 * en cada navegación. Cada respuesta se descarta si la empresa ya no es la seleccionada.
 */
const cache = new Map<string, { decisions: number; agentItems: number }>();
export function AttentionWatcher() {
  const { status } = useApp();
  const slug = status.workspace?.slug ?? null;
  const current = useRef(slug); current.current = slug;
  const load = useCallback(() => {
    if (!slug) return;
    const c = cache.get(slug); if (c) setAttention({ slug, ...c, known: true });
    void Promise.all([api.inbox(slug).catch(() => null), osApi.office(slug, null).catch(() => null)]).then(([inbox, office]) => {
      const agentItems = office ? office.agents.reduce((n, a) => n + a.attention.filter(x => !x.processId).length, 0) : (cache.get(slug)?.agentItems ?? 0);
      const decisions = inbox ? inbox.length : (cache.get(slug)?.decisions ?? 0);
      cache.set(slug, { decisions, agentItems });
      if (current.current !== slug) return; // respuesta tardía de otra empresa
      setAttention({ slug, decisions, agentItems, known: !!(inbox && office) });
    });
  }, [slug]);
  useEffect(() => { load(); }, [load]);
  useLive(c => c.ws === slug && c.kind !== 'progress' && (c.entity === 'process' || c.entity === 'assignment' || c.entity === 'batch' || c.entity === 'agent' || c.entity === 'agent_chat'), load, { minMs: 3000, enabled: !!slug });
  return null;
}
