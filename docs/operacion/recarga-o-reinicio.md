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

El indicador **no ejecuta `git fetch` ni usa la red**. El estado del remoto se calcula con la referencia local `origin/main`, que puede estar desactualizada si alguien publicó desde otra máquina. Un `fetch` explícito requeriría autorización y queda fuera de este alcance.

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
