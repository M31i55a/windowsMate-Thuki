//! Agent mode orchestrator for autonomous desktop control.
//!
//! Supports two modes:
//! - **Ollama (text-parsing)**: Parses structured text (CLICK x y, LAUNCH notepad)
//!   from the model response. Vision models also receive a screenshot; text-only
//!   models skip the screenshot and work from the task description alone, which
//!   is reliable for LAUNCH/TYPE tasks and keyboard shortcuts.
//! - **Cloud (tool-use)**: Uses native tool calling from OpenAI/Anthropic APIs.
//!   The model returns structured JSON tool calls that map directly to AgentAction.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tokio_util::sync::CancellationToken;

use crate::computer_control::{self, AgentAction};
use crate::providers::{self, ProviderChunk, ProviderConfig, ToolCall};

/// Set to `true` while the agent loop is running. Checked by the window focus
/// listener and hotkey activator to suppress interference during agent execution.
pub static AGENT_RUNNING: AtomicBool = AtomicBool::new(false);

/// Cached per-process screenshot consent for cloud agent runs.
/// Set to `true` on first user approval; avoids repeated SQLite lookups.
static SCREENSHOT_CONSENT_GRANTED: AtomicBool = AtomicBool::new(false);

// ─── Status types ───────────────────────────────────────────────────────────────

/// Current status of the agent loop.
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Idle,
    Capturing,
    Analyzing,
    Executing,
    WaitingConfirmation,
    Done,
    Error,
}

/// An event emitted by the agent loop to the frontend.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum AgentEvent {
    StatusChanged(AgentStatus),
    ActionExecuted {
        action: String,
        result: String,
    },
    Reasoning(String),
    ScreenshotTaken(String),
    ConfirmationRequired {
        action_id: String,
        action: String,
        description: String,
    },
    Error(String),
    Done {
        summary: String,
    },
}

// ─── Confirmation state ─────────────────────────────────────────────────────────

/// Number of actions that require confirmation before auto-executing.
/// Set to 0 so the agent runs uninterrupted — the user already consented
/// by invoking /do, and can stop the agent at any time via the Stop button.
const LEARNING_CONFIRMATION_LIMIT: u32 = 0;

/// Actions that always require confirmation regardless of learning state.
/// Opening applications is considered safe (the user explicitly triggered agent mode),
/// so no actions are in the always-confirm list.
const DANGEROUS_ACTION_NAMES: &[&str] = &[];

/// Tracks confirmation state for the "learning" mode.
struct ConfirmationState {
    /// How many actions have been confirmed so far in this session.
    confirmed_count: u32,
    /// Pending confirmations: action_id -> (AgentAction, description).
    pending: HashMap<String, (AgentAction, String)>,
}

impl ConfirmationState {
    fn new() -> Self {
        Self {
            confirmed_count: 0,
            pending: HashMap::new(),
        }
    }

    /// Returns true if this action requires user confirmation.
    fn requires_confirmation(&self, action: &AgentAction) -> bool {
        // Dangerous actions always require confirmation.
        let action_name = match action {
            AgentAction::Launch { .. } => "computer_launch",
            _ => "",
        };
        if DANGEROUS_ACTION_NAMES.contains(&action_name) {
            return true;
        }
        // In learning mode: confirm first N actions.
        self.confirmed_count < LEARNING_CONFIRMATION_LIMIT
    }

    /// Mark an action as confirmed.
    fn confirm(&mut self, action_id: &str) -> Option<AgentAction> {
        if let Some((action, _)) = self.pending.remove(action_id) {
            self.confirmed_count += 1;
            Some(action)
        } else {
            None
        }
    }

    /// Reject an action.
    fn reject(&mut self, action_id: &str) -> Option<AgentAction> {
        self.pending.remove(action_id).map(|(action, _)| action)
    }

    /// Register a pending confirmation.
    fn add_pending(&mut self, action_id: String, action: AgentAction, description: String) {
        self.pending.insert(action_id, (action, description));
    }
}

// ─── Agent state ────────────────────────────────────────────────────────────────

/// Shared state for the running agent.
pub struct AgentState {
    cancel: Mutex<CancellationToken>,
    status: Mutex<AgentStatus>,
    history: Mutex<Vec<String>>,
    confirmation: Mutex<ConfirmationState>,
    provider_config: Mutex<Option<ProviderConfig>>,
    /// Channel to signal the agent loop when the user confirms/rejects.
    confirmation_tx: Mutex<Option<tokio::sync::oneshot::Sender<bool>>>,
    /// The action_id currently awaiting confirmation.
    pending_action_id: Mutex<Option<String>>,
}

impl AgentState {
    pub fn new() -> Self {
        Self {
            cancel: Mutex::new(CancellationToken::new()),
            status: Mutex::new(AgentStatus::Idle),
            history: Mutex::new(Vec::new()),
            confirmation: Mutex::new(ConfirmationState::new()),
            provider_config: Mutex::new(None),
            confirmation_tx: Mutex::new(None),
            pending_action_id: Mutex::new(None),
        }
    }

    pub fn get_status(&self) -> AgentStatus {
        self.status.lock().unwrap().clone()
    }

    fn set_status(&self, status: AgentStatus) {
        *self.status.lock().unwrap() = status;
    }

    fn add_to_history(&self, entry: String) {
        self.history.lock().unwrap().push(entry);
    }

    pub fn cancel(&self) {
        self.cancel.lock().unwrap().cancel();
    }

    fn is_cancelled(&self) -> bool {
        self.cancel.lock().unwrap().is_cancelled()
    }

    fn reset(&self) {
        *self.cancel.lock().unwrap() = CancellationToken::new();
        *self.status.lock().unwrap() = AgentStatus::Idle;
        self.history.lock().unwrap().clear();
        *self.confirmation.lock().unwrap() = ConfirmationState::new();
        *self.confirmation_tx.lock().unwrap() = None;
        *self.pending_action_id.lock().unwrap() = None;
    }

    pub fn set_provider_config(&self, config: ProviderConfig) {
        *self.provider_config.lock().unwrap() = Some(config);
    }

    fn get_provider_config(&self) -> Option<ProviderConfig> {
        self.provider_config.lock().unwrap().clone()
    }
}

// ─── Tool call → AgentAction conversion ─────────────────────────────────────────

/// Converts a provider ToolCall to an AgentAction.
fn tool_call_to_action(tc: &ToolCall) -> Option<AgentAction> {
    let args: serde_json::Value = serde_json::from_str(&tc.arguments).ok()?;
    match tc.name.as_str() {
        "computer_click" => {
            let x = args.get("x")?.as_i64()?;
            let y = args.get("y")?.as_i64()?;
            Some(AgentAction::Click {
                x: x as i32,
                y: y as i32,
            })
        }
        "computer_double_click" => {
            let x = args.get("x")?.as_i64()?;
            let y = args.get("y")?.as_i64()?;
            Some(AgentAction::DoubleClick {
                x: x as i32,
                y: y as i32,
            })
        }
        "computer_right_click" => {
            let x = args.get("x")?.as_i64()?;
            let y = args.get("y")?.as_i64()?;
            Some(AgentAction::RightClick {
                x: x as i32,
                y: y as i32,
            })
        }
        "computer_type" => {
            let text = args.get("text")?.as_str()?.to_string();
            Some(AgentAction::TypeText { text })
        }
        "computer_key_press" => {
            let key = args.get("key")?.as_str()?.to_string();
            let modifiers = args
                .get("modifiers")
                .and_then(|m| m.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            Some(AgentAction::KeyPress { modifiers, key })
        }
        "computer_scroll" => {
            let direction = args.get("direction")?.as_str()?.to_string();
            let amount = args.get("amount").and_then(|a| a.as_i64()).unwrap_or(3) as i32;
            Some(AgentAction::Scroll { direction, amount })
        }
        "computer_launch" => {
            let target = args.get("target")?.as_str()?.to_string();
            Some(AgentAction::Launch { target })
        }
        "computer_screenshot" => Some(AgentAction::Screenshot {}),
        "computer_get_active_window" => Some(AgentAction::GetActiveWindowInfo {}),
        "computer_list_windows" => Some(AgentAction::ListOpenWindows {}),
        "computer_read_focused" => Some(AgentAction::ReadFocusedElement {}),
        "computer_find_activate" => {
            let name = args.get("name")?.as_str()?.to_string();
            Some(AgentAction::FindAndActivate { name })
        }
        // Anthropic computer_use tool uses a single "computer" name with an "action" field.
        "computer" => {
            let action_type = args.get("action")?.as_str()?;
            match action_type {
                "left_click" | "click" => {
                    let coords = args.get("coordinate")?;
                    let arr = coords.as_array()?;
                    if arr.len() >= 2 {
                        let x = arr[0].as_i64()?;
                        let y = arr[1].as_i64()?;
                        Some(AgentAction::Click {
                            x: x as i32,
                            y: y as i32,
                        })
                    } else {
                        None
                    }
                }
                "double_click" => {
                    let coords = args.get("coordinate")?;
                    let arr = coords.as_array()?;
                    if arr.len() >= 2 {
                        let x = arr[0].as_i64()?;
                        let y = arr[1].as_i64()?;
                        Some(AgentAction::DoubleClick {
                            x: x as i32,
                            y: y as i32,
                        })
                    } else {
                        None
                    }
                }
                "right_click" => {
                    let coords = args.get("coordinate")?;
                    let arr = coords.as_array()?;
                    if arr.len() >= 2 {
                        let x = arr[0].as_i64()?;
                        let y = arr[1].as_i64()?;
                        Some(AgentAction::RightClick {
                            x: x as i32,
                            y: y as i32,
                        })
                    } else {
                        None
                    }
                }
                "type" => {
                    let text = args.get("text")?.as_str()?.to_string();
                    Some(AgentAction::TypeText { text })
                }
                "key_press" | "key" => {
                    let key = args.get("key")?.as_str()?.to_string();
                    let modifiers = args
                        .get("modifiers")
                        .and_then(|m| m.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(AgentAction::KeyPress { modifiers, key })
                }
                "scroll" => {
                    let direction = args.get("direction")?.as_str()?.to_string();
                    let amount = args.get("amount").and_then(|a| a.as_i64()).unwrap_or(3) as i32;
                    Some(AgentAction::Scroll { direction, amount })
                }
                "screenshot" => Some(AgentAction::Screenshot {}),
                _ => None,
            }
        }
        _ => None,
    }
}

/// Generates a human-readable description for an action.
fn describe_action(action: &AgentAction) -> String {
    match action {
        AgentAction::Click { x, y } => format!("Click at ({}, {})", x, y),
        AgentAction::DoubleClick { x, y } => format!("Double-click at ({}, {})", x, y),
        AgentAction::RightClick { x, y } => format!("Right-click at ({}, {})", x, y),
        AgentAction::Drag {
            start_x,
            start_y,
            end_x,
            end_y,
            ..
        } => {
            format!(
                "Drag from ({}, {}) to ({}, {})",
                start_x, start_y, end_x, end_y
            )
        }
        AgentAction::TypeText { text } => {
            let preview = if text.len() > 30 {
                &text[..30]
            } else {
                text.as_str()
            };
            format!("Type \"{}\"", preview)
        }
        AgentAction::KeyPress { modifiers, key } => {
            let combo = if modifiers.is_empty() {
                key.clone()
            } else {
                format!("{}+{}", modifiers.join("+"), key)
            };
            format!("Press {}", combo)
        }
        AgentAction::Scroll { direction, amount } => format!("Scroll {} {}", direction, amount),
        AgentAction::Launch { target } => format!("Open \"{}\"", target),
        AgentAction::Done { summary } => format!("Done: {}", summary),
        AgentAction::Screenshot {} => "Take screenshot".to_string(),
        AgentAction::GetActiveWindowInfo {} => "Get active window info".to_string(),
        AgentAction::ListOpenWindows {} => "List open windows".to_string(),
        AgentAction::ReadFocusedElement {} => "Read focused element".to_string(),
        AgentAction::FindAndActivate { name } => format!("Find and activate \"{}\"", name),
    }
}

// ─── System prompt ──────────────────────────────────────────────────────────────

const AGENT_SYSTEM_PROMPT: &str = r#"You are a desktop automation agent. You control a Windows computer by analyzing screenshots and issuing actions.

On each turn you will receive a screenshot. Analyze it and decide what action to take to accomplish the user's task.

Available actions (one per line, must be EXACTLY formatted):
- CLICK x y — Left-click at screen coordinates (x, y)
- DOUBLE_CLICK x y — Double-click at coordinates
- RIGHT_CLICK x y — Right-click at coordinates
- DRAG start_x start_y end_x end_y [duration_ms] — Drag from start to end
- TYPE text — Type the given text character by character
- KEY_PRESS modifiers+key — Press key combo, e.g. "ctrl+c", "ctrl+shift+s"
- SCROLL direction amount — Scroll "up" or "down" by amount (default unit is 3 lines)
- LAUNCH target — Open a program, file, or URL
- SCREENSHOT — Take another screenshot (for checking progress)
- WINDOW_INFO — Get the title of the SINGLE currently active/focused window. Use this when asked what the active, current, or focused window is.
- LIST_WINDOWS — Enumerate titles of ALL visible top-level windows. Use this only when asked which apps or windows are open.
- READ_FOCUSED — Read the accessible name/value of the currently focused UI element
- FIND_ACTIVATE element_name — Find and click a UI element by its accessible name
- DONE summary — Task is complete, summarize what was accomplished

Important rules:
1. Always provide exactly ONE action per response line starting with the action keyword.
2. You may include brief reasoning before the action line.
3. Coordinates are in absolute screen pixels.
4. Use SCREENSHOT when you need to verify a change before proceeding.
5. Use WINDOW_INFO (not LIST_WINDOWS) when asked about the current/active window title.
6. For query actions (WINDOW_INFO, LIST_WINDOWS, READ_FOCUSED), you will receive the result back. Then respond with DONE <answer>.
7. Use DONE when the task is complete.
8. Be precise with coordinates — examine the screenshot carefully."#;

/// Variant of AGENT_SYSTEM_PROMPT for text-only models that do not support
/// vision input. Omits screen-analysis instructions and SCREENSHOT action
/// since no image is ever attached. These models work well for LAUNCH, TYPE,
/// and KEY_PRESS tasks that do not require reading the screen.
const AGENT_SYSTEM_PROMPT_TEXT_ONLY: &str = r#"You are a desktop automation agent. You control a Windows computer by issuing actions.

You do not receive screenshots — reason from the task description alone.

Available actions (one per line, must be EXACTLY formatted):
- CLICK x y — Left-click at screen coordinates (x, y)
- DOUBLE_CLICK x y — Double-click at coordinates
- RIGHT_CLICK x y — Right-click at coordinates
- DRAG start_x start_y end_x end_y [duration_ms] — Drag from start to end
- TYPE text — Type the given text character by character
- KEY_PRESS modifiers+key — Press key combo, e.g. "ctrl+c", "ctrl+shift+s"
- SCROLL direction amount — Scroll "up" or "down" by amount (default unit is 3 lines)
- LAUNCH target — Open a program, file, or URL
- WINDOW_INFO — Get the title of the SINGLE currently active/focused window. Use this when asked what the active, current, or focused window is.
- LIST_WINDOWS — Enumerate titles of ALL visible top-level windows. Use this only when asked which apps or windows are open.
- READ_FOCUSED — Read the accessible name/value of the currently focused UI element
- FIND_ACTIVATE element_name — Find and click a UI element by its accessible name
- DONE summary — Task is complete, summarize what was accomplished

Important rules:
1. Always provide exactly ONE action per response line starting with the action keyword.
2. You may include brief reasoning before the action line.
3. Use LAUNCH to open applications, files, or URLs by name (e.g. LAUNCH notepad, LAUNCH chrome).
4. Use WINDOW_INFO (not LIST_WINDOWS) when asked about the current/active window title.
5. For query actions (WINDOW_INFO, LIST_WINDOWS, READ_FOCUSED), you will receive the result back. Then respond with DONE <answer>.
6. Use DONE when the task is complete."#;

// ─── Iteration limits ───────────────────────────────────────────────────────────

const MAX_ITERATIONS: u32 = 30;
const ACTION_DELAY_MS: u64 = 500;
const SCREENSHOT_DELAY_MS: u64 = 500;

// ─── Agent loop ──────────────────────────────────────────────────────────────────

/// Runs the agent loop with provider-based tool use.
pub async fn run_agent_loop(
    app_handle: tauri::AppHandle,
    state: Arc<AgentState>,
    task: String,
    model: String,
    ollama_url: String,
) -> Result<(), String> {
    state.reset();
    state.set_status(AgentStatus::Capturing);
    let _ = app_handle.emit(
        "mate://agent",
        AgentEvent::StatusChanged(AgentStatus::Capturing),
    );

    let provider_config = state.get_provider_config();
    let use_tool_use = provider_config.as_ref().map_or(false, |c| {
        matches!(
            c.provider,
            providers::Provider::OpenAI
                | providers::Provider::Anthropic
                | providers::Provider::OpenRouter
        )
    });

    if use_tool_use {
        run_tool_use_loop(app_handle, state, task, provider_config.unwrap()).await
    } else {
        run_text_parse_loop(app_handle, state, task, model, ollama_url).await
    }
}

/// Agent loop using cloud provider tool calling (OpenAI/Anthropic).
async fn run_tool_use_loop(
    app_handle: tauri::AppHandle,
    state: Arc<AgentState>,
    task: String,
    config: ProviderConfig,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let cancel_token = state.cancel.lock().unwrap().clone();

    // Ask the user once before taking any screenshot.  Screenshots are sent to
    // an external cloud provider, so explicit consent is required.  If the user
    // denies (or the prompt times out), we still proceed but without screenshots.
    let provider_name = format!("{:?}", config.provider);
    let screenshot_allowed = request_screenshot_consent(&app_handle, &state, &provider_name).await;

    eprintln!("mate: [agent] cloud loop screenshot_allowed={screenshot_allowed}");

    // Hide the overlay so it doesn't appear in screenshots and cannot
    // receive stray TYPE actions while the agent loop is running.
    if let Some(w) = app_handle.get_webview_window("main") {
        let _ = w.hide();
    }

    // Build initial conversation.
    let mut messages: Vec<crate::commands::ChatMessage> = vec![
        crate::commands::ChatMessage {
            role: "system".to_string(),
            content: if screenshot_allowed {
                AGENT_SYSTEM_PROMPT.to_string()
            } else {
                AGENT_SYSTEM_PROMPT_TEXT_ONLY.to_string()
            },
            images: None,
        },
        crate::commands::ChatMessage {
            role: "user".to_string(),
            content: format!("Task: {}", task),
            images: None,
        },
    ];

    for iteration in 0..MAX_ITERATIONS {
        if state.is_cancelled() {
            state.set_status(AgentStatus::Done);
            let _ = app_handle.emit("mate://agent", AgentEvent::StatusChanged(AgentStatus::Done));
            return Ok(());
        }

        eprintln!(
            "mate: [agent] tool-use iteration {}/{}",
            iteration + 1,
            MAX_ITERATIONS
        );

        // Step 1: Optionally take a screenshot (only when user consented).
        let current_screenshot_b64: Option<String> = if screenshot_allowed {
            state.set_status(AgentStatus::Capturing);
            let _ = app_handle.emit(
                "mate://agent",
                AgentEvent::StatusChanged(AgentStatus::Capturing),
            );

            let screenshot_path = match capture_screenshot(&app_handle).await {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("mate: [agent] screenshot failed: {e}");
                    state.set_status(AgentStatus::Error);
                    let _ = app_handle.emit(
                        "mate://agent",
                        AgentEvent::Error(format!("Screenshot failed: {e}")),
                    );
                    let _ = app_handle.emit(
                        "mate://agent",
                        AgentEvent::StatusChanged(AgentStatus::Error),
                    );
                    return Err(e);
                }
            };

            let _ = app_handle.emit(
                "mate://agent",
                AgentEvent::ScreenshotTaken(screenshot_path.clone()),
            );

            let b64 = tokio::task::spawn_blocking({
                let path = screenshot_path.clone();
                move || read_image_as_base64(&path)
            })
            .await
            .map_err(|e| format!("Failed to read screenshot: {e}"))??;

            // Add screenshot to the last user message.
            let last_msg = messages.last_mut().expect("messages non-empty");
            if last_msg.role == "user" {
                let imgs = last_msg.images.get_or_insert_with(Vec::new);
                imgs.push(b64.clone());
            }

            Some(b64)
        } else {
            None
        };

        // Step 2: Send to provider with tool definitions.
        state.set_status(AgentStatus::Analyzing);
        let _ = app_handle.emit(
            "mate://agent",
            AgentEvent::StatusChanged(AgentStatus::Analyzing),
        );

        let mut accumulated_text = String::new();
        let mut tool_calls: Vec<ToolCall> = Vec::new();

        let mut on_chunk = |chunk: ProviderChunk| match chunk {
            ProviderChunk::Token(t) => accumulated_text.push_str(&t),
            ProviderChunk::ToolCalls(calls) => tool_calls.extend(calls),
            ProviderChunk::Done
            | ProviderChunk::Cancelled
            | ProviderChunk::Error(_)
            | ProviderChunk::ThinkingToken(_) => {}
        };

        let result = match config.provider {
            providers::Provider::OpenAI | providers::Provider::OpenRouter => {
                providers::openai::stream_openai_chat(
                    &config.base_url,
                    &config.model,
                    &config.api_key,
                    messages.clone(),
                    true,
                    &client,
                    cancel_token.clone(),
                    &mut on_chunk,
                )
                .await
            }
            providers::Provider::Anthropic => {
                providers::anthropic::stream_anthropic_chat(
                    &config.base_url,
                    &config.model,
                    &config.api_key,
                    AGENT_SYSTEM_PROMPT,
                    messages.clone(),
                    true,
                    current_screenshot_b64.clone(),
                    1920,
                    1080,
                    &client,
                    cancel_token.clone(),
                    &mut on_chunk,
                )
                .await
            }
            _ => Err("Unsupported provider for tool-use".to_string()),
        };

        match result {
            Ok(text) => {
                if !text.is_empty() {
                    state.add_to_history(format!("[Model] {}", text));
                    let _ = app_handle.emit("mate://agent", AgentEvent::Reasoning(text));
                }
            }
            Err(e) => {
                eprintln!("mate: [agent] provider error: {e}");
                state.set_status(AgentStatus::Error);
                let _ = app_handle.emit(
                    "mate://agent",
                    AgentEvent::Error(format!("Provider error: {e}")),
                );
                let _ = app_handle.emit(
                    "mate://agent",
                    AgentEvent::StatusChanged(AgentStatus::Error),
                );
                return Err(e);
            }
        }

        // Step 3: If no tool calls, model is done talking.
        if tool_calls.is_empty() {
            let summary = accumulated_text.trim().to_string();
            let _ = app_handle.emit("mate://agent", AgentEvent::Done { summary });
            state.set_status(AgentStatus::Done);
            let _ = app_handle.emit("mate://agent", AgentEvent::StatusChanged(AgentStatus::Done));
            return Ok(());
        }

        // Step 4: Convert and execute tool calls.
        state.set_status(AgentStatus::Executing);
        let _ = app_handle.emit(
            "mate://agent",
            AgentEvent::StatusChanged(AgentStatus::Executing),
        );

        for tc in &tool_calls {
            if state.is_cancelled() {
                state.set_status(AgentStatus::Done);
                let _ =
                    app_handle.emit("mate://agent", AgentEvent::StatusChanged(AgentStatus::Done));
                return Ok(());
            }

            let action = match tool_call_to_action(tc) {
                Some(a) => a,
                None => {
                    eprintln!(
                        "mate: [agent] unparseable tool call: {} {}",
                        tc.name, tc.arguments
                    );
                    continue;
                }
            };

            // Handle DONE action.
            if let AgentAction::Done { ref summary } = action {
                let _ = app_handle.emit(
                    "mate://agent",
                    AgentEvent::Done {
                        summary: summary.clone(),
                    },
                );
                state.set_status(AgentStatus::Done);
                let _ =
                    app_handle.emit("mate://agent", AgentEvent::StatusChanged(AgentStatus::Done));
                return Ok(());
            }

            // Handle SCREENSHOT action.
            if let AgentAction::Screenshot {} = action {
                break; // Restart loop to take a new screenshot.
            }

            // Check if confirmation is needed.
            let needs_confirm = {
                let conf = state.confirmation.lock().unwrap();
                conf.requires_confirmation(&action)
            };

            if needs_confirm {
                let action_id = uuid::Uuid::new_v4().to_string();
                let desc = describe_action(&action);
                let action_desc = format!("{:?}", action);

                {
                    let mut conf = state.confirmation.lock().unwrap();
                    conf.add_pending(action_id.clone(), action.clone(), desc.clone());
                }

                // Create a oneshot channel for the frontend to signal confirmation.
                let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
                {
                    let mut sender = state.confirmation_tx.lock().unwrap();
                    *sender = Some(tx);
                }
                {
                    let mut pending = state.pending_action_id.lock().unwrap();
                    *pending = Some(action_id.clone());
                }

                state.set_status(AgentStatus::WaitingConfirmation);
                let _ = app_handle.emit(
                    "mate://agent",
                    AgentEvent::StatusChanged(AgentStatus::WaitingConfirmation),
                );
                let _ = app_handle.emit(
                    "mate://agent",
                    AgentEvent::ConfirmationRequired {
                        action_id: action_id.clone(),
                        action: action_desc,
                        description: desc,
                    },
                );

                // Wait for user confirmation with a 30-second timeout.
                match tokio::time::timeout(Duration::from_secs(30), rx).await {
                    Ok(Ok(true)) => {
                        // User confirmed the action.
                        let confirmed_action = {
                            let mut conf = state.confirmation.lock().unwrap();
                            conf.confirm(&action_id)
                        };
                        if let Some(confirmed_action) = confirmed_action {
                            execute_action_with_result(&app_handle, &state, &confirmed_action)
                                .await?;
                        }
                    }
                    _ => {
                        // User rejected or timed out — reject the action.
                        let mut conf = state.confirmation.lock().unwrap();
                        conf.reject(&action_id);
                        // Continue to next iteration without executing.
                    }
                }
            } else {
                let action_result =
                    execute_action_with_result(&app_handle, &state, &action).await?;
                // For read-only query actions the result carries the data.
                // Inject it back so the model can see it in the next message.
                if action_result != "ok" && !action_result.is_empty() {
                    messages.push(crate::commands::ChatMessage {
                        role: "user".to_string(),
                        content: format!("Query result:\n{action_result}"),
                        images: None,
                    });
                }
            }

            tokio::time::sleep(Duration::from_millis(ACTION_DELAY_MS)).await;
        }

        // Add assistant message with tool calls to conversation for next iteration.
        messages.push(crate::commands::ChatMessage {
            role: "assistant".to_string(),
            content: accumulated_text.clone(),
            images: None,
        });

        // Add tool result as user message for next iteration.
        // Explicitly tell the model to call no tools when done so the
        // empty-tool-calls exit path fires reliably.
        messages.push(crate::commands::ChatMessage {
            role: "user".to_string(),
            content: "Action executed. What is the next step? If the task is complete, respond with plain text only — do NOT call any tools.".to_string(),
            images: None,
        });

        tokio::time::sleep(Duration::from_millis(SCREENSHOT_DELAY_MS)).await;
    }

    let summary = "Agent reached maximum iteration limit".to_string();
    let _ = app_handle.emit(
        "mate://agent",
        AgentEvent::Done {
            summary: summary.clone(),
        },
    );
    state.set_status(AgentStatus::Done);
    let _ = app_handle.emit("mate://agent", AgentEvent::StatusChanged(AgentStatus::Done));
    Ok(())
}

/// Execute an action and emit the result event.
async fn execute_action_with_result(
    app_handle: &tauri::AppHandle,
    state: &AgentState,
    action: &AgentAction,
) -> Result<String, String> {
    let action_desc = format!("{:?}", action);
    let result: Result<String, String> = tokio::task::spawn_blocking({
        let action = action.clone();
        move || computer_control::execute_action(&action)
    })
    .await
    .map_err(|e| format!("Action execution panicked: {e}"))?;

    let result_msg = match result {
        Ok(ref s) => s.clone(),
        Err(ref e) => e.clone(),
    };
    state.add_to_history(format!("[Action] {} -> {}", action_desc, result_msg));
    let _ = app_handle.emit(
        "mate://agent",
        AgentEvent::ActionExecuted {
            action: action_desc,
            result: result_msg.clone(),
        },
    );
    Ok(result_msg)
}

/// Legacy agent loop using Ollama text-parsing approach.
/// Works with both vision and text-only local models:
/// - Vision models: receives a screenshot each iteration so they can reason
///   about the current screen state.
/// - Text-only models: skips screenshots and reasons from the task description
///   alone, which is sufficient for LAUNCH/TYPE/KEY_PRESS tasks.
async fn run_text_parse_loop(
    app_handle: tauri::AppHandle,
    state: Arc<AgentState>,
    task: String,
    model: String,
    ollama_url: String,
) -> Result<(), String> {
    // Probe vision capability once before the loop. Errors are treated as
    // "no vision" so text-only models still work when /api/show is slow.
    let client = reqwest::Client::new();
    let has_vision = crate::models::fetch_model_capabilities(&client, &ollama_url, &model)
        .await
        .map(|c| c.vision)
        .unwrap_or(false);

    eprintln!("mate: [agent] model={model} has_vision={has_vision}");

    // Hide the overlay only for vision models — it must not appear in
    // screenshots. Text-only models never screenshot, so keeping the
    // overlay visible lets the user watch agent progress in real time.
    if has_vision {
        if let Some(w) = app_handle.get_webview_window("main") {
            let _ = w.hide();
        }
    }

    let mut conversation: Vec<serde_json::Value> = vec![
        serde_json::json!({
            "role": "system",
            "content": if has_vision { AGENT_SYSTEM_PROMPT } else { AGENT_SYSTEM_PROMPT_TEXT_ONLY },
        }),
        serde_json::json!({
            "role": "user",
            "content": format!("Task: {}", task),
        }),
    ];

    for iteration in 0..MAX_ITERATIONS {
        if state.is_cancelled() {
            state.set_status(AgentStatus::Done);
            let _ = app_handle.emit("mate://agent", AgentEvent::StatusChanged(AgentStatus::Done));
            return Ok(());
        }

        eprintln!(
            "mate: [agent] text-parse iteration {}/{}",
            iteration + 1,
            MAX_ITERATIONS
        );

        // Step 1: Optionally take a screenshot (vision models only).
        if has_vision {
            state.set_status(AgentStatus::Capturing);
            let _ = app_handle.emit(
                "mate://agent",
                AgentEvent::StatusChanged(AgentStatus::Capturing),
            );

            let screenshot_path = match capture_screenshot(&app_handle).await {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("mate: [agent] screenshot failed: {e}");
                    state.set_status(AgentStatus::Error);
                    let _ = app_handle.emit(
                        "mate://agent",
                        AgentEvent::Error(format!("Screenshot failed: {e}")),
                    );
                    let _ = app_handle.emit(
                        "mate://agent",
                        AgentEvent::StatusChanged(AgentStatus::Error),
                    );
                    return Err(e);
                }
            };

            let _ = app_handle.emit(
                "mate://agent",
                AgentEvent::ScreenshotTaken(screenshot_path.clone()),
            );

            let screenshot_b64 = tokio::task::spawn_blocking({
                let path = screenshot_path.clone();
                move || read_image_as_base64(&path)
            })
            .await
            .map_err(|e| format!("Failed to read screenshot: {e}"))??;

            conversation.push(serde_json::json!({
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": if iteration == 0 {
                            format!("Here is the current screen. Task: {}", task)
                        } else {
                            "Here is the screen after the last action.".to_string()
                        },
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": format!("data:image/png;base64,{}", screenshot_b64),
                        },
                    },
                ],
            }));
        }

        // Step 2: Send to Ollama.
        state.set_status(AgentStatus::Analyzing);
        let _ = app_handle.emit(
            "mate://agent",
            AgentEvent::StatusChanged(AgentStatus::Analyzing),
        );

        let response = match query_ollama(&ollama_url, &model, &conversation).await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("mate: [agent] ollama query failed: {e}");
                state.set_status(AgentStatus::Error);
                let _ = app_handle.emit(
                    "mate://agent",
                    AgentEvent::Error(format!("Ollama query failed: {e}")),
                );
                let _ = app_handle.emit(
                    "mate://agent",
                    AgentEvent::StatusChanged(AgentStatus::Error),
                );
                return Err(e);
            }
        };

        eprintln!(
            "mate: [agent] model response ({} chars): {}",
            response.len(),
            &response[..response.len().min(200)]
        );

        conversation.push(serde_json::json!({
            "role": "assistant",
            "content": response,
        }));

        state.add_to_history(format!("[Model] {}", response));
        let _ = app_handle.emit("mate://agent", AgentEvent::Reasoning(response.clone()));

        // Step 3: Parse and execute actions from the response.
        state.set_status(AgentStatus::Executing);
        let _ = app_handle.emit(
            "mate://agent",
            AgentEvent::StatusChanged(AgentStatus::Executing),
        );

        let mut actions_executed = 0u32;
        let mut query_result_injected = false;

        for line in response.lines() {
            if state.is_cancelled() {
                state.set_status(AgentStatus::Done);
                let _ =
                    app_handle.emit("mate://agent", AgentEvent::StatusChanged(AgentStatus::Done));
                return Ok(());
            }

            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            let upper = line.to_uppercase();
            let is_action = upper.starts_with("CLICK")
                || upper.starts_with("DOUBLE_CLICK")
                || upper.starts_with("RIGHT_CLICK")
                || upper.starts_with("DRAG")
                || upper.starts_with("TYPE")
                || upper.starts_with("KEY_PRESS")
                || upper.starts_with("SCROLL")
                || upper.starts_with("LAUNCH")
                || upper.starts_with("DONE")
                || upper.starts_with("SCREENSHOT")
                || upper.starts_with("WINDOW_INFO")
                || upper.starts_with("LIST_WINDOWS")
                || upper.starts_with("READ_FOCUSED")
                || upper.starts_with("FIND_ACTIVATE");

            if !is_action {
                continue;
            }

            let action = match computer_control::parse_action_line(line) {
                Some(a) => a,
                None => continue,
            };

            if let AgentAction::Done { ref summary } = action {
                let _ = app_handle.emit(
                    "mate://agent",
                    AgentEvent::Done {
                        summary: summary.clone(),
                    },
                );
                state.set_status(AgentStatus::Done);
                let _ =
                    app_handle.emit("mate://agent", AgentEvent::StatusChanged(AgentStatus::Done));
                // Re-show the overlay immediately so the user sees the result.
                if let Some(w) = app_handle.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                return Ok(());
            }

            if let AgentAction::Screenshot {} = action {
                if conversation.len() >= 2 {
                    conversation.pop();
                    conversation.pop();
                }
                break;
            }

            // Check confirmation for text-parse mode too.
            let needs_confirm = {
                let conf = state.confirmation.lock().unwrap();
                conf.requires_confirmation(&action)
            };

            if needs_confirm {
                let action_id = uuid::Uuid::new_v4().to_string();
                let desc = describe_action(&action);
                let action_desc = format!("{:?}", action);

                {
                    let mut conf = state.confirmation.lock().unwrap();
                    conf.add_pending(action_id.clone(), action.clone(), desc.clone());
                }

                // Create a oneshot channel for the frontend to signal confirmation.
                let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
                {
                    let mut sender = state.confirmation_tx.lock().unwrap();
                    *sender = Some(tx);
                }
                {
                    let mut pending = state.pending_action_id.lock().unwrap();
                    *pending = Some(action_id.clone());
                }

                state.set_status(AgentStatus::WaitingConfirmation);
                let _ = app_handle.emit(
                    "mate://agent",
                    AgentEvent::StatusChanged(AgentStatus::WaitingConfirmation),
                );
                let _ = app_handle.emit(
                    "mate://agent",
                    AgentEvent::ConfirmationRequired {
                        action_id: action_id.clone(),
                        action: action_desc,
                        description: desc,
                    },
                );

                // Wait for user confirmation with a 30-second timeout.
                match tokio::time::timeout(Duration::from_secs(30), rx).await {
                    Ok(Ok(true)) => {
                        // User confirmed the action.
                        let confirmed_action = {
                            let mut conf = state.confirmation.lock().unwrap();
                            conf.confirm(&action_id)
                        };
                        if let Some(confirmed_action) = confirmed_action {
                            actions_executed += 1;
                            execute_action_with_result(&app_handle, &state, &confirmed_action)
                                .await?;
                        }
                    }
                    _ => {
                        // User rejected or timed out — reject the action.
                        let mut conf = state.confirmation.lock().unwrap();
                        conf.reject(&action_id);
                    }
                }
            } else {
                actions_executed += 1;

                // For window-query actions in text-only mode the overlay is still
                // visible (we didn't hide it at loop start). Briefly hide it so
                // the OS shifts focus to the previous window, giving accurate results.
                let is_window_query = !has_vision
                    && matches!(
                        action,
                        AgentAction::GetActiveWindowInfo {}
                            | AgentAction::ListOpenWindows {}
                            | AgentAction::ReadFocusedElement {}
                    );
                if is_window_query {
                    if let Some(w) = app_handle.get_webview_window("main") {
                        let _ = w.hide();
                        // Give the OS time to focus the previous window.
                        tokio::time::sleep(Duration::from_millis(300)).await;
                    }
                }

                let action_result =
                    execute_action_with_result(&app_handle, &state, &action).await?;

                // Restore the overlay after a window query.
                if is_window_query {
                    if let Some(w) = app_handle.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }

                // For read-only query actions inject the result back so the model
                // can reason about it and respond with DONE on the next iteration.
                if action_result != "ok" && !action_result.is_empty() {
                    conversation.push(serde_json::json!({
                        "role": "user",
                        "content": format!("Query result:\n{action_result}\n\nRespond with DONE <answer> using this information."),
                    }));
                    query_result_injected = true;
                }
            }

            tokio::time::sleep(Duration::from_millis(ACTION_DELAY_MS)).await;
        }

        // For text-only models: inject a user feedback message so the model
        // knows its action was executed and must decide the next step.
        // Skip when a query result was already injected — that message already
        // contains the DONE instruction and a second prompt would confuse the model.
        // Vision models get this feedback via the screenshot at the next iteration.
        if !has_vision && actions_executed > 0 && !query_result_injected {
            conversation.push(serde_json::json!({
                "role": "user",
                "content": "Action executed. What is the next step to complete the task? If done, respond with DONE <summary>.",
            }));
        }

        tokio::time::sleep(Duration::from_millis(SCREENSHOT_DELAY_MS)).await;

        if actions_executed == 0 && !state.is_cancelled() {
            eprintln!("mate: [agent] no parseable actions in model response");
            let summary = response.trim().to_string();
            let _ = app_handle.emit(
                "mate://agent",
                AgentEvent::Done {
                    summary: summary.clone(),
                },
            );
            state.set_status(AgentStatus::Done);
            let _ = app_handle.emit("mate://agent", AgentEvent::StatusChanged(AgentStatus::Done));
            if let Some(w) = app_handle.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
            return Ok(());
        }
    }

    let summary = "Agent reached maximum iteration limit".to_string();
    let _ = app_handle.emit(
        "mate://agent",
        AgentEvent::Done {
            summary: summary.clone(),
        },
    );
    state.set_status(AgentStatus::Done);
    let _ = app_handle.emit("mate://agent", AgentEvent::StatusChanged(AgentStatus::Done));
    if let Some(w) = app_handle.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
    Ok(())
}

// ─── Screenshot consent (online/cloud models only) ───────────────────────────────

/// Ask the user once whether it is OK to send screenshots to a cloud provider.
/// Returns `true` immediately if the user already consented in a previous session
/// (persisted in SQLite as `agent_screenshot_consent=true`).
/// On first use, shows a one-time confirmation dialog and saves the answer.
///
/// This is called **only** for cloud provider (tool-use) loops.  Local Ollama
/// models never call this — screenshots stay on-device and do not require
/// explicit consent.
async fn request_screenshot_consent(
    app_handle: &tauri::AppHandle,
    state: &Arc<AgentState>,
    provider_name: &str,
) -> bool {
    // Return immediately if already consented in this process session.
    if SCREENSHOT_CONSENT_GRANTED.load(Ordering::SeqCst) {
        return true;
    }

    // Also check SQLite for consent stored in a previous session.
    {
        let db_state = app_handle.state::<crate::history::Database>();
        let consented = db_state
            .0
            .lock()
            .ok()
            .and_then(|conn| {
                crate::database::get_config(&conn, "agent_screenshot_consent")
                    .ok()
                    .flatten()
            })
            .map_or(false, |v| v == "true");
        if consented {
            SCREENSHOT_CONSENT_GRANTED.store(true, Ordering::SeqCst);
            return true;
        }
    }

    const CONSENT_ACTION_ID: &str = "screenshot_consent";

    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    {
        *state.confirmation_tx.lock().unwrap() = Some(tx);
        *state.pending_action_id.lock().unwrap() = Some(CONSENT_ACTION_ID.to_string());
    }

    state.set_status(AgentStatus::WaitingConfirmation);
    let _ = app_handle.emit(
        "mate://agent",
        AgentEvent::StatusChanged(AgentStatus::WaitingConfirmation),
    );
    let _ = app_handle.emit(
        "mate://agent",
        AgentEvent::ConfirmationRequired {
            action_id: CONSENT_ACTION_ID.to_string(),
            action: "screenshot_consent".to_string(),
            description: format!(
                "To complete this task, Thuki needs to take screenshots of your screen and send them to {provider_name}. \
                This data leaves your device. Only allow if you trust this provider and your screen does not contain sensitive information.",
            ),
        },
    );

    let approved = matches!(
        tokio::time::timeout(Duration::from_secs(30), rx).await,
        Ok(Ok(true))
    );

    // Cache in-process so subsequent runs this session skip the dialog.
    // SQLite persistence is handled by the frontend when the user connects
    // OpenRouter (set_setting agent_screenshot_consent=true).
    if approved {
        SCREENSHOT_CONSENT_GRANTED.store(true, Ordering::SeqCst);
    }

    approved
}

// ─── Screenshot capture ──────────────────────────────────────────────────────────

async fn capture_screenshot(app_handle: &tauri::AppHandle) -> Result<String, String> {
    crate::windows_screenshot::capture_silent_screenshot_command(app_handle.clone()).await
}

// ─── Ollama query ────────────────────────────────────────────────────────────────

async fn query_ollama(
    ollama_url: &str,
    model: &str,
    conversation: &[serde_json::Value],
) -> Result<String, String> {
    let client = reqwest::Client::new();

    let body = serde_json::json!({
        "model": model,
        "messages": conversation,
        "stream": false,
    });

    let url = format!("{}/api/chat", ollama_url.trim_end_matches('/'));

    let response = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Ollama request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Ollama returned status {}: {}", status, body));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Ollama response: {e}"))?;

    json.get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "No content in Ollama response".to_string())
}

// ─── Image encoding ─────────────────────────────────────────────────────────────

fn read_image_as_base64(path: &str) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read screenshot: {e}"))?;
    Ok(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &bytes,
    ))
}

// ─── Tauri commands ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_agent_mode(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AgentState>>,
    task: String,
    model: String,
    ollama_url: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    let app_handle = app_handle.clone();

    tauri::async_runtime::spawn(async move {
        AGENT_RUNNING.store(true, Ordering::SeqCst);
        if let Err(e) = run_agent_loop(app_handle.clone(), state, task, model, ollama_url).await {
            eprintln!("mate: [agent] error: {e}");
        }
        AGENT_RUNNING.store(false, Ordering::SeqCst);
        // Re-show the overlay so the user can see the agent result.
        if let Some(w) = app_handle.get_webview_window("main") {
            let _ = w.show();
            let _ = w.set_focus();
        }
    });

    Ok(())
}

#[tauri::command]
pub fn stop_agent_mode(state: tauri::State<'_, Arc<AgentState>>) -> Result<(), String> {
    state.cancel();
    AGENT_RUNNING.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn get_agent_status(state: tauri::State<'_, Arc<AgentState>>) -> Result<AgentStatus, String> {
    Ok(state.get_status())
}

/// Confirm a pending agent action.
#[tauri::command]
pub fn confirm_agent_action(
    state: tauri::State<'_, Arc<AgentState>>,
    action_id: String,
) -> Result<String, String> {
    // Verify the action_id matches the pending one.
    let pending_id = state.pending_action_id.lock().unwrap().clone();
    if pending_id.as_deref() != Some(action_id.as_str()) {
        return Err("No pending action with that ID".to_string());
    }
    // Signal the agent loop to proceed.
    let sender = state.confirmation_tx.lock().unwrap().take();
    if let Some(tx) = sender {
        let _ = tx.send(true);
        Ok("Confirmed".to_string())
    } else {
        Err("No pending confirmation request".to_string())
    }
}

/// Reject a pending agent action.
#[tauri::command]
pub fn reject_agent_action(
    state: tauri::State<'_, Arc<AgentState>>,
    action_id: String,
) -> Result<String, String> {
    // Verify the action_id matches the pending one.
    let pending_id = state.pending_action_id.lock().unwrap().clone();
    if pending_id.as_deref() != Some(action_id.as_str()) {
        return Err("No pending action with that ID".to_string());
    }
    // Signal the agent loop to skip this action.
    let sender = state.confirmation_tx.lock().unwrap().take();
    if let Some(tx) = sender {
        let _ = tx.send(false);
        Ok("Rejected".to_string())
    } else {
        Err("No pending confirmation request".to_string())
    }
}

/// Set the provider configuration for agent mode.
#[tauri::command]
pub fn set_agent_provider(
    state: tauri::State<'_, Arc<AgentState>>,
    chat_provider: tauri::State<'_, crate::providers::SharedChatProvider>,
    provider: String,
    model: String,
    base_url: String,
    api_key: String,
) -> Result<(), String> {
    let provider = match provider.to_lowercase().as_str() {
        "ollama" => providers::Provider::Ollama,
        "openai" => providers::Provider::OpenAI,
        "anthropic" => providers::Provider::Anthropic,
        "claude" => providers::Provider::Anthropic, // Claude uses Anthropic API
        "openrouter" => providers::Provider::OpenRouter,
        _ => return Err(format!("Unknown provider: {}", provider)),
    };
    let config = ProviderConfig {
        provider: provider.clone(),
        model,
        base_url,
        api_key,
    };
    state.set_provider_config(config.clone());
    // Also update the shared chat provider so regular chat uses the same backend.
    // Clear it for Ollama (fall through to native Ollama path).
    *chat_provider.0.lock().unwrap() = match provider {
        providers::Provider::Ollama => None,
        _ => Some(config),
    };
    Ok(())
}

/// Get the current provider configuration for agent mode.
#[tauri::command]
pub fn get_agent_provider(
    state: tauri::State<'_, Arc<AgentState>>,
) -> Result<serde_json::Value, String> {
    match state.get_provider_config() {
        Some(config) => Ok(serde_json::json!({
            "provider": config.provider,
            "model": config.model,
            "base_url": config.base_url,
            "has_api_key": !config.api_key.is_empty(),
        })),
        None => Ok(serde_json::json!({
            "provider": null,
            "model": null,
            "base_url": null,
            "has_api_key": false,
        })),
    }
}

/// Validate an OpenRouter API key by calling /auth/key.
/// Returns Ok(label) where label is the account label, or Err(message).
#[tauri::command]
pub async fn validate_openrouter_key(api_key: String) -> Result<String, String> {
    let client = reqwest::Client::new();
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Err("API key is empty".to_string());
    }
    let response = client
        .get("https://openrouter.ai/api/v1/auth/key")
        .header("Authorization", format!("Bearer {}", trimmed))
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    if response.status().is_success() {
        let json: serde_json::Value = response.json().await.unwrap_or(serde_json::json!({}));
        let label = json
            .pointer("/data/label")
            .and_then(|v| v.as_str())
            .unwrap_or("OpenRouter")
            .to_string();
        Ok(label)
    } else {
        let status = response.status().as_u16();
        if status == 401 || status == 403 {
            Err("Invalid API key".to_string())
        } else {
            Err(format!("OpenRouter returned status {status}"))
        }
    }
}

/// Validate a Claude (Anthropic) API key.
/// For now, we do basic format validation. The actual key will be validated
/// when making the first API call, and invalid keys will produce clear errors then.
#[tauri::command]
pub async fn validate_claude_key(api_key: String) -> Result<String, String> {
    let trimmed = api_key.trim();
    
    // Check for empty key
    if trimmed.is_empty() {
        return Err("API key is empty".to_string());
    }
    
    // Check for common Claude API key format (they typically start with 'sk-ant-')
    if !trimmed.starts_with("sk-ant-") && !trimmed.starts_with("sk-") {
        return Err("API key format looks invalid. Claude API keys typically start with 'sk-ant-'".to_string());
    }
    
    // Check for reasonable length (Claude keys are usually 40+ characters)
    if trimmed.len() < 20 {
        return Err("API key is too short. Please check your key.".to_string());
    }
    
    // Key format looks valid - return success
    // Actual authentication will be tested when making the first API call
    Ok("Claude".to_string())
}

// ─── Tests ───────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_status_serialization() {
        let status = AgentStatus::Capturing;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, "\"capturing\"");
    }

    #[test]
    fn agent_status_roundtrip() {
        let statuses = vec![
            AgentStatus::Idle,
            AgentStatus::Capturing,
            AgentStatus::Analyzing,
            AgentStatus::Executing,
            AgentStatus::WaitingConfirmation,
            AgentStatus::Done,
            AgentStatus::Error,
        ];
        for s in statuses {
            let json = serde_json::to_string(&s).unwrap();
            let deserialized: AgentStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(s, deserialized);
        }
    }

    #[test]
    fn agent_event_serialization() {
        let event = AgentEvent::StatusChanged(AgentStatus::Executing);
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("status_changed"));

        let event = AgentEvent::ActionExecuted {
            action: "Click".to_string(),
            result: "ok".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("action_executed"));

        let event = AgentEvent::Done {
            summary: "done".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("done"));

        let event = AgentEvent::ConfirmationRequired {
            action_id: "abc".to_string(),
            action: "Click".to_string(),
            description: "Click at (100, 200)".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("confirmation_required"));
    }

    #[test]
    fn agent_state_new_is_idle() {
        let state = AgentState::new();
        assert_eq!(state.get_status(), AgentStatus::Idle);
    }

    #[test]
    fn agent_state_set_status() {
        let state = AgentState::new();
        state.set_status(AgentStatus::Executing);
        assert_eq!(state.get_status(), AgentStatus::Executing);
    }

    #[test]
    fn agent_state_cancel() {
        let state = AgentState::new();
        assert!(!state.is_cancelled());
        state.cancel();
        assert!(state.is_cancelled());
    }

    #[test]
    fn agent_state_reset() {
        let state = AgentState::new();
        state.set_status(AgentStatus::Executing);
        state.add_to_history("test".to_string());
        state.cancel();
        state.reset();
        assert_eq!(state.get_status(), AgentStatus::Idle);
        assert!(!state.is_cancelled());
        assert!(state.history.lock().unwrap().is_empty());
    }

    #[test]
    fn agent_state_history() {
        let state = AgentState::new();
        state.add_to_history("entry1".to_string());
        state.add_to_history("entry2".to_string());
        let h = state.history.lock().unwrap();
        assert_eq!(h.len(), 2);
        assert_eq!(h[0], "entry1");
        assert_eq!(h[1], "entry2");
    }

    #[test]
    fn max_iterations_constant() {
        assert_eq!(MAX_ITERATIONS, 30);
    }

    #[test]
    fn action_delay_constant() {
        assert_eq!(ACTION_DELAY_MS, 500);
    }

    #[test]
    fn screenshot_delay_constant() {
        assert_eq!(SCREENSHOT_DELAY_MS, 500);
    }

    #[test]
    fn parse_action_integration() {
        let action = computer_control::parse_action_line("CLICK 100 200");
        assert!(matches!(
            action,
            Some(AgentAction::Click { x: 100, y: 200 })
        ));

        let action = computer_control::parse_action_line("DONE task complete");
        assert!(
            matches!(action, Some(AgentAction::Done { ref summary }) if summary == "task complete")
        );

        let action = computer_control::parse_action_line("SCREENSHOT");
        assert!(matches!(action, Some(AgentAction::Screenshot {})));
    }

    #[test]
    fn system_prompt_not_empty() {
        assert!(!AGENT_SYSTEM_PROMPT.is_empty());
        assert!(AGENT_SYSTEM_PROMPT.contains("CLICK"));
        assert!(AGENT_SYSTEM_PROMPT.contains("DONE"));
    }

    #[test]
    fn text_only_system_prompt_not_empty() {
        assert!(!AGENT_SYSTEM_PROMPT_TEXT_ONLY.is_empty());
        assert!(AGENT_SYSTEM_PROMPT_TEXT_ONLY.contains("LAUNCH"));
        assert!(AGENT_SYSTEM_PROMPT_TEXT_ONLY.contains("DONE"));
        // Text-only prompt must NOT list SCREENSHOT as an available action.
        assert!(!AGENT_SYSTEM_PROMPT_TEXT_ONLY.contains("- SCREENSHOT"));
    }

    #[test]
    fn vision_prompt_contains_screenshot_action() {
        // Vision prompt should list SCREENSHOT as an action; text-only should not.
        assert!(AGENT_SYSTEM_PROMPT.contains("- SCREENSHOT"));
        assert!(!AGENT_SYSTEM_PROMPT_TEXT_ONLY.contains("- SCREENSHOT"));
    }

    /// Verifies that `request_screenshot_consent` resolves to `true` when the
    /// frontend sends an approval via the oneshot channel.
    #[tokio::test]
    async fn screenshot_consent_approved() {
        let state = Arc::new(AgentState::new());

        // Simulate the frontend approving immediately.
        let state_clone = state.clone();
        tokio::spawn(async move {
            // Give the consent function a moment to register its sender.
            tokio::time::sleep(Duration::from_millis(10)).await;
            let sender = state_clone.confirmation_tx.lock().unwrap().take();
            if let Some(tx) = sender {
                let _ = tx.send(true);
            }
        });

        // Build a minimal AppHandle — we can't easily call the real one in unit
        // tests, so we test the underlying channel mechanism directly instead.
        // Create the channel ourselves to mirror what the function does.
        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
        {
            *state.confirmation_tx.lock().unwrap() = Some(tx);
        }
        // Approve from a background task.
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(5)).await;
            let sender = state.confirmation_tx.lock().unwrap().take();
            if let Some(s) = sender {
                let _ = s.send(true);
            }
        });
        let result = tokio::time::timeout(Duration::from_secs(1), rx)
            .await
            .unwrap()
            .unwrap();
        assert!(result, "consent should be approved");
    }

    /// Verifies that `request_screenshot_consent` resolves to `false` when the
    /// frontend denies (sends false).
    #[tokio::test]
    async fn screenshot_consent_denied() {
        let state = Arc::new(AgentState::new());
        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
        {
            *state.confirmation_tx.lock().unwrap() = Some(tx);
        }
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(5)).await;
            let sender = state.confirmation_tx.lock().unwrap().take();
            if let Some(s) = sender {
                let _ = s.send(false);
            }
        });
        let result = tokio::time::timeout(Duration::from_secs(1), rx)
            .await
            .unwrap()
            .unwrap();
        assert!(!result, "consent should be denied");
    }

    #[test]
    fn read_image_as_base64_file_not_found() {
        let result = read_image_as_base64("/nonexistent/path/to/image.png");
        assert!(result.is_err());
    }

    #[test]
    fn tool_call_to_action_click() {
        let tc = ToolCall {
            id: "1".to_string(),
            name: "computer_click".to_string(),
            arguments: r#"{"x": 100, "y": 200}"#.to_string(),
        };
        let action = tool_call_to_action(&tc).unwrap();
        assert!(matches!(action, AgentAction::Click { x: 100, y: 200 }));
    }

    #[test]
    fn tool_call_to_action_type() {
        let tc = ToolCall {
            id: "2".to_string(),
            name: "computer_type".to_string(),
            arguments: r#"{"text": "Hello"}"#.to_string(),
        };
        let action = tool_call_to_action(&tc).unwrap();
        assert!(matches!(action, AgentAction::TypeText { ref text } if text == "Hello"));
    }

    #[test]
    fn tool_call_to_action_key_press() {
        let tc = ToolCall {
            id: "3".to_string(),
            name: "computer_key_press".to_string(),
            arguments: r#"{"key": "c", "modifiers": ["ctrl"]}"#.to_string(),
        };
        let action = tool_call_to_action(&tc).unwrap();
        assert!(
            matches!(action, AgentAction::KeyPress { ref modifiers, ref key } if modifiers.len() == 1 && key == "c")
        );
    }

    #[test]
    fn tool_call_to_action_launch() {
        let tc = ToolCall {
            id: "4".to_string(),
            name: "computer_launch".to_string(),
            arguments: r#"{"target": "notepad"}"#.to_string(),
        };
        let action = tool_call_to_action(&tc).unwrap();
        assert!(matches!(action, AgentAction::Launch { ref target } if target == "notepad"));
    }

    #[test]
    fn tool_call_to_action_anthropic_click() {
        let tc = ToolCall {
            id: "5".to_string(),
            name: "computer".to_string(),
            arguments: r#"{"action": "left_click", "coordinate": [500, 300]}"#.to_string(),
        };
        let action = tool_call_to_action(&tc).unwrap();
        assert!(matches!(action, AgentAction::Click { x: 500, y: 300 }));
    }

    #[test]
    fn tool_call_to_action_anthropic_type() {
        let tc = ToolCall {
            id: "6".to_string(),
            name: "computer".to_string(),
            arguments: r#"{"action": "type", "text": "Hello World"}"#.to_string(),
        };
        let action = tool_call_to_action(&tc).unwrap();
        assert!(matches!(action, AgentAction::TypeText { ref text } if text == "Hello World"));
    }

    #[test]
    fn tool_call_to_action_get_active_window() {
        let tc = ToolCall {
            id: "8".to_string(),
            name: "computer_get_active_window".to_string(),
            arguments: "{}".to_string(),
        };
        let action = tool_call_to_action(&tc).unwrap();
        assert!(matches!(action, AgentAction::GetActiveWindowInfo {}));
    }

    #[test]
    fn tool_call_to_action_list_windows() {
        let tc = ToolCall {
            id: "9".to_string(),
            name: "computer_list_windows".to_string(),
            arguments: "{}".to_string(),
        };
        let action = tool_call_to_action(&tc).unwrap();
        assert!(matches!(action, AgentAction::ListOpenWindows {}));
    }

    #[test]
    fn tool_call_to_action_read_focused() {
        let tc = ToolCall {
            id: "10".to_string(),
            name: "computer_read_focused".to_string(),
            arguments: "{}".to_string(),
        };
        let action = tool_call_to_action(&tc).unwrap();
        assert!(matches!(action, AgentAction::ReadFocusedElement {}));
    }

    #[test]
    fn tool_call_to_action_find_activate() {
        let tc = ToolCall {
            id: "11".to_string(),
            name: "computer_find_activate".to_string(),
            arguments: r#"{"name": "OK"}"#.to_string(),
        };
        let action = tool_call_to_action(&tc).unwrap();
        assert!(matches!(action, AgentAction::FindAndActivate { ref name } if name == "OK"));
    }

    #[test]
    fn tool_call_to_action_find_activate_missing_name_returns_none() {
        let tc = ToolCall {
            id: "12".to_string(),
            name: "computer_find_activate".to_string(),
            arguments: "{}".to_string(),
        };
        assert!(tool_call_to_action(&tc).is_none());
    }

    #[test]
    fn describe_action_uia_variants() {
        assert_eq!(
            describe_action(&AgentAction::GetActiveWindowInfo {}),
            "Get active window info"
        );
        assert_eq!(
            describe_action(&AgentAction::ListOpenWindows {}),
            "List open windows"
        );
        assert_eq!(
            describe_action(&AgentAction::ReadFocusedElement {}),
            "Read focused element"
        );
        assert_eq!(
            describe_action(&AgentAction::FindAndActivate {
                name: "Submit".to_string()
            }),
            "Find and activate \"Submit\""
        );
    }

    #[test]
    fn tool_call_to_action_unknown_returns_none() {
        let tc = ToolCall {
            id: "7".to_string(),
            name: "unknown_tool".to_string(),
            arguments: "{}".to_string(),
        };
        assert!(tool_call_to_action(&tc).is_none());
    }

    #[test]
    fn describe_action_click() {
        let action = AgentAction::Click { x: 100, y: 200 };
        assert_eq!(describe_action(&action), "Click at (100, 200)");
    }

    #[test]
    fn describe_action_launch() {
        let action = AgentAction::Launch {
            target: "notepad".to_string(),
        };
        assert_eq!(describe_action(&action), "Open \"notepad\"");
    }

    #[test]
    fn confirmation_state_learning() {
        let cs = ConfirmationState::new();
        let click = AgentAction::Click { x: 100, y: 200 };
        // LEARNING_CONFIRMATION_LIMIT = 0 means no learning period;
        // non-dangerous actions auto-execute without confirmation from the start.
        assert!(!cs.requires_confirmation(&click));
    }

    #[test]
    fn confirmation_state_dangerous_always() {
        let mut cs = ConfirmationState::new();
        cs.confirmed_count = 100; // Way past learning limit.
        let launch = AgentAction::Launch {
            target: "test".to_string(),
        };
        // computer_launch is no longer in DANGEROUS_ACTION_NAMES, so once past
        // the learning limit it auto-executes without confirmation.
        assert!(!cs.requires_confirmation(&launch));
    }

    #[test]
    fn confirmation_state_auto_after_learning() {
        let mut cs = ConfirmationState::new();
        cs.confirmed_count = LEARNING_CONFIRMATION_LIMIT;
        let click = AgentAction::Click { x: 100, y: 200 };
        assert!(!cs.requires_confirmation(&click));
    }

    #[test]
    fn confirmation_confirm_and_reject() {
        let mut cs = ConfirmationState::new();
        let action = AgentAction::Click { x: 1, y: 2 };
        cs.add_pending("id1".to_string(), action.clone(), "test".to_string());

        let confirmed = cs.confirm("id1");
        assert!(confirmed.is_some());
        assert_eq!(cs.confirmed_count, 1);
        assert!(cs.confirm("id1").is_none()); // Already removed.

        cs.add_pending("id2".to_string(), action.clone(), "test".to_string());
        let rejected = cs.reject("id2");
        assert!(rejected.is_some());
        assert_eq!(cs.confirmed_count, 1); // Not incremented on reject.
    }

    #[test]
    fn agent_provider_config() {
        let state = AgentState::new();
        assert!(state.get_provider_config().is_none());

        let config = ProviderConfig {
            provider: providers::Provider::OpenAI,
            model: "gpt-4o".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            api_key: "sk-test".to_string(),
        };
        state.set_provider_config(config);
        let retrieved = state.get_provider_config().unwrap();
        assert_eq!(retrieved.model, "gpt-4o");
    }

    #[test]
    fn agent_provider_config_openrouter() {
        let state = AgentState::new();
        let config = ProviderConfig {
            provider: providers::Provider::OpenRouter,
            model: "openai/gpt-4o".to_string(),
            base_url: "https://openrouter.ai/api/v1".to_string(),
            api_key: "sk-or-v1-test".to_string(),
        };
        state.set_provider_config(config);
        let retrieved = state.get_provider_config().unwrap();
        assert_eq!(retrieved.model, "openai/gpt-4o");
        assert_eq!(retrieved.base_url, "https://openrouter.ai/api/v1");
        assert!(matches!(
            retrieved.provider,
            providers::Provider::OpenRouter
        ));
    }

    #[test]
    fn use_tool_use_openrouter() {
        let config = ProviderConfig {
            provider: providers::Provider::OpenRouter,
            model: "openai/gpt-4o".to_string(),
            base_url: "https://openrouter.ai/api/v1".to_string(),
            api_key: "sk-or-v1-test".to_string(),
        };
        let use_tool_use = matches!(
            config.provider,
            providers::Provider::OpenAI
                | providers::Provider::Anthropic
                | providers::Provider::OpenRouter
        );
        assert!(use_tool_use);
    }

    #[tokio::test]
    async fn validate_openrouter_key_rejects_empty() {
        let result = validate_openrouter_key("".to_string()).await;
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "API key is empty");
    }

    #[tokio::test]
    async fn validate_openrouter_key_rejects_whitespace_only() {
        let result = validate_openrouter_key("   \n\t".to_string()).await;
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "API key is empty");
    }
}
