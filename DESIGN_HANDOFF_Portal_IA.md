# DESIGN HANDOFF — Portal IA · Initial Bootstrap Experience (HU-001 · HU-002 · HU-003)

Prepared for implementation in React + TypeScript + Vite. All user-facing strings are Spanish; this document is English so the engineering reviewer can map it to code. "Portal IA" is a temporary name and is referenced in exactly three places (wordmark, workspace switcher, breadcrumb) so it can be swapped via a single constant.

---

## A. Prototype

**Primary deliverable — standalone prototype.** `portal-ia-prototipo.html` is a single self-contained HTML/CSS/JS file with no dependencies and no network calls (Google Fonts is the only external link; it falls back to system fonts offline). Open it directly in any browser — double-click, or `npx serve` the folder — and the full flow works: provider connection (simulated success/failure), model selection, workspace initialization, repository authorization, dashboard, team org chart, and agent configuration with save/discard. Architecture: a single in-memory `S` state object, pure template functions per screen (`screenWelcome()` … `screenAgent()`), one `render()` that re-paints `#app` and restores focus, and delegated event handlers keyed by `data-act` / `data-change` / `data-field`. This maps directly onto React components + a store (section G).

**Design canvas (secondary, for review).** The Design canvas open beside this conversation ("Portal IA · Experiencia de arranque") holds the same design in the canvas's component format:

| Artboard | What it is |
|---|---|
| `Main.dc.html` — *Prototipo interactivo · flujo completo* | The whole flow in one component with shared state. Press **Play** (or open full-window) and walk Welcome → Provider → Init → Dashboard → Team → Agent → back. |
| `A-Bienvenida` … `F-Agente` | The same component mounted at a fixed entry screen/state (`start-screen`, `start-conn` props) so each screen can be reviewed side by side. They are fully interactive too. |

**Why one component.** The flow must carry state across screens (selected provider → default model → agents' preferred model; repo authorization → dashboard chip; agent edits persisting while navigating). In the canvas format, cross-screen state requires a single artboard; each screen is a conditional branch on `state.screen`. This maps 1:1 to a React app with a router + store.

**Files required to reproduce.**
- `portal-ia-prototipo.html` — **the standalone prototype** (open directly; this is the file to hand to the implementing engineer).
- `Main.dc.html` — the canvas component version of the same design (CSS in `<helmet><style>`, markup with `{{hole}}` bindings and `<sc-if>/<sc-for>`, logic class). It only runs inside the Design canvas (it needs the canvas's `support.js` runtime); do not open it directly.
- Canvas files `project/canvas.json`, `project/A-…F-….dc.html` live in the canvas itself (artboard index + 20-line wrappers that mount `Main` at a start state).

**Inspecting / exporting.** Standalone file: open in a browser. Canvas: *Play* runs it; *Share › Export* produces PNG/PDF per artboard. Translation guidance is in section G.

**Prototype-only affordances (remove in product).** The "prototipo · simular resultado · Éxito/Fallo" segmented control on Screen B, the "PROTOTIPO · conexiones y datos simulados" corner badge, and the "lista simulada" tag on the model list. The connection is simulated with a 1.6 s timer; initialization steps advance every 0.7 s on a timer. No network calls are made anywhere.

---

## B. Screen inventory

### SCR-A · Bienvenida (first-run welcome)
- **Purpose.** Introduce the local workspace in one sentence, show the 3 setup steps, make "connect a provider" the only primary action.
- **Main components.** `SetupHeader` (wordmark + "nombre provisional" chip + mono status "local · primera ejecución · v0.1"), 2-column `SetupLayout` (text column / `PreviewCard`), `StepsList` (3 numbered rows), `Button primary`, `AssuranceNote` (lock icon), `PreviewCard` "Qué se creará" (mini-tree of workspace → project → team → repo → future companies, each with a `Chip` status).
- **Interactions.** `Conectar un proveedor de IA →` → SCR-B.
- **Navigation.** → SCR-B.
- **Mock states.** Single state.

### SCR-B · Proveedor de IA (provider configuration)
- **Purpose.** HU-001: select provider, enter credential, verify, pick default model; communicate security and that consumer subscriptions ≠ API access.
- **Main components.** `SetupHeader` with `Stepper` (1 active / 2 / 3) — replaced by `Volver al panel` when entered post-setup; `PageIntro` (eyebrow "Paso 1 de 3", H1, lede); `Card Proveedor` with `ProviderCard ×2` (Anthropic, OpenAI; selectable, check badge) + disabled dashed `ProviderCard` "Otro proveedor · disponible más adelante"; `Card Credencial` with `ConnectionStatusChip`, `PasswordInput` + `Mostrar/Ocultar` toggle, help text (subscription ≠ API), `Notice info` (encrypted local storage), conditional `Notice error` / `Notice ok`, `SimulationToggle` (prototype only), `Button primary` Verificar; conditional `Card Modelo predeterminado` with `ModelRadioRow ×3` (name, mono id, description, "razonamiento ajustable" chip, 3-bar relative cost); footer `Atrás` / `Continuar · Inicializar espacio interno`; aside: `Card Estado de la conexión` (`Timeline` 4 rows), `Card Qué hace la verificación` (kv rows: 1 API call, no generation), `Card Independiente del proveedor`.
- **Interactions.** Pick provider (resets connection + model); type key; toggle visibility; choose simulated outcome; Verificar → 1.6 s "Verificando…" → Conectada or Error; pick model radio; Continuar enabled only when connected AND model chosen; Atrás.
- **Navigation.** ← SCR-A · → SCR-C (first run) · → SCR-D (when opened from dashboard: labels become "Guardar y volver al panel" / "Cancelar").
- **Mock states.** Connection: `idle` ("Sin configurar", grey) · `connecting` ("Verificando…", amber pulsing dot, spinner in button, button disabled) · `connected` ("Conectada", green; model card appears) · `failed` ("Error de conexión", red; alert "401 · clave no válida", button "Reintentar verificación"). Typing a new key after a failure returns to `idle`. Artboards: *B-Proveedor-Error*, *B-Proveedor-Conectado*.

### SCR-C · Inicialización del espacio interno
- **Purpose.** HU-002 + HU-003 trigger: show what is being created, confirm success without technical noise, let the user inspect the structure, and register the repository as an explicit authorized action.
- **Main components.** `SetupHeader` + `Stepper` (1 done / 2 active→done / 3 active→done); `PageIntro`; `Card Inicialización` with `InitStepList ×5` (done ✓ / running spinner / pending number, right-side mono meta "local") and footer "Llamadas a modelos de IA durante la inicialización · 0 · todo local"; `Card Repositorio del código fuente` (status chip, explanatory text, `Input` path, `Checkbox` authorization sentence, `Button secondary` Registrar repositorio, "también puedes hacerlo más tarde") → on success `Notice ok`; footer `Atrás` / `Abrir el panel del proyecto`; aside `Card Estructura resultante` = `TreeView` (9 selectable nodes with depth indent, colored square glyph, mono meta) + `DetailPanel` footer showing the selected node's title/body.
- **Interactions.** Steps auto-advance (0.7 s) on entry; tree node click → detail; checkbox enables Registrar; Registrar → chip "Registrado · solo lectura", tree node turns green, toast; Abrir el panel disabled until 5/5 steps done.
- **Navigation.** ← SCR-B · → SCR-D.
- **Mock states.** Steps 0–5 (running/done); repo `pendiente de autorización` / `registrado · solo lectura`. Artboard *C-Inicializacion* shows the completed state with repo pending.

### SCR-D · Panel del proyecto (internal project dashboard)
- **Purpose.** First real operating surface. Answers: which workspace/project is active, what the system builds, who is on the team, whether anything runs, where to configure the team, where requests will go.
- **Main components.** `AppShell` = `Sidebar` (workspace switcher "Portal IA · Espacio interno" (disabled, future), project selector "Desarrollo del Portal · interno", `NavItem ×8` with Panel/Equipo de IA live and Actividad/Solicitudes/Conocimiento/Herramientas y MCP/Presupuestos/Organización marked `próx.`, Proveedores block "Anthropic · conectado", Configuración `próx.`) + `TopBar` (`Breadcrumb` Portal IA / Desarrollo del Portal / Panel, chip "Sin procesos en ejecución", mono chip "hoy · 0 tokens · 0,00 USD", owner avatar). `PageHeader` (eyebrow, H1, chips: Espacio · Portal IA / repo status / 8 agentes · 0 activos; buttons Configurar equipo, Nueva solicitud (disabled)). Main column: `Card Qué construye este proyecto` (paragraph, 3 numbered objectives, 8 architecture chips), `Card Solicitudes de desarrollo` (`EmptyState`, disabled textarea composer, disabled "Enviar al Coordinador del Proyecto", explanatory note). Aside: `Card Equipo del proyecto` (`AgentRow ×5` + "Agentes del espacio" `AgentRow ×3`, footer link Gestionar equipo), `Card Procesos` (`EmptyState` + kv rows Procesos hoy 0 / Tokens 0 / Costo 0,00 USD), `Card Proveedores` (connected provider + default model, button Añadir o revisar proveedores).
- **Interactions.** Any agent row → SCR-F; Configurar equipo / Gestionar equipo / nav Equipo de IA → SCR-E; provider rows → SCR-B (post-setup mode).
- **Navigation.** → SCR-E, SCR-F, SCR-B.
- **Mock states.** Repo chip reflects SCR-C decision. Everything else is a true empty state (no invented analytics).

### SCR-E · Equipo de IA (team management)
- **Purpose.** HU-003: show the eight agents as an organization, distinguishing workspace-level vs project-level, with reporting lines.
- **Main components.** `AppShell`; `PageHeader` (chips 3 del espacio / 5 del proyecto / 0 activos · 8 configurados; buttons Nuevo agente desde plantilla (disabled), Activar equipo (disabled, title explains)); `Notice info` ("configurados pero inactivos…"); `Card Estructura organizativa` with legend chips and `OrgChart`: root `OwnerNode` ("Tú · Propietario del espacio") → Asistente de Empresa, Gestor Organizacional → Agente de Onboarding, Coordinador del Proyecto → Arquitecto, Desarrollador, Diseñador, QA. `OrgNode` = avatar initials (teal tint = workspace, grey = project), scope chip, name, role, footer (inactive dot + model short name). `Card Relaciones y configuración` = `DataTable` (Agente · Rol · Ámbito · Reporta a · Modelo preferido · Esfuerzo · Estado).
- **Interactions.** Any org node or table name → SCR-F for that agent.
- **Navigation.** → SCR-F · ← SCR-D via nav.
- **Mock states.** Table reflects saved agent edits (name, model, effort).

### SCR-F · Detalle y configuración de agente
- **Purpose.** Inspect and edit one agent; demonstrate editable configuration with explicit save/discard; make scope, permissions and authorization requirements visible; make clear the agent is inactive and has never run.
- **Main components.** `AppShell`; `AgentRail` (back to Equipo, grouped `RailItem ×3` + `×5`, active state); `AgentHeader` (large avatar, editable name shown as H1, role, chips: Ámbito / Configurado · Inactivo / template id mono; `Descartar`, `Guardar cambios` — both disabled until dirty); conditional `Notice warn` unsaved changes; `SettingsGrid` (2-col auto-fit) of `Card`s: **Identidad y rol** (Nombre input, Rol disabled "Definido por la plantilla", Especialización textarea) · **Responsabilidades** (numbered list with remove ✕, add input + Añadir) · **Relaciones organizacionales** (Reporta a / Supervisa / Colabora con as navigable chips) · **Ámbito asignado** (kv rows + "Fuera del ámbito · sin acceso", read-only) · **Modelo preferido** (Proveedor select — non-connected disabled "· no conectado"; Modelo select; description) · **Modelos alternativos autorizados** (checkbox list across providers; preferred and non-connected disabled with reason) · **Esfuerzo de razonamiento** (Bajo/Medio/Alto segmented; disabled with note when model lacks it) · **Límites de gasto** (monthly USD, per-task authorization threshold USD) · **Herramientas y permisos** (8 `ToolRow`: switch + name + description + risk chip `local` / `requiere autorización`; warning notice that authorization-gated tools always stop for approval) · **Acceso a conocimiento** (5 checkboxes) · **Criterios de evaluación** (read-only, "edición próximamente") · **Estado** (kv: última actividad ninguna / llamadas 0 / costo 0,00 USD / configuración plantilla sin cambios ↔ editada localmente; `Activar agente` disabled + reason). Footer `Volver al panel`.
- **Interactions.** Every field edits a draft; dirty → notice + buttons enable; Guardar → persists (in-memory), toast "Configuración de … guardada localmente", rail/table/dashboard update; Descartar → drop draft; relation chips navigate to that agent; rail navigates (drops unsaved draft — see H).
- **Navigation.** → other agents (rail/relations) · → SCR-E · → SCR-D.
- **Mock states.** clean / dirty / saved; effort enabled vs disabled (model-dependent); fallback rows enabled / disabled-preferred / disabled-provider-not-connected.

---

## C. Design system

**Direction.** "Instrument panel": warm-neutral ground, ink-black primary actions, one teal accent reserved for selection/active/workspace-scope, status colors only on status. No gradients, no illustrations, no left-border cards. Dense but airy: 14 px base, 18 px card padding, 20 px grid gaps.

### Colors (HEX)
| Token | Value | Use |
|---|---|---|
| `--bg` | `#F4F3EF` | App/canvas ground |
| `--surface` | `#FFFFFF` | Cards, inputs |
| `--surface-2` | `#FAF9F6` | Sidebar, card footers, chips |
| `--surface-3` | `#F7F6F2` | Info notice, hover on secondary |
| `--line` | `#E5E3DC` | Default borders |
| `--line-soft` | `#EEECE6` | Row dividers |
| `--line-strong` | `#CFCCC3` | Input borders, selectable card borders, org connectors |
| `--ink` | `#1A1B1E` | Primary text, primary button bg |
| `--ink-hover` | `#2C2E33` | Primary button hover |
| `--ink-2` | `#4F5259` | Secondary text (6.6:1 on white) |
| `--ink-3` | `#686B72` | Muted text/labels (≥4.7:1 on all surfaces) |
| `--accent` | `#0F6E6A` | Selection, focus ring, links, workspace scope, switches on |
| `--accent-hover` | `#0B5652` | |
| `--accent-soft` | `#E3F1EF` / border `#C6E2DE` / text `#0B5652` | Accent chip, workspace avatar, selected model row `#F3FAF9` |
| **Status · ok** | dot `#22A55B` · bg `#E4F3EA` · border `#C2E3CF` · text `#166534` (notice text `#14532D`) | Connected, registered, completed |
| **Status · warn** | dot `#E39B1C` · bg `#FBF0DC` · border `#F0DCB0` · text `#7A4A00` (notice `#633D00`) | Verifying, pending authorization, "requiere autorización", unsaved |
| **Status · error** | dot `#D93025` · bg `#FBE7E5` · border `#F2C7C3` · text `#9A1F18` (notice `#7F1D16`) | Connection failed, "sin acceso" |
| **Status · running** | dot `#2563EB` · bg `#E6EDFB` · border `#C7D6F5` · text `#1D4ED8` | Reserved for live processes (none in this scope) |
| **Status · inactive** | dot `#B4B7BD` · neutral chip | Inactive agents, no processes |

Rule: ok/warn/error always pair a dot or icon with a text label — never color alone.

### Typography
- UI: **IBM Plex Sans** 400/500/600 (fallback `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, Arial`).
- Code/ids/metrics: **IBM Plex Mono** 400/500 — model ids, template ids, token/cost counters, paths, step numbers.
- Scale: H1 32/1.15 600 (−0.015em) · H1-compact 26–28 · H2 20/1.25 600 · H3 15/1.3 600 · body 14/1.45 · lede 16/1.55 · sm13 13 · small 12/1.4 · eyebrow 12 600 uppercase +0.07em · side-section 11 600 uppercase +0.06em.

### Spacing scale
4 · 6 · 8 · 10 · 12 · 14 · 16 · 18 · 20 · 24 · 28 · 40 · 56 (px). Card padding 18; card header 14×18; page padding 28 (20 on phone); setup page padding 56/40 top/sides; grid/column gaps 20–24; chip gap 6–8; sidebar width 248; agent rail 260–290.

### Border radius
Buttons/inputs 8 · small buttons 7 · cards 10 · nav items 7 · avatars 8 (large 12) · chips/switch 999 · tree squares 3 · provider logo 8.

### Shadows
Default: none (1 px border). Elevated card (welcome preview): `0 1px 2px rgba(26,27,30,.04), 0 12px 32px rgba(26,27,30,.06)`. Org node hover: `0 6px 16px rgba(26,27,30,.08)` + `translateY(-1px)`. Toast: `0 8px 24px rgba(0,0,0,.18)`. Selected provider card: `inset 0 0 0 1px var(--accent)` (2 px effective ring).

### Buttons
`height 40 · padding 0 16 · radius 8 · 14/500`. Variants: **primary** ink bg/white text; **secondary** white bg, `--line-strong` border; **ghost** transparent, `--ink-2` text, hover `#ECEAE4`; **sm** height 32, padding 0 12, 13 px. Disabled: `opacity .42`, `cursor: not-allowed`, keep `title` with the reason. Focus: 2 px accent outline, 2 px offset. Icon-only buttons need `aria-label`.

### Form patterns
Input/select/textarea `height 40 · radius 8 · border --line-strong · focus 2px accent inset ring`; label 13/500 above, help 12 `--ink-3` below; disabled bg `#F7F6F2`. Checkbox/radio 16 px with `accent-color: --accent`. Switch 36×20, thumb 16, on = accent. Segmented control: 1 px border wrapper, 2 px padding, pressed segment ink bg/white text (`aria-pressed`). Selectable cards use `<button aria-pressed>` with a corner check badge.

### Status chips
`height 24 · padding 0 9 · radius 999 · 12/500`, xs variant 20 px/11 px; `soon` variant dashed border; status variants as above; may carry an 8 px dot.

### Navigation styles
Sidebar: `--surface-2` bg, right border; items 36 px, 13.5/500, radius 7, active `#ECEAE4` + ink text, disabled items carry a dashed `próx.` pill. Breadcrumb 13 px `--ink-3`, separators `--line-strong`, current item ink/500. Setup stepper: 24 px numbered circles — active ink, done accent-soft, pending outlined. Agent rail items 13 px with avatar; active = white bg + border.

### Motion
Screen enter `fadeUp .28s ease` (opacity + 4 px); state transitions 150 ms on bg/border/color; pulsing dot (`box-shadow` ring 1.2 s) for in-progress; spinner `.8s linear`; toast 2.4 s.

---

## D. Reusable component inventory (React)

**Layout.** `SetupLayout` (header + centered main, optional aside) · `AppShell` (Sidebar + TopBar + outlet) · `Sidebar` · `WorkspaceSwitcher` · `ProjectSelector` · `NavItem` (icon, label, active, soon) · `TopBar` · `Breadcrumb` · `PageHeader` (eyebrow, title, chips, actions) · `SettingsGrid`.

**Primitives.** `Button` (variant, size, loading) · `IconButton` · `LinkButton` · `Chip` (tone, size, dot) · `StatusDot` (tone, pulse) · `Card` / `CardHeader` / `CardBody` / `CardFooter` · `Notice` (info/ok/warn/error) · `Toast` · `Input` · `PasswordInput` (reveal toggle) · `Textarea` · `Select` · `Checkbox` · `RadioRow` · `Switch` · `SegmentedControl` · `KeyValueRow` · `EmptyState` (icon, title, hint) · `Spinner` · `Avatar` (initials, scope tint) · `Wordmark`.

**Setup.** `Stepper` · `ProviderCard` · `ConnectionStatusChip` · `ModelRadioRow` (cost bars, effort chip) · `CostBars` · `ConnectionTimeline` · `InitStepList` / `InitStepItem` · `RepositoryAuthorizationCard` · `TreeView` / `TreeNode` / `TreeDetailPanel`.

**Team.** `OrgChart` (recursive) · `OrgNode` · `OwnerNode` · `AgentRow` · `AgentRail` / `RailItem` · `TeamTable` (DataTable).

**Agent config.** `AgentHeader` · `UnsavedChangesBar` · `IdentitySection` · `ResponsibilitiesEditor` · `RelationsSection` · `ScopeSection` · `PreferredModelSection` · `FallbackModelsSection` · `ReasoningEffortSection` · `SpendLimitsSection` · `ToolsPermissionsSection` / `ToolRow` · `KnowledgeAccessSection` · `EvaluationCriteriaSection` · `AgentStatusSection`.

**Domain types (TS).** `Provider {id,name,consoleHost,keyHint}` · `ModelInfo {id,name,short,tier:'top'|'mid'|'low',supportsEffort,relativeCost:1|2|3,description}` · `ConnectionState 'idle'|'connecting'|'connected'|'failed'` · `AgentTemplate` (immutable: id, role, scope, template, reportsTo, supervises, collaborates, evaluation, defaults) · `AgentConfig` (editable: name, specialization, responsibilities[], provider, model, fallbacks[], effort, tools{}, knowledge{}, monthlyLimitUsd, perTaskAuthUsd) · `AgentStatus 'inactive'|'active'|'paused'` (only `inactive` in scope) · `RepoRegistration {path, mode:'read-only', registeredAt}`.

---

## E. Interaction map

```
SCR-A ──Conectar proveedor──▶ SCR-B
SCR-B ──Atrás──▶ SCR-A
SCR-B  pickProvider      : provider=X, conn=idle, model=null
SCR-B  verify            : conn=connecting ─(1.6s)─▶ connected | failed
SCR-B  setKey (after fail): conn=idle
SCR-B  pickModel         : model=id  → Continuar enabled iff conn=connected && model
SCR-B ──Continuar──▶ SCR-C   : initStep=0, timer +1 / 0.7s until 5  (first run)
SCR-B ──Guardar y volver──▶ SCR-D                                  (post-setup)
SCR-C  selectTreeNode    : treeNode=id (detail panel)
SCR-C  toggleRepoAuth → registerRepo : repoRegistered=true, toast, tree node ok
SCR-C ──Abrir el panel──▶ SCR-D   (enabled iff initStep≥5)
SCR-C ──Atrás──▶ SCR-B
SCR-D ──Configurar equipo / Gestionar equipo / nav──▶ SCR-E
SCR-D ──agent row──▶ SCR-F(agentId)
SCR-D ──proveedor──▶ SCR-B(post-setup mode)
SCR-E ──org node / table name──▶ SCR-F(agentId)
SCR-F  edit*             : draft={...cfg, patch}; dirty = draft≠saved
SCR-F  save              : saved[agentId]=draft; draft=null; toast
SCR-F  discard           : draft=null
SCR-F ──rail / relation chip──▶ SCR-F(otherId)  (draft dropped)
SCR-F ──Equipo de IA──▶ SCR-E · ──Volver al panel──▶ SCR-D
Derived everywhere: agents' preferred model = tierModel(connectedProvider, template.tier) unless saved.
```

Global invariants shown in the UI at all times post-setup: active workspace + project (sidebar, breadcrumb), "Sin procesos en ejecución", "0 tokens · 0,00 USD", and every agent "Inactivo".

---

## F. Acceptance-criteria coverage

| Requirement | Where | Status |
|---|---|---|
| **HU-001** Provider selection (Anthropic, OpenAI) | SCR-B ProviderCard ×2 + disabled "Otro proveedor" | ✅ |
| API credential entry | SCR-B PasswordInput + reveal | ✅ |
| Connection verification | SCR-B Verificar; 4 states | ✅ (simulated) |
| Available model selection | SCR-B model radio list after connection | ✅ (mock list) |
| Clear status and errors | ConnectionStatusChip, Timeline, error Notice with cause + next step | ✅ |
| Secure credential messaging | Notice "Almacenamiento seguro", assurance on SCR-A | ✅ |
| Add other providers later | Disabled "Otro proveedor" card, aside "Independiente del proveedor", SCR-D "Añadir o revisar proveedores", sidebar Proveedores | ✅ |
| No automatic paid AI operations | "consumo de IA en este paso · 0 tokens" header, "Qué hace la verificación" card, 0-call footer on SCR-C | ✅ |
| Provider-agnostic; subscriptions ≠ API | Help text under key field; adapter copy | ✅ |
| **HU-002** Auto-initialize workspace "Portal IA" + project "Desarrollo del Portal" | SCR-C steps 1–2 | ✅ |
| Persistent internal structures | Step 4 + tree (Conocimiento, Historial, Memoria, SQLite path) | ✅ |
| Objectives + approved context | Step 3; tree nodes; SCR-D card | ✅ |
| Register source repository with explicit authorization | SCR-C card: path + checkbox + button; read-only scope stated | ✅ |
| Separate from future customer workspaces | "aislado" chip, tree detail, "Empresas y clientes · más adelante" on SCR-A | ✅ |
| Avoid unnecessary AI calls | "0 · todo local" counters | ✅ |
| Communicate success without technical detail | Step list + "Espacio interno inicializado"; details only on demand in tree | ✅ |
| **HU-003** 3 workspace + 5 project agents from templates | Step 5; SCR-E org chart; template ids | ✅ |
| Each agent: identity, role, responsibilities, reporting, scope, preferred model, fallbacks, effort, tools/permissions, knowledge, evaluation | SCR-F sections (one card each) | ✅ |
| Creating agents does not invoke models | "sin llamadas a modelos" step copy; Estado card "Llamadas a modelos 0" | ✅ |
| Agents appear configured but inactive | Every surface: grey dot "Inactivo"; Activar disabled with reason | ✅ |
| User can inspect and edit configuration | SCR-F draft/save/discard | ✅ |

**Not (fully) represented visually.**
1. Real backend outcomes of verification (rate limits, network errors other than 401, org/billing not enabled) — only one error shape is drawn; the `Notice error` pattern is meant to carry any `code + cause + next step`.
2. Credential **deletion/rotation** and multiple credentials per provider.
3. The workspace switcher's real menu (companies list) — drawn disabled.
4. Agent **activation** and execution authorization dialogs (next story) — represented only as disabled actions with explanation.
5. Template versioning/upgrade UI — only the template id is shown.
6. Per-process budgets — referenced as "próximamente" in Límites de gasto.
7. Phone layouts exist structurally (flex-wrap, auto-fit grids, hidden stepper <720 px) but were not tuned screen by screen.

---

## G. Implementation guidance (React + TypeScript + Vite)

**Suggested structure (apps/web).**
```
src/
  app/            router (TanStack Router or react-router), AppShell, SetupLayout
  design-system/  tokens.css (section C), primitives (section D)
  features/
    setup/        WelcomePage, ProviderPage, InitializationPage
    dashboard/    ProjectDashboardPage
    team/         TeamPage, OrgChart
    agents/       AgentDetailPage, sections/*
  domain/         types.ts (section D), templates.ts (8 AgentTemplate), catalog (fetched)
  state/          zustand/redux store: setup slice, agents slice, workspace slice
  api/            typed client to the Fastify backend (see below)
```

**Translating the prototype.** The `<helmet><style>` block becomes `tokens.css` + component CSS (or CSS modules / vanilla-extract). Each `<sc-if value="{{x}}">` is `{x && …}`; each `<sc-for list as>` is `.map`; `{{a.b}}` holes are props; `onClick="{{fn}}"` are handlers from the store. `renderVals()` is the selector layer: everything derived (chip classes, labels, disabled flags) should become small pure selectors/helpers, not component state. Prototype data constants `CATALOG`, `PROVIDERS`, `TOOLS`, `KNOWLEDGE`, `AGENTS`, `INIT_STEPS` are the seed for `domain/`.

**UI-only behavior (stays in the frontend).** Screen routing; draft/dirty/discard for agent config; selected tree node; password reveal; stepper classes; chip/label derivation; toast; form validation (non-empty key, numeric limits); disabled-state reasons; responsive layout.

**Future backend operations (Fastify, local).** Replace the timers with these calls, keeping the same UI states:
- `POST /providers/:id/credential` → stores encrypted secret (never returned); `POST /providers/:id/verify` → `{ok, models[]} | {ok:false, code, message}` (drives `connecting → connected|failed`; the `models[]` response replaces `CATALOG`).
- `PUT /workspace/default-model`.
- `POST /bootstrap/internal-workspace` → streams/polls step progress `{step, status}` (drives `InitStepList`); idempotent; creates workspace DB `data/workspaces/portal-ia/*.sqlite`, project, objectives, approved context, knowledge/history tables, and the 8 agents from templates with `status: 'inactive'`.
- `POST /projects/:id/repository` `{path, mode:'read-only', authorized:true}` → validates path exists / is a git repo.
- `GET /workspaces/:id/agents`, `GET /agents/:id`, `PATCH /agents/:id/config` (whole `AgentConfig`), `GET /templates`.
- `GET /processes?status=running` and `GET /usage/today` for the top-bar chips (currently constants 0).
- Model/effort capability flags (`supportsEffort`, relative cost) must come from the provider adapter, not the UI.

**Future security-sensitive operations (must be designed with explicit authorization, not implied by this UI).** Credential storage/encryption at rest (OS keychain or encrypted SQLite column; never in renderer memory longer than needed; never logged); credential transmission only from the backend adapter to the provider; repository registration (path validation, read-only mount into sandbox); any tool flagged `requiere autorización` (repo write, sandbox exec, tests, dependency install, network) → execution-authorization flow with per-use approval and budget check; agent activation; spend limits enforcement server-side; secret redaction in execution history/knowledge.

**Do not carry over.** Simulation toggle, prototype badge, mock model lists, timers, in-memory `saved` map, hard-coded "0 tokens" strings.

---

## H. Assumptions and pending decisions

**Assumptions made.**
1. Verification = one "list models" call against the provider; UI copy states this. If the adapter needs a tiny completion call instead, update the "Qué hace la verificación" card.
2. Model names/ids in the prototype (Claude Sonnet 4.5 / Opus 4.1 / Haiku 4.5; GPT-5 / GPT-4.1 / GPT-5 mini) are placeholders for the adapter's live list; relative cost (1–3 bars) and "razonamiento ajustable" are adapter-provided flags.
3. Default preferred model per agent is derived from a template **tier** (`top|mid|low`) mapped onto the connected provider's list, so templates remain provider-agnostic.
4. Reporting lines: Asistente de Empresa and Gestor Organizacional report to the owner; Agente de Onboarding and Coordinador del Proyecto report to the Gestor; the four specialists report to the Coordinador.
5. Repository registration is optional during bootstrap and read-only; write/exec are per-agent tools gated by authorization.
6. Spend limits are modeled as monthly USD + a per-task threshold above which authorization is required; both editable per agent.
7. Internal workspace storage shown as one SQLite file per workspace (`portal-ia.sqlite`), matching "SQLite isolated by company".
8. Owner identity is shown as a generic avatar ("Propietario del espacio"); no user profile in scope.
9. Navigating away from an agent with unsaved changes silently discards the draft in the prototype; the product should confirm.

**Decisions worth confirming (only these).**
1. Should the **default workspace model** chosen in HU-001 be automatically applied to all agents, or only to those whose template tier matches it (current prototype: tier mapping, so Arquitecto/Coordinador/Gestor get the top-tier model even if the user picked a mid-tier default)?
2. Is repository registration **required** before the team can ever be activated, or truly optional (current: optional, re-offered on the dashboard)?
3. Reasoning effort levels: fixed three (Bajo/Medio/Alto) or provider-specific enumerations surfaced by the adapter?
4. Should **Esfuerzo**, **Límites** and **Herramientas** be editable while an agent is inactive only, or also live (affects whether SCR-F needs a "changes apply on next task" notice later)?
