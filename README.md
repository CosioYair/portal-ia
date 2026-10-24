# Portal IA (nombre provisional)

Sistema operativo empresarial multiagente, **local-first**. Esta es la **v0.1 real** (no un prototipo): implementa las historias HU-001 (conexión de proveedor de IA), HU-002 (inicialización del espacio interno) y HU-003 (equipo inicial de 8 agentes) con backend, base de datos y frontend funcionando sobre tu equipo.

> El propio Portal IA es su primer cliente: el espacio interno «Portal IA» y el proyecto «Desarrollo del Portal» que crea esta versión son los que el equipo de agentes usará para construir el resto del producto.

## Qué hace ya (real)

- **Conexión a proveedores (Anthropic / OpenAI).** La clave de API se guarda **cifrada (AES-256-GCM)** en SQLite local con una clave maestra generada en tu equipo; nunca se devuelve al navegador ni aparece en logs. La verificación hace **una sola llamada** real al proveedor (listado de modelos). No genera texto.
- **Catálogo de modelos real** del proveedor, con clasificación heurística (nivel, costo relativo, soporte de esfuerzo de razonamiento) y elección del modelo predeterminado.
- **Inicialización del espacio interno** (idempotente, 0 llamadas a IA): espacio «Portal IA» con su propia base SQLite, proyecto «Desarrollo del Portal», objetivos, contexto aprobado, tablas de conocimiento / historial / memoria.
- **Equipo inicial**: 8 agentes creados desde plantillas aprobadas (3 de espacio, 5 de proyecto), **inactivos**, con modelo preferido derivado del catálogo real del proveedor.
- **Registro del repositorio** con autorización explícita y acceso de solo lectura, eligiendo la carpeta con un **selector de carpetas real** (regla del producto: ninguna ruta local se escribe a mano).
- **Panel, equipo (organigrama) y configuración de agentes** con edición persistida: nombre, especialización, responsabilidades, modelo, alternativos, esfuerzo, herramientas/permisos, conocimiento, límites de gasto.

- **Evaluación inicial del proyecto (HU-004, v0.2)**: primer trabajo real del equipo. Con tu **autorización explícita y un presupuesto en USD**, el Coordinador, el Arquitecto y el Diseñador leen el repositorio registrado (solo lectura) y producen cuatro documentos: comprensión y dirección, evaluación técnica, dirección de diseño, y síntesis con backlog priorizado. Cada llamada real al proveedor queda registrada (tokens y costo estimado); el proceso se detiene entre pasos si se acerca al presupuesto; puede cancelarse. Los agentes implicados están **activos solo durante el proceso**. Resultados en **Conocimiento**; seguimiento en **Actividad**.
- **Selector de carpetas** que recorre todo el equipo (inicio, unidades, carpeta de esta instalación) con «Ir a ruta» validado contra el disco.
- **Creación de agentes especializados (v0.3)** — el propósito central del producto: Equipo de IA → «Nuevo agente especializado». Defines ámbito (espacio o proyecto), identidad, especialización, responsabilidades, a quién reporta y con quién colabora, modelo, esfuerzo, herramientas, conocimiento, límites y criterios de evaluación. Opcionalmente el **Agente de Onboarding propone la configuración** a partir de una descripción (1 llamada real, con tu autorización y costo visible), que tú revisas antes de crear. El organigrama se construye desde las relaciones reales, así que el nuevo agente aparece bajo su supervisor. Los agentes personalizados se pueden eliminar; los del equipo inicial, editar.
- **Backlog y ejecución de historias (v0.4)** — el ciclo completo de trabajo: la síntesis de la evaluación se importa como **historias** (también puedes añadir solicitudes propias). «Ejecutar» una historia lanza un proceso autorizado con presupuesto: el Coordinador hace el plan técnico, el Desarrollador entrega los **cambios completos** y QA los revisa. El resultado es un **diff** por archivo que tú apruebas; al aprobarlo se escribe en una rama `portal-ia/hu-xxx` del repositorio registrado con un commit. Después puedes ejecutar la **verificación** (`npm run typecheck|test|build`, ejecución local autorizada por uso) y marcar la historia como completada. Integrar la rama en `main` es decisión tuya.
- **Asistente global (v0.5)** — primera entrada del menú. Es el Asistente de Empresa en modo conversación: le pides en lenguaje natural y ejecuta acciones locales al instante (añadir historias al backlog del proyecto que indiques, crear proyectos, crear empresas con sus agentes) y responde sobre el estado real de la plataforma. Cada mensaje es una llamada al modelo (costo estimado visible por mensaje y gasto del mes frente a su límite mensual, que se aplica).
- **El asistente ejecuta el backlog y modifica el propio Portal (v0.6)** — sabe que el Portal es su primer cliente: cualquier mejora del producto (incluido el propio chat) se consigue añadiendo la historia al proyecto «Desarrollo del Portal» y ejecutándola con su equipo. Cuando le pides «ejecuta HU-007» o «añade X y hazlo», crea el proceso y muestra una **tarjeta de autorización en el chat** (pasos, modelos, costo estimado, presupuesto editable, casilla de autorización); nada se gasta hasta que pulsas «Autorizar y ejecutar». Igual con «aplica los cambios del proceso …»: tarjeta «Aplicar cambios» que escribe en la rama git solo con tu autorización. Las propuestas quedan resueltas (autorizada / fallida, con el error visible) y no se repiten al recargar. Admite **imágenes** (adjuntar o pegar capturas, hasta 4 por mensaje, 5 MB cada una), que se envían al modelo del asistente. La respuesta ya no duplica texto ni muestra JSON crudo.
- **Recuperar y reintentar (v0.9.1)** — un proceso fallido, cancelado o detenido por presupuesto ofrece dos botones en su propia pantalla: **«Recuperar el resultado (sin IA)»** vuelve a leer la salida que el Desarrollador ya entregó con las reglas actuales y, si hay cambios aplicables, deja el diff listo para revisar sin gastar nada; **«Volver a ejecutar la historia»** crea un proceso nuevo pendiente de autorización. El «siguiente paso» lo indica.
- **Ejecución más rápida, barata y robusta (v0.9)** — el Desarrollador modifica archivos existentes con **parches** buscar/reemplazar (no reescribe archivos enteros), con contexto acotado; un cambio inválido (ruta protegida, parche que no encaja) ya **no tumba el proceso**: se marca «no aplicable», se muestra y el resto se aplica. `.env.example` y similares se permiten (solo se protegen `.env` reales, claves y `data/`). Escaneo de posibles **secretos** con aviso. Revisión de QA **opcional** por historia. `npm install` disponible como verificación autorizada.
- **Estado veraz y siguiente paso (v0.9)** — cada proceso lleva una orientación calculada en el servidor («Diff listo para revisar», «Aplicado · falta integrar», «Integrado · falta publicar», «Falló: motivo…») con el siguiente paso del propietario; la ven la vista del proceso, el backlog y las tarjetas del chat, que se actualizan solas (nada de «en ejecución» cuando ya terminó).
- **Backlog saneado y compacto (v0.9)** — secciones plegables (en curso, pendientes por prioridad, completadas, descartadas), búsqueda y filtros; orden real por posición. Al arrancar, un saneamiento único del backlog interno cierra como hechas las historias ya implementadas en el Portal, descarta las obsoletas del repositorio paralelo, fusiona duplicadas y ordena lo pendiente con la automejora como prioridad (ver `apps/server/src/services/backlogMaintenance.ts`, cada decisión con su motivo en la descripción de la historia).
- **Chat usable de verdad (v0.8.1)** — el asistente flotante es realmente fijo (siempre visible sin hacer scroll), más alto, con modo «ancho» y sin empujar el resto de la pantalla; admite mensajes largos (hasta 400 000 caracteres), **archivos de texto** (.md, .txt, .json, .csv, código…) por botón, arrastre o pegado, además de imágenes; los mensajes largos se muestran plegados. Las propuestas de los encargos se extraen aunque el modelo las ponga en un bloque `json` o la respuesta se corte (se recuperan las completas y se pide continuación); los encargos antiguos se reparan al abrirlos. Backlog muestra «Pendientes de tu decisión» con acceso directo a aplicar propuestas, revisar diffs o integrar.
- **Encargos a los agentes (v0.8)** — no todo es una historia de desarrollo. «Revisa y replantea el backlog», «propón la organización de la nueva empresa», «evalúa si conviene X»: el Asistente lo encarga al **agente responsable** del ámbito (Coordinador del Proyecto para asuntos del proyecto; Gestor Organizacional para la empresa; Agente de Onboarding para agentes; o el que nombres). Ese agente **valida** el encargo, **consulta a los agentes a su cargo** si hace falta (relación real de jerarquía, hasta 3) y entrega el resultado en Conocimiento con **propuestas de cambio al backlog** (añadir, actualizar, fusionar, descartar, repriorizar) que tú aplicas con un clic. Se autoriza con presupuesto como cualquier proceso; también desde Backlog → «Encargo al equipo».
- **El Portal mejora su propio código de verdad (v0.8)** — el proyecto interno exige que su repositorio sea **la carpeta desde la que corre el Portal**; si apunta a otra (un repo vacío, una copia), las historias se detienen antes de gastar y el Panel ofrece «Usar la carpeta de esta instalación». Tarjeta **Repositorio** con el estado git real (rama, main, limpieza, remoto, commits por publicar) y las operaciones del flujo: crear `main` si el repo nació sin ella, configurar el remoto de GitHub, publicar `main`. Cada historia crea su rama **desde main**, no desde la rama que esté activa.
- **Aviso de sincronización y actualización con un clic (v0.8)** — cuando el código del Portal cambia respecto al que arrancó (historias integradas), una barra indica si basta recargar o hay que reconstruir y reiniciar, y lo hace con tu autorización: `npm install` (si cambiaron dependencias), `npm run build` y reinicio del servidor; la página se recarga sola al volver.
- **Regla de cierre y asistente siempre visible (v0.8)** — una historia solo se cierra cuando sus cambios están integrados en `main` (o la cierras explícitamente como «resuelta fuera del flujo», con motivo); el Backlog muestra «aplicada · falta integrar» / «integrada · falta publicar». El Asistente está disponible en todas las pantallas como panel flotante, con contador de propuestas por autorizar.
- **Ciclo completo hasta GitHub (v0.7)** — desde el proceso de una historia: Aplicar (rama local) → Verificar → **Integrar en la rama principal** (merge con commit) → **Publicar en el remoto** (`git push` con las credenciales git de tu equipo). Cada paso requiere tu autorización; hasta «Publicar» nada sale de tu equipo. Si el repositorio es el del propio Portal, tras integrar hay que `npm run build` y reiniciar para que la mejora entre en funcionamiento (lo indica la pantalla).
- **Entregas del Desarrollador más fiables (v0.7)** — el Desarrollador ya no devuelve los archivos dentro de un JSON (frágil y caro en tokens) sino en bloques `=== ARCHIVO: ruta | create|modify|delete === … === FIN ARCHIVO ===`. Si la respuesta se corta por longitud, el Portal pide continuar (hasta 2 veces) y, si aun así un archivo queda incompleto, lo dice con nombre y no aplica nada a medias. Límite de salida del Desarrollador: 16 000 tokens por llamada.
- **Asistente más preciso (v0.7)** — resuelve referencias a historias por número («HU-15» = HU-015) o por título, no propone dos veces la misma historia en una respuesta, avisa si ya hay un proceso en ejecución, y las historias nuevas siguen la numeración del backlog (HU-014 → HU-015) en lugar de saltar a HU-1xx. Si el modelo responde en el formato antiguo y se corta, se muestra el texto legible en vez del JSON crudo.
- **Repositorios recién creados y errores visibles (v0.6.1)** — aplicar cambios funciona también sobre un repositorio sin commits (la rama nace vacía con `--orphan`); si falla, el error se muestra junto al botón «Aplicar», y el repositorio se deja como estaba. El veredicto de QA tiene más espacio de salida y, si aun así se corta, se rescata el texto legible y se indica.
- **Ejecutar una historia abre un diálogo (v0.6)** — en Backlog, «Ejecutar» abre una ventana modal con la estimación por paso, presupuesto y autorización; los errores de estimación o de arranque se muestran dentro del propio diálogo.
- **Varias empresas y proyectos (v0.5)** — el selector de empresa y de proyecto del menú funcionan: crea empresas (base SQLite propia + 3 agentes de espacio) y proyectos (+ 5 agentes de proyecto). Todo lo demás (evaluación, backlog, ejecución, conocimiento) opera sobre la empresa/proyecto seleccionados. Rutas profundas: `/empresa/<slug>/proyecto/<id>/backlog`.
- **Importación del backlog robusta (v0.5)** — reconoce JSON (en cualquier bloque), tablas y listas con `HU-xxx`; si aun así no encuentra historias, el Coordinador las extrae con una llamada que autorizas en el mismo botón, con su costo.
- **Consumo honesto**: todas las cabeceras muestran el consumo real del día (llamadas, tokens, USD) tomado del historial de ejecución. Si una llamada al proveedor se corta (red/tiempo de espera), se registra el costo **estimado** de la entrada enviada y se marca como estimación, en lugar de mostrar 0.

## Qué NO hace todavía (siguientes historias)

Sandbox real (Docker/WSL2) para la verificación —hoy se ejecuta localmente, solo comandos `npm run` permitidos y con tu autorización—, presupuestos por historia aplicados en servidor, activación permanente de agentes, varias empresas, integración automática de ramas. Fuera de un proceso o propuesta autorizados, **ningún agente consume créditos**.

### Consolidar tu repositorio en `main` y en GitHub (una vez)

Si tu repositorio nació sin `main` (solo ramas `portal-ia/hu-xxx`) o el Portal corre desde una carpeta distinta a la registrada:

1. En la carpeta donde corre el Portal (la que contiene este README): `git add -A && git commit -m "Portal IA v0.8"` y, si la rama activa no es `main`, `git branch -M main`.
2. Arranca el Portal, ve al **Panel** del proyecto «Desarrollo del Portal» y, si el repositorio registrado es otro, pulsa **«Usar la carpeta de esta instalación»**.
3. En la tarjeta **Repositorio**: pega la URL de GitHub en «Remoto», marca la autorización y pulsa **«Añadir remoto»**; luego **«Publicar main en el remoto»**.
4. En GitHub → Settings → Branches, fija `main` como rama por defecto. Las ramas `portal-ia/hu-xxx` antiguas puedes borrarlas.

El repositorio anterior (el que construyeron los agentes aparte) queda como archivo; sus documentos están en `docs/agentes/`.

### Importante al actualizar sobre tu repositorio

Si copias una versión nueva encima de tu carpeta (la misma que registraste como repositorio), **confirma los cambios en git antes de ejecutar historias**: `git add -A && git commit -m "Portal IA vX.Y"`. Aplicar cambios de los agentes exige un árbol de trabajo limpio, precisamente para que todo lo que escriban quede en su propia rama y sea reversible.

## Cómo seguir desarrollando dentro del proyecto

El flujo pensado es que el **equipo de agentes** continúe el desarrollo sobre este mismo repositorio. Para ello:

1. Ejecuta la **Evaluación inicial** (panel). Produce la dirección, la evaluación técnica, la de diseño y un **backlog priorizado** (en Conocimiento, con un bloque JSON al final de la síntesis).
2. Crea los **agentes especializados** que ese backlog pida (p. ej. Documentador, DevOps, Analista de datos) desde Equipo de IA.
3. Abre **Backlog**, elige la primera historia y pulsa «Ejecutar». Revisa el diff, aplícalo en la rama, verifica, y marca como completada. Repite. Las historias con dependencias esperan a que la dependencia esté completada.
4. Cuando una rama te convenza, intégrala en `main` (`git merge portal-ia/hu-xxx`) y, si tocó el frontend, `npm run build` para ver los cambios en la interfaz.

Convenciones que ya sigue el código y conviene mantener: dominio compartido en `packages/domain` (tipos y plantillas, sin lógica de IO); adaptadores por proveedor en `packages/ai-adapters` (toda llamada a un modelo pasa por `complete()` y registra tokens/costo); una base SQLite por espacio; rutas Fastify delgadas que validan con zod y delegan en `services/`; frontend con pantallas en `apps/web/src/screens` y componentes en `components`, textos en español, estados explícitos (inactivo/activo, autorizado/ejecutando) y nunca una acción con costo sin autorización explícita en la UI. Pruebas: `npm test` (backend, sin red).

---

## Requisitos

- **Node.js ≥ 22.13** (LTS). Usa SQLite integrado de Node (`node:sqlite`): sin compilaciones nativas, funciona igual en Windows, WSL2, macOS y Linux. Comprueba con `node -v`.
- npm ≥ 10 (viene con Node).
- Una **clave de API** de Anthropic (console.anthropic.com) u OpenAI (platform.openai.com). Una suscripción de consumo (Claude.ai / ChatGPT) **no** sirve.

## Despliegue paso a paso

### Paso 1 · Instalar

```bash
cd portal-ia
npm install
```

### Paso 2 · (Opcional) Configuración

```bash
cp .env.example .env     # en Windows: copy .env.example .env
```
Valores por defecto: puerto `4310`, host `127.0.0.1` (solo tu equipo), datos en `./data`. No pongas claves de API en `.env`: se introducen desde la interfaz.

### Paso 3 · Comprobar (opcional pero recomendado)

```bash
npm run typecheck   # tipos en los 4 paquetes
npm test            # pruebas del backend (cifrado, bootstrap, API)
```

### Paso 4 · Arrancar

**Modo producción local** (una sola URL, recomendado para usarlo):
```bash
npm run build       # compila el frontend en apps/web/dist
npm start           # backend en http://127.0.0.1:4310 sirviendo también la interfaz
```
Abre **http://127.0.0.1:4310**.

**Modo desarrollo** (recarga en caliente, dos procesos):
```bash
npm run dev:server  # terminal 1 · backend con recarga
npm run dev:web     # terminal 2 · Vite en http://localhost:5173 (proxy /api → 4310)
```

### Paso 5 · Primera ejecución (en el navegador)

1. **Bienvenida** → «Conectar un proveedor de IA».
2. **Proveedor**: elige Anthropic u OpenAI, pega tu clave, «Verificar conexión». Verás el estado real (Conectada / Error con el motivo del proveedor) y la lista de modelos real. Elige el modelo predeterminado → «Continuar».
3. **Inicialización**: se crean el espacio, el proyecto y los 8 agentes (todo local, 0 llamadas a IA). Opcionalmente registra el repositorio: «Examinar…» abre el selector de carpetas; solo se admiten carpetas con repositorio git; marca la autorización → «Registrar repositorio».
4. **Evaluación inicial** (en la misma pantalla, o después desde el panel): revisa agentes, modelos y costo estimado, fija el presupuesto máximo, marca la autorización y pulsa «Autorizar y ejecutar». Verás el proceso en vivo (pasos, tokens, costo) y al terminar la síntesis con el backlog en el panel y en **Conocimiento**. Consejo: antes de autorizar puedes cambiar el modelo de cada agente en **Equipo de IA** para ajustar el costo.
5. **Panel del proyecto** → «Configurar equipo» → organigrama → clic en un agente → edita y «Guardar cambios».

Al reiniciar la aplicación todo persiste (`data/`). Para empezar de cero: para el servidor y borra la carpeta `data/`.

## Dónde quedan los datos

```
data/
  .master.key                  clave maestra de cifrado (0600) · NO la compartas ni la subas a git
  platform.sqlite              proveedores, credenciales cifradas, registro de espacios
  workspaces/portal-ia/
    portal-ia.sqlite           proyecto, objetivos, contexto, agentes, repositorio, conocimiento, historial, memoria
```
`data/` está en `.gitignore`. Cada empresa futura tendrá su propia carpeta y base en `workspaces/<slug>/`.

## Estructura del monorepo

```
packages/domain        tipos compartidos, plantillas de agentes, heurísticas de modelos
packages/ai-adapters   adaptadores por proveedor (listado de modelos; generación en historias futuras)
apps/server            Fastify + node:sqlite · rutas /api · cifrado de credenciales · sirve apps/web/dist
apps/web               React 19 + Vite 7 · pantallas A–F · FolderPicker · sistema de diseño en styles.css
```

### API local (resumen)

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/health` | estado del backend |
| GET | `/api/providers` | proveedores con estado, pista de credencial, modelos, modelo predeterminado |
| PUT | `/api/providers/:id/credential` `{apiKey}` | guarda cifrada (no se devuelve) |
| DELETE | `/api/providers/:id/credential` | elimina la credencial |
| POST | `/api/providers/:id/verify` | **1 llamada real** al proveedor → `connected` + modelos, o `failed` + motivo |
| PUT | `/api/providers/:id/default-model` `{modelId}` | modelo predeterminado |
| GET | `/api/fs/roots` | raíces navegables: inicio, unidades, carpeta de esta instalación |
| GET | `/api/fs/dirs?path=…` | carpetas (solo directorios) + detección de git |
| GET | `/api/workspaces/:slug/projects/:id/assessment/estimate` | estimación de la evaluación inicial (pasos, modelos, USD aprox.) |
| POST | `/api/workspaces/:slug/projects/:id/assessment` | crea el proceso en estado `pending_authorization` (no consume) |
| POST | `/api/workspaces/:slug/processes/:id/authorize` `{budgetUsd, authorized:true}` | **autoriza y ejecuta** (único punto de consumo de IA) |
| POST | `/api/workspaces/:slug/processes/:id/cancel` | cancela (se detiene entre pasos) |
| GET | `/api/workspaces/:slug/projects/:id/processes` · `/api/workspaces/:slug/processes/:id` | procesos y detalle con pasos |
| GET | `/api/workspaces/:slug/projects/:id/knowledge` | documentos generados |
| GET/POST/DELETE | `/api/assistant` · `/api/assistant/messages` | conversación con el Asistente (POST = 1 llamada real; acepta `images[]` base64; ejecuta acciones locales y crea propuestas pendientes) |
| GET/POST | `/api/workspaces/:slug/projects/:id/repository/status` · `/init-main` · `/remote` · `/publish-main` | estado git real · crear `main` · configurar remoto · publicar `main` (con `authorized: true`) |
| POST | `/api/workspaces/:slug/delegations/estimate` · `/delegations` · `/processes/:id/backlog-ops/apply` | encargo a un agente responsable (estimar, crear pendiente de autorización, aplicar sus propuestas al backlog) |
| GET/POST | `/api/system/status` · `/api/system/update` | código arrancado vs. actual · reconstruir y reiniciar (con `authorized: true`) |
| POST | `/api/workspaces/:slug/processes/:id/merge` · `/publish` | integrar la rama en la principal · publicar en el remoto (ambos con `authorized: true`) |
| POST | `/api/assistant/messages/:id/resolve` | marca una propuesta del chat como autorizada/fallida tras resolverla desde la tarjeta |
| POST | `/api/workspaces` `{name}` · `/api/workspaces/:slug/projects` `{name, description}` | crear empresa / proyecto con sus agentes (sin IA) |
| GET/POST | `/api/workspaces/:slug/projects/:id/backlog` · `…/backlog/import` | historias; importar desde la síntesis |
| PATCH/DELETE | `/api/workspaces/:slug/backlog/:id` | editar estado/datos; eliminar |
| GET/POST | `/api/workspaces/:slug/projects/:id/backlog/:item/estimate` · `…/execute` | estimar; crear el proceso de ejecución (pendiente de autorización) |
| POST | `/api/workspaces/:slug/processes/:id/apply` `{authorized:true, branch?}` | escribe los cambios en una rama git y hace commit |
| POST | `/api/workspaces/:slug/processes/:id/verify` `{authorized:true, command}` | ejecuta `npm run typecheck|test|build` localmente |
| GET | `/api/bootstrap/status` | si hay proveedor y si el espacio interno está inicializado |
| POST | `/api/bootstrap/internal` | crea espacio, proyecto, estructuras y 8 agentes (idempotente) |
| GET | `/api/workspaces/:slug/projects` | proyectos con objetivos, contexto, repositorio |
| POST | `/api/workspaces/:slug/projects/:id/repository` `{path, authorized:true}` | registra repo (solo lectura, exige `.git`) |
| GET | `/api/workspaces/:slug/agents[/:id]` | agentes |
| POST | `/api/workspaces/:slug/agents` | crea un agente especializado (inactivo; valida relaciones, modelo, herramientas) |
| DELETE | `/api/workspaces/:slug/agents/:id` | elimina un agente personalizado (no los del equipo inicial ni activos) |
| GET | `/api/workspaces/:slug/agents/draft/estimate` | costo estimado de una propuesta con IA |
| POST | `/api/workspaces/:slug/agents/draft` `{description, scope, authorized:true, maxUsd}` | el Agente de Onboarding propone la configuración (1 llamada real) |
| PUT | `/api/workspaces/:slug/agents/:id/config` | guarda configuración (validada contra el catálogo real) |
| GET | `/api/workspaces/:slug/usage/today` | procesos, tokens y costo del día (hoy: 0) |

## Seguridad (v0.1)

- El backend escucha solo en `127.0.0.1`. CORS limitado a `localhost`.
- Credenciales cifradas en reposo; redactadas en logs (`req.body.apiKey`).
- El explorador de carpetas solo lista directorios (nunca contenido de archivos). Recorre todo el equipo porque es una app local tuya; `PORTAL_FS_RESTRICT=home` lo limita a tu carpeta de usuario.
- El contexto que leen los agentes excluye `node_modules`, `.git`, `dist`, `data` y cualquier archivo que parezca contener secretos (`.env`, `*.key`, `*.pem`, `secret`, `credential`).
- Los costos mostrados son **estimaciones** con tarifas públicas por familia de modelo; el importe exacto lo factura el proveedor.
- Registro de repositorio: solo lectura; exige autorización explícita (`authorized: true`) y un `.git`.
- Pendiente para historias futuras: clave maestra en el llavero del SO, autorización por ejecución de herramientas, límites de gasto aplicados en servidor.

## Entregar este proyecto a los agentes

El plan es que el equipo de agentes trabaje sobre este mismo repositorio. Lo que ya les dejamos como base aprobada: `README.md` (este), `DESIGN_HANDOFF_Portal_IA.md` (diseño de las pantallas y sistema de diseño), `packages/domain` (contratos y plantillas) y las pruebas en `apps/server/test`. La siguiente historia a implementar es la **activación de agentes con autorización de ejecución y presupuesto**, que es lo que convierte las "Solicitudes de desarrollo" del panel en trabajo real.
