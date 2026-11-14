# Portal IA 4.0 · diseño de producto y arquitectura

Qué pidió el propietario, qué había y qué cambia. Cuando dos peticiones chocan, manda la última explícita.
El inventario completo de requisitos (con sus palabras y fechas) se guarda **fuera del repositorio**, que es público:
aquí solo va su resumen. Este documento se revisó con un Gauntlet de requisitos; lo que cambió por esa revisión está
marcado con «(R-n)» y figura en `HALLAZGOS.md`.

## 1. Lo que se pidió y no se tenía

| Lo que pidió (resumido) | Estado al empezar | Qué hace 4.0 | Dónde |
|---|---|---|---|
| Que un encargo no se quede atascado ni «no haga nada» al pedir cambios | mal implementado | Un trabajo integrado no se convierte en análisis; su estado se corrige solo | C1, C2 |
| Que el estado diga la verdad: lo integrado no figura como «detenido» | mal implementado | El estado sale de los hechos (integrado, activo), no de la última iteración | C2 |
| Que un lote atascado no impida crear otro | mal implementado | Solo bloquea el lote que puede avanzar por sí mismo | C3 |
| Que los agentes aprendan y no repitan errores | mal implementado (se cuenta «usada», no «evitó el fallo») | Una lección solo es «Aprendida» si evitó su error en una tarea que tocaba el mismo archivo | C4 |
| Sin información repetida ni pantallas parecidas; menos texto | parcial | Seis destinos por objetivo; una acción por tarjeta; detalle técnico plegado | D |
| Estudio de vídeo | no existía | Editor real con exportación a MP4 comprobada | E |
| Especialista en ingeniería inversa y seguridad | no existía | Perfil de agente + análisis de artefactos aislado | F |
| Todos los agentes de Portal IA con Fable 5.2 (EN-028) | sin integrar | Recuperar el candidato verificado | G |
| Módulo «Ediciones» (HU-214) | sin integrar | Recuperar el candidato verificado | G |
| Nombre, identidad y bienvenida nuevos (HU-215, HU-216) | sin empezar | Inicio es la nueva entrada; el nombre es decisión suya | §7 |

## 2. Navegación: por objetivo, no por mecanismo

| Destino | Responde a | Absorbe |
|---|---|---|
| **Inicio** | ¿Qué me necesita? ¿Qué está pasando? ¿Qué se terminó? | Resumen; el recorrido de prueba mientras esté abierto |
| **Trabajo** | Todo lo que pedí y su estado | Backlog, Lotes, Actividad, Archivo, Procesos e Historias |
| **Agentes** | Quién trabaja para mí; crear, especializar, exportar, traer de vuelta | Oficina, Organización, Departamentos |
| **Estudio** | Crear y editar vídeo | nuevo |
| **Conocimiento** | Lo que el equipo sabe y ha aprendido | Conocimiento, lecciones |
| **Ajustes** | Motores de IA, presupuestos, seguridad, sistema | Ajustes, Presupuestos, recorrido de prueba |

- El **Asistente** no es un destino: es el botón «Pedir», presente en todas las pantallas, con su panel (conserva la
  conversación y el texto sin enviar). Su vista grande sigue en `/asistente`.
- **Una sola lista de «Te necesitan»** (R-2): la de Trabajo. Inicio enseña las cuatro primeras y enlaza a ella; no es
  otra lista.
- El subtítulo de marca deja de ser «Estudio de agentes» para no chocar con el Estudio de vídeo (R-7).
- Las rutas antiguas siguen funcionando; nada de lo que existía deja de ser alcanzable (búsqueda con Ctrl+K).

Pendiente en esta área, reconocido: historias y encargos siguen siendo dos entidades por dentro aunque se listen
juntos; Backlog, Lotes, Actividad y Archivo siguen siendo pestañas de Trabajo; el flujo de un trabajo conserva sus
nueve etapas. Unificarlos es el siguiente paso de D y está en el punto de control.

## 3. Un solo ciclo de entrega

Reglas del motor (las que estaban rotas llevan su corrección):

1. Un trabajo que pide un cambio no termina como «análisis» por sí solo; si ya está hecho, se **demuestra** (C1).
2. Después de integrar, el trabajo conserva ese hecho: una iteración posterior no lo oculta (C2, automático).
3. Una comprobación escrita por un agente es **dato no fiable**: se acota, y cuando el Portal responde bien y solo falla
   esa comprobación, primero se repite; no se culpa al código (C1).
4. La evidencia que solo puede producir el Portal (capturas, accesibilidad) la produce el Portal **antes** de la
   revisión de calidad, y «falta la evidencia» nunca va al Desarrollador (hecho en `ccfffcd`).
5. Un lote solo bloquea a otro si de verdad puede avanzar solo (C3).
6. Reintentar algo idéntico no se ofrece: o cambia la entrada, o cambia quién lo atiende, o se detiene con el motivo.

**Decisiones que SOLO son del propietario** (R-10): gastar (presupuesto y proveedores de pago), integrar en la
versión principal, activar, publicar, aceptar o rechazar un resultado, cancelar trabajo, borrar datos o ramas, conectar
cuentas externas y declarar que puede examinar un artefacto ajeno. Todo lo demás lo resuelve el equipo o el Portal; si
no puede, se detiene diciendo de quién es el problema, no «decides tú».

## 4. Arquitectura: migración incremental

Se conserva el monorepo (TypeScript, React + Vite, Fastify, SQLite por empresa): los datos del propietario y 170
archivos de pruebas dependen de él, y nada de lo que fallaba se arregla cambiando de tecnología. Lo que cambia:

- **Módulos nuevos aislados**, con su contrato en `packages/domain` y su almacenamiento propio. El Estudio
  (`studio*.ts`) y el laboratorio (`lab.ts`, `artifactLab.ts`) no importan nada del motor de historias.
- **Herramientas externas en contenedores propios**: FFmpeg (`portal-ia-media`) y REA (`portal-ia-rea`), sin red, sin
  privilegios, solo lectura y con límites. Nunca en el proceso del servidor ni con credenciales del propietario.
- **Adaptadores con estado honesto**: modelos y arneses (`ai-adapters`, `harness/`), generación de vídeo
  (`studioProviders`).
- **Deuda reconocida**: `batchRunner.ts` (2000+ líneas), `storyPipeline.ts` (1290) y `routes/processes.ts` (870)
  concentran el ciclo de entrega. Se parten al tocar cada regla del §3, con sus pruebas; no se reescriben de golpe.

## 5. Seguridad de lo nuevo

Ver `HALLAZGOS.md` (ronda de seguridad). En resumen: subidas con tamaño contado byte a byte y tipo decidido por
contenido; ningún texto del usuario llega a la orden ni al grafo de FFmpeg; contenedores sin red, de solo lectura y
con tope de memoria, CPU, procesos y tiempo; ZIP desempaquetado con validación de cada entrada; salidas de
herramientas tratadas como dato; todo cambio exige la sesión del propietario; al arrancar se limpian contenedores y
carpetas temporales huérfanos.

## 6. De los cuatro vídeos de referencia

Los cuatro se inspeccionaron por fotogramas y descripción (sin audio ni transcripción disponibles). Ninguno demuestra
nada en pantalla: son presentaciones. Principios adoptados:

| Vídeo | Principio | Dónde se aplica |
|---|---|---|
| El «algoritmo» de cinco pasos (EDteam) | Cuestionar y **eliminar** antes de automatizar | §2: se quitan destinos antes de añadir |
| Las ocho capas de un agente empresarial (Klustomer) | Guardarraíles ante contenido no fiable; observabilidad; evaluar antes de publicar | §3.3, §5, Gauntlet |
| 31 mejoras de rendimiento (bybrayan.ai) | Trabajo pesado en segundo plano, carga diferida, progreso real | Estudio: exportación fuera del servidor con avance y cancelación |
| Anuncios con Claude (promesa comercial) | Ninguno: no demuestra nada ni enlaza a nada comprobable | — |

## 7. Decisiones que siguen siendo del propietario (R-1)

No están decididas por este diseño; 4.0 funciona con lo vigente hasta que él diga otra cosa:

- **Paleta**: está en marcha el índigo de EN-029 (lo integró, pero aún no lo ha aceptado).
- **Nombre e identidad**: se conserva «Portal IA»; HU-216 espera su decisión de nombre.
- **Reinicio**: hoy el Portal se reinicia solo tras «Actualizar»; su última indicación escrita pedía reiniciar a mano.
- **Proveedor de vídeo con IA**: ninguno conectado. Las condiciones de Higgsfield restringen usarlo para productos
  que compitan con él: no se integra salvo que él las lea y lo decida.
