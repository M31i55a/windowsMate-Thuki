<h1 align="center">
  Mate — Windows AI Assistant
</h1>

<p align="center">
  <img src="public/thuki-logo.png" alt="Mate logo" width="300" />
</p>

<p align="center">
  A floating AI secretary for Windows. Fully local, completely free, zero data ever leaves your machine.
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

> **Windows port of [Thuki](https://github.com/quiet-node/thuki)** — original macOS app by [Logan Nguyen](https://x.com/quiet_node). This fork brings the full Thuki experience to Windows 10 and 11, with native window controls, Windows-style title bar, adjustable transparency, and a custom chat bubble color picker.

**No API keys. No subscriptions. No cloud. No telemetry. Free forever.**

Mate (based on Thuki — Vietnamese _thư kí_ for secretary) is a lightweight Windows overlay powered by local AI models running entirely on your own machine, built for quick, uninterrupted asks without ever leaving what you're doing.

## See It in Action

### Basic Usage

Double-tap Control <kbd>Ctrl</kbd> to summon Mate from anywhere. Ask a question, get an answer, and dismiss. Use `/screen` or the screenshot button to capture your screen and attach it as context.

https://github.com/user-attachments/assets/57df0efe-24eb-4875-a83d-e605e0c6f8b4

### Overlay Mode

Mate floats above every app. Highlight text anywhere, double-tap Control <kbd>Ctrl</kbd>, and Mate opens with your selection pre-filled as a quote, ready to ask about.

https://github.com/user-attachments/assets/f52b55f7-479d-4c2e-a361-1553fe132712

## Why Mate?

Most AI tools require accounts, API keys, or subscriptions that bill you per token. Mate is different:

- **100% free AI interactions:** you run the model locally, there is no per-query cost, ever
- **Zero trust by design:** no remote server, no cloud backend, no analytics, no telemetry
- **Works completely offline:** once your model is pulled, Mate runs without an internet connection
- **Your data is yours:** conversations are stored in a local SQLite database on your machine and nowhere else
- **Most importantly: it works everywhere.** Double-tap Control <kbd>Ctrl</kbd> and Mate appears on your desktop, inside a browser, inside a terminal, and even while a game or video is fullscreen. Your favorite AI chat apps can't do that!

## Features

- **Always available:** double-tap Control <kbd>Ctrl</kbd> to summon the overlay from any app
- **Context-aware quotes:** highlight any text, then double-tap Control <kbd>Ctrl</kbd> to open Mate with the selected text pre-filled as a quote
- **Throwaway conversations:** fast, lightweight interactions without the overhead of a full chat app
- **Conversation history:** persist and revisit past conversations across sessions
- **Fully local LLM:** powered by Ollama; no API keys, no accounts, no cost per query
- **Isolated sandbox:** optionally run models in a hardened Docker container with capability dropping, read-only volumes, and localhost-only networking
- **Image input:** paste or drag images and screenshots directly into the chat
- **Screen capture:** type `/screen` to instantly capture your entire screen and attach it to your question as context
- **Agentic search:** type `/search` to run a fully local, multi-step search pipeline (SearXNG + Trafilatura reader) with a live trace of every query, fetch, and judgement step
- **Slash commands:** built-in commands for live search and prompt shortcuts: `/search`, `/translate`, `/rewrite`, `/tldr`, `/refine`, `/bullets`, `/todos`. Highlight text anywhere, summon Mate, type a command, and hit Enter
- **Extended reasoning:** type `/think` to have the model reason through a problem step by step before answering
- **In-app model picker:** browse the models installed in your local Ollama and switch the active model from the ask bar or chat header without ever opening a config file
- **Cross-model continuity:** swap models mid-conversation and Mate sanitizes history and filters capabilities (vision, thinking) to whatever the new model supports
- **Settings panel:** a multi-tab native window for inference, prompt, window, search, and appearance settings, including a log-scale context-window slider and a tunable image-attachment cap (up to 20)
- **Chat bubble color:** pick any accent color for your chat bubbles — the scrollbar and UI highlights adapt automatically
- **Window transparency:** set the overlay background opacity (50–100%) directly from the Appearance settings tab
- **Contextual tip bar:** lightweight in-overlay hints surface the right shortcut or command at the right moment
- **Privacy-first:** zero-trust architecture, all data stays on your device

## Windows-Specific Additions

This port adds several Windows-native improvements on top of the original Thuki:

| Feature                      | Details                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| **Native Windows title bar** | Minimize button with Windows-style controls alongside macOS-style traffic-light dots               |
| **Chat bubble color picker** | Choose any accent color; scrollbar tint and highlights update in real time                         |
| **Adjustable transparency**  | Slide window background opacity from 50% to 100% in the Appearance settings tab                    |
| **Narrower chrome**          | Tighter padding on the overlay and chat area for a denser, more focused layout                     |
| **Header model chip**        | Active model displayed as a compact chip in the chat header — click to switch without leaving chat |

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
- **More slash commands:** expanding the existing `/search`, `/screen`, `/think`, `/translate`, `/rewrite`, `/tldr`, `/refine`, `/bullets`, and `/todos` set

### Better AI Control

- **Multiple provider support:** opt in to OpenAI, Anthropic, or any OpenAI-compatible endpoint as an alternative to local Ollama
- **Custom activation shortcut:** change the double-tap trigger to any key or combo you prefer

### Richer Context

- **Voice input:** dictate your question instead of typing
- **Auto-capture screen context:** activate Mate and have it automatically read the active window or selected region as context
- **File and document drop:** drag a PDF, image, or text file directly into Mate as context for your question

---

Have a feature idea? [Open an issue](https://github.com/M31i55a/Mate2.0-Thuki/issues) and let's talk about it.

## License

Windows port copyright 2026 Gioda - Code Artist. Original Thuki copyright 2026 Logan Nguyen. Licensed under the [Apache License, Version 2.0](LICENSE).
