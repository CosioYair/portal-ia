/**
 * Portal IA 3 · Recorrido de aceptación del propietario, DENTRO del Portal.
 *
 * Cada paso es algo que el propietario pidió y dijo no poder hacer. No se marca solo: lo hace él, en la pantalla real, y
 * anota si funcionó. «Funciona» lo decide quien usa el producto, no una prueba automática ni una casilla marcada en un
 * segundo. Un paso con fallo queda a la vista con su comentario hasta que se corrija y se vuelva a probar.
 */
export interface AcceptanceStep {
  id: string;
  group: 'Saber qué pasa' | 'Pedir y revisar trabajo' | 'Que el trabajo no se atasque' | 'Agentes que son tuyos' | 'Moverse por el Portal' | 'Trabajo pendiente de antes';
  title: string;
  /** Lo que pediste, con tus palabras cuando existen. */
  asked: string;
  /** Dónde se prueba (ruta del Portal) y el texto del enlace. */
  to: string; go: string;
  /** Qué hacer, en orden. Todo dentro del Portal. */
  how: string[];
  /** Qué deberías ver si funciona. */
  expect: string;
}

export const ACCEPTANCE_GUIDE_VERSION = '3.0';

export const ACCEPTANCE_STEPS: AcceptanceStep[] = [
  {
    id: 'estado-veraz', group: 'Saber qué pasa', title: 'Ver de un vistazo qué te necesita y qué está en marcha',
    asked: '«Me gustaría ver algún indicador que me deje saber cuáles son las historias pendientes por cerrar o continuar; este portal necesita ser muy intuitivo.»',
    to: '/trabajo', go: 'Abrir Trabajo',
    how: ['Abre Trabajo. Arriba está «Te necesitan»; después «En marcha» y «Por empezar».', 'Mira el estado de cada elemento y la frase que lo explica.', 'Pulsa el botón de uno de ellos.'],
    expect: 'Historias y encargos aparecen juntos. Nada dice «completado» si no lo aceptaste tú: lo detenido dice «Detenido sin terminar», lo integrado sin aceptar dice «falta tu aceptación». El botón te lleva a donde se actúa.'
  },
  {
    id: 'pedir-sin-historias', group: 'Pedir y revisar trabajo', title: 'Pedir un cambio sin crear una historia',
    asked: '«Arréglalo tú sin crear ninguna historia.»',
    to: '/asistente', go: 'Abrir el Asistente',
    how: ['Pide un cambio pequeño al Asistente con tus palabras.', 'Autoriza el encargo que te propone.', 'Vuelve a Trabajo.'],
    expect: 'El Asistente prepara UN encargo (no varias historias). El encargo aparece en Trabajo con su estado, igual que una historia.'
  },
  {
    id: 'revisar-dentro', group: 'Pedir y revisar trabajo', title: 'Revisar un resultado sin abrir archivos',
    asked: '«Las pruebas paso a paso a veces me mandan a revisar archivos en mis documentos; deben ser solo dentro del Portal.»',
    to: '/trabajo?ver=te-necesitan', go: 'Abrir lo que te necesita',
    how: ['Abre un trabajo que esté «Listo para revisar», «Detenido sin terminar» o «Integrada · falta tu aceptación».', 'Lee «Revisión del resultado».', 'Despliega «Detalles técnicos» solo si quieres.'],
    expect: 'Ves qué pediste, qué cambió, si las comprobaciones pasan, qué dijo la revisión, las capturas si las hay y qué probar. Si falta algo para aceptarlo, lo dice arriba en «Qué falta». No necesitas abrir ningún archivo ni la terminal.'
  },
  {
    id: 'pedir-cambios', group: 'Que el trabajo no se atasque', title: 'Pedir cambios sin que se pierda lo ya hecho',
    asked: '«Cuando concedo corrección o alguna otra acción similar casi no hace nada; me cuesta mucho volver a poner en marcha algo.»',
    to: '/trabajo?ver=te-necesitan', go: 'Abrir lo que te necesita',
    how: ['En un trabajo detenido o listo para revisar, pide un cambio con una nota.', 'Deja SIN marcar «Empezar de cero».', 'Pulsa «Aplicar los cambios pedidos» y autoriza.'],
    expect: 'El equipo corrige sobre lo que ya había: no se crea un intento nuevo desde cero ni se borra lo verificado. Si el fallo cambia (avanza), sigue; si se repite igual, se detiene y lo dice.'
  },
  {
    id: 'herramienta-ausente', group: 'Que el trabajo no se atasque', title: 'Una herramienta que falta no cuenta como fallo del trabajo',
    asked: '«Se sigue atascando prácticamente donde mismo.»',
    to: '/trabajo?ver=te-necesitan', go: 'Abrir lo que te necesita',
    how: ['Abre un trabajo detenido por la comprobación visual de las pantallas.', 'Lee el motivo de la pausa.', 'Pulsa «Repetir la verificación visual (sin IA)».'],
    expect: 'El motivo dice que falta una herramienta del Portal y que el trabajo no tiene nada que corregir. Tras actualizar el Portal, repetir la verificación deja las capturas en la revisión.'
  },
  {
    id: 'exportar', group: 'Agentes que son tuyos', title: 'Llevarte un agente sabiendo qué lleva y qué necesita',
    asked: '«Los agentes deberían funcionar tanto dentro de mi portal como fuera de él… con la misma efectividad.»',
    to: '/oficina', go: 'Abrir la Oficina',
    how: ['Abre un agente que tenga carpeta propia › Ajustes › Origen (en uno creado aquí: Ajustes › Archivos).', 'Lee «Exportar»: qué incluye, qué no sale, qué necesita y dónde puede trabajar.', 'Pulsa «Descargar paquete (ZIP)».'],
    expect: 'Antes de descargar ves si está listo y qué lleva. El paquete incluye sus programas, lo aprendido, las versiones de lo que necesita y la comprobación de calidad del Portal. No incluye tus documentos.'
  },
  {
    id: 'traer-de-vuelta', group: 'Agentes que son tuyos', title: 'Traer de vuelta un agente que mejoró fuera',
    asked: '«Espero ver al importar todo lo aprendido por el agente.»',
    to: '/oficina', go: 'Abrir la Oficina',
    how: ['En ese mismo agente › Ajustes › Origen, baja a «Traer de vuelta un paquete mejorado».', 'Elige el paquete que usaste fuera.', 'Revisa los cambios, autoriza e importa. Después prueba «Deshacer esta importación».'],
    expect: 'Ves solo lo que cambió, archivo a archivo, con su comparación. Lo que también cambió aquí te pregunta cuál conservar. Tus documentos no se tocan. Deshacer lo deja como estaba.'
  },
  {
    id: 'navegacion', group: 'Moverse por el Portal', title: 'Ir y volver sin perder dónde estabas',
    asked: '«Tengo que hacer mucho scroll… no quiero ver información repetida o pantallas similares.»',
    to: '/trabajo?ver=por-empezar', go: 'Abrir Trabajo con un filtro',
    how: ['En Trabajo elige un filtro y escribe en el buscador.', 'Abre un elemento y vuelve con Atrás.', 'Recarga la página.'],
    expect: 'El filtro y la búsqueda siguen ahí al volver y al recargar. El menú va por objetivos y «Trabajo» muestra cuántos te necesitan.'
  },
  {
    id: 'movil', group: 'Moverse por el Portal', title: 'Usarlo desde el móvil',
    asked: '«Tiene que ser compatible con mobile.»',
    to: '/trabajo', go: 'Abrir Trabajo',
    how: ['Abre el Portal en el móvil o estrecha la ventana del navegador.', 'Recorre Trabajo, una historia y la ficha de un agente.'],
    expect: 'Nada se sale por los lados, los botones se pueden pulsar con el dedo y la revisión se lee en una columna.'
  },
  {
    id: 'pendiente-anterior', group: 'Trabajo pendiente de antes', title: 'Retomar un trabajo que quedó detenido de antes, sin rehacerlo',
    asked: '«Hice múltiples iteraciones y no puedo terminar esto.»',
    to: '/trabajo?ver=te-necesitan', go: 'Abrir lo que te necesita',
    how: ['Abre un trabajo «Detenido sin terminar» que venga de antes.', 'Usa el botón principal que te ofrece su tarjeta (seguir corrigiendo, aplicar los cambios pedidos o repetir una comprobación).', 'Cuando esté listo, revísalo y decide tú si se integra.'],
    expect: 'Continúa sobre su trabajo ya hecho, sin empezar de cero. Nada se integra sin tu autorización. Lo que depende de él sigue esperando, y se dice así.'
  }
];

/** Huella del texto de un paso: si el paso cambia, una marca anterior deja de valer (hay que probarlo de nuevo). */
export function acceptanceStepSignature(s: AcceptanceStep): string {
  const text = [s.title, s.to, s.go, ...s.how, s.expect].join('\n');
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export type AcceptanceResult = 'ok' | 'fail';
export interface AcceptanceMark { result: AcceptanceResult | null; comment: string; at: string | null; /** Huella del paso cuando se marcó. */ sig?: string }
export interface AcceptanceView {
  version: string;
  steps: (AcceptanceStep & { mark: AcceptanceMark })[];
  summary: { total: number; ok: number; fail: number; pending: number; accepted: boolean };
}

export function acceptanceView(marks: Record<string, AcceptanceMark | undefined>): AcceptanceView {
  // Una marca vale solo para el paso tal como estaba al marcarlo: si su texto cambió, vuelve a «sin probar» (se conserva el comentario).
  const steps = ACCEPTANCE_STEPS.map(s => {
    const m = marks[s.id];
    if (!m) return { ...s, mark: { result: null, comment: '', at: null } };
    if (m.sig !== acceptanceStepSignature(s)) return { ...s, mark: { result: null, comment: m.comment, at: null } };
    return { ...s, mark: { result: m.result, comment: m.comment, at: m.result ? m.at : null } };
  });
  const ok = steps.filter(s => s.mark.result === 'ok').length; const fail = steps.filter(s => s.mark.result === 'fail').length;
  // «Aceptado» solo cuando TODOS los pasos los marcó el propietario como correctos. Un fallo o un pendiente lo impide.
  return { version: ACCEPTANCE_GUIDE_VERSION, steps, summary: { total: steps.length, ok, fail, pending: steps.length - ok - fail, accepted: ok === steps.length } };
}
