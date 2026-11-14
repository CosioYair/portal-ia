# Estudio · edición de vídeo

## Qué hace hoy (comprobado)

| Capacidad | Dónde |
|---|---|
| Proyectos: crear, renombrar, duplicar, quitar (papelera) y liberar espacio | Estudio (lista) |
| Guardado automático con historial; versiones con nombre; volver a una versión sin perder las posteriores | Editor › Versiones |
| Deshacer y rehacer (un paso por gesto, no por tecla) | Editor |
| Biblioteca: subir arrastrando o eligiendo; vista previa; el tipo lo decide el contenido | Editor › Biblioteca |
| Línea de tiempo con varias pistas de vídeo/imagen, audio y texto; subir y bajar pistas | Editor |
| Mover, recortar por los bordes, partir, cambiar de pista, reordenar | Arrastrando, con el teclado o con los campos |
| Duración, velocidad (×0,25–×4), volumen, fundidos de entrada y salida, fundido cruzado | Ajustes del fragmento |
| Tamaño, posición y recorte de la imagen | Ajustes del fragmento |
| Títulos y subtítulos; importar y descargar `.srt` | Barra de la línea de tiempo |
| Formatos horizontal 16:9, vertical 9:16 y cuadrado 1:1 | Cabecera |
| Exportar MP4 (480p/720p/1080p; borrador, estándar, alta) con avance y cancelación | Exportar |
| Comprobación del archivo exportado (H.264 + AAC, tamaño, duración) y descarga | Exportar |

## Qué NO hace (dicho con claridad)

- **Generar vídeo con IA** (texto→vídeo, imagen→vídeo, transformar): hay contrato de adaptador
  (`studioProviders.ts`) pero ningún proveedor conectado. Son servicios de pago de terceros, no incluidos en la
  suscripción de Claude. Estados posibles: disponible y comprobado · conectado sin probar · necesita conexión ·
  necesita autorización de gasto · no disponible.
- **Subtítulos automáticos (voz a texto)** y **voz en off generada**: no construidos.
- El texto no salta de línea solo; por encima del 100 % de volumen solo se oye en el vídeo exportado; la vista previa
  usa la fuente del navegador (la exportación usa DejaVu Sans), así que el ancho del texto puede variar un poco.
- Recorte y tamaño se ajustan con campos, no sobre la imagen.

## Arquitectura

- `packages/domain/src/studio.ts`: el proyecto (datos planos, versionados), normalización de todo lo que llega del
  navegador, partir fragmentos, SRT. Lo comparten el editor y el servidor.
- `apps/server/src/services/studioPlan.ts`: **función pura** proyecto → orden de FFmpeg. Los archivos se nombran por
  posición; los textos van en archivos (`textfile=` con `expansion=none`). Ningún texto del usuario llega a la orden.
- `apps/server/src/services/studio.ts`: biblioteca (ffprobe), cola de exportación (una a la vez), comprobación del
  MP4, limpieza al arrancar.
- `docker/media.Dockerfile`: FFmpeg en contenedor. Cada ejecución: sin red, solo lectura, sin privilegios, 2 GB,
  2 CPU, tiempo máximo (8× la duración, tope de 2 h) y corte si deja de avanzar 3 minutos.
- El editor (`StudioEditor.tsx`) pinta la vista previa en un lienzo con la misma geometría que la exportación.

Construir la imagen una vez: `docker build -t portal-ia-media:1 -f docker/media.Dockerfile docker`.
FFmpeg se usa como programa aparte (no se enlaza ni se redistribuye con el Portal).

## Agentes creativos

Perfiles «Director Creativo de Vídeo» y «Editor y Revisor de Vídeo» en el catálogo de agentes: concepto, guion por
escenas, formatos por red, instrucciones de montaje, subtítulos y control de calidad. Usan el mismo motor de agentes.

## Evidencia

- `apps/server/test/p4-estudio.test.ts`: recorrido real por la API con medios de verdad (crear, importar, montar,
  recortar, partir, texto, audio, guardar, reabrir, exportar, comprobar, cancelar, duplicar).
- Recorrido en navegador real (41 comprobaciones), a 1440, 1024, 768, 390 y 320 px.
