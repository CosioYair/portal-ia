# Estándar de estilos de la interfaz

Reglas para que las pantallas del Portal queden alineadas, se adapten al ancho de la ventana y no repitan estilos. Valen para todo `apps/web` y se aplicaron por primera vez en EN-014 (chips del ámbito en la Oficina).

## Clases del sistema y tokens, no estilos en línea

- Antes de escribir `style={{…}}`, busca una clase en `system.css`. Si un mismo estilo aparece dos veces, conviértelo en una clase.
- `system.css` contiene lo que se usa en varias pantallas: `.chip`, `.chip-row`, `.card`, `.btn`, `.tbl-cards`… `office.css` solo se carga con la Oficina, así que allí va únicamente lo propio de la Oficina (`.desk`, `.desk-body`, `.office-list`).
- Los valores salen de `tokens.css`: espacios (`--space-1` = 4px…), colores (`--color-…`), radios (`--radius-…`) y duraciones. Escribe `var(--space-1)` sin valor de respaldo: `design-tokens-migration.test.ts` no admite `var(--x, …)`.
- Si falta un token, no lo inventes en la pantalla: propónlo en una historia aparte.
- El estilo en línea solo se admite para valores que se calculan en tiempo de ejecución, como el tono `--dept-h` de cada sala.

## Alineación

- **Al inicio** (`flex-start`): tablas, cabeceras de página o de tarjeta, formularios y listas. El ojo lee de izquierda a derecha, y todo lo que comparte una columna empieza en el mismo borde.
- **Centrado**: puestos de la planta, tarjetas en columna y estados vacíos, es decir, cuando el elemento ya tiene un eje central (figura, nombre y estado centrados).
- En vertical, lo que comparte una fila se alinea al centro (`align-items: center`). Las celdas de tabla llevan `vertical-align: middle`.
- Un contenedor flex que puede encoger lleva `min-width: 0`, para que los textos largos se recorten o pasen de línea en vez de desbordar.

## Filas de chips: `.chip-row`

- `.chip-row` es una fila de chips con `gap: var(--space-1)`, `flex-wrap: wrap`, `align-items: center` y `max-width: 100%`.
- Elige un modificador: `.chip-row-start` (por defecto en tablas, cabeceras y formularios) o `.chip-row-center` (ocupa todo el ancho y centra también las líneas que pasan abajo).
- Los chips van directamente dentro de la fila. La explicación emergente se pone con `<Chip title="…">`. Nunca envuelvas un chip en otro `<span title>`, porque añade altura de línea y descuadra la fila.
- Para el ámbito del agente usa `<ContextScopeChips scope={…} align="start" | "center" />`. Por ejemplo, en la planta de la Oficina va `align="center"` dentro de `.desk-body`, y en la lista, `align="start"`.

## Responsividad

- Comprueba cada pantalla a 1280, 1024, 768 y 375 px de ancho.
- En el móvil (≤ 767 px), las tablas con `.tbl-cards` pasan a tarjetas: cada `<td>` lleva `data-label="Columna"` y la etiqueta se muestra delante del valor. Dentro de esas tarjetas, una `.chip-row` sigue alineada al inicio y con `max-width: 100%`.
- Las rejillas usan `repeat(auto-fill, minmax(…, 1fr))` en vez de anchos fijos. Lo que no cabe pasa de línea (`flex-wrap: wrap`) en vez de provocar desplazamiento horizontal.
- Los textos largos (rutas, carpetas, nombres) usan `overflow-wrap: anywhere` o se recortan con puntos suspensivos y llevan `title`.

## Botones (HU-208)

- **Niveles:** hay tres. El primario (`.btn-primary`) es violeta relleno con sombra, y cada pantalla tiene uno solo. El secundario (`.btn-secondary`) va sobre `--color-surface`, con borde `--color-control-border` y texto `--color-text`. El terciario (`.btn-ghost`) es transparente, con borde `--color-tertiary-border` y texto `--color-text-med`; se usa para «Ahora no», «Descartar» y «Quitar». Al pasar el ratón por encima del terciario, el fondo cambia a `--color-surface-pressed` y el borde a `--color-border-hover-strong`.
- **Borde del terciario:** `--color-tertiary-border` tiene un contraste de 3:1 o más sobre `--color-surface`, `--color-bg`, `--color-surface-alt` y `--color-surface-pressed`. Lo comprueba `hu208-sistema-diseno.test.ts`. No uses `--color-control-border` para este borde, porque sobre `--color-bg` queda en el límite.
- **Partir línea:** `.btn` y `.btn-sm` llevan `max-width: 100%`, `white-space: normal`, `overflow-wrap: anywhere` y `min-height` (40 px y 32 px), nunca `height` fija. Un texto largo pasa a la línea siguiente en vez de desbordar, también en 375 px. No vuelvas a poner `white-space: nowrap` en un botón.

## Componentes de `kit.tsx`: `SettingsRow` e `InfoPanel` (HU-208)

- **`<SettingsRow label description? htmlFor?>{control}</SettingsRow>`:** muestra la etiqueta y una descripción opcional a la izquierda, y el control a la derecha. En pantallas estrechas el control pasa debajo. Si se pasa `htmlFor`, la etiqueta es un `<label>` enlazado al control. El componente no modifica el control que recibe. Para enlazar la descripción con `aria-describedby`, pasa una función como hijo: recibe el id de la descripción, por ejemplo `{(d) => <input aria-describedby={d} … />}`.
- **`<InfoPanel title? icon?>{cuerpo}</InfoPanel>`:** es un aviso informativo sobre `--color-info-bg` con borde `--color-info-border`. El título y el icono usan `--color-info-text`, con 4,5:1 o más. Lleva `role="note"` por defecto, así que no interrumpe al lector de pantalla. Usa `role="status"` solo si el contenido cambia mientras se está viendo. El icono es decorativo y el mensaje siempre va en texto.
- Los dos son solo de presentación: no importan el router ni la API. Sus estilos están en `system.css` (`.settings-row`, `.settings-row__text`, `__label`, `__desc`, `__control`, `.info-panel`, `__icon`, `__title`, `__body`) y usan únicamente tokens.

## Verificación visual obligatoria (HU-207)

- **Cuándo se exige:** cuando una historia toca `apps/web/src`. El Gauntlet pide la evidencia visual del commit aplicado antes de cualquier otra decisión. Se pide también en modo `off`, sin Evaluador y al reevaluar el mismo commit. Si falta la evidencia, si es de otro commit o si no cubre todas las rutas esperadas, la puerta bloquea.
- **Rutas a capturar:** se deducen de los archivos tocados con el mapa de UX `apps/web/visual-routes.json`, que relaciona cada patrón de archivo con sus rutas. Todas las rutas son **sin parámetros**. **Limitación actual:** la vista previa no tiene datos sembrados y el Gauntlet no pasa `--vars`, así que las pantallas de detalle (`/historias/:id`, `/procesos/:id`, `/lotes/:id`, `/oficina/agente/:id/configuracion`) no se capturan. Sus archivos se verifican en su lista: `/backlog`, `/actividad`, `/lotes` y `/oficina/organizacion`. Para capturar el detalle hará falta, en otra historia, sembrar los datos por API en la base de la vista previa (nunca en la base real) y pasar los ids reales con `--vars`. Hasta entonces, un `{marcador}` en el mapa haría fallar siempre la puerta («faltan datos sembrados»), y `hu207-verificacion-visual.test.ts` lo impide. Si se deduce un conjunto vacío, la puerta también bloquea. Una pantalla o un componente nuevo necesita su entrada en el mapa.
- **Qué hace el script:** este es el comando.

  `node scripts/visual-check.mjs --base-url <vista previa> --routes </r1,/r2> --out <dir> --commit <sha> [--vars k=v,...]`

  Por cada ruta guarda `<ruta>-375.png`, `<ruta>-768.png` y `<ruta>-1440.png`, todas de página completa, y escribe `report.json` con `{commit, routes, widths, results[], status}`.
  - Falla si `scrollWidth > clientWidth` en el documento o en el body.
  - Falla si axe da violaciones de impacto `serious` o `critical`. Las de impacto `moderate` o `minor` constan en el informe, pero no bloquean.
  - Falla si la ruta redirige a otra o si no aparece la pantalla (`.page`, `main` o `h1`).
  - Códigos de salida: 0 si todo está bien, 1 si falla, 2 si los argumentos no son válidos y 3 si falta una herramienta.
- **Se ejecuta en el host, no en el sandbox:** el sandbox no tiene navegador ni red. Por eso `typecheck`, `test` y `build` solo prueban la lógica, con un navegador falso (los casos «HU-207» de `hu207-verificacion-visual.test.ts`). La ejecución real la lanza el Portal sin IA, dentro de la autorización del proceso: arranca o reutiliza la vista previa del commit y ejecuta el script con un plazo. Ese plazo se ajusta con `PORTAL_VISUAL_TIMEOUT_MS`; al vencer, el script se detiene de verdad. También puedes repetirla con `POST /api/workspaces/:slug/processes/:id/visual-check`. Si no se puede completar, el proceso pausa con «evidencia visual pendiente en el host», que no es lo mismo que «falta en la imagen del sandbox». Al pulsar «Continuar», se repite.
- **Herramientas:** Playwright está en las devDependencies de la raíz. Chromium se instala con `npx playwright install chromium`, o se indica con `PORTAL_PLAYWRIGHT`. axe-core se carga solo si está instalado. Para habilitarlo, ejecuta `npm i -D axe-core` en la raíz y confirma el `package-lock.json` que genera npm. **El lockfile nunca se edita a mano.** La otra opción es apuntar `PORTAL_AXE` a `axe.min.js` o a su carpeta. Si falta Playwright, Chromium o axe, el resultado es `unavailable` y la puerta bloquea: nunca se da por bueno.
- **Evidencias:** quedan en `data/evidence/<proceso>/visual/<commit>/` (`report.json` y los PNG). Cada ejecución queda auditada en el historial de ejecución del proceso (`visual_check:<estado>:<commit>`). El Evaluador recibe un resumen con las rutas, los anchos, los desbordes, las violaciones graves y la ruta de cada captura. UX revisa las capturas antes de integrar.

## Lista de comprobación antes de entregar una pantalla

1. No hay `style={{` nuevos salvo para valores que se calculan en tiempo de ejecución; los colores y espacios salen de tokens.
2. Cada fila de chips usa `.chip-row` con su modificador y no hay envolturas alrededor de los chips.
3. Lo que va en columna está centrado, y lo que va en tabla, cabecera o formulario está alineado al inicio.
4. Con 1, 2 y 3 chips, y con la ventana estrecha, siguen alineados entre sí al pasar de línea.
5. En 375 px nada se desborda y las tablas se ven como tarjetas con su `data-label`.
6. Los estados se comunican con icono y texto, nunca solo con color, y el foco se ve.
7. El caso vacío o sin datos (p. ej. «Sin ámbito») también está alineado.
8. Los botones con texto largo parten línea dentro de su contenedor en 375 px, y en cada pantalla hay una sola acción primaria.
9. Las filas de ajuste usan `SettingsRow` y los avisos informativos usan `InfoPanel`, en lugar de estructuras hechas a mano.
10. La pantalla tocada tiene su entrada en `apps/web/visual-routes.json`, y la verificación visual del commit pasa a 375, 768 y 1440 px.

## Pendiente (otras historias)

- Quedan `style={{…}}` anteriores a este estándar, por ejemplo en `ContextScopeFields` y en el asistente de importación de `AgentWizard.tsx`, en `DraftNote` y `Empty` de `ui.tsx` y en diálogos de `Office.tsx`. Se migrarán a clases en una historia aparte, sin cambiar lo que hacen.
- La verificación visual automática ya existe (HU-207, ver arriba). La lista de comprobación sigue valiendo para lo que no se ve en una captura, como el foco o los estados.
