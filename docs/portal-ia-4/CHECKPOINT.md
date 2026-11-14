# Portal IA 4.0 · punto de control de ingeniería

Dónde va la reconstrucción y cuál es el siguiente paso exacto. Referencia el código, las pruebas y los demás
documentos de esta carpeta; no los repite. Informe para el propietario: `INFORME.md`.

- Límites que no cambian: no leer `data/` ni `.env`; no gastar IA de pago ni autorizar por el propietario; no aceptar
  ni cerrar trabajo en su nombre; activar el Portal solo con su sesión; `git push` sin forzar.
- Respaldo de todas las ramas antes de la consolidación (116 referencias, restauración comprobada):
  `C:\Mis Proyectos\Portal IA-respaldos\2026-11-14\` (fuera del repositorio).

## Etapas

| Etapa | Estado | Dónde |
|---|---|---|
| A · Descubrimiento | hecho | `descubrimiento/` (el inventario con las palabras del propietario queda fuera: el repositorio es público) |
| B · Diseño | hecho, revisado | `DISENO.md` |
| C · Autonomía | hecho lo que atascaba; ver pendientes | `p4-entrega-integrada`, `p4-conciliacion-git`, `p4-aprendizaje-verificado` (pruebas) |
| D · Interfaz 4.0 | **parcial** | Inicio, menú por objetivos, Trabajo sin pestañas al frente. Las pantallas de detalle son las anteriores |
| E · Estudio de vídeo | hecho | `estudio.md` |
| F · Especialista en ingeniería inversa | hecho | `especialista-rea.md` |
| G · Trabajo pendiente | hecho lo recuperable | EN-028 y HU-214 integrados (falta su aceptación). EN-001, HU-215 y HU-216 esperan al propietario |
| H · Gauntlet | 2 rondas, 5 revisores | `HALLAZGOS.md` |
| I · Consolidación | ver «Repositorio» | |
| J · Activación y aceptación | del propietario | «Actualizar» y «Tu prueba del Portal» |

## Lo que queda abierto (por orden de impacto)

1. **Una sola pantalla de trabajo** para historia y encargo, sin «proceso» ni «iteración» a la vista (J-1).
2. **Vocabulario técnico** fuera de la vista por defecto en pausas, errores y el Asistente (J-3), con una prueba
   automática de textos.
3. Acciones visibles de «Habilidades», «Exportar» y «Traer de vuelta» en la ficha del agente (J-7).
4. Conocimiento: abrir en lo aprendido e incluir la memoria de los agentes (J-11).
5. El Asistente que resuelve directamente lo pequeño (R-9).
6. Aprovisionar las herramientas del anfitrión que falten (R-6).
7. Estudio: recorte y tamaño sobre la imagen; compartir elementos de vídeo por medio (U-10, U-17); un agente que monte
   por ti a partir de instrucciones.
8. Partir `batchRunner.ts`, `storyPipeline.ts` y `routes/processes.ts` (deuda reconocida en `DISENO.md` §4).

## Repositorio

Se rellena al cerrar la consolidación (commit final de `main`, ramas remotas borradas y las que no se pudieron).

## Imágenes de Docker necesarias en la máquina (una vez; ya construidas en este equipo)

`docker build -t portal-ia-media:1 -f docker/media.Dockerfile docker`
`docker build -t portal-ia-rea:6.9.0 -f docker/rea.Dockerfile docker`
