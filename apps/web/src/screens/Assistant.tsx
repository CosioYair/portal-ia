import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { AssistantInfo } from '../lib/api.ts';
import { fmtUsd } from '../lib/labels.ts';
import { Shell } from '../components/Shell.tsx';
import { Chip, KV } from '../components/ui.tsx';
import { AssistantChat } from '../components/AssistantChat.tsx';

/** Asistente global a pantalla completa. (El mismo asistente está siempre disponible en el dock flotante.) */
export function Assistant() {
  const [info, setInfo] = useState<AssistantInfo | null>(null);
  const [pending, setPending] = useState(0);
  // El texto que otra pantalla propone se toma UNA vez y se retira del historial: recargar no vuelve a pisar lo escrito.
  const loc = useLocation(); const navigate = useNavigate();
  const [draft] = useState(() => (loc.state as { draft?: string } | null)?.draft);
  useEffect(() => { if ((loc.state as { draft?: string } | null)?.draft) navigate(`${loc.pathname}${loc.search}${loc.hash}`, { replace: true, state: null }); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const pct = info ? Math.min(100, Math.round((info.spentThisMonthUsd / Math.max(0.01, info.monthlyLimitUsd)) * 100)) : 0;
  return (
    <Shell crumb="Asistente">
      <main className="page assist-page" style={{ display: 'flex', flexDirection: 'column', gap: 16, height: 'calc(100vh - 57px)', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="eyebrow">Asistente global</div>
            <h1 className="h1" style={{ fontSize: 24 }}>{info?.name ?? 'Asistente de Empresa'}</h1>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {info && <Chip className="mono" xs>{info.model}</Chip>}
              {info && <Chip xs tone={info.available ? (info.billing === 'subscription' ? 'ok' : '') : 'warn'}>{info.backendLabel}{info.billing === 'subscription' ? ' · sin cargo a la API' : ''}</Chip>}
              {info && info.billing === 'api' && <Chip xs>≈ {fmtUsd(info.estimatedPerMessageUsd)} por mensaje</Chip>}
              {info && !info.available && info.unavailableReason && <Chip xs tone="warn">{info.unavailableReason}</Chip>}
              {info && <Chip xs tone={pct >= 90 ? 'err' : pct >= 70 ? 'warn' : ''}>mes: {fmtUsd(info.spentThisMonthUsd)} de {fmtUsd(info.monthlyLimitUsd)}</Chip>}
              {pending > 0 && <Chip xs tone="warn" dot="pulse">{pending} propuesta(s) por autorizar</Chip>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {info && <Link className="btn btn-ghost btn-sm" to={`/equipo/${info.agentId}`}>Configurar asistente</Link>}
          </div>
        </div>
        <AssistantChat onInfo={setInfo} onPending={setPending} initialText={draft} />
        {info && <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }} className="small muted"><KV k="Cada envío">1 llamada real al modelo del asistente</KV><KV k="Cambios locales">sin IA; los confirmas tú en la tarjeta</KV><KV k="Ejecutar / encargos / historias">el asistente propone; tú autorizas en la tarjeta</KV></div>}
      </main>
    </Shell>
  );
}
