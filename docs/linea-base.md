# Línea base de Portal IA

Documento versionado en git: describe qué ES hoy Portal IA para que cualquier agente (y el propietario) parta de hechos y no de suposiciones. Al iniciar una etapa desde el Portal (Backlog → «Nueva etapa»), este texto se copia a Conocimiento junto con el estado leído en ese momento (commit, ramas, organización, lecciones validadas). Se actualiza con un commit cuando cambia algo de lo que describe.

**Procedencia.** Todo lo de este documento está implementado en la rama principal y cubierto por pruebas automáticas que pasan (`npm run typecheck`, `npm test`, `npm run build`) o por la prueba de extremo a extremo `apps/server/test/e2e/self-improvement.e2e.mjs`. Las pruebas usan el **proveedor simulado** (0 USD) y datos temporales. Lo que NO se ha verificado se dice explícitamente en «Limitaciones». Las historias y planes de la etapa experimental están archivados en el Portal: son registro histórico, no prueba de funcionalidad.

## 1 · Propósito y organización

- Portal IA es una plataforma local en la que empresas son operadas por equipos de agentes de IA bajo la autoridad del propietario. Su primer cliente es él mismo: el espacio interno «Portal IA» y su proyecto «Desarrollo del Portal», cuyo repositorio es la carpeta desde la que corre el Portal (`CosioYair/portal-ia`, rama `main`).
- **Propietario y autoridad final: Yair Cosio.** Aprueba gasto de IA, integraciones, publicaciones, reinicios, cambios organizativos (nuevos agentes o departamentos) y toda decisión importante.
- Objetivo de la organización: convertirse progresivamente en un entorno de trabajo multiagente autogestionado. Cada agente decide dentro de sus responsabilidades y permisos; el propietario solo interviene cuando hace falta aprobación, más autoridad, presupuesto o una decisión realmente importante. La organización debe mejorar su eficiencia y reducir la dependencia de un único agente generalista.
- Equipo inicial (plantillas aprobadas, versionadas en `agent_templates`):
  - Espacio: Asistente de Empresa (`ws-asistente`, conversa con el propietario y propone acciones), Gestor Organizacional (`ws-gestor`, organización, nuevas áreas), Agente de Onboarding (`ws-onboarding`, creación y configuración de agentes).
  - Proyecto: Coordinador del Proyecto (`pj-coordinador`, planifica historias, lidera encargos del proyecto), Arquitecto de Software (`pj-arquitecto`, consulta de arquitectura), Desarrollador Full Stack (`pj-dev`, implementa; único con `write_repo` en el equipo inicial), Diseñador UX/UI (`pj-ux`, consulta de UX), Especialista QA (`pj-qa`, revisa calidad y genera pruebas).
  - La jerarquía real (a quién reporta cada agente), sus modelos, herramientas y versión de plantilla se registran en la sección (A) de cada línea base copiada a Conocimiento.
- Nuevos agentes: desde plantillas aprobadas o como agentes especializados por capacidad, con permisos mínimos; se presentan al propietario para su aprobación.

## 2 · Arquitectura

- Monorepo npm (workspaces): `apps/server` (Fastify 5, TypeScript ejecutado con tsx, `node:sqlite`), `apps/web` (React 19 + Vite 7), `packages/domain` (tipos y plantillas), `packages/ai-adapters` (Anthropic, OpenAI y un proveedor simulado solo para pruebas).
- Datos locales en `data/` (nunca en git): `platform.sqlite` (proveedores, credenciales cifradas AES-256-GCM con clave maestra local, espacios, ajustes, mensajes del asistente) y una base por espacio `data/workspaces/<slug>/<slug>.sqlite` (proyectos, agentes, backlog, procesos y pasos, conocimiento, lecciones, plantillas, conversaciones y tareas de historias, feedback de pruebas manuales, historial de uso y presupuestos). Migraciones solo aditivas, con copia de seguridad previa.
- Servidor en `127.0.0.1:4310`; `npm start` lanza el supervisor `scripts/portal-start.mjs`, que reinicia el servidor cuando sale con el código 75 («Reconstruir y reiniciar»). La interfaz compilada (`apps/web/dist`) la sirve el mismo servidor.

## 3 · Flujo de desarrollo (cómo se trabaja desde el Portal)

1. Petición: el propietario habla con el Asistente (pantalla Asistente o panel flotante) o añade una solicitud en Backlog. No todo es una historia: revisar, evaluar, proponer u organizar es un **encargo** (`delegate_task`) al agente responsable, que valida, consulta a su equipo y entrega un documento en Conocimiento con propuestas al backlog que el propietario aplica.
2. Historia: «Ejecutar» compone el equipo sin IA (`teamComposer.ts`, por capacidades: planificador, implementador, revisor y hasta 2 consultores, con motivos) y estima el costo. Nada consume IA sin autorización explícita con presupuesto.
3. Ejecución: Coordinador (plan) → consultores → Desarrollador (parches buscar/reemplazar y secciones «Para el propietario» y «Prueba manual») → QA (observaciones con gravedad). Resultado: un diff revisable.
4. Recorrido guiado de 9 etapas (`services/storyFlow.ts`, una sola fuente de verdad en `guidance.flow`): ejecutar → revisar → aplicar → verificar → integrar → activar → comprobar en ejecución → prueba manual → cerrar (7 etapas fuera del repositorio del Portal). Cada problema se clasifica (entorno / código / decisión) con diagnóstico y acciones de recuperación.
5. Iteración: el feedback de la prueba manual, las tareas, el chat de la historia y el error actual alimentan una iteración correctiva con su contexto.
6. Cierre: solo con los cambios integrados en `main`, activados (si es el Portal), comprobados en ejecución y probados paso a paso. Publicar en GitHub es opcional y siempre lo autoriza el propietario.

## 4 · Ejecución segura

- **Política de ejecución** (`services/executionPolicy.ts`): toda operación con efectos (escribir en worktree, sandbox, instalar dependencias, merge, push, reinicio, comprobación en ejecución, llamada a IA, limpieza de worktree, inicio de etapa) pasa por `requirePolicy`, que exige la autorización del propietario, la herramienta del agente y su ámbito de proyecto, y lo audita en `execution_history` (`policy:*`).
- **Worktrees** (`services/worktree.ts`): cada proceso escribe en `<repo>-worktrees/<proceso>`; el checkout del Portal nunca cambia de rama. Las ramas de historia nacen de `main`.
- **Sandbox fail-closed** (`services/sandbox.ts`, `docs/sandbox.md`): `docker` → `wsl` → `linux-ns`; sin sandbox, `test`/`build` quedan bloqueados y el proyecto interno no se integra. Docker: imagen `portal-ia-sandbox:1`, dependencias Linux en un volumen por package-lock (`portal-ia-nm-<hash>`), `install` con red solo con confirmación explícita; el resto sin red, `--read-only`, `--cap-drop ALL`, usuario sin privilegios, contenedor eliminado al agotar el tiempo. Código 86 = faltan dependencias (problema del entorno, se resuelve con «Instalar dependencias y repetir»).
- **Verificación antes de integrar**: no se integra sin `typecheck` correcto en la rama; el proyecto interno exige además `test` y `build` en sandbox real.
- **Activación** (`services/system.ts`): integrar no es activar. Una historia del Portal cuenta como activa cuando el servidor en marcha y la interfaz compilada contienen su commit («Reconstruir y reiniciar» compila a `dist.next` y conserva `dist.prev`). Después se comprueba en ejecución (HTTP y navegador con Playwright, capturas en `data/evidence/`).
- Protecciones de escritura: rutas protegidas (`.env` reales, claves, `data/`), escaneo de posibles secretos, bloqueo de reemplazos sobre archivos que cambiaron después de leerse.

## 5 · Aprendizaje organizacional

- Lecciones (`services/lessons.ts`): detectores sin IA crean lecciones «detectadas» con evidencia; «Proponer con IA» solo con autorización; **solo el propietario valida**. Solo las validadas se inyectan en los prompts por proyecto y papel, y cada paso registra cuáles usó. La reincidencia se cuenta.
- Plantillas versionadas (`services/agentTemplates.ts`): una lección validada puede promoverse a práctica de una plantilla (`clave@N+1`); los agentes existentes la adoptan con «Actualizar» y pueden volver atrás.
- Las lecciones detectadas o propuestas NO son conocimiento validado.

## 6 · Herramientas de los agentes

`read_repo` (leer el repositorio), `write_repo` (escribir en el worktree del proceso), `sandbox_exec` y `run_tests` (verificación en sandbox), `install_deps`, `knowledge_write` (documentos en Conocimiento), `delegate` (encargos). Cada agente solo tiene las que su configuración activa; la política las comprueba en el backend. Integrar, publicar, reiniciar y gastar IA son decisiones del propietario, no herramientas de agente.

## 7 · Verificado y cómo

- Pruebas del servidor (`apps/server/test/*.test.ts`): política y fail-closed, worktrees, sandbox Docker con aislamiento real (en Windows con Docker Desktop), composición de equipos, lecciones y plantillas, espacio de la historia e iteraciones, recorrido guiado y recuperación de errores, bandeja de autorizaciones, presupuestos, migraciones, etapas y archivo (`phase-transition.test.ts`).
- E2E de automejora: una copia del Portal arrancada con el supervisor recorre solicitud → ejecución → aplicar → verificar en sandbox → integrar → reconstruir y reiniciar → comprobar en ejecución (HTTP y navegador) → prueba manual → cerrar, más los escenarios de fallo (verificación, activación, parche, ejecución).
- Interfaz: recorridos con Playwright sobre instancias aisladas (recorrido guiado A–F, iteraciones, etapa y archivo).

## 8 · Limitaciones conocidas

- Nada de lo anterior se ha verificado con un proveedor de IA real ni sobre los datos reales del propietario; la primera ejecución real la autoriza el propietario con su presupuesto.
- El compositor de equipos usa coincidencia léxica (sin IA): puede no elegir a un especialista si la historia no nombra su área (se añade a mano al ejecutar).
- No hay editor de conflictos de merge: un conflicto se resuelve con una iteración correctiva sobre el `main` actual.
- «Reconstruir y reiniciar» se lanza desde la barra del sistema, no desde la historia.
- Un bloqueo de Docker Desktop se detecta al agotarse el tiempo máximo del sandbox (10 minutos).
- La gravedad de las observaciones de QA antiguas (sin prefijo `[alta]/[media]/[baja]`) se infiere por palabras clave.
- El chat de una historia responde un agente por pregunta.
- Las entradas «Herramientas y MCP», «Presupuestos» y «Organización» del menú aparecen como «próx.»: esas pantallas aún no existen.
