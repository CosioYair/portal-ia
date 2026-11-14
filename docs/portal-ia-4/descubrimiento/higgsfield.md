# Higgsfield capability analysis (for an independent Portal IA video studio)

Access date for every URL below: 2026-11-14. Read-only research; no sign-up, no login, nothing installed.
Pages were read through an HTML-to-text fetcher, so anything rendered only as images or behind login (the editor UI itself, the pricing cards) was NOT seen. Those gaps are marked.

Legend: **[V]** verified on a first-party page · **[M]** first-party marketing claim (stated by the vendor, not independently checkable) · **[3P]** third-party source only · **[?]** could not verify.

## 1. What Higgsfield is today

- [M] "AI-native creative suite" for images, video and voice; claims 40M+ users, 35+ models, founded 2023, San Francisco. https://higgsfield.ai/
- [V] It is mostly an **aggregator/orchestrator of third-party generative models** plus a few own-brand ones. Models named on its pages: Kling 2.6/3.0/3.0 Omni Edit/4.0/o1, Seedance 2.0/2.5, Wan 2.6/2.7/3.0, Veo 3.1, MiniMax H3, Grok Imagine, FLUX 3 Video Edit, LTX 2.5, Nano Banana Pro, Seedream 5.5, GPT Image 2; own-brand: Cinema Studio 4.0, Genjutsu, Soul, "Miracle" (marked "Soon"). https://higgsfield.ai/ai-video , https://higgsfield.ai/ai-video-editor , https://open.higgsfield.ai/
- [V] The "AI video editor" page describes a **three-step generative flow** (upload clip → pick model/tool and describe the edit → generate, review, download). It does **not** describe a timeline, trimming, cuts, or captions. So the "editor" is prompt-driven video-to-video, not an NLE. https://higgsfield.ai/ai-video-editor
- [V] Billing is per-generation credits; the credit cost is shown on the Generate button before running; new accounts get 10 free credits. Plan prices: [?] (pricing page renders as images; a "Black Friday 60% off" banner was live). https://higgsfield.ai/pricing

## 2. Capability map

"Local" = implementable on the user's machine with open tooling and no paid API. "External" = needs a generative model, realistically via a provider API (or a very large local GPU model). "N/R" = not reproducible by us (proprietary model/preset library).

| Higgsfield feature (as named) | Class | Local with open tooling? | Notes for our design |
|---|---|---|---|
| Timeline, trim, split, concat, crop, speed, transitions-as-cuts | Conventional editing | **Local** (FFmpeg filtergraph for render; WebCodecs + Canvas for preview; WebAudio for mix) | Higgsfield does **not** offer this [V]. This is where an independent studio can differentiate. |
| AI Auto Reframe (16:9 ↔ 9:16 ↔ 1:1) | AI-assisted editing | **Local, partially**: static/centre crop with FFmpeg is trivial; subject-aware crop needs a detector (MediaPipe / ONNX face-person model) + smoothed crop path | Generative outpainting variant = External |
| Personal Clipper (YouTube highlight → social clip) | AI-assisted editing | **Local, partially**: Whisper-class STT + an LLM to pick highlights + FFmpeg cut + burned captions | Needs our LLM provider for selection; downloading third-party video has its own ToS issues |
| Captions / subtitles | AI-assisted editing | **Local** (whisper.cpp / faster-whisper → SRT/ASS → FFmpeg `subtitles` filter) | Not listed by Higgsfield on the pages read |
| Text-to-video (Kling, Seedance, Wan, Veo, MiniMax, Grok, LTX) | Text-to-video | **External**. Open weights (Wan, LTX) exist but need a high-VRAM GPU; not a default for a Windows dev box | Provider adapter |
| Image-to-video; first/last-frame control; reference images | Image-to-video | **External** | Provider adapter; capability flags per model |
| Video reference / motion transfer; Genjutsu "Object Swap", "Motion Transfer"; Recast; Video Face Swap | Video-to-video | **External**; Genjutsu itself **N/R** (Higgsfield exclusive) | Face/character swap carries consent and deepfake-policy obligations |
| Prompt edits on existing clips (Kling Omni Edit, FLUX 3 Video Edit, Seedance 2.5 Edit "Draw to Edit", Grok Imagine Edit); AI Style Transfer | Prompt-based editing | **External** | "Draw to Edit" = user-drawn mask + prompt; mask UI is local (Canvas), inference is external |
| AI Background Swap; AI Video Background Remover | Background replacement | **Local, partially**: matting with open models (RVM / MODNet / BiRefNet via ONNX Runtime) + FFmpeg alpha overlay. Generative new background = External | fal lists "Video Background Removal" at $0.008 per 30 frames as a cheap external option [V] https://fal.ai/pricing |
| AI Object Removal (prompt, no manual mask) | Object removal | **Local, limited**: SAM2-class segmentation + video inpainting (ProPainter) works on short/simple shots, GPU-heavy. Prompt-only quality tier = External | Offer as External first |
| Camera controls, "Director's Panel" (genre, camera, lens, lighting, palette), optical stack presets, Angles, Shots, Bullet Time, 3D Rotation | Camera & motion controls | The **UI is local** (structured fields → prompt/parameter compilation); the **effect is External**. Real 2D Ken-Burns pan/zoom on stills is Local (FFmpeg `zoompan`) | Higgsfield's preset library and tuned prompts are **N/R**; we write our own vocabulary |
| Effects/templates (Cloud Surf, Mukbang, On Fire, Plushies, Truck Ad, Billboard Ad, …), Shorts Studio "Recreate" | AI effects | **External**; the specific presets **N/R** | A "template = saved prompt + reference slots + model settings" data model is generic |
| Transitions (AI-generated in-between) | AI effects | Classic transitions **Local** (FFmpeg `xfade`, ~40 built-in types); generative morph = External (first/last-frame mode of a provider) | |
| AI Video Extender (forward/backward) | AI effects / video-to-video | **External** | |
| Native synchronized audio in generation (Seedance, Kling 3.0, Veo 3.1) | Audio & voice | **External** (property of the model) | Expose as a model capability flag |
| AI Lipsync (Lipsync Studio); AI Dubbing / Translate (18 languages) | Audio & voice | **Local, partially**: STT (Whisper) + MT (LLM) + open TTS (Piper/Kokoro/XTTS) + FFmpeg mux covers dubbing without lip movement. Lip-sync needs Wav2Lip/MuseTalk-class models (GPU; Wav2Lip weights are non-commercial) → treat as External | Voice cloning needs consent handling |
| AI Voice Generator, AI Podcast Generator | Audio & voice | **Local** with open TTS at lower quality; premium voices External | |
| Mixing, ducking, normalisation, fades | Audio (conventional) | **Local** (FFmpeg `loudnorm`, `sidechaincompress`, `afade`; WebAudio preview) | Not offered by Higgsfield on pages read |
| AI Video Upscaler (1080p/2K/4K, presets for AI video/UGC/old film) | Enhancement / upscale | **Local, partially**: Real-ESRGAN (ncnn-vulkan runs on consumer GPUs) is slow but workable; plain Lanczos via FFmpeg always available | Higgsfield mentions Topaz for interpolation [V] |
| AI Frame Interpolation / FPS Boost (to 120 fps) | Enhancement | **Local**: FFmpeg `minterpolate` (CPU, artefacts) or RIFE (ncnn-vulkan) | |
| AI Video Deflicker | Enhancement | **Local, basic**: FFmpeg `deflicker` handles exposure flicker; AI-generation flicker needs a model | |
| Assets library (generated outputs saved to "Assets"), reusable characters/locations/props in Cinema Studio | Projects & asset management | **Local** (filesystem + SQLite/JSON, content hashes, thumbnails via FFmpeg) | Local-first is an advantage: Higgsfield API retains outputs only ≥7 days [V] |
| Supercomputer Agent, Higgsfield MCP for Claude | Agent orchestration | **Local** orchestration with our own agents; generation calls External | Their agent and prompt stack are N/R |
| Virality Predictor | AI-assisted (analytics) | N/R as offered (undisclosed model). A heuristic checklist via an LLM is possible but would be our own, unvalidated feature | Marketing-grade claim [M] |

Feature names and descriptions: https://higgsfield.ai/ai-video-editor , https://higgsfield.ai/ai-video , https://higgsfield.ai/apps , https://higgsfield.ai/

## 3. Official public API: yes

- [V] **Platform**: https://open.higgsfield.ai/ titles itself "Official Higgsfield API Platform", with per-model pages/playgrounds (`/models/<provider>/<model>/playground`). Docs: https://docs.higgsfield.ai/ (index https://docs.higgsfield.ai/docs/llms.txt , supplementary OpenAPI https://docs.higgsfield.ai/docs/openapi.json).
- [V] **Base URL**: `https://api.higgsfield.ai`.
- [V] **Auth**: key ID + secret, `Authorization: Key <KEY_ID>:<KEY_SECRET>`. Legacy `hf-api-key` / `hf-secret` headers still accepted. **Not** a Bearer token. Server-side only; invalid credentials → `401 {"detail":"Invalid credentials"}`. Keys are created in the console (docs say console.higgsfield.ai; an older page says cloud.higgsfield.ai — naming inconsistency). https://docs.higgsfield.ai/docs/authentication.md
- [V] **Flow**: asynchronous. `POST /<provider>/<model>/…` returns a request ID, status URL and cancel URL; then `GET /requests/{request_id}/status`, `POST /requests/{request_id}/cancel`, `DELETE /requests/{request_id}`. Statuses: `queued`, `in_progress`, `completed`, `failed`, `nsfw`, `canceled`. Webhooks are offered as the production alternative to polling. https://docs.higgsfield.ai/docs/openapi.json , https://docs.higgsfield.ai/docs/help/faq
- [V] **Endpoints in the OpenAPI file** (explicitly "not the authoritative model catalog"): `/higgsfield-ai/soul/standard`, `/kling-video/v2.5-turbo/pro/{image-to-video,text-to-video}`, `/kling-video/v2.5-turbo/standard/image-to-video`, `/minimax/hailuo-2.3/standard/{image-to-video,text-to-video}`. The live catalogue is larger and is documented per model in the console.
- [V] **SDKs**: npm `@higgsfield/client` (import from `@higgsfield/client/v2`, env `HF_CREDENTIALS` = `key-id:key-secret`, `higgsfield.subscribe(model, { input, withPolling: true })`; the v2 client blocks browser use), pip `higgsfield-client` (env `HF_KEY`). https://docs.higgsfield.ai/docs/how-to/sdk.md
- [V] **Billing**: pay-as-you-go from a prepaid balance; invoicing only under a committed-use contract. Failed, timed-out and NSFW-flagged requests are not charged. Rate limits are per account and per model (shown in the dashboard; increases requested via Discord). Outputs are kept **at least 7 days**, then may be removed. https://docs.higgsfield.ai/docs/help/faq
- [V] **Listed "from" prices** on https://open.higgsfield.ai/ (currency symbol not captured by the fetcher; presumably USD — treat as [?]). Video, per second: Wan 3.0 0.038 · Wan 3.0 Prime 0.051 · Genjutsu Light 0.074 · Wan 2.7 0.075 · Seedance 2.0 0.080 · Grok Imagine Video 1.5 0.080 · LTX 2.5 Fast 0.090 · Kling 4.0 Flash 0.094 · Seedance 2.5 0.118 · LTX 2.5 Pro 0.120 · Cinema Studio 4.0 0.123 · Kling 4.0 0.126 · MiniMax H3 0.130 · Genjutsu 0.154 · Genjutsu workflow 0.318. Images from 0.003 (Soul 2) to 0.094 (Soul Standard) per image.

### Terms relevant to a third-party integration
Source: https://higgsfield.ai/terms-of-use-agreement (stated "last updated October 23, 2026"). Read via summariser — **have counsel read the original before integrating**; section numbers below are as reported.

- §1.2 licence is limited/revocable, for personal or internal business use, or to build apps for end users under §11 (Developer Terms, part of the same agreement).
- **§5.1(iii): may not use the Service or Outputs to develop products or models that compete with it.** This is the clause that matters most for us: a video studio that offers Higgsfield as one generation backend is arguably a competing product. Treat a Higgsfield adapter as **legally blocked until clarified in writing**.
- §5.2(i) no resale/rental; §11.5 no sublicensing, redistribution, or acting as a pass-through/service bureau without independent added value; you are responsible for your end users.
- §5.2(v) no reverse engineering (except where law expressly allows); §5.2(vi) no scraping.
- §11.4 keys are confidential; suspected compromise must be reported within 24 hours. §11.10 endpoints can change at any time. §1.5 usage limits can change without notice; circumvention (e.g. multiple accounts) prohibited.
- §4.2/§4.4 Higgsfield does not claim ownership of inputs/outputs and does not restrict commercial use of outputs; **§4.4 content may be used to train Higgsfield models unless an Enterprise Agreement applies**.
- §11.8 no implied endorsement/affiliation without written consent; no general trademark licence. §5.5/§6.4 provenance markings must not be removed.
- §8 underlying model providers' acceptable-use policies also apply.

A bring-your-own-key design (the user's own Higgsfield key, stored locally, calls made from our local Node backend) reduces resale/pass-through exposure but does **not** resolve §5.1(iii).

## 4. Other official video-generation APIs (adapter candidates)

| Provider | Availability | Auth | Rough price per second | Licence / notes | Confidence |
|---|---|---|---|---|---|
| **Runway API** | Public developer API; hosts own models (`gen4.5`, `gen4_turbo`, `aleph2`, `act_two`) and third-party ones (`veo3.1`, `kling_4`, `seedance2_5`, `wan3`, `hailuo3`, `grok_imagine_1_5`, `gemini_omni_flash_1.2`…) | API key; versioned API ("2024-11-06" linked). Exact header not on the pricing page [?] | 1 credit = $0.01. `gen4_turbo` 5 cr/s ($0.05) · `gen4.5` 12 ($0.12) · `aleph2` 28 ($0.28) · `veo3.1` 20/40 without/with audio · `veo3.1_fast` 10/15 · `wan3` 5/10/20 by resolution · `kling_4` 720p 12.56 (promo until 2026-11-30, list 15.7) | Read Runway API terms before use [?] | [V] prices: https://docs.dev.runwayml.com/guides/pricing/ |
| **Google (Gemini API)** | `gemini-omni-1.2-flash` video model is listed and paid-only; `gemini-omni-1.1-flash` deprecated, rerouted from 2026-12-03 | API key (`x-goog-api-key`) — from prior knowledge, not re-read today [?] | Omni 1.2 Flash: ~$0.023/s 360p · ~$0.07/s 720p · ~$0.104/s 1080p · ~$0.209/s 4K ($12 per 1M video output tokens) | No free tier for video | [V] https://aistudio.google.com/docs/pricing (ai.google.dev/gemini-api/docs/pricing redirects there) |
| **Google Veo via Gemini API** | Veo 3.1 family exists and is sold through Runway and Higgsfield [V]; its row on Google's own pricing page was **not seen** (page truncated by the fetcher) | same as above | [3P] Veo 3.1 $0.40/s (720p/1080p), $0.60/s 4K; Fast $0.10/$0.12/$0.30; Lite $0.05/$0.08 | Outputs carry SynthID watermark — prior knowledge [?] | **Unverified on first-party page** |
| **OpenAI Sora API** | **Shut down.** "The Sora 2 models and Videos API were shut down on September 24, 2026 and are no longer available"; "no one-to-one replacement API" | — | Historical: sora-2 $0.10/s; sora-2-pro $0.30–$0.70/s | Do not build an adapter | [V] https://developers.openai.com/api/docs/models/sora-2.md |
| **Luma (Agents API)** | Public; base `https://agents.lumalabs.ai/v1`; `POST /v1/generations`, `GET /v1/generations/{id}`; model `ray-3.2`; job types `video`, `video_edit`, `video_reframe`. Older "Dream Machine API" docs now point here | `Authorization: Bearer`, env `LUMA_AGENTS_API_KEY` | [3P] ~$0.30 per 5 s 720p clip, $1.20 at 1080p (per generation, credits) | Terms not read [?] | [V] shape: https://docs.agents.lumalabs.ai/ ; price unverified |
| **Kling (official)** | Official developer API with docs at kling.ai/document-api; "API Key authentication must be used"; legacy Access-Key/Secret-Key JWT (HS256, ≤30 min) only for legacy endpoints | API key (Bearer) | Prepaid resource packs that expire; per-second official price not confirmed [?]. Via Runway `kling3.0_standard` 9 cr/s = $0.09; via fal Kling v3 $0.14/s | Console/base URL details from search snippets only | [3P]/partially verified: https://kling.ai/document-api/api/get-started/authentication.md |
| **Pika** | Conflicting. Pika announced an "API Club" (Aug 2026, ~$10/month membership, multi-model, effectively an aggregator); older access was via fal ("Pika API is now powered by fal") | [?] | [?] | Could not open first-party docs | **Unverified** — https://experiment.pika.art/blog/pika-api-club , https://blog.fal.ai/pika-api-is-now-powered-by-fal |
| **fal.ai** (aggregator) | Public; hundreds of model endpoints; current price per endpoint at `https://fal.ai/models/<endpoint-id>/llms.txt` | API key (`Authorization: Key …`) — prior knowledge [?] | PixVerse V6 $0.005/s · Grok Imagine Video 1.5 i2v $0.01/s · MiniMax H3 Max $0.05/s · Kling v2.6 Pro $0.07/s · FLUX 3 Max $0.085/s · Kling v3 / O3 $0.14/s; Seedance billed per token | Prepaid credits; no charge for server errors or queue time. Per-model licences differ — check each model page | [V] https://fal.ai/pricing |
| **Replicate** (aggregator) | Public | API token (Bearer) — prior knowledge [?] | Example on pricing page: `wavespeedai/wan-2.1-i2v-480p` $0.09/s, `-720p` $0.25/s; many models billed by hardware run-time instead | Open-weight models keep their own licences (some non-commercial) | [V] https://replicate.com/pricing |
| **Higgsfield API** | Public (section 3) | `Authorization: Key id:secret` | 0.038–0.318 per second "from" | **§5.1(iii) competing-product clause** | [V] |

Adapter design implications (ours):
- Every provider is **asynchronous job + poll/webhook**. One internal contract fits all: `submit(spec) → jobId`, `status(jobId)`, `cancel(jobId)`, `fetchOutput(jobId) → local file`. Download outputs immediately (retention is short everywhere).
- Normalise a **capability descriptor per model** (t2v, i2v, first/last frame, reference images, video-to-video edit, extend, native audio, max duration, resolutions, aspect ratios) and a **cost estimator** (per second × resolution × audio, plus minimums such as Runway's 56–80-credit floors).
- Show the estimated cost before the user confirms a run; never auto-retry a paid job silently.
- Keys stay server-side in the local Node process; never in the React bundle (Higgsfield's v2 client refuses to run in a browser).
- Lowest-risk first adapters: **fal.ai** (broadest catalogue, clear per-endpoint pricing) and **Runway** (first-party + clear price table). Gemini Omni as a third. Skip Sora. Hold Higgsfield pending legal review.

## 5. FFmpeg licensing and how to obtain it

Licensing ([V] https://ffmpeg.org/legal.html):
- FFmpeg is **LGPL 2.1-or-later by default**. Building with `--enable-gpl` (required for libx264, libx265, and several filters) makes the whole build **GPL**. `--enable-nonfree` (e.g. libfdk-aac) produces a binary that **cannot be redistributed**.
- FFmpeg is "not available under any other licensing terms" — no commercial licence exists.
- LGPL checklist items that apply when **distributing** it: provide the exact corresponding source and configure line, state in About/docs/EULA that the product uses FFmpeg under LGPL 2.1, do not forbid reverse engineering in the EULA, do not rename/obfuscate the libraries.
- Patents are a separate matter (H.264/HEVC/AAC pools); FFmpeg grants no patent rights. Risk rises with commercial distribution.

What this means for Portal IA (our reading, not legal advice):
- **Invoking a separate `ffmpeg` executable as a child process** is not linking; it is generally treated as use of an independent program ("mere aggregation" in GPL terms). Our own code does not become GPL/LGPL by spawning it, even with a GPL build.
- Obligations attach when we **redistribute** the binary (bundle it in an installer, npm dependency, or Docker image we publish). Then we must ship the licence text and offer the corresponding source for that exact build. A GPL build is fine to redistribute under GPL terms; a nonfree build is not.
- If the user installs FFmpeg themselves and we only locate it on PATH, we distribute nothing and carry no redistribution obligation. This is the cleanest option for a local-first tool.
- Never use `--enable-nonfree` builds. Prefer the built-in `aac` encoder over libfdk-aac.
- In-browser preview with WebCodecs/Canvas/WebAudio uses the OS/browser codecs and involves no FFmpeg licensing at all.

Ways to get FFmpeg on Windows / Node (status checked today via GitHub API and npm registry):

| Route | Status 2026-11-14 | Licence of what you get | Assessment |
|---|---|---|---|
| System install: **Gyan.dev builds** (`winget install Gyan.FFmpeg`, github.com/GyanD/codexffmpeg) | Latest release tag `9.0.2`, 2026-09-20 | GPLv3 builds ("essentials"/"full") | Maintained; simplest for a dev machine |
| System install: **BtbN/FFmpeg-Builds** | Auto-builds; `latest` release published 2026-11-14 | Offers separate **GPL and LGPL** variants, static or shared | Best when an LGPL build is required; actively maintained |
| npm **`ffmpeg-static`** | 5.3.0 published 2025-11-14 (binary release tag `b6.1.1`, i.e. FFmpeg 6.1.1); repo not archived, last push 2026-03-21, 34 open issues | Package `GPL-3.0-or-later`; downloads a binary in a **postinstall script** from GitHub releases | Slow-moving and ships an old FFmpeg; install-time download is a supply-chain and offline-install consideration. Acceptable fallback, not first choice |
| npm `ffmpeg-ffprobe-static` | 6.1.2-rc.1, 2024-10-29 | GPL-3.0-or-later | Stale |
| npm `@ffmpeg-installer/ffmpeg` | 1.1.0, **2021-07-15** | LGPL-2.1 label, very old binaries | Effectively unmaintained — avoid |
| npm **`fluent-ffmpeg`** (wrapper) | **Deprecated on npm** ("Package no longer supported"); GitHub repo **archived** | MIT | Do not adopt; build arguments ourselves and use `child_process.spawn` |
| npm `@ffmpeg/ffmpeg` (ffmpeg.wasm) | 0.12.15, 2025-01-07 | MIT wrapper; core is a GPL/LGPL wasm build | In-browser only, slow, memory-limited (≈2 GB); fine for tiny clips, not for a render pipeline |
| npm `mediabunny` (pure-TS mux/demux over WebCodecs) | 1.66.0, 2026-11-13 | MPL-2.0 | Active; good for browser-side read/write of MP4/WebM without FFmpeg |
| Docker: `linuxserver/ffmpeg`, `jrottenberg/ffmpeg` | Both pushed this month (2026-11-13 / 2026-11-08) | GPL builds (some tags include nonfree components — check the tag) | Good isolation and reproducibility; on Docker Desktop for Windows there is bind-mount I/O overhead and no simple GPU encoder access |

Recommendation: resolve `ffmpeg`/`ffprobe` in this order — explicit path in settings → PATH → optional managed download of a pinned BtbN build with SHA-256 verification (user-approved) → Docker image as an opt-in sandboxed renderer. Record `ffmpeg -version` and `-buildconf` in project diagnostics so the licence flavour is visible.

## 6. UX patterns worth learning from (described in our own words)

1. **One input bar, mode by attachment.** The same composer becomes text-to-video, image-to-video or edit-a-clip depending on what the user attaches, instead of separate screens.
2. **Cost before commitment.** The run button carries the price of that exact configuration; the number updates as duration/resolution/model change.
3. **Model picker phrased as trade-offs** (fast draft vs. best quality vs. native audio vs. 4K), with per-model controls appearing only when the chosen model supports them.
4. **Structured creative controls that compile to a prompt.** Separate fields for camera, lens, lighting, palette and genre, so users do not need prompt jargon; the free-text prompt remains for intent.
5. **Start/end frame slots.** Two image drop zones define where a shot begins and ends; simple mental model for controlled motion and for generated transitions.
6. **Reusable entities.** Characters, locations and props are saved once and referenced across shots to keep continuity.
7. **"Remix this" from examples.** Every showcase item is a preset the user can re-run with their own subject; templates are data (prompt + slots + settings), not hard-coded screens.
8. **Post-steps chained from a result.** From any finished clip: extend, upscale, reframe, change fps, re-edit — each a one-click follow-up that produces a new version rather than overwriting.
9. **Everything lands in a library.** Outputs are saved automatically with their recipe, so a clip can be regenerated or branched.
10. **Draft tiers.** Cheap low-resolution/fast mode first, then promote a chosen take to the expensive tier.
11. **Asynchronous jobs with visible states** (queued, running, done, failed, blocked by moderation) and no charge on failure — the UI should say so explicitly.
12. **Draw-to-edit.** Paint a rough region on a frame and describe the change; avoids precise masking.

Where an independent, local-first studio can be better: a real timeline with frame-accurate local preview; unlimited local operations at zero marginal cost (cut, caption, mix, reframe, upscale); permanent local storage with full provenance per asset (provider, model, prompt, seed, cost); provider choice per shot; outputs not used for anyone's training unless the chosen provider's terms say so.

## 7. Open items / not verified

- Higgsfield plan prices, credit-to-currency rate, concurrency limits (pricing page not machine-readable).
- Currency of the open.higgsfield.ai price list; full live endpoint catalogue and webhook payload/signature format.
- Exact wording of Higgsfield ToS §5.1(iii), §11 (read via summariser).
- Veo pricing on Google's own page; Kling official per-second prices; Luma Ray 3.2 prices; Pika first-party API status.
- API-specific terms of Runway, Luma, fal, Replicate, Google (output ownership, watermarking, competing-use clauses) — not read.
- Auth header details marked [?] in the table come from prior knowledge, not from pages read today.
