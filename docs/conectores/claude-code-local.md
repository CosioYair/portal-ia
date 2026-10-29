# Conector «Claude Code — Local»

Fecha: 28 de octubre de 2026 · Claude Code instalado en este equipo: 2.1.311 (npm, `claude.exe` nativo).

Permite que agentes concretos del Portal ejecuten los pasos de un proceso autorizado con la instalación de Claude Code
del propietario y su suscripción de Claude. Es un **backend de ejecución**: el agente conserva su identidad, papel,
permisos, conocimiento e historial, y el resultado vuelve a él. El Portal sigue a cargo de la organización, los permisos,
la memoria, el flujo, el worktree, la verificación en Docker, QA y la aprobación del propietario.

## 1. Estado

| | |
|---|---|
| Implementado | Detección sin modelo, activación con autorización, proyectos y agentes autorizados, CLI gestionada (`claude -p`), puente MCP de solo lectura, consola del propietario por MCP, integración en el pipeline, registro de uso aparte del gasto, pausa por límite, alternativa por API solo autorizada, interfaz |
| Verificado con CLI simulada | Todo lo anterior: `claude-code-connector.test.ts` (10), `claude-code-execution.test.ts` (15, con Docker real), y una instancia aislada con Chromium (16 de 16) |
| Verificado con la CLI real, SIN llamar al modelo (§11) | `--restricted` combinado con todas las opciones gestionadas; `auth status` en modo restringido (`claude.ai`, plan `max`); `apiKeySource: "none"`; herramientas reales (`StructuredOutput` + las 5 del puente); puente conectado; modelo `haiku` → `claude-haiku-5-5` |
| Verificado con la suscripción real | **Nada todavía**: ninguna llamada al modelo. Lo hará la prueba de humo autorizada (§9) |
| No verificado | La respuesta real del modelo, el registro de uso real y que no haya cargos de API (eso último solo se comprueba en claude.ai y en la consola de la API) |

## 2. Investigación (documentación oficial, consultada el 28/10/2026)

**CLI** (code.claude.com/docs/en/cli-reference, …/headless, …/permission-modes, …/authentication):
- `claude -p` es el modo no interactivo documentado (Agent SDK por CLI). Admite `--output-format stream-json`, `--json-schema` (devuelve `structured_output`), `--max-turns`, `--model`, `--system-prompt-file` y `--no-session-persistence`.
- `--tools ""` desactiva todas las herramientas integradas. `--strict-mcp-config` usa solo los servidores de `--mcp-config`. `--allowedTools` preaprueba herramientas.
- `--permission-mode dontAsk`: «auto-denies every tool call that would otherwise prompt». `--permission-prompts none` (≥ 2.1.259): nadie responde y se deniega.
- `claude auth status` devuelve JSON. `authMethod` ∈ `none`, `claude.ai`, `oauth_token`, `api_key`, `api_key_helper`, `third_party`; sale con código 1 si no hay sesión. La 2.1.311 también informa `subscriptionType` y `apiProvider`.
- Precedencia de credenciales: proveedores en la nube → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → sesión de suscripción. «In non-interactive mode (-p), the key is always used when present.»
- `--bare` «never reads OAuth credentials»: **no sirve para la suscripción**. Sin `--bare`, `-p` carga hooks, plugins y `CLAUDE.md` del usuario.
- `stream-json` emite:
  - `system/init` con `apiKeySource`, `tools` y `mcp_servers`;
  - `system/api_retry`;
  - `rate_limit_event`: `status` allowed / allowed_warning / rejected, `resetsAt` y `errorCode: credits_required`;
  - `result` con `usage`, `num_turns`, `duration_ms`, `total_cost_usd` y `permission_denials`.
- `total_cost_usd` es una **estimación del cliente**, no la factura. SIGTERM termina con código 143.

**Soporte de Anthropic:**
- *Use the Claude Agent SDK with your Claude plan* (15036540): con la sesión del plan, el Agent SDK y `claude -p` «draw from your subscription limits». El 15/06/2026 se pausaron los cambios anunciados: «nothing has changed». Desde el 07/10/2026, Max y Team incluyen créditos mensuales de API, que solo cubren `claude -p` con una clave de una organización de Console vinculada.
- *Log in to your Claude account* (13189465):
  - las suscripciones son para el uso normal de las aplicaciones nativas, Claude Code incluido;
  - para herramientas de terceros, lo preferido es una clave de API;
  - Anthropic «may … allow» ciertas herramientas de terceros y se reserva cobrarlas a los «usage credits»;
  - está prohibido falsear la identidad ante sus servidores y «route third-party traffic against subscription limits».
- *Manage API key environment variables* (12304248): una `ANTHROPIC_API_KEY` en el entorno tiene prioridad sobre la suscripción y se factura a tarifa de API. Para comprobarlo se usa `/status`.

## 3. Método elegido y compatibilidad

- **Elegido:**
  - el binario oficial `claude`, en modo `-p` documentado, como subproceso local del propietario y para su propio trabajo;
  - un servidor MCP local por stdio, registrado por las vías oficiales (`--mcp-config` en las ejecuciones gestionadas y `claude mcp add` en la consola del propietario).
- **Descartado:**
  - leer, copiar o reutilizar las credenciales OAuth (`.credentials.json`);
  - `setup-token`;
  - llamar a la API con la sesión de la suscripción;
  - hacerse pasar por el cliente oficial;
  - `--bare`, `bypassPermissions` y `--dangerously-skip-permissions`;
  - el paquete del Agent SDK, que sería una dependencia más sobre la misma CLI.
- **Zona gris (declarada, no resuelta por el Portal):** el Portal es una herramienta propia que orquesta Claude Code. Anthropic puede considerarla «de terceros» y cobrar ese uso a los usage credits si el uso adicional está activado. El Portal no puede verlo. Por eso nunca dice que sea gratis, nunca activa uso adicional, avisa en la interfaz y pide revisar claude.ai → Ajustes → Uso. Si Anthropic reactiva los cambios pausados, hay que revisar el conector antes de usarlo.

## 4. Arquitectura

- **Capa B · ejecución** (`services/claudeCode/`):
  - `detect.ts`: CLI (PATH, instalador nativo, lanzador de npm resuelto a su `claude.exe` sin shell) y sesión con `auth status`, en el mismo entorno que una ejecución;
  - `cli.ts`: una llamada de agente con `claude -p`;
  - `backend.ts`: puerta de autorización, concurrencia, duplicados y registro;
  - `settings.ts` y `env.ts`.
- **Integración:** `callAgentStep` (`storyPipeline.ts`), por donde pasan TODAS las llamadas de los pasos de una historia: plan, unidades, continuaciones, reparaciones, correcciones, consultas y QA. No hay otro orquestador.
- **Capa A · puente MCP:**
  - `scripts/portal-mcp.mjs` (sin dependencias) habla con `/api/bridge/v1/*` (`routes/claudeCode.ts`, `services/claudeCode/bridge.ts`);
  - herramientas: `portal_whoami`, `portal_list_tasks`, `portal_claim_task`, `portal_task_context`, `portal_list_files`, `portal_read_file`, `portal_knowledge`, `portal_report_progress`, `portal_submit_result` y `portal_report_blocker`;
  - ni shell, ni escritura de archivos, ni base de datos.
- **Dos modos por agente:**
  - `claude-code`: el Portal lanza la CLI y la ejecución recibe un token de UN uso para leer su tarea;
  - `claude-code-terminal`: la tarea espera en la cola de la consola del propietario, que la toma, la atiende y entrega el resultado por MCP.

  En ambos casos el resultado es texto que el motor valida como el de cualquier proveedor: lo aplica en el worktree aislado, lo verifica en Docker y QA lo evalúa con evidencia.
- **Datos (aditivos, versión de esquema 0.13, copia de `data/` antes de migrar):**
  - `claude_code_runs` en cada espacio: agente, paso, modelo, estado, origen, tokens, turnos, duración, equivalente estimado, límites y progreso;
  - `process_steps.backend`;
  - `claude_code_workers` en la plataforma: el token, solo como hash;
  - ajustes en `settings`.

## 5. Seguridad

- **Entorno:** lista blanca mínima. `ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN` y las variables de nube nunca se reenvían; el Portal solo informa de sus nombres.
- **Doble barrera de facturación:**
  1. `auth status` antes de cada ejecución: debe ser `claude.ai` u `oauth_token` con `firstParty`;
  2. `apiKeySource` del arranque: si indica clave de API, se detiene antes de seguir.
- **Herramientas:** `--tools ""`, `--strict-mcp-config`, `dontAsk` y `--permission-prompts none`. Si la sesión expone herramientas que no son del puente, se detiene.
- **Aislamiento de la ejecución:**
  - carpeta de trabajo temporal vacía, que se borra al terminar;
  - sin persistencia de sesión;
  - un plazo por ejecución;
  - la cancelación mata el árbol de procesos (`taskkill /T /F`);
  - nada de reintentos automáticos.
- **Puente:**
  - el alcance sale del token (espacio, agentes, tarea), nunca de los argumentos;
  - lo ajeno da 404;
  - solo lectura;
  - rutas protegidas: `.env`, `data/`, `.git`, `node_modules`, `.claude`, `.ssh`, claves;
  - enlaces que salen de la carpeta, binarios y archivos con secretos, denegados;
  - un resultado con secretos se rechaza;
  - las consolas se revocan al instante.
- **El Portal aplica los cambios:** Claude Code no escribe en el repositorio ni en el worktree. Nunca integra, reinicia ni publica.

**Riesgos residuales:**
- No es aislamiento del sistema operativo: la CLI corre con tu usuario y las restricciones son las de Claude Code (`--tools ""` y permisos). Un fallo de Claude Code podría saltárselas.
- ~~Sin `--bare` se cargan tus hooks, plugins y `~/.claude/CLAUDE.md`~~. Resuelto en §11: con `--restricted` y `CLAUDE_CODE_DISABLE_CLAUDE_MDS` no se cargan; solo quedan los 3 plugins incluidos en Claude Code.
- La **consola** es tu sesión normal de Claude Code, con las herramientas y la autenticación que tú tengas:
  - el Portal no puede verificar su facturación («No verificado»); avisa si ve credenciales en su entorno;
  - no puede impedir que edites a mano.
- El token de la consola queda en tu `~/.claude.json` (alcance de usuario). Cualquier proceso local con ese token actúa dentro de su alcance.
- Sin datos de cuota restante: solo los avisos `rate_limit_event`. La presencia, la cola y los duplicados viven en memoria (un solo servidor); tras reiniciar, las ejecuciones «en curso» quedan «interrumpidas».
- Formatos de la CLI que pueden cambiar. Las pruebas usan una CLI simulada.

## 6. Uso y costos

- Con la suscripción, el paso cuesta **0 USD del presupuesto de API**: la interfaz dice «sin cargo a la API» y el gasto del proceso no cambia.
- Se registran aparte:
  - tokens (entrada + caché, salida), turnos, duración, modelo, agente y origen;
  - el **equivalente estimado por API** (`total_cost_usd`), rotulado «estimación, NO es un cargo».
- La consola no informa de tokens.

## 7. Fallos y alternativas

| Situación | Qué hace el Portal |
|---|---|
| Límite de la suscripción (`rejected` o 429) | Pausa `subscription_limit` con la hora de renovación; lo hecho se conserva. «Continuar cuando se renueve el límite» no pide presupuesto |
| `credits_required` | Igual, y aclara que no compra créditos |
| Sin sesión, facturación por API, CLI ausente, consola desconectada, proyecto o agente no autorizado | Pausa con el motivo; no cambia de origen |
| Proyecto sin autorizar, antes de empezar o al continuar | «Autorizar la ejecución» y «Continuar» se rechazan (409 `backend_not_ready`) sin eventos ni pasos. La historia ofrece «Autorizar «proyecto» para Claude Code», que guarda la autorización y la comprueba en la configuración guardada. Solo entonces ofrece «Continuar la operación pendiente», sin correcciones nuevas |
| Plazo agotado, cancelación, salida mal formada, error de la CLI | Error claro, paso fallido, sin reintento automático |
| Turnos agotados (`error_max_turns`) | `CLAUDE_CODE_MAX_TURNS_EXHAUSTED`, pausa `max_turns`. No es un fallo de conexión, así que no se ofrece «repetir la llamada». Se registra el uso (tokens, turnos y herramientas usadas) y se conserva lo hecho. El siguiente intento, con tu autorización y los mismos límites, es acotado: lleva el contenido de los archivos relacionados e indica cuánto enviará. Una segunda vez en la misma unidad no se insiste: «volver a verificar sin IA». El límite de turnos no se sube de forma global |

La alternativa por la API del agente solo actúa si la autorizaste en «Si la suscripción no está disponible». Entonces factura y descuenta del presupuesto del proceso, y el paso queda marcado como «alternativa autorizada».

## 8. Activación (en tu instalación, con tu autorización)

1. Reconstruir y reiniciar el Portal (necesario para el código nuevo; la versión de esquema 0.13 hace una copia de `data/` al arrancar).
2. Proveedores → «Claude Code — Local» → «Comprobar instalación y sesión». Debe decir «Claude Code — Suscripción · plan max».
3. Marcar la autorización y pulsar «Activar».
4. Elegir los proyectos autorizados y el backend de cada agente (cada cambio pide confirmación).
5. Opcional, consola: asignar «Claude Code (tu consola)» a un agente, «Crear consola» y ejecutar en una terminal las órdenes que se muestran: `mkdir` y `cd` a la carpeta dedicada, y `claude mcp add --scope local portal-ia …`. El token aparece una sola vez y caduca en 30 días. Abre Claude Code en esa carpeta y pide «muéstrame mis tareas del Portal».

Al arrancar, nada se ejecuta solo: el conector empieza desactivado y una historia solo corre cuando la autorizas.

## 9. Prueba de humo con la suscripción real (propuesta, sin ejecutar)

Una sola ejecución gestionada, de solo lectura, sin datos del proyecto y sin escribir nada:

1. Comprobar sesión (sin modelo): «Comprobar instalación y sesión» → `claude.ai` / `max`. En una terminal, `claude auth status --text` y `/status` dentro de Claude Code.
2. Anotar la hora y pulsar «Prueba de humo (1 llamada real)» en Proveedores → Claude Code — Local, que pide confirmación (`POST /api/claude-code/smoke-test` con `authorized: true`). Hace:
   - UNA llamada por el MISMO adaptador que las ejecuciones: `claude -p`, modelo `haiku`, `--max-turns 1`, `--tools ""`, sin puente ni datos del proyecto, texto «Responde exactamente con la palabra OK.»;
   - comprueba antes la sesión y, al arrancar, el `apiKeySource` real (se detiene si indicara facturación por API).

   Devuelve la respuesta, la sesión, el origen de la clave, los tokens y «presupuesto de API descontado: 0», y la deja en «Uso de hoy» (llega al Portal). No necesita activar el conector ni autorizar proyectos o agentes, y no escribe nada fuera del Portal.
3. Si algo falla (opción rechazada por la CLI, herramientas inesperadas, origen de la clave desconocido), el error lo dice y no se reintenta.
4. Comprobar la facturación por las vías oficiales:
   - claude.ai → Ajustes → Uso: el uso de la sesión aparece en tu plan; revisa si el uso adicional está activado;
   - console.anthropic.com → Usage / Billing de tu organización de API: no debe aparecer consumo a la hora de la prueba.

   Una respuesta correcta de la CLI **no prueba** por sí sola que no haya cargos de API.

Si la CLI real rechaza alguna opción o lista herramientas inesperadas, la ejecución se detiene antes de llamar al modelo y se ajusta el conector. Nada se elude.

## 11. Revisión de seguridad previa a la activación (28/10/2026)

### Modo restringido

Documentación oficial (`--restricted`, ≥ 2.1.248):
- quita las herramientas que ejecutan código y WebFetch;
- ignora los ajustes de usuario, proyecto y locales (solo valen los gestionados y `--settings`);
- limita las herramientas de archivos a las carpetas de trabajo;
- rechaza bypassPermissions;
- con `--strict-mcp-config`, tampoco carga otros servidores MCP.

A diferencia de `--bare`, la documentación no dice que deje de leer la sesión OAuth.

Comprobado en la CLI 2.1.311 sin llamar al modelo, con un mensaje en blanco: la documentación dice que «nothing was sent to the model» y el resultado fue 0 turnos, 0 tokens, 0 USD.

| Comprobación | Resultado |
|---|---|
| `claude --restricted auth status --json` | `loggedIn: true`, `claude.ai`, `firstParty`, plan `max` |
| Opciones gestionadas + `--restricted` | Aceptadas todas, también `--system-prompt-file` y `--max-turns` |
| `apiKeySource` del init | `"none"`: sin clave de API, sesión de la suscripción |
| Herramientas | Solo `StructuredOutput` (por `--json-schema`) y las 5 del puente: `portal_task_context`, `portal_list_files`, `portal_read_file`, `portal_knowledge`, `portal_report_progress` |
| Servidores MCP | Solo `portal`, `connected` |
| Plugins | Solo los 3 incluidos en Claude Code (`cc-plugin-agents-md`, `cc-plugin-telemetry`, `cc-plugin-plugin-authoring`). Los tuyos no se cargan |
| Subagentes | Los 5 incluidos; inutilizables, porque no hay herramienta Agent |
| Modo seguro (`CLAUDE_CODE_SAFE_MODE`) | Descartado: quita también el servidor de `--mcp-config` (sin puente no hay lectura del repositorio) y no quita los plugins incluidos |

### Hallazgos y correcciones

1. **Error real.** Con `--json-schema`, la CLI expone `StructuredOutput`, y la comprobación de herramientas lo trataba como ajeno: todas las revisiones de QA reales se habrían detenido. Ahora se admite solo cuando se pidió esquema (prueba de regresión).
2. **La comprobación del init no era una barrera.** La CLI solo emite `init` al leer el primer mensaje, así que el encargo ya estaba enviado. Ahora:
   - `--input-format stream-json`: primero un mensaje en blanco, que no llega al modelo;
   - se comprueba el `init`: origen de la clave, herramientas, modo de permisos `dontAsk` y el puente `connected`;
   - el encargo va en un segundo mensaje de la misma sesión;
   - si el mensaje en blanco informara turnos o tokens, se detiene.
3. **`apiKeySource`:** lista blanca, solo `"none"`. Cualquier otro valor, conocido o no, detiene antes del encargo.
4. **Ajustes personales:** `--restricted` en la ejecución y en `auth status`. Tu `env`, `apiKeyHelper`, hooks y plugins de usuario no entran y no pueden reintroducir la facturación por API. CLI anterior a 2.1.248: bloqueada, «actualiza Claude Code».
5. **Entorno**, además de la lista blanca sin credenciales:
   - `CLAUDE_CODE_RESTRICTED=1`;
   - `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`: ningún CLAUDE.md, ni de usuario, ni de proyecto, ni de memoria;
   - `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`;
   - `ENABLE_CLAUDEAI_MCP_SERVERS=false`: sin los conectores de claude.ai;
   - `DISABLE_AUTOUPDATER=1`.
6. **Sonda en la detección:** al comprobar o activar se repite la sonda sin modelo con la configuración exacta. Si no la supera, el origen queda «No verificado» y no se ejecuta.
7. **Consolas:** el token caduca (30 días por defecto, de 1 a 90) y se registra con `--scope local` en una carpeta dedicada (`%USERPROFILE%\PortalIA-consola\<espacio>`). El puente ya no aparece en todos tus proyectos de Claude Code.
8. **Peticiones hostiles al puente:** rutas codificadas (`%2e%2e`, `%5C%5C`, `%00`, `C:\`), otra tarea por la URL, campos de más en el cuerpo, token en la URL o con otro esquema, JSON-RPC mal formado, herramientas inexistentes y argumentos de tipo incorrecto: todo rechazado (pruebas).

### Configuración exacta de una ejecución gestionada

```text
claude --restricted -p --output-format stream-json --verbose --model <modelo del agente>
  --system-prompt-file <temporal>/system-prompt.md --tools "" --permission-mode dontAsk --max-turns <N>
  --no-session-persistence --disable-slash-commands --strict-mcp-config --permission-prompts none
  [--mcp-config <temporal>/mcp.json --allowedTools mcp__portal__portal_task_context,…]   (lectura por el puente)
  [--json-schema <esquema>]                                                               (veredicto de QA)
  --input-format stream-json
```

- Carpeta de trabajo: temporal y vacía, borrada al terminar.
- Entorno: lista blanca + los controles del punto 5.
- stdin: mensaje en blanco → comprobación del init → encargo.

### Lo que la revisión deja como riesgo (sin cambio)

- **API local del Portal sin autenticación** (diseño local de siempre): cualquier proceso local puede llamarla. Las ejecuciones gestionadas no pueden: no tienen Bash ni WebFetch. Tu **consola** sí podría, porque es tu sesión normal de Claude Code con tus herramientas. El puente no amplía nada, pero la consola no está aislada de tu equipo. Úsala para tareas que atiendes tú.
- **Política de ejecución:** cada llamada pasa por `requirePolicy('ai_call')` en `callAgentStep`, también las de la consola. Lo que entrega la consola es texto que el motor valida y aplica en el worktree, verifica en Docker y somete a QA, igual que lo de la API.
- Siguen cargándose los 3 plugins incluidos en Claude Code (uno es de telemetría de Anthropic).

## 10. Pruebas (CLI y proveedor simulados)

| Requisito | Prueba |
|---|---|
| 1-5 | `claude-code-connector.test.ts`: no instalada, instalada, suscripción, desconocido, conflicto de API |
| 6-7 | conector: consola desconectada, conectada y desconectada al cerrarse |
| 8, 21, 22, 24, 25 | `claude-code-execution.test.ts` «8 · punta a punta» |
| 9-12 | conector: sin token y tokens ajenos, otra empresa, otro proyecto, rutas protegidas |
| 13-17 | ejecución: estructurado, mal formado, plazo, cancelación, límite |
| 18 | «17-18 · límite en el pipeline» y «alternativa SOLO autorizada» |
| 19 | reinicio en otro proceso |
| 20 | duplicados y cola |
| 23 | Docker real |
| Consola | «consola del propietario» |
