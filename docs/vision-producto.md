# Portal IA · Visión de producto

> **Estado: dirección de producto del propietario (Yair Cosio), 31 de octubre de 2026.** Orienta la planificación y la
> hoja de ruta (`docs/hoja-de-ruta-capacidades.md`). **No es política operativa:** no concede permisos, no activa
> integraciones ni autoriza gasto. Cada capacidad nueva entra con su propia autorización, sus límites y su evidencia.

## 0. Posicionamiento (2 de noviembre de 2026)

**Portal IA es un sistema operativo local, visual y cercano para gestionar agentes de IA como se gestiona a las personas de
una pequeña empresa.** No construye modelos ni compite con su infraestructura:

- **El Portal es el plano de control**: organización (departamentos, encargos, peticiones), propiedad local, permisos y
  autorizaciones, contabilidad, auditoría y una interfaz que entiende alguien no técnico.
- **Los arneses son motores de ejecución**: Claude Code, Codex, la API de un proveedor y los que vengan. Cada uno con sus
  capacidades reales y su forma de facturar; nunca uno en lugar de otro en silencio (`docs/arneses.md`).
- **Los agentes son identidades del propietario**, en carpetas locales y portables (`agent.yaml`, `AGENTS.md`, habilidades,
  memoria verificada): cambiar de arnés no los recrea (`docs/agentes-portables.md`).

Agente ≠ arnés ≠ modelo ≠ cuenta del proveedor ≠ permisos. La experiencia diaria es la **oficina** (`docs/sistema-operativo-agentes.md`).

## 1. Propósito

Portal IA es una empresa operada por agentes de IA. El propietario describe un objetivo y autoriza un alcance. La
organización trabaja hasta un resultado **verificable**:
- planifica;
- se cuestiona (Gauntlet);
- implementa o produce;
- verifica con evidencia;
- corrige;
- entrega.

Hoy gestiona su propio desarrollo. Mañana gestionará proyectos de software existentes y nuevos, investigación,
marketing y otras áreas, sin que el propietario tenga que coordinar a mano el trabajo técnico rutinario.

## 2. El papel del propietario

- **Decide lo que es suyo:**
  - qué se hace y por qué;
  - el alcance y los límites (presupuesto, llamadas a la suscripción, concurrencia, permisos);
  - la aceptación de cada resultado;
  - las decisiones de negocio y las operaciones protegidas.
- **No coordina lo rutinario.** Investigar, elegir el enfoque técnico, ejecutar pruebas autorizadas, corregir defectos
  ordinarios, consultar especialistas y preparar evidencia son decisiones técnicas autónomas dentro de lo autorizado.
- **Se le pregunta solo lo necesario:** una pregunta concreta, con opciones y recomendación, cuando hay una decisión de
  producto o falta una autorización. Nunca para confirmar otra vez algo que ya autorizó.

## 3. Autonomía organizativa

La autonomía es lo normal **dentro de un alcance autorizado explícito**.

| Autónomo (dentro de lo autorizado) | Protegido (siempre del propietario) |
|---|---|
| Investigar código y datos permitidos | Ampliar gasto o topes de llamadas |
| Elegir el enfoque y planificar | Pasar a una API facturable sin autorización |
| Ejecutar verificaciones y pruebas autorizadas (sandbox) | Credenciales de producción |
| Corregir defectos ordinarios y reverificar | Publicar contenido público |
| Consultar especialistas y actualizar el plan | Compromisos externos de negocio |
| Poner al día candidatos de integración (git, sandbox, QA) | Operaciones destructivas |
| Preparar evidencia, registrar decisiones y lecciones | Conceder permisos nuevos |
| | Desplegar en producción externa |
| | Integrar o publicar cuando la aceptación es del propietario |

**Lo que sí:**
- Una autorización vale para todo lo que cubre. Un lote autorizado no vuelve a pedir permiso para cada historia ni
  para cada corrección dentro de sus límites.

**Lo que nunca:**
- Ningún control de seguridad se salta para ganar autonomía: worktrees aislados, sandbox Docker, rutas protegidas,
  aislamiento de credenciales, salvaguardas de git, topes de llamadas y sin cambio silencioso a una API facturable.

## 4. Responsabilidades de los agentes

| Agente | Qué hace |
|---|---|
| **Asistente** | Entiende el objetivo e investiga (lee el código del proyecto en solo lectura). Propone el trabajo con la forma adecuada: encargo directo, historias o análisis. Mantiene el contexto de la conversación. |
| **Coordinador / Gestor** | Planifica, ordena dependencias, reparte el trabajo y convoca especialistas solo cuando aportan. |
| **Especialistas y Desarrollador** | Ejecutan en su worktree, con el contexto justo (paquetes de contexto, no historiales completos). |
| **QA y Evaluador Gauntlet** | Revisan con evidencia real (diff, sandbox, pruebas, equivalencias deterministas). Distinguen lo medido de lo supuesto. |
| **Todos** | Registran decisiones, evidencia y lecciones con procedencia. Una afirmación no verificada no se convierte en regla permanente. |

## 5. Ciclo de vida de un proyecto

**Idea → definición viva → validación → arquitectura → equipo → backlog con dependencias → lotes autorizados → integración
ordenada → aceptación → medición → mejora.**

Un lote:
- **Primero se termina técnicamente entero:** planificar, cuestionar, implementar, verificar, QA, Gauntlet y corregir.
- **Después lo acepta el propietario historia a historia,** en un orden de integración explicado: no el de los
  identificadores, sino el que minimiza conflictos y respeta dependencias y prioridades.
- **Cada integración pone al día los candidatos siguientes.** Nunca se presenta como vigente una evidencia de una revisión
  obsoleta (ver `docs/empresa-autonoma-lotes-y-asistente.md`).

## 6. Proyectos existentes (escenario de referencia: Orbiventt)

El Portal no asume que un proyecto empieza vacío ni que usa su flujo npm/git/Docker. Incorporar un proyecto existente
sigue estos pasos:

1. **Descubrir sin autorizar.** El Portal lee metadatos: estructura, gestor de paquetes, scripts, CI, documentación,
   herramientas, remotos. No ejecuta nada ni lee secretos (`GET …/projects/:id/discovery` ya lo hace). El resultado es una
   *propuesta* de perfil del proyecto.
2. **Perfil del proyecto aprobado por el propietario.** Comandos de instalación, typecheck, lint, pruebas y build; imagen
   del sandbox; puerta de integración; rutas protegidas propias; herramientas y MCP del proyecto.
3. **Equipo y permisos propuestos.** Se basan en la arquitectura descubierta; los concede el propietario.
4. **Backlog importado o reconstruido** cuando procede, sin cambiar la arquitectura del proyecto.
5. **Gestión del desarrollo futuro** con sus propias prácticas: ramas, entornos, publicación.

Un repositorio registrado **no** da acceso al resto del equipo del propietario. El acceso es por proyecto, con rutas
protegidas.

## 7. Proyectos nuevos (de la idea a producción)

El Asistente guía una conversación que mantiene una **definición viva** del proyecto:
- problema y usuarios;
- objetivos de negocio y alcance;
- funcionalidad clave y restricciones técnicas;
- prioridades y riesgos;
- criterios de éxito y presupuesto inicial.

Las decisiones se cierran de una en una (ya existe el registro de decisiones). Solo con el concepto aprobado, el equipo
hace esto:
- valida y cuestiona;
- propone la arquitectura y el equipo;
- crea el proyecto;
- produce el backlog con dependencias;
- configura las herramientas;
- empieza la ejecución autorizada.

No se crean historias antes de que el propietario apruebe el alcance (salvo que lo pida). La conversación, las decisiones
y la investigación quedan como conocimiento del proyecto.

## 8. Marketing y otros departamentos

Un departamento trabaja con **objetivos de negocio medibles** y un ciclo cerrado: investigación → estrategia → propuesta →
aprobación → producción → publicación → medición → aprendizaje → mejora. Capacidades posibles:
- estudio de mercado, competencia y audiencia;
- campañas;
- textos, diseño, imagen y vídeo;
- calendario de redes;
- analítica;
- experimentos.

Reglas:
- Ningún proveedor concreto se decide sin evaluar requisitos e integraciones disponibles.
- Toda conexión externa exige credenciales, alcances y autorización propios.
- Publicar contenido público o gastar en publicidad exige permiso explícito.
- **Nunca se inventan datos de mercado, interacción, conversiones ni resultados.** Se distingue siempre lo medido de lo
  previsto.

## 9. Integraciones y herramientas

Arquitectura de **capacidades y adaptadores por proyecto**. Cada proyecto declara sus comandos, herramientas, conectores
MCP y servicios externos. El Portal los descubre y los propone; el propietario los autoriza; los agentes los invocan solo
a través de capacidades del Portal: previsualización, autorización, auditoría y topes. No se cablea el flujo del propio
Portal como solución universal.

## 10. Aprendizaje basado en evidencia

- El conocimiento verificado llega a los agentes que lo necesitan: errores recurrentes, convenciones de un proyecto,
  experimentos, supuestos fallidos, cambios en la forma de trabajar del propietario.
- Cada pieza lleva procedencia, alcance, versión y estado de validación. Las lecciones ya funcionan así: las valida el
  propietario y se audita su uso.
- La organización mide sus resultados y propone mejoras con evidencia: duración de historias, defectos repetidos en QA,
  conflictos de integración, intervenciones innecesarias del propietario, campañas por debajo del objetivo.
- Las reuniones internas solo se convocan con un objetivo concreto, participantes pertinentes, evidencia, decisiones,
  acciones con responsable y conclusiones registradas. Nunca se presentan como reuniones humanas.

## 11. Seguridad y autorización

- Aislamiento por worktree y sandbox; el checkout desde el que corre el Portal no cambia.
- Rutas protegidas (credenciales, `.env`, datos, `.git`) que ni se leen ni se escriben.
- Credenciales aisladas por proveedor; nunca en prompts ni en registros.
- Autorización explícita, persistida y auditable para cada alcance.
- Topes de llamadas a la suscripción comprobados antes de cada llamada. La suscripción no es ilimitada ni gratuita; si el
  proveedor no expone el margen real, se dice.
- Nada facturable sin autorización; nunca un cambio silencioso a la API.
- Nada se integra en main sin la verificación exigida, y sin la aceptación del propietario cuando el alcance lo pide.

## 12. Rendimiento y fiabilidad

- Navegar entre Asistente, backlog, historia, proceso, lote y actividad es inmediato y conserva el estado.
- Lo que cambia llega en tiempo real.
- Varios procesos independientes avanzan a la vez; solo se serializa lo que debe serializarse (integrar en main).
- Un reinicio no pierde trabajo ni repite llamadas con cobro incierto. Todo estado duradero se guarda antes de actuar.
- Toda afirmación de estado («integrado», «activo», «vigente») sale del estado real (git, procesos, evidencia), nunca de
  una suposición.
