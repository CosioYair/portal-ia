# Autonomía con la suscripción, ejecución del Asistente y estado persistente

Encargo del propietario tras la primera prueba real (octubre de 2026): un lote con HU-164 y HU-165, solo con la
suscripción de Claude Code, Gauntlet profundo, dos a la vez y ≈ 1000 llamadas autorizadas, se detuvo tras el plan por un
«presupuesto» en USD que nadie había autorizado gastar (0,00 USD de API reales); el Asistente convirtió una orden directa
(«arréglalo, aplica Gauntlet y publica main») en historias o propuesta y dio el trabajo por terminado; un especialista
agotó sus turnos buscando; y la interfaz pierde lo escrito al recargar.

## Ronda 0 · Estándar de calidad (antes de implementar)

Cada criterio es comprobable de forma independiente, con una prueba automática o una comprobación en el navegador.

| # | Criterio | Cómo se comprueba |
|---|---|---|
| Q1 | **Suscripción ≠ USD.** Una llamada que se ejecuta con Claude Code (suscripción) nunca se bloquea por un presupuesto en USD; solo por el tope de llamadas a la suscripción y el estado de la suscripción. Una llamada por la API sigue limitada por los USD autorizados y se pausa ANTES de hacerla, diciendo por qué | Lote simulado de 2 historias con todo el equipo en Claude Code gestionado, API 0 USD: termina (plan, unidades, verificación en Docker, QA, Gauntlet) con 0 USD de API y llamadas ≤ tope. Equipo mixto: solo las llamadas por la API descuentan USD; sin USD suficientes, pausa antes de la llamada afectada |
| Q2 | **Estimaciones informativas.** Una estimación en USD para un trabajo que irá por la suscripción se muestra como orientativa (equivalente API) y no detiene nada | La misma prueba Q1: ninguna pausa de tipo «presupuesto» |
| Q3 | **Sin cambios de origen en silencio.** Cada paso usa el origen de su agente; si un agente necesita la API y el lote no la autoriza, se explica y se pide | Pruebas de origen por paso y de alternativa desactivada |
| Q4 | **Estados del lote verdaderos.** El lote distingue: en marcha, espera tu decisión, espera al entorno, pausado por la suscripción, fallido, verificado técnicamente, listo para tu aceptación y terminado. Un lote no se presenta como «terminado» (ni «lo automático terminó») mientras haya historias en pausa que pueden seguir | Prueba: con una historia en pausa por la suscripción y otra independiente, la independiente sigue; el texto del lote no dice «terminó» |
| Q5 | **Solo pausas reales.** Una historia de un lote solo se detiene por un límite autorizado (llamadas, USD de la API, tiempo), un fallo que necesita decisión o el entorno | Q1 + prueba de pausa por tope de llamadas |
| Q6 | **Intención del Asistente.** Una orden directa de corregir o implementar («arregla…», «corrige…», «encárgate de…», «fix…») se prepara como **encargo** (EN-n) con su autorización; nunca como historia del backlog ni como análisis, salvo que el propietario pida historias o un análisis. Crear historias exige autorización explícita | Pruebas del Asistente con el proveedor simulado: la instrucción del sistema, el contrato de acciones y el resultado (encargo propuesto, ninguna historia creada, ningún proceso iniciado) |
| Q7 | **Operaciones git tipadas.** «publica main» solo prepara la operación tipada existente, que pide confirmación; nunca se ejecuta por aparecer en el chat | Prueba: el texto del chat no publica nada sin la confirmación |
| Q8 | **Mensajes de estado verdaderos.** Ningún mensaje dice que un cambio de código está hecho, integrado, activado o publicado si solo hubo análisis, propuesta o historias. Cada tarjeta dice en qué punto real está | Prueba: un análisis terminado no se describe como cambio de código; el texto distingue análisis, propuesta, historias, implementación, verificación, QA, Gauntlet, integración, activación y publicación |
| Q9 | **Especialistas eficientes.** Una consulta recibe un paquete de evidencia (archivos y fragmentos ya conocidos por el plan), un presupuesto de herramientas explícito y la regla de responder antes de agotar los turnos. Si aun así los agota, se recupera UNA vez sin herramientas con lo que ya leyó; no se repite a ciegas ni se clasifica como error de conexión | Prueba con la CLI simulada: búsquedas sin respuesta → diagnóstico «turnos agotados», una recuperación sin herramientas, llamadas contadas |
| Q10 | **El Asistente conoce el Portal.** Recibe una descripción compacta y versionada de lo que el Portal hace hoy (Gauntlet adaptativo, revisión del plan, correcciones por progreso, diagnóstico, encargos, lotes, suscripción) | Prueba: la instrucción del sistema la contiene, con su versión, y no crece sin límite |
| Q11 | **Borradores persistentes.** Formularios a medio rellenar (lote, búsqueda y filtros, orden, límites, Gauntlet, mensaje del Asistente, encargo, historia, propuesta, respuestas a decisiones, configuración) sobreviven a recargar, navegar, reiniciar el navegador y reiniciar el servidor | Navegador: recargar, ir y volver, contexto nuevo del navegador, reinicio del servidor aislado |
| Q12 | **Navegación persistente.** Empresa y proyecto, pantalla, pestaña o sección, elemento seleccionado, filtros y conversación activa se restauran; un enlace directo y Atrás/Adelante mandan sobre lo guardado | Navegador: recargar en una pestaña, enlace directo con otro estado guardado, Atrás/Adelante |
| Q13 | **Guardado ≠ autorización.** Restaurar un borrador nunca marca una casilla de autorización ni ejecuta nada; las autorizaciones concedidas siguen siendo inmutables y auditables | Navegador y pruebas: el borrador restaurado deja la casilla «Autorizo…» sin marcar y el botón desactivado |
| Q14 | **Aislamiento y seguridad.** Los borradores se guardan por empresa y proyecto; cambiar de empresa no muestra los de otra; nada secreto se guarda en el navegador; un borrador antiguo no pisa datos más nuevos | Prueba: claves por empresa/proyecto; credenciales excluidas; versión del dato en los borradores de edición |
| Q15 | **Reinicio.** Un lote en pausa o en marcha sobrevive a un reinicio sin repetir lo terminado | Prueba de reinicio del lote |
| Q16 | **Rendimiento.** Ninguna llamada a modelos extra por estos cambios (salvo la recuperación única de Q9); guardar borradores no hace peticiones al servidor por cada tecla | Recuento de llamadas simuladas antes/después; el guardado local no hace peticiones |
| Q17 | **Sin regresiones.** typecheck, pruebas (con Docker obligatorio, dentro del sandbox incluidas), build y navegador en verde | Ejecuciones completas |


## Ronda 1 · Diagnóstico independiente

Cuatro evaluadores con contexto nuevo (lote y suscripción, Asistente, especialistas, interfaz) reprodujeron cada fallo
con una prueba que fallaba ANTES de corregir nada (proveedor y CLI simulados, datos temporales, nunca `data/` real).

| Fallo | Causa raíz | Prueba que lo reproducía |
|---|---|---|
| A · el lote solo por suscripción se pausó por USD | Antes de implementar, `startIncremental` comparaba el coste de TODAS las unidades a precio de API con los USD restantes (0,10 por historia, el mínimo que forzaba el lote), aunque todas iban por Claude Code; lo mismo en la reserva del lote, la vista previa, la política `ai_call` y los análisis | `subscription-budget.test.ts` |
| B · «Lo automático terminó» con historias en pausa | `maybeComplete` cerraba el lote si nada estaba en cola o en marcha, sin mirar las pausas reanudables; el tope de llamadas era un fallo, no una pausa | `subscription-budget.test.ts`, `batch-execution.test.ts` |
| C · una orden directa acabó en historias o propuesta | La instrucción del Asistente decía «implementar/corregir → historia» y que toda mejora del Portal pasa por historias; «encargo» nombraba también los análisis | `assistant-intent-diagnosis.test.ts` |
| D · mensajes de terminado falsos | Las tarjetas pasaban a «hecho» al autorizar o al dejar de ser borrador; el historial que recibe el modelo no tenía el estado real ni los encargos EN-n | `assistant-intent-diagnosis.test.ts` |
| E · 8 turnos agotados buscando | La consulta no recibía los archivos que el plan ya conocía, no sabía cuántos turnos tenía, `portal_search` devolvía hasta 200 líneas sin orden y la consulta corría fuera del contexto de pausa (la historia fallaba entera) | `consult-max-turns.test.ts` (CLI simulada) |
| F · el Asistente no conocía el Gauntlet | Ninguna descripción de las capacidades actuales en su instrucción | `assistant-intent-diagnosis.test.ts` |
| Persistencia | Todo el estado de los formularios vivía en `useState`; además, la carga inicial pisaba el enlace directo con la selección guardada y la edición de una historia podía guardarse en otra al cambiar de historia sin desmontar | sonda en Chromium + `ui-persistence-wiring.test.ts` |

## Ronda 2 · Implementación

Cuatro commits, cada árbol verificado antes de confirmarlo (typecheck, suite completa con Docker obligatorio y build):

- `62133de` Interfaz: un solo mecanismo (`apps/web/src/lib/persist.ts`) para preferencias y borradores, por empresa y
  proyecto, con caducidad de 30 días y estado visible; navegación y desplazamiento restaurados.
- `ab11296` Asistente: tabla de enrutado (orden directa → encargo EN-n; historias solo si se piden; análisis solo para
  estudiar; publicar solo como tarjeta tipada), estados reales y `portal-capabilities@1`.
- `ef4247b` Especialistas: paquete de evidencia, reglas de turnos y herramientas, UNA recuperación sin herramientas,
  pausa «turnos agotados» en lugar de fallo, uso de ambas ejecuciones contado.
- `f529a8d` Suscripción ≠ USD: solo las llamadas por la API consumen y comprueban USD; pausa propia por tope de
  llamadas (`call_cap`) reanudable; el lote dice su estado real; 0 USD de API válido si todo el equipo va por la
  suscripción.

## Ronda 3 · Cuestionamiento independiente

Tres evaluadores con contexto nuevo intentaron romper lo implementado (sondas propias, Chromium y el escenario real de
la suscripción con Docker). Hallazgos materiales y su corrección (`3302a75` servidor, `9ccb95b` interfaz):

| # | Hallazgo | Corrección |
|---|---|---|
| B1 | Tras una pausa por USD, «Reanudar» concedía otro tope por historia aunque el lote no tuviera saldo: se podía superar el total autorizado | Solo se concede si cabe en lo que queda del lote (lo no gastado del proceso + lo nuevo); si no, espera al propietario con la cifra |
| B2 | Con la API como origen, un presupuesto < 0,10 USD se aceptaba en silencio | 400 `budget_required` con la explicación (con 0 USD, quitar la API) |
| B3 | Reanudar una historia detenida antes de implementar volvía a pedir (y pagar) el plan | El plan pasa a la nueva ejecución (`carriedPlan`); su revisión sí se hace |
| B4 | Una pausa por el límite de la suscripción no se retomaba con «Reanudar» | `subscription_limit` es reanudable; si el límite sigue, la llamada lo comprueba y se pausa otra vez |
| A1 | «…y publica main» en la misma respuesta que un encargo nuevo prepararía la publicación del main actual, SIN el encargo | No se prepara: aviso de que se propondrá cuando el encargo esté integrado |
| A2 | Autorizar una tarjeta de publicar después de que main recibiera otros commits publicaba lo que la tarjeta no mostraba | La vista previa lleva el commit exacto; si cambió, 409 y no se ejecuta nada |
| A3 | El historial describía cada decisión como «abierta» aunque ya estuviera resuelta; la instantánea mostraba los encargos más ANTIGUOS | Estado real de cada decisión; los más recientes |
| S1 | Si la recuperación alcanzaba el tope de llamadas, el uso de la ejecución que agotó turnos no se registraba | Se suma al paso y al proceso |
| S2 | El paquete de evidencia podía enviar al modelo un archivo con un posible secreto (el puente ya lo bloqueaba) | Se omite con la misma comprobación (`scanSecrets`) |
| S3 | Un tope de llamadas o límite de la suscripción durante una consulta hacía fallar la historia | Pausa reanudable, como los turnos agotados |
| U1 | El borrador guardaba la versión del dato del momento de GUARDAR: si la historia cambiaba en el servidor mientras se editaba, el borrador «parecía» actual y guardar pisaba el cambio | La versión se fija al EMPEZAR; al guardar se envían solo los campos cambiados por el propietario; si otro cambió el mismo campo, aviso con su valor y segundo «Guardar» |
| U2 | El texto que otra pantalla propone al Asistente («Solicitar evaluación») se perdía al cargar una conversación existente | Se aplica cuando ya se sabe la conversación |
| U3 | Atrás/Adelante mostraban la pantalla anterior con la empresa de la última | Cada entrada del historial recuerda su empresa y proyecto (también entre páginas y al recargar) |
| U4 | El aviso de opciones con permisos recuperadas desaparecía al tocar cualquier otra cosa, con ellas aún marcadas | Sigue mientras estén marcadas |
| U5 | Un formulario recuperado (reintentar, iterar) podía abrirse cuando la acción ya no era posible; «Aceptar» un encargo enviaba el texto de «pedir cambios» como nota de aceptación | Solo se abre si sigue siendo posible; «Aceptar» no envía nota |
| U6 | Los cambios sin guardar de un agente y el documento abierto de Conocimiento se perdían al recargar | Borrador del agente (solo los campos cambiados, sobre la versión actual) y `?doc=` en la URL |

Nuevas pruebas: `r3-lote-reanudar-presupuesto.test.ts`, `r3-asistente-sondas.test.ts`,
`r3-especialistas-sondas.test.ts` y los casos de ronda 3 de `ui-persistence-wiring.test.ts`; la prueba M de
`batch-execution.test.ts` modela ahora un límite de la suscripción que se renueva.

## Ronda 4 · Segundo cuestionamiento

Un evaluador con contexto nuevo atacó las correcciones de la ronda 3 (`3302a75`, `9ccb95b`) con sondas propias; además,
al revisar su hallazgo R4-7 apareció uno más grave (R4-0). Todo corregido, cada uno con una prueba que falla sobre
`9ccb95b`:

| # | Gravedad | Hallazgo | Corrección |
|---|---|---|---|
| R4-0 | **alta** | «Reanudar» exigía USD a una historia SOLO de suscripción si la versión anterior la había pausado por «presupuesto»: justo el lote real (HU-164/HU-165) habría quedado otra vez esperando «0,20 USD de API» | Al seguir, solo una historia que puede gastar API reserva USD (la misma regla que al empezar); prueba «R4 · lote heredado SOLO suscripción…» |
| R4-1 | media | El plan reutilizado al reanudar ignoraba una edición de la historia hecha durante la pausa | El plan guarda la huella de la historia y del contexto de iteración (`planBasis`); solo se reutiliza si no cambió |
| R4-2 | media-baja | Dos «Autorizar» simultáneos de la misma tarjeta (dos pestañas) publicaban dos veces (la comprobación nueva esperaba antes de marcarla en marcha) | Se marca en marcha antes de cualquier espera |
| R4-3 | media-baja | «Publicar main» aplazado se mostraba al modelo como «hecho» y prometía una propuesta automática que no existe | El modelo ve el aviso tal cual; el texto dice que se prepara cuando lo pidas tras integrar el encargo, no sola |
| R4-4 | baja | Un archivo omitido por posible credencial no decía cómo modificarlo (riesgo de reescribirlo entero sin verlo) | La misma indicación que los omitidos por tamaño: no reescribirlo entero, parches o un módulo nuevo |
| R4-5 | baja | En la configuración de un agente, volver un campo a su valor anterior tras un cambio en el servidor no se guardaba | El borrador guarda solo los campos que tocaste |
| R4-6 | baja | La primera entrada de una pestaña (abrir /panel directamente) no recordaba su empresa | Recibe una clave al cargar |
| R4-7 | baja | Al seguir tras una pausa que no era por USD no se comprobaba el saldo del lote | Incluido en R4-0: la comprobación vale para toda historia que puede gastar API |

Comprobado como correcto por el evaluador: las cuentas del saldo del lote, que `subscription_limit` no se repite solo,
el mínimo de 0,10 USD, la mecánica del plan reutilizado, el registro del uso en el tope, la huella de la tarjeta, la
versión de los borradores, el aviso de choque al editar, el historial por empresa, el texto propuesto al Asistente y
los formularios recuperados del lote.

Antes de activar se comprobó también el lote real que quedó «en marcha» con las dos historias esperando: al arrancar
la versión nueva no se empieza ni se retoma nada (prueba «activación sobre un lote heredado» en
`batch-execution.test.ts`); pasa a «En pausa» con «Reanudar».

## Ronda 5 · Tercer cuestionamiento (solo lo cambiado en la ronda 4)

| # | Gravedad | Hallazgo | Corrección |
|---|---|---|---|
| R5-1 | media | Al volver a empezar una iteración detenida antes de implementar, el proceso nuevo perdía la nota del propietario (contexto de iteración) y, con la huella de la ronda 4, volvía a pagar el plan sin la nota | El proceso nuevo conserva el contexto de iteración y el plan de la iteración se reutiliza (prueba `r5-plan-iteracion`) |
| R5-2 | baja | El modelo veía el aviso de «publicar main» aplazado cortado a 220 caracteres (se perdía «no se propone sola») | Hasta 400 caracteres |
| R5-3 | baja | Una operación autorizada queda «Ejecutando…» si el Portal se cae justo en la comprobación previa (ya pasaba durante la ejecución) | No corregido: ver «Limitaciones» |
| R5-4 | baja | En un agente, un campo cambiado y devuelto a su valor seguía siendo «tuyo» y podía pisar un cambio posterior del servidor | Un campo igual al del servidor deja de ser tuyo |

Comprobado como correcto: el cálculo de `prep.api` al reanudar coincide con el de empezar (y con la ejecución), la
comprobación del saldo, la huella del plan tras la revisión y el replan compacto, la doble autorización (síncrona, 409)
y la clave de la primera entrada del historial con react-router 7.

## Verificación

- Suite completa con Docker obligatorio (`PORTAL_REQUIRE_DOCKER=1`) en un árbol exportado de cada commit; en el último:
  501 pruebas, 499 superadas, 0 fallos, 2 omitidas por plataforma (SIGTERM y espacios de nombres de Linux en Windows).
  Dentro del sandbox de Docker (dos ejecuciones): 0 fallos; se omiten las 12 que necesitan Docker o un `/tmp` ejecutable,
  que el sandbox no tiene a propósito.
- Navegador (Chromium sin interfaz, Portal aislado, proveedor simulado, interfaz construida en el commit final):
  persistencia 42/42 (recargar, ir y volver, reiniciar el navegador con perfil persistente y reiniciar el servidor),
  lotes 40/40, Asistente 12/12, controles del encargo y del plan 26/26, asistente del lote 18/18.
- Escenario real de la suscripción (`e2e-subscription`, Docker real, CLI de Claude Code simulada): lote de 2 historias,
  0 USD de API, Gauntlet profundo, concurrencia 2 → ambas verificadas en Docker, QA y Gauntlet aprobados, 0 llamadas a
  la API; con un tope de 2 llamadas, pausa `call_cap` (no USD, no «terminó»), un reinicio del servidor no retoma nada
  solo y «Reanudar» con más llamadas termina sin volver a pedir el plan. 19/19.
- Tamaño del prompt del Asistente (500 historias, dos empresas): 19 705 → 20 512 caracteres (+4,1 %), por
  `portal-capabilities@1`. Ninguna llamada a modelos extra salvo la recuperación única de un especialista.

## Comportamiento resultante

**Suscripción y USD.** Una llamada por Claude Code solo la limitan el tope de llamadas autorizado y el estado de la
suscripción; las cifras en USD de ese trabajo son «equivalente API», orientativas. Una llamada por la API sigue
comprobando sus USD antes de hacerse (con el historial reenviado y cada reintento). Un lote o encargo acepta 0 USD de
API si todo su equipo va por la suscripción; si algún agente usa la API, dice cuál y pide presupuesto.

**Lote.** Estados: en marcha, en pausa (tope de llamadas, suscripción, entorno, USD de la API, duración), espera tu
decisión, verificada técnicamente / pendiente de integrar, lista para tu aceptación, terminada. Nunca dice «terminó»
con algo que puede seguir. «Reanudar» (autorizado, con límites ampliados) retoma cada historia donde quedó, sin repetir
lo hecho ni superar el total autorizado. Al arrancar el Portal no se retoma nada que espere tu decisión.

**Persistencia.** En el navegador (`localStorage`, clave `portal-ia.draft.v1.<formulario>.<empresa>.<proyecto>…`,
30 días): lote a medias, filtros y orden, mensaje del Asistente por conversación, respuestas a decisiones, encargo,
chat/tarea/iteración/edición de una historia, backlog, agente nuevo y configuración de un agente. Nunca una casilla de
autorización ni un secreto; tras autorizar o enviar, el borrador se borra. Un borrador de una versión anterior del dato
se ofrece («Recuperarlo» / «Descartar») y no se aplica solo. Navegación: empresa/proyecto por entrada del historial,
enlace directo por encima de lo guardado, pestañas en la URL, desplazamiento por pantalla.

## Limitaciones conocidas

- Los borradores viven en este navegador y este perfil: no viajan a otro equipo ni a otro navegador.
- Las imágenes y archivos adjuntos al Asistente no se guardan como borrador (pueden ser grandes o privados).
- La versión de un dato sin fecha propia se identifica por una huella de sus campos editables: un cambio en otro campo
  del mismo dato no marca el borrador como antiguo (y al guardar solo se envían tus campos).
- Si el Portal se detiene de golpe mientras ejecuta una operación autorizada desde el Asistente (publicar main…), la
  tarjeta queda «Ejecutando…»: compruébalo en git y pide la operación de nuevo si hace falta.
- La pausa por el límite de la suscripción se retoma con «Reanudar»; si el límite no se ha renovado, la primera
  llamada lo comprueba y la historia vuelve a pausarse (sin gasto de API).
