<h1 align="center">
  Mate — Windows AI Assistant
</h1>

<p align="center">
  <img src="public/thuki-logo.png" alt="Mate logo" width="300" />
</p>

<p align="center">
  A floating AI secretary for Windows. Local-first, privacy-first — run fully offline with Ollama, or optionally connect to OpenRouter for cloud models.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-beta-yellow.svg" alt="Beta" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4?logo=windows&logoColor=white" alt="Platform: Windows 10/11" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri-v2-24C8DB?logo=tauri&logoColor=white" alt="Tauri v2" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" alt="React 19" />
  <img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Rust-stable-CE422B?logo=rust&logoColor=white" alt="Rust" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white" alt="Tailwind CSS 4" />
  <img src="https://img.shields.io/badge/SQLite-bundled-003B57?logo=sqlite&logoColor=white" alt="SQLite" />
  <img src="https://img.shields.io/badge/Ollama-local-black" alt="Ollama" />
</p>

---

> **Windows port of [Thuki](https://github.com/quiet-node/thuki)** — original macOS app by [Logan Nguyen](https://x.com/quiet_node). This fork brings the full Thuki experience to Windows 10 and 11, with native window controls, Windows-style title bar, adjustable transparency, a custom chat bubble color picker, online model support (OpenRouter / Anthropic / OpenAI), agent mode (`/do`), Edge TTS voice output, a Gateway API server, and more.

**Local mode: no API keys, no subscriptions, no cloud, no telemetry. Free forever.**
**Online mode: bring your own OpenRouter, Anthropic, or OpenAI key — one optional toggle.**

Mate (based on Thuki — Vietnamese _thư kí_ for secretary) is a lightweight Windows overlay powered by local AI models running entirely on your own machine, built for quick, uninterrupted asks without ever leaving what you're doing.

## See It in Action

### Basic Usage

Double-tap Control <kbd>Ctrl</kbd> to summon Mate from anywhere. Ask a question, get an answer, and dismiss. Use `/screen` or the camera button to capture your full screen, or click the crosshair (region-select) button to drag and crop any area of your screen — the captured image is attached automatically as context.

[https://github.com/user-attachments/assets/57df0efe-24eb-4875-a83d-e605e0c6f8b4](https://github.com/user-attachments/assets/6a03da1b-4a1b-4c45-b251-19bcaba995b0)

### Overlay Mode

Mate floats above every app. Highlight text anywhere, double-tap Control <kbd>Ctrl</kbd>, and Mate opens with your selection pre-filled as a quote, ready to ask about.

[https://github.com/user-attachments/assets/f52b55f7-479d-4c2e-a361-1553fe132712](https://github.com/user-attachments/assets/bc9fec9f-d12d-480e-be03-22e2d50699b6)

### Quick Explain (Ctrl+Space)

Select any text and press <kbd>Ctrl</kbd>+<kbd>Space</kbd> to instantly explain it. Mate opens (or resets if already open), captures your selection via clipboard, and automatically asks _"What is this, and what is it about?"_ — no typing required.

### Inline Edit (Ctrl+Shift)

Select any text in any app, then press and hold <kbd>Ctrl</kbd>+<kbd>Shift</kbd>. If you don't press any other key within 700 ms, Mate opens in **inline-edit mode** with your selection pre-loaded — ready for you to ask the AI to rewrite, improve, translate, or transform it. The 700 ms grace period lets normal <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> shortcuts (e.g. <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> in VS Code) pass through untouched.

## Why Mate?

Most AI tools require accounts, API keys, or subscriptions that bill you per token. Mate is different:

- **Local mode is 100% free:** run Ollama locally, no per-query cost, ever
- **Zero trust by design (local):** no remote server, no cloud backend, no analytics, no telemetry
- **Works completely offline:** once your model is pulled, Mate runs without an internet connection
- **Your data is yours:** conversations are stored in a local SQLite database on your machine and nowhere else
- **Online mode when you need it:** optionally connect OpenRouter, Anthropic, or OpenAI with your own key — you stay in control of what leaves your device
- **Most importantly: it works everywhere.** Double-tap Control <kbd>Ctrl</kbd> and Mate appears on your desktop, inside a browser, inside a terminal, and even while a game or video is fullscreen. Your favorite AI chat apps can't do that!

## Features

- **Always available:** double-tap Control <kbd>Ctrl</kbd> to summon the overlay from any app
- **Quick Explain:** select any text and press <kbd>Ctrl</kbd>+<kbd>Space</kbd> — Mate opens and instantly explains your selection without any extra typing
- **Inline Edit:** select text in any app, press <kbd>Ctrl</kbd>+<kbd>Shift</kbd> and hold for 700 ms (without pressing any other key) — Mate opens in inline-edit mode with your selection ready for AI rewriting, translation, or transformation
- **Context-aware quotes:** highlight any text, then double-tap Control <kbd>Ctrl</kbd> to open Mate with the selected text pre-filled as a quote
- **Throwaway conversations:** fast, lightweight interactions without the overhead of a full chat app
- **Conversation history:** persist and revisit past conversations across sessions
- **Fully local LLM:** powered by Ollama; no API keys, no accounts, no cost per query
- **Online models:** connect OpenRouter (or Anthropic / OpenAI directly) with your own API key for cloud-powered responses — one toggle in the model picker switches between local and online mode
- **Isolated sandbox:** optionally run models in a hardened Docker container with capability dropping, read-only volumes, and localhost-only networking
- **Image input:** paste or drag images and screenshots directly into the chat
- **File attachments:** type `/file` (or `/file your question`) to open a native file picker — Mate reads up to 5 text files at once (`.txt`, `.md`, `.json`, `.ts`, `.py`, `.rs`, and more, up to 1 MB each) and sends their full contents to the model as context
- **Screen capture:** type `/screen` or click the camera button to instantly capture your entire screen and attach it to your question as context
- **Region capture:** click the crosshair button in the ask bar to open a fullscreen drag-to-select overlay — draw a rectangle over any part of your screen and the cropped region is attached as context
- **Agent mode:** type `/do` to let Mate autonomously control your desktop — launch apps, type text, press key combos, and complete multi-step tasks. Works with both vision and text-only local models; cloud providers ask for screenshot consent before sending any screen data off-device
- **Agentic search:** type `/search` to run a fully local, multi-step search pipeline (SearXNG + Trafilatura reader) with a live trace of every query, fetch, and judgement step
- **Slash commands:** built-in commands for live search and prompt shortcuts: `/do`, `/file`, `/search`, `/screen`, `/think`, `/translate`, `/rewrite`, `/tldr`, `/refine`, `/bullets`, `/todos`. Highlight text anywhere, summon Mate, type a command, and hit Enter
- **Extended reasoning:** type `/think` to have the model reason through a problem step by step before answering
- **Voice output (TTS):** click the speaker icon on any assistant message to have it read aloud using Microsoft Edge Neural TTS — pick from a rich set of voices in Settings → Sound
- **Conversation trace recorder:** optionally record every chat and `/search` session as JSON-Lines for debugging and forensics — off by default; enable from Settings or set `[debug] trace_enabled = true` in `config.toml`
- **In-app model picker:** browse models installed in your local Ollama and switch the active model from the ask bar or chat header without opening a config file; online models from OpenRouter are listed alongside local ones
- **Cross-model continuity:** swap models mid-conversation and Mate sanitizes history and filters capabilities (vision, thinking) to whatever the new model supports
- **Gateway API server:** expose Mate's inference backend as a local OpenAI-compatible HTTP endpoint for use by other tools
- **Settings panel:** a multi-tab native window (AI, Web, Display, Agent, Gateway, Sound, About) for inference, prompt, window, search, appearance, TTS, and gateway settings
- **Chat bubble color:** pick any accent color for your chat bubbles — the scrollbar and UI highlights adapt automatically
- **Window transparency:** set the overlay background opacity (50–100%) directly from the Appearance settings tab
- **Chat background blur:** tune the frosted-glass blur (0–20 px) behind the chat area from the Appearance settings tab
- **Contextual tip bar:** lightweight in-overlay hints surface the right shortcut or command at the right moment
- **Privacy-first:** local mode is fully air-gapped; online mode shows explicit consent prompts before any screen data leaves your device

## Windows-Specific Additions

This port adds several Windows-native improvements on top of the original Thuki:

| Feature                           | Details                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Native Windows title bar**      | Minimize button with Windows-style controls alongside macOS-style traffic-light dots                                                                                                                                                                                                                                                                                                                                                                      |
| **Chat bubble color picker**      | Choose any accent color; scrollbar tint and highlights update in real time                                                                                                                                                                                                                                                                                                                                                                                |
| **Adjustable transparency**       | Slide window background opacity from 50% to 100% in the Appearance settings tab                                                                                                                                                                                                                                                                                                                                                                           |
| **Chat background blur**          | Tune the frosted-glass blur (0–20 px) behind the chat area in the Appearance settings tab                                                                                                                                                                                                                                                                                                                                                                 |
| **Online model support**          | Connect OpenRouter, Anthropic, or OpenAI with your own key; switch between local and online in the model picker                                                                                                                                                                                                                                                                                                                                           |
| **Agent mode (`/do`)**            | Autonomous desktop control — launches apps, types text, presses keys; cloud providers ask consent before sending screenshots                                                                                                                                                                                                                                                                                                                              |
| **Edge TTS voice output**         | Read any assistant message aloud; choose from Neural voices in Settings → Sound                                                                                                                                                                                                                                                                                                                                                                           |
| **Gateway API server**            | Expose Mate's backend as a local OpenAI-compatible HTTP endpoint for third-party tools                                                                                                                                                                                                                                                                                                                                                                    |
| **Narrower chrome**               | Tighter padding on the overlay and chat area for a denser, more focused layout                                                                                                                                                                                                                                                                                                                                                                            |
| **Header model chip**             | Active model displayed as a compact chip in the chat header — click to switch without leaving chat                                                                                                                                                                                                                                                                                                                                                        |
| **Quick Explain (Ctrl+Space)**    | Select text anywhere, press <kbd>Ctrl</kbd>+<kbd>Space</kbd> — Mate opens and auto-submits an explain query for the selection                                                                                                                                                                                                                                                                                                                             |
| **Inline Edit (Ctrl+Shift)**      | Select text anywhere, press <kbd>Ctrl</kbd>+<kbd>Shift</kbd> and hold 700 ms — Mate opens in inline-edit mode with the selection pre-loaded. The 700 ms delay lets <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> app shortcuts (VS Code, browsers, etc.) pass through untouched                                                                                                                                                                           |
| **Drag-to-select region capture** | Click the crosshair button in the ask bar; a fullscreen overlay opens with a crosshair cursor. Drag a rectangle over any screen area, release, and the cropped region is attached as context. Escape or right-click cancels. Works alongside `/screen` (full-screen capture) and manual image paste/drag                                                                                                                                                  |
| **Conversation trace recorder**   | Records every chat and `/search` session as JSON-Lines under `%APPDATA%\com.quietnode.thuki\traces\`. Off by default; toggle in Settings → About or set `[debug] trace_enabled = true` in `config.toml`                                                                                                                                                                                                                                                   |
| **Transparent-bottom fix**        | Overlay window is always reset to the collapsed height before being shown, eliminating the transparent gap that was visible at the bottom when re-opening after a previous chat session                                                                                                                                                                                                                                                                   |
| **File attachments (`/file`)**    | Type `/file` or `/file your question` to open a native file picker. Mate reads the selected text files (up to 5 files, 1 MB each) and sends their full contents to the model as context. Supported formats: `.txt`, `.md`, `.csv`, `.json`, `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.rs`, `.go`, `.java`, `.c`, `.cpp`, `.h`, `.xml`, `.yaml`, `.toml`, `.html`, `.css`, `.sh`, `.bat`, `.ps1`, `.sql`, `.rb`, `.php`, `.swift`, `.kt`, `.cs`, `.r`, `.tex` |

## Getting Started

### Step 1: Set Up Your AI Engine

> **Default model:** Mate ships with [`gemma4:e2b`](https://ollama.com/library/gemma4) by default, an effective 2B parameter edge model from Google. It runs comfortably on most modern Windows PCs with 8 GB of RAM and delivers strong performance on reasoning, coding, and vision tasks. The ask-bar model picker lists the models currently installed in your local Ollama and lets you switch the active model without leaving the overlay. To change the bootstrap default itself, edit `%APPDATA%\com.quietnode.thuki\config.toml` and reorder the `[model] available` list so your preferred model is first.

Choose one of the two options below to set up your AI engine before installing Mate.

#### Option A: Local Ollama (Recommended for most users)

[Ollama](https://ollama.com) runs AI models directly on your PC. It's free, open-source, and takes about 5 minutes to set up.

1. **Install Ollama**

   Download and install from [ollama.com](https://ollama.com).

2. **Pull a model**

   ```powershell
   ollama pull gemma4:e2b
   ```

   > **Note:** Model files are large (typically 2–8 GB). This step can take several minutes depending on your internet connection. You only need to do it once.

3. **Verify the model is ready**

   ```powershell
   ollama list
   ```

   You should see your model listed. Once it appears, Ollama is ready and Mate will connect to it automatically at `http://127.0.0.1:11434`.

#### Option B: Docker Sandbox (For security-conscious users)

**Prerequisites:** Install [Docker Desktop](https://www.docker.com/get-started)

The Docker sandbox is for users who want the strongest possible isolation between the AI model and their host system — ideal if you work in regulated environments, are security-conscious about what runs on your machine, or simply want peace of mind. The model runs in a hardened container that cannot reach the internet, cannot write to your filesystem, and leaves no trace when stopped.

Start the sandbox:

```powershell
bun run sandbox:start
```

> **First run:** The sandbox will pull the model inside the container; this may take several minutes depending on your connection. Subsequent starts are instant.

When you're done, stop and wipe all model data:

```powershell
bun run sandbox:stop
```

For the full architecture and security philosophy behind the sandbox, see [`sandbox/README.md`](sandbox/README.md).

#### Option C: Online Models via OpenRouter (No local install needed)

If you prefer not to install Ollama, you can use cloud models instead. Mate integrates with **[OpenRouter](https://openrouter.ai)**, giving you access to GPT-4o, Claude Sonnet 4, Gemini 2.5, Llama 4, DeepSeek R1, and more.

1. Create a free account at [openrouter.ai](https://openrouter.ai) and copy your API key.
2. Launch Mate, open the model picker, and switch to **Online** mode.
3. Paste your API key and pick a model. Done — no local setup required.

> **Privacy note:** In online mode, your messages are sent to the selected cloud provider. For `/screen` screenshots and agent mode (`/do`) screenshots, Mate will ask for explicit consent before sending any screen data off-device.

### Step 2: Setup the search sandbox (Optional, required for /search)

The `/search` command uses an agentic search pipeline that depends on two local Docker containers: a **SearXNG** meta-search engine and a **Trafilatura** reader. This setup ensures that your search queries and the content you read remain entirely local.

**Prerequisite:** [Docker Desktop](https://www.docker.com/get-started) must be running.

1. **Start the search services**

   ```powershell
   bun run search-box:start
   ```

2. **Verify services (Optional)**

   ```powershell
   curl "http://127.0.0.1:25017/search?q=mate&format=json"
   ```

   Without this service running, the `/search` command will be disabled in the chat, but all other features will remain available.

   For more details on the agentic search pipeline, see [docs/agentic-search.md](docs/agentic-search.md).

### Step 3: Install Mate

#### Download (Recommended)

1. Download `Mate_x64-setup.exe` (or the `.msi` installer) from the [latest release](https://github.com/M31i55a/Mate2.0-Thuki/releases/latest).
2. Run the installer and follow the prompts.
3. Launch **Mate** from the Start menu or desktop shortcut.

> **First launch:** Windows may show a SmartScreen prompt since the app is not yet code-signed. Click **More info → Run anyway**. This is expected for open-source apps distributed outside the Microsoft Store.

#### Build from Source

**Prerequisites:** [Bun](https://bun.sh), [Rust](https://rustup.rs), and optionally [Docker](https://www.docker.com/get-started)

```powershell
# Clone and install dependencies
git clone https://github.com/M31i55a/Mate2.0-Thuki.git
cd Mate2.0-Thuki
bun install

# Launch in development mode
bun run dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development setup guide.

## Architecture & Security

<details>
<summary>Click to expand</summary>

Mate is a **Tauri v2** app (Rust backend + React/TypeScript frontend) that interfaces with a locally running Ollama instance at `http://127.0.0.1:11434`.

### Dual-Layer Isolation

1. **Frontend (Tauri/React):** Operates within a secure system webview with restricted IPC. Streaming uses Tauri's Channel API; the Rust backend sends typed `StreamChunk` enum variants, and the frontend hook accumulates tokens into React state.

2. **Generative Engine (Docker Sandbox):**
   - **Ingress Isolation:** The API is bound to `127.0.0.1` only, blocking all external network access
   - **Privilege Dropping:** All Linux kernel capabilities are dropped (`cap_drop: ALL`)
   - **Model Integrity:** Model weights are mounted read-only (`:ro`) to prevent tampering
   - **Ephemeral State:** All model data is purged on shutdown via `docker compose down -v`

### Window Lifecycle

The app starts hidden. The hotkey or tray menu shows it. The window close button hides (not quits); quit is only available from the tray.

</details>

## Configuration

Mate reads a single typed TOML file at `%APPDATA%\com.quietnode.thuki\config.toml`, seeded with sensible defaults on first launch. The in-app Settings panel writes to the same file, so you can edit by hand or click through tabs, whichever you prefer.

See [docs/configurations.md](docs/configurations.md) for the full schema covering the `[inference]`, `[prompt]`, `[window]`, `[quote]`, and `[search]` sections (Ollama URL, system prompt, context window, image cap, agentic-search timeouts, and more).

See [docs/commands.md](docs/commands.md) for the full slash command reference, and [docs/tuning-context-window.md](docs/tuning-context-window.md) for guidance on picking a `num_ctx` value.

## Contributing

Contributions are welcome! Read [CONTRIBUTING.md](CONTRIBUTING.md) to get started. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Original Project

Mate is a Windows port of **[Thuki](https://github.com/quiet-node/thuki)** by [Logan Nguyen](https://x.com/quiet_node). All core functionality, architecture, and design originate from the upstream project. This port adapts and extends it for Windows.

## Author

**Gioda - Code Artist** ([@M31i55a](https://github.com/M31i55a)) — reach out on [X](https://x.com/gioda123456) with questions or feedback.

## What's next for Mate

Mate inherits the Thuki roadmap and adds Windows-specific improvements:

### Secretary Superpowers

- **Tool integrations via [MCP](https://modelcontextprotocol.io/):** connect Mate to Gmail, Slack, Discord, Google Calendar, and any other MCP-compatible service
- **More slash commands:** expanding the existing `/do`, `/file`, `/search`, `/screen`, `/think`, `/translate`, `/rewrite`, `/tldr`, `/refine`, `/bullets`, and `/todos` set

### Better AI Control

- **More online providers:** additional cloud backends beyond OpenRouter, Anthropic, and OpenAI

### Richer Context

- **Voice input:** dictate your question instead of typing (TTS output already works — STT is next)
- **Auto-capture screen context:** activate Mate and have it automatically read the active window or selected region as context

---

Have a feature idea? [Open an issue](https://github.com/M31i55a/Mate2.0-Thuki/issues) and let's talk about it.

## License

Windows port copyright 2026 Gioda - Code Artist. Original Thuki copyright 2026 Logan Nguyen. Licensed under the [Apache License, Version 2.0](LICENSE).
