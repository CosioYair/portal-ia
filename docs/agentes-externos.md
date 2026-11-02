# Agentes externos: integrar un agente que ya existe en su carpeta

Un agente que ya trabaja en una carpeta propia (por ejemplo **PDF Word Fiel**: `AGENTS.md`, `CLAUDE.md`, `contexto/`,
`skills/`, `memoria/`, `bandeja-de-entrada/`, `documentos/`) se integra en el Portal como **referencia gestionada**:
el Portal **no la copia, no la reinicializa y no sustituye sus archivos**. La carpeta original sigue siendo la fuente de
verdad; el Portal guarda un mapa de su estructura, una instantánea adoptada de lo que entra en los prompts, los permisos
que concedes y el registro de todo lo que hace con ella.

Código: `packages/domain/src/external-agent.ts`, `apps/server/src/services/externalAgents.ts`,
`apps/server/src/services/documentJobs.ts`, `apps/server/src/routes/externalAgents.ts`,
`apps/web/src/components/ExternalAgent.tsx`, herramientas en `apps/server/tools/`. Pruebas:
`apps/server/test/agentes-externos.test.ts`.

## Contrato y compatibilidad con estructuras existentes

| Parte | Dónde (detectado) | Qué hace el Portal |
|---|---|---|
| Identidad canónica | `AGENTS.md` (obligatorio) | Entra en sus prompts (instantánea adoptada). |
| Adaptadores de arnés | `CLAUDE.md`, `COMO_EMPEZAR.md`, `README.md` | Se muestran; **no** se inyectan (solo apuntan a `AGENTS.md`). |
| Contexto y conocimiento | `contexto/*.md` | Entra en sus prompts (recortado). |
| Habilidades | `skills/<habilidad>/SKILL.md` (+ `CAMBIOS.md`) | Nombre, versión y procedimiento en sus prompts; guían el plan de cada trabajo. |
| Scripts | `skills/<habilidad>/scripts/*.py` | Se fijan por huella SHA-256; solo se ejecutan los adoptados. |
| Memoria propia | `memoria/*.md` | Su final entra en sus prompts; las mejoras aprobadas pueden añadirle hechos. |
| Entradas | `bandeja-de-entrada/` | Zona de escritura concedida. |
| Entregables | `documentos/<documento>/{original,versiones,revisiones}/` + `HISTORIAL.md` | Zona de escritura concedida; nada se sobrescribe. |
| Copias de seguridad | `configuracion/respaldos/` | Copia previa de cada cambio aplicado o restaurado. |
| Ignorado | `.dependencias/`, `perfil_*`, `node_modules/`, `.git/`, ocultos | No se leen. |
| Permisos | — | **Siempre en el Portal**, por ruta; la carpeta nunca se concede permisos. |

Las carpetas portables del Portal (`portal-ia/agent@1`, con `agent.yaml`) siguen importándose como antes (se copian a
la carpeta del Portal); esta vía es para agentes cuya carpeta debe seguir siendo la suya.

## Procedencia y estado de integración

- **Procedencia** (histórica, no cambia): carpeta de origen, fecha, quién, huella original.
- **Estado de integración**: `Externo · pendiente de integración` (recién importado) → `Externo · en evaluación` (ya hizo un
  trabajo real con el Portal) → `Integrado` **solo** cuando el Portal aplica a sus archivos una mejora **autorizada y
  validada**, con evento (`improvement_applied`: actor, hora, archivos con huella antes/después, autorización, validación,
  copia y revisión restaurable). Adoptar un cambio hecho fuera **no** integra.

## Importar (Oficina → Añadir agente → «¿Es un agente que ya trabaja en su propia carpeta?»)

1. Vista previa: mapa detectado, **todo lo que entraría en sus prompts** (AGENTS.md, contexto, habilidades, memoria),
   adaptadores, scripts con su huella, lo ignorado y los enlaces que no se siguen. No escribe nada.
2. Eliges nombre, papel, departamento, arnés (Claude Code con tu suscripción, o Codex si estuviera disponible; **nunca la
   API facturable**) y los permisos por ruta: escribir entregables/entradas, ejecutar sus scripts, aplicar mejoras.
3. Confirmas. Una carpeta solo se integra una vez (ruta real única; en Windows sin distinguir mayúsculas).

Seguridad de lectura: sin seguir enlaces (symlink/junction) ni enlaces físicos, solo archivos de identidad, límites de
tamaño, credenciales que bloquean.

## Cambios hechos fuera del Portal

El Portal compara la carpeta con la instantánea adoptada. Si cambia algo, la pestaña **Origen** lo muestra (archivo,
nuevo/modificado/eliminado); los prompts siguen usando lo adoptado y **los scripts cambiados no se ejecutan** hasta que los
adoptes (nueva revisión). Restaurar una revisión anterior escribe esa versión en la carpeta con copia previa (CAMBIOS.md
conserva su historial y anota la vuelta atrás).

## Trabajo con documentos (pestaña Documentos)

1. Das un PDF o un ZIP con PDF. ZIP seguro: solo PDF, sin rutas (nombre base), sin cifrados, enlaces, ZIP64, bombas de
   compresión ni CRC falsos; el mismo PDF (SHA-256) no se duplica. Se guarda en `documentos/<documento>/original/`.
2. **Procesar** (lo confirmas): inventario (páginas, texto extraíble). Un PDF escaneado sin OCR instalado se rechaza con
   el motivo (no se entrega un Word de imágenes).
3. El agente **planifica** (una llamada a Claude Code): qué script de su habilidad y con qué argumentos, en JSON. El Portal
   lo valida: script adoptado, argumentos solo marcadores (`{entrada}`, `{salida}`, `{informe}`, `{trabajo}`), opciones y
   valores simples; ninguna ruta.
4. El Portal **ejecuta** el script: una **copia** escrita desde la instantánea adoptada (con sus scripts hermanos), no el
   archivo del disco; solo si el disco y `.dependencias` (fijada por su huella) coinciden con lo adoptado. Sin shell,
   entorno mínimo (sin variables del Portal ni credenciales; Python solo con sus paquetes y las dependencias del agente),
   sin cachés de bytecode del agente, carpeta temporal propia de ruta corta, tiempo límite, uno a la vez por agente y tope
   diario. Python se toma de las instalaciones registradas en Windows (PEP 514), nunca de carpetas que cualquiera puede
   crear. El plan no puede elegir programas ni perfiles (`--soffice`, `--perfil`…) y cada marcador tiene un único papel.
   **No es un sandbox de Docker**: corre en este equipo con tus permisos de usuario; por eso exige tu permiso explícito.
5. **QA del Portal** (`tools/doc_qa.py`), siempre sobre **todas** las páginas (un piloto parcial nunca queda «listo»), en
   una carpeta temporal que el script no conoce y solo si la propia QA termina bien; las evidencias se copian después. Con
   render real en LibreOffice: texto editable, sin páginas completas como imagen,
   sin marcos/VML/fitText ni anclajes, mismas páginas, contenido completo (recall de palabras fuera de figuras), sin
   duplicados, ninguna página vacía, **estructura compatible con Word** (orden del esquema OOXML, ids de dibujo únicos,
   ninguna celda/cuerpo que acabe en tabla), **figuras verificadas** (las regiones que el conversor declara como figura
  existen como imágenes y llevan su texto como texto alternativo) y comparación visual por página (PNG original | render).
6. El agente redacta el **informe de entrega** a partir de las métricas (otra llamada). Si una puerta falla, la versión
   queda **rechazada** y el informe lo dice primero.
7. Versiones `v1`, `v2`… en `versiones/`, evidencias en `revisiones/vN/` (qa.json, comparaciones, INFORME.md) y una línea
   en `HISTORIAL.md`. Nunca se sobrescribe.

**Qué sale de tu equipo**: a Claude (tu suscripción) se envían su habilidad, contexto, nombres de archivo y métricas de
calidad; **el contenido del PDF no se envía**.

## Feedback y aprendizaje (pestaña Mejoras)

Tu feedback se clasifica (una llamada): **solo este documento** (se aplica generando una nueva versión con tu corrección;
no cambia la habilidad), **reutilizable** o **necesita validación** (propuesta de cambio a su habilidad, contrato,
instrucciones o memoria), o **no aplicable**. Las propuestas:

- solo tocan archivos de identidad del mapa; **el código nunca lo escribe el modelo**: un script solo llega como herramienta
  verificada del Portal (`tools/kits/`, p. ej. `pdf-word/convertir_editable.py`); CAMBIOS.md lo escribe el Portal;
- llevan el texto actual de cada archivo (ves el cambio línea a línea antes de aprobar) y la versión sobre la que se
  hicieron: si su identidad cambió después (otra mejora, un cambio adoptado, una vuelta atrás), la propuesta queda
  **obsoleta** y no se aplica; las rutas se llevan a la grafía exacta del archivo existente;
- se aplican **solo** con tu aprobación y el permiso de mejoras, con la carpeta sin cambios externos pendientes;
- al aplicarse: copia previa en `configuracion/respaldos/<fecha>-portal-mejora-<id>/` (con MANIFIESTO.json), cambios,
  entrada en `CAMBIOS.md` (qué, motivo, clasificación, evidencia, copia), validación (lo escrito es lo aprobado, SKILL.md
  legible, Python que compila sin ejecutarse), nueva revisión adoptada y evento; si algo falla, todo vuelve a como estaba.

La siguiente ejecución usa la habilidad nueva (cada versión guarda la revisión de la habilidad y el script que usó): así se
comprueba que la mejora cambió el comportamiento.

## Conversor editable de PDF Word Fiel (kit `pdf-word/convertir_editable.py`, habilidad 0.5.0)

Texto real con sus fuentes, tamaños y colores; tablas nativas con sus filetes; columnas y listas con sangría francesa;
muestras de color en línea; figuras complejas (maquetas de interfaz, capturas) como **imagen de su región** con su texto
como texto alternativo — nunca páginas completas; ajuste con LibreOffice y hasta 3 reintentos a menor escala por página que
desborda. Propiedades OOXML en el orden del esquema.

Límites honestos: el texto **dentro** de las figuras no es editable (en la propuesta de Star Médica, ≈37 % de las palabras
están en maquetas de interfaz); el OCR necesita Tesseract (no instalado); Microsoft Word no está en este equipo: la
compatibilidad con Word se comprueba por estructura, y el render visual es el de LibreOffice.

## Revisión Gauntlet

Tres revisiones independientes (seguridad; integración y datos; interfaz y accesibilidad). Corregido y cubierto por
pruebas: rutas con otra grafía que reemplazaban un archivo sin copia; propuestas obsoletas que deshacían una mejora;
restaurar a medias; agente eliminado que bloqueaba volver a integrar su carpeta; propuesta atascada en «aprobada»;
versión huérfana que bloqueaba el trabajo; doble clic; QA falseable o reducida a unas páginas; código no fijado
(`.dependencias`, scripts hermanos, cachés); opciones del plan que elegían programas; Python descubierto en carpetas
escribibles por otros; raíz sustituida por un enlace; nombres reservados de Windows; salida del script enviada al modelo;
encargos que no fijaban la identidad externa con la que se autorizaron; paso a la API o a la consola. En la interfaz:
confirmaciones antes de gastar o escribir, diferencias antes de adoptar o aprobar, el texto no se pierde si algo falla,
avisos en la oficina de cambios externos y mejoras pendientes, actualización en vivo y lenguaje llano.

## Fallos contemplados

Escritura sin permiso (403), recorridos y enlaces (rechazados), ZIP inseguros (omitidos con motivo), conversión fallida
(versión registrada como fallida), Word no editable o con páginas como imagen (rechazado por la QA), arnés caído (falla con
su motivo; nunca otro arnés ni la API), límites (uno a la vez, tope diario), mejora sin aprobación o con cambios externos
pendientes (409), aprendizaje inválido (se descarta lo inseguro), importación duplicada (409), reinicio a mitad (el trabajo
queda «falló» y se puede repetir; el original y las versiones anteriores siguen en su carpeta).

## API

`POST /api/workspaces/:slug/agents/external/preview` · `POST …/agents/external` · `GET …/agents/:id/source` ·
`POST …/source/adopt` · `PUT …/source/grants` · `POST …/source/restore` · `GET|POST …/agents/:id/documents` ·
`POST …/documents/:jobId/process` · `GET …/documents/:jobId/file?path=` · `GET …/documents/:jobId/versions/:n/evidence` ·
`POST …/agents/:id/feedback` · `POST …/proposals/:pid/apply|reject`.

Esquema de datos 0.18 (copia automática antes de migrar): `agent_sources`, `agent_source_revisions`, `document_jobs`,
`improvement_proposals` (aditivas).
