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

## Lista de comprobación antes de entregar una pantalla

1. No hay `style={{` nuevos salvo para valores que se calculan en tiempo de ejecución; los colores y espacios salen de tokens.
2. Cada fila de chips usa `.chip-row` con su modificador y no hay envolturas alrededor de los chips.
3. Lo que va en columna está centrado, y lo que va en tabla, cabecera o formulario está alineado al inicio.
4. Con 1, 2 y 3 chips, y con la ventana estrecha, siguen alineados entre sí al pasar de línea.
5. En 375 px nada se desborda y las tablas se ven como tarjetas con su `data-label`.
6. Los estados se comunican con icono y texto, nunca solo con color, y el foco se ve.
7. El caso vacío o sin datos (p. ej. «Sin ámbito») también está alineado.

## Pendiente (otras historias)

- Quedan `style={{…}}` anteriores a este estándar, por ejemplo en `ContextScopeFields` y en el asistente de importación de `AgentWizard.tsx`, en `DraftNote` y `Empty` de `ui.tsx` y en diálogos de `Office.tsx`. Se migrarán a clases en una historia aparte, sin cambiar lo que hacen.
- Una comprobación visual automática (capturas a varios anchos) queda como mejora futura. Hasta entonces, la sustituye la lista de comprobación.
