import type { Process } from '@portal-ia/domain';
import { fmtUsd } from '../lib/labels.ts';
import { nextStepTarget, type NextStepTarget, type ProcStatusLabel } from '../lib/processView.ts';
import { Chip, Icon } from './ui.tsx';

/**
 * HU-167 · Resumen del proceso: estado, gasto con barra y el siguiente paso como botón principal.
 * El botón solo lleva a una sección de la página o a la historia (onNext): no autoriza, no reintenta,
 * no recupera ni llama a la IA. Sin guidance o con el proceso archivado no hay botón.
 */
export function ProcessHeader({ proc, status, onNext }: {
  proc: Process;
  status: ProcStatusLabel;
  onNext: (target: NextStepTarget) => void;
}) {
  const tokens = proc.inputTokens + proc.outputTokens;
  const pct = proc.budgetUsd ? Math.min(100, Math.round((proc.spentUsd / proc.budgetUsd) * 100)) : 0;
  const level = pct >= 90 ? ' is-err' : pct >= 70 ? ' is-warn' : '';
  const target = nextStepTarget(proc);
  const next = proc.guidance?.next;
  return (
    <div className="proc-header" data-proc-header>
      <div className="proc-header-chips">
        <Chip tone={status.tone} dot={status.dot}>{status.label}</Chip>
        <Chip xs>{proc.steps.filter(s => s.status === 'done').length} de {proc.steps.length} pasos</Chip>
      </div>
      <div className="spend">
        <div className="spend-bar" role="progressbar" aria-label="Gasto sobre el presupuesto autorizado" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={`${fmtUsd(proc.spentUsd)} gastado de ${fmtUsd(proc.budgetUsd)} autorizado (${pct} %)`}>
          <div className={`spend-bar-fill${level}`} style={{ width: `${pct}%` }} />
        </div>
        <div className="small mono spend-text">{fmtUsd(proc.spentUsd)} gastado de {fmtUsd(proc.budgetUsd)} autorizado · {pct} % · {tokens} tokens</div>
      </div>
      {next && target && <div>
        <button type="button" className="btn btn-primary" data-next-step onClick={() => onNext(target)}>{next}{Icon.arrow()}</button>
      </div>}
    </div>
  );
}
