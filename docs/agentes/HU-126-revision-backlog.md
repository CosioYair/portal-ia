# HU-126 · Revisión del backlog frente al flujo unificado de git

- **Estado del informe:** BORRADOR PARCIAL, pendiente de aprobación del propietario.
- **Autores:** Coordinador y Arquitecto (redacción por el Desarrollador Full Stack).
- **Commit de `main` revisado:** _por fijar al aprobar (el análisis puede quedar desfasado si `main` cambia)._
- **Alcance:** solo análisis y propuesta. No se ha modificado código y no se ha borrado ni editado ninguna historia en el Portal. Toda reclasificación es una **propuesta**.

## 0. Limitación que bloquea el cierre de la historia

El criterio de aceptación exige clasificar las 25 historias del backlog. El listado vigente (ID, título, criterio de aceptación y estado) vive en el Portal y no está en el repositorio. Este borrador solo puede clasificar con evidencia las historias que el repositorio permite identificar: **11 de 25**. Las otras **14** quedan como «sin clasificar» en la sección 3.

**Acción requerida del propietario:** aportar el listado exacto, o exportarlo desde el Portal. Con él se completa la sección 3 y se confirman las clasificaciones provisionales de la sección 2. Hasta entonces, HU-126 no debe darse por cumplida.

Las clasificaciones de HU-116, HU-117 y HU-121 se apoyan en el enunciado del propietario (solapamientos y «ya resuelta de hecho»), no en el texto de esas historias, que no he podido leer. Llevan confianza **baja** y deben contrastarse con su criterio de aceptación.

## 1. Flujo unificado de referencia

1. `main` es el código real del Portal.
2. Una rama por cambio, creada desde `main` actualizado.
3. Prueba manual del propietario.
4. Integración en `main` (con autorización explícita).
5. Publicación de `main` en el remoto (con autorización explícita).
6. Cierre de la historia y aviso «cambia a main y haz pull».

## 2. Clasificación de las historias identificadas

Clasificaciones posibles: **mantener**, **fusionar**, **descartar**, **replanificar**. Cada historia tiene exactamente una.

| Historia | Clasificación propuesta | Motivo | Evidencia | Confianza |
| --- | --- | --- | --- | --- |
| HU-116 | Descartar (resuelta de hecho) | El propietario indica que ya está resuelta. Para descartarla hay que verificarlo con su criterio de aceptación. | Pendiente: no se ha podido leer su texto. Si no se encuentra prueba o archivo que la cubra, pasa a **replanificar**. | Baja |
| HU-117 | Fusionar en HU-125 | El propietario la señala como solapada con HU-121, HU-124 y HU-125. HU-125 es la historia ancla del flujo de rama por cambio. | Solapamiento indicado por el propietario. Falta contrastar texto. | Baja |
| HU-119 | Mantener | Publicación de rama implementada y probada. No requiere acción. | `apps/server/test/git-publish.test.ts` (`publishBranch`, redacción de credenciales, `isValidBranchName`). | Media |
| HU-120 | Mantener | Regla de cierre de historia implementada y probada. Con la salvedad del hallazgo H2. | `packages/domain/src/story-closure.ts` (`evaluateStoryClosure`), `apps/server/test/story-closure.test.ts`. | Media |
| HU-121 | Replanificar | Se ejecuta después de HU-125 y solo por el residuo que HU-125 no cubra. Su alcance debe recortarse tras consolidar HU-125. | Solapamiento indicado por el propietario. Falta contrastar texto. | Baja |
| HU-122 | Mantener | Completada, pero no era visible por ejecutarse el Portal desde otra carpeta. Ese problema lo aborda HU-124. | `docs/operacion/recarga-o-reinicio.md` (sección HU-124). | Media |
| HU-123 | Mantener | Aviso de recarga o reinicio implementado y documentado. | `packages/domain/src/portal-sync.ts`, `apps/server/test/portal-sync.test.ts`, `docs/operacion/recarga-o-reinicio.md`. | Media |
| HU-124 | Mantener | Detecta carpeta y rama distintas y propone pasos de corrección. Lo que falta, cambiar la ruta registrada, va en una historia nueva (sección 5), no en esta. | `packages/domain/src/runtime-location.ts`, `apps/server/test/runtime-location.test.ts`. | Media |
| HU-125 | Mantener (historia ancla, ampliada) | Cubre el flujo central. El dominio ya implementa rama, ciclo y texto del aviso, pero hay huecos de integración (H1 a H4). Se amplía su criterio de aceptación con el aviso (sección 6) y se propone partirla (sección 7). | `packages/domain/src/git-branch.ts`, `packages/domain/src/story-closure.ts` (`evaluateStoryLifecycle`, `CLOSE_NEXT_STEP_NOTICE`), `apps/server/test/story-closure.test.ts`. | Media |
| HU-126 | Mantener | Es esta historia. Se cierra al aprobar el informe completo. | Este documento. | Alta |
| HU-128 | Mantener | Deriva y publica la rama de historia. Introduce una segunda convención de nombre de rama (H5) que debe decidir el propietario. | `storyPublishBranchName`, `isValidStoryBranch` en `git-branch.ts`; `PublishedStoryBranchSchema` en `packages/contracts/src/story-closure.ts`. | Media |

Nota sobre «mantener»: aplicado a historias ya completadas significa «no tocarlas». No implica trabajo nuevo.

## 3. Historias sin clasificar (14)

No identificables desde el repositorio. Se completará cuando el propietario aporte el listado.

| ID | Título | Estado | Clasificación | Motivo | Evidencia |
| --- | --- | --- | --- | --- | --- |
| _por completar (14 filas)_ | | | | | |

Criterios para clasificar al completar:

- **Mantener:** aporta valor directo a «crear empresas y proyectos» o completa el flujo git.
- **Fusionar:** solapa con otra historia y cabe en un diff revisable al unirse.
- **Descartar:** ya resuelta (con archivo y prueba concretos) o sin valor en la etapa actual.
- **Replanificar:** valiosa pero depende de algo previo o necesita recortarse.

## 4. Matriz de cobertura del flujo unificado

| Paso del flujo | Lo que ya existe | Huecos observados |
| --- | --- | --- |
| Rama por cambio desde `main` actualizado | `storyBranchName` (`hu-NNN/descripcion`), `checkStoryBranchBase`, `MAIN_BRANCH` en `git-branch.ts`. Probado en `story-closure.test.ts`. Existe `story-branch.test.ts` (no revisado en este borrador). | H5: dos convenciones de nombre (`hu-NNN/…` y `historia/hu-NNN-…`). |
| Publicación de la rama | `publishBranch` y su prueba (`git-publish.test.ts`). `storyPublishBranchName` y contratos `PublishedStoryBranch` y `StoryBranchError`. | Ninguno observado en el dominio. |
| Prueba manual del propietario | Etapas `prueba_manual_pendiente` y `visto_bueno` en `evaluateStoryLifecycle`. Procedimiento en `docs/operacion/recarga-o-reinicio.md`. Aviso de recarga o reinicio (`portal-sync.ts`). | H2: ver abajo. Interfaz de usuario no verificada. |
| Integración en `main` | Hecho `mergedIntoMain`. El servicio lo comprueba con git (`story-closure.test.ts`, incluso con la rama borrada y `mergedCommit`). | La integración con autorización explícita no está evidenciada en lo revisado. |
| Publicación de `main` | Hecho `pushedToRemote`. Vigía de publicación (`evaluatePublication`). | Sin `fetch`, el remoto es la última referencia conocida (limitación documentada). |
| Cierre | `evaluateStoryClosure` y `evaluateStoryLifecycle`. `completeStory`, `getStoryClosureStatus` y rutas `GET /stories/:id/closure` y `POST /stories/:id/complete` (409 con motivo). | H2. |
| Aviso «cambia a main y haz pull» | `CLOSE_NEXT_STEP_NOTICE` y `nextStepNotice` en `evaluateStoryLifecycle`. | H1, H3, H4. |
| Ubicación de ejecución | `compararUbicacion`, `construirPasosCorreccion`, `clasificarHistorias` en `runtime-location.ts`. | H6: no hay evidencia de una operación para cambiar la ruta. |

### Hallazgos

- **H1.** `StoryClosureStatusSchema` (`packages/contracts/src/story-closure.ts`) es `strict` y no tiene campo para el aviso. El texto vive en el dominio, pero el contrato actual no lo transporta hasta el cliente.
- **H2 (inferido, por confirmar).** Las pruebas de servicio y rutas usan `StoryRecord` sin campo de visto bueno y bloquean por `noIntegrada` o `noPublicada`. Parece que el servicio usa `evaluateStoryClosure`, y que `evaluateStoryLifecycle` (que exige visto bueno) solo está probada a nivel de dominio. Si es así, la regla «no se cierra sin visto bueno» documentada no se aplica en la ruta de cierre.
- **H3.** `evaluateStoryLifecycle` solo devuelve `nextStepNotice` cuando `canClose` es verdadero. Una vez la historia está completada devuelve `yaCompletada` y el aviso desaparece. Es decir, el aviso solo existiría antes de cerrar, no después.
- **H4.** El aviso no comprueba el estado real de git (rama actual distinta de `main`, o `main` local detrás de `origin/main`). Se muestra aunque el propietario ya esté en `main` actualizado.
- **H5.** Conviven `hu-NNN/descripcion` (HU-125) y `historia/hu-NNN-slug` (HU-128). Hay que elegir una o definir cuándo se usa cada una.
- **H6.** `construirPasosCorreccion` dice «actualiza el repositorio registrado del proyecto», pero no he visto en `apps/server/src/routes` ni en `packages/contracts` una operación para hacerlo.

## 5. ¿Hace falta una historia para cambiar la ruta del repositorio registrado?

**Conclusión provisional: sí.**

Justificación:

- `runtime-location` detecta y explica la discrepancia, pero es de solo lectura por diseño.
- `portal-sync` solo observa y registra.
- Los pasos de corrección piden al propietario «actualizar el repositorio registrado», y no se ha encontrado la operación que lo permita (H6).
- La conclusión se invalida si el listado de historias o la UI ya incluyen esa edición. Debe confirmarse antes de crear la historia.

**Propuesta (pendiente de aprobación):**

- **Título:** Cambiar la ruta y la rama del repositorio registrado de un proyecto.
- **Criterio de aceptación:**
  1. El propietario puede editar la ruta y la rama del repositorio registrado desde la vista del proyecto.
  2. El servidor valida con zod que la ruta existe y es un repositorio git, y que el nombre de rama es válido (`isValidBranchName`).
  3. Tras guardar, la comprobación de ubicación se recalcula y el estado se muestra de forma explícita (`coincide`, `carpeta-distinta`, etc.).
  4. El cambio no ejecuta `fetch`, no cambia de rama y no tiene coste. Registra una entrada de actividad.
  5. Hay pruebas en `apps/server/test` para ruta inexistente, no-repositorio y rama inválida.
- **Dependencias:** HU-124 (ya hecha). Conviene ejecutarla después de consolidar HU-125.

## 6. Aviso «cambia a main y haz pull» (parte del criterio de aceptación de HU-125)

### Especificación

- **Cuándo aparece:** tras publicar `main` y cerrar la historia. Debe persistir después del cierre (corrige H3), no solo mientras el cierre es posible.
- **Condiciones (se evalúan con git local, sin `fetch` ni red):**
  - La rama actual del repositorio registrado es distinta de `main`, **o**
  - `main` local está por detrás de `origin/main` según la última referencia conocida.
- **Cuándo desaparece:** cuando la rama actual es `main` y no está por detrás de la referencia conocida de `origin/main`.
- **Texto (español, ya definido en el dominio como `CLOSE_NEXT_STEP_NOTICE`):** «Cambia a main y actualízalo localmente (git checkout main && git pull) antes de empezar la siguiente historia.»
- **Estados explícitos en la interfaz:**
  - _Oculto_: no hay historia recién cerrada o las condiciones no se cumplen.
  - _Visible_: se cumple alguna condición. Muestra el texto y, si es útil, el motivo («estás en la rama X» o «main va N commits por detrás»).
  - _No verificable_: git falla, no hay repositorio registrado o HEAD está desacoplado. Se muestra el motivo, sin ocultar el aviso en silencio.
- **Sin acciones automáticas:** el Portal no ejecuta `checkout` ni `pull`. Solo informa. Un botón «Copiar comando» sería opcional y sin coste.
- **Limitación a documentar:** «por detrás de `origin/main`» usa la última referencia conocida. Si alguien publicó desde otra máquina, puede estar desactualizada.

### Añadido propuesto al criterio de aceptación de HU-125

> Tras cerrar una historia, mientras la rama actual sea distinta de `main` o `main` local esté por detrás de la última referencia de `origin/main`, la interfaz muestra el aviso «Cambia a main y actualízalo localmente (git checkout main && git pull) antes de empezar la siguiente historia». El aviso tiene estados explícitos (oculto, visible, no verificable), no ejecuta ningún comando por sí mismo y llega al cliente a través del contrato de cierre.

## 7. Orden recomendado y punto de replanificación

**Punto de replanificación:** tras consolidar HU-125 y HU-121. A partir de ahí, todo lo no completado se reordena en función de la cadena mínima hacia crear empresas y proyectos.

1. **Paso 0 (bloqueante).** El propietario aporta el listado de las 25 historias. Se fija el commit de `main` revisado.
2. **HU-125 consolidada (absorbe HU-117 si se confirma).** Para mantener el diff revisable, se propone partirla en cortes:
   - **Corte A:** conectar `evaluateStoryLifecycle` (visto bueno) con el servicio y las rutas de cierre, y añadir el aviso al contrato (H1, H2).
   - **Corte B:** aviso persistente en la interfaz con las condiciones de git (H3, H4).
   - **Corte C:** unificar la nomenclatura de ramas con HU-128 (H5), según decida el propietario.
3. **HU-121, solo por el residuo** que HU-125 no cubra.
4. **Historia nueva: cambiar la ruta del repositorio registrado** (sección 5).
5. **Cadena mínima hacia crear empresas y proyectos**, apoyada en los contratos existentes (`packages/contracts/src/company.ts` y `common.ts`):
   - crear empresa (servicio, ruta y pantalla),
   - crear proyecto dentro de una empresa, con repositorio registrado opcional,
   - listar y abrir empresas y proyectos.
   Las historias concretas del backlog que corresponden a cada paso se mapearán al completar la sección 3. Las que no estén en esta cadena se **replanifican** o **descartan** según su valor en la etapa actual.

## 8. Decisiones pendientes del propietario

Nada de lo siguiente se ejecuta sin aprobación expresa.

1. Aportar el listado de las 25 historias (bloqueante).
2. Aprobar o corregir las clasificaciones provisionales de la sección 2, en especial HU-116 (descartar), HU-117 (fusionar en HU-125) y HU-121 (replanificar).
3. Confirmar si hace falta la historia de cambio de ruta del repositorio registrado (sección 5) y aprobar su título y criterio.
4. Aprobar el añadido al criterio de aceptación de HU-125 (sección 6).
5. Aprobar la partición de HU-125 en los cortes A, B y C.
6. Elegir la convención de nombre de rama: `hu-NNN/descripcion`, `historia/hu-NNN-slug`, o definir cuándo se usa cada una (H5).
7. Confirmar el hallazgo H2 (cierre sin visto bueno) y si debe corregirse dentro de HU-125 o en una historia aparte.
8. Aprobar el punto de replanificación y el orden de la sección 7.

No se borra, fusiona ni edita ninguna historia en el Portal hasta recibir esta aprobación.
