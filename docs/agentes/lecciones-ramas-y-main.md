# Lecciones: ramas, main y ejecuciones desde el sitio equivocado (HU-129)

## Qué pasó

- El remoto tenía como rama por defecto `portal-ia/hu-119`, no `main`.
- El trabajo acumulado estaba repartido en seis ramas: `portal-ia/hu-119` (la rama por defecto), `portal-ia/hu-124`, `portal-ia/hu-126`, `portal-ia/hu-127`, `portal-ia/hu-128` y `portal-ia/001`.
- `main` no contenía el código actual del Portal, incluido el asistente flotante.
- Al reiniciar el Portal el propietario no veía los cambios de las historias completadas, porque corría desde una rama que no los incluía.
- HU-125 falló dos veces por exceso de tamaño: se intentó resolver demasiado en una sola tarea.
- HU-121 se solapaba con este problema y queda cubierta por HU-129.

## Por qué ocurrió

- Cada historia partía de la rama por defecto del remoto en lugar de partir de `main` actualizado.
- Las ramas de las historias no se integraban en `main` al terminar, así que el trabajo se apilaba rama sobre rama.
- Nada comprobaba, antes de ejecutar una historia, desde qué rama corría el Portal ni cuál era la rama por defecto del remoto.
- Las historias grandes se intentaban resolver de una vez, sin entregables pequeños y revisables por separado.

## La regla

1. **`main` es la única fuente de verdad.** Contiene siempre el código actual y completo del Portal.
2. **Cada historia parte de `main` actualizado** (`git switch main && git pull`) y se desarrolla en su propia rama.
3. **Toda integración llega a `main` mediante un PR aprobado por el propietario.** Nadie toca `main` sin esa aprobación.
4. **La rama por defecto del remoto debe ser `main`.** Cambiarla en GitHub requiere permisos de administrador del repositorio, así que lo hace el propietario.
5. **Las historias grandes se dividen en pasos pequeños y entregables por separado**, con una parada de aprobación entre ellos.

## Cómo se hace cumplir

Antes de ejecutar cualquier historia, el Portal hace una comprobación previa (preflight) que verifica tres cosas:

| Comprobación | Condición para pasar |
| --- | --- |
| `rama-actual` | El Portal corre desde `main`. |
| `main-actualizado` | `HEAD` coincide con `origin/main` tras `git fetch origin main`. |
| `rama-por-defecto-remoto` | `git ls-remote --symref origin HEAD` indica que la rama por defecto es `main`. |

- Se aplica la regla **denegar por defecto**: si un dato no se puede obtener (remoto inaccesible, HEAD desacoplado, timeout), la comprobación queda «indeterminada» y bloquea igual que un fallo.
- Si algo no pasa, la historia queda en estado `detenido` con el motivo en español. No se reserva presupuesto, no se llama a `complete()` y no se registra consumo.
- La rama por defecto se consulta con `ls-remote` en vivo y no con `origin/HEAD` local, que puede estar obsoleto.
- El código está en `packages/domain/src/runtime-location.ts` (`evaluateExecutionPreflight`), `apps/server/src/services/execution-preflight.ts` y el aviso `apps/web/src/components/AvisoPreflight.tsx`.

## Qué hacer si la ejecución se detiene

1. Lee el motivo y el detalle de cada comprobación en el aviso.
2. Si el Portal no corre desde `main`: `git switch main && git pull` y reinicia el Portal.
3. Si la rama por defecto del remoto no es `main`: en GitHub, **Settings → Branches → Default branch → main** (lo hace el propietario). Después, en local: `git fetch origin && git remote set-head origin -a`.
4. Si el remoto no está accesible, comprueba la red y las credenciales y reintenta.

Ver también [Cuándo recargar y cuándo reiniciar el Portal](../operacion/recarga-o-reinicio.md).
