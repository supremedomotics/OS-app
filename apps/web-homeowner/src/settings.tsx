import { useState } from "react";
import {
  AUREON_ACCENTS,
  AUREON_MODES,
  applyAureonTheme,
  loadAureonTheme,
  saveAureonTheme,
  type AureonAccent,
  type AureonMode,
} from "@supreme/aureon-web";

/**
 * Appearance settings (§11.2 Themes): Light / Dark / Automatic base palettes
 * (Luxury Black / Luxury White) and the accent colour (Gold / Silver). Applying a theme
 * is a pure repaint — it just flips data attributes on the document root — and the choice
 * is persisted for next launch.
 */
export function ThemeSettings() {
  const [choice, setChoice] = useState(loadAureonTheme());

  function update(next: { mode?: AureonMode; accent?: AureonAccent }) {
    const merged = { ...choice, ...next };
    setChoice(merged);
    applyAureonTheme(merged);
    saveAureonTheme(merged);
  }

  return (
    <div className="settings">
      <h1 className="title">Settings</h1>

      <section className="card-section">
        <h2 className="section-title">Appearance</h2>

        <p className="opt-label">Theme</p>
        <div className="seg">
          {AUREON_MODES.map((m) => (
            <button
              key={m.key}
              className={choice.mode === m.key ? "on" : ""}
              onClick={() => update({ mode: m.key })}
            >
              {m.label}
            </button>
          ))}
        </div>

        <p className="opt-label">Accent</p>
        <div className="seg accents">
          {AUREON_ACCENTS.map((a) => (
            <button
              key={a.key}
              className={choice.accent === a.key ? "on" : ""}
              onClick={() => update({ accent: a.key })}
            >
              <span className="swatch" style={{ background: a.swatch }} />
              {a.label}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
