# Cuándo recargar y cuándo reiniciar el Portal (HU-123)

Cuando el equipo de agentes aplica cambios al propio Portal, no siempre se ven al instante. Este documento explica qué hacer en cada caso. El Portal lo avisa solo: la barra superior muestra un aviso cuando hace falta actuar.

## Reglas

| Qué cambia | Acción | Motivo |
| --- | --- | --- |
| `apps/web/src/**`, `apps/web/public/**`, `apps/web/index.html` | **Recargar** la página | Es código del navegador. |
| `apps/server/src/**`, `packages/**` | **Reiniciar** el Portal | El servidor carga el código al arrancar; `packages/**` lo usan servidor y web. |
| `package.json`, `package-lock.json`, `tsconfig*`, `.env*` (en cualquier carpeta) | **Reiniciar** el Portal | Cambian dependencias o configuración, que se leen solo al arrancar. |
| Otros archivos de `apps/web/` (configuración de Vite, etc.) | **Reiniciar** el Portal | Se cargan al arrancar. |
| `docs/**` | **Nada** | Solo documentación. |
| Pruebas (`apps/**/test/**`, `*.test.*`) | **Nada** | No forman parte de lo que se ejecuta. |

Si un conjunto de cambios mezcla varias categorías, manda la acción **más fuerte**: reiniciar > recargar > nada. Esta tabla es exactamente la clasificación que implementa `classifyChangeImpact` en `packages/domain/src/portal-sync.ts`.

## Cómo funciona el aviso

- Al arrancar, el servidor guarda el commit (`HEAD`) del repositorio del Portal.
- El aviso compara ese commit con el `HEAD` actual: revisa los archivos cambiados y los mensajes de commit posteriores al arranque.
- Las historias afectadas son las que aparecen como `HU-NNN` en esos mensajes. **Incluye siempre el identificador de la historia en el mensaje de commit** para que figure en el aviso.
- Si hay que reiniciar, se muestra «Reinicia el Portal para ver: HU-…». Si basta recargar, aparece un botón «Recargar».
- El aviso desaparece al reiniciar, porque el nuevo arranque toma como base el `HEAD` actual.

## Cómo leer el indicador de sincronización

- **Rama**: la rama activa. «HEAD suelto» significa que no hay rama activa (es un estado normal, no un error).
- **Coincide con main** (✅): la rama activa apunta al mismo commit que `main`. Si no, indica cuántos commits va por delante y por detrás.
- **Publicado en GitHub** (☁️): `main` está contenida en `origin/main`.
- **Pendiente de publicar** (⏳): hay commits en `main` que `origin/main` aún no tiene.
- **main y origin/main han divergido** (⚠️): cada una tiene commits que la otra no; requiere resolución manual.
- **Sin remoto** (🚫): no existe la referencia `origin/main` en el repositorio local.

El indicador se actualiza al enfocar la ventana y cada 30 segundos. Consultarlo no tiene coste.

## Limitación: el remoto es la última referencia conocida

El indicador **no ejecuta `git fetch` ni usa la red**. El estado del remoto se calcula con la referencia local `origin/main`, que puede estar desactualizada si alguien publicó desde otra máquina. Un `fetch` explícito requeriría autorización y queda fuera de este alcance. (La comprobación previa a ejecutar una historia, descrita al final de este documento, sí consulta el remoto.)

## Servidor con recarga en caliente

Si el servidor se ejecuta con recarga en caliente (por ejemplo `tsx watch`), el `HEAD` de arranque se reinicia con cada recarga automática y el aviso de reinicio puede no aparecer. En ese modo no hace falta reiniciar a mano los cambios de servidor; sí hay que recargar la página.

## Rol de vigilancia: «Vigía de publicación»

- Se ejecuta tras cada aplicación o publicación, también cuando esta falla.
- Comprueba, solo con git local, que el commit esté integrado en `main` y contenido en `origin/main`.
- Registra en la actividad una entrada con el actor «Vigía de publicación» y un veredicto:
  - `ok`: integrado en `main` y publicado.
  - `pendiente`: falta integrar, falta publicar o no se puede confirmar (por ejemplo, sin remoto).
  - `divergente`: el commit está en `origin/main` pero no en `main`, o `main` y `origin/main` han divergido.
- No llama a modelos, no accede a la red, no tiene coste y no bloquea ni revierte la publicación: solo observa y registra.

## Flujo de una rama por cambio (HU-125)

`main` contiene siempre el código real y completo del Portal (carpeta de trabajo `C:\Mis Proyectos\Portal IA`). Cada historia se desarrolla en su propia rama y solo llega a `main` con la aprobación del propietario.

### Convención

- La rama se crea **desde `main` actualizado** y se llama `hu-NNN/descripcion-corta` (por ejemplo, `hu-125/rama-por-cambio`). La función `storyBranchName` de `packages/domain/src/git-branch.ts` deriva el nombre y `checkStoryBranchBase` comprueba que la base es `main` y está al día.
- Los commits citan el identificador de la historia (`HU-NNN`) para que el aviso de reinicio los reconozca.

### Etapas

1. **Rama creada**: el equipo crea la rama desde `main` actualizado.
2. **Prueba manual pendiente**: el propietario recibe la rama para probarla.
3. **Visto bueno**: el propietario aprueba tras probar.
4. **Integrada en main**: con autorización explícita, se integra la rama en `main`.
5. **Publicada**: con autorización explícita, se publica `main` en el remoto.
6. **Cerrada**: se marca la historia como completada.

La historia **no se puede cerrar** sin visto bueno, integración y publicación (regla de cierre de HU-120). Esta regla la implementa `evaluateStoryLifecycle` en `packages/domain/src/story-closure.ts`.

### Pasos para el propietario

1. Cambia a la rama de la historia: `git checkout hu-NNN/descripcion-corta`.
2. Reinicia el servidor local para cargar el código de esa rama. Si solo cambió la web, basta recargar la página (ver las reglas de arriba).
3. Prueba la funcionalidad y comprueba los criterios de aceptación.
4. Si todo es correcto, da el visto bueno y autoriza la integración y la publicación. Si no, indica qué corregir y se sigue en la misma rama.
5. El equipo integra la rama en `main`, publica `main` y cierra la historia.
6. Al cerrar, el Portal muestra: «Cambia a main y actualízalo localmente (`git checkout main && git pull`) antes de empezar la siguiente historia». Hazlo y confirma antes de empezar la siguiente.

## El Portal corre desde otra carpeta o rama (HU-124)

Si el equipo aplica los cambios en una carpeta o rama distinta de la que tú estás ejecutando, no verás esos cambios aunque las historias figuren como completadas. Es lo que ocurrió con HU-122: se completó, pero el Portal se ejecutaba desde otra carpeta y la historia no era visible.

### Qué comprueba el Portal

- Al iniciar y en la vista del proyecto, el Portal compara la **carpeta raíz del repositorio git desde el que corre** y su **rama activa** con el **repositorio registrado** del proyecto (ruta y rama).
- Muestra siempre la rama en la que corre, también cuando todo coincide.
- Indica qué historias completadas **no están contenidas** en la rama en ejecución (se comprueba con `git merge-base --is-ancestor`, solo sobre las historias más recientes). Las historias sin SHA de cierre registrado figuran como «desconocido».
- La comparación de rutas ignora la barra final, los separadores y, en Windows y macOS, las mayúsculas.
- Es de solo lectura: no ejecuta `fetch`, no cambia de rama, no llama a modelos y no tiene coste. Al arrancar, el servidor escribe una advertencia en el log (solo rutas y ramas) si no coinciden.

### Estados

| Estado | Significado |
| --- | --- |
| `coincide` | Carpeta y rama son las del repositorio registrado. |
| `carpeta-distinta` | El Portal corre desde otra carpeta. |
| `rama-distinta` | Misma carpeta, pero otra rama. |
| `carpeta-y-rama-distintas` | Ambas difieren. |
| `no-verificable` | No hay git, la carpeta no es un repositorio, el proyecto no tiene repositorio registrado o HEAD está desacoplado. Se muestra el motivo. |

### Pasos de corrección

La alerta muestra los pasos con las rutas y ramas reales. En general:

1. Detén el Portal, abre una terminal en la **carpeta registrada** y ejecútalo desde ahí con `npm run dev`.
2. Si la rama en ejecución no es la registrada, ejecuta `git -C <ruta> switch <rama registrada>` o fusiona la rama en ejecución en la rama registrada.
3. Si en realidad la carpeta o la rama correctas son las que están en ejecución, actualiza el repositorio registrado del proyecto para que apunte a ellas.
4. Reinicia el Portal y pulsa «Volver a comprobar»: la alerta debe pasar a «coincide».

### Limitaciones

- La comprobación toma como referencia el proceso del **servidor** (`process.cwd()`): se asume que el servidor representa la instalación en ejecución. Si la web se sirve desde otra carpeta, no se detecta.
- Si el proyecto no tiene repositorio registrado, la alerta indicará siempre «no verificable».
- Si el cierre de una historia no guarda el SHA del commit, la contención de esa historia queda como «desconocido».

## Comprobación previa a ejecutar una historia (HU-129)

Antes de ejecutar cualquier historia, el Portal comprueba que corre desde `main` actualizado y que la rama por defecto del remoto es `main`. Si no, la historia queda **detenida** con el motivo en español, sin reservar presupuesto, sin llamar a modelos y sin registrar consumo.

| Comprobación | Condición |
| --- | --- |
| `rama-actual` | La rama en ejecución es `main`. |
| `main-actualizado` | `HEAD` coincide con `origin/main` tras `git fetch origin main`. |
| `rama-por-defecto-remoto` | `git ls-remote --symref origin HEAD` indica `main`. |

Regla «denegar por defecto»: si algo no se puede determinar (remoto inaccesible, HEAD desacoplado, timeout) se considera «indeterminado» y bloquea igualmente.

Qué hacer si se detiene: cambia a `main` y actualízala (`git switch main && git pull`), y si la rama por defecto del remoto no es `main`, el propietario debe cambiarla en GitHub (**Settings → Branches → Default branch → main**) y después ejecutar `git fetch origin && git remote set-head origin -a`.

Lecciones y motivo completo: [Lecciones: ramas, main y ejecuciones desde el sitio equivocado](../conocimiento/lecciones-ramas-y-main.md).
