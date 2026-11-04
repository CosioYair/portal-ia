# Autonomía real del Asistente y aprendizaje verificable

Intervención del 2026-11-03 a partir de dos problemas observados en pruebas reales:

- **HU-177** agotó sus correcciones sin converger.
- El Asistente respondía que no podía cambiar el código del Portal sin crear una historia.

El objetivo: que «haz esto» se resuelva con los mecanismos autorizados del Portal (encargos, operaciones del catálogo, sandbox, QA y Gauntlet), con evidencia y sin historias automáticas. Las correcciones deben apoyarse en evidencia y el conocimiento validado debe sobrevivir solo si una tarea posterior lo demuestra.

## 1. Causa raíz: por qué las correcciones no resolvían nada (HU-177)

Todo lo siguiente se comprobó sobre el historial guardado de HU-177 y reproduciendo `main` (88863b5) en el MISMO sandbox Docker que usa el Portal, sin tocar HU-177.

1. **Falso positivo de la comprobación previa a QA.**
   - Desde que `apps/server` usa `node scripts/run-tests.mjs` como script `test`, `testDiscovered` tomaba la ruta del ejecutor por un patrón de pruebas.
   - Resultado: toda prueba nueva salía «el script test no ejecuta esta prueba».
   - HU-177 gastó la corrección 1 en eso, y el agente llegó a modificar la propia comprobación (`storyUnits.ts`) en su rama.
2. **`main` ya fallaba en el sandbox Linux y nada lo comparaba.** Dos pruebas eran válidas en Windows y fallaban en el contenedor:
   - `mantenimiento-proyecto` «el remoto rechaza»: su gancho git estaba en un `/tmp` que no permite ejecutar.
   - `lotes-adjuntos-acciones` «fallo de disco al cerrar»: marcar un archivo de solo lectura no impide su sustitución atómica en Linux.

   Ninguna historia podía dejar `test` en verde, y el Portal le cargaba esos fallos.
3. **Atribución por ruta, no por evidencia.**
   - «Solo fallan pruebas que esta historia no toca» mezclaba dos regresiones reales de HU-177 (pasan en `main`) con los dos fallos heredados.
   - Repetía una vez y se detenía en el límite.
4. **Correcciones casi a ciegas.**
   - La evidencia llegaba recortada a 1 500 caracteres.
   - Los intentos anteriores eran solo títulos (sin diff ni resultado).
   - No llegaba el contexto de la iteración.
   - El agente agotaba sus 8 turnos buscando.
5. **Una regla que hacía imposible terminar.**
   - Las dos regresiones de HU-177 son pruebas existentes que fijan justo el comportamiento que la historia debía cambiar (lotes independientes).
   - Como «una prueba existente no se modifica», el agente no podía adaptarlas ni el código podía cumplir a la vez la historia y la prueba antigua.
6. **«Preguntar al equipo» e «iterar» perdían la evidencia.**
   - La pregunta llegaba con esfuerzo bajo y sin diagnóstico.
   - La iteración nueva descartaba la rama y recibía solo títulos, así que repetía errores.
7. **Lecciones no demostradas.**
   - Nacían de cualquier fallo, incluidos los heredados o los falsos positivos.
   - Bastaba un clic para validarlas y se inyectaban sin más; una reincidencia solo mostraba un aviso.

## 2. Cambios

### Correcciones basadas en evidencia (`services/baseline.ts`, `testTriage.ts`, `storyPipeline.ts`, `storyUnits.ts`, `qaGate.ts`)

**Línea base, sin IA.** Cuando `test` falla, se ejecuta el mismo `test` sobre la **base** de la historia. La base es `merge-base(cabeza, main)`: siempre código ya integrado, también tras un candidato de integración o en historias apiladas. La ejecución:
- usa un worktree temporal y único bajo `<repo>-worktrees/.linea-base/`, nunca bajo `/tmp` (un sandbox sin `/tmp` propio lo compartiría con el equipo);
- se retira siempre, y al arrancar se limpian los que dejó un apagado brusco;
- corre en el mismo sandbox, sin instalar nada;
- se hace una vez por commit y se comparte entre historias;
- si no se pudo obtener, no se repite en la sesión.

**Evidencia completa.** El triaje no usa la salida guardada (que se recorta) sino un resumen calculado en el sandbox sobre la salida COMPLETA (`TestDigest`): cuenta, fallos con su error, línea y valores `expected`/`actual`, y la huella de las pruebas que pasaron. Las rutas de archivo se hacen relativas al repositorio (Docker, WSL y linux-ns). Sin resumen completo no hay triaje:
- un proceso antiguo con la salida recortada repite `test` una vez, sin IA;
- si el proceso de pruebas murió (código distinto de 1) o se ejecutaron menos pruebas que en la base, no se acepta nada.

Cada prueba que falla se clasifica así:

| Clase | Qué significa | Consecuencia |
|---|---|---|
| preexistente | falla igual sin la historia: mismo archivo, prueba, línea de la aserción, mismos valores y mismo error (solo se ignoran duraciones, rutas temporales, ids y puertos) | no se le cobra; no gasta correcciones |
| introducida | no fallaba en la base y falla con la historia | es de la historia; la corrección la recibe con esa evidencia |
| cambiada | ya fallaba, pero distinto (otros valores, otra línea u otro error), o la historia dice ocuparse de ella (su plan o su criterio) | es de la historia |

- Si solo hay preexistentes, `test` cuenta como superada frente a la base (`verificationPassed`). La salida real se conserva, y QA, el flujo y la tarjeta lo dicen así («sin fallos nuevos»), con las pruebas por nombre.
- **Integrar exige que lo confirmes:** la integración manual responde `ack_required` hasta que marcas la confirmación, que nombra las pruebas heredadas. Además fija el commit que viste (`expectedCommit`). En los lotes, la revisión lo muestra y aceptarla es la confirmación.
- Sin línea base fiable (otras dependencias, sin sandbox, error al prepararla) no se clasifica nada y se dice por qué.
- La verificación manual («Verificar test») hace el mismo triaje que el pipeline.

**Prueba existente que fija un comportamiento que la historia cambia.**
- Solo es actualizable si la base demuestra con su resultado `ok` que PASABA, y falla con la historia.
- Nunca si es de seguridad: sesión del propietario, política, sandbox, puente, capacidades, git o secretos.
- Nunca para debilitarla: sin IA se rechaza añadir `skip`/`todo`/`only`, quitar casos o quitar aserciones.
- El prompt pide actualizarla solo si un criterio lo exige y explicarlo.
- Queda en `manifest.testUpdates`. QA la revisa explícitamente, la tarjeta y el proceso la muestran, e **integrar exige confirmarla**.

**La corrección recibe:**
- la evidencia sin recortar a 1 500 caracteres;
- la línea base (lo suyo y lo que no debe tocar);
- los intentos anteriores con su diff real y lo que pasó después;
- el contexto de la iteración;
- la instrucción de identificar la causa antes de cambiar nada.

**Otros cambios:**
- **Comprobación previa a QA:** un script ejecutor ya no se toma por patrón; lo decide la ejecución real.
- **Preguntar al equipo / iterar:** reciben `iterationEvidence` (fallos reales con su error, línea base, correcciones ya intentadas con su commit y el estado del pipeline). La pregunta usa el esfuerzo configurado del agente.
- **Las dos pruebas de `main`** ya no dependen del sistema operativo:
  - una usa `receive.denyDeletes` en lugar de un gancho;
  - la otra, una carpeta con el nombre del manifiesto en lugar de un archivo de solo lectura.

### Aprendizaje verificable (`services/lessons.ts`)

- Una lección nunca nace de un fallo que la historia no causó (un `test` aceptado frente a la base no genera lección).
- **Validada ≠ aprendida.** Al terminar cada tarea POSTERIOR, cada lección validada que llevaba inyectada recibe su evidencia (`LessonProof`):
  - `held` = terminó verificada sin repetir su error. La primera vez queda **aprendida** (`provenAt`).
  - `recurred` = el mismo error volvió con ella presente.
- Tras `REFUTE_AFTER` (2) reincidencias seguidas, la lección queda **retirada** (`refuted`):
  - deja de inyectarse y aparece en Pendientes para revisarla;
  - si el propietario la corrige, se crea una versión nueva sin pruebas; la anterior conserva su historial.
- La tarea que originó la lección no cuenta como demostración.
- Solo cuentan las tareas TERMINADAS y verificadas: una pausa con un fallo pendiente aún puede corregirse y no es una reincidencia.

### El Asistente actúa (`services/assistant.ts`, `capabilities.ts`, `assignments.ts`)

**Prompt:**
- Prepara, ejecuta por los mecanismos del Portal y supervisa; el propietario autoriza lo que gasta o cambia.
- Sigue una guía de autonomía de 6 pasos: intención, lectura, vía, autorización, informe con evidencia y lo que falta.
- A «¿puedes cambiar el código del Portal sin una historia?» responde que sí: con un encargo que prepara y supervisa.
- Nunca presenta como hecho algo que no ha ocurrido.

**Sin historias automáticas.**
- Una operación que el catálogo no tiene se propone desarrollar con un **encargo** en borrador (sin duplicados por título), no con una historia. Las historias se crean solo si el propietario las pide.
- Si el alcance es un conjunto grande de entregas, el Asistente pregunta si prefiere historias.
- Las acciones «mejorar el Portal» de los chats de la Oficina siguen creando una historia, pero solo tras el «Sí, hazlo» del propietario en su tarjeta, que dice lo que se crea.

**`run_checks`** (nueva operación del catálogo):
- Ejecuta de verdad typecheck/test/build sobre `main` de un proyecto, en el sandbox, en un worktree temporal; sin red, sin IA y sin cambiar nada.
- La autoriza el propietario en la tarjeta (sesión del propietario y política `sandbox_exec`).
- Está atada al commit que mostró la tarjeta: se ejecuta ESE commit y, si `main` cambió, no se ejecuta.
- Usa una carpeta única por ejecución (dos a la vez no se pisan).
- Se ejecuta en segundo plano y el resultado aparece en la tarjeta.
- Si un reinicio la corta, queda «no terminada», nunca «hecha».

**Lectura:**
- Sin un proyecto fijado, la conversación global o de la empresa Portal IA lee (solo lectura, rutas protegidas) el repositorio del propio Portal si está autorizado para Claude Code. En conversaciones de otra empresa, nunca.
- El prompt dice qué repositorio leen sus herramientas.
- La pista de esas herramientas ya no dice «no puedes»: dice cómo se cambia el código.

**Resultado en la conversación.** Al terminar, detenerse o fallar un encargo, el Asistente publica en su conversación (sin IA, con el texto escapado) qué cambió, el commit, la verificación (con la línea base) y QA.
- El siguiente paso es el botón exacto que tiene su tarjeta: «Integrar en main», «Continuar», contestar la pregunta del equipo, «Autorizar y ejecutar» o cancelar.
- No publica nada si ya está integrado o si lo rechazaste tú.

**Tarjeta del encargo (en el chat; el panel lateral no la repite):**
- **Revisión:** archivos cambiados, verificación en el sandbox en palabras («sin fallos nuevos», «bloqueado», «no terminó») y las pruebas existentes modificadas.
- **Diff:** enlace al diff completo.
- **«Integrar en main»:**
  - usa el servicio de siempre, con la sesión del propietario;
  - fija el commit verificado y pide confirmar lo que la base dejó pasar;
  - si hace falta preparar el candidato con main o resolver conflictos, enlaza al proceso.
- **Después de integrar:** dice qué falta para «Aceptar» (activar, comprobar en ejecución y la prueba manual).

### Configuración del modelo y el esfuerzo

- **Niveles:** `ReasoningEffort` admite `xhigh` y `max`. `effortLevelsFor` dice qué admite cada modelo, según la documentación de Anthropic:
  - Opus 4.7+, Opus 5/5.5, Sonnet 5/5.5, Haiku 5.5 y Fable: los cinco;
  - Opus/Sonnet 4.6: sin `xhigh`;
  - el resto: bajo, medio y alto.
- **Al guardar:** guardar un nivel que el modelo no admite devuelve 400 `effort_unsupported` con los admitidos. Al crear agentes (asistente, importación, propuesta de la IA, Evaluador), el nivel se ajusta al que el modelo admite.
- **Solo si lo eliges (`effortApplied`):** el esfuerzo se pasa a Claude Code solo si el propietario lo eligió después de esta versión.
  - Los agentes existentes siguen con el esfuerzo predeterminado de la CLI hasta que elijas su nivel y guardes: el Portal no cambia solo a ningún agente.
  - Las llamadas internas con otro esfuerzo (p. ej. «bajo») tampoco lo cambian.
- **Claude Code:**
  - La detección lee los niveles de `--effort` de la ayuda de la CLI instalada (sin llamar al modelo).
  - `buildArgs` pasa `--effort <nivel>` solo si esa CLI lo anuncia.
  - Cada ejecución registra el esfuerzo pasado (`claude_code_runs.effort`).
- **Ajustes del agente:** muestran la **invocación real**, por ejemplo «Se invoca: claude --model claude-opus-5-5 --effort xhigh (Claude Code 2.1.311, tu suscripción)».
  - Si la CLI no admite el nivel, o aún no lo elegiste, se dice que usa su predeterminado.
  - Las estimaciones de costo cuentan el razonamiento de `xhigh` y `max`.
- **Por la API:** `output_config.effort` con los cinco niveles (OpenAI se queda en `high`).
- **Comprobación en el equipo del propietario, sin consumo:**
  - Claude Code 2.1.311 acepta `--effort xhigh` con `--model claude-opus-5-5`. Una sesión con mensaje en blanco dio `apiKeySource: none` (suscripción), «nothing was sent to the model» y 0 USD.
  - Un valor inventado se rechaza: «Unknown --effort value … Valid values: low, medium, high, xhigh, max».

## 3. Gobernanza (lo que NO cambia)

- **Autorización:** todo cambio por la API exige la sesión del propietario. Las nuevas acciones (autorizar el encargo, integrar, `run_checks`) pasan por la misma política y las mismas rutas.
- **El Asistente:** no tiene consola ni escribe archivos. Cambia código solo mediante encargos: worktree aislado, sandbox sin red, QA y Gauntlet.
- **Integración:** no integra, activa ni publica nada por sí solo.
- **Presupuesto y llamadas:** se autorizan en la tarjeta; con Claude Code, 0 USD de API.
- **Archivos y mensajes:** su texto se trata como datos (vallas de adjuntos, puente de solo lectura con rutas protegidas).

## 4. Cómo probarlo desde el Asistente

1. **Ajustes del Asistente.** En Equipo, abre el Asistente de Empresa, elige el esfuerzo «Muy alto» (xhigh) y pulsa «Guardar». En «Invocación real» debe aparecer `--model claude-opus-5-5 --effort xhigh` con tu suscripción. Si dice que la comprobación es anterior, pulsa Ajustes › Claude Code › Comprobar.
2. **Pregunta.** En el Asistente: «¿Puedes cambiar el código del Portal sin crear una historia?». Debe responder que sí, con un encargo.
3. **Pide un cambio pequeño**, por ejemplo: «Cambia el texto X del Portal por Y». Aparece la tarjeta del encargo EN-n (sin historia en el backlog).
4. **Autoriza.** Revisa el equipo, el tope de llamadas y Gauntlet, marca «Autorizo ejecutar…» y pulsa «Autorizar y ejecutar».
5. **Resultado.** Al terminar, el Asistente publica en la conversación los archivos, el commit y la verificación. En la tarjeta:
   1. revisa el diff;
   2. marca «Integro en la rama principal…» y pulsa «Integrar en main»;
   3. pulsa «Reconstruir y reiniciar» en la barra superior;
   4. en el proceso, «Comprobar en ejecución» y la prueba manual;
   5. «Aceptar».
6. **Comprueba main.** Pide «comprueba main» y autoriza `run_checks`: typecheck/test/build sobre el `main` integrado.
