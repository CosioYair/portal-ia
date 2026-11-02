# Portal IA · Sistema operativo visual de agentes (2 de noviembre de 2026)

> Rama `mejora/sistema-operativo-agentes` (desde `6eb119f`). **No integrada en `main`, no publicada, no activada.**
> Contratos: `docs/agentes-portables.md` (carpeta del agente) y `docs/arneses.md` (arneses y Codex).

## 1. La referencia (Pulpo) y sus límites

- **Vídeo** (`youtube.com/watch?v=SXniJe0Cf6I`, t=3639 s): solo se pudo leer el título, «Crea agentes de IA en Claude que
  trabajan por ti en 60 minutos». La página no expuso descripción, capítulos ni transcripción; no se analizó su contenido ni
  hay marcas de tiempo, y nada de este diseño se apoya en detalles del vídeo.
- **Captura**: el encargo anunciaba una captura de la interfaz, pero no llegó adjunta. El diseño parte de la descripción del
  propietario: oficina con personajes, agrupación, indicadores de atención, bandeja central, área de órdenes, conocimiento,
  panel de conversación con pestañas Chat/Solicitudes/Tablero/Archivos/Memoria/Configuración, tira de agentes y contadores.
- **Lo que se toma**: el modelo de interacción (la empresa como un lugar; abrir un agente y tenerlo todo ahí; ver de un
  vistazo quién trabaja y quién te necesita). **Lo que no**: ni marca, ni ilustraciones, ni código: los personajes son
  propios (SVG generado de forma determinista por agente) y la paleta sale de los tokens del Portal.

## 2. Posicionamiento

**Portal IA es el plano de control; los arneses son motores de ejecución; los agentes son identidades del propietario.**
No se construyen modelos ni se recrea Claude o ChatGPT: el Portal pone la organización (departamentos, encargos,
peticiones), la propiedad (carpetas locales y portables), los permisos y autorizaciones, la contabilidad, la auditoría y una
interfaz que una persona no técnica entiende. Empezar con Claude Code, probar Codex, añadir habilidades, ordenar agentes en
departamentos y gestionar su trabajo sin reconstruir nada.

## 3. Arquitectura: antes y después

| | Antes (`6eb119f`) | Ahora |
|---|---|---|
| Identidad del agente | Fila `agents` (config JSON) | Fila (lo concedido) + **carpeta portable** con revisiones en la base (`agent_folders`, `agent_revisions`) |
| Arnés | `config.backend` api / claude-code / consola; «no API» = Claude Code | Registro de arneses con capacidades reales; **Codex** como arnés propio; despacho explícito y *fail closed* en todo el código; arnés e identidad fijados por encargo |
| Aprendizaje | Lecciones de la organización | + **memoria de cada agente** (lecciones con `agent_id`), solo verificada por el propietario |
| Organización | Organigrama por «reporta a»; etiqueta de departamento solo en propuestas organizativas | **Departamentos** con propósito y coordinador sobre esa misma etiqueta; peticiones a un departamento |
| Trabajo de un agente | Encargos delegados del Asistente | + **encargos directos** (una llamada), **chat por agente** (carril propio, tope diario), peticiones a departamentos con equipo fijado |
| Interfaz | Panel administrativo | **Oficina** como portada, panel del agente en 6 pestañas, asistente de creación sin código; todo lo anterior intacto |
| Auditoría | Ejecuciones y políticas | + `agent_events` (creación, importación, arnés, departamento, carpeta, memoria, encargos) |

Capas: **A** identidad portable (`portable-agent.ts`, `agentFolders.ts`, `agentIdentity.ts`, `agentLearning.ts`) ·
**B** arneses (`harness.ts`, `harness/index.ts`, `harness/codex.ts`, despacho en `claudeCode/backend.ts`) ·
**C** orquestación e interfaz (`agentOs.ts`, `departments.ts`, `agentChat.ts`, `agentCreation.ts`, `delegation.ts`,
`routes/agentsOs.ts`, `screens/Office.tsx`, `components/AgentPanel.tsx`, `screens/AgentWizard.tsx`).

## 4. Diseño visual

- **Oficina**: cada departamento es una sala (cartel, propósito, suelo de baldosas, contador), cada agente un puesto con su
  personaje (pelo, tono de piel y accesorio deterministas por id; camiseta del color del departamento) y su pantalla.
- **Estados reales** (calculados en el servidor de procesos, pasos, conversaciones y decisiones; nunca animaciones al azar):
  *Trabajando* (pantalla encendida, manos que teclean), *En cola* (pantalla en espera, reloj), *Te necesita* (insignia «!»),
  *Disponible*, *Retirado* (gris). Siempre con texto y forma, no solo color; animaciones sobrias que se detienen con
  «reducir movimiento».
- **Vista Lista** densa y accesible (tabla con encabezados y `caption`), búsqueda a partir de 13 agentes, salas que muestran
  primero a quien te necesita o trabaja (12 y «Ver todos»), **tira de agentes** fija al pie del contenido.
- **Barra de órdenes** «Pide algo a tu empresa…»: `@Nombre …` → su chat; `Marketing: …` → petición al departamento; el resto →
  el Asistente. Muestra la ruta antes de enviar.
- Tokens nuevos `--color-office-*` en `tokens.css`; `office.css` cumple las reglas de tokens (sin colores, radios ni duraciones
  escritos a mano; lo comprueba `design-tokens-migration.test.ts`). Paneles y diálogos montados en `<body>` por encima de
  los botones flotantes. Carga diferida de la oficina y del asistente.

## 5. Pantallas y recorridos

- `/oficina` (portada; `/panel` sigue igual): salas, contadores (agentes, trabajando, te necesitan, decisiones), Lista,
  Arneses, Nuevo departamento, Nuevo agente, barra de órdenes, tira.
- `/oficina/agente/<id>/<pestaña>` — **Chat** (una llamada por mensaje con su arnés; con la API, confirmación del costo en
  cada envío; «¿Qué debería aprender?»), **Solicitudes** (lo que espera de ti), **Trabajo** (nuevo encargo con autorización;
  tablero Por autorizar / En cola / Haciendo / Hecho / Detenido; entregables; «Valorar y enseñar»), **Archivos** (carpeta,
  cambios externos con diff para adoptar o descartar, instrucciones, habilidades, revisiones y vuelta atrás, exportar),
  **Memoria** (por verificar / verificada; verificar, editar, retirar), **Configuración** (identidad, departamento, arnés
  con compatibilidad y autorización, permisos, registro).
- `/oficina/nuevo-agente` — 1 ¿Qué necesitas? (ejemplos y sugerencias deterministas, sin IA) → 2 Identidad (nombre,
  departamento, papel, responsabilidades, entregables, habilidades, conocimiento, dónde trabaja) → 3 Cómo trabaja (arnés
  disponible, herramientas en lenguaje llano, autonomía; avanzadas: modelo, esfuerzo, instrucciones) → 4 Revisión (puede /
  no puede / accede a / necesita tu aprobación / arnés; autorización) → 5 Primera tarea segura. Importar una carpeta desde
  el paso 1.

## 6. Departamentos y centro de órdenes

Un departamento es la etiqueta `template.department` de sus agentes (la misma que usan las evaluaciones organizativas) más
su propósito y coordinador. «Marketing, investiga oportunidades para Orbiventt»: el coordinador recibe la petición, valida,
consulta a los miembros que confirmaste (hasta 6, fijados al crear la petición) y entrega **un** resultado consolidado en
Conocimiento, con la autorización de siempre (0 USD de API si todo el equipo va por suscripción). El Asistente conoce las
pantallas nuevas (su mapa de pantallas) y la barra de órdenes deriva a él lo que no es un agente o un departamento. La
proactividad programada no se activa en esta entrega (sección 10).

## 7. Gauntlet

Ciclo: investigar → cuestionar el diseño → plan → implementar → verificar → revisiones independientes → corregir →
reverificar. Resumen (detalle en el informe de la entrega):

- **Revisión del diseño** (independiente, antes de implementar) — 3 bloqueantes adoptados: (1) todo el código trataba
  «no API» como Claude Code: Codex habría corrido como Claude Code, entrado en lotes autorizados para Claude o caído a la API
  → despacho explícito, `BatchSource 'codex'`, guardas en historias; (2) bloquear el cambio de arnés no protegía el trabajo en
  pausa ni las historias aún sin proceso → arnés e identidad fijados por encargo y origen comprobado en cada llamada; (3) los
  prompts de los agentes existentes cambiarían con un AGENTS.md generado → identidad solo con contenido propio. Mayores
  adoptados: departamentos sobre la etiqueta existente; memoria = lecciones con `agent_id`; migración bajo demanda; nombres de
  carpeta `<clave>-<id8>`; Codex con lista permitida comprobada en vez de lista de denegación.
- **Hallazgo propio verificado (sin llamar al modelo)**: la CLI de Codex instalada expone `exec` y herramientas de subagentes
  aunque se desactive todo lo desactivable → Codex queda bloqueado en este equipo (`docs/arneses.md` §3).
- **Pruebas en navegador**: botón «Enviar» del chat tapado por el botón flotante del Asistente, tira bajo «Autorizaciones»,
  tipografía con serifa en el panel, etiquetas «No verificado» con la suscripción verificada, foco robado a las pestañas,
  compatibilidad que no mostraba lo que cambia si el agente no lo usa hoy → corregidos y reverificados.
- **Rendimiento**: con 100 agentes `GET /office` tardaba 305 ms (departamento calculado de forma cuadrática y relectura de
  todas las carpetas en cada aviso) → firma de carpeta en caché y departamento directo: 34 ms.
- **Revisiones independientes de la implementación** (tres revisores con contexto nuevo; los hallazgos materiales se
  reprodujeron con scripts y quedaron cubiertos por pruebas de regresión):
  - *Seguridad y arneses*: (M) la comprobación de herramientas de Codex fallaba ABIERTA ante una salida inesperada o
    herramientas sin nombre → ahora exige código 0 y la sección conocida, cuenta toda herramienta (con o sin nombre), se hace
    con el modelo del agente antes de cada ejecución y los eventos de la CLI van por lista permitida; (M) «Descartar» sobre
    una carpeta sustituida por una *junction* escribía y borraba fuera → nunca se escribe a través de un enlace; (M) una
    carpeta plantada con el nombre previsible de un agente se adoptaba sin revisión (con un secreto) → nunca se adopta: se
    usa otro nombre; (M) importar concedía los papeles pedidos y no mostraba lo que llega al prompt → papeles solo si los
    concedes, vista previa con instrucciones, habilidades y referencias completas; (m) adoptar o volver atrás podía dejar la
    fila a medias → todo bajo un cerrojo y con vuelta atrás de la fila; (m) cola de Codex que podía bloquearse → contador
    dentro del `try`, esperas abortadas fuera y plazo de cola; (m) comprobaciones de rutas solo léxicas → ruta real
    (`realpath.native`), sin unidades de red y escritura exclusiva al exportar; (m) la ruta antigua del backend pasaba a la API
    sin autorización → la exige y nunca con una llamada en curso; (m) autonomía adoptable desde la carpeta → no; (m) habilidades
    con nombre que no se guardaban → slug válido.
  - *Integración y regresiones*: (M) un encargo o petición que no se podía autorizar dejaba un proceso pendiente fantasma por
    reintento → se cancela con el motivo; (M) renombrar un departamento impedía volver a crear su nombre (error 500) y
    confundía búsquedas por id → id propio y comprobación contra todos los departamentos; (m) el arnés fijado se comprobaba
    en la primera llamada → al autorizar; sin revisión fijada, sin identidad; (m) la memoria de un agente podía convertirse en
    lección de la organización por las rutas de lecciones → 409 y `agent_id` en la inserción; (m) chat: prompt antes de
    registrar la respuesta en curso, la API exige límite mensual y el historial alterna turnos; (m) recargas por cada tick de
    progreso → solo cambios de estado, huella de carpeta en caché también en el panel; (m) una escritura a medias parecía un
    cambio externo → se repone la revisión adoptada. Confirmó que los flujos existentes se comportan igual.
  - *Interfaz y accesibilidad*: (C) el asistente ofrecía «Claude Code (tu consola)», cuyo chat siempre falla → fuera del
    asistente y chat desactivado con explicación para esos agentes; (M) diálogos bajo el panel, un Escape cerraba ambos,
    foco robado en cada render y sin trampa de Tab → diálogos por encima, Escape solo del de arriba (y no mientras escribes),
    foco inicial, trampa y devolución al que lo abrió; (M) controles desbordados en el panel (`box-sizing`); (M) el panel
    podía mostrar el chat de OTRO agente con clics rápidos → respuestas descartadas si no son del agente abierto; (M) la barra
    de órdenes enviaba su propio ejemplo «@Arquitecto revisa…» al Asistente → nombre más largo que coincide; departamento
    con nombre exacto; (M) «Añadir agente» de una sala no respetaba el departamento → se respeta, y el borrador se ve y se
    descarta; (M) «Disponible» para agentes cuyo arnés no puede trabajar → estado «No puede trabajar» con el motivo; (M)
    callejón sin salida sin arnés → aviso con dónde arreglarlo y por qué «Continuar» está desactivado; (M) entregables
    ilegibles en columnas estrechas → lector a lo ancho con enlace a su proceso; (M) peticiones a un departamento con
    coordinador por API sin presupuesto → cuenta el coordinador; (M) cerrar el panel creaba otra entrada en el historial → vuelve
    atrás y devuelve el foco al puesto; (M) jerga (ids de modelo y herramientas, tokens, versiones de CLI, permisos de
    desarrollo ofrecidos a Marketing) → lenguaje llano, detalles técnicos plegados y permisos de desarrollo bajo «Más
    permisos»; menores: recuento de sala, rutas con el selector de carpetas, regiones vivas, contraste de los puntos,
    Inicio/Fin en pestañas, envío con teclado con las mismas comprobaciones, confirmación de «Descartar» y «Volver a esta»,
    Lista por defecto en móvil.

## 8. Pruebas y medidas

- `sistema-operativo-agentes.test.ts` (26: 19 del diseño + 7 regresiones de las revisiones; CLI de Codex simulada, proveedor
  simulado), `oficina-wiring.test.ts` (4), `office.css` bajo las reglas de tokens; suite completa con Docker obligatorio sin
  fallos (cifras exactas del árbol final en el informe de la entrega).
- Navegador real (Chromium, Portal aislado, Claude Code y Codex simulados): recorrido completo del propietario, 37/37
  comprobaciones (departamento → Codex comprobado y habilitado con autorización → agente creado con el asistente → primera
  pregunta → encargo con entregable → opinión → aprendizaje verificado → MEMORY.md → cambio a Codex con compatibilidad →
  chat con Codex con la memoria en el prompt y en modo restringido → identidad intacta → petición a Marketing desde la barra
  → Lista → teclado), sin errores de JavaScript ni respuestas 5xx. Segundo recorrido con Codex como en este equipo (expone
  herramientas): 13/13 — la interfaz dice que está bloqueado y por qué, no deja habilitarlo ni elegirlo, 0 ejecuciones; e
  importación por la interfaz (lo pedido no viene concedido, contenido visible antes de importar, id nuevo).
- Rendimiento (Chromium, mediana de 5; API mediana de 20):

| Agentes | GET /office | Oficina visible | Abrir panel | A Lista | Nodos DOM | Panel (`/panel`, referencia) |
|---|---|---|---|---|---|---|
| 8 | 1 ms | 54 ms | 74 ms | 41 ms | 569 | 670 ms |
| 10 | 2 ms | 62 ms | 70 ms | 41 ms | 689 | 676 ms |
| 50 | 16 ms | 73 ms | 133 ms | 41 ms | 2 598 | 667 ms |
| 100 | 34 ms | 102 ms | 139 ms | 65 ms | 4 499 | 685 ms |

  «3 agentes» no es una empresa posible hoy (una empresa nace con 3 agentes de espacio y cada proyecto con 5); el mínimo
  medible es 8. Con 100 agentes la oficina pinta 80 puestos (12 por sala, el resto con «Ver todos») y la Lista los 100; antes
  de las correcciones de rendimiento, `GET /office` tardaba 305 ms y abrir el panel 877 ms. No hace falta virtualizar: ~4 500
  nodos se pintan en ~0,1 s. Paquete principal: 875 kB
  (antes 860 kB); oficina 55 kB y asistente 20 kB en trozos aparte.

## 9. Git y activación

- Commits en `mejora/sistema-operativo-agentes` (no publicada). `main` y el Portal en marcha siguen en `6eb119f`.
- **Datos**: migración solo aditiva (tablas `agent_folders`, `agent_revisions`, `agent_events`, `agent_messages`,
  `departments`; columna `lessons.agent_id`) con copia de seguridad previa automática (`DATA_SCHEMA_VERSION` 0.17). No se
  crean carpetas ni se tocan filas al arrancar.
- **Lote 568c60cb**: sus agentes siguen en Claude Code; nada de esta rama cambia su política ni su autorización. Integrar
  esta rama antes de decidir el lote es posible, pero sus candidatos se pondrán al día con un `main` más grande (posibles
  conflictos en `App.tsx` y servicios tocados): recomendado decidir el lote primero o aceptar ese coste.
- Pasos (cuando lo autorices): verificar el árbol exacto, `git merge --ff-only`, publicar, «Reconstruir y reiniciar».

## 10. Limitaciones (honestas)

- **Codex no ejecuta trabajo real en este equipo**: bloqueado por la comprobación de herramientas (§3 de `docs/arneses.md`).
  Su ejecución real nunca se ha probado; requiere una versión que lo permita y tu autorización para 1 llamada de prueba.
- Codex aún no ejecuta **historias ni lotes** (se detiene y lo dice).
- La identidad portable aún no llega a los prompts del pipeline de historias (a propósito, para no cambiar los lotes).
- Proactividad (seguimientos programados, informes automáticos): diseñada, **no activada**.
- La revisión de diffs de carpeta es por líneas (no un diff completo); la exportación es carpeta o `.json` (sin zip).
- El vídeo de referencia no se pudo analizar y la captura no llegó.

## 11. Próximos pasos (priorizados)

1. Decidir el lote 568c60cb; después autorizar la integración y activación de esta rama.
2. Una prueba controlada de Codex (1 llamada) cuando la comprobación de herramientas lo permita; si no, ejecutar Codex dentro
   del sandbox Docker (solo el worktree montado) para obtener el aislamiento que su CLI no ofrece hoy.
3. Identidad portable en los prompts del pipeline de historias (con fijación por lote).
4. Codex para historias (origen propio autorizable en lotes).
5. Proactividad con calendario, topes y aprobación.
6. Conocimiento por departamento y aprobación de conocimiento (hoy solo «añadir»).
