/**
 * Display tab - window dimensions and quoted-text preview limits.
 */

import { useState } from 'react';
import { emit } from '@tauri-apps/api/event';
import { Section, NumberSlider, NumberStepper, SettingRow } from '../components';
import { SaveField } from '../components/SaveField';
import { configHelp } from '../configHelpers';
import type { RawAppConfig } from '../types';

interface DisplayTabProps {
  config: RawAppConfig;
  resyncToken: number;
  onSaved: (next: RawAppConfig) => void;
}

export function DisplayTab({ config, resyncToken, onSaved }: DisplayTabProps) {
  const [bubbleColor, setBubbleColor] = useState(
    () => localStorage.getItem('mate-bubble-color') ?? '#ff8d5c',
  );
  const [blur, setBlur] = useState(
    () => Number(localStorage.getItem('mate-chat-blur-px') ?? '10'),
  );

  function applyBubbleColor(color: string) {
    setBubbleColor(color);
    localStorage.setItem('mate-bubble-color', color);
    document.documentElement.style.setProperty('--bubble-color', color);
    void emit('mate://appearance', { bubbleColor: color, primaryColor: null, opacity: null, blur: null });
  }

  function applyBlur(px: number) {
    setBlur(px);
    localStorage.setItem('mate-chat-blur-px', String(px));
    document.documentElement.style.setProperty('--chat-bg-blur', `${px}px`);
    void emit('mate://appearance', { bubbleColor: null, primaryColor: null, opacity: null, blur: String(px) });
  }

  return (
    <>
      <Section heading="Window">
        <SaveField
          section="window"
          fieldKey="overlay_width"
          label="Overlay width"
          helper={configHelp('window', 'overlay_width')}
          initialValue={config.window.overlay_width}
          resyncToken={resyncToken}
          onSaved={onSaved}
          render={(value, setValue) => (
            <NumberSlider value={value} min={200} max={2000} step={10} unit="px" onChange={setValue} ariaLabel="Overlay width" />
          )}
        />
        <SaveField
          section="window"
          fieldKey="max_chat_height"
          label="Max chat height"
          helper={configHelp('window', 'max_chat_height')}
          initialValue={config.window.max_chat_height}
          resyncToken={resyncToken}
          onSaved={onSaved}
          render={(value, setValue) => (
            <NumberSlider value={value} min={200} max={2000} step={10} unit="px" onChange={setValue} ariaLabel="Max chat height" />
          )}
        />
      </Section>

      <Section heading="Input">
        <SaveField
          section="window"
          fieldKey="max_images"
          label="Max images"
          helper={configHelp('window', 'max_images')}
          initialValue={config.window.max_images}
          resyncToken={resyncToken}
          onSaved={onSaved}
          render={(value, setValue) => (
            <NumberStepper value={value} min={1} max={20} onChange={setValue} ariaLabel="Max images" />
          )}
        />
        <SaveField
          section="quote"
          fieldKey="max_display_lines"
          label="Max display lines"
          helper={configHelp('quote', 'max_display_lines')}
          initialValue={config.quote.max_display_lines}
          resyncToken={resyncToken}
          onSaved={onSaved}
          render={(value, setValue) => (
            <NumberStepper value={value} min={1} max={100} onChange={setValue} ariaLabel="Max display lines" />
          )}
        />
        <SaveField
          section="quote"
          fieldKey="max_display_chars"
          label="Max display chars"
          helper={configHelp('quote', 'max_display_chars')}
          initialValue={config.quote.max_display_chars}
          resyncToken={resyncToken}
          onSaved={onSaved}
          render={(value, setValue) => (
            <NumberStepper value={value} min={1} max={10000} step={50} onChange={setValue} ariaLabel="Max display chars" />
          )}
        />
        <SaveField
          section="quote"
          fieldKey="max_context_length"
          label="Max context length"
          helper={configHelp('quote', 'max_context_length')}
          initialValue={config.quote.max_context_length}
          resyncToken={resyncToken}
          onSaved={onSaved}
          render={(value, setValue) => (
            <NumberStepper value={value} min={1} max={65536} step={256} onChange={setValue} ariaLabel="Max context length" />
          )}
        />
      </Section>

      <Section heading="Appearance">
        <SaveField
          section="appearance"
          fieldKey="color_primary"
          label="Primary accent color"
          helper={configHelp('appearance', 'color_primary')}
          initialValue={config.appearance.color_primary}
          resyncToken={resyncToken}
          onSaved={onSaved}
          render={(value, setValue) => (
            <input
              type="color"
              value={value}
              onChange={(e) => {
                const newColor = e.target.value;
                setValue(newColor);
                document.documentElement.style.setProperty('--color-primary', newColor);
                void emit('mate://appearance', { bubbleColor: null, primaryColor: newColor, opacity: null, blur: null });
              }}
              aria-label="Primary accent color"
              style={{ width: 40, height: 28, padding: 2, cursor: 'pointer', borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent' }}
            />
          )}
        />
        <SettingRow label="Chat bubble color">
          <input
            type="color"
            value={bubbleColor}
            onChange={(e) => applyBubbleColor(e.target.value)}
            aria-label="Chat bubble color"
            style={{ width: 40, height: 28, padding: 2, cursor: 'pointer', borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent' }}
          />
        </SettingRow>
        <SaveField
          section="appearance"
          fieldKey="app_bg_opacity"
          label="Window transparency"
          helper={configHelp('appearance', 'app_bg_opacity')}
          initialValue={config.appearance.app_bg_opacity * 100}
          resyncToken={resyncToken}
          onSaved={onSaved}
          render={(value, setValue) => (
            <NumberSlider
              value={value}
              min={30}
              max={100}
              step={1}
              unit="%"
              onChange={(pct) => {
                setValue(pct);
                const opacity = (pct / 100).toFixed(2);
                document.documentElement.style.setProperty('--app-bg-opacity', opacity);
                void emit('mate://appearance', { bubbleColor: null, primaryColor: null, opacity, blur: null });
              }}
              ariaLabel="Window transparency"
            />
          )}
        />
        <SettingRow label="Chat background blur">
          <NumberSlider
            value={blur}
            min={0}
            max={20}
            step={1}
            unit="px"
            onChange={applyBlur}
            aria-label="Chat background blur"
          />
        </SettingRow>
      </Section>
    </>
  );
}