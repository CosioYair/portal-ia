# Portal IA 4.0 · punto de control de ingeniería

Dónde va la reconstrucción y cuál es el siguiente paso exacto. Referencia el código, las pruebas y los demás
documentos de esta carpeta; no los repite.

- Rama de trabajo: `portal-ia-4` (sale de `main` en `d189bb6`). **No está en `main`, no está publicada, no está activa.**
- Última batería completa: 177/177 archivos, 1326 pruebas superadas, 0 fallidas (3 omitidas de siempre), sobre el
  commit «Integra candidato/hu-214-p3 en portal-ia-4».
- Respaldo de todas las ramas (116 referencias, verificado): `C:\Mis Proyectos\Portal IA-respaldos\2026-11-14\`.
- Límites que no cambian: no leer `data/` ni `.env`; no gastar IA de pago ni autorizar por el propietario; no aceptar
  ni cerrar trabajo en su nombre; activar el Portal solo con su sesión; `git push` sin forzar.

## Etapas

| Etapa | Estado | Dónde |
|---|---|---|
| A · Descubrimiento | hecho | `descubrimiento/` (el inventario con las palabras del propietario queda fuera del repositorio, que es público) |
| B · Diseño | hecho, revisado | `DISENO.md` |
| C · Autonomía | parcial | EN-029 tras integrar, estado desde git, lotes, aprendizaje verificado. Ver «Pendiente antes de integrar» |
| D · Interfaz 4.0 | **parcial** | Inicio y menú de seis destinos. Las pantallas de trabajo siguen siendo las anteriores |
| E · Estudio de vídeo | hecho | `estudio.md` |
| F · Especialista REA | hecho | `especialista-rea.md` |
| G · Trabajo pendiente | parcial | EN-028 y HU-214 integrados en la rama. EN-001, HU-215, HU-216 esperan al propietario |
| H · Gauntlet | 2 rondas | `HALLAZGOS.md` (falta anotar la ronda 2, resumida abajo) |
| I · Consolidación | sin empezar | Respaldo hecho. Las 41 ramas remotas ya están integradas en `main` |
| J · Activación y aceptación | del propietario | Recorrido 4.0 preparado, sin aplicar |

## Pendiente ANTES de integrar en `main` (ronda 2 del Gauntlet, sin corregir)

Regresión (ningún bloqueante, seis mayores):

1. `deliveredReconcile.ts`: la vuelta automática a la entrega integrada puede pasar por encima de un cambio que el
   propietario pidió de verdad. Limitarla a las iteraciones nacidas de un fallo de comprobación (no de una nota suya),
   saltar las que ya se convirtieron en análisis, dejar una marca para hacerlo una sola vez.
2. En historias no se actualiza la tarjeta del backlog (queda «pendiente» y podría volver a ejecutarse en un lote).
3. Los elementos de un lote siguen apuntando al proceso superado.
4. `batchRunner.ts` (~1389): al desbloquear dependientes, comprobar que no haya otro lote activo.
5. La limpieza al arrancar del Estudio y del laboratorio no distingue instancias: una segunda instancia (pruebas)
   borraría contenedores y carpetas de la que está en marcha. Etiquetar por instancia.
6. `reconcileIntegrated`: usar una vía «solo registrar» en `mergeStory` que falle si el commit no está en main.

Menores: «Atrás» desde Inicio/Estudio/Ediciones (`nav.ts`), `blocksNewBatch` de la vista de lotes, la exposición de
una lección por «misma carpeta» es demasiado amplia en carpetas planas, E/S síncrona en `GET /studio/status`,
`lab_reports` sin poda, el oyente de fin de proceso sin prueba propia.

Recorrido de usuario (veredicto: **no es todavía un rediseño completo**): dos pantallas distintas para historia y
encargo; Trabajo conserva las pestañas Backlog/Lotes/Actividad/Archivo; unos veinte términos técnicos en pausas y
errores; «Oficina» sigue apareciendo junto a «Agentes»; el análisis de artefactos no se encuentra desde el menú y
parte de su informe sale en inglés; el recorrido de aceptación aún describe el menú anterior.

## Siguiente paso exacto

1. Corregir los seis hallazgos mayores de regresión, cada uno con su prueba, y repetir la batería completa.
2. Aplicar el recorrido de aceptación 4.0 (preparado como parche; conserva las marcas de los pasos que no cambian).
3. Hallazgos de experiencia de mayor impacto: análisis de artefactos a dos clics y en español; Trabajo sin pestañas
   al frente; «Agentes» en todas partes.
4. Solo entonces: integrar `portal-ia-4` en `main`, publicar sin forzar y borrar las ramas remotas ya integradas.
5. El propietario activa con «Actualizar» y recorre «Tu prueba del Portal».

Imágenes de Docker que hay que tener construidas en la máquina (una vez):
`docker build -t portal-ia-media:1 -f docker/media.Dockerfile docker` y
`docker build -t portal-ia-rea:6.9.0 -f docker/rea.Dockerfile docker`. Ya están construidas en este equipo.
