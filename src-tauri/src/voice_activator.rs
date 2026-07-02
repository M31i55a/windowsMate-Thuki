/*!
 * Voice input module: microphone capture, speech-to-text (VAD-triggered).
 *
 * Architecture:
 *   cpal capture → ring buffer → VAD → whisper.cpp (STT) → event to frontend
 *
 * STT uses whisper.cpp as a subprocess (avoids heavy Rust ML deps).
 *
 * Note: Wake word detection ("Mate") is not yet implemented as a Rust lib
 * (rustpotter depends on candle-core which has an unfixable half/rand version
 * conflict). A future implementation could use whisper.cpp's `--detect-mode` or
 * a smaller on-device model. For now the listener uses VAD-only mode: any
 * speech triggers recording → transcription.
 */

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};

use serde::Serialize;
use tauri::{Emitter, Manager};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

// ─── Constants ──────────────────────────────────────────────────────────────

/// Whisper expects 16 kHz mono audio.
const SAMPLE_RATE: u32 = 16000;
/// Process audio in 32 ms frames (512 samples @ 16 kHz).
const FRAME_SIZE: usize = 512;
/// ~800 ms of silence before finalising a recording.
const SILENCE_FRAMES_MAX: usize = 25;
/// ~20 s hard cap on any single recording.
const MAX_RECORDING_FRAMES: usize = 625;
/// Energy threshold for simple VAD (tune for your mic).
const VAD_THRESHOLD: f32 = 0.02;

// ─── Event payloads ─────────────────────────────────────────────────────────

#[derive(Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum VoiceStatus {
    Idle,
    Listening,
    Recording,
    Transcribing,
    AiProcessing,
    Speaking,
    Error(String),
}

#[derive(Clone, Serialize)]
pub struct VoiceStatePayload {
    pub status: VoiceStatus,
    pub text: Option<String>,
    pub response: Option<String>,
}

// ─── Shared state ───────────────────────────────────────────────────────────

pub struct VoiceListenerState {
    pub running: AtomicBool,
    pub handle: Mutex<Option<JoinHandle<()>>>,
}

impl VoiceListenerState {
    pub fn new() -> Self {
        Self {
            running: AtomicBool::new(false),
            handle: Mutex::new(None),
        }
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Simple energy-based VAD.
fn is_speech(frame: &[f32]) -> bool {
    let energy = frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32;
    energy > VAD_THRESHOLD
}

/// Write f32 samples as a 16-bit mono WAV file.
fn write_wav(path: &std::path::Path, samples: &[f32], sample_rate: u32) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(path, spec)
        .map_err(|e| format!("wav create: {e}"))?;
    for &s in samples {
        let clamped = s.clamp(-1.0, 1.0);
        w.write_sample((clamped * i16::MAX as f32) as i16)
            .map_err(|e| format!("wav write: {e}"))?;
    }
    w.finalize().map_err(|e| format!("wav finalize: {e}"))
}

/// Transcribe audio using whisper.cpp CLI as a subprocess.
/// Expects `whisper.exe` in `{app_data}/whisper/`.
fn transcribe_audio(audio: &[f32], whisper_exe: &std::path::Path, model_path: &std::path::Path) -> Option<String> {
    let tmp_dir = std::env::temp_dir().join("mate-voice");
    let _ = std::fs::create_dir_all(&tmp_dir);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    let wav_path = tmp_dir.join(format!("input_{timestamp}.wav"));

    write_wav(&wav_path, audio, SAMPLE_RATE).ok()?;

    let output = std::process::Command::new(whisper_exe)
        .arg("-m")
        .arg(model_path)
        .arg("-f")
        .arg(&wav_path)
        .arg("--no-prints")
        .arg("--print-progress")
        .arg("false")
        .arg("-l")
        .arg("en")
        .arg("-oj")
        .output()
        .ok()?;

    let _ = std::fs::remove_file(&wav_path);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("mate: [voice] whisper failed: {stderr}");
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_whisper_json(&stdout)
}

fn parse_whisper_json(output: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(output).ok()?;
    let text = parsed.get("text")?.as_str()?.trim().to_string();
    if text.is_empty() { None } else { Some(text) }
}

/// Resample audio from any rate to 16 kHz using linear interpolation.
fn resample_to_16k(samples: &[f32], src_rate: u32) -> Vec<f32> {
    if src_rate == SAMPLE_RATE {
        return samples.to_vec();
    }
    let ratio = src_rate as f64 / SAMPLE_RATE as f64;
    let out_len = (samples.len() as f64 / ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 * ratio;
        let lo = src.floor() as usize;
        let hi = (lo + 1).min(samples.len().saturating_sub(1));
        let frac = src - lo as f64;
        out.push(samples[lo] * (1.0 - frac as f32) + samples[hi] * frac as f32);
    }
    out
}

/// Convert i16 samples to f32.
fn i16_to_f32(input: &[i16]) -> Vec<f32> {
    input.iter().map(|&s| s as f32 / i16::MAX as f32).collect()
}

// ─── Audio capture thread ───────────────────────────────────────────────────

fn run_voice_listener(
    app_handle: tauri::AppHandle,
    whisper_exe: std::path::PathBuf,
    whisper_model_path: std::path::PathBuf,
    state: Arc<VoiceListenerState>,
) {
    // ── Open microphone ──────────────────────────────────────────
    let host = cpal::default_host();
    let device = match host.default_input_device() {
        Some(d) => d,
        None => return emit_err(&app_handle, "No microphone found"),
    };

    let supported_cfg = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => return emit_err(&app_handle, &format!("No mic config: {e}")),
    };

    let src_rate = supported_cfg.sample_rate().0;
    let src_channels = supported_cfg.channels();
    let src_fmt = supported_cfg.sample_format();
    let stream_cfg: cpal::StreamConfig = supported_cfg.into();

    let (audio_tx, audio_rx) = mpsc::channel::<Vec<f32>>();

    let stream_result = match src_fmt {
        cpal::SampleFormat::F32 => build_f32_stream(&device, &stream_cfg, audio_tx.clone()),
        cpal::SampleFormat::I16 => build_i16_stream(&device, &stream_cfg, audio_tx.clone()),
        cpal::SampleFormat::U16 => build_u16_stream(&device, &stream_cfg, audio_tx.clone()),
        _ => Err("unsupported sample format".into()),
    };

    let stream = match stream_result {
        Ok(s) => s,
        Err(e) => return emit_err(&app_handle, &format!("Cannot open mic: {e}")),
    };
    if let Err(e) = stream.play() {
        return emit_err(&app_handle, &format!("Cannot start mic: {e}"));
    }

    let has_whisper = whisper_exe.exists() && whisper_model_path.exists();
    if !has_whisper {
        eprintln!(
            "mate: [voice] whisper not available (exe: {}, model: {})",
            whisper_exe.display(),
            whisper_model_path.display()
        );
    }

    emit_state(&app_handle, VoiceStatus::Listening, None, None);

    // ── Audio processing loop (VAD-triggered) ─────────────────────
    let mut recording_buffer: Vec<f32> = Vec::new();
    let mut silence_counter = 0;
    let mut is_recording = false;

    while state.running.load(Ordering::SeqCst) {
        while let Ok(mut frame) = audio_rx.try_recv() {
            // Downmix to mono
            if src_channels == 2 {
                frame = frame.chunks(2).map(|ch| (ch[0] + ch[1]) * 0.5).collect();
            }
            // Resample to 16 kHz
            if src_rate != SAMPLE_RATE {
                frame = resample_to_16k(&frame, src_rate);
            }

            let mut offset = 0;
            while offset + FRAME_SIZE <= frame.len() {
                let chunk = &frame[offset..offset + FRAME_SIZE];
                offset += FRAME_SIZE;
                let speech = is_speech(chunk);

                if is_recording {
                    recording_buffer.extend_from_slice(chunk);
                    if speech {
                        silence_counter = 0;
                    } else {
                        silence_counter += 1;
                    }

                    if silence_counter >= SILENCE_FRAMES_MAX
                        || recording_buffer.len() / FRAME_SIZE >= MAX_RECORDING_FRAMES
                    {
                        is_recording = false;
                        let audio = std::mem::take(&mut recording_buffer);

                        emit_state(&app_handle, VoiceStatus::Transcribing, None, None);

                        let text = if has_whisper {
                            transcribe_audio(&audio, &whisper_exe, &whisper_model_path)
                        } else {
                            None
                        };

                        if let Some(ref t) = text {
                            eprintln!("mate: [voice] transcribed: {t}");
                            emit_state(
                                &app_handle,
                                VoiceStatus::AiProcessing,
                                Some(t.clone()),
                                None,
                            );
                        } else {
                            emit_state(&app_handle, VoiceStatus::Listening, None, None);
                        }
                        silence_counter = 0;
                    }
                } else if speech {
                    // VAD triggered — start recording
                    is_recording = true;
                    recording_buffer.clear();
                    silence_counter = 0;
                    recording_buffer.extend_from_slice(chunk);
                    emit_state(&app_handle, VoiceStatus::Recording, None, None);
                }
            }
        }
        thread::sleep(std::time::Duration::from_millis(10));
    }

    let _ = stream.pause();
    emit_state(&app_handle, VoiceStatus::Idle, None, None);
    eprintln!("mate: [voice] listener stopped");
}

// ─── Stream builders for different sample formats ──────────────────────────

fn build_f32_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    tx: mpsc::Sender<Vec<f32>>,
) -> Result<cpal::Stream, String> {
    device
        .build_input_stream::<f32, _, _>(config, move |data, _| {
            let _ = tx.send(data.to_vec());
        }, |err| eprintln!("mate: [voice] {err}"), None)
        .map_err(|e| format!("f32 stream: {e}"))
}

fn build_i16_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    tx: mpsc::Sender<Vec<f32>>,
) -> Result<cpal::Stream, String> {
    device
        .build_input_stream::<i16, _, _>(config, move |data, _| {
            let _ = tx.send(i16_to_f32(data));
        }, |err| eprintln!("mate: [voice] {err}"), None)
        .map_err(|e| format!("i16 stream: {e}"))
}

fn build_u16_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    tx: mpsc::Sender<Vec<f32>>,
) -> Result<cpal::Stream, String> {
    device
        .build_input_stream::<u16, _, _>(config, move |data, _| {
            let f32_data: Vec<f32> = data
                .iter()
                .map(|&s| (s as f32 - 32768.0) / i16::MAX as f32)
                .collect();
            let _ = tx.send(f32_data);
        }, |err| eprintln!("mate: [voice] {err}"), None)
        .map_err(|e| format!("u16 stream: {e}"))
}

// ─── Event helpers ──────────────────────────────────────────────────────────

fn emit_state(app: &tauri::AppHandle, status: VoiceStatus, text: Option<String>, response: Option<String>) {
    let _ = app.emit(
        "mate://voice_state",
        VoiceStatePayload { status, text, response },
    );
}

fn emit_err(app: &tauri::AppHandle, msg: &str) {
    eprintln!("mate: [voice] {msg}");
    let _ = app.emit(
        "mate://voice_state",
        VoiceStatePayload {
            status: VoiceStatus::Error(msg.to_string()),
            text: None,
            response: None,
        },
    );
}

// ─── Tauri commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn start_voice_listener(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<VoiceListenerState>>,
) -> Result<(), String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?;

    let whisper_exe = app_data_dir.join("whisper").join("whisper.exe");
    let whisper_model_path = app_data_dir.join("models").join("ggml-base.en.bin");

    let state_arc = state.inner().clone();
    let handle = thread::Builder::new()
        .name("mate-voice-listener".into())
        .spawn(move || {
            run_voice_listener(app_handle, whisper_exe, whisper_model_path, state_arc);
        })
        .map_err(|e| format!("cannot spawn voice thread: {e}"))?;

    *state.handle.lock().unwrap() = Some(handle);
    Ok(())
}

#[tauri::command]
pub fn stop_voice_listener(
    state: tauri::State<'_, Arc<VoiceListenerState>>,
) -> Result<(), String> {
    if !state.running.swap(false, Ordering::SeqCst) {
        return Ok(());
    }
    if let Some(handle) = state.handle.lock().unwrap().take() {
        let _ = handle.join();
    }
    Ok(())
}

#[tauri::command]
pub fn is_voice_listener_running(
    state: tauri::State<'_, Arc<VoiceListenerState>>,
) -> Result<bool, String> {
    Ok(state.running.load(Ordering::SeqCst))
}

#[tauri::command]
pub fn has_wakeword_reference(app_handle: tauri::AppHandle) -> Result<bool, String> {
    let dir = app_handle.path().app_data_dir().map_err(|e| format!("{e}"))?;
    Ok(dir.join("mate.rpw").exists())
}
