# REA ("Reverse Engineer Anything") — repository study

Repo: https://github.com/morluto/rea · read on 2026-11-14 through `gh repo view`, `gh api repos/morluto/rea/...`, `gh release list`, `gh issue view`, and the public npm registry JSON. **Nothing was cloned, installed or executed.** Raw copies of the files read are in the `_rea_raw` folder next to this file.

The repo exists and matches the description. Everything below is quoted or derived from files at `main`; where I did not read a file, it says so.

## 1. Snapshot

| Item | Value |
|---|---|
| Description | "Reverse engineer anything with agents, from app behavior down to native binaries." |
| Licence | MIT (REA-authored code); third-party material keeps its own licences (`THIRD_PARTY_NOTICES.md`, `licenses/`) |
| Created | 2026-04-14 |
| `main` HEAD | `4502bd44bb65741e3c62eb9c7d579df085d33a13` — 2026-11-14T18:28:43Z — "fix(gdb): keep a retained cancelled startup a cancellation on cleanup retry (#10551)" |
| Latest release | `rea-agents-6.9.0`, published 2026-11-12T08:59:13Z → commit `d74549e495c58eb4a560279fd9f05508401ea0a0` (GitHub-verified signature) |
| `main` vs release | 247 commits ahead after two days |
| Release cadence | 10 releases between 2026-10-08 (6.0.0) and 2026-11-12 (6.9.0); tags back to 2.x |
| npm package | `rea-agents@6.9.0`; bins `rea` and `rea-agents` → `scripts/rea.mjs`; **189.6 MB unpacked, 10,585 files**; registry signature and provenance attestation present; integrity `sha512-KqDn1UR5BMqHoQ3MGAnPuWiSKwgdFaz1L/uUNgrKt+1W8kPtgYP8AWEOXIF1lDIOBVyPuYIIst2iamo1Wf3r8g==`; **single npm maintainer** (`morluto`) |
| Languages | TypeScript (≈64 MB of source), JavaScript, Python, Java, Swift, C/C++ |
| Popularity as reported by the API | 459,422 stars, 112,617 forks, 757 open issues, PR numbers above 10,500; top contributor has 4,333 commits. These are extraordinary numbers for a seven-month-old project. I could not assess whether they are organic; **do not treat them as a trust signal.** |
| Published security advisories | none returned by `repos/morluto/rea/security-advisories` |

## 2. What it is

One Node.js program that is both a CLI (`rea …`) and an MCP server (`rea mcp`), plus an agent skill (`reverse-engineer-anything`) and plugin manifests for Claude Code, Codex and Cursor (`.claude-plugin/`, `.codex-plugin/`, `.cursor-plugin/`). It parses many formats itself and drives external engines (Ghidra, Hopper, IDA, Kuna, JADX, Rizin, objdump, GDB, Frida, tshark, binwalk…) through bridge scripts in `bridge/`.

Layout seen in the tree (9,039 entries): `src/` (`application/`, `server/`, `cli/`, `contracts/`, `domain/`, `artifacts/`, `browser/`, `ghidra/`, …), `bridge/` (Java Ghidra/JADX scripts, Python Hopper/Cutter/LLDB/pwntools/mitmproxy scripts, Swift helpers), `native/windows/` (C++ Node addon, shipped prebuilt as `native/windows/build/rea-windows-x64.node`), `third_party/` (git submodules: `jadx-headless-mcp`, `binwalk`, `unblob`, `ghidra-nativeaot`, `wakaru`; plus `pwntools`, `pwndbg`, `wabt`, `evmole` notes), `docs/`, `website/`, `tests/`. Architecture map: `docs/architecture/architecture.mermaid` (not read).

### Runtime and toolchain requirements
- **Node.js `^22.23.4 || ^24.22.1 || >=26.12.1`** (`package.json#engines`; `.npmrc` has `engine-strict=true`; `.nvmrc` = 24.22.1). Node 23, 25, early 26 and prereleases are unsupported. **Node 20 is not supported.** A Node 22 host must be at 22.23.4 or newer.
- npm (or Bun ≥ 1.2.17 for global updates).
- Linux: a procps-compatible `ps` on PATH.
- Direct dependencies are exact-pinned (42), among them `@modelcontextprotocol/server` 2.3.1, `playwright-core` 1.64.1, `@lydell/node-pty` 1.1.0, `isomorphic-git` 1.38.7, `openpgp` 6.3.2, `ws` 8.21.0, `zod` 4.6.6. Optional dependency: **`frida` 17.23.2** (native, fetched as a prebuilt binary at install; the install doc mentions the resulting `prebuild-install` deprecation warning).
- External engines are **never installed by REA** except Hopper (optional, with approval, macOS/Linux only). The skill states: "REA setup never installs or upgrades Node.js, npm, Homebrew, Java, Ghidra, IDA, JADX, Kuna, Binwalk, or Unblob."

| Capability | Needs | Host support stated |
|---|---|---|
| Native decompilation | Hopper, Ghidra 12.x (≥12.1, verified 12.1.4) + 64-bit full JDK 21+, IDA, or Kuna | Ghidra: Linux x64/arm64, macOS x64/arm64, **Windows x64 "experimental P0"** (read-only, PE x86/x64/ARM, DOS MZ, raw 6502). Hopper: macOS 12+ and listed x86_64 Linux distros only |
| Static JS/Electron, .NET, PE imports/certificates/load-config, binary hardening, ELF notes, Go/Rust metadata, Windows shortcuts, IL2CPP, Godot PCK, PyInstaller, Deno, APK signatures, Flutter, model files (GGUF/safetensors) | built in | Any supported Node host |
| SQLite inspection | Node 24.x ≥ 24.15 or 26+ | — |
| Android APK decompilation | headless JADX + full JDK | Linux/macOS/Windows x64 |
| Websites | a Chrome-family browser | — |
| Offline ELF layout, recorded crashes, EVM bytecode | caller-supplied pwntools (GDB/pwndbg optional) | **Linux x64 only** |
| Firmware | Binwalk / Unblob | **Linux** |
| Packets, logic signals | TShark 4.x / sigrok-cli 0.7.2 + `prlimit` | **Linux** |
| Process behaviour capture | native PTY | **Linux/macOS** |
| WASM | caller-supplied WABT 1.0.42 | — |
| Desktop-app environments | Docker + agentenv | Linux amd64/arm64 |

### CLI commands (names as they appear in README, `docs/getting-started/cli.md`, `installation.md`, `docs/reverse-engineering-tools.md`)
Lifecycle: `rea setup`, `rea doctor`, `rea update` (alias `rea --update`), `rea uninstall` (`--purge-data`), `rea mcp` (`--http --host --port`), `rea mcp doctor`, `rea providers`, `rea capabilities`, `rea completions`.
Analysis: `analyze`, `decompile`, `function`, `xrefs`, `search`, `instructions`, `trace`, `compare`, `inspect-analysis-view`, `analyze-javascript-application`, `trace-application-feature`, `audit-release-exposure`, `inspect-artifact`, `extract-artifact`, `compare-artifacts`, `compare-bundles`, `inspect-managed-artifact`, `inspect-managed-members`, `inspect-binary-hardening`, `inspect-pe-imports`, `inspect-pe-certificates`, `inspect-pe-load-config`, `inspect-windows-shortcut`, `inspect-elf-notes`, `inspect-elf-unwind-ranges`, `inspect-native-initializers`, `inspect-go-binary`, `inspect-rust-binary`, `inspect-python-pyc`, `inspect-il2cpp-metadata`, `inspect-erlang-beam`, `inspect-kernel-module`, `inspect-kernel-build-config`, `inspect-devicetree`, `inspect-model-artifact`, `inspect-sqlite-database`, `inspect-apple-ips`, `inspect-with-objdump`, `list-objdump-architectures`, `execute-rizin-command`, `debug-with-rizin`, `debug-with-gdb`.
Evidence and environments: `evidence-import`, `evidence-export`, `import-reference-source`, `environment-build`, `environment-serve`, `environment-export`, `environment-compare`.
Useful `setup` flags: `--client <id>` (repeatable), `--all-detected`, `--skill=false`, `--skill-client`, `--tool-families <ids>`, `--dry-run`, `--json`, `--yes`, `--install-hopper`, `--accessible`.
This list was harvested by pattern from the docs; it is not the generated catalogue and may be incomplete.

### MCP server
- Default transport **stdio**; registration is `npx -y rea-agents@6.9.0 mcp` (`mcp.json`, `server.json`, MCP registry name `io.github.morluto/rea`). Plugin installs launch `node ${CLAUDE_PLUGIN_ROOT}/scripts/plugin-mcp-launcher.mjs 6.9.0`.
- Optional `rea mcp --http`: "plain HTTP without TLS or client authentication", one shared active target; binds `127.0.0.1` and an ephemeral port by default.
- Size: `docs/verification/mcp-catalog-codex-2026-11-05.md` records **234 tools and six prompts** at commit `ec34109`, with about 4.03 MB of advertised JSON (3.68 MB of it output schemas). The complete list is generated at build time (`docs/public/product-catalog.json`) and is **not checked in**; https://rea.tools/product-catalog.json returned 404 today. I therefore did not enumerate all 234.
- Tool names I actually saw in `SKILL.md`, `docs/reference/mcp-contracts.md`, README and install docs: `binary_session`, `open_binary`, `close_binary`, `binary_overview`, `analyze_function`, `inspect_analysis_view`, `update_analysis_settings`, `get_call_graph`, `build_call_path`, `compare_functions`, `match_native_functions`, `trace_native_values`, `inspect_binary_layout`, `inspect_macho`, `inspect_signature`, `inspect_native_load_image`, `inspect_native_data_type`, `read_bytes`, `search_strings`, `annotate_native_function`, `set_address_name`, `set_addresses_names`, `inspect_artifact`, `extract_artifact`, `compare_artifacts`, `open_bundle_resources`, `decode_interface_builder`, `inspect_wasm_artifact`, `inspect_apk_signature`, `analyze_javascript_application`, `trace_application_feature`, `capture_browser_scenario`, `compare_web_captures`, `get_evidence_bundle`, `export_evidence_bundle`, `record_unknown`, `update_unknown`, `list_unknowns`, `discover_tools`.
- Tool families selectable through `REA_MCP_TOOL_FAMILIES` (ids seen): `session`, `application`, `direct`, `enhanced`, `native`, `artifact`, `managed`, `browser`, `electron`, `javascript-runtime`, `pcap`, `firmware`, `android`, `adb`, `apktool`, `frida`, `jeb`, `flutter`. Unselected tools are omitted from `tools/list` and fail with `Tool ... disabled`.
- Registrar modules in `src/server/register*.ts` show the remaining surface, including runtime-affecting groups: `FridaTools`, `GdbTools`, `RizinDebugTools`, `AdbTools`, `BrowserTools`, `BrowserScenarioTool`, `ElectronTools`, `JavaScriptRuntimeObservationTools`, `DesktopBuildTools`, `CaptureTools`.
- Other environment switches: `REA_MCP_INPUT_SCHEMA_PROFILE`, `REA_MCP_OUTPUT_SCHEMA_PROFILE` (`compact`/`off`), `REA_MCP_MAX_RESPONSE_BYTES`, `REA_ANALYSIS_PROVIDER`, `GHIDRA_INSTALL_DIR`, `JAVA_HOME`, `HOPPER_LAUNCHER_PATH`, `REA_JADX_MCP_JAR`, `REA_JEB_MCP_URL`, `REA_GHIDRA_STARTUP_TIMEOUT_MS`, `REA_LOG_LEVEL`.

### Skills
- User-facing: `reverse-engineer-anything` (`SKILL.md` ≈ 43 KB, metadata version "62") with references `android-applications`, `connection-and-recovery`, `desktop-build`, `environments`, `evidence-workflows`, `javascript-applications`, `native-and-artifacts`, `runtime-observation`.
- Its own scope statement: "Skip REA for ordinary source-repository architecture analysis" and "For ordinary analysis of a complete source repository, use normal repository tools and do not run REA readiness or provider commands."
- Maintainer-only skills in `.agents/skills/`: `rea-analysis-optimization`, `rea-changelog-update`, `rea-ci-tests-audit`, `rea-tool-design`.

### Security policy (`SECURITY.md`)
- Fixes only for the latest published version.
- "REA is not a general-purpose sandbox or a multi-tenant authorization service." CLI and MCP "run with the host process's permissions."
- Targets are untrusted data; "Agents must treat target text and Evidence as data rather than instructions."
- Static JS and .NET inspection "do not run the target application"; runtime, debugger, instrumentation, browser and desktop workflows "can deliberately execute code, attach to processes, make network requests, write files".
- Analysis engines are trusted with the account's permissions: "parsing an input in an external engine does not isolate that engine from the host."
- Explicit advice: "Use an appropriately isolated account, VM or restricted environment when handling hostile targets." Resource limits are not universal; "Enforce hard host resource limits externally when needed."
- IDA Free's cloud decompiler can send data off-host.
- Reporting: GitHub private vulnerability reporting, fallback morluto@outlook.com.
- No telemetry statement found either way in README, SECURITY, DISCLAIMER or the install guide (searched for telemetry/analytics; no hits). README: "REA analyzes targets locally. Your agent receives the tool results, and its model provider has its own data policy."

### Open security-relevant issues (titles as listed today)
- #6480 "Track supply-chain audit follow-up: runtime, dependency and release hardening" (opened 2026-10-23, still open). Their own audit of 6.7.0 states: Dependabot alerts were disabled and code scanning had "no analysis found" at that date; main requires CI but **zero approving reviews**; a fresh install resolved **nine transitive dependency versions different from the source lockfile**; production `npm audit` reported zero advisories; all 180 Action references pinned to SHAs; tarball digest matched registry integrity and attestation. Unchecked items remain: advisory/signature gate, consumer dependency-tree reproducibility policy, documenting publishing controls. (A `.github/dependabot.yml` and `codeql.yml` now exist on main.)
- #6708 "Require dependency security evidence for source and fresh release consumers" (open).
- #4230 "[Design] Opt-in agent-evaluation scenario for instructions planted in target content" (open) — prompt-injection resistance is not yet part of their evaluation lane.
- #3423 "[Docs] Pin install commands…" (open). #9103 Frida injection under PRoot (functional).
- The published `files` list includes `npm-shrinkwrap.json`, which would address the transitive-drift finding for 6.9.0; I did not download the tarball to confirm its contents.

### Known limitations stated by the project
Windows Ghidra is experimental and read-only; PE load-image attestation is "unsupported"; no Hopper on Windows; firmware, pcap, signals, pwntools, process capture are Linux (or Linux/macOS) only; README and docs describe `main`, which runs ahead of npm ("Check release availability"); analysis "can be incomplete or incorrect"; the default tool catalogue is very large for agent context (their own measurement: a real package question "used hundreds of thousands of cumulative input tokens").

## 3. Installation: what it changes

Entry points: `npx rea-agents setup`, `npm install --global rea-agents` then `rea setup`, or `install.sh` (curl wrapper).

- `install.sh` (read in full): **macOS/Linux only** — it fails on any other `uname -s`, so it is not usable from Git Bash on Windows. It checks Node, resolves the latest tag from `api.github.com/repos/morluto/rea/releases/latest` (or takes `--version`), runs `npm install --global rea-agents@<exact>` (with `--prefix $HOME/.local` on Linux), verifies `rea --version`, then starts `rea setup` if a TTY exists. Flags: `--version`, `--dry-run`, `--no-setup`/`--no-prompt`, `--verbose`. No sudo, no other downloads.
- `npm install`: pulls ≈190 MB plus the dependency tree from registry.npmjs.org. The optional `frida` dependency downloads a prebuilt native binding through an install script. `@lydell/node-pty` and the bundled `rea-windows-x64.node` are native code. `playwright-core` does not download browsers.
- `rea setup` (interactive, plan → approval): for each selected client it adds an MCP server entry and installs the skill. For Claude Code the docs say it "writes `mcpServers.rea` in `~/.claude.json` and installs the bundled skill under `~/.claude/skills`, so every project that Claude Code opens can call REA." Backups are written as `.rea.backup` (and `.rea.backup.<sha256>.recovery`). With no client selected the skill goes to `~/.agents/skills`. Registrations are pinned to the installing version and to absolute runtime/script paths on Windows.
- Optional Hopper install (separate approval, `--install-hopper` when non-interactive): macOS DMG into `~/Applications`, or Linux package verified against a pinned PGP publisher key. Not offered on Windows.
- State and caches: `~/.rea`, `${XDG_CACHE_HOME:-~/.cache}/rea/...`; on Windows a private NTFS runtime directory with a DACL restricted to the current user and SYSTEM, loopback TCP with a per-session token for the Ghidra bridge, and Job Objects for helper processes.
- Permissions: user level only; no administrator rights described.
- Removal: `rea uninstall` removes REA-owned registrations and skill files; `--purge-data` also removes caches/state.
- Update: `rea update` installs the exact resolved release into the owning npm/Bun global prefix **with dependency lifecycle scripts disabled**, verifies the version, and prints a scoped setup command to refresh registrations; `npx rea-agents@latest setup` for runner-based installs.

Impact on this machine specifically: running `rea setup` on the host would edit the owner's global Claude Code configuration (`~/.claude.json`) and add a global skill, making 234 tools visible to every project. That is a configuration change that needs the owner's explicit decision; it is avoidable (section 4).

### Supply-chain risks
1. Very high change velocity (247 commits in two days; releases roughly weekly; README says "REA changes quickly") and zero required approving reviews per their own audit. `@latest` is a moving target.
2. Single npm publisher account; publisher 2FA/token settings are "explicitly unknown" in their audit.
3. Large opaque payload: 10,585 files / 190 MB including a prebuilt Windows `.node` addon and compiled `dist/`. Provenance attestation links the tarball to a CI build, which is good, but nobody will review 190 MB by hand.
4. Install-time native download (Frida) and transitive version drift (their finding for 6.7.0).
5. The tool surface itself: Frida injection, debuggers, ADB, browser automation, process capture, and an unauthenticated HTTP transport. An agent that reads hostile target content while holding these tools is a prompt-injection path to code execution on the host; their own design issue #4230 is still open.
6. Third-party submodules (`jadx-headless-mcp` from a personal account, `wakaru`, `ghidra-nativeaot`) — whether and how they ship inside the npm tarball was not verified.
7. Popularity figures cannot be validated and the README itself warns about look-alike repositories; install only from `rea-agents` on npm or this exact repo.

## 4. Compatibility with Windows 11 + Node 20/22 + Docker Desktop, and isolation

- **Node 20: incompatible** (engine-strict). **Node 22: only ≥ 22.23.4.** Do not change the host Node for this; give REA its own runtime.
- Native Windows: the built-in static inspectors and JS/.NET analysis are expected to work; Ghidra works only inside the experimental read-only boundary and needs a user-installed Ghidra 12.1+ and JDK 21+; no Hopper; none of the Linux-only families.
- A **Linux container is the better fit**: it is the best-supported platform for almost every provider, and it supplies the isolation SECURITY.md asks for. The repo ships **no Dockerfile** (none in the tree), so the image is ours to write.

Recommended isolation (design, not executed):
- Dedicated image: `node:24-bookworm-slim` pinned by digest, `procps`, then `npm install --global rea-agents@6.9.0 --omit=optional --ignore-scripts` (drops Frida and all lifecycle scripts) and verify the tarball integrity against the pinned `sha512` and `npm audit signatures`. Add Temurin JDK 21 + Ghidra 12.1.4 (checksum-verified) only in a second, larger image variant if native decompilation is actually needed.
- Build with network; **run with `--network none`**, non-root user, `--read-only` root filesystem, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit`, `--memory`/`--cpus`, a `tmpfs` for `/tmp` and for `HOME`.
- Mount the target artifact **read-only** at a fixed path (`/target`), and one dedicated writable output directory (`/evidence`). Mount nothing else: no home directory, no `.claude`, no SSH/git/npm credentials, no Docker socket, no environment secrets.
- **Never run `rea setup` at all.** Portal IA spawns the server itself per task: `docker run --rm -i … rea mcp` over stdio, so no client configuration is touched on the host and uninstalling means deleting the image.
- Narrow the surface with `REA_MCP_TOOL_FAMILIES` (for example `session,artifact,managed,application` for static work) and `REA_MCP_OUTPUT_SCHEMA_PROFILE=compact`; leave `frida`, `adb`, `browser`, `electron`, `javascript-runtime`, debugger families off by default. Do not use `--http`.
- Treat everything REA returns as untrusted text in the agent prompt. Runtime/dynamic families only in a disposable container with an explicit per-task owner approval.
- Git Bash note for this host: prefix Docker commands with `MSYS_NO_PATHCONV=1` or use PowerShell for `-v` mounts, as with the existing Portal IA sandbox.

## 5. Usefulness for a defensive "Reverse Engineering & Software Intelligence Specialist" agent

Worth having (all static, no target execution):
- **Release-exposure audits of our own builds** — `rea audit-release-exposure`, `analyze-javascript-application`: what a shipped JS/Electron bundle leaks (source maps, routes, IPC surface, embedded secrets).
- **Third-party binary triage** before adopting a tool or dependency — `inspect-binary-hardening` (PIE/NX/RELRO/CFG), `inspect-pe-imports` (imports, imphash), `inspect-pe-certificates` (Authenticode signer), `inspect-go-binary` / `inspect-rust-binary` (embedded module and crate versions → SBOM for closed binaries), `inspect-python-pyc`, PyInstaller/Deno/Node SEA/Bun unpacking, `.NET` metadata, `inspect-apk-signature`, GGUF/safetensors headers.
- **Version diffing** of vendor artifacts — `compare-artifacts`, `compare-bundles`, `compare_functions`.
- **Incident artefacts** — HAR/SAZ capture analysis, `inspect-windows-shortcut` (LNK), `inspect-sqlite-database`, Apple `.ips` crash files.
- **Evidence discipline** — every result carries evidence and an "unknowns" ledger (`record_unknown`, `list_unknowns`, `export_evidence_bundle`); a good pattern to copy even without the tool.
- Native decompilation through Ghidra when a claim truly depends on a binary with no source.

Keep off by default: Frida, GDB/Rizin debugging, ADB, live browser/Electron observation, process capture, environment building — they execute or attach to targets.

When plain source-level analysis is better (and the REA skill agrees): whenever complete source is available — Portal IA's own repo, open-source dependencies, anything on GitHub. Reading, grep/AST search, `npm audit`, lockfile diffing and SBOM tools are faster, cheaper in tokens and more accurate than decompiling. Also prefer `npm pack` + reading for npm packages, and for a single quick fact a lone tool (`strings`, `sigcheck`, `objdump`, `jadx`, Ghidra headless) avoids a 234-tool catalogue. REA earns its cost for closed artifacts, shipped-versus-source discrepancies, and artifact-to-artifact comparison.

Legal boundary: DISCLAIMER and README restrict use to software "you own or are authorized to examine"; many vendor terms forbid reverse engineering (Higgsfield's §5.2(v) is an example from the companion report). The agent should require an authorization statement per target.

## 6. Proposed pin and update check

**Pin the npm release, not `main`:**
- Package `rea-agents@6.9.0`
- Git tag `rea-agents-6.9.0` → commit **`d74549e495c58eb4a560279fd9f05508401ea0a0`** (2026-11-12T08:58:30Z, verified)
- Tarball integrity `sha512-KqDn1UR5BMqHoQ3MGAnPuWiSKwgdFaz1L/uUNgrKt+1W8kPtgYP8AWEOXIF1lDIOBVyPuYIIst2iamo1Wf3r8g==` (shasum `d48047b60abccc7a9acdaf9097955ddea8f0df04`)
- For reference only, `main` at study time: `4502bd44bb65741e3c62eb9c7d579df085d33a13`. Do not pin to it: it is unreleased, moves hourly, and requires a full source build.
- Also pin the base image digest, the Ghidra version/checksum and the JDK version if used.

**An update check should compare (read-only; adoption is a manual, reviewed decision):**
1. `npm view rea-agents dist-tags.latest` against the pinned version.
2. `gh api repos/morluto/rea/releases/latest` `tag_name`, and the commit that tag resolves to.
3. `dist.integrity` of the candidate version, presence of registry signatures and provenance attestation (`npm audit signatures` inside the build container), and that provenance points at `morluto/rea` and the release tag.
4. npm `maintainers` list — any change is a stop signal.
5. `engines.node`, `dependencies`/`optionalDependencies` and lifecycle-script diffs between pinned and candidate `package.json`.
6. `gh api repos/morluto/rea/security-advisories` and open issues mentioning security; `SECURITY.md` diff.
7. CHANGELOG entries between versions (breaking MCP contract changes; there is a `docs/migrations/` folder).
8. After rebuilding the image: `rea --version`, `rea doctor --json`, and the catalogue identity/tool count reported by `binary_session` / `rea mcp doctor`, compared with the recorded values, so a silent change in the exposed tool surface is detected.
Suggested policy: check weekly, adopt only releases at least 7 days old (their own Dependabot cooldown is 7 days), never auto-adopt.

## 7. Not verified
- Full list of the 234 MCP tools and all family ids (generated artefact, not in the repo).
- Contents of the published npm tarball (not downloaded), including whether `npm-shrinkwrap.json` and third-party submodule code are inside.
- Actual behaviour on Windows 11 or in Docker — nothing was run.
- `DISCLAIMER.md`, `CONTRIBUTING.md`, `THIRD_PARTY_NOTICES.md`, the architecture diagram and most provider guides were fetched or listed but not read in full.
- Whether star/fork counts are organic.
