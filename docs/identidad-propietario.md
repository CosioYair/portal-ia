# Identidad del propietario en todo el Portal

**Qué cambia.** Antes, la sesión del propietario protegía solo la revisión del proyecto y las operaciones del Asistente:
el resto de la API (rechazar una iteración, cerrar un lote, publicar main, cambiar el remoto, reconstruir y reiniciar el
Portal, credenciales…) seguía aceptando cualquier petición local. Ahora hay **una sola regla en el servidor**: todo cambio
por la API exige la sesión del propietario. Mismo mecanismo, sin un segundo sistema: el código de un solo uso fuera de las
páginas y la sesión de este navegador (`services/ownerSession.ts`; ver `docs/mantenimiento-gobernado.md` §10).

## 1. La regla

- **Todo `POST`, `PUT`, `PATCH` y `DELETE` de `/api/*`** pasa por un único gancho `onRequest` (`apps/server/src/app.ts`)
  ANTES de leer el cuerpo, tomar arriendos o tocar nada. Se decide por la **ruta registrada** (no por la dirección
  escrita): mayúsculas, barras de más, codificaciones o rutas nuevas olvidadas no se la saltan. Exige:
  - si hay cuerpo, JSON o un archivo en flujo (`application/octet-stream`, las subidas); nunca formulario, texto o
    multipart, los tipos que otra página puede enviar sin permiso del navegador (415);
  - la dirección del propio Portal: el puerto del `Host` es aquel en el que llegó la petición (por la interfaz de
    desarrollo de Vite, 5173, no: 403 `foreign_port`), o una dirección EXACTA de `PORTAL_ALLOWED_HOSTS`;
  - el mismo origen si trae `Origin` (otra página local: 403 `foreign_origin`);
  - una sesión válida en `X-Portal-Owner` (401 `owner_required`).
- **Abiertas (12)**, con su propia identificación o sin efectos: vincular y desvincular este navegador (el código de un
  solo uso; JSON y mismo origen), el **puente de los agentes** (`/api/bridge/v1/*`: un token por tarea o trabajador, con
  su alcance) y **dos lecturas por POST**: la vista previa de un lote y la estimación de un encargo (calculan; no guardan
  nada ni llaman a la IA, y lo que devuelven ya se ve por las lecturas).
- **Leer (GET) no pide nada**: consultar el Portal no exige vincular. Sin CORS: una página de otro origen (otro puerto
  local incluido) no puede leer las respuestas.
- **Sin vincular**, todas las pantallas muestran un aviso; cualquier cambio abre «Vincular este navegador como
  propietario» (un diálogo encima de todo, también de otro diálogo) sin perder lo escrito; al vincular, el foco vuelve a
  la acción que querías hacer.

## 2. Inventario y clasificación

273 rutas de la API: 90 lecturas y 183 cambios; **171 exigen la sesión** y 12 son abiertas. Generado a partir de las rutas
registradas (`app.routeList`): `test/politica-propietario.test.ts` recorre TODAS las que cambian algo (también las que se
añadan después) y comprueba la lista exacta de abiertas, así que ninguna ruta nueva queda abierta sin decidirlo.

| Impacto | Rutas | Exigen la sesión |
|---|---:|---:|
| **0** · Abiertas: identificación propia (vincular este navegador; el puente de los agentes con su token) y dos lecturas por POST | 12 | 0 |
| **A** · Repositorio, GitHub y el propio Portal (irreversible o hacia fuera) | 25 | 25 |
| **B** · Credenciales, motores y permisos (quién y con qué se ejecuta) | 18 | 18 |
| **C** · Gasta IA o cuota, o pone agentes a trabajar | 51 | 51 |
| **D** · Cierra, cancela, descarta o borra | 32 | 32 |
| **E** · Organización, configuración y contenido | 45 | 45 |
| Lecturas (GET) | 90 | 0 (no cambian nada) |

<details><summary><strong>0</strong> · Abiertas: identificación propia (vincular este navegador; el puente de los agentes con su token) y dos lecturas por POST (12)</summary>

- `POST /api/bridge/v1/bye` — **abierta** (identificación propia)
- `POST /api/bridge/v1/heartbeat` — **abierta** (identificación propia)
- `POST /api/bridge/v1/hello` — **abierta** (identificación propia)
- `POST /api/bridge/v1/tasks/:id/blocker` — **abierta** (identificación propia)
- `POST /api/bridge/v1/tasks/:id/claim` — **abierta** (identificación propia)
- `POST /api/bridge/v1/tasks/:id/progress` — **abierta** (identificación propia)
- `POST /api/bridge/v1/tasks/:id/result` — **abierta** (identificación propia)
- `POST /api/owner/logout` — **abierta** (identificación propia)
- `POST /api/owner/pair` — **abierta** (identificación propia)
- `POST /api/owner/pairing` — **abierta** (identificación propia)
- `POST /api/workspaces/:slug/delegations/estimate` — **abierta** (identificación propia)
- `POST /api/workspaces/:slug/projects/:projectId/batches/preview` — **abierta** (identificación propia)

</details>

<details><summary><strong>A</strong> · Repositorio, GitHub y el propio Portal (irreversible o hacia fuera) (25)</summary>

- `POST /api/portal/integration`
- `POST /api/system/restart`
- `POST /api/system/update`
- `POST /api/workspaces/:slug/agents/:id/folder/adopt`
- `POST /api/workspaces/:slug/agents/:id/folder/discard`
- `POST /api/workspaces/:slug/agents/:id/folder/restore`
- `POST /api/workspaces/:slug/agents/:id/source/adopt`
- `POST /api/workspaces/:slug/agents/:id/source/restore`
- `POST /api/workspaces/:slug/maintenance/plans/:id/execute`
- `POST /api/workspaces/:slug/maintenance/plans/:id/reject`
- `POST /api/workspaces/:slug/processes/:id/apply`
- `POST /api/workspaces/:slug/processes/:id/integration/prepare`
- `POST /api/workspaces/:slug/processes/:id/integration/resolve`
- `POST /api/workspaces/:slug/processes/:id/merge`
- `POST /api/workspaces/:slug/processes/:id/previews`
- `DELETE /api/workspaces/:slug/processes/:id/previews/:previewId`
- `POST /api/workspaces/:slug/processes/:id/publish`
- `POST /api/workspaces/:slug/processes/:id/recover`
- `POST /api/workspaces/:slug/processes/:id/reject`
- `POST /api/workspaces/:slug/projects/:projectId/maintenance/plans`
- `POST /api/workspaces/:slug/projects/:projectId/repository`
- `POST /api/workspaces/:slug/projects/:projectId/repository/init-main`
- `POST /api/workspaces/:slug/projects/:projectId/repository/normalize-eol`
- `POST /api/workspaces/:slug/projects/:projectId/repository/publish-main`
- `POST /api/workspaces/:slug/projects/:projectId/repository/remote`

</details>

<details><summary><strong>B</strong> · Credenciales, motores y permisos (quién y con qué se ejecuta) (18)</summary>

- `PUT /api/budgets/:level/:id`
- `PUT /api/claude-code/settings`
- `PUT /api/harnesses/codex`
- `PUT /api/providers/:id/credential`
- `DELETE /api/providers/:id/credential`
- `PUT /api/providers/:id/default-model`
- `PUT /api/providers/:id/settings`
- `POST /api/providers/:id/verify`
- `PUT /api/workspaces/:slug/agents/:id/backend`
- `PUT /api/workspaces/:slug/agents/:id/harness`
- `POST /api/workspaces/:slug/agents/:id/proposals/:pid/apply`
- `PUT /api/workspaces/:slug/agents/:id/source/grants`
- `PUT /api/workspaces/:slug/claude-code/projects`
- `POST /api/workspaces/:slug/claude-code/workers`
- `DELETE /api/workspaces/:slug/claude-code/workers/:id`
- `POST /api/workspaces/:slug/org-evaluations/:id/proposals/:proposalId`
- `POST /api/workspaces/:slug/org-evaluations/:id/proposals/:proposalId/reapply`
- `PUT /api/workspaces/:slug/projects/:projectId/gauntlet`

</details>

<details><summary><strong>C</strong> · Gasta IA o cuota, o pone agentes a trabajar (51)</summary>

- `POST /api/assistant/messages`
- `DELETE /api/assistant/messages`
- `POST /api/claude-code/smoke-test`
- `POST /api/workspaces/:slug/agents/:id/actions/:actionId/confirm`
- `POST /api/workspaces/:slug/agents/:id/actions/:actionId/reroute`
- `POST /api/workspaces/:slug/agents/:id/batches/:batchId/cancel`
- `POST /api/workspaces/:slug/agents/:id/batches/:batchId/deliverable`
- `POST /api/workspaces/:slug/agents/:id/batches/:batchId/pause`
- `POST /api/workspaces/:slug/agents/:id/batches/:batchId/resume`
- `POST /api/workspaces/:slug/agents/:id/batches/:batchId/retry`
- `POST /api/workspaces/:slug/agents/:id/batches/:batchId/start`
- `POST /api/workspaces/:slug/agents/:id/chat`
- `POST /api/workspaces/:slug/agents/:id/documents`
- `POST /api/workspaces/:slug/agents/:id/documents/:jobId/process`
- `POST /api/workspaces/:slug/agents/:id/memory/:lessonId/verify`
- `POST /api/workspaces/:slug/agents/:id/tasks`
- `POST /api/workspaces/:slug/agents/draft`
- `POST /api/workspaces/:slug/agents/import`
- `POST /api/workspaces/:slug/agents/wizard`
- `POST /api/workspaces/:slug/assignments/:id/authorize`
- `POST /api/workspaces/:slug/assignments/:id/changes`
- `POST /api/workspaces/:slug/batches/:id/items/:itemId/iterate`
- `POST /api/workspaces/:slug/batches/:id/items/:itemId/reopen`
- `POST /api/workspaces/:slug/batches/:id/items/:itemId/restore`
- `POST /api/workspaces/:slug/batches/:id/items/:itemId/retry`
- `POST /api/workspaces/:slug/batches/:id/pause`
- `POST /api/workspaces/:slug/batches/:id/policy`
- `POST /api/workspaces/:slug/batches/:id/resume`
- `POST /api/workspaces/:slug/delegations`
- `POST /api/workspaces/:slug/departments/:id/requests`
- `POST /api/workspaces/:slug/org-evaluations`
- `POST /api/workspaces/:slug/processes/:id/accept-plan`
- `POST /api/workspaces/:slug/processes/:id/authorize`
- `POST /api/workspaces/:slug/processes/:id/backlog-ops/apply`
- `POST /api/workspaces/:slug/processes/:id/claude-code/fix`
- `POST /api/workspaces/:slug/processes/:id/continue`
- `POST /api/workspaces/:slug/processes/:id/convert-to-analysis`
- `POST /api/workspaces/:slug/processes/:id/detect-lessons`
- `POST /api/workspaces/:slug/processes/:id/external-correction`
- `POST /api/workspaces/:slug/processes/:id/manual-test/generate`
- `POST /api/workspaces/:slug/processes/:id/retry`
- `POST /api/workspaces/:slug/processes/:id/runtime-check`
- `POST /api/workspaces/:slug/processes/:id/verify`
- `POST /api/workspaces/:slug/processes/:id/verify/install-and-retry`
- `POST /api/workspaces/:slug/projects/:projectId/assessment`
- `POST /api/workspaces/:slug/projects/:projectId/backlog/:id/execute`
- `POST /api/workspaces/:slug/projects/:projectId/batches`
- `POST /api/workspaces/:slug/projects/:projectId/gauntlet/evaluator`
- `POST /api/workspaces/:slug/stories/:id/iterate`
- `POST /api/workspaces/:slug/stories/:id/messages`
- `POST /api/workspaces/:slug/stories/:id/messages/:messageId/apply`

</details>

<details><summary><strong>D</strong> · Cierra, cancela, descarta o borra (32)</summary>

- `POST /api/assistant/conversations/:id/decisions/:did/:action`
- `POST /api/assistant/messages/:id/local/:index/:decision`
- `POST /api/assistant/messages/:id/operations/:opId/:decision`
- `POST /api/assistant/messages/:id/resolve`
- `POST /api/owner/logout-all`
- `DELETE /api/workspaces/:slug/agents/:id`
- `POST /api/workspaces/:slug/agents/:id/actions/:actionId/dismiss`
- `DELETE /api/workspaces/:slug/agents/:id/attachments/:attId`
- `POST /api/workspaces/:slug/agents/:id/memory/:lessonId/retire`
- `POST /api/workspaces/:slug/agents/:id/proposals/:pid/reject`
- `POST /api/workspaces/:slug/assignments/:id/accept`
- `POST /api/workspaces/:slug/assignments/:id/cancel`
- `DELETE /api/workspaces/:slug/backlog/:id`
- `POST /api/workspaces/:slug/backlog/:id/discard`
- `POST /api/workspaces/:slug/backlog/:id/done`
- `POST /api/workspaces/:slug/backlog/:id/reset`
- `POST /api/workspaces/:slug/batches/:id/accept`
- `POST /api/workspaces/:slug/batches/:id/cancel`
- `POST /api/workspaces/:slug/batches/:id/items/:itemId/cancel`
- `POST /api/workspaces/:slug/batches/:id/items/:itemId/postpone`
- `POST /api/workspaces/:slug/batches/:id/items/:itemId/reject`
- `POST /api/workspaces/:slug/batches/:id/revoke`
- `DELETE /api/workspaces/:slug/departments/:id`
- `POST /api/workspaces/:slug/inbox/:kind/:processId/decision`
- `POST /api/workspaces/:slug/inbox/superseded/:processId/restore`
- `POST /api/workspaces/:slug/lessons/:id/obsolete`
- `POST /api/workspaces/:slug/lessons/:id/reject`
- `POST /api/workspaces/:slug/org-evaluations/:id/proposals/:proposalId/undo`
- `POST /api/workspaces/:slug/processes/:id/cancel`
- `POST /api/workspaces/:slug/projects/:projectId/batches/:id/close`
- `POST /api/workspaces/:slug/projects/:projectId/phase/:id/revert`
- `DELETE /api/workspaces/:slug/stories/:id/tasks/:taskId`

</details>

<details><summary><strong>E</strong> · Organización, configuración y contenido (45)</summary>

- `POST /api/assistant/conversations`
- `PATCH /api/assistant/conversations/:id`
- `POST /api/assistant/conversations/:id/artifacts`
- `POST /api/assistant/conversations/:id/artifacts/:aid/:decision`
- `POST /api/bootstrap/internal`
- `POST /api/claude-code/detect`
- `POST /api/claude-code/usage/acknowledge`
- `POST /api/harnesses/codex/detect`
- `POST /api/workspaces`
- `POST /api/workspaces/:slug/agent-folders`
- `POST /api/workspaces/:slug/agents`
- `PUT /api/workspaces/:slug/agents/:id/attachments`
- `PUT /api/workspaces/:slug/agents/:id/config`
- `PUT /api/workspaces/:slug/agents/:id/department`
- `PUT /api/workspaces/:slug/agents/:id/documents/upload`
- `POST /api/workspaces/:slug/agents/:id/export`
- `POST /api/workspaces/:slug/agents/:id/feedback`
- `POST /api/workspaces/:slug/agents/:id/folder`
- `PUT /api/workspaces/:slug/agents/:id/identity`
- `POST /api/workspaces/:slug/agents/:id/memory/feedback`
- `POST /api/workspaces/:slug/agents/:id/template-version`
- `POST /api/workspaces/:slug/agents/external`
- `POST /api/workspaces/:slug/agents/external/preview`
- `POST /api/workspaces/:slug/agents/import/preview`
- `PATCH /api/workspaces/:slug/assignments/:id`
- `PATCH /api/workspaces/:slug/backlog/:id`
- `POST /api/workspaces/:slug/backlog/:id/restore`
- `POST /api/workspaces/:slug/departments`
- `PUT /api/workspaces/:slug/departments/:id`
- `POST /api/workspaces/:slug/lessons`
- `POST /api/workspaces/:slug/lessons/:id/promote`
- `POST /api/workspaces/:slug/lessons/:id/propose`
- `POST /api/workspaces/:slug/lessons/:id/validate`
- `POST /api/workspaces/:slug/org-evaluations/:id/proposals/:proposalId/reopen`
- `POST /api/workspaces/:slug/processes/:id/manual-test`
- `PUT /api/workspaces/:slug/processes/:processId/manual-test-feedback/:stepKey`
- `POST /api/workspaces/:slug/projects`
- `POST /api/workspaces/:slug/projects/:projectId/assignments`
- `POST /api/workspaces/:slug/projects/:projectId/backlog`
- `POST /api/workspaces/:slug/projects/:projectId/backlog/import`
- `POST /api/workspaces/:slug/projects/:projectId/phase`
- `POST /api/workspaces/:slug/stories/:id/tasks`
- `PATCH /api/workspaces/:slug/stories/:id/tasks/:taskId`
- `POST /api/workspaces/:slug/stories/:id/tasks/from-feedback`
- `POST /api/workspaces/:slug/stories/:id/tasks/from-issue`

</details>

## 3. Puntos de entrada a una operación con privilegios

| Entrada | Cómo se controla |
|---|---|
| La interfaz (navegador) | La sesión del propietario en cada cambio: `request()` la envía; las pocas llamadas directas (subidas en flujo, módulos antiguos) usan `ownerHeaders()` (lo comprueba `test/propietario-wiring.test.ts`). |
| Decisiones (aprobar, denegar, integrar, publicar) | Ejecuta la misma acción por su misma ruta (`app.inject`) con las credenciales de quien decide reenviadas: mismas guardias (sesión, arriendo, versión vista, superada). |
| El Asistente | Chatear es un cambio (gasta cuota y prepara operaciones): exige la sesión. Sus capacidades solo PREPARAN (revisiones, tarjetas); autorizar o rechazar una tarjeta exige la sesión; nunca sustituye una revisión del propietario. |
| Procesos en segundo plano (lotes, planificador, recuperación al arrancar) | Dentro del servidor, sin HTTP: solo continúan lo que el propietario ya autorizó (el lote y sus límites, el presupuesto del proceso). Una revisión interrumpida queda «a medias»: reanudarla exige la sesión. |
| Agentes (Claude Code con las herramientas del Portal) | Solo el puente, con un token de tarea o trabajador (crear un trabajador exige la sesión); entregar un resultado no integra ni aplica nada por sí solo. |
| Supervisor (`scripts/portal-start.mjs`) | No llama a la API: relanza el servidor al salir con el código 75. Reconstruir y reiniciar son cambios con sesión, atados al commit que viste. |
| Vista previa de un candidato (`scripts/preview-runner.mjs`) | Es el código del candidato con datos simulados en un contenedor sin red: exento SOLO con `PORTAL_PREVIEW=1`, proveedor simulado, datos temporales y `PORTAL_INSIDE_SANDBOX=1` (lo fija el contenedor). Tu Portal nunca lo cumple. |
| Pruebas de extremo a extremo y entornos aislados | Se vinculan como el propietario: leen el código del archivo (nunca por la API). |

## 4. Aprobaciones atadas a la acción, el objetivo y el estado

| Operación | Atadura | Repetida o desactualizada |
|---|---|---|
| Revisión del proyecto (limpieza, cierre de etapa) | Objetivos del plan, opción válida, nada protegido, motivo; justo antes de ejecutar: main, repositorio, remoto (nombre, dirección y pushurl) y la huella de cada objetivo. | Terminada, rechazada o caducada: 409. |
| Operaciones del Asistente (publicar main, revisión) | Huella de la vista previa (publicar: el commit de main y el remoto); se ejecuta el commit de la huella. | Una sola vez (pasa a «en marcha» antes de esperar nada). |
| Publicar main (Resumen › Repositorio) | `expectedMain` (commit exacto) y `expectedRemoteUrl`; se publica ESE commit, sin forzar. | Cambió desde que lo viste: 409 `stale_state`. |
| Publicar una historia (pantalla, Decisiones, lote) | Main se publica hasta la integración de ESA historia (su commit), no lo que tenga después. | Sin forzar: si el remoto avanzó, se rechaza. |
| Cambiar el remoto | `expectedUrl` (el que había). | Cambió: 409. |
| Integrar, aplicar, publicar o descartar un proceso | La versión del proceso que viste (`seenVersion`, si la pantalla lo cargó), el arriendo por historia y la máquina de estados (cada acción solo en el estado que la ofrece). | Pestaña desactualizada: 409 `stale_view`. «Cancelar» se acepta siempre: parar nunca se bloquea. |
| Decisiones | La decisión pendiente se recalcula con el estado real y lleva la versión del proceso que mostraba. | Ya no pendiente o cambió: 409. |
| Lotes | Aceptar (revisiones), reanudar (política esperada), cerrar (en pausa y con motivo); la política solo restringe. | Estados de un solo sentido. |
| Reconstruir y reiniciar el Portal | `expectedHead` (el commit que viste); con trabajo en marcha, además `interruptRunning`. | Avanzó: 409. |
| Otra empresa | Todo se busca dentro de la empresa de la ruta: lo de otra no existe (404) o no tiene nada sobre lo que actuar (409); nada cambia. | — |

## 5. Pruebas

- `test/politica-propietario.test.ts`: recorre las 171 rutas protegidas con 7 variantes cada una (sin sesión, inventada,
  en cookie, otra página local, otro puerto, texto, formulario) y comprueba que **ni la base de datos ni git cambian**;
  rutas alternativas; otra empresa; publicar main, el remoto y reconstruir atados; pestaña desactualizada; Decisiones con
  las credenciales reenviadas; el puente con su token; la vista previa; sin CORS. Salir del proceso durante la prueba es
  un fallo (sin la guardia, una petición de reinicio apagaba el servidor y la prueba «pasaba»).
- `test/seguridad-propietario.test.ts` (vincular y revisiones), `test/propietario-wiring.test.ts` (la interfaz envía la
  sesión) y las 54 pruebas existentes, ahora con el propietario vinculado (`test/fixtures/owner-app.ts`, que no toca las
  llamadas internas: así Decisiones prueba de verdad que reenvía la sesión).
- Mutaciones: quitar el gancho central, el reenvío de Decisiones o las ataduras hace fallar las pruebas.
- Navegador real (entorno aislado): sin vincular se consulta todo y cada cambio abre el diálogo; vinculado: chat,
  backlog, Decisiones, publicar atado; diálogo sobre diálogo; una página de otro puerto ni cambia ni lee; y el ensayo
  completo del cierre de etapa (vincular → pedirlo → «Revisar de nuevo» → autorizar).

## 6. Límites conocidos

- Un programa que se ejecuta con **tu** usuario de Windows y lee tus archivos podría leer el código o la base de datos (y
  usar git con tus credenciales): esto protege frente a quien solo puede hacer peticiones HTTP. Por eso importan los
  permisos de la carpeta (sección 7).
- Las lecturas no piden sesión: un programa local que no es un navegador (otra cuenta de Windows, un contenedor) puede
  leer la API (carpetas, conversaciones, diferencias). Una página de otro puerto, no (sin CORS).
- `seenVersion` es opcional en las acciones de un proceso: una pantalla que no cargó el proceso actúa sobre su estado
  actual (con la máquina de estados y el arriendo). Decisiones y las pantallas del proceso sí lo envían.
- Reconstruir comprueba el commit antes de empezar; una integración que entre justo durante la reconstrucción se activa
  con ella (ventana de segundos; el lote no empieza trabajo nuevo mientras se reconstruye).
- Publicar una historia usa el remoto actual (cambiarlo exige la sesión y el remoto que viste).
- Si el Portal está apagado y otra aplicación ocupa su puerto (4310) y abres esa dirección, podría leer la sesión de este
  navegador: si ocurre, Ajustes › Propietario › «Desvincular todos los navegadores».
- La interfaz de desarrollo (Vite, 5173) es de solo lectura: los cambios se hacen en http://127.0.0.1:4310.
- Reiniciar o reconstruir el Portal lo hace el propietario («Reconstruir y reiniciar» con el navegador vinculado): ningún
  proceso sin sesión puede.

## 7. Permisos de Windows (auditoría; NO aplicado)

**Estado actual** (auditado en solo lectura con `Get-Acl`, sin cambiar nada):

| Carpeta | Permisos efectivos relevantes |
|---|---|
| `C:\` | «Usuarios autentificados»: pueden crear carpetas, y a cada carpeta nueva le hereda **Modificar**. |
| `C:\Mis Proyectos`, `…\Portal IA`, `…\Portal IA\data`, `…\Portal IA-worktrees` | Heredado de `C:\`: Administradores y SYSTEM, control total; **Usuarios autentificados: Modificar**; Usuarios: lectura. Propietario: tu cuenta. |
| `%LOCALAPPDATA%\Portal IA` (archivo del código) | Bajo tu perfil: solo tu cuenta, SYSTEM y Administradores. |
| `%USERPROFILE%\.codex` | Explícito para `CodexSandboxUsers`: lectura. |

Cuentas locales activas además de la tuya: `CodexSandboxOffline` y `CodexSandboxOnline` (grupos `CodexSandboxUsers` y
`Usuarios`). Con la herencia actual pueden **leer y modificar** el código del Portal y **sus datos** (`data\`: bases de
datos, `.master.key`, sesiones del propietario), y con ello saltarse cualquier comprobación local. Ninguna carpeta de
`C:\Mis Proyectos` tiene permisos explícitos para Codex: hoy escribe en tus proyectos gracias a esa herencia.

**Qué necesita cada uno:**
- Portal IA corre como tu usuario: necesita control total solo para ti (más SYSTEM y Administradores).
- Docker Desktop (motor en WSL2) accede a las carpetas montadas como tu usuario; su servicio corre como SYSTEM. No
  necesita «Usuarios autentificados».
- Codex (sus cuentas de sandbox) necesita escribir en los proyectos donde lo uses; **nunca** en `data\` ni en `.env`.

**Propuesta de mínimo privilegio** (para revisarla tú; en una consola de PowerShell como administrador):

```powershell
# 0) Copia de los permisos actuales, para poder volver atrás
icacls "C:\Mis Proyectos\Portal IA" /save "$env:USERPROFILE\portal-ia-acl-respaldo.txt" /t /c
# 1) Datos y secretos: solo tu cuenta, SYSTEM y Administradores (sin herencia)
icacls "C:\Mis Proyectos\Portal IA\data" /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
icacls "C:\Mis Proyectos\Portal IA\.env" /inheritance:r /grant:r "${env:USERNAME}:F" "*S-1-5-18:F" "*S-1-5-32-544:F"
# 2) El repositorio y los worktrees: lo mismo
icacls "C:\Mis Proyectos\Portal IA" /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
icacls "C:\Mis Proyectos\Portal IA-worktrees" /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
# 3) Opcional, SOLO si usas Codex en este repositorio (data\ y .env ya no heredan: no les llega)
# icacls "C:\Mis Proyectos\Portal IA" /grant "CodexSandboxUsers:(OI)(CI)M"
```

**Compatibilidad y recuperación:**
- Orden: primero `data\` y `.env` (sin herencia), después la carpeta del repositorio; así un permiso de Codex en el
  repositorio nunca llega a los datos.
- Codex: sin el paso 3 no podrá leer ni escribir en este repositorio; los demás proyectos de `C:\Mis Proyectos` no
  cambian. Lo mismo para cualquier herramienta que se ejecute con otra cuenta.
- Docker, git, el Portal, VS Code y Claude Code corren como tu usuario: no cambian.
- Volver atrás: `icacls "C:\Mis Proyectos" /restore "$env:USERPROFILE\portal-ia-acl-respaldo.txt" /c`, o recuperar la
  herencia con `icacls "<carpeta>" /reset /t /c`.
- Ensayo recomendado: aplicarlo primero a una copia (p. ej. un worktree de prueba) y comprobar allí Codex y Docker.
