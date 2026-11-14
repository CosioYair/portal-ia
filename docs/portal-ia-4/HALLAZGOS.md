# Portal IA 4.0 · libro de hallazgos del Gauntlet

Cada hallazgo de una revisión independiente (revisores sin el contexto de quien implementó): gravedad, componente,
estado y cómo se verificó. Estados: `corregido` (con prueba) · `parcial` · `abierto` · `aceptado` (se deja, con
motivo) · `del propietario` (decisión suya).

## Ronda 1 · Seguridad (Estudio y corrección de EN-029)

Sin hallazgos críticos ni altos. El revisor comprobó como seguro: ningún texto del usuario llega a la orden ni al
grafo de FFmpeg; el contenedor solo ve `/in` (lectura) y `/out`, sin red ni privilegios; rangos HTTP correctos; sin
recorrido de rutas; sin XSS almacenado; los enlaces duros entre copias no comparten borrados ni ediciones.

| Id | Gravedad | Hallazgo | Estado | Corrección y verificación |
|---|---|---|---|---|
| S-M1 | media | Tras un reinicio, exportaciones «en marcha» para siempre; contenedores y temporales huérfanos | corregido | `recoverStudioAtStartup` en el arranque: marca las exportaciones como no terminadas, quita contenedores por etiqueta y carpetas temporales; tope de tiempo también dentro del contenedor |
| S-M2 | media | Una exportación atascada bloquea la cola hasta 30–60 h | corregido | Máximo 8× la duración (16× en alta), tope de 2 h, y corte si no avanza en 3 minutos |
| S-M3 | media | `drawtext` interpreta `%{…}` del texto: «50% de descuento» rompe la exportación | corregido | `expansion=none`; prueba «S-M3» en `p4-estudio.test.ts` |
| S-L1 | baja | Un color que no es texto pasa la validación y rompe la exportación | corregido | Solo cadenas `#RRGGBB`; prueba «S-L1» |
| S-L2 | baja | Un fallo al preparar la carpeta de trabajo deja la exportación en cola | corregido | La preparación va dentro del `try` |
| S-L3 | baja | Cancelar durante la comprobación final se ignora | corregido | Se vuelve a comprobar la cancelación antes de publicar el archivo |
| S-L4 | baja | Se puede borrar un medio con una exportación pendiente | corregido | 409 mientras haya exportación en cola o en marcha |
| S-L5 | baja | El disco no se recupera | corregido | Se conservan las 10 últimas exportaciones por proyecto; «liberar espacio» borra la papelera con confirmación |
| S-L6 | baja | Un medio cuyo archivo falta responde 500 con la ruta | corregido | 410 genérico |
| S-L7 | baja | `GET …/status?fresh=1` lanza procesos sin sesión; sin `Cross-Origin-Resource-Policy` | corregido | Volver a comprobar es un `POST` (exige sesión); los archivos llevan `same-origin` |
| S-L8 | baja | `restore-delivered` sin transacción única | corregido | `makeCurrentDelivered` (una transacción); además la corrección es automática. `requirePolicy` no se añadió: no hay una operación de política que corresponda y la ruta ya exige sesión y autorización explícita (aceptado) |
| S-L9 | baja | `matches` demasiado laxo; expresión regular de un agente sin límites | corregido | La tolerancia solo aplica a texto evidente; expresión ≤ 500 caracteres y cuerpo ≤ 200 000; prueba en `p4-entrega-integrada.test.ts` |
| S-L10 | baja | Imagen de medios sin versiones fijadas; sin `--memory-swap` | parcial | `--memory-swap` añadido. Fijar por resumen (`digest`) la imagen base queda pendiente |

## Ronda 1 · Estudio: función y experiencia

| Id | Gravedad | Hallazgo | Estado | Corrección |
|---|---|---|---|---|
| U-1 | bloqueante | Escribir en «Empieza en» o «Duración» reordenaba la línea de tiempo en cada tecla | corregido | Campos con borrador: solo cambian al salir o con Intro; vacío se ignora |
| U-2 | bloqueante | Un paso de deshacer por tecla o por movimiento del deslizador | corregido | Los cambios seguidos del mismo campo cuentan como un paso |
| U-3 | bloqueante | El guardado automático podía quedarse en «sin guardar» | corregido | Al terminar un guardado se vuelve a programar si hubo cambios |
| U-4 | bloqueante | Los ajustes del servidor pisaban ediciones más nuevas | corregido | Solo se adoptan si no se editó entretanto |
| U-5 | bloqueante | En pantalla táctil, los fragmentos impedían desplazar | corregido | El primer toque selecciona; solo el fragmento seleccionado se arrastra |
| U-6 | mayor | Recortar creaba dos pasos de deshacer; arrastrar entre pistas se rompía | corregido | El arrastre se sigue en la ventana; un gesto, un paso; Esc cancela |
| U-7 | mayor | Fragmentos cortos imposibles de mover; recorte izquierdo pisaba al anterior | corregido | Asas solo si caben; el recorte se detiene en el vecino |
| U-8 | mayor | Con el teclado no se podía pasar un fragmento por delante de otro | corregido | «Poner antes del anterior» / «después del siguiente»; las flechas no pisan |
| U-9 | mayor | La vista previa no coincidía con la exportación (texto de varias líneas, contorno) | corregido | Misma alineación y contorno; lo que no coincide (volumen > 100 %, fuente) se dice |
| U-10 | mayor | Un `<video>` por fragmento precargando entero | parcial | Solo se precarga lo cercano a la cabeza de reproducción. Compartir elementos por medio queda pendiente |
| U-11 | mayor | Exportar: errores de consulta silenciados; mensaje equivocado en conflicto; sin indicador fuera de la ventana | corregido | Aviso si el Portal deja de responder; mensajes por estado; avance en el botón «Exportar» |
| U-12 | mayor | Soltar un archivo fuera de la zona sacaba al navegador de la página | corregido | Se sube desde cualquier parte del editor |
| U-13 | mayor | Límite de pistas: se perdían en silencio | corregido | Se impide añadir y el servidor lo dice |
| U-14 | mayor | Atajo «S» global | corregido | Solo con un fragmento enfocado |
| U-15 | mayor | Faltaba: renombrar desde la lista, reordenar pistas, fundido cruzado, versiones con nombre | corregido | Añadidos |
| U-16 | menor | Redacción («Aparece en», jerga), estados que parecían acciones, pestañas sin `aria-controls` | corregido | Redacción llana; `aria-pressed` con etiqueta fija; pestañas con teclado |
| U-17 | menor | Recorte y tamaño solo con campos; texto con tres posiciones; sin miniatura de audio | abierto | No se abordó en esta ronda |

Verificación: recorrido en navegador real, 41 comprobaciones a 1440, 1024, 768, 390 y 320 px.

## Ronda 1 · Requisitos (diseño 4.0)

| Id | Gravedad | Hallazgo | Estado | Respuesta |
|---|---|---|---|---|
| R-1 | mayor | El diseño daba por decididos paleta, nombre y modo de reinicio | corregido | `DISENO.md` §7: decisiones del propietario |
| R-2 | mayor | Dos listas de «Te necesitan» | corregido | Una sola (Trabajo); Inicio enseña las primeras y enlaza |
| R-3 | mayor | Un trabajo ya integrado no debe mostrarse «Detenido» | corregido | `deliveredReconcile.ts`: automático al arrancar y al terminar un proceso; también desde los hechos de git. Pruebas `p4-entrega-integrada` y `p4-conciliacion-git` |
| R-4 | mayor | Un lote en pausa bloquea crear otro | corregido | `canLaunchWork` / `blocksNewBatch`; pruebas con el caso real |
| R-5 | mayor | «Aprendizaje verificado» no era comprobable | corregido | Una lección solo es «Aprendida» si una tarea posterior que tocó el mismo archivo (o su prueba) terminó bien sin repetir el error. `p4-aprendizaje-verificado.test.ts`. No hace una repetición «con y sin la lección»: mide exposición real |
| R-6 | mayor | Herramientas del anfitrión que los agentes no pueden lanzar | parcial | La evidencia visual la produce el Portal antes de QA. Aprovisionar herramientas que falten sigue pendiente |
| R-7 | media | «Estudio» chocaba con el subtítulo de marca | corregido | Subtítulo «Tu equipo de IA» |
| R-8 | media | Faltaban en el documento Estudio, REA y conciliación | corregido | `estudio.md`, `especialista-rea.md`, punto de control |
| R-9 | media | El Asistente «que lo arregle él»: qué puede cambiar directamente | abierto | No abordado |
| R-10 | media | Lista cerrada de decisiones que solo son del propietario | corregido | `DISENO.md` §3 |
| R-11 | media | Historias y encargos siguen siendo dos entidades; nueve etapas | abierto | Reconocido en `DISENO.md` §2 |

## Ronda 2 · Regresión y arquitectura

Sin bloqueantes. Comprobado como correcto por el revisor: `makeCurrentDelivered` es transaccional y no entra en bucle;
la precedencia de «integrado» sobre un flujo en pausa; el registro de rutas y las exportaciones del dominio; todas las
pantallas anteriores siguen alcanzables.

| Id | Gravedad | Hallazgo | Estado | Corrección y verificación |
|---|---|---|---|---|
| G2-1 | mayor | La vuelta automática a la entrega integrada podía pasar por encima de un cambio pedido de verdad por el propietario; no respetaba una conversión a análisis ni una recuperación manual | corregido | `autoRestorable`: solo iteraciones abiertas por un aviso del Portal, nunca con nota suya ni convertidas en análisis, y una sola vez (marca `deliveredRestore`). Cuatro pruebas en `p4-entrega-integrada.test.ts` |
| G2-2 | mayor | En historias, la tarjeta del backlog quedaba «pendiente» (podía volver a ejecutarse) | corregido | Vuelve a «en revisión» con la entrega integrada como último proceso; prueba |
| G2-3 | mayor | Los elementos de un lote seguían apuntando al proceso superado | corregido | La vuelta automática no toca historias de un lote en seguimiento: las lleva el coordinador del lote |
| G2-4 | mayor | Al desbloquear dependientes, un segundo lote podía ponerse a trabajar a la vez | corregido | Si otro lote del proyecto está activo, espera con su cola |
| G2-5 | mayor | La limpieza al arrancar no distinguía instancias: unas pruebas podían borrar contenedores y carpetas del Portal en marcha | corregido | Etiqueta y prefijo por instancia (huella de la carpeta de datos) en Estudio y análisis |
| G2-6 | mayor | Registrar una integración ya existente dependía de una comprobación previa | corregido | `mergeStory(…, { registerOnly: true })` falla si el commit no está en main; prueba |
| G2-7 | menor | «Atrás» desde Inicio, Estudio y Ediciones | corregido | `nav.ts` |
| G2-8 | menor | La vista de lotes calculaba el bloqueo con la regla antigua | corregido | Usa `blocksNewBatch` |
| G2-9 | menor | «Misma carpeta» era demasiado amplio para dar una lección por demostrada | corregido | Mismo archivo o su prueba/implementación; una tarea no expuesta no limpia la racha de reincidencias. Efecto al actualizar: las lecciones que figuraban «Aprendida» pasan a «pendiente de demostrar» hasta que una tarea las ponga a prueba |
| G2-10 | menor | E/S síncrona en `GET /studio/status`; descompresión síncrona en la subida | parcial | El tamaño de la papelera se calcula como mucho una vez por minuto. La descompresión sigue siendo síncrona (acotada a 600 MB) |
| G2-11 | menor | Informes de análisis sin poda ni índice | corregido | Se conservan 200; índice por fecha |
| G2-12 | menor | El enganche de fin de proceso no tenía prueba | corregido | `installDeliveredReconcile` y su prueba |

## Ronda 2 · Recorrido de usuario (evaluador sin contexto, no técnico)

**Veredicto del evaluador: es el producto anterior con una portada nueva, un menú recortado y dos módulos añadidos; no
es todavía un rediseño.** Se acepta el veredicto. Lo que se corrigió y lo que sigue abierto:

| Id | Hallazgo | Estado | Nota |
|---|---|---|---|
| J-1 | Dos pantallas distintas para lo mismo (historia y encargo); «proceso» e «iteración» a la vista | abierto | El mayor pendiente de la interfaz |
| J-2 | Trabajo con pestañas Backlog / Lotes / Actividad / Archivo | parcial | En Trabajo ya no van al frente (plegadas en «Otras vistas del trabajo»); las pantallas existen |
| J-3 | Unos veinte términos técnicos en pausas, errores y el Asistente | abierto | |
| J-4 | Tres recuentos distintos (Inicio, Trabajo, campana) | abierto | Miden cosas distintas: trabajos frente a decisiones |
| J-5 | El análisis no se encontraba desde el menú | corregido | «Analizar un programa» en Inicio y en Agentes |
| J-6 | Informe de análisis con jerga, inglés y salida cruda | corregido | Texto llano en español; el detalle técnico, plegado |
| J-7 | Sin acciones visibles de «Habilidades», «Exportar» y «Traer de vuelta» en el agente | abierto | |
| J-8 | El recorrido de aceptación describía el menú anterior | corregido | Recorrido 4.0, con nueve pasos nuevos |
| J-9 | «Oficina» junto a «Agentes» | corregido | En textos a la vista; las direcciones conservan `/oficina` |
| J-10 | Inicio no explicaba qué es el Portal | corregido | Una frase cuando no hay nada pendiente |
| J-11 | Conocimiento abre en Documentos; lo aprendido está en otra pestaña y en la memoria de cada agente | abierto | |
| J-12 | Estudio: «proyecto» chocaba con el selector de Proyecto; ningún agente participa | parcial | Ahora «vídeo». Los agentes creativos existen como perfiles, pero no actúan dentro del editor |
