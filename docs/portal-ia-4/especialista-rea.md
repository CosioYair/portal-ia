# Especialista en ingeniería inversa y seguridad · análisis de artefactos

## Qué es

- Un **perfil de agente** («Especialista en Ingeniería Inversa y Seguridad», `agent-catalog.ts`, id
  `reverse-engineering`) que se crea como cualquier otro agente (Agentes › Crear un agente). Trae cinco habilidades:
  alcance y autorización, elegir el método (código fuente o artefacto), informe con evidencia, vulnerabilidades y
  dependencias, y modelo de amenazas. Sirve más allá de una herramienta concreta.
- Una **herramienta aislada** para lo que el código fuente no puede responder: «Análisis de artefactos»
  (Agentes › Analizar un artefacto, o Ctrl+K). Usa REA («Reverse Engineer Anything», MIT,
  <https://github.com/morluto/rea>).

## Cuándo usar cada cosa

| Situación | Método |
|---|---|
| Hay código fuente completo (el propio repositorio, software libre) | Leerlo: buscar, seguir llamadas, revisar dependencias. Más rápido y más exacto |
| Solo hay un paquete o un binario | Análisis de artefactos |
| Comprobar qué deja ver lo que se publica (mapas de código, credenciales, rutas) | Análisis de artefactos › «Qué deja ver lo que publicas» |
| Comprobar que una corrección funcionó | Analizar la versión corregida y **comparar** con el informe anterior |

## Cómo está aislada la herramienta

- Imagen propia `portal-ia-rea:6.9.0` (`docker/rea.Dockerfile`), con su propio Node 24: no se cambia el del Portal.
- Versión **fijada** `rea-agents@6.9.0` y su huella `sha512`; si npm sirve otra cosa, la imagen no se construye.
- Instalada con `--ignore-scripts --omit=optional`: no corre ningún script de instalación ni entra Frida.
- **Nunca** se ejecuta `rea setup`: no toca `~/.claude.json` ni instala habilidades en el equipo.
- Cada análisis: `--network none`, `--read-only`, `--cap-drop ALL`, `no-new-privileges`, usuario sin privilegios,
  2 GB / 2 CPU / 256 procesos, 5 minutos. El artefacto se monta en **solo lectura**; no se monta nada más.
- Lista **cerrada** de órdenes (`LAB_ANALYSES`): `audit-release-exposure`, `inspect-binary-hardening`,
  `inspect-artifact`. Todas estáticas: nada de lo analizado se ejecuta. Quedan fuera depuradores, instrumentación,
  ADB, navegador y captura de procesos.
- Lo que devuelve la herramienta es **dato no fiable**: se acota, se limpian caracteres de control y solo se leen
  campos conocidos (`parseReaOutput`). Un estado desconocido nunca cuenta como «sin problema».
- Un ZIP se desempaqueta validando cada entrada (rutas absolutas, `..`, unidades, tamaño, proporción de compresión).
- Sin la declaración del propietario de por qué puede examinar el artefacto, no se analiza. Queda en el informe.

Quitarla del todo: `docker rmi portal-ia-rea:6.9.0`.

## Informe

Tres listas, nunca mezcladas: **confirmado** (con gravedad, dónde y cómo corregirlo), **sin determinar** (sospechas:
no son hallazgos) y **sin problema / no aplica**. Más los límites que declara la propia herramienta.

## Actualizaciones

«Buscar una versión más nueva» consulta solo los metadatos públicos del paquete en npm. Nunca instala nada.

- Si hay versión nueva con menos de 7 días: se espera.
- Si lleva 7 días o más: se propone **revisarla**. Adoptarla es una tarea aparte: leer las notas de versión, comparar
  dependencias y scripts, cambiar versión y huella en `docker/rea.Dockerfile` y en `REA_PIN`, construir la imagen
  nueva y repetir `p4-laboratorio.test.ts`.
- Avisa si la huella de la versión fijada cambió en el registro o si cambia el número de mantenedores.
- Vuelta atrás: la imagen anterior sigue en Docker con su etiqueta de versión; basta volver a apuntar `REA_PIN`.

## Señales de confianza a vigilar (revisión del 2026-11-14)

Un solo mantenedor en npm, ritmo de cambios muy alto, paquete de 190 MB y, según su propia auditoría, sin revisiones
obligatorias en el repositorio. Por eso: versión fijada, sin scripts, sin red al analizar y sin acceso a nada del
propietario. No se recomienda ampliar la lista de órdenes a las que ejecutan o instrumentan sin una revisión nueva.

## Evidencia

`apps/server/test/p4-laboratorio.test.ts`: un artefacto de prueba con **dos defectos sembrados** (mapa de código con el
fuente original y una credencial falsa) se analiza con la herramienta real; se confirman los dos; se corrige el
artefacto; el segundo análisis da cero confirmados y la comparación marca los dos como corregidos.
