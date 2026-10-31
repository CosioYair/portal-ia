# Empresa autónoma · Lotes terminados antes de tu aceptación, integración ordenada y Asistente con más capacidad

> **31 de octubre de 2026** · rama `mejora/empresa-autonoma` (sobre `mejora/concurrencia-tiempo-real`, a su vez sobre `1eb9a7c`).
>
> Documentos relacionados:
> - visión del producto: `docs/vision-producto.md`;
> - hoja de ruta: `docs/hoja-de-ruta-capacidades.md`;
> - hallazgos del Gauntlet: tabla en §7.

## 1. Punto de partida (estado real, sin tocar datos)

### Lote `568c60cb` en el Portal en marcha (`1eb9a7c`)

- **Autorización:**
  - 10 historias;
  - Claude Code, 4000 llamadas, Gauntlet profundo, 3 a la vez;
  - integrar, activar y publicar pre-autorizados.
- **Plan:** «sin IA»: HU-166 → … → HU-175, es decir, el orden de los identificadores.
- **Estado de las historias:**

| Historias | Estado |
|---|---|
| 7 | Integradas en main y activas: 6 pendientes de aceptación y HU-167 aceptada. |
| HU-169 | Candidato con conflictos resueltos por la IA, verificado en el sandbox. QA no lo revisó, así que el lote lo dejó en «decides tú». |
| HU-173 | QA «no pudo verificar» (equivalencia visual). |
| HU-175 | El Coordinador no entregó un plan con archivos (es una auditoría). |

### Rama sin integrar

`mejora/concurrencia-tiempo-real` (`0ae33a5`) tampoco se ha integrado. Aporta:
- exclusión por historia;
- carril de repositorio;
- tiempo real;
- estados por commit;
- la conversión de HU-175 en análisis.

Este trabajo se apoya en ella.

## 2. Causas raíz

### Ejecución continua

1. **Integrar = antes de aceptar.** Con «integrar» marcado, cada historia entraba en main (y se publicaba y activaba) en cuanto terminaba. La aceptación llegaba sobre código ya integrado. Sin «integrar», cada una quedaba «pendiente de integrar» sin orden ni puesta al día. No existía «terminar todo el lote y aceptar historia a historia».
2. **Orden sin análisis.** El orden era el topológico de `dependsOn` con tu orden como desempate, que en la práctica era el de los identificadores. No se usaban archivos compartidos ni dependencias implícitas.
3. **Candidatos sin control de vigencia.** No existía la noción de «evidencia de una revisión obsoleta». La integración preparaba el candidato en el último momento y, si QA no cubría el commit nuevo, se paraba en «decides tú». Eso es lo que le pasó a HU-169.
4. **Pedir cambios descartaba el trabajo.** «Iterar» sobre una historia terminada y no integrada borraba su worktree y su rama y la rehacía desde main. Era aceptable cuando ya estaba integrada, pero destructivo con la integración al aceptar. Lo mismo ocurría en los encargos.
5. **Verificación rutinaria como decisión del propietario.** Revisar con QA un candidato verificado (HU-169) o repetir QA con evidencia nueva (HU-173) exigía pasos manuales en cada proceso.

### Asistente frente a Claude Code (análisis con `archivo:línea`)

| # | Causa | Evidencia |
|---|---|---|
| 1 | El Asistente no veía el código: su llamada no tenía proyecto ni puente de lectura; solo el resumen del estado | `assistant.ts` (`agentCaller(…, null, …)`) |
| 2 | La conversación compartía el único hueco de Claude Code con los procesos: esperaba hasta el plazo de una unidad de un lote | `claudeCode/backend.ts` (`acquireSlot`) |
| 3 | «Mejora…» acababa en historias o análisis en vez de en un encargo | tabla de acciones de `assistant.ts` |
| 4 | Una tarjeta de encargo en pausa solo ofrecía «Autorizar», que descartaba lo aplicado y lo ya pagado; «Continuar» solo estaba en otra pantalla | `ConversationPanel.tsx` |
| 5 | Tope de llamadas sugerido ≈ 13–15, insuficiente para encargos normales, que se pausaban | `assignments.ts` |
| 6 | El Desarrollador no tiene bucle «editar → probar → corregir» dentro de una llamada (`--tools ""`; propone texto) y cada llamada empieza sin sesión | `claudeCode/cli.ts` |
| 7 | Historial del chat recortado a 1200 caracteres por mensaje | `assistant.ts` |

La causa 6 es la mayor. No se cierra en este encargo porque exige un cambio de seguridad propio (ver R2 en la hoja de ruta).

## 3. Cambios implementados

### Prioridad 0: completar el lote actual

- **«Reanudar» continúa el trabajo técnico rutinario** sin pasos en cada proceso (`candidateNeedsQa`, `qaRetryable`):
  - un candidato verificado que QA no revisó → QA lo revisa (una llamada) y el lote lo integra como autorizó;
  - un «QA no pudo verificar» → QA lo repite **una vez** con la evidencia actual (la equivalencia de estilos de la rama anterior), mediante `qaRequestedFor`.
- **En lotes nuevos con integración automática**, revisar el candidato es automático (no pasa por «decides tú»).
- **HU-175:** «Convertir en encargo de análisis» (rama anterior) sigue siendo una decisión de un clic. Cambia la naturaleza del trabajo, así que es del propietario.

### Prioridad 1: integración al aceptar, ordenada y con candidatos al día

- **Política nueva `git.integration: 'on_acceptance'`.** Es la recomendada en el asistente de lotes. Los lotes anteriores quedan en `auto`, como se autorizaron.
- **Estados nuevos:**
  - `ready`: terminada, sin integrar;
  - `revalidating`: poniéndose al día;
  - `postponed`: aplazada.
- **Ciclo de vida explícito:** terminada técnicamente → aceptada (`acceptance`) → integrada (`mergedCommit`) → cerrada (`accepted` + backlog `done`).
- **Resumen del lote** (`batchLifecycle`), por ejemplo: «Lote técnicamente completo: 12 historias — 10 listas para tu aceptación (sin integrar), 1 requiere una decisión tuya, 1 bloqueada por un problema técnico». Indica también cuál toca revisar después.
- **Orden de integración** (`integrationOrder`, sin IA, explicado):
  - dependencias declaradas;
  - dependencias implícitas (una historia menciona un archivo que otra crea);
  - dentro de cada grupo que comparte archivos, primero la más transversal (archivos compartidos o más solapes);
  - a igualdad, tu prioridad.
  - Se recalcula con la mejor información: archivos reales de la rama > plan > archivos mencionados en el texto.
- **Vigencia de la evidencia** (`freshnessOf`, solo git):
  - `current`: nació del main actual y QA cubre el commit;
  - `clean_carry`: main no tocó sus archivos ni los compartidos;
  - `stale`: hay solape, con causas y conflictos previstos por `merge-tree`;
  - `unknown`.
  - Lo obsoleto nunca se presenta como vigente.
- **Puesta al día** (`revalidate`), solo de la **siguiente** en el orden y de una en una (no se paga dos veces):
  1. merge de main (git);
  2. si hay conflictos reales, el Desarrollador resuelve solo esas secciones (una llamada, dentro de los límites del lote);
  3. sandbox;
  4. QA del commit nuevo si la combinación tocó sus archivos;
  5. vuelve a «lista» con un evento que dice qué cambió.
- **Aceptar e integrar** (`acceptReady` → `integrateAccepted`, en segundo plano):
  - Se guarda el commit revisado y la **huella** de sus cambios (`git patch-id` del diff sin contexto respecto a main).
  - Se integra solo si la huella no cambió al ponerla al día. Si cambió, la aceptación se anula y vuelves a revisarla.
  - Publicación y activación según la autorización.
  - Una única aceptación: queda cerrada.
- **Tus acciones por historia:**
  - Aceptar e integrar.
  - **Pedir cambios: sobre su misma rama** (`prepareOwnerRound`: ronda dirigida con tu nota y una corrección autorizada más; se repiten verificación, QA y Gauntlet).
  - No aceptar.
  - Aplazar / Recuperar.
  - Cerrar (la aceptación cierra la historia).
- **El lote solo termina** cuando todo está aceptado e integrado, no aceptado, aplazado o cancelado. Nunca con trabajo aceptado sin integrar ni decisiones pendientes. La duración autorizada limita el trabajo del equipo, no tu tiempo de revisión.
- **Dependencias:** una historia dependiente empieza cuando su dependencia está aceptada e integrada. El asistente de lotes lo avisa. Las ramas apiladas quedan como R5.

### Prioridad 2: Asistente y encargos

- **El Asistente lee el código del proyecto** de la conversación:
  - usa el puente MCP de **solo lectura**, con las mismas rutas protegidas que los agentes: nunca `.env`, `data/` ni credenciales;
  - investiga antes de proponer y cita archivos y funciones reales.
- **Carril propio de Claude Code para la conversación:** el chat ya no espera detrás de un lote. Sigue contando en el registro y en los topes.
- **«Mejorar algo» es un encargo directo** (sin historia ni análisis, salvo que pidas eso). Los últimos turnos del historial van casi completos.
- **Encargos:**
  - «Pedir cambios» aplica tu nota sobre su rama y sigue con la misma autorización, en un clic, sin descartar nada;
  - la tarjeta en pausa ofrece «Continuar» (con llamadas adicionales opcionales) en vez de una reautorización que descartaba lo hecho;
  - con una pregunta pendiente del equipo, enlaza a contestarla;
  - tope sugerido realista (pasos + 14 + 6 por corrección).

### Prioridad 3: cimientos

- **Descubrimiento de proyectos existentes** (`GET …/projects/:id/discovery`):
  - solo metadatos;
  - propone un perfil: comandos de instalación, typecheck, lint, test y build; gestor de paquetes; CI; documentación; herramientas como MCP y contenedores;
  - avisa de lo que el sandbox aún no soporta (pnpm, Python…);
  - nunca lee secretos;
  - **descubrir no autoriza nada**.
- **Falso verde corregido:** la verificación mínima en el equipo daba `typecheck` en verde **sin comprobar nada** en cualquier repositorio sin los tsconfig del Portal. La integración de proyectos externos, que solo exige typecheck, podía aceptar código sin verificar.
- **Dirección del producto:**
  - documentada en `docs/vision-producto.md`;
  - el Asistente la conoce como **dirección, no política**: no concede permisos ni activa integraciones.

## 4. Arquitectura de integración y concurrencia

- **Implementación en paralelo** (concurrencia autorizada, worktree por historia).
- **Integración en serie:**
  - carril por repositorio (`withRepoLock`);
  - `update-ref` con el valor anterior;
  - una integración a la vez por lote;
  - arriendo por historia.
- **Puestas al día:** también ocupan un hueco de la concurrencia y esperan a que no haya una historia aceptada en camino de main.
- **Idempotencia ante reinicios:**
  - Cada paso se guarda antes de actuar (`revalidation.step`, `mainHead`).
  - Un merge a medias se aborta (`MERGE_HEAD`).
  - Un merge del Portal que quedó sin registrar se **adopta** (mensaje propio, primer padre = lo verificado, segundo en main).
  - Si el commit verificado ya está en main, se **registra esa integración en vez de crear otra**.
  - `mergeStory` solo integra el commit verificado: rechaza los commits sin registrar.
  - El fin de una puesta al día se decide con hechos de git: main incorporado, cabeza = commit registrado, verificado y cubierto por QA. Nunca con «el proceso terminó».
- **Llamadas:**
  - las de QA y de resolución de conflictos son del mismo proceso y cuentan en el tope del lote (`callCapCheck`);
  - una pausa del proveedor durante una puesta al día **no se repite sola**: decides tú.

## 5. Medidas

| Medida | Antes | Después |
|---|---|---|
| Respuesta del Asistente con una unidad de lote larga (4 s) ocupando el único hueco de Claude Code | esperaba a la unidad (≥ 4 s más la suya) | < 3,5 s, en su carril (prueba «carril propio») |
| Llamadas para revisar un candidato verificado (HU-169) | pasos manuales en el proceso | 1 llamada de QA, desde «Reanudar» |
| Pedir cambios a una historia terminada sin integrar | plan + implementación completos otra vez | 1 corrección dirigida (prueba 12.1: 0 planes nuevos, 0 reimplementaciones) |
| Revalidaciones al integrar N historias que comparten archivo | — | 1 por historia afectada, solo la siguiente en el orden (no N−1 por cada integración) |
| Vista del lote (`GET /batches/:id`) | — | sin git en la petición: plan y vigencia guardados por el coordinador |

La navegación y los listados se midieron en la rama anterior (`docs/rendimiento-concurrencia-tiempo-real.md`). Siguen igual.

## 6. Diseño pendiente: ramas apiladas (R5)

1. La dependiente se crea desde la cabeza de la rama de su dependencia, no desde main. El plan y las lecturas se hacen desde ese worktree. Se guarda `stackedOn` = {historia, commit}.
2. Al integrarse la dependencia, la dependiente se pone al día con main. Su propio diff es el que va desde ese commit.
3. Si la dependencia se rechaza o se aplaza, la dependiente queda bloqueada con su motivo: su rama contiene ese código.
4. Nunca se integra antes que su dependencia.

## 7. Gauntlet

| Ronda | Qué se revisó | Resultado |
|---|---|---|
| A · diseño | Revisión independiente | 12 hallazgos (2 críticos) corregidos antes de implementar |
| B · implementación | Revisión independiente del diff | 11 hallazgos (2 críticos: re-programación en bucle que podía colgar el servidor; reintentos automáticos de llamadas pausadas) corregidos con pruebas de regresión |
| C · punta a punta | Navegador real, Docker y git reales | `e2e-lote-aceptar` 14/14 |

Tabla completa de hallazgos y correcciones:

| # | Gravedad | Hallazgo | Corrección |
|---|---|---|---|
| A1 | crítico | «Pedir cambios» sobre una historia `ready` → `iterateStory({discardApplied})` borra el worktree y la rama verificados y lo rehace todo desde main | `prepareOwnerRound`: ronda del propietario sobre la MISMA rama (+1 corrección autorizada), retomada en su turno; nunca `discardBranch` para `ready`/`postponed` |
| A2 | crítico | Lote en pausa → la historia termina → `awaiting_integration` → «Reanudar» la pasa a `integrating` → se integra sin aceptación | Con integración al aceptar, `technicalDone` siempre va a `ready`; la promoción de «Reanudar» solo aplica a `auto`; `integrationQueue` e `integrateAccepted` exigen `acceptance` |
| A3 | mayor | El propietario tendría que aceptar dos veces (`afterMerge`/`finishActivation` → `awaiting_acceptance`) | Con una aceptación registrada → `accepted`, backlog cerrado y `owner_acceptance` registrado ahí mismo |
| A4 | mayor | Los estados nuevos rompían `maybeComplete` (`ready` completaría el lote), el límite de duración, `stopRunning`, cancelar/cerrar, `batchMoving`, `DEPENDENCY_BROKEN` y la iteración de bloqueadas | Cada uno adaptado (ver pruebas) |
| A5 | mayor | La puesta al día corría con el proceso `done`: invisible para la recuperación tras un fallo, la activación y la concurrencia | `procs.resume` antes de verificar o resolver; `maybeActivate` y `startNext` cuentan `revalidating` |
| A6 | mayor | Reinicio no idempotente: merge a medias, commit de merge sin registrar, o main ya integrado sin registro → segundo merge | `merge --abort` si hay `MERGE_HEAD`; se adopta el commit de merge hecho por el Portal; `mergeStory` registra el merge existente en vez de integrar dos veces; solo integra si la rama es el commit verificado |
| A7 | mayor | «Proceso verificado» no prueba que la puesta al día se hiciera (paso interrumpido → mismo commit revisado) | El fin se decide con hechos de git (main es ancestro de la cabeza, cabeza verificada y cubierta por QA); un paso interrumpido se rehace |
| A8 | mayor | Anular la aceptación exige una huella estable | `storyPatchId` (`patch-id --stable` del diff sin contexto respecto a main), recalculada antes de integrar |
| A9 | mayor | La vigencia podía presentar evidencia obsoleta como vigente (conjuntos de archivos distintos, renombrados, `baseCommit`) | Mismo conjunto de archivos que `revisionStatus`; `--no-renames`; merge-base en vivo; «vigente» solo con la cabeza verificada y cubierta por QA |
| A10 | mayor | Repetir QA: `integration` no es reanudable, `lastQaCommit` se borraría, correcciones ya agotadas, coste añadido | Reanudable solo para la puesta al día del propio lote y para candidatos verificados; una corrección más para ponerla al día (registrada); la vista previa avisa del coste |
| A11 | mayor | `integrate` esperado dentro de la pasada bloquea el lote durante minutos | La integración al aceptar corre como tarea en segundo plano (sin bloquear) |
| A12 | menor | `ADOPTABLE`/`syncItems` ignoran `ready`/`postponed` | Se siguen: iteración desde fuera, integración a mano o continuación desde la vista del proceso |
| B1 | crítico | La aceptación compite con la puesta al día → `integrating` con el proceso en marcha → `scheduleTick` en bucle de microtareas (el servidor se cuelga) | `acceptReady` vuelve a comprobar `ready` antes de escribir (409 `state_changed`); la cola de integración salta las historias con su proceso en marcha; `integrateAccepted`/`revalidate` solo re-programan si algo cambió |
| B2 | crítico | Una pausa del proveedor durante la puesta al día (plazo, límite, turnos, presupuesto…) se rehacía sola, reenviando llamadas quizá ya cobradas | Cualquier pausa distinta de `integration`/`interrupted` sin cobro incierto → `needs_owner` vía `classifyStop` (pausa el lote si afecta a todo) |
| B3 | mayor | Un borrador antiguo del asistente de lotes (`merge` sin `integration`) mostraba «al aceptar» pero autorizaba `auto` | Al recuperar el borrador se fija `on_acceptance`; la vista previa y la autorización envían siempre la política explícita |
| B4 | mayor | «Iterar» con una pregunta pendiente, un diff rechazado o un conflicto → una ronda que nunca podía retomarse | Ronda del propietario solo cuando de verdad puede retomarse; si no, una iteración nueva como antes |
| B5 | mayor | Una nota del propietario sin archivo iba a un único archivo arbitrario | Una unidad con todos los archivos de la historia (y los que mencione la nota) |
| B6 | mayor | Una historia ya en main (integrada fuera del lote o tras un reinicio) se integraba otra vez (el candidato se preparaba antes) | `alreadyInMain` → `mergeStory` registra el merge existente en `integrate`, `integrateAcceptedNow` y `revalidate` |
| B7 | mayor | Un merge sin registrar tras un reinicio se mostraba como «evidencia vigente» | `freshnessOf` y `finishRevalidation` exigen que la cabeza de la rama sea el commit registrado |
| B8 | menor | Tareas en segundo plano que escribían en lotes cerrados o cerraban dos veces | Guardas: lote vivo y estado esperado; conjunto `finishing`; `closeAccepted` idempotente |
| B9 | menor | Un merge a mano desde la vista del proceso cerraba con una aceptación antigua | Un merge a mano borra la aceptación → queda pendiente de tu aceptación |
| B10 | menor | Interfaz: los pasos marcados a medias no se enviaban; «Recuperar» oculto en un lote terminado; «Continuar» en la tarjeta con una pregunta pendiente | Corregido: los pasos se envían y los valida el servidor; «Recuperar» visible; enlace para contestar en el proceso |
| B11 | menor | Reabrir un lote terminado lo pausaba por duración; puesta al día fuera del límite de concurrencia; puesta al día atascada en «verificado» | `createdAt` renovado; concurrencia respetada; `verified` reanudable dentro de la puesta al día |

## 8. Pruebas

Todas usan el proveedor simulado o la CLI simulada: ninguna llamada real.

| Archivo | Pruebas | Escenarios |
|---|---|---|
| `lote-integracion-al-aceptar.test.ts` | 10 | 12; 12.1; 12.2 (conflictos reales y anulación de la aceptación); nunca sin aceptación; 12.4 (reinicio en mitad); recuperación del lote real; huella; ronda B |
| `asistente-capacidad.test.ts` | 3 | Lectura del código sin `.env`; carril propio; encargo directo |
| `incorporacion-proyectos.test.ts` | 2 | Descubrimiento; sin falso verde |
| Actualizadas | — | `assignments.test.ts` y `assistant-journey.test.ts` (Docker real): pedir cambios sobre la rama; `concurrencia-tiempo-real.test.ts` (C2): la iteración sobre su rama, seguida sin repetir |

Navegador real, Docker y git reales: `e2e-lote-aceptar.mjs`, 14/14.
- El lote listo con main intacto.
- El orden explicado y la vigencia.
- Pedir cambios sobre la rama.
- Aceptar e integrar.
- La siguiente puesta al día sola.
- La independiente arrastra su evidencia.
- Aplazar y recuperar.
- Lote resuelto con 3 merges y ninguno repetido.
- Sin errores de JavaScript.

## 9. Recuperar el lote real `568c60cb` cuando actives esta versión

Nada se ejecuta solo al activar: las historias que ya esperaban tu decisión siguen esperándola.

1. **Abre el lote** (Ejecución continua) y **acepta** las 6 integradas y activas que te parezcan bien (HU-166, 168, 170, 171, 172, 174). Para cada una: «Aceptar seleccionadas» con sus pasos de prueba marcados.
2. **«Reanudar»** (autorizado), dentro de la autorización que ya diste al lote:
   - **HU-169:** QA revisa su candidato (1 llamada). Si aprueba, el lote la integra, la publica y la activa, como ya estaba pre-autorizado.
   - **HU-173:** QA repite su revisión una vez, con la equivalencia de estilos como evidencia.
3. **HU-175:** «Convertir en encargo de análisis» desde su proceso. Es una decisión tuya, porque cambia la naturaleza del trabajo.
4. El lote termina cuando todas quedan aceptadas o resueltas.

Ese lote conserva su política (**integración automática**). La integración al aceptar se elige al autorizar lotes nuevos.

## 10. Limitaciones conocidas

- La integración al aceptar no permite probar la **interfaz** del Portal en marcha antes de aceptar. Revisas la evidencia; la previsualización del candidato es R4. Para probar en vivo, usa la integración automática.
- Las dependencias de un lote esperan a que aceptes su dependencia (ramas apiladas: R5).
- Que no haya conflictos de texto no garantiza la semántica. La vigencia usa archivos propios, archivos leídos y compartidos, y la verificación del sandbox (typecheck/test/build) atrapa los cambios de contrato que esos comandos detectan, no todos.
- El Desarrollador sigue sin bucle de herramientas dentro de una llamada (R2).
- Los proyectos externos siguen con comandos npm e imagen Node. El descubrimiento ya propone su perfil, pero aplicarlo es R1.
- El margen real de la suscripción (sesión y semana) no lo expone la CLI. El Portal usa sus topes de llamadas y lo dice.
