# Portal IA 4.0 · punto de control de ingeniería

Este archivo dice **dónde va la reconstrucción y cuál es el siguiente paso exacto**. No repite lo que ya dicen el código,
las pruebas o los registros del Portal: los referencia. Se actualiza al cerrar cada etapa.

- Rama de trabajo: `portal-ia-4` (sale de `main` en `d189bb6`).
- Mandato del propietario: 2026-11-14 («Portal IA 4.0 — complete product reinvention…»).
- Límites que no cambian: no leer `data/` ni `.env`; no gastar IA de pago ni autorizar por el propietario; no aceptar ni
  cerrar trabajo en su nombre; activar el Portal solo con su sesión; `git push` sin forzar; ninguna prueba ni servidor
  desde la carpeta principal.

## Etapas

| Etapa | Estado | Evidencia |
|---|---|---|
| A · Descubrimiento (historial, vídeos, Higgsfield, REA, inventario) | en curso | `docs/portal-ia-4/descubrimiento/` (al cerrarla) |
| B · Arquitectura y diseño de producto | pendiente | — |
| C · Autonomía (ejecución, correcciones, evidencia, cierre) | en curso | ver «C1» |
| D · Interfaz 4.0 | pendiente | — |
| E · Estudio de vídeo | pendiente | — |
| F · Especialista REA | pendiente | — |
| G · Migración y conciliación del trabajo pendiente | pendiente | — |
| H · Gauntlet completo y validación en navegador | pendiente | — |
| I · Consolidación del repositorio | pendiente | — |
| J · Activación y aceptación | pendiente (del propietario) | — |

## C1 · EN-029 después de integrar (hecho en la rama, falta activarlo)

Causa confirmada con los registros del Portal en marcha (procesos `7a24ea71…`, `f7618b53…`, `afaf14d2…`):

1. EN-029 se integró (`d189bb6`) y se activó. La paleta nueva está en `main` y en marcha.
2. La comprobación en ejecución que escribió el equipo tenía la expectativa `/<div id="root"` (barra sin cerrar).
   `matches()` la buscó como texto literal, no la encontró y dio por rota `/oficina`.
3. El flujo trató ese fallo como «del código» y ofreció una iteración correctiva, que superó a la entrega integrada.
4. El Coordinador, con razón, no encontró nada que cambiar; el Portal ofreció «convertir en encargo de análisis».

Corrección (pruebas en `apps/server/test/p4-entrega-integrada.test.ts`):

- `runtimeChecks.ts`: una expectativa «/texto» sin cerrar es texto; una pantalla (no `/api/`) cuyo contenido no está en
  el armazón se comprueba con navegador, no por HTTP.
- `storyFlow.ts`: si el Portal responde y solo falla la comprobación del equipo, lo primero es repetirla (sin IA).
  Un «sin código» con una iteración anterior integrada ofrece «Volver a la entrega integrada y comprobarla (sin IA)».
- `routes/processes.ts`: `POST …/processes/:id/restore-delivered` (autorización explícita, reversible, no borra nada).

Lo que hará el propietario tras activar: en EN-029, «Volver a la entrega integrada y comprobarla (sin IA)» →
«Volver a comprobar (sin IA)» → su prueba paso a paso → aceptar.

## Siguiente paso exacto

Ver la sección «Siguiente» al final; se reescribe en cada sesión.

## Siguiente

1. Terminar la batería completa sobre C1 y confirmarlo.
2. Cerrar la etapa A con los cuatro informes de descubrimiento y copiar sus conclusiones a `descubrimiento/`.
3. Etapa B: mapa de navegación 4.0 y ciclo único de trabajo, con revisión Gauntlet de requisitos antes de implementar.
