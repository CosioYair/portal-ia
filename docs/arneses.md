# Arneses de ejecución · contrato y estado real

> **Agente ≠ arnés ≠ modelo ≠ cuenta del proveedor ≠ permisos.** El arnés es CÓMO trabaja un agente (Claude Code, Codex, la
> API de un proveedor). Cambiarlo no cambia su identidad, instrucciones, habilidades, memoria, departamento, proyectos ni su
> historial. Portal IA no ejecuta modelos propios: orquesta herramientas existentes con permisos, contabilidad y auditoría.

Código: `packages/domain/src/harness.ts` (descriptores y compatibilidad), `apps/server/src/services/harness/index.ts`
(disponibilidad, opciones, cambio), `harness/codex.ts` (adaptador Codex), `claudeCode/backend.ts` (despacho y carriles).

## 1. Contrato

Cada arnés declara (`HarnessDescriptor`): identidad, proveedor, de quién son los modelos, facturación (`subscription` |
`api` | `unverified`) y su matriz de capacidades **tal como el Portal lo lanza** (no lo que el producto podría hacer por su
cuenta): trabajo desatendido, salida estructurada, progreso en directo, lectura del proyecto, propuesta de cambios, ejecutar
órdenes, investigación web, imágenes, continuidad de sesión, subagentes, cancelación e informe de uso — cada una «sí»,
«parcial» (con su explicación) o «no». La parte viva (`harnessAvailability`) dice instalación, versión, autenticación y si
está listo ahora, **sin llamar al modelo**. La ejecución devuelve texto + uso con errores normalizados (`usage_limit`,
`call_cap`, `backend_unavailable`, `timeout`, `cancelled`, `provider_error`, `max_turns`).

| | Claude Code | Claude Code (tu consola) | Codex | API del proveedor |
|---|---|---|---|---|
| Facturación | tu suscripción | no verificable | tu sesión de ChatGPT | por uso (presupuesto) |
| Desatendido | sí | no | sí | sí |
| Lee el proyecto | sí (puente de solo lectura) | sí | parcial (el contexto que le pasa el Portal) | parcial |
| Ejecuta órdenes | no (las verificaciones corren en el sandbox Docker del Portal) | no | no | no |
| Web / subagentes / sesión | no / no / no | — | no / no / no | no / no / no |
| Historias y lotes | sí | sí | **todavía no** (se detiene y lo dice) | sí |

## 2. Reglas (todas probadas)

- **Nunca una sustitución silenciosa.** Cada punto que resuelve el arnés lo hace de forma explícita (`usesClaudeCode` ya no es
  «todo lo que no sea API»). Si el arnés del agente no está disponible, la llamada no se hace y se dice por qué; no se usa otro
  arnés ni la API en su lugar.
- **Codex es su propio origen en los lotes** (`batchSourceOf('codex') === 'codex'`): ningún lote lo autoriza hoy, así que un
  agente que pase a Codex no puede colarse en un lote autorizado para Claude Code o la API. Las historias rechazan Codex antes
  de crear un paso.
- **Trabajo ya autorizado no cambia.** Un encargo fija al crearse el arnés y la revisión de identidad de cada participante
  (`pins`); si el arnés cambia después, esa llamada no se hace. Los lotes ya fijan sus orígenes autorizados.
- **Cambiar de arnés** exige autorización explícita (también hacia la API), solo a un arnés disponible, con un modelo válido para
  ese arnés y nunca con una llamada del agente en curso. Antes de confirmar se muestra qué gana, pierde o cambia, la
  facturación, el trabajo abierto y los lotes afectados. Queda en el registro del agente (`agent_events`).
- Las conversaciones directas tienen su **propio carril** (uno a la vez), no esperan detrás de los lotes ni del Asistente.

## 3. Codex — estado verificado en este equipo (2 de noviembre de 2026)

- Instalado con la app de escritorio: `OpenAI.Codex 26.1027`, CLI `codex-cli 0.166.0-alpha.5.1`
  (`%LOCALAPPDATA%\OpenAI\Codex\bin\<versión>\codex.exe`), «Logged in using ChatGPT».
- Modo que usa el Portal: `codex exec --json --ephemeral --skip-git-repo-check --ignore-user-config --ignore-rules -s read-only
  -C <carpeta temporal vacía> -o <archivo> [--output-schema …] -c web_search="disabled" -c approval_policy="never"
  -c project_doc_max_bytes=0 -c history.persistence="none" -c mcp_servers={} --disable shell_tool --disable unified_exec
  --disable multi_agent …`, prompt por stdin, entorno mínimo **sin** `OPENAI_API_KEY`/`CODEX_API_KEY`, solo con sesión de
  ChatGPT (una clave de API se rechaza: facturaría). Cualquier evento de herramienta durante la ejecución la detiene y queda
  como incidente. Un límite de uso pausa; nunca cambia de arnés.
- **Comprobación sin llamar al modelo:** `codex debug prompt-input` con esos mismos argumentos devuelve la lista de herramientas
  que vería el modelo. **Con la versión instalada, incluso con todas las restricciones, expone `exec` (ejecución de código),
  `wait`, `spawn_agent`, `send_message`, `wait_agent`, `followup_task`, `interrupt_agent`, `list_agents`** y la lista de
  skills personales del propietario. El Portal no puede demostrar que `exec` quede dentro de lo autorizado, así que **Codex
  queda bloqueado** («No disponible» con el motivo) y no se puede habilitar. Cuando una versión permita el modo restringido, la
  misma comprobación lo habilitará sin cambiar código.
- **Verificado de verdad:** detección, sesión, catálogo de modelos (caché local, nunca `auth.json`), la comprobación de
  herramientas sobre la salida real, y todo el adaptador (argumentos, entorno, JSONL, incidentes, límites, cancelación, uso)
  con una CLI simulada. **No verificado:** una ejecución real de Codex (requiere tu autorización para una prueba controlada de
  1 llamada, y además que la comprobación de herramientas lo permita).

## 4. Añadir otro arnés

1. Descriptor en `HARNESSES` con su matriz honesta. 2. Disponibilidad sin llamar al modelo en `harnessAvailability`.
3. Rama explícita en `agentCaller` (y, si va a ejecutar historias, en el pipeline y en `batchSourceOf`). 4. Pruebas con una CLI
simulada. 5. Nada se habilita sin autorización del propietario.
