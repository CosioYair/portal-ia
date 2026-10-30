# Portal IA · Asistente como interfaz de ejecución, encargos de desarrollo y Gauntlet automático

Fecha: 30 de octubre de 2026. Diseño, estándar de calidad, revisión independiente, medidas y límites:
`docs/asistente-encargos-y-gauntlet-adaptativo.md`. Todo con proveedor y CLI de Claude Code simulados, datos e
instancias temporales, **sin abrir `data/`, sin llamadas reales, sin reiniciar el Portal en marcha, sin integrar ni
publicar**.

**Rama `mejora/asistente-encargos`** sobre `mejora/lotes-autorizacion-seleccion` (`9ea0ce9`, conservada sin cambios;
`main` = `e9fcbbc`, sin cambios). Commits: tabla de la fase C del documento más `855db5f` (correcciones de la revisión
independiente, fase D) y la documentación.

**Verificación (última ejecución):** `npm run typecheck` y `npm run build`, exit 0. `npm test`: 429 pruebas, 419 en
verde, 3 omitidas por plataforma y **7 fallidas, todas con Docker real**, por Docker Desktop (abajo). Recorrido en
Chromium sin interfaz sobre una instancia aislada: 12/12 (escritorio y móvil). Dos revisiones independientes: la
primera encontró 13 defectos (corregidos con prueba, salvo el tope por reintento, documentado); la segunda confirmó
11 y encontró 5 más, entre ellos uno alto y previo (un agente podía leer `.env` por su nombre corto de Windows, `ENV~1`),
todos corregidos con prueba (detalle en la fase D del documento).

**Qué cambia para ti:**
- **Conversaciones** en el Asistente, cada una con su empresa y proyecto, que sobreviven a recargar y reiniciar.
  «Archivar» nunca borra.
- **Decisiones una a una**: el Asistente propone las preguntas (opciones, recomendación, riesgos); tú apruebas,
  aplazas, rechazas, revisas o reabres cada una.
- **Propuesta → revisión del equipo → historias**: cada paso es un encargo de análisis que autorizas con presupuesto;
  la propuesta la cuestiona otro especialista que no la redactó; las historias se crean solo con tu clic, sin
  duplicados y con dependencias.
- **Encargos de desarrollo `EN-n`** («arregla esto y déjalo listo para revisar»): sin crear historia, con el mismo
  pipeline (worktree y rama propios, Docker, QA, Gauntlet). Se autorizan con presupuesto de API y **tope de llamadas
  a la suscripción**; se aceptan con la misma regla de cierre que una historia o se piden cambios.
- **Cambios locales** pedidos por chat (crear o editar historias, reiniciarlas, crear empresa o proyecto): ahora son
  tarjetas que confirmas; antes se hacían al instante.
- **Gauntlet automático por defecto** (también en lotes, historia a historia), resuelto sin IA con su motivo; sigue
  solo con progreso estricto y con un tope duro.
- **Suscripción**: se guarda el último informe de límites de la CLI (de la cuenta). Con «límite» sin renovar o con
  uso adicional («overage»), no empieza trabajo nuevo hasta que se renueve o lo reconozcas.
- **Agentes**: `portal_search` y `portal_diff`, de solo lectura, en el puente MCP.

**Para activarlo** (requiere tu autorización): integrar las dos ramas en `main` (primero
`mejora/lotes-autorizacion-seleccion`), `npm run build` y reiniciar el Portal. Migraciones aditivas: tablas nuevas,
columnas `assignment_id` y `conversation_id`; los mensajes antiguos pasan una vez a «Historial anterior».

**Antes, en tu equipo:** Docker Desktop no monta carpetas de `C:` («input/output error») desde las 12:58. Reinícialo y
ejecuta `PORTAL_REQUIRE_DOCKER=1 npm test` en la rama: las 7 pruebas con Docker real deben pasar, y conviene confirmar en
el sandbox la corrección de las pruebas inestables (ver el documento).

**Prueba manual en tu Portal** (tras activarlo). Los pasos marcados con 💳 hacen UNA llamada real del Asistente (con
Claude Code, de tu suscripción); los marcados con 🔒 piden tu autorización con presupuesto y no se hacen solos:
1. Asistente → «+ Nueva», empresa «Portal IA», proyecto «Desarrollo del Portal». Recarga: la conversación sigue elegida.
2. 💳 «Quiero un modo oscuro, ayúdame a decidir cómo»: deben aparecer decisiones D1, D2… abiertas, con recomendación,
   y el panel en «Decisiones». Ninguna aprobada; el backlog no cambia.
3. Aprueba una, aplaza otra; recarga: siguen así, y el hilo muestra cada decisión con su autor.
4. «Preparar propuesta»: aparece una tarjeta «espera tu autorización» con pasos, agentes y estimación; «Siguiente» dice
   «Autoriza la propuesta». No la autorices si no quieres gastar. 🔒
5. 💳 «Arregla el texto X y déjalo listo para revisar»: aparece la tarjeta «EN-001» en borrador con objetivo, criterios,
   presupuesto, tope de llamadas y Gauntlet que se aplicará. No se ejecuta nada hasta «Autorizar y ejecutar». 🔒
6. 💳 «Añade una historia para …»: tarjeta «sin IA · requiere tu confirmación»; «Hacerlo» exige marcar la casilla.
7. «Archivar» en la barra: la conversación queda marcada 🗄 con «Reactivar»; al elegir otra deja de listarse salvo con
   «ver archivadas». Nada se borra (mensajes, decisiones y artefactos siguen ahí).
8. En el móvil (o con la ventana estrecha): «Menú» pliega la navegación y nada se superpone.

---

# Portal IA · Revisión Gauntlet de la ejecución continua (autorización por agente y selección escalable)

Fecha: 30 de octubre de 2026. Detalle (estándar, causa raíz, rondas, rendimiento y limitaciones):
`docs/ejecucion-continua-revision-gauntlet.md`. Todo con proveedor y CLI de Claude Code simulados, datos e instancias
temporales, **sin abrir `data/`, sin llamadas reales, sin reiniciar el Portal en marcha, sin integrar ni publicar**.

**Rama `mejora/lotes-autorizacion-seleccion`** (sobre `main` = `e9fcbbc`, sin publicar; `main` no cambió):

| Commit | Contenido |
|---|---|
| `37ab4db` | Autorización por agente: causa raíz del «claude-code — no autorizado», misma comprobación en la vista previa y al ejecutar, alternativa por API solo si el lote la autoriza |
| `c7b17b4` | Selección escalable y resumen persistente del lote |
| `3f3a853` | Pruebas T y R explican su fallo en el sandbox (la corrección de I + J quedó, por error de agrupación, en el commit siguiente) |
| `72e32b1` | Lo que la vista previa bloquea no se autoriza; perder un permiso pausa el lote una vez; cuántas caben con los límites; I + J sin depender del orden |
| `abe75fd` | Interfaz: cuántas caben, dependientes sin integrar, ordenar y filtrar por responsable |
| `2127631` | El origen autorizado se respeta en cada llamada; «caben» con duración máxima y concurrencia |
| `ff3bb62` | Aviso de duración y documentación de las rondas 5 y 6 |
| `9f4e5c1` | Tras la tercera revisión: solo el origen no autorizado pausa todo el lote (no la petición de permiso de una historia); «caben» sin falsos avisos con concurrencia |

**Verificación:**
- `npm run typecheck`: exit 0.
- `PORTAL_REQUIRE_DOCKER=1 npm test`: 414 pruebas, 412 superadas, 0 fallidas, 2 omitidas por plataforma.
- `npm run build`: exit 0.
- Recorrido en Chromium en una instancia aislada con 500 historias: 40/40.
- Tres revisiones independientes (máximo acordado):
  - la segunda confirmó en ejecución los 8 hallazgos corregidos de la primera;
  - la tercera, los 4 de la segunda, con el veredicto «listo, con detalles menores»;
  - sus 3 detalles se corrigieron después, verificados solo con pruebas.

**Para activarlo** (requiere tu autorización):
1. Integrar la rama en `main`.
2. `npm run build`.
3. Reiniciar el Portal.

No cambia el esquema: los lotes antiguos se leen igual. Un lote antiguo sin `apiFallback` queda sin alternativa por API,
que es lo más restrictivo.

**Prueba en tu Portal** (sin gastar: no autorices el lote):
1. Ejecución continua → Nuevo lote. Comprueba los valores por defecto:
   - Claude Code marcado y API sin marcar;
   - integrar, reiniciar y publicar desmarcados.
2. Marca HU-164 y HU-165. En «Equipo y orígenes», cada agente debe decir «Claude Code — Suscripción» y «sí», sin ningún
   «no autorizado». El resumen debe decir «Pueden empezar 2».
3. Filtra por tamaño o busca un texto, pulsa «Seleccionar las filtradas» y cambia los filtros: el contador conserva la
   selección y dice cuántas no se ven.
4. Revisa en el resumen:
   - llamadas y suscripción frente al tope;
   - USD de API;
   - «Hará sin preguntarte» y «Seguirá siendo decisión tuya».
5. Desmarca Claude Code: debe pedir un origen. Vuelve a marcarlo.
6. Cierra el asistente sin autorizar.

**Pendiente (preexistente, también en `main`):** en el sandbox Docker (2 CPU), la suite completa del Portal falla una
prueba distinta en cada ejecución (5 de 5). Propuesta: una historia para estabilizarla, porque el Portal la usa para
verificar sus propias historias.

---

# Portal IA · Gauntlet, ejecución continua del backlog, comunicación y aprendizaje

Fecha: 30 de octubre de 2026. Diseño, flujo y limitaciones: `docs/gauntlet-y-ejecucion-continua.md`. Todo con
proveedor y CLI simulados (0 USD), datos temporales y Docker real, **sin abrir `data/`, sin llamadas reales, sin
integrar ni publicar**.

**Commits sobre `main`** (sin publicar):

| Commit | Contenido | Esquema |
|---|---|---|
| `318e61a` | Telemetría de cada llamada (p50/p95, modelo frente a Portal) | 0.14 |
| `5e32c33` | Evaluador Gauntlet y etapa en el pipeline | — |
| `6b40667` | Ejecución continua del backlog | 0.15 |
| `34b9073` | Interfaz en español | — |
| `76b61b8` | Consultas en paralelo con presupuesto garantizado y contexto por secciones | — |
| `fe901b5` | Brechas del Evaluador en el ciclo de lecciones | — |

**Verificación** (clon limpio, `npm run typecheck`, `PORTAL_REQUIRE_DOCKER=1 npm test`, `npm run build`): exit 0 /
392 pruebas, 390 superadas, 0 fallidas, 2 omitidas por plataforma / exit 0. Recorrido en Chromium de las pantallas
nuevas en una instancia aislada: 18 de 18.

- **Pruebas por escenario:**
  - A–E, Q y R en `gauntlet.test.ts`;
  - F–Q en `batch-execution.test.ts`;
  - S y T en `performance.test.ts`.
- **Antes / después** (simulado; no prueba un modelo real): historia con 2 consultas de 4,9 s a 3,3 s, mismas 15
  llamadas y mismo resultado.
- **Activación:** no activo en el Portal en marcha. Hay que reconstruir y reiniciar con tu autorización; al arrancar,
  el esquema 0.15 copia `data/` antes de migrar.

**Prueba real controlada propuesta** (requiere tu autorización; consume la suscripción):
1. Reconstruir y reiniciar el Portal.
2. En Equipo, aprobar el Evaluador Gauntlet en un proyecto de bajo riesgo, con un modelo de nivel medio y el backend
   Claude Code.
3. Elegir 2–3 historias pequeñas (texto, interfaz o documentación), una de ellas dependiente de otra.
4. Crear un lote con estos límites:
   - concurrencia 1, Gauntlet `standard`, 2 correcciones;
   - tope de 30 llamadas a la suscripción;
   - 0 USD de API, sin alternativa por API;
   - integrar, activar y publicar **desactivados**.
5. Revisar cada historia en la pantalla de aceptación y comparar la telemetría (`/metrics/calls`) con la línea base.
6. Criterios de éxito:
   - 0 USD de API;
   - ninguna llamada repetida;
   - paradas correctas;
   - hallazgos del Evaluador con evidencia real y útiles a tu juicio.

---

# Portal IA v0.12.1 · Integración en Windows (Fases 0–2)

Fecha: 27 de octubre de 2026. Sobre la entrega v0.12.0 (abajo). Todo verificado en Windows 11 con Docker Desktop (motor WSL2), con datos temporales y proveedor simulado; **sin abrir `data/`, sin gastar créditos reales, sin publicar**.

- **Sandbox Docker en Windows** (`docs/sandbox.md`): imagen propia `portal-ia-sandbox:1` (`docker/sandbox.Dockerfile`: git + procps), dependencias Linux en un volumen por package-lock (`portal-ia-nm-<hash>`, install con red confirmada; el resto en solo lectura y sin red), entorno del CLI de Docker separado del contenedor, `--mount` para rutas `C:…` con espacios, `--pull never`, `--read-only`, `--init`, contenedor eliminado al agotar el tiempo. Pruebas: `sandbox-docker.test.ts` (orden sin Docker + aislamiento real).
- **E2E de automejora en Windows**: `node apps/server/test/e2e/self-improvement.e2e.mjs` → 45/45 pasos con Docker y Playwright/Chromium.
- **Iterar desde el feedback de la prueba** (Fase 2): acciones en «Pasos con falla», estados de la iteración anterior (`StoryContext.iteration`), reabrir, descarte confirmado del worktree, edición del contexto con historial, orientación «Enviar feedback al equipo» y «faltan dependencias del sandbox». Pruebas: `story-iteration-feedback.test.ts`, `story-iteration-ui-wiring.test.ts`; recorrido en navegador con Playwright sobre una instancia aislada.
- **Recorrido guiado y recuperación de errores**: una sola fuente de verdad, `services/storyFlow.ts` (servida en `guidance.flow`): 9 etapas con estados distintos, el problema actual clasificado (entorno / código / decisión) con diagnósticos (`services/diagnostics.ts`: TypeScript, pruebas, build, QA por gravedad) y las acciones que lo resuelven con las rutas existentes. Interfaz: `StoryFlowPanel` en el espacio de la historia y en el proceso. Docker sin dependencias (86) → «Instalar dependencias y repetir» (`POST /verify/install-and-retry`); tiempo agotado → problema del entorno; conflictos de merge guardados; iteración correctiva y chat reciben el error y los intentos anteriores. Pruebas: `story-flow-recovery.test.ts` (escenarios A, B, C, F por API) y Playwright A–F en una instancia aislada.
- **Etapas operativas y archivo** (inicio de operación organizada): Backlog → «Nueva etapa» (`/etapa`) muestra una vista previa (qué se archiva, qué se conserva, estado git, qué bloquea) y, con tu autorización, archiva de forma reversible todo el trabajo activo del proyecto (columnas `archived_at`/`archive_id` en `backlog_items` y `processes`; nada se borra), guarda en Conocimiento una línea base versionada (`docs/linea-base.md` + estado verificado leído en ese momento, sin IA) y registra la transición (`phase_transitions`). No toca git, agentes, lecciones, plantillas, conversaciones, presupuestos ni historial de uso. Lo archivado es de solo lectura (409 `archived` en cualquier acción) y se consulta en `/archivo`; una historia se restaura con autorización y la etapa vigente se puede revertir. Los ids de historia nunca se reutilizan y la síntesis de una etapa anterior ya no vuelve a llenar el backlog. Encargos, historias, chat de la historia y el asistente reciben la etapa y la línea base en su contexto. Servicio: `services/operationalPhase.ts`; rutas: `routes/phase.ts`. Pruebas: `phase-transition.test.ts` (incluye reinicio en otro proceso) y Playwright 23/23 sobre una instancia aislada.
- **Pipeline autónomo autorizado y contrato de salida** (regresión HU-155): la respuesta del Desarrollador se clasifica y se recupera sin IA (`services/devOutput.ts`: lector por líneas; acciones en español, marcadores de conflicto de git, cierres olvidados, diff unificado, archivos nuevos en bloques de código, JSON antiguo); si no basta y está autorizado, una reparación acotada del mismo Desarrollador con su respuesta anterior y el diagnóstico (sin repetir el plan). Con el pipeline incluido en la autorización (`PipelineConfig`: aplicar, comandos, instalar con red, límites de reparaciones/correcciones/fallos repetidos/duración), el equipo aplica en el worktree, verifica en el sandbox, resuelve el entorno sin IA, QA evalúa la evidencia con veredicto estructurado (`services/qaGate.ts`, salida estructurada nativa en los adaptadores) y corrige con diagnósticos, hasta «Implementación verificada por QA — lista para revisión del propietario». Pausas explicadas y «Continuar» (`POST /processes/:id/continue`) que retoma sin repetir. Fallos clasificados por causa real (`result.failure`). Pruebas: `autonomous-pipeline.test.ts` (A–G, con Docker real en C/D/E), `structured-output.test.ts`; Playwright 15/15 sin Docker (clasificación HU-155, reparación, autorización con pipeline, recuperación local, pausa por entorno).
- **Verificación final con Docker real** (28 de octubre): `PORTAL_REQUIRE_DOCKER=1 npm test` (las pruebas con Docker fallan en vez de omitirse); el `npm test` del Portal también pasa DENTRO del sandbox; e2e de automejora con el pipeline autónomo sobre el propio Portal (typecheck/test/build reales en Docker, QA con evidencia, error de `tsc` corregido solo, sin integrar); Playwright: recorrido A–F, iteraciones, pipeline con y sin Docker, etapas. Corregido durante la verificación: Docker Desktop podía no registrar el final de un contenedor (ahora el contenedor imprime su código y se retira si el motor se cuelga), una prueba sensible a los registros, la lista de actividad que ocultaba hitos y una comprobación repetida al reanudar.
- **Fallos de agentes y del proveedor (incidente HU-155)** — análisis y corrección en `docs/incidentes/HU-155.md`, sin abrir `data/` ni reanudar HU-155. Causa verificada: una explicación legítima sin archivos se clasificaba como «negativa» por frases sueltas («no puedo», «no tengo acceso») y toda no-implementación se «reparaba» como si fuera formato; la llamada no tenía cancelación real ni estado en vivo y un reinicio dejaba el proceso «en ejecución» para siempre. Ahora: 12 clases de fallo (`AgentFailureKind`) con recuperación por clase (solo la salida no válida o incompleta se repara; información → repositorio, especialista del equipo autorizado o pregunta al propietario con respuesta entregada una vez; permiso, capacidad y negativa del proveedor → se detiene y se pide); sección `BLOQUEO` en el contrato de salida; plazo por llamada (90 s–10 min, `PORTAL_PROVIDER_TIMEOUT_SEC` o `providerTimeoutSec`), cancelación con `AbortSignal`, reintentos acotados (`maxProviderRetries`, por defecto 2) solo para errores de conexión, estado en vivo por paso, costo no confirmado aparte y reservado del presupuesto (`services/providerCalls.ts`; también en la evaluación inicial y los encargos, donde antes una estimación se sumaba al gasto confirmado); recuperación tras reinicio sin reenviar nada (`services/interruptions.ts`); tarjeta de la llamada en curso, pregunta del equipo con respuesta y «Cancelando…» en la interfaz; lecciones detectadas (`agent_blocked`, `provider_refusal`, `provider_timeout`, `provider_unavailable`, `provider_credentials`), nunca validadas solas. Pruebas: `agent-failures.test.ts` (A–O, 22) y `autonomous-pipeline.test.ts` (M/N, Docker real); `PORTAL_REQUIRE_DOCKER=1 npm test` 178/180 (2 omitidas por plataforma: SIGTERM en Windows y `linux-ns` con Docker disponible); Playwright 36/36 (llamada en curso también a 390 px, cancelación en <0,1 s, pregunta y respuesta, permiso con el texto de HU-155, negativa, **reinicio real del Portal durante una reparación**) y la regresión del pipeline 15/15; e2e de automejora 53/53 (con Docker y Playwright; 3 ejecuciones en verde, ver abajo). Corregido de paso: el sondeo de la vista se detenía al continuar (estado congelado hasta recargar); la fila de acciones del proceso desbordaba a 390 px; la salida recortada del sandbox omitía la prueba que fallaba (ahora conserva los fallos del medio); la prueba de aislamiento Docker podía heredar un volumen de otra ejecución; la evaluación inicial y los encargos sumaban al gasto confirmado una estimación no confirmada y no se podían cancelar a mitad de llamada. Prueba inestable dentro del sandbox: 3 de las primeras 4 e2e fallaron por UNA prueba del Portal ejecutada en Docker; en la única ejecución con la salida completa fue «A2 · caso HU-155» (`autonomous-pipeline.test.ts`, anterior a esta entrega): la guarda de archivo desactualizado compara la fecha del commit (resolución de 1 s) con la del proceso y, con la base del repositorio sintético creada en el mismo segundo, un ajuste del reloj de la VM de Docker Desktop (medido: −0,3 a −0,4 s respecto al equipo, variable) puede dispararla. Hipótesis sobre el reloj; corrección determinista: base fechada en el pasado (solo pruebas). Las otras dos ejecuciones fallidas no conservaron el nombre de la prueba. Después: 2 e2e seguidas 53/53. El commit `836f23d` dice «3 de 4 e2e» de A2: solo una está confirmada. Riesgo latente: la línea base llega a los agentes con un tope de 16 000 caracteres (estado verificado + `docs/linea-base.md`); con una organización real más grande que la de las pruebas, el final del documento puede quedar fuera. «Limitaciones conocidas» pasa ahora antes de «Verificado y cómo».
- **Pantalla congelada durante una llamada real (HU-155, iteración 2)** — `docs/incidentes/HU-155.md` §7. Diagnóstico en vivo sin parar el Portal: el servidor y el proceso estaban sanos (continuaciones de una respuesta cortada, terminó y se pausó por presupuesto a las 21:29:44); se congeló la PESTAÑA: el renderizador Markdown entraba en un bucle infinito con un título con `\r` suelto o U+2028/2029 (reproducido con la interfaz anterior en una instancia aislada: pestaña sin respuesta, F5 falla, servidor sano). Corregido (`2a35185`, `dd48d3c`): Markdown que siempre avanza, salida parcial en texto plano, tiempos con la hora del servidor, aviso de conexión y sondeo que no se detiene, duración/uso previo de pasos en curso rotulados, vigilante de llamadas, continuación fallida sin perder el uso previo, registro del ciclo de vida, llamada pasada de plazo visible como problema. Pruebas: `live-progress.test.ts` (10), `npm test` 190/192 (2 omitidas por plataforma), Playwright 19/19 en un clon aislado; e2e de automejora 53/53. **No activo hasta reiniciar el Portal y reconstruir la interfaz** (ver §7).
- **Entrega incremental de historias (HU-155, iteración 3: 2 de 8 archivos, correcciones cortadas)** — `docs/incidentes/HU-155.md` §8. Causas verificadas con los metadatos (sin abrir `data/`): el razonamiento oculto de Opus 5.5 consumía la salida (`budget_tokens` retirado; respuestas al máximo exacto o vacías, todo facturado), una sola respuesta para toda la historia, la reparación pedía solo el archivo cortado, QA pagada para descubrir lo que faltaba, correcciones no dirigidas que consumían la cuota sin efecto y un contador que contaba 3 rechazos con una sola revisión; tarifa local de Opus 3,75 veces la pública. Ahora (`services/storyUnits.ts`): manifiesto de entregables y unidades acotadas (≈ 6 000 tokens de texto) aplicadas como puntos de control en el worktree; continuación por archivo cortado (contador propio, unión validada); salida agotada → se divide la unidad; comprobación determinista previa a QA; QA con el manifiesto real; correcciones dirigidas por archivo (solo parches; un archivo terminado no se regenera); una corrección sin cambios no consume la cuota y tras otra estrategia (consulta al especialista del equipo) se detiene; adaptador con razonamiento adaptativo, esfuerzo del agente y margen explícito; tarifas públicas por modelo; interfaz con entregables y tres niveles (compila / completa / QA aprobó); 7 detectores de lecciones nuevos. Dos revisiones de código (20 hallazgos) y seis prioridades del propietario (plan vacío o mal formado sin respuestas enormes, plan sin recortes silenciosos, evidencia de pruebas en cuatro estados —superada, fallida, no aplica, no determinada—, desacuerdos QA–Desarrollador con un solo intercambio, historia de 8 archivos con límites de salida reales y costo medido): corregidos, cada uno con una prueba que fallaba con el código anterior; riesgos que quedan en `docs/incidentes/HU-155.md` §8.1. Pruebas: `incremental-delivery.test.ts` 39/39 (R con Docker real, O con reinicio real en otro proceso); `PORTAL_REQUIRE_DOCKER=1 npm test` 229/231 (2 omitidas por plataforma); Playwright 13/13 en un clon aislado; e2e de automejora 53/53. **No activo hasta reiniciar el Portal y reconstruir la interfaz.** Los procesos ya terminados (HU-155) no se reprocesan.
- **Rescate de HU-155 (iteración 4, 9 de 9 correcciones agotadas)** — `docs/incidentes/HU-155-rescate.md`. Causa del último fallo: el catálogo de la historia usaba rutas y campos supuestos (`/api/inbox`, `…/stories`, `/api/usage/today` con `tokensIn/tokensOut/cost`, `…/assistant/conversations`…) y la prueba de declaraciones mostraba uno cada vez; la corrección 9 «resolvió» el Asistente declarando que no tiene GET (sí lo tiene: `/api/assistant`). No faltaba ningún endpoint salvo el alta HTTP en Conocimiento (criterio 5: decisión del propietario). Por qué falló 9 veces: el Desarrollador nunca vio `routes/*.ts`, cada ronda revelaba un elemento, «Continuar» vacía el contador de fallos repetidos y tres rondas se fueron en dos pruebas del Portal inestables en Docker (caché por fecha del proveedor simulado) que el equipo acabó modificando. Corrección externa preparada sin IA en la rama local `portal-ia/hu-155-rescate` (`5bee368`, avance rápido sobre `e06ba9e`; el worktree no se ha tocado): rutas y campos reales, prueba contra el registro real de Fastify que informa de todo a la vez, revertido el cambio fuera del plan (F7); sandbox Docker real 250 pruebas, 0 fallos. En el Portal: proveedor simulado sin caché; diagnóstico enfocado sin IA para corregir fallos del sandbox (`failureDiagnosis.ts`: prueba, mensaje, aserción, archivos citados, índice real de rutas con prefijos, historial del caso, tipo de fallo y progreso); «test» repetido una vez sin IA si solo fallan pruebas ajenas; pruebas existentes fuera del plan protegidas; SIN CAMBIOS con evidencia ante un fallo objetivo → decide el propietario; corrección externa autorizada (`POST /processes/:id/external-correction`: avance rápido, sin rutas protegidas ni cambios sin confirmar, registro de commit y archivos, verificación sin IA, pausa antes de QA, QA informada; sin pasos, tokens ni correcciones inventados) y guarda que detiene «Continuar» sin IA si el worktree tiene commits sin registrar. Pruebas: `correction-diagnosis.test.ts` (A–I) y `mock-provider.test.ts`, que fallan con el código anterior; `PORTAL_REQUIRE_DOCKER=1 npm test` 239/241 (2 omitidas por plataforma); Playwright 10/10 del registro en un clon aislado (también a 390 px); e2e de automejora 53/53. **No activo hasta reiniciar el Portal.**
- **HU-155, segunda ronda (decisiones del propietario)** — `docs/incidentes/HU-155-rescate.md` §7. Rama `portal-ia/hu-155-rescate` hasta `cbcac73`:
  - **Alta autorizada en Conocimiento** (`POST …/knowledge`): solo alta, `authorized: true`, esquema estricto, solo proyectos del espacio, sin secretos, idempotente por título.
  - **Commit activo dinámico**: HEAD de la CLI o `--commit`, y nada por activar.
  - **Estimación** demostrada sin IA y ejecutada.
  - **Plantillas** por su endpoint.
  - **reporta_a**: Falla prevista comprobada sobre el código.
  - **Contrato** con 112 citas verificadas por prueba; guía de QA e incidente alineados.

  Pruebas en Docker: typecheck, test y build en verde; 31 de 31 casos de HU-155 ejecutados. CLI real contra una instancia aislada: 14 de 14 (9 capturas con Chromium, publicación única, activación pendiente detectada, 0 llamadas a IA).

  En `main` (`0b8e417`): la evidencia de «pruebas nuevas ejecutadas» sobrevive al recorte de la salida del sandbox (antes abría correcciones pagadas en falso) y la verificación de una corrección externa repite una vez las pruebas ajenas inestables. `PORTAL_REQUIRE_DOCKER=1 npm test` 241/243 (2 omitidas por plataforma).
- **Conector «Claude Code — Local»** — `docs/conectores/claude-code-local.md`:
  - **Qué es:** backend de ejecución por agente (`api` · `claude-code` · `claude-code-terminal`) para los pasos de los procesos autorizados, integrado en `callAgentStep`. El agente, el flujo, el worktree, Docker y QA no cambian.
  - **Ejecución:** la CLI oficial en `claude -p` restringido: `--tools ""`, `--strict-mcp-config`, `dontAsk`, entorno mínimo sin credenciales y doble barrera de facturación (`auth status` y `apiKeySource`).
  - **Puente MCP:** `scripts/portal-mcp.mjs`, de solo lectura, con alcance por token y la consola del propietario como cola de tareas.
  - **Uso y fallos:** el uso con suscripción va aparte del gasto (0 USD de la API; el equivalente se muestra como estimación). Ante un límite, pausa `subscription_limit`; solo pasa a la API si el propietario la autorizó.
  - **Datos:** versión de esquema 0.13, aditiva, con copia de `data/` al arrancar.
  - **Pruebas:** `claude-code-connector.test.ts` (10) y `claude-code-execution.test.ts` (15, Docker real), con una CLI simulada. Instancia aislada con Chromium: 16 de 16.
  - **Falta:** la prueba de humo con la suscripción real, que requiere autorización. **No activo hasta reconstruir y reiniciar el Portal.**
- **HU-159, Asistente operativo y backends** — `docs/incidentes/HU-159.md`:
  - **Pruebas:** las canceladas no son fallos. La causa (`before` de la suite) va primero y completa en la evidencia, y se repite `test` sin IA si solo hay canceladas.
  - **Claude Code:** la puerta se comprueba antes de crear pasos. «Backends del equipo» es visible antes de empezar, y «Autorizar el proyecto o pasar a gestionado y continuar» retoma sin repetir lo hecho. Una consola desconectada no deja tareas esperando.
  - **Asistente:** catálogo cerrado de operaciones con tarjeta de autorización (`publish_main`, el mismo servicio que el Panel, con auditoría). Su backend es explícito, y ninguna llamada de agente pasa a la API sin autorización.
  - **Pruebas:** `assistant-operations.test.ts` (5), `test-cancellations.test.ts` (4) y casos nuevos en `claude-code-*` (F/G, D/E, H). `PORTAL_REQUIRE_DOCKER=1 npm test` 288/286 (2 omitidas por plataforma). Chromium 13/13 en una instancia aislada.
- **HU-159, bloqueo real tras activar** — `docs/incidentes/HU-159.md` §5:
  - **Causa:** junto a la acción de autorizar se ofrecía «Continuar cuando Claude Code esté disponible», que solo podía volver a pausar (80 eventos). La confirmación no nombraba el proyecto y no había comprobación previa. Proyecto e identificadores, correctos.
  - **Ahora:** «Autorizar la ejecución» y «Continuar» se rechazan sin eventos mientras falte algo. La historia dice el bloqueo exacto, con la tarjeta de Claude Code y enlace a la configuración; autorizar se comprueba con lo guardado antes de ofrecer «Continuar la operación pendiente».
  - **Datos:** sin correcciones nuevas; la corrección planificada con pruebas canceladas, y con bloques TAP recortados, se sustituye sin IA por una nueva verificación.
  - **Navegación:** Presupuestos accesible, enlace a «Claude Code — Local», aviso de interfaz desactualizada e historial sin repeticiones.
  - **Pruebas:** `settings-navigation-wiring.test.ts` (5) y casos nuevos en `claude-code-execution`, `incremental-delivery` y `test-cancellations`. `PORTAL_REQUIRE_DOCKER=1 npm test` 294/296 (2 omitidas por plataforma). Chromium 23/23 en una instancia aislada.
- **HU-159, iteración 3: turnos agotados e integración** — `docs/incidentes/HU-159.md` §6:
  - **Integración original:** fallaba por 2 conflictos reales en una rama nacida de una base vieja. Se informaron 11 y la historia se rehízo entera.
  - **«Corrección 2.2»:** ya estaba resuelta por la 2.1; Claude Code agotó sus turnos cuatro veces, clasificado como conexión.
  - **Fallo real:** `active-agents.test.ts` no cargaba.
  - **Ahora:** `CLAUDE_CODE_MAX_TURNS_EXHAUSTED` con reintento acotado y sin bucle; correcciones obsoletas sustituidas sin IA; pruebas que no cargan diagnosticadas; candidato de integración con el main actual (sin IA) y conflictos resueltos solo en sus secciones; integrar exige el candidato si main avanzó.
  - **Pruebas:** `integration-recovery.test.ts` (E–J) y casos A–D en `claude-code-execution`, `test-cancellations` e `incremental-delivery`. Chromium 17/17 en una instancia aislada.
- Pendiente de la validación del propietario en su instalación real: ver la lista de prueba final de la sesión.

---

# Portal IA v0.12.0 — Entrega de la implementación (Hitos 0–6)

Fecha: 27 de octubre de 2026. Base: tu `main` (`7627938` v0.11.2 + merge `cd84b69` de HU-147). Todo el trabajo está en commits sobre esa base en la copia adjunta (`portal-ia-v0.12.0.zip`, sin `node_modules`, `data`, `dist` ni `.git`). No se publicó nada en GitHub ni en ningún remoto; no se consumió ningún crédito de proveedor real; tus datos no se tocaron.

## 1 · Resumen por hito

| Hito | Estado | Qué hay |
|---|---|---|
| 0 · Base fiable | **Implementado y verificado** | Copia de seguridad automática de `data/` antes de la primera apertura con el esquema 0.12 (`data/backups/<fecha>_antes-de-0.12`, marca `.schema-version`); migraciones solo aditivas probadas sobre una copia **sintética** 0.11 (`migration.test.ts`). Proveedor simulado para pruebas (`PORTAL_MOCK_PROVIDER=1`, 0 USD). |
| 1 · Ejecución segura | **Implementado y verificado** (Docker/WSL2: pendiente de tu entorno) | Política de ejecución en backend (`executionPolicy.ts`): toda operación con efectos (worktree, sandbox, merge, push, reinicio, llamada a IA) pasa por `requirePolicy`, que exige autorización, herramienta del agente y ámbito, y lo audita en `execution_history` (`policy:*`). Worktrees aislados por proceso (`<repo>-worktrees/<proceso>`): el checkout del Portal nunca cambia de rama. Sandbox fail-closed: `docker` → `wsl` → `linux-ns` (Linux sin Docker: `unshare`, sin red, HOME/Portal/datos en solo lectura) → sin sandbox solo `tsc --noEmit`; el proyecto interno no se integra sin test y build en sandbox real, ni siquiera con «saltar verificación». |
| 2 · Automejora verificada | **Implementado y verificado de extremo a extremo** (con proveedor simulado) | Integrar ≠ activo: `activation` se calcula con `git merge-base --is-ancestor` del commit arrancado y del commit con el que se construyó la interfaz (`dist/build-info.json`); reconstrucción a `dist.next` con `dist.prev` conservado; reinicio por supervisor; `index.html` sin caché. Comprobaciones en ejecución (`=== COMPROBACIONES ===` del Desarrollador + 2 por defecto): HTTP contra el propio Portal y navegador (Playwright) con captura en `data/evidence/`. Orden de cierre 1–8 calculado en el servidor; cerrar exige activación + comprobación en verde + prueba manual; publicar es opcional. |
| 3 · Agentes especializados efectivos | **Implementado y verificado** | `capabilities` por agente; `teamComposer.ts` determinista (0 llamadas a IA) elige planificador, implementador (exige `write_repo`), revisor y hasta 2 consultores por coincidencia de vocabulario con la historia; motivos y exclusiones visibles; anulación manual (añadir/quitar) registrada; las consultas se ejecutan como pasos y llegan al prompt del implementador y de QA; métricas por agente desde `process_steps`; costo por paso real vs estimación. |
| 4 · Aprendizaje validado | **Implementado y verificado** | Detectores sin IA (parche que no encaja, archivo desactualizado, reemplazo masivo, módulo sin importar, QA no aprueba, verificación/activación/ejecución fallidas, historia devuelta, sin entrega) → lección `detected` con evidencia; «Proponer con IA» solo con autorización (1 llamada); validación/edición con versiones; inyección por proyecto y papel («Lecciones de esta organización») registrada en `process_steps.lessons_used`; reincidencia contada cuando el mismo detector salta con la lección presente. |
| 5 · Plantillas versionadas | **Implementado y verificado** | `agent_templates` por espacio (v1 = plantilla aprobada); promover una lección validada crea `clave@N+1` con diff legible; agentes nuevos (de plantilla o personalizados por capacidad) heredan la última; los existentes siguen en su versión hasta «Actualizar» (diff) y pueden «Volver»; historial por agente; prácticas inyectadas y trazadas como `practice:<clave@v>:<lección>`. |
| 6 · Espacio unificado de la historia | **Implementado y verificado** | `/historias/:id`: contexto, equipo con motivos, orden de cierre, diff/QA/aplicar/verificar/integrar (misma implementación que el proceso), prueba paso a paso **única** (OK/Falla/Observación + comentario; «OK» marca el paso probado), chat con los agentes implicados (autorizado por pregunta; propuestas de tareas/criterio/iteración aplicables), tareas (manuales, del equipo o desde los pasos con falla), iteraciones con contexto (feedback + tareas + conversación + nota) y cierre. El panel aparte de feedback se retiró. |

## 2 · Evidencia

### Pruebas automáticas (todas con proveedor simulado o sin IA)

`npm run typecheck` sin errores en los 4 paquetes; `npm run build --workspace apps/web` correcto.

`npm test --workspace apps/server`: **100 pruebas, 100 correctas, 0 omitidas** en este entorno Linux. En Windows, `sandbox-linux.test.ts` se omite sola (no hay `unshare`); también se omite cuando las pruebas ya corren dentro de un sandbox. Las mismas 100 pruebas pasan **dentro** del sandbox `linux-ns` (es lo que ejecuta «Verificar → test» sobre el propio Portal). Archivos nuevos o adaptados:

- `m1-m2.test.ts` — política (niveles, herramientas, ámbito, proceso en ejecución, presupuesto, auditoría), fail-closed, flujo API aplicar→verificar→integrar→comprobar→cerrar sin publicar, activación, parser de comprobaciones, comprobación HTTP que falla de verdad.
- `sandbox-linux.test.ts` — un `npm test` malicioso no escribe en el Portal, HOME ni datos, no sale a Internet; el worktree sí.
- `m3-team.test.ts` — A1 composición determinista (0 llamadas a IA; si omites QA, el revisor no reaparece como consultor), A2 participación real del especialista (su aportación llega al prompt; `process_steps` con modelo/tokens/costo), A3 permisos en backend (403 + auditoría).
- `m4-m5-learning.test.ts` — B1 detección objetiva (9 detectores, idempotente), B2 ciclo de validación (sin autorización 0 llamadas; versiones; ámbito), B3/B4 inyección medible (el simulado solo acierta si recibe L1: tasa de parches fallidos 1 → 0; `lessons_used`; reincidencia), C1/C2 plantillas (promoción, herencia, opt-in, vuelta atrás, práctica en el prompt).
- `m6-story.test.ts` — contexto, feedback↔marcas, chat autorizado con propuestas, tareas desde fallos, iteración con contexto, dos iteraciones no simultáneas.
- `migration.test.ts` — migración 0.11→0.12 sobre copia sintética: copia previa, columnas añadidas, filas intactas, segunda apertura sin copiar.
- `core.test.ts` adaptado a worktrees (el checkout no cambia de rama; sin commits se rechaza con mensaje; orden de cierre nuevo) y `manual-test-wiring.test.ts` (los 2 fallos que traía tu `main` quedan resueltos por la lista unificada).

### Prueba B · automejora verificada de extremo a extremo (`apps/server/test/e2e/self-improvement.e2e.mjs`)

Arranca una **copia** del Portal (clon de `main`) con `npm start` (supervisor) en un puerto libre, datos temporales, proveedor simulado y sandbox `linux-ns`, registra la carpeta de esa instalación como repositorio del proyecto interno y recorre: solicitud → equipo/estimación → autorización 1 USD → ejecución (patch real a `Backlog.tsx`, 3 pasos de prueba, 2 comprobaciones) → aplicar en worktree (checkout sigue en `main`, sin el cambio) → integrar bloqueado sin verificar (409) → typecheck/test/build en sandbox (exit 0) → integrar (`merge --no-ff`, worktree retirado) → «Integrada · NO activada», comprobar y cerrar bloqueados (409 `not_activated`) → «Reconstruir y reiniciar» (dist.next, reinicio por supervisor, `startedAt` nuevo, `startCommit = buildCommit = HEAD`) → «Activada» → comprobación en ejecución: HTTP ok y **el propio Portal abre `/backlog` con un navegador y encuentra el `h1` «(1 abiertas)»** (captura `data/evidence/<proceso>/check-3-ui.png`) → cerrar bloqueado sin prueba manual (409 `not_tested`) → prueba manual → «Listo para cerrar (activada y probada)» → cerrada **sin publicar** (`origin/main` sigue en el commit anterior) → sin lecciones falsas. Escenarios negativos, todos de extremo a extremo: **verificación fallida** (typecheck roto: integrar 409 `verification_failed`, también con «saltar verificación»; lección `verification_failed`; rechazar descarta worktree y rama); **activación fallida** (build roto: `dist` anterior intacta, el Portal sigue respondiendo con el mismo `startedAt`, lección `activation_failed`); **parche que no encaja** (proceso «failed» con motivo, nada escrito, lección `patch_mismatch`); **fallo en ejecución** (una historia que compila, pasa typecheck/test/build en sandbox, se integra y se activa, pero el Portal abre `/backlog` en el navegador y encuentra «(3 abiertas)» en lugar de lo prometido: comprobación `ui` en rojo con captura, fase «comprobación en ejecución FALLÓ», y **cerrar devuelve 409 `not_runtime_verified` aunque los 3 pasos de la prueba manual estén marcados**; lección `runtime_failed`). Resultado: **43/43 pasos correctos en ~2,5 min, 9 llamadas al proveedor simulado, 0 a uno real**. Resultados y capturas: `portal-ia-v0.12.0-evidencia-e2e.zip` (`results.json` + 13 capturas, incluidas las de las pantallas nuevas). Se regeneran con el mismo comando.

**Proveedor real: NO se ejecutó** (sin autorización de gasto ni clave). Todo lo anterior es con proveedor simulado; nada de este documento afirma verificación con proveedor real.

### Pruebas A–E del encargo

| | Resultado | Dónde |
|---|---|---|
| A · Creación de agente y participación | Simulado ✔ (creación por formulario con capacidades; entra en una historia relevante como consultor; su aportación llega al implementador; métricas) | `m3-team.test.ts`, pantalla Equipo → agente (Capacidades y participación) |
| B · Automejora verificada (+ verificación/activación/ejecución fallidas) | Simulado ✔ 43/43 en una copia real del Portal arrancada con el supervisor y sandbox `linux-ns`; los tres fallos, de extremo a extremo | `self-improvement.e2e.mjs`, `m1-m2.test.ts` |
| C · Aprendizaje validado y medible | Simulado ✔ (patch_fail_rate 1 → 0 con L1; reincidencia) | `m4-m5-learning.test.ts` |
| D · Transferencia a agentes nuevos | Simulado ✔ (pj-dev@2; herencia; opt-in/vuelta atrás; práctica en el prompt) | `m4-m5-learning.test.ts` C1/C2 |
| E · Preservación y seguridad | ✔ (migración sintética; política; fail-closed; aislamiento `linux-ns`; cierre bloqueado; rechazo seguro) | `migration.test.ts`, `m1-m2.test.ts`, `sandbox-linux.test.ts`, `m3-team.test.ts` A3 |

## 3 · Cómo instalar y ejecutar (Windows)

Ver `docs/instalacion-windows.md` (instalar sobre tu carpeta, `npm install`, `npm run build`, `npm start`; parar con Ctrl+C; reiniciar desde la barra del sistema). Sandbox: `docs/sandbox.md` (Docker Desktop recomendado; WSL2 alternativa). Migración: automática con copia previa en `data/backups`.

Comandos de verificación tras instalar: `npm run typecheck`, `npm test`, y opcionalmente `node apps/server/test/e2e/self-improvement.e2e.mjs` (requiere sandbox; con Docker Desktop en Windows debería funcionar igual que aquí con `linux-ns`; Playwright opcional: sin él, las comprobaciones `ui` quedan «pendientes» y la historia no se da por verificada).

## 4 · Primera automejora real desde dentro del Portal

Pasos exactos en `docs/instalacion-windows.md` §«Primera automejora real». Resumen: Panel → Repositorio = carpeta de esta instalación y sandbox `docker`/`wsl`; Backlog → nueva solicitud pequeña y observable (p. ej. el contador en el título de Backlog) → Ejecutar (equipo y estimación; autoriza 1 USD) → Espacio de la historia → Aplicar → Verificar (typecheck, test, build) → Integrar → barra «Reconstruir y reiniciar» → Comprobar en ejecución → prueba paso a paso → Cerrar. Costo esperado con Anthropic (Sonnet para QA/Dev, Opus para el Coordinador según tus agentes): 0,3–1,2 USD; se registra el costo real por paso.

## 5 · Qué queda pendiente de tu entorno o bloqueado

- **Docker Desktop / WSL2 en tu Windows**: no verificable desde aquí. Hasta que uno exista, el Portal te lo dirá en la tarjeta Repositorio y en Verificación; `test`/`build` quedarán «no disponible» y el proyecto interno no se integrará (fail-closed, por diseño).
- **Proveedor real**: ninguna prueba se hizo con Anthropic/OpenAI. La primera automejora real la haces tú con tu clave y presupuesto.
- **Playwright en tu equipo**: `npm i -D playwright && npx playwright install chromium` para que «Comprobar en ejecución» incluya la comprobación de navegador; sin él las `ui` quedan pendientes (no bloquea las HTTP, pero sí el cierre si hay comprobaciones `ui` definidas).
- **`npm test` del propio Portal dentro del sandbox** tarda ~20 s en Linux; en Docker Desktop dependerá del disco compartido.
- Hallazgos corregidos durante la verificación final: (1) el detector de «módulo sin importar» habría marcado como huérfano cualquier módulo nuevo en el repositorio del Portal porque `git grep` fallaba con una ruta inexistente (`src/`); ahora solo usa rutas que existen y, si git no puede comprobar, no detecta nada; (2) la prueba de migración importaba rutas absolutas que en Windows no son válidas para ESM; ahora usa `file://`; (3) si omites QA al ejecutar, el revisor ya no entra como consultor.
- Actualización simulada sobre una copia de **tu** árbol subido (en `main` = `7627938`, sin tu carpeta `data`, que retiré de la copia antes de nada para no abrirla ni migrarla): descomprimir encima → typecheck limpio, 100/100 pruebas, build correcto, con y sin los tres archivos sobrantes del panel anterior.
- Hallazgo durante las pruebas: `.gitignore` tenía `node_modules/` (solo carpetas); un `node_modules` que sea **enlace simbólico** no quedaba ignorado y un `git add -A` lo habría incluido en un commit. Corregido a `node_modules`. Con tu instalación normal (carpeta real) no te afectaba.
- La API de prueba manual permite marcar pasos antes de que la comprobación en ejecución esté en verde (la interfaz no lo permite); la regla de cierre lo bloquea igualmente (`not_runtime_verified`), como demuestra la e2e.
- Limitaciones conocidas: el compositor de equipos usa coincidencia léxica (sin IA) y puede no elegir a un especialista cuando la historia no nombra su área (puedes añadirlo manualmente al ejecutar); el detector de «módulo sin importar» usa `git grep` (solo archivos rastreados); el chat de la historia responde un agente por pregunta (el Coordinador por defecto o el que elijas), no todo el equipo a la vez; la activación se evalúa solo para el proyecto interno con la carpeta de esta instalación.

## 6 · Commits (sobre tu `main`)

`4f37942` M0–M2 servidor · `e11d09a` M1/M2 interfaz y docs · `7419e78` M3 · `101f326` M4/M5 servidor · `75ef5c8` M4/M5 interfaz · `3fbc5ae` M6 · `ff4bcfe` sandbox linux-ns · `402f2f2` loopback en sandbox · `f9fe6bf` rechazo seguro + e2e · `aac48dc` sandbox marcas/salida · `1b8fb64` orden de cierre de 8 pasos · `f420359` v0.12.0 (handoff, docs, migración, orientación de historias cerradas) · `ebb8e0b` QA omitida no reaparece; e2e de fallo en ejecución · `5916ae4` capturas en la e2e · `f280f7c` pasos de actualización · `8703987` detector sin falsos positivos y prueba de migración portable.

Estos commits están en la copia de trabajo de esta sesión, **no** en tu repositorio ni en GitHub. Al descomprimir el zip sobre tu carpeta y hacer `git add -A && git commit`, quedarán como un único commit tuyo; si prefieres conservar la historia por hitos, te puedo entregar los parches (`git format-patch`) para aplicarlos con `git am`.

## 7 · Próximos pasos sugeridos

1. Instalar Docker Desktop, arrancar, confirmar sandbox `docker` en el Panel.
2. Ejecutar la primera automejora real (§4) con 1 USD; revisar costos reales por paso en el proceso.
3. Validar la primera lección que aparezca en Conocimiento → Lecciones y promoverla a práctica; comprobar en Equipo → Desarrollador el diff y actualizarlo.
4. Crear un agente especializado con capacidad `consultar` para tu área (p. ej. accesibilidad) y ver cómo entra en la siguiente historia que la mencione.
5. Cuando Docker esté, ejecutar `node apps/server/test/e2e/self-improvement.e2e.mjs` en tu equipo como prueba de regresión antes de cada actualización.
