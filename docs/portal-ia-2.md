# Portal IA 2.0 — arquitectura de la información, identidad visual y sistema de diseño

Documento de producto de la versión 2.0 de la interfaz. Primero el diagnóstico (auditoría del código y del Portal en
marcha), después la nueva organización, la identidad visual y el sistema de diseño, y al final la correspondencia exacta
entre la navegación anterior y la nueva.

## 1. Diagnóstico (fase A)

Auditoría del código (`apps/web/src`, 20 rutas, 20 pantallas, 35 componentes) y del Portal en marcha (capturas de cada
ruta a 1440, 834 y 390 px).

| # | Problema | Evidencia |
|---|---|---|
| 1 | **Dos sistemas de agentes.** Oficina y «Equipo de IA» listan los mismos agentes con dos vocabularios de estado (Trabajando/Te necesita… frente a Activo/Inactivo), dos asistentes de creación y dos pantallas de configuración. «Trabajando ahora» de Equipo no refleja actividad real. | `Team.tsx:33,52,66`, `AgentFigure.tsx:65`, `AgentPanel.tsx:308` |
| 2 | **El arnés se elige en cuatro sitios** (ficha avanzada, panel del agente, Claude Code en Proveedores, diálogo «Arneses» de la Oficina) y el asistente de lotes manda al sitio equivocado. | `AgentDetail.tsx:166`, `AgentPanel.tsx:310`, `ClaudeCodePanel.tsx:133`, `Office.tsx:228`, `Batches.tsx:198` |
| 3 | **Navegación acumulada**: 10 entradas, 2 muertas («próx.»), mismo icono para «Ejecución continua» y «Actividad», y faltan Decisiones, Etapa y Archivo. Los proveedores ocupan la parte baja del menú. | `Shell.tsx:15,86-103` |
| 4 | **Botones flotantes que tapan contenido** («Autorizaciones» abajo a la izquierda, «Asistente» abajo a la derecha) y una tira de agentes fija que corta los departamentos. En móvil tapan la pantalla. | capturas `antes-*` |
| 5 | **Autorizaciones fuera de la estructura**: sin menú ni asistente; solo «Volver al panel». | `InboxScreen.tsx:40,49` |
| 6 | **Saltos incoherentes**: la portada es la Oficina, pero cambiar de empresa o proyecto lleva al Panel; tres mecanismos de «atrás» en algunas pantallas. | `App.tsx:166`, `Shell.tsx:24,72,80` |
| 7 | **Interfaz falsa o muerta**: «Activar equipo» y «Activar agente» siempre desactivados; cifras fijas «0 / $0» en la ficha avanzada; «Proyecto interno» e «inactivos» escritos a mano. | `Team.tsx:66`, `AgentDetail.tsx:266-271`, `Dashboard.tsx:110,203` |
| 8 | **Muro de texto**: el Panel mide 3 500 px (descripciones largas, «Novedades integradas» completas). | captura `antes-escritorio-panel` |
| 9 | **Estilos sin sistema**: 310 colores escritos a mano en `styles.css`, 131 en componentes y 1 086 estilos en línea; `office.css` redefine `.seg` para toda la aplicación; `BudgetMeter` usa clases que no existen; tres formas distintas de hacer pestañas. | `styles.css`, `office.css:9`, `BudgetMeter.tsx:122,168`, `StoryWorkspace.tsx:221`, `Knowledge.tsx:53` |
| 10 | **Identidad plana**: beige y negro con un único acento verde azulado, iconos pequeños monocromos, tarjetas idénticas en todas las pantallas. | capturas |

Lo que **no** es duplicación (se conserva separado): Panel (entrega del proyecto) frente a Oficina (empresa y agentes);
Backlog, Ejecución continua, Actividad, Archivo y Etapa (trabajos distintos del mismo proyecto); Conocimiento (empresa)
frente a la Memoria de un agente; el Asistente de la empresa frente al chat con un agente (uno decide a quién le toca,
el otro es una conversación con un especialista).

## 2. Arquitectura de la información (fase B)

Principio: **tres preguntas del propietario** — *¿qué pasa en mi empresa?* (Oficina), *¿qué tengo que decidir?*
(Decisiones), *¿en qué va el proyecto?* (Proyecto) — más pedir, consultar y ajustar. Versión final, tras las tres
revisiones de diseño (producto, visual y seguridad/conservación):

```
[Empresa ▾]  [Proyecto ▾]          ← selector de contexto (siempre visible; «＋ Nueva…» en cada uno)

  Oficina            la empresa: Planta · Departamentos · Organización · Lista · crear/importar agentes · departamentos
  Decisiones   (3)   TODO lo que espera tu respuesta: autorizaciones de procesos, lo que piden los agentes, el Asistente
  Asistente          pedir en lenguaje natural; el Portal decide a qué agente o flujo le toca

PROYECTO             (solo con un proyecto elegido; sin proyecto: «Crear un proyecto»)
  Resumen            lo que te necesita, cifras, contexto, etapa, backlog, novedades, repositorio, equipo
  Trabajo      (●)   Backlog · Lotes · Actividad · Archivo  (pestañas con ruta propia)
  Conocimiento       documentos y lecciones del proyecto

EMPRESA
  Ajustes            proveedores y Claude Code · motores de IA · presupuestos · Asistente · empresas y proyectos · sistema
```

- 7 entradas (antes 10 + 2 muertas + 4 de proveedores). Ninguna entrada muerta en el menú.
- **Barra superior**: «Atrás», migas *Empresa › Proyecto › Sección › Elemento*, búsqueda (**Ctrl+K**: secciones,
  vistas, agentes, historias y ajustes; solo navega), **«Pedir»** (abre el panel del Asistente en cualquier pantalla,
  con su número de propuestas) y la **campana** de Decisiones (un único número, de la misma fuente que el menú).
- **Sin botones flotantes** que tapen contenido: el Asistente y las Decisiones se abren desde la barra superior.
- **Tableta** (768–1099 px): menú en carril de iconos. **Móvil** (<768 px): menú en cajón con foco atrapado y Esc.
- **Cambiar de empresa o proyecto** lleva a la **raíz de la sección** en la que estabas (nunca a un detalle cuyos
  identificadores son de la empresa anterior) y crea una entrada de historial; si la sección necesita proyecto y no
  lo hay, a la Oficina. Las pantallas se montan de nuevo con la nueva selección.
- **Decisiones agrupa sin decidir por su cuenta**: las autorizaciones de procesos se aprueban o deniegan con la misma
  tarjeta de siempre (cifra, riesgo y confirmación); lo que piden los agentes y el Asistente son enlaces a donde se
  resuelve. La búsqueda, la campana y Ajustes solo navegan (lo fija `portal-ia-2-wiring.test.ts`).

### Panel del agente: cinco grupos

| Grupo | Contiene (pestañas anteriores) |
|---|---|
| Chat | Chat |
| Trabajo | Trabajo · Documentos (agentes externos) |
| Para revisar | Solicitudes · Mejoras (agentes externos) |
| Memoria | Memoria |
| Ajustes | Configuración · Archivos (Portal) / Origen (externos) · enlace a «Ajustes avanzados» (`/equipo/:id`) |

Cada nombre antiguo sigue siendo una ruta válida (`/oficina/agente/:id/documentos`, `…/mejoras`, `…/origen`, …):
abre su grupo con esa vista elegida. Por debajo de 1280 px el panel es modal (fondo, foco atrapado, Esc, foco de vuelta).

### Correspondencia exacta (navegación anterior → nueva)

| Antes | Ahora | Ruta |
|---|---|---|
| Oficina | Oficina › Planta | `/oficina` (igual) |
| (vista de la Oficina) Departamentos, Lista | Oficina › Departamentos, Oficina › Lista | `/oficina/departamentos`, `/oficina/lista` (rutas propias) |
| Equipo de IA | Oficina › Organización (organigrama, relaciones, evaluar la organización, Evaluador Gauntlet) | `/oficina/organizacion`; `/equipo` redirige conservando `?…` y `#…` |
| Equipo › Nuevo agente especializado | Oficina › «Nuevo agente ▾» (crear, importar carpeta portable, integrar agente externo) y Organización › «Formulario completo de agente» | `/oficina/nuevo-agente`, `/equipo/nuevo` (iguales) |
| Ficha del agente (`/equipo/:id`) | Panel del agente › Ajustes › «Ajustes avanzados» | `/equipo/:id` (igual) |
| Asistente | Asistente (menú) y «Pedir» (barra superior) | `/asistente` (igual) |
| Autorizaciones (botón flotante) | **Decisiones** (menú y campana) | `/autorizaciones` (igual); `/decisiones` redirige |
| Panel | Proyecto › Resumen | `/panel` (igual) |
| Etapas (`/etapa`) | Proyecto › Resumen (tarjeta de etapa) y acción «Nueva etapa» del Backlog | `/etapa` (igual) |
| Backlog | Proyecto › Trabajo › Backlog | `/backlog` (igual) |
| Ejecución continua | Proyecto › Trabajo › **Lotes** | `/lotes`, `/lotes/:id` (iguales) |
| Actividad | Proyecto › Trabajo › Actividad | `/actividad`, `/procesos/:id` (iguales) |
| (solo enlaces) Archivo | Proyecto › Trabajo › Archivo | `/archivo` (igual) |
| Conocimiento | Proyecto › Conocimiento | `/conocimiento` (igual) |
| Presupuestos | Ajustes › Presupuestos (y el consumo del pie del menú) | `/presupuestos` (igual) |
| Proveedores (bloque inferior) | Ajustes › Proveedores y Claude Code | `/configuracion/proveedor` (igual; dentro del marco una vez preparado el Portal) |
| Claude Code — Local | Ajustes › Proveedores y Claude Code | `/configuracion/proveedor#claude-code` (igual) |
| Arneses (diálogo de la Oficina) | «Motores de IA» en la Oficina y en Ajustes (mismo diálogo, misma autorización de Codex) | — |
| Herramientas y MCP (muerta) | — (las herramientas de cada agente siguen en su ficha avanzada) | — |
| Configuración (muerta) | **Ajustes** (pantalla real) | `/ajustes` (nueva) |

Todas las rutas anteriores siguen funcionando (enlaces directos, historial y `/empresa/:slug[/proyecto/:pid]/…`).

## 3. Identidad visual (fase C) — «Estudio de agentes»

Una empresa de agentes que trabaja de noche y de día: **estructura tranquila** (tinta índigo, superficies limpias) y
**vida en los agentes** (color solo donde hay estado real).

- **Marca**: índigo tinta en el menú lateral (`#1C1B3A`), **violeta** (`#6D28D9`) como acción principal, selección y
  foco, y el verde azulado pasa a significar *agente trabajando*. Isotipo nuevo: un «portal» (marco redondeado) con
  tres nodos.
- **Color semántico** (siempre con texto o forma, nunca solo color), con los seis estados reales del servidor:
  trabajando = verde azulado · en cola = azul · te necesita = ámbar · no puede trabajar = rojo · disponible = pizarra ·
  retirado = gris con borde discontinuo. «Te necesita» es además una **insignia independiente** con el número de
  peticiones: un agente puede estar trabajando y a la vez esperar algo de ti. El ámbar solo se usa para atención.
- **Departamentos**: cada sala toma su tono (`hue`) en OKLCH (fondo, cabecera, rótulo y muestra de color) con
  luminosidad fija, así todos los tonos tienen el mismo contraste.
- **Tipografía**: IBM Plex Sans; escala `--fs-*` (título 28, sección 18, tarjeta 15, cuerpo 14, pequeño 12, cifra 24);
  cifras en IBM Plex Mono.
- **Iconografía**: juego propio ampliado (trazo uniforme) y un «azulejo» por sección en el menú y en la cabecera.
- **Ilustraciones originales** (SVG en línea, solo con tokens): la oficina vista desde fuera para la bienvenida, y
  escenas para los estados vacíos (escritorio libre, bandeja vacía, estantería, tablero, engranajes, gráfica).
- **Movimiento**: solo cuando hay un estado real (un agente trabajando: tres pulsos y se detiene), transiciones de
  panel; todo se anula con «reducir movimiento». La Oficina no inventa actividad.
- **Tema**: claro. El oscuro se aplaza (ver limitaciones): con los tokens completos es un cambio de un solo archivo.

## 4. Sistema de diseño

- **Tokens** (`tokens.css`, único bloque `:root`): colores semánticos, superficies, texto, bordes, marca, menú lateral,
  estados de agente, fondos de oscurecimiento, espacios, tamaños de letra, radios, sombras y duraciones. `styles.css`,
  `system.css`, `office.css`, `batch-wizard.css` y las demás hojas solo los consumen (lo fijan
  `design-tokens-wiring` y `design-tokens-migration`), y cada par de texto/fondo alcanza AA (≥4,5:1; bordes de
  control ≥3:1), comprobado en las pruebas.
- **Primitivas** (`system.css`, `components/ui.tsx`, `components/kit.tsx`): marco (menú, barra superior, cajón),
  `PageHeader`, `SectionTabs`/`WorkTabs`, `Tile`, `Stat`, `EmptyState` (con ilustración), botones, campos, chips,
  avisos, segmentados, interruptores, `Modal`, `Disclosure`, `StatusIcon`, `Spinner`.
- **Registro único de secciones** (`lib/routes.ts`): de ahí salen el menú, las migas, la búsqueda, la pantalla madre
  del «Atrás» y adónde ir al cambiar de empresa o proyecto.
- **Patrones**: tarjetas con jerarquía (cabecera, cuerpo, pie), filas de lista, tablas que en móvil pasan a tarjetas,
  pestañas de sección, confirmaciones con lo que cuesta y lo que hace, avisos, progreso.
- **Carga**: la Oficina, Ajustes, la búsqueda y las pantallas de detalle (historia, proceso, lotes, conocimiento,
  etapas, archivo, ficha avanzada) se cargan aparte: el paquete inicial pasa de 874 kB a 571 kB (247 → 170 kB gzip).

## 5. Lo que se conserva sin cambios de semántica

Aislamiento por empresa, permisos de agentes, elección de arnés (en el panel, en la ficha avanzada y en Claude Code,
con las mismas confirmaciones), suscripción de Claude Code, creación e importación de agentes, identidades portables,
conversaciones y adjuntos, conversión de documentos y lotes, propuestas de mejora y su aprobación, aprendizaje,
conocimiento, backlog, ejecución continua, presupuestos, historial, git, reinicio y activación. Ninguna autorización
cambia: los mismos botones piden las mismas confirmaciones, y ninguna pantalla nueva decide nada.

Cambios de comportamiento deliberados (solo de presentación o de destino de un enlace):
- Las acciones del chat propuestas («Sí, hazlo») aparecen como petición del agente en la Oficina y en Decisiones.
- El enlace de una historia creada desde el chat («mejorar el Portal») abre esa historia en su proyecto
  (`/empresa/:slug/proyecto/:pid/historias/:id`) en vez del backlog del proyecto seleccionado.
- Los enlaces «Origen de…» de los lotes llevan al panel del agente (donde se cambia su motor), no a la ficha antigua.
- Se quitan cifras fijas que no medían nada (llamadas «0», costo «0 USD», «Última actividad: ninguna») y botones que
  nunca se habilitaban («Activar agente», «Activar equipo»), y la franja «Trabajando ahora» de Equipo, que tomaba el
  campo «activo» de configuración por trabajo real: el estado mostrado es siempre el que calcula la Oficina.

## 6. GAUNTLET (fase F)

Seis revisiones independientes sobre la implementación (producto, visual, accesibilidad, mantenibilidad, conservación
de funciones y seguridad), cada una con el código y el Portal aislado en marcha (proveedores simulados, 0 USD).
Ninguna encontró cambios en la semántica de autorización: la búsqueda, la campana, Decisiones y Ajustes solo leen y
navegan; las aprobaciones siguen en su tarjeta de siempre.

Corregido tras la revisión (y comprobado de nuevo en el navegador):
- **Tableta**: no había forma de cambiar de empresa o proyecto; ahora el botón de menú abre el cajón completo.
- **Estilos en el trozo diferido de la Oficina** (pastillas de estado, diálogos, Motores de IA, contadores): pasan a
  `system.css`; el aspecto ya no depende de haber visitado la Oficina. Tipografía del Portal en todo lo que se monta en
  `<body>` (panel «Pedir», diálogos).
- **Cambio de empresa**: selección y destino en una sola transición (nunca se monta la ruta anterior con la empresa
  nueva); crear empresa o proyecto con botones aparte (recorrer la lista con el teclado ya no abre diálogos).
- **Cifras coherentes**: el Resumen cuenta lo mismo que la campana; las peticiones de agentes de toda la empresa; las
  propuestas del Asistente son globales y se publican también desde su pantalla completa.
- **Asistente**: Ajustes y «Configurar asistente» abren el Asistente real (el de la empresa interna) desde cualquier
  empresa; el panel «Pedir» se presenta como global.
- **Teclado y foco**: flechas entre puestos (fallaban); panel del agente modal por debajo de 1280 px y, en pantallas
  anchas, al lado de la Oficina apartando el contenido (no tapa nada enfocable; se cambia de puesto sin cerrarlo); igual
  el panel «Pedir» en escritorio; selectores de empresa y proyecto que con el teclado cambian al pulsar Intro; búsqueda con el foco dentro y cierre al navegar, Esc que no cierra dos cosas, título de pestaña por
  pantalla, foco al contenido al cambiar de pantalla, margen bajo la barra fija, nombres accesibles que faltaban.
- **Color**: lo que está en marcha es verde azulado (antes ámbar en chips, pasos y la línea de tiempo, con pulso
  infinito); Decisiones solo en ámbar si hay algo pendiente; títulos de sala en tinta neutra.
- **Oficina**: recuerda la vista (Lista por defecto en móvil), la mantiene debajo del panel, cifras solo donde filtran,
  sin proyecto no ofrece crear agentes que no se pueden crear.
- **Reflujo**: sin desplazamiento horizontal a 320–390 px (rutas largas, filtros, presupuestos), tablas a tarjetas.
- **Textos**: «Motor de IA» en panel, ficha avanzada y avisos del servidor; «Resumen» en lugar de «panel» para el
  proyecto; estados vacíos ilustrados en Conocimiento, Lotes, Actividad y Archivo.

Segunda ronda: las seis revisiones volvieron a comprobar sus hallazgos sobre la versión corregida; seguridad confirmó
de nuevo que la autorización no cambia, y lo que quedaba (selector con teclado, panel «Pedir», empresa en cada propuesta
del Asistente, migas en móvil, ámbar decorativo) se corrigió y se verificó en el navegador (62/62 comprobaciones).

Pendiente y aceptado (ver limitaciones del informe): tema oscuro; Gauntlet de organización fuera de Decisiones; la
barra «Pide algo a tu empresa» abre el Asistente a pantalla completa (como antes); la cifra de propuestas del Asistente
se conoce al abrir su conversación (no hay consulta de servidor para todas).
