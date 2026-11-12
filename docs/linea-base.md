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
3. Ejecución: Coordinador (plan) → consultores → Desarrollador (parches buscar/reemplazar y secciones «Para el propietario» y «Prueba manual»). La respuesta del Desarrollador pasa por un **contrato de salida** (`services/devOutput.ts`): se clasifica (implementación, sin cambios, cortada, incompleta, mal formada, bloqueo del agente —información, permiso o capacidad, declarado en la sección `BLOQUEO` o deducido—, negativa del proveedor) y se recuperan sin IA las variantes de formato frecuentes; nunca se inventan cambios.
3a. **Fallos por clase** (`docs/incidentes/HU-155.md`): solo la salida no válida se repara con IA; lo que falta se pide (repositorio, especialista del equipo autorizado o propietario) y permisos, capacidades y negativas del proveedor se detienen con una petición. Cada llamada tiene plazo, cancelación real y estado en vivo.
3b. **Pipeline autorizado** (`services/storyPipeline.ts`, incluido en la autorización del proceso con sus límites): si la entrega no es aplicable, una reparación acotada del mismo Desarrollador (sin repetir el plan); después aplicar en el worktree aislado → verificar en el sandbox (instalar dependencias solo si está autorizado; sin sandbox se pausa) → QA evalúa la evidencia real con veredicto estructurado (`services/qaGate.ts`; la verificación automática prevalece) → correcciones acotadas con los diagnósticos. Termina en «Implementación verificada por QA — lista para revisión del propietario» o se pausa/detiene con el motivo (presupuesto, red, entorno, límite, fallo repetido) y «Continuar» retoma donde quedó. Antes de cada llamada a la IA se comprueba el presupuesto restante. Nunca integra, reinicia ni publica. Sin pipeline (API antigua), QA revisa el diff y cada paso lo autoriza el propietario.
4. Recorrido guiado de 9 etapas (`services/storyFlow.ts`, una sola fuente de verdad en `guidance.flow`): ejecutar → revisar → aplicar → verificar → integrar → activar → comprobar en ejecución → prueba manual → cerrar (7 etapas fuera del repositorio del Portal). Cada problema se clasifica (entorno / código / decisión) con diagnóstico y acciones de recuperación.
4a. **Main avanzó** (`storyIntegration.ts`): candidato sin IA (main incorporado en la rama y verificado); con conflictos reales, el equipo resuelve solo esas secciones. Nunca otra iteración por eso.
4b. **Turnos agotados** (`CLAUDE_CODE_MAX_TURNS_EXHAUSTED`): no es conexión; reintento acotado y sin bucle (`docs/incidentes/HU-159.md` §6).
5. Iteración: el feedback de la prueba manual, las tareas, el chat de la historia y el error actual alimentan una iteración correctiva con su contexto.
6. Cierre: solo con los cambios integrados en `main`, activados (si es el Portal), comprobados en ejecución y probados paso a paso. Publicar en GitHub es opcional y siempre lo autoriza el propietario.

## 4 · Ejecución segura

- **Política de ejecución** (`services/executionPolicy.ts`): toda operación con efectos (escribir en worktree, sandbox, instalar dependencias, merge, push, reinicio, comprobación en ejecución, llamada a IA, limpieza de worktree, inicio de etapa) pasa por `requirePolicy`, que exige la autorización del propietario, la herramienta del agente y su ámbito de proyecto, y lo audita en `execution_history` (`policy:*`).
- **Worktrees** (`services/worktree.ts`): cada proceso escribe en `<repo>-worktrees/<proceso>`; el checkout del Portal nunca cambia de rama. Las ramas de historia nacen de `main`.
- **Sandbox fail-closed** (`services/sandbox.ts`, `docs/sandbox.md`): `docker` → `wsl` → `linux-ns`; sin sandbox, `test`/`build` quedan bloqueados y el proyecto interno no se integra. Docker: imagen `portal-ia-sandbox:1`, dependencias Linux en un volumen por package-lock (`portal-ia-nm-<hash>`), `install` con red solo con confirmación explícita; el resto sin red, `--read-only`, `--cap-drop ALL`, usuario sin privilegios, contenedor eliminado al agotar el tiempo. Código 86 = faltan dependencias (problema del entorno, se resuelve con «Instalar dependencias y repetir»).
- **Verificación antes de integrar**: no se integra sin `typecheck` correcto en la rama; el proyecto interno exige además `test` y `build` en sandbox real.
- **Activación** (`services/system.ts`): integrar no es activar. Una historia del Portal cuenta como activa cuando el servidor en marcha y la interfaz compilada contienen su commit («Reconstruir y reiniciar» compila a `dist.next` y conserva `dist.prev`). Después se comprueba en ejecución (HTTP y navegador con Playwright, capturas en `data/evidence/`).
- Protecciones de escritura: rutas protegidas (`.env` reales, claves, `data/`), escaneo de posibles secretos, bloqueo de reemplazos sobre archivos que cambiaron después de leerse.

### Paquete distribuible (HU-206)

Ninguna edición lleva credenciales. El árbol que se empaqueta para la edición distribuible (`PORTAL_EDITION=distributable`) tiene una única fuente de verdad: `apps/server/src/services/packageTree.ts`. No tiene dependencias ni usa `REPO_ROOT`: quien lo llama le pasa la raíz.

- **Qué incluye** (`PACKAGE_INCLUDE`): `package.json`, `package-lock.json`, `README.md`, `.env.example` y `tsconfig.base.json`; las carpetas `docs/`, `docker/` y `scripts/`; el código y la configuración de cada paquete (`packages/*/src`, `package.json`, `tsconfig.json`), del servidor (`apps/server/src`, `scripts`, `tools`, `package.json`, `tsconfig.json`) y de la web (`apps/web/src`, `index.html`, `package.json`, `tsconfig.json`, `vite.config.ts`). Solo entran archivos de texto y nunca enlaces simbólicos. `listPackageFiles(raíz)` devuelve rutas relativas con «/», ordenadas y sin duplicados.
- **Qué excluye y por qué** (`PACKAGE_EXCLUDE`; `packageExclusion(ruta)` da el motivo):
  - `apps/server/test/**`, incluida la prueba de extremo a extremo: las pruebas no se distribuyen.
  - `apps/web/dist`, `dist.prev` y `dist.next`: se generan al construir.
  - `node_modules`: las dependencias se instalan en destino.
  - `data/`: son los datos locales del Portal.
  - `.git`: es el historial.
  - Los `.env` reales: solo se distribuye `.env.example`.
  - `scripts/preview-runner.mjs`: solo sirve a la vista previa de automejora.
- **Vista previa en la edición distribuible:** la automejora está desactivada. Por eso la vista previa de candidatos (`services/preview.ts`) responde 403 `edition_distributable` antes de copiar `preview-runner.mjs`. En la edición studio funciona igual que antes.
- **Guarda de secretos:** la prueba `apps/server/test/hu206-paquete-sin-secretos.test.ts` se ejecuta en `npm test` y comprueba lo siguiente:
  - Aplica `findSecret` (`@portal-ia/domain`) a cada archivo de `listPackageFiles(raíz)` y falla si alguno queda marcado. El mensaje da la ruta y el tipo, nunca el valor.
  - Verifica que las pruebas y el runner quedan fuera y que el código del servidor, la web y los paquetes está dentro.
  - Incluye un control: construye una clave de muestra sin literales y comprueba que el detector la marca.
  - Comprueba el 403 de la vista previa.
  - Si se añade al árbol un archivo con un literal que parezca una clave, `npm test` falla.

### Probar la Edición en la misma máquina (HU-212)

Para probar la edición distribuible en la misma PC sin tocar el Estudio, ejecuta `npm run edition:try` desde la raíz de la instalación. Puede hacerse con el Estudio en marcha en 4310. La orden ejecuta `apps/server/scripts/edition-sandbox.ts`, que llama a `startEditionSandbox` (`apps/server/src/services/editionSandbox.ts`, sin IA). La Edición queda en `http://127.0.0.1:4320` y se detiene con Ctrl+C. Para ver la interfaz hace falta `apps/web/dist` (`npm run build`); sin él, solo responde la API.

- **Qué queda aislado:**
  - **Datos:** la Edición usa su propia carpeta. Por defecto es `<instalación>-edicion/data`, una carpeta hermana de la instalación; se puede cambiar con `PORTAL_EDITION_SANDBOX_DIR`. Ahí crea su propia `.master.key` y su propia base de datos.
  - **Worktrees:** usa su propia carpeta, `<instalación>-edicion/worktrees`.
  - **Variables del hijo:** el entorno fija de forma explícita `PORTAL_EDITION=distributable`, `PORTAL_PORT=4320`, `PORTAL_HOST=127.0.0.1`, `PORTAL_DATA_DIR` y `PORTAL_WORKTREES_DIR`. Deja vacías las claves de proveedor (`*_API_KEY`) y quita `PORTAL_PREVIEW_*` y `PORTAL_MAIN_BRANCH`. Como `config.ts` solo rellena desde `.env` las variables no definidas, el `.env` del Estudio no se cuela.
- **Qué no queda aislado:** la sesión de Claude Code del usuario (carpeta personal) es compartida.
- **El data/ del Estudio no se toca:** el servicio no importa `config.ts` (al cargarse crea carpetas y hace copias en `data/`) ni `repoWrite.ts`, y no usa `REPO_ROOT`. Solo importa módulos `node:*`. La raíz de la instalación y el data/ del Estudio le llegan como parámetros, y solo se leen para comparar rutas y el hash de la clave.
- **Carpetas rechazadas** (`unsafe_dir`): la carpeta de datos del Estudio, una que esté dentro de ella o que la contenga, una dentro de la instalación o que la contenga, la carpeta de worktrees del Estudio, la raíz de una unidad y la carpeta personal.
- **Fallos, en español y sin efectos:**
  - `already_running`: la Edición ya está en marcha.
  - `port_busy`: el 4320 está ocupado.

  En los dos casos no se lanza ningún proceso ni se crea ninguna carpeta. Hay otros dos fallos:
  - `start_failed`: el hijo termina o no responde a `/api/health` dentro del plazo.
  - `shared_key`: la clave de la Edición coincide con la del Estudio; la Edición se detiene.
- **Sin secretos:** nunca se registra ni se devuelve una clave, su hex ni su hash; solo «clave propia: sí/no». La salida del hijo se guarda en un búfer acotado de unas 200 líneas, y una línea que parezca un secreto o un hex de 64 caracteres se sustituye por «[salida omitida: contenía un posible secreto]».
- **Detención:** `stopEditionSandbox` mata al hijo, espera a que termine y a que el 4320 quede libre. Si el proceso padre sale, `process.once('exit')` mata también al hijo.
- **Prueba:** `apps/server/test/hu212-edicion-sandbox.test.ts` cubre el entorno, las rutas, `port_busy`, `already_running` y los guardianes. Uno de ellos importa el servicio en otro proceso y comprueba que la carpeta de datos sigue vacía. Las pruebas de integración se omiten, indicando el motivo, si el 4320 ya estaba ocupado o si falta `apps/web/dist`. Comprueban que `/api/health` responde, que la clave es propia y distinta de la sembrada, y que no aparece ninguna clave en logs, salida ni errores. También comprueban que el data/ del Estudio queda idéntico (archivos, contenido y mtimes) y que el pid muere y el puerto queda libre, tanto tras detener la Edición como tras la salida del padre.

## 5 · Aprendizaje organizacional

- Lecciones (`services/lessons.ts`, `lessonCurator.ts`): sin IA y a 0 USD, se detectan los errores y, al terminar cada tarea, el Curador los agrupa por causa, aplica la del catálogo y descarta ruido y duplicados. Solo las aplicadas se inyectan (proyecto y papel); se retiran solas si fallan 2 veces. El propietario puede editarlas o retirarlas.
- Plantillas versionadas (`services/agentTemplates.ts`): una lección validada puede promoverse a práctica de una plantilla (`clave@N+1`); los agentes existentes la adoptan con «Actualizar» y pueden volver atrás.

## 6 · Herramientas de los agentes

`read_repo` (leer el repositorio), `write_repo` (escribir en el worktree del proceso), `sandbox_exec` y `run_tests` (verificación en sandbox), `install_deps`, `knowledge_write` (documentos en Conocimiento), `delegate` (encargos). Cada agente solo tiene las que su configuración activa; la política las comprueba en el backend. Integrar, publicar, reiniciar y gastar IA son decisiones del propietario, no herramientas de agente.

## 7 · Limitaciones conocidas

- Nada de lo anterior se ha verificado con un proveedor de IA real ni sobre los datos reales del propietario; la primera ejecución real la autoriza el propietario con su presupuesto.
- La salida estructurada nativa (veredicto de QA: herramienta forzada en Anthropic, json_schema en OpenAI) está probada con respuestas simuladas, no contra los proveedores reales; si el proveedor la rechaza, se repite una vez sin ella y el motor valida el JSON. Con razonamiento extendido en Anthropic no se fuerza la herramienta (incompatible).
- La decisión de corregir tras un rechazo de QA la toma el pipeline con reglas deterministas en nombre del Coordinador (presupuesto, límites, fallos repetidos); no hay una llamada de IA del Coordinador para decidirlo.
- El compositor de equipos usa coincidencia léxica (sin IA): puede no elegir a un especialista si la historia no nombra su área (se añade a mano al ejecutar).
- No hay editor de conflictos de merge: un conflicto se resuelve con una iteración correctiva sobre el `main` actual.
- «Reconstruir y reiniciar» se lanza desde la barra del sistema, no desde la historia.
- Un bloqueo de Docker Desktop se detecta al agotarse el tiempo máximo del sandbox (10 minutos).
- La gravedad de las observaciones de QA antiguas (sin prefijo `[alta]/[media]/[baja]`) se infiere por palabras clave.
- Sin streaming: el estado en vivo muestra envío, inicio y fin de la respuesta, no el avance de la generación. Un bloqueo no declarado en la sección `BLOQUEO` se deduce por frases (heurística, así indicada).

## 8 · Verificado y cómo

- Pruebas del servidor (`apps/server/test/*.test.ts`): política y fail-closed, worktrees, sandbox Docker con aislamiento real (en Windows con Docker Desktop), composición de equipos, lecciones y plantillas, espacio de la historia e iteraciones, recorrido guiado y recuperación de errores, bandeja de autorizaciones, presupuestos, migraciones, etapas y archivo (`phase-transition.test.ts`), contrato de salida y pipeline autorizado (`autonomous-pipeline.test.ts`: recuperación local, reparación acotada, pipeline completo en Docker, corrección de un error de código, dependencias, presupuesto, fallo repetido) y salida estructurada en los adaptadores (`structured-output.test.ts`, sin red); fallos de agentes y del proveedor (`agent-failures.test.ts`).
- E2E de automejora: una copia del Portal arrancada con el supervisor recorre solicitud → ejecución → aplicar → verificar en sandbox → integrar → reconstruir y reiniciar → comprobar en ejecución (HTTP y navegador) → prueba manual → cerrar, más los escenarios de fallo (verificación, activación, parche, ejecución).
- Interfaz: recorridos con Playwright sobre instancias aisladas (recorrido guiado A–F, iteraciones, etapa y archivo, fallos de agentes).
- Paquete distribuible sin secretos: `hu206-paquete-sin-secretos.test.ts` comprueba el contenido y las exclusiones del árbol, que `findSecret` no marca nada y el 403 de la vista previa en la edición distribuible (ver «Paquete distribuible (HU-206)» en el apartado 4).
- Edición en la misma máquina: `hu212-edicion-sandbox.test.ts` comprueba el arranque en 4320 con carpeta y clave propias, que no se filtra ninguna clave y que el data/ del Estudio queda intacto. Comprueba también los fallos `port_busy` y `already_running`, y que el proceso muere y el puerto queda libre al detenerla y cuando sale el padre (ver «Probar la Edición en la misma máquina (HU-212)» en el apartado 4).
