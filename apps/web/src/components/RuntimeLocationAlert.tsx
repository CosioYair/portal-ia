// Alerta de ubicación del Portal: compara carpeta y rama en ejecución con el repositorio registrado.
// Solo lee (GET) y no ofrece acciones con efecto lateral: «Volver a comprobar» repite la consulta
// y «Copiar pasos» solo escribe en el portapapeles.

import { useEffect, useState } from 'react';
import type { RuntimeLocationCheck } from '@portal/contracts';

export interface RuntimeLocationAlertProps {
  readonly projectId: string;
  /** «global» se muestra en el shell al iniciar; «proyecto» en la vista del proyecto. */
  readonly variante?: 'global' | 'proyecto';
}

type Estado =
  | { readonly tipo: 'cargando' }
  | { readonly tipo: 'listo'; readonly datos: RuntimeLocationCheck }
  | { readonly tipo: 'error'; readonly mensaje: string };

const SIN_DATO = '(desconocida)';

function esResultado(valor: unknown): valor is RuntimeLocationCheck {
  if (typeof valor !== 'object' || valor === null) return false;
  const candidato = valor as Record<string, unknown>;
  return (
    typeof candidato['estado'] === 'string' &&
    typeof candidato['ejecucion'] === 'object' &&
    candidato['ejecucion'] !== null &&
    typeof candidato['registrado'] === 'object' &&
    candidato['registrado'] !== null &&
    Array.isArray(candidato['historiasCompletadas']) &&
    Array.isArray(candidato['pasos'])
  );
}

const cajaBase = {
  borderRadius: 8,
  padding: '12px 16px',
  margin: '8px 0',
  fontSize: 14
} as const;

const estilos = {
  alerta: { ...cajaBase, border: '2px solid #b42318', background: '#fef3f2', color: '#7a271a' },
  aviso: { ...cajaBase, border: '1px solid #b54708', background: '#fffaeb', color: '#7a2e0e' },
  discreto: { ...cajaBase, padding: '4px 12px', border: '1px solid #d0d5dd', background: '#f9fafb', color: '#344054' },
  tabla: { borderCollapse: 'collapse', width: '100%', margin: '8px 0' },
  celda: { border: '1px solid #d0d5dd', padding: '4px 8px', textAlign: 'left', wordBreak: 'break-all' },
  boton: { marginRight: 8, padding: '4px 12px', cursor: 'pointer' }
} as const;

function textoRama(datos: RuntimeLocationCheck): string {
  if (datos.ejecucion.rama !== null) return datos.ejecucion.rama;
  return datos.ejecucion.headDesacoplado ? 'HEAD desacoplado (sin rama)' : SIN_DATO;
}

function Historias({ datos }: { readonly datos: RuntimeLocationCheck }) {
  const noContenidas = datos.historiasCompletadas.filter((historia) => historia.contenida === false);
  const desconocidas = datos.historiasCompletadas.filter((historia) => historia.contenida === null);
  if (noContenidas.length === 0 && desconocidas.length === 0) return null;
  return (
    <div>
      {noContenidas.length > 0 && (
        <>
          <strong>Historias completadas que NO están en la rama en ejecución:</strong>
          <ul>
            {noContenidas.map((historia) => (
              <li key={historia.id}>
                {historia.id} — {historia.titulo}
              </li>
            ))}
          </ul>
        </>
      )}
      {desconocidas.length > 0 && (
        <>
          <strong>Historias completadas con estado desconocido (sin SHA registrado o sin comprobar):</strong>
          <ul>
            {desconocidas.map((historia) => (
              <li key={historia.id}>
                {historia.id} — {historia.titulo}: desconocido
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Pasos({ pasos }: { readonly pasos: readonly string[] }) {
  const [copiado, setCopiado] = useState<'no' | 'si' | 'fallo'>('no');
  if (pasos.length === 0) return null;
  const copiar = (): void => {
    const texto = pasos.map((paso, indice) => `${indice + 1}. ${paso}`).join('\n');
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
      setCopiado('fallo');
      return;
    }
    navigator.clipboard.writeText(texto).then(
      () => setCopiado('si'),
      () => setCopiado('fallo')
    );
  };
  return (
    <div>
      <strong>Cómo corregirlo:</strong>
      <ol>
        {pasos.map((paso) => (
          <li key={paso}>
            <code>{paso}</code>
          </li>
        ))}
      </ol>
      <button type="button" style={estilos.boton} onClick={copiar}>
        Copiar pasos
      </button>
      {copiado === 'si' && <span>Pasos copiados.</span>}
      {copiado === 'fallo' && <span>No se pudo copiar; selecciona el texto manualmente.</span>}
    </div>
  );
}

export function RuntimeLocationAlert({ projectId, variante = 'proyecto' }: RuntimeLocationAlertProps) {
  const [estado, setEstado] = useState<Estado>({ tipo: 'cargando' });
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    const controlador = new AbortController();
    setEstado({ tipo: 'cargando' });
    fetch(`/api/projects/${encodeURIComponent(projectId)}/runtime-location`, {
      signal: controlador.signal
    })
      .then(async (respuesta) => {
        if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
        const cuerpo: unknown = await respuesta.json();
        if (!esResultado(cuerpo)) throw new Error('Respuesta inesperada');
        setEstado({ tipo: 'listo', datos: cuerpo });
      })
      .catch((error: unknown) => {
        if (controlador.signal.aborted) return;
        setEstado({
          tipo: 'error',
          mensaje: error instanceof Error ? error.message : 'Error desconocido'
        });
      });
    return () => controlador.abort();
  }, [projectId, intento]);

  const volver = (
    <button type="button" style={estilos.boton} onClick={() => setIntento((n) => n + 1)}>
      Volver a comprobar
    </button>
  );

  if (estado.tipo === 'cargando') {
    return (
      <div style={estilos.discreto} role="status" data-variante={variante}>
        Comprobando la carpeta y la rama del Portal…
      </div>
    );
  }

  if (estado.tipo === 'error') {
    return (
      <div style={estilos.aviso} role="alert" data-variante={variante}>
        <p>
          ⚠️ No se pudo comprobar la ubicación del Portal ({estado.mensaje}).
        </p>
        {volver}
      </div>
    );
  }

  const { datos } = estado;

  if (datos.estado === 'no-verificable') {
    return (
      <div style={estilos.aviso} role="status" data-variante={variante}>
        <p>
          ℹ️ No se puede verificar la ubicación del Portal:{' '}
          {datos.motivoNoVerificable ?? 'motivo no indicado'}
        </p>
        {volver}
      </div>
    );
  }

  if (datos.estado === 'coincide') {
    const faltan = datos.historiasCompletadas.some((historia) => historia.contenida === false);
    return (
      <div style={faltan ? estilos.aviso : estilos.discreto} role="status" data-variante={variante}>
        <span>
          ✅ El Portal corre en la rama <strong>{textoRama(datos)}</strong>, en la carpeta registrada.
        </span>
        {faltan && (
          <>
            <p>⚠️ Algunas historias completadas no están contenidas en esta rama.</p>
            <Historias datos={datos} />
          </>
        )}
      </div>
    );
  }

  return (
    <div style={estilos.alerta} role="alert" data-variante={variante}>
      <p>
        <strong>🚨 El Portal corre desde una carpeta o rama distinta al repositorio registrado.</strong>{' '}
        Los cambios que aplique el equipo pueden no verse aquí.
      </p>
      <table style={estilos.tabla}>
        <thead>
          <tr>
            <th style={estilos.celda} />
            <th style={estilos.celda}>Ejecución</th>
            <th style={estilos.celda}>Registrado</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th style={estilos.celda}>Carpeta</th>
            <td style={estilos.celda}>{datos.ejecucion.ruta ?? SIN_DATO}</td>
            <td style={estilos.celda}>{datos.registrado.ruta ?? SIN_DATO}</td>
          </tr>
          <tr>
            <th style={estilos.celda}>Rama</th>
            <td style={estilos.celda}>{textoRama(datos)}</td>
            <td style={estilos.celda}>{datos.registrado.rama ?? SIN_DATO}</td>
          </tr>
        </tbody>
      </table>
      <Historias datos={datos} />
      <Pasos pasos={datos.pasos} />
      {volver}
    </div>
  );
}
