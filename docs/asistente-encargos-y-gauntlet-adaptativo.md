# Asistente como interfaz de ejecución, encargos de desarrollo y Gauntlet adaptativo

Fecha: 30 de octubre de 2026. Rama `mejora/asistente-encargos`, sobre `mejora/lotes-autorizacion-seleccion`
(`9ea0ce9`, sin integrar; `main` = `e9fcbbc`). Todo con proveedor y CLI simulados, datos e instancias aisladas.

## Fase A · Línea base (qué existe, qué falta, qué se reutiliza)

| Área | Hoy | Falta |
|---|---|---|
| Asistente | Un único hilo global (`assistant_messages`, sin conversaciones). Cada mensaje es una llamada con un «snapshot» de TODAS las empresas, proyectos y el backlog abierto completo. Acciones por bloque JSON: crear empresa/proyecto, **crear, editar o reiniciar historias al instante** (sin clic del propietario); proponer ejecutar historia, aplicar, encargo de análisis (`delegated_task`) y operaciones del catálogo (con tarjeta de autorización). | Conversaciones persistentes; registro de decisiones; propuesta, revisión del equipo e historias generadas como pasos explícitos; encargos de desarrollo sin historia; crear historias solo con decisión explícita; contexto acotado. |
| Ejecución | Pipeline de historias (`storyExecution`/`storyPipeline`): worktree aislado, Docker, QA con evidencia, Gauntlet opcional, correcciones acotadas, integración manual o por lote. Atado a `backlogItemId` en ~20 puntos. | Ejecutar un encargo del propietario con el MISMO motor, sin crear historia. |
| Gauntlet | Modos `off`/`standard`/`deep` elegidos a mano; `recommendGauntlet` (sin IA) ya recomienda; evaluación DESPUÉS de QA; tope fijo de rondas (1–3). Evaluador solo si el propietario lo aprobó en el proyecto. | Modo automático por defecto; revisión del PLAN antes de implementar cuando compense; continuación por progreso, con replanteo ante fallos idénticos y límites de recursos reales. |
| Suscripción | El CLI gestionado comprueba la suscripción antes de cada llamada; el límite pausa (nunca cambia a la API salvo autorización); el lote limita llamadas. Se guarda `rate_limit_event` por ejecución (estado, `resetsAt`, `utilization`). | Mostrar lo que el CLI oficial informa de verdad (ver abajo) sin inventar cuotas; no empezar trabajo nuevo si el último informe es «rechazado» y aún no se ha renovado. |
| Herramientas de agentes | Claude Code gestionado SIN herramientas integradas; puente MCP de solo lectura (`portal_task_context`, `portal_list_files`, `portal_read_file`, `portal_knowledge`, `portal_report_progress`). El agente entrega parches en texto que aplica el Portal en el worktree; la verificación la ejecuta el pipeline en Docker. | Búsqueda en el código y diff del worktree (exploración tipo Claude Code) sin dar escritura ni shell. |
| Imágenes | La interfaz las admite; con Claude Code gestionado **no se envían** (se le dice al modelo que pida una descripción). | Enviarlas como bloques de imagen por `stream-json` (lo admite el CLI) o decirlo con claridad. |
| Pruebas | En Windows, la suite completa pasa. En el sandbox Docker (2 CPU) cada ejecución falló una prueba distinta (5 de 5, también en `main`). | Causas reproducibles y correcciones sin debilitar aserciones. |

**Lo que expone el CLI oficial instalado (2.1.311)**, según su propio esquema de `stream-json`: el evento
`rate_limit_event.rate_limit_info` trae `status` (`allowed` | `allowed_warning` | `rejected`), `resetsAt`, `rateLimitType`
(`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `overage`…), `utilization` y `unifiedWindows` (uso por
ventana de 5 h y 7 días; el propio CLI lo marca `@internal`). **Solo llega cuando se hace una llamada**: no hay forma
oficial de consultar el saldo sin gastar. El Portal lo mostrará como «último informe de Claude Code, de las HH:MM», nunca
como un porcentaje en vivo ni como una previsión de llamadas restantes. El CLI acepta bloques de imagen en base64 en los
mensajes de entrada.

## Estándar de calidad (criterio → verificación → prueba negativa)

| # | Objetivo | Verificación | Negativa |
|---|---|---|---|
| 1 | Conversaciones útiles y persistentes | Varias conversaciones; tras reiniciar el servidor, mensajes, etapa y decisiones siguen ahí (prueba con reinicio de la base) | Un fallo del proveedor deja la conversación usable con el error |
| 2 | Investigar y definir ideas | La etapa avanza exploración → decisiones → propuesta; el modelo propone decisiones con opciones, recomendación y riesgos | El modelo no puede marcar una decisión como aprobada |
| 3 | Decisiones una a una | Aprobar, rechazar, revisar o aplazar UNA decisión por API/UI; las demás no cambian | Aprobar no crea historias ni cambia código |
| 4 | Especialistas y opiniones independientes | «Consultar al equipo» llama a especialistas distintos del redactor; sus aportaciones vuelven a la conversación | La propuesta no se presenta sin el cuestionamiento independiente |
| 5 | Ideas → historias bien definidas | Borradores con título, descripción, criterios, dependencias, prioridad, especialistas, tamaño y enlace a la propuesta; sin duplicados del backlog | Sin propuesta aprobada no se ofrecen; sin clic no se crean |
| 6 | Encargos de desarrollo sin historia | Un encargo `EN-n` se autoriza y ejecuta; el backlog no cambia | Sin autorización explícita no hay proceso en marcha ni llamadas |
| 7 | Misma infraestructura segura | El encargo usa el mismo pipeline (worktree, Docker, QA, Gauntlet, integración manual) | Ninguna ruta de ejecución nueva fuera de la política de ejecución |
| 8 | Gauntlet automático | Por defecto `auto`: la intensidad sale de tamaño, riesgo e historial (sin IA); el plan se revisa antes de implementar en lo medio/complejo | Una pregunta informativa: 1 llamada, sin pipeline |
| 9 | Cooperación y concurrencia | Consultas independientes en paralelo (ya existe) con presupuesto garantizado; conflictos de archivos detectados | Nunca dos escrituras en el mismo worktree a la vez |
| 10 | Contexto sin duplicación | Medir los caracteres del prompt del Asistente antes/después; contexto acotado a la conversación y al proyecto | El Asistente no recibe el backlog completo de todas las empresas |
| 11 | Trabajo rutinario sin terminal | Desde el chat: investigar, decidir, proponer, crear historias, encargar, ver progreso y cambios | — |
| 12 | Uso, permisos e irreversibles controlados | Cada operación tipada con su autorización; integrar, publicar y reiniciar siguen fuera | Lenguaje natural ambiguo no ejecuta nada irreversible |
| 13 | Registro duradero | Encargo con id, petición, objetivo, criterios, agentes, autorización, worktree, commits, verificaciones, hallazgos y resultado; documento en Conocimiento al terminar | — |
| 14 | Interrupción y reanudación | Reinicio a mitad: el encargo se retoma sin repetir pasos (mismo motor y recuperación) | No se reenvía una llamada con cobro incierto |
| 15 | Ningún éxito sin evidencia | El encargo no queda «listo» sin verificación y QA; los informes distinguen hecho, estimación y limitación | Un criterio fallido impide «listo para revisar» |

## Diseño propuesto (sujeto a la revisión independiente de la fase B)

1. **Encargo de desarrollo** (`assignments`, código `EN-n`): reutiliza el pipeline de historias. El proceso
   `story_execution` lleva `assignment_id` en lugar de `backlog_item_id`; un adaptador `workItemOf(proceso)` entrega al
   motor el mismo «elemento de trabajo» que hoy da el backlog, y `setWorkStatus` actualiza el encargo en vez de la
   historia. Estados: borrador → pendiente de autorización → en marcha → (en pausa) → listo para revisar → aceptado |
   cambios pedidos | cancelado | fallido. Integrar sigue siendo manual. El «encargo» de análisis existente
   (`delegated_task`) no cambia; en la interfaz se distinguen «Encargo de desarrollo» y «Encargo de análisis».
2. **Conversaciones y registro de decisiones** (base de plataforma, como el Asistente): `assistant_conversations` (etapa,
   alcance empresa/proyecto), mensajes con `conversation_id` (los antiguos van a una conversación «Historial anterior»),
   `assistant_decisions` (pregunta, opciones, recomendación, riesgos, dependencias, estado, respuesta) y
   `assistant_artifacts` (propuesta con versión y cuestionamiento, revisión del equipo, borradores de historias).
   - El modelo solo PROPONE decisiones; aprobar, rechazar, revisar o aplazar es una operación del propietario.
   - Preparar propuesta, consultar al equipo, generar borradores y crear historias son operaciones tipadas, iniciadas
     por un botón que dice cuántas llamadas consumen.
   - Crear historias exige la propuesta aprobada y un clic.
3. **Contexto del Asistente**: el de la conversación, es decir, su empresa y proyecto con resúmenes acotados, las
   decisiones abiertas y cerradas, y los últimos mensajes. No el snapshot completo de todas las empresas.
4. **Intención**: el modelo clasifica en sus acciones. Las nuevas son `open_decision`, `propose_assignment`,
   `suggest_team_review` y `propose_stories` (solo borradores). Crear, editar o reiniciar historias pasa a ser una
   tarjeta que el propietario confirma. Nada ejecuta código sin la tarjeta de autorización del encargo.
5. **Gauntlet adaptativo**:
   - Modo `auto` por defecto, resuelto sin IA al autorizar a partir del tamaño, el riesgo y el historial, con los
     motivos a la vista.
   - Revisión independiente del plan antes de implementar si el modo resultante no es `off` y hay Evaluador.
   - La continuación se decide por progreso: sigue mientras baja la gravedad o el número de brechas y queda margen
     autorizado. Ante la misma brecha repetida, un diagnóstico de otro especialista antes de corregir otra vez; sin
     progreso tras eso, se detiene y decide el propietario.
   - El tope de rondas pasa a ser un límite de recursos autorizado, ampliable, no la definición de calidad.
6. **Suscripción**:
   - Se guarda y muestra el último informe del CLI (estado, ventanas, `resetsAt`) con su fecha y la advertencia de que
     no es una previsión.
   - Antes de empezar trabajo nuevo con Claude Code: si el último informe es `rejected` y no ha llegado `resetsAt`, no
     se empieza; queda en pausa con el motivo.
   - Nada cambia a la API ni activa uso adicional por su cuenta.
7. **Herramientas de agentes**: se añaden al puente MCP `portal_search` (buscar texto en el worktree de la tarea) y
   `portal_diff` (diff del worktree), ambas de solo lectura. Escribir y ejecutar siguen mediados por el Portal: parches
   aplicados en el worktree y verificación en Docker.
8. **Conocimiento**: al terminar un encargo se registra en Conocimiento qué se hizo, qué agentes, qué evidencia y qué
   commits, y se ejecutan los detectores de lecciones existentes. A los agentes se les dan referencias, no historiales
   completos.
9. **Pruebas inestables del sandbox**: se reproducen y se corrigen por su causa.
## Fase B · Cuestionamiento independiente del diseño y diseño revisado

Revisor con contexto nuevo, sobre el código real. Hallazgos que cambian el diseño (con su evidencia en el informe):

| # | Gravedad | Hallazgo | Cambio |
|---|---|---|---|
| F1 | crítico | Con la suscripción el margen en USD no limita nada: una llamada de Claude Code cuesta 0 USD y un proceso suelto no tiene tope de llamadas | Tope de llamadas a la suscripción por proceso (`pipeline.config.maxSubscriptionCalls`), autorizado al empezar y contado en cada llamada (también las fallidas); al alcanzarlo, pausa y decides |
| F2 | crítico | «Baja la gravedad o el número de brechas» puede alternar sin fin; `findingKey` no detecta brechas reformuladas | Progreso solo si mejora estrictamente una medida con suelo: más criterios cumplidos con evidencia o menos brechas bloqueantes/mayores; tope duro por proceso; la continuación automática nunca concede rondas nuevas |
| F3 | mayor | El acoplamiento a `backlogItemId` es ~70 usos en 21 archivos (recuperación tras reinicio, bandeja, integración, rama `portal-ia/cambio` reutilizada…) | `assignment_id` de primera clase en procesos; todos los usos por `workItemOf`/`setWorkStatus`; rama propia `portal-ia/en-NNN`; prueba que falla si aparece un uso directo nuevo; estado del encargo derivado del proceso |
| F4 | mayor | `resolveStory` casa solo el número («EN-3» → HU-003); empresa/proyecto por defecto en silencio | Referencias por prefijo exacto; el alcance de la conversación lo pone el servidor; sin referencia clara, tarjeta fallida |
| F5 | mayor | Varias vías de autorización: una propuesta del modelo crea un proceso pendiente que la bandeja ejecuta con un clic; `auto` se convertiría en `off` | El encargo es un borrador sin proceso hasta que autorizas; el modo `auto` se resuelve una vez al autorizar y se guarda con sus motivos |
| F6 | mayor | Antes de la entrega del Desarrollador, un reinicio repite el plan; operaciones nuevas del Asistente fuera de procesos no se recuperan ni se cancelan | Las operaciones con IA del Asistente son procesos (se reutiliza el encargo de análisis); el límite de la recuperación antes de la entrega queda documentado |
| F7 | mayor | Buscar o hacer diff podría filtrar secretos o la carpeta del propietario sin confirmar | Búsqueda literal (`git grep -F`) en archivos versionados de HEAD (o del worktree de la tarea), sin rutas protegidas ni archivos con secretos, con topes; diff solo del worktree, sin argumentos del modelo y sin conversores externos |
| F8 | mayor | El informe de límites solo se guarda si la llamada sale bien, y por espacio; el uso adicional (`overage`) no se detecta | Se guarda en la base de plataforma en cada resultado; la comprobación usa el último de la cuenta; un indicio de `overage` pausa |
| F9 | mayor | `auto` saldría «profundo» casi siempre (vocabulario de riesgo muy amplio, tamaño desconocido) | Tamaño desconocido → estándar como mucho; un riesgo solo → estándar; profundo exige tamaño L o dos señales; el encargo exige tamaño |
| F10 | mayor | Duplicaba el encargo de análisis (`delegated_task`), `askTeam`, las propuestas de backlog y la iteración | Propuesta, revisión del equipo e historias = encargos de análisis con un propósito; crear historias = aplicar sus propuestas con un clic; «cambios pedidos» = nueva ejecución con el contexto de iteración |
| F11 | mayor | Trampas: la tarjeta del chat promete revisar el diff antes de aplicarlo pero aplica; pide USD con la suscripción; «limpiar» borraría las decisiones | Textos corregidos; tope de llamadas en lugar de USD cuando el equipo usa la suscripción; las conversaciones se archivan, las decisiones no se borran |
| F12 | menor | Crear empresa/proyecto sigue siendo inmediato; contexto de decisiones sin tope; imágenes no guardadas | Tarjeta para crear; contexto de decisiones acotado; límites de imágenes documentados |

## Fase C · Lo implementado (commits pequeños sobre `9ea0ce9`)

| Commit | Contenido |
|---|---|
| `2389017` | Causa raíz de las pruebas inestables del sandbox: el reloj del contenedor retrocede (medido) y la «frescura» de la evidencia mezclaba horas. Marcas de tiempo monótonas (`monotonicNow`) y evidencia identificada por **commit** (`verificationsForApplied`), también en la puerta de integración, las unidades y la interfaz |
| `271e051` | Encargos de desarrollo `EN-n` (sin historia) con el mismo motor (`assignment_id` de primera clase, `workItemOf`/`setWorkStatus`, prueba que falla ante un uso directo nuevo de `backlogItemId`); autorización única (`authorizeProcess`); Gauntlet `auto` resuelto al autorizar y continuación por progreso estricto con tope duro (6); tope de llamadas a la suscripción por proceso; informe de límites del CLI en la base de plataforma con puerta de cuenta y reconocimiento del propietario |
| `4818b66` | Conversaciones persistentes con alcance; registro de decisiones (el modelo propone, el propietario decide una a una, con historial); propuesta, revisión del equipo e historias como encargos de análisis con propósito; la propuesta la cuestiona otro especialista con contexto propio; historias solo con el clic autorizado, sin duplicados y con dependencias por título; cambios locales como tarjetas; contexto acotado; imágenes al CLI como bloques |
| `38ece34` | Lotes: Gauntlet `auto` por defecto (el del proyecto), resuelto historia a historia en la vista previa y al empezar, con su motivo y su sobrecoste |
| `b869f56`, `de22cfa` | Herramientas MCP de solo lectura `portal_search` (literal, acotada) y `portal_diff` (sin confirmar o de la rama) con las mismas protecciones que leer; git sin fsmonitor, sin diff externo, sin bloquear el índice y sin shell |
| `2f54d3d` | Interfaz del Asistente: barra de conversación, panel con etapa y siguiente acción, decisiones, artefactos, encargos, cambios locales, aviso de límites; límite de errores por tarjeta; móvil sin superposiciones (menú lateral plegable) |

Desviaciones del diseño, a la vista:
- **No implementado:** revisión independiente del PLAN antes de implementar, y diagnóstico de otro especialista ante la
  misma brecha repetida (el Gauntlet se detiene sin progreso y decide el propietario). Quedan como siguiente paso.
- `portal_search` recorre los archivos listados por `git ls-files` (versionados y nuevos no ignorados) leyendo cada uno
  con las comprobaciones de `portal_read_file`, en lugar de `git grep -F`: así un archivo con un secreto se omite entero.
- Crear empresa o proyecto desde el chat también pasa por tarjeta (F12).

## Medidas

| Medida | Antes (`9ea0ce9`) | Después | Cómo |
|---|---|---|---|
| Prompt del Asistente con 500 historias abiertas en un proyecto y 120 en otra empresa | 70 270 caracteres | 19 886 sin alcance (−72 %) · 17 102 con alcance de proyecto (−76 %) | `perf-prompt.mjs`: misma petición, proveedor simulado, caracteres recibidos |
| Llamadas por pregunta informativa | 1 | 1 | registro del proveedor simulado |
| Llamadas para preparar una propuesta, una revisión o borradores | — | 0 (hasta autorizar) | prueba `conversations.test.ts` |

El recorte tiene un coste: el Asistente ve 40 historias abiertas por proyecto y no tiene una herramienta para consultar
otra concreta (se le dice cuántas hay). Los USD que muestran las pruebas y las capturas son del proveedor simulado.

## Verificación

- `npm run typecheck` y `npm run build`: exit 0 en cada commit.
- `npm test`: en Windows, todas las pruebas que no usan Docker en verde (418 de 425 en la última ejecución). Las 7 con
  Docker real fallan desde las 12:58 porque Docker Desktop devuelve «input/output error» al montar cualquier carpeta de
  `C:` (reproducido con un `docker run` mínimo, sin código del Portal); con el mismo código de servidor pasaron antes.
- Sandbox Docker: antes de la corrección, 5 de 5 ejecuciones fallaban una prueba distinta. Tras la corrección del reloj
  y la evidencia por commit, dos ejecuciones fallaron la MISMA prueba (HU-159, «pruebas solo canceladas»), cuyo
  dato de prueba se corrigió en el mismo commit `2389017`; **esa versión final no se ha vuelto a ejecutar en el sandbox**
  (Docker no monta carpetas). Pendiente de confirmar cuando Docker funcione.
- Recorrido en navegador sobre una instancia aislada (proveedor simulado): idea → decisiones → recargar → propuesta con
  cuestionamiento → aprobación → borradores → historias creadas con su dependencia; encargo `EN-001` autorizado (pasó a
  «espera tu decisión» con el motivo); cambio local confirmado. Script `ui-assist-verify.mjs`: 12/12 en escritorio y
  móvil (390 px). El recorrido encontró y se corrigieron: un tipo erróneo que dejaba la pantalla en blanco, la siguiente
  acción incoherente, un aviso de corte falso, un botón inexistente mencionado en un texto, quien cuestionaba también
  aportaba a la redacción, y la superposición en móvil.

## Fase D · Evaluación independiente del resultado y correcciones

Revisor con contexto nuevo, sobre el diff `9ea0ce9..HEAD`, con sondas propias (sin tocar el repositorio). 13 hallazgos;
todos corregidos con su prueba, salvo lo indicado:

| # | Gravedad | Hallazgo | Corrección y prueba |
|---|---|---|---|
| 1 | mayor | Las iteraciones anteriores de un encargo no quedaban superadas: se podía integrar la versión rechazada | Se superan como las de una historia; «continuar» también se bloquea en una superada. Prueba: la iteración 1 queda superada y `/merge` responde 409 |
| 2 | mayor | El Gauntlet de la vista previa del encargo no era el que se aplicaba (otro texto) y la tarjeta forzaba «auto» | La vista previa usa la misma resolución que la autorización; la tarjeta envía un modo solo si lo cambias y dice el que se aplicará |
| 3 | mayor | «Overage» en plena llamada no la paraba; un informe posterior sin la marca levantaba el bloqueo sin tu reconocimiento | La llamada se para en el acto; el bloqueo persiste hasta que lo reconoces. Prueba con la CLI simulada emitiendo «overage» y un informe normal posterior |
| 4 | mayor | Las historias no tenían tope de llamadas a la suscripción por proceso | Por defecto 60 (el de un lote) si el equipo usa Claude Code, ampliable al continuar. Pruebas: el tope por defecto y una pausa con tope 1 sin segunda llamada |
| 5 | mayor | `portal_diff`: un nombre de archivo con caracteres de patrón («[.]npmrc») alcanzaba el `.npmrc` protegido y devolvía su token | git con `--literal-pathspecs`; el escáner de secretos reconoce `_authToken`. Prueba con ambos archivos |
| 6 | menor (previo) | Rutas protegidas distinguían mayúsculas en Windows («.GIT/config», «DATA/x») | Patrones sin distinguir mayúsculas al leer y al escribir. Prueba |
| 7 | mayor | La tarjeta «Editar HU-x» no decía qué cambiaba ni que podía descartar un diff en revisión | La tarjeta lista los cambios y avisa si la historia vuelve a pendiente |
| 8 | menor | PATCH del alcance de una conversación no se validaba («../../x» llegó a crear una base fuera de `data/`) | Validación igual que al crear; `workspaceDbPath` rechaza identificadores que no sean `[a-z0-9-]`. Prueba |
| 9 | menor | La regla «solo altas» de las historias no se aplicaba al releer ni al aplicar | `applyBacklogOps` y `ensureOpsParsed` filtran por propósito; una propuesta no cambia el backlog. Prueba |
| 10 | menor | `/continue` aceptaba `gauntlet: auto` sin resolverlo | Se resuelve con la misma regla que al autorizar |
| 11 | menor | Diff rechazado dejaba el encargo «listo»; un borrador cancelado fijaba la etapa «encargo» | Rechazado → «espera tu decisión» (prueba); los cancelados no cuentan para la etapa |
| 12 | menor | Dos pruebas pasaban por el motivo equivocado | Reescritas: la cancelación del proceso recién creado se prueba con un equipo que no puede ejecutar; la puerta de la suscripción con una autorización real de un equipo en Claude Code (409, sin llamar a la CLI; tras reconocerla, sí) |
| 13 | menor | Progreso por «o» (podía alternar); «Reconocer y reanudar» no reanudaba; el encargo se ponía al día al leer | Progreso solo si nada empeora (prueba); el botón dice «Reconocer» y qué hace; el encargo se pone al día al terminar su proceso (oyente de `finish`) |

No corregido en esta ronda: el tope de llamadas se comprueba una vez por paso, no en cada reintento del proveedor (un
paso puede pasarse en hasta `maxProviderRetries`).

**Segunda revisión independiente** (verificación de `855db5f`, con sondas propias): 11 de 13 confirmadas; la 4 corregida
con una regresión y la 6 solo en parte. Hallazgos nuevos y su corrección:

| Gravedad | Hallazgo | Corrección y prueba |
|---|---|---|
| alta (previo) | En Windows, un agente podía leer `.env` con su nombre corto 8.3 (`ENV~1`), y también `GIT~1/config` | Los segmentos con nombre corto se rechazan al leer y al escribir; la lectura se vuelve a comprobar sobre la ruta real del sistema (`realpathSync.native`). Prueba |
| media | El «overage» reconocido no se podía aceptar: cada llamada se paraba de nuevo | Por episodios: reconocido, las llamadas siguen mientras dure; cuando un informe ya no lo indica, el siguiente episodio exige reconocerlo otra vez. Prueba |
| media | El tope por defecto (60) no se podía ampliar desde la interfaz | La parada por tope dice «tope de llamadas» (no USD) y ofrece «Conceder N llamadas más y continuar». Prueba: la acción existe, no pide USD y continuar amplía el tope |
| baja | `_authToken=${NPM_TOKEN}` se marcaba como secreto | Se excluyen los marcadores de variable. Prueba |
| baja | Una autorización fallida dejaba superada la iteración anterior; restaurar no valía para encargos | Se deshacen las marcas del proceso que no empezó; restaurar funciona por `assignment_id` |
| cosmético | Eventos repetidos al fallar una autorización o al cancelar | Sin el estado intermedio al cancelar; sin el segundo «No se inició» |

Residual documentado: una iteración anterior FALLIDA (sin decisión pendiente) no queda superada y se puede continuar,
igual que con las historias.

## Límites conocidos (no se ocultan)

- **Gauntlet en la planificación:** no hay revisión independiente del plan antes de implementar; el Gauntlet evalúa
  después de QA. Tampoco hay diagnóstico de otro especialista ante la misma brecha repetida: sin progreso, se detiene.
- **Agentes:** leen, buscan y ven diferencias por el puente MCP, pero no ejecutan órdenes ni escriben: entregan cambios
  que el Portal aplica en el worktree y verifica en Docker. No hay un bucle «editar → ejecutar pruebas → corregir»
  dentro de una misma llamada, como en la terminal de Claude Code.
- **Asistente:** ve hasta 40 historias abiertas por proyecto y no tiene herramienta para consultar otras; propone, no
  ejecuta. «Ejecutar historia» desde el chat sigue creando un proceso pendiente (se autoriza en su tarjeta).
- **Reanudación:** un reinicio antes de la entrega del Desarrollador repite el plan (documentado ya en v0.12).
- **Suscripción:** el Portal solo sabe lo que dice el último informe de la CLI (llega con cada llamada); no conoce el
  saldo ni lo estima. El tope de llamadas se comprueba por paso, no por reintento.
- **Sin validación con modelos reales:** todo se verificó con proveedor y CLI simulados; la calidad real de
  propuestas, cuestionamientos e historias depende del modelo y no se ha medido.
- **Docker:** la versión final de la corrección de pruebas inestables no se ha ejecutado aún en el sandbox (ver
  Verificación).

## Puerta de estabilización (31 de octubre de 2026)

**Seguridad.** Una sola comprobación de lectura (`resolveReadable`) para el puente MCP y el contexto que el pipeline
envía a los modelos, y una de escritura (`writablePath`) para aplicar, confirmar e integrar:
- se rechazan: mayúsculas distintas, nombres cortos 8.3, flujos alternativos (`::$DATA`), punto o espacio final, `..`,
  rutas absolutas y `\?\`;
- la ruta REAL del sistema debe quedar dentro de la carpeta y no ser protegida;
- en las escrituras, ningún tramo puede ser un enlace o una unión.

Protegidos para leer y para escribir:
- `.env*` (salvo `.example`/`.sample`/`.template`), `.git` (también anidado), `data/` y `node_modules/` en la raíz;
- `.npmrc`, `.ssh`, `.aws`, `.claude`, `secrets/`, `.netrc`, `.git-credentials`, `.pypirc` y `.envrc`;
- claves privadas.

Además, ningún git que lance el Portal ejecuta hooks del repositorio (`GIT_CONFIG_*` → `core.hooksPath` vacío): un hook
versionado editado por un agente no corre en el equipo. Prueba `security-paths.test.ts`:
- usa marcadores sintéticos que el detector de secretos no reconoce, los nombres cortos REALES del volumen, una unión
  real y un flujo alternativo real;
- recorre cada alias por cada camino (read_file, search, diff, lista, contexto del pipeline, escritura, HTTP codificado);
- incluye escrituras a través de una unión y un hook versionado, este con control positivo.

Contra el código anterior falla, por ejemplo con «.env » (espacio final), que la validación de escritura aceptaba.

**Tope de llamadas a la suscripción.** Se comprueba antes de CADA ejecución de la CLI contra el registro duradero
`claude_code_runs`, en el mismo tramo síncrono que la registra, así que no hay carreras. Cuentan también las fallidas y las
interrumpidas. Cubre reintentos, continuaciones, QA, Gauntlet, encargos de análisis, evaluaciones, pruebas manuales y la
consola. Antes, los encargos de análisis llegaban sin proceso y su tope no se aplicaba. Se aplica el tope del proceso y el
del lote. Al alcanzarlo no se llama, no se reintenta ni se cede a la API, y la parada ofrece ampliar el tope.

**Gauntlet en la planificación y diagnóstico.** Se describen en la fase C; quedan completados con:
- «Seguir con este plan (decides tú)» tras una pausa de la revisión, sin repetir el plan ni la revisión;
- un criterio no cubierto (con evidencia) que cuenta como brecha bloqueante;
- un registro que ya no se pierde al guardar.

**Encargos.** Pedir cambios con una versión aplicada sin integrar exige confirmar su descarte (como iterar una historia).
Se retiran el worktree y la rama sin integrar. Antes, la segunda ejecución fallaba porque la rama seguía en uso.

**Revisión independiente (tercera).** 3 hallazgos mayores y 6 menores. Corregidos:
- el tope no se aplicaba a los encargos de análisis;
- las escrituras seguían enlaces fuera del worktree;
- no había forma de seguir tras la pausa del plan;
- el registro y los eventos de la revisión se perdían;
- el descarte de rama no pedía confirmación;
- la protección de escritura era estrecha y faltaban nombres de credenciales;
- la cobertura «no» se ignoraba y la prueba de revisión del plan no distinguía el plan revisado;
- la estimación suponía un solo diagnóstico.

**Pendientes:**
- si falla la llamada de diagnóstico, la evaluación de esa ronda se vuelve a pagar al continuar;
- la cita de evidencia del revisor del plan no se comprueba contra el texto del plan;
- el paso del planificador muestra solo el coste de su última llamada (el total del proceso es correcto).

**Docker.** Ver «Verificación» en `IMPLEMENTATION_HANDOFF.md`.

**Cuarta revisión (verificación de `79d4521`).**

Confirmó: escrituras sin enlaces, sin hooks, confirmación del descarte y el registro que ya no se pierde.

Defectos nuevos, corregidos con prueba:
- «Seguir con este plan» podía revivir una iteración RECHAZADA (con una llamada de implementación pagada) y no
  comprobaba si había otro proceso en marcha ni si el equipo podía ejecutar. Ahora rechaza lo integrado o rechazado,
  aplica las mismas comprobaciones que «continuar», conserva la actividad anterior y devuelve la guía.
- Las evaluaciones organizativas no tenían tope de llamadas: se les asigna al crearlas.
- La lista de credenciales bloqueaba también acciones del propietario (su corrección externa, resolver un conflicto).
  Ahora solo bloquea las escrituras de los agentes; la lista base (.git, data/, node_modules/, .env, claves) sigue
  aplicándose a todo.
- La prueba manual (una llamada que pide el propietario) quedaba bloqueada si la ejecución había agotado su tope: no
  cuenta para ese tope.
- Otros: `.env-dist` es una plantilla como `.env.dist`; la casilla de descarte se reinicia; las carpetas temporales sin
  hooks se retiran al salir.

Sin corregir: los enlaces duros no se detectan. Bajo Docker no dan salida al agente fuera del worktree.
