import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import { initAureonDensity, initAureonTheme } from "@supreme/aureon-web";
import { App } from "./App.js";
import { applyA11y } from "./settings.js";
import "@supreme/aureon-web/components.css";
import "./styles.css";

// Apply the saved Light/Dark/Auto + accent theme, the viewport's density mode, and
// accessibility prefs before first paint.
initAureonTheme();
initAureonDensity();
try { applyA11y({ largeText: false, highContrast: false, ...JSON.parse(localStorage.getItem("supreme.a11y") ?? "{}") }); } catch { /* defaults */ }

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
