# Punto de control para reiniciar Windows · 30 de octubre de 2026

El propietario reinicia Windows porque el motor de Docker Desktop no arranca. Este documento permite retomar el trabajo
exactamente donde quedó, sin repetir lo hecho. Todo el trabajo está **confirmado en git** (rama
`mejora/asistente-encargos`): no depende de carpetas temporales ni de la conversación de Claude Code.

> **Actualización tras el reinicio:** el plan F se completó (pasos 1–8). Resultados, correcciones y lo que queda para
> el propietario: sección **H**, al final.

## A · Objetivo

Que Portal IA sea el entorno principal de desarrollo con IA del propietario, con capacidades cercanas a Claude Code en
la terminal, reforzadas con:
- agentes especializados y conocimiento de la empresa;
- Gauntlet automático;
- conversaciones persistentes y encargos de desarrollo directos;
- autonomía controlada por el propietario.

## B · Implementado (rama `mejora/asistente-encargos`)

| Capacidad | Dónde |
|---|---|
| Conversaciones persistentes del Asistente (alcance empresa/proyecto, etapa, siguiente acción; archivar sin borrar) | `apps/server/src/db/conversations.ts`, `services/conversations.ts`, `services/assistant.ts`, `routes/assistant.ts`, `packages/domain/src/conversation.ts`, web `components/ConversationPanel.tsx`, `AssistantChat.tsx` |
| Registro de decisiones (el modelo propone; el propietario aprueba, rechaza, revisa, aplaza o reabre, con historial) | `services/conversations.ts` (`proposeDecisions`, `decide`) |
| Exploración de ideas y propuesta con cuestionamiento independiente | `services/conversations.ts` (`startArtifact`), `services/delegation.ts` (propósito `proposal`, `pickChallenger`) |
| Revisión del equipo | `services/delegation.ts` (propósito `team_review`) |
| Generación de historias (solo altas, sin duplicados, dependencias por título, solo con clic autorizado) | `services/delegation.ts` (`applyBacklogOps`), `services/conversations.ts` (`createStoriesFrom`) |
| Encargos del propietario sin historia (`EN-n`), mismo motor que las historias; pedir cambios descarta la versión no integrada con confirmación | `packages/domain/src/assignment.ts`, `db/assignments.ts`, `services/assignments.ts`, `services/workItems.ts`, `routes/assignments.ts` |
| Gauntlet automático y adaptativo (resuelto sin IA al autorizar y por historia en lotes; progreso estricto; tope 6) | `packages/domain/src/gauntlet.ts`, `services/gauntlet.ts`, `services/processAuthorization.ts`, `services/batchRunner.ts` |
| Gauntlet en la planificación (revisión del plan antes de implementar; «Seguir con este plan») | `services/gauntlet.ts` (`planReviewStage`), `services/storyExecution.ts`, `routes/processes.ts` (`accept-plan`) |
| Diagnóstico independiente ante la misma brecha repetida | `packages/domain/src/gauntlet.ts` (`decideGauntlet` → `diagnose`), `services/gauntlet.ts` |
| Herramientas de agentes de solo lectura `portal_search` y `portal_diff` | `services/claudeCode/bridge.ts`, `routes/claudeCode.ts`, `scripts/portal-mcp.mjs` |
| Protección de la suscripción de Claude: informe de límites del CLI, «overage» por episodios con reconocimiento, tope de llamadas comprobado antes de CADA ejecución (sin carreras), nunca se cambia a la API sin autorización | `services/claudeCode/usage.ts`, `callCap.ts`, `backend.ts`, `cli.ts` |
| Seguridad: una guarda de lectura (`resolveReadable`) y una de escritura (`writablePath`), sin alias de Windows (8.3, flujos alternativos, punto/espacio final), sin enlaces, credenciales protegidas; ningún git del Portal ejecuta hooks | `services/repoWrite.ts`, `src/gitSafety.ts`, `services/claudeCode/bridge.ts` |
| Mejoras de lotes (Gauntlet automático por historia, tope de lote sobre el registro real de ejecuciones) | `services/batchRunner.ts`, web `screens/Batches.tsx` |
| Pruebas fiables en el sandbox (reloj monótono, evidencia por commit) | `src/clock.ts`, `packages/domain/src/types.ts` (`verificationsForApplied`) |

Diseño, estándar de calidad, cuatro revisiones independientes, medidas y límites:
`docs/asistente-encargos-y-gauntlet-adaptativo.md`.

## C · Estado de git (comprobado al crear este documento)

| Referencia | Commit | Nota |
|---|---|---|
| `main` | `e9fcbbc` | sin cambios; el Portal en marcha usa este código |
| `mejora/lotes-autorizacion-seleccion` | `9ea0ce9` | rama anterior, conservada, sin integrar |
| `mejora/asistente-encargos` | `e15ea7e` (+ el commit de este documento) | 16 commits sobre `9ea0ce9` (25 desde `main`); sin integrar ni publicar |

- No hay `upstream` para las ramas `mejora/*`: nada se ha publicado.
- El checkout principal `C:\Mis Proyectos\Portal IA` está en `main` y limpio.
- Worktree de trabajo (temporal; puede desaparecer sin perder nada, porque todo está en la rama):
  `C:\Users\Yair\AppData\Local\Temp\claude\C--Mis-Proyectos-Portal-IA\257efd23-edaf-4a95-b92c-bbff02f4ae27\scratchpad\wt`,
  limpio. Su `node_modules` son uniones a las del checkout principal.
- Otro worktree existente, que no es de este trabajo: `C:\Mis Proyectos\Portal IA-worktrees\98c680e1-…` → `portal-ia/hu-155`.
- `stash@{0}` (antiguo, «Portal IA v0.12.0 descomprimida»): no es de este trabajo; no tocarlo.

**Procesos al crear el punto de control:**
- El Portal en marcha: `npm run start` → `scripts/portal-start.mjs` → `tsx src/index.ts`, PID 5056, en 127.0.0.1:4310.
- Un `npm test` colgado desde las 07:45, lanzado desde Git Bash (PID 10976 y sus hijos), sin relación con este punto de
  control. El reinicio lo terminará.

Ningún cambio sin confirmar.

**Si el worktree temporal desaparece**, se recrea desde git sin perder nada:
1. `git worktree prune`.
2. `git worktree add <carpeta> mejora/asistente-encargos`.
3. Dependencias: en `<carpeta>\node_modules`, una unión por cada entrada de `C:\Mis Proyectos\Portal IA\node_modules`,
   salvo `@portal-ia`, que debe apuntar a los paquetes de la propia carpeta (`packages/ai-adapters`, `packages/domain`,
   `apps/server`, `apps/web`). Alternativa: `npm ci` en la carpeta (descarga: pide permiso al propietario).

## D · Verificación realizada (sin contar lo omitido o bloqueado como superado)

| Tipo | Resultado |
|---|---|
| Typecheck (`npm run typecheck`) | exit 0 en `e15ea7e` |
| Build (`npm run build`) | exit 0 en `e15ea7e` |
| Suite (`npm test`, Windows, sin Docker) | 439 pruebas: 428 en verde, 10 omitidas y 1 fallida, en `e15ea7e` |
| Pruebas con proveedor y CLI simulados (conversaciones, encargos, Gauntlet, tope de llamadas, lotes, Claude Code) | en verde dentro de esas 428 |
| Pruebas de seguridad (`apps/server/test/security-paths.test.ts`) | en verde (5/5). Usan secretos sintéticos, nombres cortos REALES, una unión, un flujo alternativo y un hook versionado con control positivo. Contra `28c1a6f` fallaban |
| Navegador (Chromium sin interfaz, instancia aislada, escritorio y móvil) | 12/12 en `2f54d3d`. **No repetido** tras los últimos cambios de interfaz (botón «Seguir con este plan», casilla de descarte) |
| Recorrido completo del Asistente (`apps/server/test/assistant-journey.test.ts`) | **No superado.** Con Docker simulado (copia temporal) pasa; con Docker real falla porque exige Docker |
| Pruebas con Docker real (7) | **No ejecutadas** (omitidas sin motor): ver E |

Las 7 pruebas con Docker real son:
- `sandbox-docker.test.ts`: «un script malicioso…»;
- `autonomous-pipeline.test.ts`: C, D, E y E2;
- `claude-code-execution.test.ts`: 23;
- `incremental-delivery.test.ts`: R.

## E · Bloqueos y pendientes

**Bloqueo principal: Docker Desktop.**
1. Primero, cualquier montaje de carpetas de `C:` fallaba con «input/output error», también con un `docker run` mínimo
   sin código del Portal.
2. Tras `docker desktop restart` (autorizado una vez por el propietario), el servicio de fondo no arrancó y el panel
   mostró un error. El canal `dockerDesktopLinuxEngine` no existe; `docker desktop start` responde «already running»
   sin motor.
3. Consecuencias:
   - las 7 pruebas con Docker real se omitieron;
   - el recorrido completo no pasó;
   - la corrección de las pruebas inestables del sandbox (`2389017`) **nunca** se ha ejecutado dentro de Docker;
   - el Portal en marcha tampoco tiene sandbox: las historias se pausan, no se ejecutan sin aislamiento.

**Hallazgos de las revisiones aún abiertos** (detalle en el documento de diseño):
- Si falla la llamada de diagnóstico, la evaluación de esa ronda se vuelve a pagar al continuar.
- La cita de evidencia del revisor del plan no se comprueba contra el texto del plan.
- Los enlaces duros no se detectan; bajo Docker no dan salida al agente.
- El paso del planificador muestra solo el coste de su última llamada; el total del proceso es correcto.
- Una iteración anterior FALLIDA no queda superada y se puede continuar (igual que con historias).

**Límites conocidos:**
- Los agentes no ejecutan órdenes ni editan directamente: el Portal aplica y verifica en Docker. No hay bucle
  «editar → probar → corregir» dentro de una llamada.
- El Asistente ve hasta 40 historias abiertas por proyecto.
- Un reinicio antes de la entrega del Desarrollador repite el plan.
- No hay validación con modelos reales.

**Seguridad:** `main` (el Portal en marcha) aún tiene los agujeros de lectura por nombre corto (`ENV~1`) y del contexto
del pipeline. Mientras no se integre esta rama, conviene desactivar la lectura del repositorio para Claude Code.

## F · Plan de continuación (en este orden; no repetir lo hecho)

1. **Salud de Docker Desktop**: `docker version` y `docker desktop status`.
2. **¿Arranca el motor?** Si arranca, ir al paso 4.
3. **Si no arranca**, diagnosticar sin destruir nada:
   - leer `%LOCALAPPDATA%\Docker\log\host\` y la salida de `wsl -l -v` y `wsl --status`;
   - nunca borrar volúmenes, imágenes ni distribuciones de WSL;
   - nunca hacer «reset to factory defaults» ni `wsl --unregister`;
   - cualquier reparación la decide el propietario.
4. **Comprobación mínima** de montaje, solo lectura y sin red:
   ```
   MSYS_NO_PATHCONV=1 docker run --rm --network none --mount "type=bind,src=<carpeta temporal con x.txt>,dst=/w,readonly" --entrypoint sh portal-ia-sandbox:1 -c 'cat /w/x.txt'
   ```
   Si falla con «input/output error», el problema de Docker Desktop sigue: parar e informar.
5. **Pruebas con Docker, una a una**, en la rama:
   ```
   cd apps/server
   node --test --import tsx test/sandbox-docker.test.ts
   node --test --import tsx test/autonomous-pipeline.test.ts
   node --test --import tsx test/incremental-delivery.test.ts
   node --test --import tsx test/claude-code-execution.test.ts
   node --test --import tsx test/assistant-journey.test.ts
   ```
6. **Suite completa con Docker obligatorio**: `PORTAL_REQUIRE_DOCKER=1 npm test`. Además, varias ejecuciones de la suite
   DENTRO del sandbox (`--cpus 2 --memory 2g`) para confirmar la corrección de las pruebas inestables. Antes, 5 de 5
   ejecuciones fallaban una prueba distinta.
7. **Código final**: `npm run typecheck`, `npm test`, `npm run build` en el HEAD de la rama. Repetir el recorrido en
   navegador sobre una instancia aislada.
8. **Hallazgos**: corregir lo que Docker revele; ver los abiertos en E.
9. **Solo entonces**, pedir autorización al propietario para integrar `mejora/lotes-autorizacion-seleccion` y luego
   `mejora/asistente-encargos` en `main`, `npm run build` y reiniciar el Portal.

## G · Reglas de seguridad (vigentes)

- Nunca leer ni modificar el `data/` real, ni `.env` ni `data/.master.key`; no exponer credenciales.
- Nunca gastar créditos de IA reales ni llamar a Claude Code real desde el Portal sin autorización. En las pruebas,
  proveedor y CLI simulados.
- Nunca reiniciar ni modificar el Portal en marcha (127.0.0.1:4310) sin autorización.
- Nunca integrar en `main`, reescribir historia ni publicar sin autorización.
- Nunca borrar ramas ni worktrees sin autorización.
- Nunca reiniciar ni borrar volúmenes de Docker ni distribuciones de WSL automáticamente.
- No debilitar el aislamiento de Docker ni dar a los agentes un shell del equipo.
- Antes de cada commit: typecheck, test y build en verde. Commits pequeños, en español.

## H · Reanudación tras el reinicio (30 de octubre de 2026, noche)

**Estado recuperado:** la rama seguía en `35aae36`, con el worktree temporal intacto y limpio; `main` en `e9fcbbc` y el
checkout principal limpio. Tras el reinicio el Portal en marcha **no** estaba arrancado (nada escucha en 4310); no se
arrancó.

**Docker Desktop: sano** (pasos F.1–F.4). Docker Desktop 4.97.0, motor 29.9.2, `docker desktop status` → `running`.
La imagen `portal-ia-sandbox:1` y los volúmenes de dependencias siguen ahí. El montaje mínimo desde `C:` (sin red, solo
lectura) lee el archivo y rechaza escribir: ya no hay «input/output error». No se reinició ni se borró nada de Docker ni
de WSL.

**Pruebas antes bloqueadas, con Docker real (paso F.5, en `35aae36`):**

| Prueba | Resultado |
|---|---|
| `sandbox-docker.test.ts` («un script malicioso…») | en verde (12/12 del archivo) |
| `autonomous-pipeline.test.ts` C, D, E y E2 | en verde (17 de 18; la omitida es la puerta que solo se exige con `PORTAL_REQUIRE_DOCKER=1`) |
| `incremental-delivery.test.ts` R | en verde (41/41) |
| `claude-code-execution.test.ts` 23 | en verde (29/29) |
| `assistant-journey.test.ts` (recorrido completo) | en verde |
| `PORTAL_REQUIRE_DOCKER=1 npm test` (Windows) | 439 pruebas: 437 en verde, 0 fallidas, 2 omitidas (SIGTERM en Windows; `linux-ns` porque hay Docker) |

**Lo que reveló la verificación y se corrigió:**
1. **Dentro del sandbox, dos pruebas nuevas de esta rama fallaban SIEMPRE** (el Portal ejecuta esta suite en el
   sandbox para verificar cada historia de su propio proyecto: tras integrar, cada historia habría fallado `test` y
   abierto correcciones pagadas):
   - `assistant-journey.test.ts` exigía Docker sin condición, y dentro del sandbox no hay Docker. Ahora, como C, D y E:
     sin Docker se omite y lo dice; con `PORTAL_REQUIRE_DOCKER=1` **falla**. Comprobado con una imagen inexistente
     (se omite; con la obligación, falla) y con Docker (pasa).
   - `security-paths.test.ts`: el control positivo del hook no puede pasar en el sandbox porque `/tmp` es un tmpfs
     `noexec` (medido: `Permission denied`; git: «hook was ignored»). La prueba de hooks va aparte y se omite, diciéndolo,
     solo si el directorio temporal no permite ejecutar; en Windows (donde el Portal hace sus commits) se ejecuta con su
     control. La de enlaces se ejecuta siempre.
2. **«Seguir con este plan» no hacía nada en la interfaz**: `accept_plan` no estaba en `HANDLED` de `StoryFlowPanel`,
   así que el botón solo decía «recarga la página». Las pruebas del servidor llamaban a la ruta directamente. Corregido,
   con una prueba estática nueva: cada `FlowActionId` debe estar en `HANDLED` (sobre el código anterior detecta
   `accept_plan`).
3. **Su confirmación no decía que paga la implementación**: usaba el texto genérico «Autorizo esta acción en el
   sandbox…» y no ofrecía presupuesto adicional. Ahora dice qué se autoriza y con qué (lo que queda del presupuesto, el
   adicional si lo pones, Claude Code si el equipo lo usa) y muestra el campo de presupuesto.
4. **El título de esa pausa engañaba**: «Detenido: el plan no se puede ejecutar por partes» (pensado para un plan
   demasiado grande). Con la revisión del plan en pausa ahora dice «La revisión independiente del plan dejó una brecha
   bloqueante: decides tú». Prueba en `gauntlet.test.ts`; el caso antiguo conserva su título.

**Pruebas inestables del sandbox (paso F.6):** con la corrección `2389017`, 6 ejecuciones completas de la suite
dentro del sandbox (`--cpus 2 --memory 2g`, los mismos argumentos de `buildDockerRunArgs`) **sin ningún fallo
aleatorio**; antes, 5 de 5 fallaban una prueba distinta. La primera ejecución solo falló las dos pruebas del punto 1.

**Código final (paso F.7):**
- `npm run typecheck` y `npm run build`: exit 0.
- `PORTAL_REQUIRE_DOCKER=1 npm test`: 441 pruebas; 439 en verde, 0 fallidas, 2 omitidas (las de plataforma).
- Dentro del sandbox: 2 de 2 ejecuciones con 441 pruebas: 430 en verde, 0 fallidas, 11 omitidas (las que necesitan Docker o ejecutar en `/tmp`, y las de sandbox anidado).
- Navegador (Chromium sin interfaz, instancia aislada, proveedor simulado, Docker real): las 12 comprobaciones de siempre y 26 nuevas (escritorio y móvil), todas en verde y sin errores en la consola.

**Cómo se reprodujo** (scripts fuera del repositorio, en la carpeta temporal de la sesión de Claude Code, que puede
desaparecer):
- Suite dentro del sandbox: los argumentos de `buildDockerRunArgs` y `depsVolumeName` de `sandbox.ts`, sobre una
  exportación limpia de la rama (`git archive`), sin red y con un `PORTAL_DATA_DIR` temporal.
- Navegador: `ux-assist.mjs` (instancia aislada) con `ui-assist-verify.mjs` (las 12 comprobaciones de siempre) y
  `ui-new-controls.mjs` (nuevo: tarjeta del encargo con «Pedir cambios» y descarte; pausa del plan con «Seguir con este
  plan», en escritorio y móvil, aceptándolo de punta a punta con Docker real).

**Siguen abiertos** (sin cambios en esta sesión; ver E): el diagnóstico fallido que vuelve a pagar la evaluación, la
cita del revisor del plan sin comprobar, los enlaces duros, el coste del planificador por llamada y la iteración
FALLIDA no superada. Cosmético visto en el móvil: los botones flotantes «Autorizaciones» y «Asistente» tapan el borde
inferior de la pantalla (el contenido se desplaza por debajo).

**Para el propietario (paso F.9, requiere autorización):** integrar en `main` primero
`mejora/lotes-autorizacion-seleccion` y luego `mejora/asistente-encargos`, `npm run build` y reiniciar el Portal. Nada
de eso se ha hecho.
