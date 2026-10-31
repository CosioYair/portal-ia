# Rendimiento, navegación, concurrencia y tiempo real (31 de octubre de 2026)

Encargo del propietario tras usar el Portal con historias reales y lotes de ejecución continua: navegar era lento,
volver atrás perdía el contexto, una historia en marcha impedía iterar otra («Ya hay un proceso en ejecución. Espera a
que termine.»), la interfaz no se actualizaba sola y los estados de QA se contradecían (HU-166, HU-169, HU-173, HU-175).
Metodología Gauntlet: medir y reproducir → diseño desafiado (ronda A) → implementación → revisión independiente del
diff (ronda B) → recorridos de punta a punta (ronda C) → verificación final.

## 1. Causas raíz (reproducidas)

| Problema | Causa real | Cómo se reprodujo |
|---|---|---|
| Lentitud general | `process_steps` sin índice por proceso: cada proceso leía la tabla entera de pasos (decenas de MB). El listado de procesos calculaba la orientación de cada proceso y, para numerar su iteración, volvía a cargar TODOS los procesos del proyecto (O(N²)). La bandeja pedía internamente el listado completo (con `app.inject`, 37 MB) y lo volvía a cargar. SQLite es síncrono: cada petición lenta bloqueaba todas las demás. | Instancia aislada con 150 historias y 66 procesos (36 MB): `/inbox` 13,6 s, `/processes` 13,4 s (37,8 MB), `/stories/:id` 482 ms; Backlog llegó a mostrar «0 historias» (la lectura superaba el límite de 20 s del cliente). En el Portal real (36 procesos): `/inbox` 2,8 s y `/processes` 2,7 s (12,7 MB) en cada visita al Backlog. |
| «Ya hay un proceso en ejecución» | Regla histórica «un proceso a la vez» repetida en 8 comprobaciones (`running().length`): autorizar, continuar, aceptar el plan, resolver conflictos, encargos, corrección externa, candidato de integración y el lote. | HU-175 no podía iterar mientras el lote ejecutaba HU-169. |
| La interfaz no se actualizaba | Sondeos por pantalla (2–30 s) que se detenían al terminar el proceso; Backlog y Panel no se actualizaban nunca; «Reconstruir y reiniciar» tardaba hasta 30 s. | Auditoría de cada pantalla. |
| QA contradictorio (HU-166/169) | Cada superficie leía un campo distinto: el motivo de una pausa ya resuelta («QA aún no ha revisado este commit» tras integrar), `qaApproved` falso cuando había candidato, la etapa «Verificar» bloqueada por una pausa de integración, «Pulsa Integrar» mientras el problema pedía una decisión. | Datos de HU-166 (integrada y activa con la pausa vieja) y HU-169 (conflictos resueltos por el agente). |
| HU-175 (plan sin archivos) | El Coordinador dijo A PROPÓSITO que la historia (una auditoría de solo lectura) no cambia archivos; el Portal lo trató como un JSON cortado, lo volvió a pedir (pagado) y ofreció repetir la historia, que fallaría igual. | Salida del Coordinador: JSON completo con `filesToChange: []` y el motivo. |
| HU-173 (sin capturas) | El criterio pedía capturas antes/después; el sandbox no tiene navegador. Además: «7 de 8» casos (TAP escapa `#` en los nombres) y el diff para QA cortado a 50 KB por un CSS minificado. | Proceso de HU-173. |

## 2. Arquitectura elegida

- **Concurrencia por historia** (`services/executionLocks.ts`): solo chocan las operaciones sobre la misma historia o
  encargo (su rama y su worktree). Un «arriendo» en memoria se toma al empezar cada operación con efecto y se suelta al
  terminar el manejador (aunque el navegador se vaya), con caducidad de seguridad.
- **Carril del repositorio** (`services/repoLock.ts`, reentrante): integrar en main (`update-ref` con el valor anterior
  esperado), preparar candidatos, crear o quitar worktrees y construir la interfaz, de uno en uno. Planificar,
  implementar, verificar, QA y tu revisión siguen en paralelo.
- **Base fijada por historia** (`ExecutionResult.baseCommit`): la rama nace del main que vio el Desarrollador, así una
  integración de otra historia mientras trabaja se combina con git (o se dice el conflicto) y nunca se deshace en silencio.
- **Capacidad compartida** (`services/capacity.ts`): la cola de Claude Code (1–4 a la vez) ya no consume el plazo de la
  llamada ni la duración de la historia y se ve como «En cola»; el sandbox limita los contenedores a la vez (3 por
  defecto) y protege el volumen de dependencias con un cerrojo lector/escritor.
- **Lotes**: una historia ocupada no frena a las demás; una iteración que autorizas fuera del lote queda «Sigue fuera del
  lote» (el lote no la repite, no la integra y no la cobra); la integración pre-autorizada solo si la aprobación de QA
  cubre el commit; la activación espera a lo que esté en marcha y lo dice.
- **Reconstruir y reiniciar**: con procesos en marcha exige confirmar que se interrumpen; durante la reconstrucción no
  empieza trabajo nuevo; antes de reiniciar se vuelve a comprobar.
- **Tiempo real** (`services/live.ts`, `routes/live.ts`, `web/src/lib/live.ts`): cada escritura avisa QUÉ cambió (espacio,
  entidad, id; nunca contenido) por Server-Sent Events, agrupado cada ~200 ms, con época:secuencia, recuperación de lo
  perdido y «resync». Una conexión por pestaña visible, latido con vigilante (una red muda se detecta y se reconecta),
  respaldo cada 15 s sin conexión. Cada pantalla vuelve a pedir lo que muestra; la respuesta más reciente gana.
- **Estado por commit** (`services/revision.ts`): qué commit aprobó QA, cuál es el actual o el candidato y si la
  aprobación lo cubre (directa, Gauntlet, candidato que solo añade main sin tocar la historia, con solapamiento o
  superada). Todas las superficies (etapas, problema, guía, lote, Actividad) usan esta única derivación.
- **Navegación** (`web/src/lib/nav.ts`): «Atrás» global (historial del navegador, sin entradas artificiales; sin pantalla
  anterior del Portal va a la pantalla madre), estado por entrada del historial, filtros por pestaña y desplazamiento por
  entrada. Pestaña desactualizada: cada acción lleva la versión del proceso que vio (409 `stale_view` si cambió).

## 3. Medidas antes/después

Misma instancia sintética (150 historias, 66 procesos, 36 MB de historial), mismo script (`perf-measure.mjs`).

**API** (12 peticiones seguidas; p50 / p95; tamaño de la respuesta):

| Ruta | Antes | Después |
|---|---|---|
| `/inbox` (lo pedía cada pestaña cada 30 s y en cada navegación) | 13 619 / 15 292 ms | **41 / 47 ms** |
| `/projects/:id/processes` (listado completo, se conserva) | 13 370 / 17 245 ms · 37,8 MB | 2 234 / 2 491 ms · 37,8 MB |
| `/projects/:id/processes?view=summary` (lo que usa la interfaz) | — (no existía: 13,4 s y 37,8 MB) | **1 577 / 2 928 ms · 0,9 MB** |
| `/processes/:id` | 318 / 454 ms | 157 / 171 ms |
| `/stories/:id` (antes se pedía cada 3 s) | 482 / 533 ms | 161 / 164 ms |
| `/projects/:id/batches` · `/batches/:id` | 19 / 24 · 17 / 23 ms | 1,5 / 2,7 · 2,0 / 2,3 ms |

`/system/status` no es comparable (la instancia «antes» corría desde una copia sin git y respondía sin consultarlo).

**Navegación en el navegador** (3 vueltas, hasta contenido útil visible; p50 / p95; tope de espera 45 s):

| Recorrido | Antes | Después |
|---|---|---|
| Backlog → Historia | 45 006 / 45 015 ms (2 de 3 sin terminar) | **29 / 80 ms** |
| Historia → Proceso | 28 008 / 45 005 ms | **216 / 216 ms** |
| Proceso → Ejecución continua | 11 486 / 11 665 ms | **70 / 73 ms** |
| Ejecución continua → Lote | 22 / 23 ms | 16 / 26 ms |
| Lote → Historia | 14 194 / 14 697 ms | **14 / 15 ms** |
| Actividad | 45 023 / 45 024 ms (2 de 3 sin terminar) | **42 / 47 ms** |
| Actividad → Proceso | 45 008 / 45 010 ms (sin terminar) | **18 / 20 ms** |
| Atrás (a Actividad) | 45 007 / 45 008 ms (sin terminar) | **16 / 21 ms** |
| Atrás (a la Historia del lote) | 45 005 / 45 015 ms | **18 / 18 ms** |
| Proceso → Backlog | 45 026 / 45 036 ms | **20 / 21 ms** |
| Carga directa del Backlog | 45 030 / 54 729 ms (sin terminar: «0 historias») | **1 750 / 1 759 ms** |
| Carga directa de una Historia | 13 567 / 14 297 ms | **289 / 1 111 ms** |
| Peticiones de fondo con una historia abierta 20 s sin cambios | 5 | **0** |

En el Portal real (36 procesos, solo lecturas): `/inbox` 2,8 s y `/processes` 2,7 s (12,7 MB) por visita al Backlog antes
del cambio. Después de activarlo se espera la misma proporción; no se ha medido en el Portal real (no se ha reiniciado).

## 4. Gauntlet

- **Ronda A (diseño)**: 2 críticos (integrar en main sin carril; huecos entre comprobación y cambio de estado), 6 mayores
  (cola de Claude Code y plazo, volumen de dependencias, activación sin drenaje, iteración fuera del lote, tormenta de
  avisos, reescritura sobre un main que avanzó). Todos incorporados al diseño.
- **Ronda B (diff)**: 2 críticos (arriendo que quedaba colgado si el navegador se iba; el lote podía ejecutar dos veces
  una iteración que ya habías autorizado), 3 mayores («fuera del lote» oscilaba y deshacía tu «No aceptar»; la
  reconstrucción bloqueaba el carril y reiniciaba sin volver a mirar; la espera en cola se arrastraba), 3 menores (Backlog
  seguía «de una en una»; avisos que no se emitían; segundo clic de una pestaña vieja). Todos corregidos con prueba.
- **Ronda C (punta a punta)**: lote de 2 historias (2 a la vez, integrar en main pre-autorizado) y, mientras corre, una tercera autorizada fuera del lote, con el SANDBOX DOCKER REAL y git real: 13/13 comprobaciones (3 ejecuciones): tres procesos a la vez; la autorización de la tercera mientras el lote trabaja (antes 409); el doble clic ejecuta una sola vez; las dos integraciones en main de una en una, la segunda tras un candidato sin IA; nada se pierde en main; verificación en Docker; un solo plan pagado por historia; 17 avisos en tiempo real en ~7 s (sin tormenta). Caída y vuelta del servidor con una pestaña abierta (`ui-reconnect.mjs`): aviso «sin tiempo real» al instante, reconexión sola en ~2 s, cambios de nuevo sin recargar (5/5).

## 5. Pruebas nuevas

- `concurrencia-tiempo-real.test.ts`: G/H/K, J/O, L (dos integraciones a la vez), HU-175, I/P, Q–X (canal), W (pestaña
  vieja), base fijada (otra historia integra mientras se trabaja) y las regresiones de la ronda B.
- `estado-revision-rendimiento.test.ts`: Y/Z (HU-166, HU-169, solapamiento, superada), HU-173 (inconcluso, sin integrar
  con conflicto, equivalencia de estilos, TAP, diff repartido), AA/AB, versión para decidir, M (cola, semáforo, cerrojo),
  A (pantalla madre), AD/AE/AF (índices y listados con 120 historias).
- `navegacion-tiempo-real-wiring.test.ts`: tiempo real sin sondeos, «Atrás», estado por pestaña, versión vista,
  reinicio con procesos en marcha, salvaguardas de la reconstrucción.
- Recorridos en el navegador (`ui-nav-live.mjs`, scratchpad): A–F, Q, S, U, V, X, AJ.

**Verificación** (cada árbol antes de su commit, en una copia limpia con Docker obligatorio):

| Comprobación | Resultado |
|---|---|
| typecheck · build | en verde |
| Suite completa (Docker obligatorio) | 597 pruebas: 593 correctas, **0 fallos**, 4 omitidas (las mismas que en `main` `1eb9a7c`, que tenía 561: dos de reconciliación necesitan una copia con git, SIGTERM no aplica en Windows, el aislamiento linux-ns no se usa con Docker disponible) |
| Pruebas nuevas | 36 (`concurrencia-tiempo-real` 14, `estado-revision-rendimiento` 15, `navegacion-tiempo-real-wiring` 7) |
| Navegador · navegación y tiempo real (`ui-nav-live.mjs`) | 20/20 (A–F, Q, S, X, AJ, sin errores de JavaScript) |
| Navegador · caída y vuelta del servidor (`ui-reconnect.mjs`) | 5/5 (U, V y reconexión tras reinicio) |
| Punta a punta, Docker y git reales (`e2e-concurrencia.mjs`) | 13/13 (G, H, L, O, Q/R, AI) en tres ejecuciones |
| Regresión de las suites anteriores del navegador | persistencia 42/42 · monitor de lotes 40/40 · Asistente 12/12 · controles de encargos y planes 26/26 · asistente de lotes 18/18 |

La regresión del Asistente detectó que el «Atrás» con texto ocupaba una fila más en móvil (el chat dejaba de empezar en la
primera pantalla): corregido en un commit aparte (solo el icono en móvil, sin hacer más alta la fila).

## 6. Limitaciones

- La espera en la cola de Claude Code y las cachés de la interfaz viven en memoria: tras un reinicio, lo interrumpido se
  retoma a mano (como antes) y la primera visita a cada pantalla vuelve a pedirlo todo.
- La equivalencia de estilos prueba valores resueltos, no píxeles: no ve HTML ni JavaScript. Si el criterio exige capturas,
  sigue siendo tu decisión (el Portal lo dice con las acciones concretas).
- Los índices nuevos se crean al abrir cada base (aditivos, sin tocar datos; menos de un segundo).
- El listado completo de procesos (`/processes` sin `?view=summary`) sigue existiendo por compatibilidad y es pesado;
  la interfaz ya no lo usa.
