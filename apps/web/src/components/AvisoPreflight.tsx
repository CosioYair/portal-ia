import type { ExecutionPreflightResult } from '@portal/contracts';

interface AvisoPreflightProps {
  /** Resultado de la comprobación previa; null mientras no se ha comprobado. */
  readonly resultado: ExecutionPreflightResult | null;
}

const ETIQUETAS: Readonly<Record<string, string>> = {
  'rama-actual': 'Rama en ejecución',
  'main-actualizado': 'main actualizado respecto a origin/main',
  'rama-por-defecto-remoto': 'Rama por defecto del remoto'
};

const ICONOS: Readonly<Record<string, string>> = {
  ok: '✅',
  fallo: '❌',
  indeterminado: '❔'
};

const TEXTOS_ESTADO: Readonly<Record<string, string>> = {
  ok: 'Correcto',
  fallo: 'Fallo',
  indeterminado: 'No se pudo comprobar'
};

/** Aviso de la comprobación previa a ejecutar una historia. No lanza ninguna acción con coste. */
export function AvisoPreflight({ resultado }: AvisoPreflightProps) {
  if (resultado === null) {
    return (
      <section className="aviso-preflight" role="status" aria-live="polite">
        <p>
          <span aria-hidden="true">⏳</span> Comprobando que el Portal corre desde main actualizado…
        </p>
      </section>
    );
  }

  if (resultado.ok) {
    return (
      <section className="aviso-preflight aviso-preflight--ok" role="status" aria-live="polite">
        <p>
          <span aria-hidden="true">✅</span> El Portal corre desde main actualizado. Puedes lanzar la
          historia.
        </p>
      </section>
    );
  }

  const hayFallo = resultado.checks.some((comprobacion) => comprobacion.estado === 'fallo');

  return (
    <section className="aviso-preflight aviso-preflight--detenido" role="alert">
      <h3>
        <span aria-hidden="true">⛔</span>{' '}
        {hayFallo
          ? 'Detenido: el Portal no corre desde main actualizado'
          : 'Detenido: no se pudo verificar que el Portal corra desde main actualizado'}
      </h3>
      {resultado.motivo !== null ? <p>{resultado.motivo}</p> : null}
      <ul>
        {resultado.checks.map((comprobacion) => (
          <li key={comprobacion.id}>
            <span aria-hidden="true">{ICONOS[comprobacion.estado] ?? '❔'}</span>{' '}
            <strong>{ETIQUETAS[comprobacion.id] ?? comprobacion.id}</strong>
            {' — '}
            {TEXTOS_ESTADO[comprobacion.estado] ?? comprobacion.estado}: {comprobacion.detalle}
          </li>
        ))}
      </ul>
      <p>
        La historia no se ha ejecutado y no se ha consumido presupuesto. Corrige la situación y vuelve a
        intentarlo.
      </p>
    </section>
  );
}
