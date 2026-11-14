# Portal IA 4.0 · informe para el propietario

Qué pediste, qué se entrega, qué se comprobó y qué falta. Lo que pone «comprobado» se ejecutó de verdad; lo que no,
lo dice.

## En una frase

Portal IA 4.0 entrega dos módulos nuevos que funcionan (Estudio de vídeo y análisis de programas), un motor que ya no
se atasca en los tres puntos donde te atascaba, una portada y un menú nuevos, y tus dos trabajos pendientes
recuperados. **No entrega todavía la interfaz completamente reinventada que pediste**: las pantallas de detalle del
trabajo siguen siendo las anteriores.

## Lo que pediste frente a lo que hay

| Pediste | Se entrega | Comprobado |
|---|---|---|
| Que el trabajo no se atasque («no logro salir de mi último encargo») | Un trabajo ya integrado no se convierte en «análisis» ni figura como detenido; su estado se corrige solo. La evidencia visual la produce el Portal antes de la revisión | 19 pruebas con los textos reales de tu encargo de la paleta |
| Que un lote parado no impida crear otro | Solo bloquea el lote que puede avanzar por sí mismo | Pruebas con el caso real |
| Que los agentes aprendan de verdad | Una lección solo dice «Aprendida» si una tarea posterior que tocó el mismo archivo terminó bien sin repetir el error | 5 pruebas. Al actualizar, las que figuraban «Aprendida» pasan a «pendiente de demostrar» hasta que una tarea las ponga a prueba |
| Una interfaz intuitiva, sin pantallas repetidas | Inicio y un menú de seis destinos; Trabajo sin pestañas al frente; «Agentes» en lugar de «Oficina» | Recorrido en navegador. **Parcial**: ver «Lo que falta» |
| Estudio de vídeo | Editor con biblioteca, varias pistas, recortar, partir, texto, subtítulos, audio, fundidos, tres formatos y exportación a MP4 comprobada | 41 comprobaciones en navegador real a cinco anchos; exportación real verificada |
| Especialista en ingeniería inversa y seguridad | Perfil de agente con cinco habilidades y «Analizar un programa», con su herramienta aislada | Encontró dos defectos sembrados a propósito y confirmó la corrección; 14 comprobaciones en navegador |
| Recuperar Ediciones y la regla de modelo sin repetir correcciones | Integrados a partir de sus candidatos verificados | Sus pruebas pasan. Falta tu aceptación |
| Una sola rama en GitHub | Ver «Repositorio» | |

## Qué se conservó, qué se sustituyó y qué se quitó

- **Conservado**: todos tus datos, agentes, documentos, conversaciones e historial; el motor de historias y encargos;
  exportar y traer de vuelta agentes; el recorrido de prueba con las marcas que ya pusiste en los pasos que no cambian.
- **Sustituido**: la portada (ahora Inicio); el menú; la regla de bloqueo de lotes; cómo se mide una lección; cómo se
  interpreta una comprobación automática que falla después de integrar.
- **Quitado de la vista** (siguen existiendo en su dirección y en la búsqueda): Asistente, Decisiones, Resumen y el
  recorrido de prueba como elementos del menú; las pestañas Backlog, Lotes, Actividad y Archivo al frente de Trabajo.
- **Nuevo**: Estudio, Analizar un programa, tres perfiles de agente (seguridad, director de vídeo, editor de vídeo).

## Los cuatro vídeos que enviaste

Se inspeccionaron los cuatro, por fotogramas y descripción: no tienen transcripción y el audio no se pudo escuchar.
Ninguno demuestra nada en pantalla. Se adoptó: eliminar antes de automatizar (menos destinos); tratar como no fiable
lo que escribe un agente o devuelve una herramienta; trabajo pesado en segundo plano con avance real. Del vídeo de
anuncios no se adoptó nada: es una promesa comercial sin demostración.

## Seguridad

Dos revisiones independientes. Sin hallazgos críticos ni altos. Seis hallazgos medios y mayores, todos corregidos
(detalle en `HALLAZGOS.md`). Lo esencial: las herramientas externas (FFmpeg y REA) corren en contenedores propios, sin
red y sin acceso a nada tuyo; ningún texto que escribas llega a una orden; un archivo subido se identifica por su
contenido, no por su nombre; todo cambio exige tu sesión.

## Rendimiento

La exportación de vídeo no bloquea el Portal: corre aparte, de una en una, con 2 GB y 2 CPU como máximo y tiempo
límite. Un vídeo de 11 segundos a 480p se exportó en unos segundos en esta máquina. No se midió con proyectos largos.

## Lo que falta (dicho sin rodeos)

1. **La interfaz no es todavía un rediseño completo.** Un evaluador independiente, sin contexto, concluyó que es «el
   producto anterior con una portada nueva y dos módulos añadidos». Siguen igual: la pantalla de detalle de una
   historia y la de un encargo (son dos distintas), las pantallas de Backlog, Lotes y Actividad, y el vocabulario
   técnico en pausas y errores (rama, sandbox, Gauntlet, iteración…).
2. **Generar vídeo con IA** no está conectado a ningún proveedor: son servicios de pago que no incluye tu suscripción.
   Tampoco hay subtítulos automáticos ni voz generada.
3. **El Asistente «que lo arregle él»** sin crear un encargo: no abordado.
4. **Prueba de agente exportado funcionando fuera y volviendo**: no se repitió en esta etapa (pasó en la anterior).
5. **Trabajos que esperan tu decisión**: el encargo antiguo que quedó «No terminó» y cuyo problema ya se arregló por
   otra vía; la bienvenida en seis pasos; el cambio de nombre visible, que necesita que decidas el nombre.

## Decisiones que son tuyas

Aceptar o no cada trabajo integrado; la paleta (está en marcha la índigo, sin aceptar); el nombre del producto; si el
Portal se reinicia solo o lo reinicias tú; conectar o no un proveedor de vídeo con IA.

## Qué hacer ahora

1. En el Portal, pulsa «Actualizar» (reconstruye y reinicia con tu sesión).
2. Abre Inicio › «Tu prueba del Portal» y recorre los pasos. Los que ya marcaste y no cambiaron conservan tu marca.
3. Marca lo que falle con tu comentario: es la lista de lo siguiente.
