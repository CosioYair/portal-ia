# Ejecución continua: revisión Gauntlet (autorización por agente, selección escalable y resumen del lote)

Fecha: 30 de octubre de 2026. Revisión de la «Ejecución continua» tras el primer intento real del propietario
(HU-164 y HU-165 marcadas «claude-code — no autorizado» con todo autorizado). Método: estándar medible (ronda 0),
auditoría (1), evaluación independiente de la interfaz actual (2), corrección (3), evaluación independiente de lo
corregido (4), verificación (5) y rendimiento (6). Todo con datos sintéticos, proveedor y CLI de Claude Code simulados.

## Ronda 0 · Estándar de calidad (criterio → cómo se verifica)

| # | Criterio | Verificación |
|---|---|---|
| 1 | Autorización correcta agente/origen | `batch-authorization.test.ts`: gestionado, consola, solo API, equipo mixto, proyecto sin autorizar; la vista previa y la ejecución real dan el mismo resultado y el mismo motivo. |
| 2 | Vista previa exacta y comprensible | Cada historia que no empezará tiene ≥ 1 motivo concreto; cada agente, su origen, si puede ejecutar y un enlace para corregirlo. Ninguna fila dice «se ejecutará» si no empezará. |
| 3 | Selección escalable | Con 500 historias, la tabla nunca pinta más de 25 filas; búsqueda por ID, título y descripción; filtros de estado, tamaño y dependencias. |
| 4 | Flujo eficiente | 2 historias en 2 clics; 12 con un rango (Mayús + clic); ~100 en 2 interacciones (filtro + «seleccionar las filtradas»). Orden por defecto: el del backlog. |
| 5 | Dependencias seguras | Las que faltan se muestran y **no** se añaden solas; añadirlas es un clic explícito; el plan las pone antes (oleadas). |
| 6 | Presupuesto y suscripción claros | USD de API separado de las llamadas a la suscripción; la suscripción no se presenta como gratis («consume la cuota de tu plan»); peor caso si Claude Code cede a la API; rango de llamadas con su incertidumbre. |
| 7 | Git seguro por defecto | Integrar, reiniciar y publicar desmarcados en cada lote nuevo; reiniciar y publicar exigen integrar (también en el servidor); un lote nuevo no hereda nada. |
| 8 | Pausa, reanudación y recuperación | Pruebas K/L/M existentes en verde; el límite de la suscripción en el primer paso pausa TODO el lote; reanudar re-encola lo que no llegó a trabajar; el alcance autorizado no cambia al reanudar. |
| 9 | Progreso y errores comprensibles | El monitor dice «espera tu decisión» si nada avanza; «Reintentar» donde no hay trabajo que conservar; cancelar pide confirmación y no deja historias «esperando» sin acciones. |
| 10 | Aceptación individual del propietario | Pruebas O/P existentes en verde (sin cambios en la aceptación). |
| 11 | Accesibilidad y adaptación | Casillas alcanzables con Tab y marcables con Espacio, foco visible, etiquetas en filtros y casillas; sin desbordamiento horizontal a 390 y 1280 px (`scrollWidth ≤ innerWidth`). |
| 12 | Rendimiento con backlogs grandes | Vista previa de 200 historias ≤ 150 ms (repositorio real); filtrar 500 historias < 100 ms en el navegador; una petición por ráfaga de cambios. |
| 13 | Aislamiento entre empresas y proyectos | Historias de otro proyecto o no pendientes, rechazadas (prueba Q); la autorización de Claude Code es por proyecto. |
| 14 | Sin llamadas de IA innecesarias | Seleccionar y previsualizar: 0 llamadas (registro del proveedor simulado y de la CLI simulada). |

## Ronda 1 · Auditoría: causa raíz del aviso «claude-code — no autorizado»

Recorrido `backend del agente → proyecto autorizado → orígenes del lote → vista previa → lote guardado → ejecución`:

- El agente guarda su origen como `ExecutionBackend` = `'api' | 'claude-code' | 'claude-code-terminal'` (con guion).
- El lote autoriza `('api' | 'claude_code')[]` (con guion bajo).
- `previewBatch` (`batchRunner.ts`, vista previa) y `startItem` (arranque real) leían `agent.config.backend` y lo
  **convertían a la fuerza** (`as 'api' | 'claude_code'`), sin traducirlo: `'claude-code'` nunca está en
  `['api', 'claude_code']`. La conversión forzada ocultó el error al comprobador de tipos.
- Resultado: con todo autorizado, la vista previa marcaba «no autorizado» y, al autorizar, **cada** historia pasaba a
  «esperando tu decisión» con «El equipo usa un origen de ejecución no autorizado en el lote (claude-code)». No era un
  problema de normalización del proyecto ni de configuración obsoleta: era un desajuste de identificadores, igual en la
  vista previa y en la ejecución.
- Por qué no lo vieron las pruebas: la prueba Q del lote solo usaba agentes en la API.
- Mismo desajuste en la interfaz del Evaluador Gauntlet (`Gauntlet.tsx`): un Evaluador en Claude Code se mostraba «API».
- Hallazgos asociados:
  - La vista previa no comprobaba lo que sí comprobaba el arranque (conector, proyecto, consola), así que podían discrepar.
  - La alternativa por API dependía solo del ajuste global del conector: un lote **sin** la API autorizada podía facturar API.
  - El coste de la vista previa contaba todo al precio de la API, también los pasos de Claude Code.
  - El límite de la suscripción en el primer paso (el plan) se clasificaba como un fallo de la historia y no pausaba el lote.

Prueba de regresión, escrita **antes** de la corrección y fallando en la vista previa (`['claude-code']` frente a
`[]`) y en la ejecución («no autorizado en el lote (claude-code)»): primera prueba de `batch-authorization.test.ts`.

## Ronda 2 · Evaluación independiente de la interfaz actual

Evaluador con contexto nuevo, en un Portal aislado (500 historias sintéticas, agentes en Claude Code gestionado,
proyecto autorizado), con Playwright. Hallazgos principales, en orden de gravedad:

1. **Bloqueante:** el fallo de identificadores; 2/2, 12/12 y 30/30 historias marcadas.
2. La vista previa se contradecía («no autorizado» y «se ejecutará» en la misma fila) y permitía autorizar.
3. Al volver a un lote interrumpido: «en marcha» sin nada en marcha; «Reanudar» no volvía a poner en cola nada.
4. La API (facturable) venía marcada y no aparecía en la frase que autorizas.
5. La alternativa por API no respetaba los orígenes del lote.
6. La selección no escalaba:
   - caja de 260 px con 449 historias (10.253 px de contenido);
   - 466 pulsaciones de Tab;
   - un máximo de 30 oculto, con el error fuera de la vista.
7. El coste ignoraba el origen: 32,34 USD «estimados» para un equipo en la suscripción.
8. Desbordamiento horizontal a 390 px (631 px).
9. «Depende de» se guardaba en el backlog sin decirlo; 500 opciones por historia seleccionada.
10. El orden era el de los clics, no el del backlog.
11. El estado de cada historia no se veía.
12. «Cancelar lote» actuaba con un clic y dejaba historias «esperando» sin acciones.
13. La frase de autorización contaba historias que no iban a empezar.

## Ronda 3 · Correcciones y diseño

**Modelo de autorización** (un solo lugar):
- `batchSourceOf` (en `domain/batch.ts`) traduce el backend del agente al origen del lote: gestionado y consola → `claude_code`.
- `checkTeam` (`batchRunner.ts`) comprueba **cada agente**:
  - si el lote autoriza su origen;
  - conector, proyecto, suscripción verificada, consola conectada y proveedor de API conectado;
  - la alternativa por API, que debe autorizar el lote.
- Devuelve el motivo y dónde se corrige.
- La usan la vista previa **y** el arranque real de cada historia: no pueden discrepar.

**Alternativa por API:**
- Nuevo `auth.apiFallback`, desactivado por defecto; exige la API marcada en el lote y la alternativa activa en el conector.
- El proceso de la historia lleva `pipeline.config.apiFallback = false` si el lote no la autoriza.
- `apiFallbackFor` (`storyPipeline.ts`) es la única comprobación, en la llamada, en el paso y en la estimación.

**Origen por defecto:** solo la suscripción de Claude Code. La API (facturable) exige marcarla, en la interfaz y en el
servidor.

**Selección escalable** (`BatchStoryPicker.tsx`):
- búsqueda por ID, título y descripción, sin distinguir tildes;
- filtros de estado (elegibles, pendientes, bloqueadas, todas), tamaño y dependencias («les falta su dependencia»);
- «Seleccionar las filtradas» y «Quitar las filtradas», que actúan solo sobre lo filtrado y elegible, en todas sus
  páginas; «Vaciar la selección»;
- rango con Mayús + clic;
- páginas de 25 filas;
- un contador permanente con las seleccionadas que no se ven con los filtros actuales;
- estado y dependencia de cada historia;
- las no elegibles, visibles con «Todas» pero no seleccionables;
- máximo de 200 por lote, visible; nunca se recorta en silencio (el servidor rechaza más con su motivo).

**Orden:** el del backlog (su prioridad), con «al principio», subir, bajar y quitar. «Depende de» se edita con un campo
y una lista común (no 500 opciones por fila) y la interfaz avisa de que se guarda en el backlog.

**Resumen persistente** (columna derecha fija; en pantallas estrechas, al final, con una barra fija que lleva a él):
- seleccionadas, que empezarán, bloqueadas por dependencias y sin permiso, con «quitar las que no pueden empezar»;
- llamadas a modelos (mínimo–máximo) y a la suscripción frente a su tope;
- USD de API y su peor caso;
- duración orientativa (mediana del historial, solo con ≥ 5 historias);
- dependencias que faltan, con «Añadir» explícito;
- oleadas;
- qué hará sin preguntarte y qué seguirá siendo tuyo;
- avisos;
- la frase de autorización, con el número que empezará, los orígenes y las operaciones git.

La vista previa se actualiza sola (una petición tras cada ráfaga de cambios) y cualquier cambio desmarca la autorización.
No se puede autorizar con historias sin permiso ni sin orígenes.

**Equipo y orígenes:** una tabla por agente (qué hace, su origen y si puede ejecutar), con el motivo y un enlace a
«Proveedores → Claude Code» o al agente.

**Recuperación:**
- El límite de la suscripción o un Claude Code no disponible en el primer paso pausan todo el lote, y la historia queda
  esperando tu decisión: no queda «fallida».
- «Reintentar» por historia (con autorización) cuando no hay trabajo que conservar.
- Reanudar re-encola las que no llegaron a trabajar.
- El monitor dice «espera tu decisión» cuando nada avanza.
- Cancelar pide confirmación y cierra lo que esperaba.

**Rendimiento:** el contexto del repositorio se mide una vez por vista previa, no una vez por historia.

## Ronda 4 · Evaluación independiente de lo corregido (1.ª revisión) y correcciones

Veredicto del evaluador: **«no listo (cerca)»**. Confirmó en ejecución que el fallo original está resuelto y que la vista
previa y el arranque dan el mismo motivo. Hallazgos y corrección de cada uno:

| # | Gravedad | Hallazgo | Corrección |
|---|---|---|---|
| 1 | mayor | «Empezarán 95» con un tope de 60 llamadas (caben ≈ 20); el tope máximo de 400 hacía imposible un lote de 200 | `summary.fits`: cuántas empiezan antes de pausarse, con la misma regla que el coordinador; aviso y botón explícito «Subir el tope»; tope máximo 2000; KPI «Pueden empezar» |
| 2 | mayor | Sin «Integrar en main», la dependiente del lote nunca empieza; el monitor decía «en marcha» | `summary.waitForManualIntegration` (aviso, fuera de los totales); `batchMoving()` en el dominio: el monitor y el servidor dicen «espera tu decisión» y por qué |
| 3 | mayor | Un problema de permisos de todo el lote se trataba historia a historia (6 procesos cancelados, 6 «Reintentar»); el servidor aceptaba un lote que la vista previa bloquea; motivo repetido 4 veces | `createBatch` rechaza (409 `not_authorized`) con los mismos motivos; `startItem` comprueba ANTES de crear el proceso y pausa el lote una vez con el motivo y su enlace (`reasonFix`); motivos sin repetir; `network` pausa todo el lote |
| 4 | mayor | Duración «≈ 2 min» con historias que se detuvieron | Solo historias verificadas (o integradas) de ≥ 1 min; mediana y p25–p75; ≥ 5 muestras |
| 5 | menor | El rango con Mayús se recortaba al máximo sin decirlo | Aviso «Se añadieron X de Y: alcanzaste el máximo» |
| 6 | menor | El coste de API no contaba las correcciones autorizadas | Rango de USD por historia y total (mismo criterio que las llamadas) |
| 7 | menor | Tras cancelar, las historias empezadas dejan de ser elegibles sin aviso | La confirmación de cancelar lo dice |
| 8 | menor | El registro decía «falló» y la historia «espera tu decisión» | El texto sigue la clasificación de todo el lote |

Huecos del estándar señalados y añadidos al estándar:
- que «empezarán» sea cierto con los límites y sin integrar;
- que el servidor rechace lo que la vista previa bloquea;
- que una pérdida de permisos durante el lote pause el lote entero;
- que las muestras de duración sean válidas;
- ordenar y filtrar por responsable (añadidos a la selección).

## Ronda 5 · Segunda revisión independiente y tercera corrección

El evaluador confirmó en el entorno aislado (no solo en las pruebas) que los 8 hallazgos de la ronda 4 están resueltos.

Hallazgos nuevos y su corrección:

| # | Gravedad | Hallazgo | Corrección |
|---|---|---|---|
| 1 | mayor | «Caben» no contaba la duración máxima del lote: con historias de ~1 min y 5 min de límite decía «7 de 7» | `fits` también con la duración: mediana del historial (optimista) y p75 (pesimista), con la concurrencia; aviso y botón «Subir la duración máxima» |
| 2 | mayor | Un agente cambiado a la API a mitad de una historia hacía llamadas facturables en un lote que no autoriza la API | `pipeline.config.backends`: el origen del lote se comprueba en **cada** llamada (`originBlocked`); si no está autorizado, no se llama y el lote se pausa con el motivo (`permission` pausa todo el lote) |
| 3 | menor | Con 6 correcciones, el peor caso de 200 historias superaba el tope máximo de 2000 llamadas | Tope máximo 5000 |
| 4 | menor | «Caben» suponía una historia a la vez | La estimación modela la concurrencia (las de un grupo no ven las llamadas de las otras) y avisa de que el tope puede superarse un poco |

Se acordó un máximo de tres rondas de revisión y corrección; esta fue la tercera. Lo pendiente está en
«Limitaciones conocidas».

## Ronda 6 · Rendimiento

Todo medido en una instancia aislada con 500 historias sintéticas y proveedor simulado.

| Medida | Antes | Después |
|---|---|---|
| Vista previa en el servidor, 200 historias (repositorio real del Portal) | 471 ms | 92 ms (el contexto del repositorio se mide una vez) |
| Vista previa en el servidor, 100 historias | 245 ms | 52 ms |
| DOM del asistente con 30 seleccionadas | 17.594 nodos (15.004 `<option>`: 500 por historia) | — |
| DOM del asistente con 111 seleccionadas | — | 3.234 nodos (523 `<option>`: una lista común) |
| Filas pintadas con 500 historias | 449 casillas en una caja de 260 px | 25 por página |
| Filtrar entre 500 (navegador, incluye Playwright) | sin filtros | 12–25 ms |
| Marcar 111 filtradas | 111 clics | 1 clic, 44–47 ms |
| Peticiones por cambio | 1 por clic en «Vista previa» | 1 por ráfaga (espera de 350 ms) |
| Llamadas de IA al seleccionar y previsualizar | 0 | 0 |

## Verificación

**Pruebas:**
- `batch-authorization.test.ts`: 16 escenarios.
- Suite completa en Windows: ver el resumen en `IMPLEMENTATION_HANDOFF.md`.

**Recorrido en Chromium** (instancia aislada, 500 historias): 40/40 comprobaciones. Cubre:
- volver a un lote interrumpido;
- valores seguros;
- 2, 12 (rango), 111 (filtro) y 500 historias, con el máximo;
- filtros que conservan la selección, quitar, ordenar y el tope;
- dependencias que faltan;
- sin permiso, sin orígenes y solo API;
- la frase de autorización;
- un lote nuevo sin herencia;
- teclado;
- 390 px y 1280 px;
- 0 llamadas de IA y ningún error de consola.

## Limitaciones conocidas

- **Sin validación con un modelo real ni con el Portal real:** todo es simulado, como se exigió.
- **Las estimaciones son orientativas:**
  - las llamadas son estructurales (pasos y correcciones autorizadas);
  - el USD de una evaluación Gauntlet se aproxima con el de una revisión de QA;
  - la duración necesita al menos 5 historias verificadas en el historial.
- **El tope de llamadas a la suscripción se comprueba al empezar cada historia;** una historia en marcha termina sus
  llamadas.
- **Reanudar no continúa las historias con trabajo en pausa:** solo re-encola las que no tenían trabajo que conservar.
  Las pausadas con trabajo se continúan desde su proceso.
- **No hay un campo de prioridad aparte:** la prioridad es el orden del backlog.
- **Cerrar el asistente pierde la selección.**
- **Pruebas inestables en el sandbox (preexistente, también en `main`).** En el sandbox Docker (2 CPU), cada ejecución
  completa de la suite del Portal falló una prueba distinta en 5 de 5 ejecuciones:
  - R y T;
  - I + J, dos veces;
  - iterar;
  - entrega incremental.

  En Windows pasan todas. I + J se corrigió (dependía del orden de integración); T y R ahora explican su fallo. Las
  demás quedan como riesgo: el Portal ejecuta esta suite para verificar cada historia de su propio proyecto, y un fallo
  aleatorio puede provocar correcciones innecesarias.
