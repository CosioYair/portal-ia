# Punto de control para reiniciar Windows · 30 de octubre de 2026

El propietario reinicia Windows porque el motor de Docker Desktop no arranca. Este documento permite retomar el trabajo
exactamente donde quedó, sin repetir lo hecho. Todo el trabajo está **confirmado en git** (rama
`mejora/asistente-encargos`): no depende de carpetas temporales ni de la conversación de Claude Code.

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
