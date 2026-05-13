//! Provider abstraction for multi-backend LLM support.
//!
//! Routes requests to the correct backend (Ollama, OpenAI, Anthropic)
//! based on user configuration. Each provider implements the same streaming
//! interface but translates messages to its own API format.

pub mod anthropic;
pub mod openai;

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

/// Supported LLM providers.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Ollama,
    OpenAI,
    Anthropic,
    OpenRouter,
}

/// Runtime configuration for the active provider.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProviderConfig {
    /// Which provider to use for requests.
    pub provider: Provider,
    /// Model name to send to the provider.
    pub model: String,
    /// Base URL for the provider API (Ollama: http://127.0.0.1:11434, OpenAI: https://api.openai.com/v1, Anthropic: https://api.anthropic.com).
    pub base_url: String,
    /// API key for cloud providers (empty for Ollama).
    pub api_key: String,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            provider: Provider::Ollama,
            model: "gemini-3-flash-preview".to_string(),
            base_url: "http://127.0.0.1:11434".to_string(),
            api_key: String::new(),
        }
    }
}

/// A tool call from a model response.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolCall {
    /// Unique ID for the tool call (used to match results).
    pub id: String,
    /// The function/tool name (e.g., "computer_click").
    pub name: String,
    /// JSON string of arguments.
    pub arguments: String,
}

/// A chunk of streaming response from any provider.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum ProviderChunk {
    /// A text token from the model.
    Token(String),
    /// A thinking/reasoning token.
    ThinkingToken(String),
    /// The model is requesting one or more tool calls.
    ToolCalls(Vec<ToolCall>),
    /// Streaming is complete.
    Done,
    /// Streaming was cancelled by the user.
    Cancelled,
    /// An error occurred.
    Error(String),
}

/// Returns default base URLs for each provider.
pub fn default_base_url(provider: &Provider) -> &'static str {
    match provider {
        Provider::Ollama => "http://127.0.0.1:11434",
        Provider::OpenAI => "https://api.openai.com/v1",
        Provider::Anthropic => "https://api.anthropic.com",
        Provider::OpenRouter => "https://openrouter.ai/api/v1",
    }
}

/// Returns recommended models for each provider.
pub fn default_models(provider: &Provider) -> &'static [&'static str] {
    match provider {
        Provider::Ollama => &[
            "gemini-3-flash-preview",
            "llama3.2-vision",
            "llama3.2",
            "mistral",
        ],
        Provider::OpenAI => &["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
        Provider::Anthropic => &[
            "claude-sonnet-4-20250514",
            "claude-3-5-sonnet-20241022",
            "claude-3-5-haiku-20241022",
        ],
        Provider::OpenRouter => &[
            "openai/gpt-4o",
            "anthropic/claude-sonnet-4",
            "google/gemini-2.5-pro",
            "meta-llama/llama-4-scout",
            "google/gemma-4-31b-it:free",
            "google/gemma-4-26b-a4b-it:free",
            "inclusionai/ring-2.6-1t:free",
            "arcee-ai/trinity-large-thinking:free",
        ],
    }
}

/// Shared provider state for routing the regular ask-bar chat to the active
/// cloud provider.  `None` means fall through to the default Ollama backend.
/// Set by `set_agent_provider`; read by `ask_ollama`.
pub struct SharedChatProvider(pub Mutex<Option<ProviderConfig>>);

impl SharedChatProvider {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
}

impl Default for SharedChatProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_serialization() {
        assert_eq!(
            serde_json::to_string(&Provider::Ollama).unwrap(),
            "\"ollama\""
        );
        assert_eq!(
            serde_json::to_string(&Provider::OpenAI).unwrap(),
            "\"openai\""
        );
        assert_eq!(
            serde_json::to_string(&Provider::Anthropic).unwrap(),
            "\"anthropic\""
        );
        assert_eq!(
            serde_json::to_string(&Provider::OpenRouter).unwrap(),
            "\"openrouter\""
        );
    }

    #[test]
    fn provider_config_default() {
        let config = ProviderConfig::default();
        assert_eq!(config.provider, Provider::Ollama);
        assert_eq!(config.base_url, "http://127.0.0.1:11434");
        assert!(config.api_key.is_empty());
    }

    #[test]
    fn default_base_urls() {
        assert_eq!(
            default_base_url(&Provider::Ollama),
            "http://127.0.0.1:11434"
        );
        assert_eq!(
            default_base_url(&Provider::OpenAI),
            "https://api.openai.com/v1"
        );
        assert_eq!(
            default_base_url(&Provider::Anthropic),
            "https://api.anthropic.com"
        );
        assert_eq!(
            default_base_url(&Provider::OpenRouter),
            "https://openrouter.ai/api/v1"
        );
    }

    #[test]
    fn default_models_not_empty() {
        for provider in &[
            Provider::Ollama,
            Provider::OpenAI,
            Provider::Anthropic,
            Provider::OpenRouter,
        ] {
            assert!(!default_models(provider).is_empty());
        }
    }
}
