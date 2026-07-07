import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import { initAureonTheme } from "@supreme/aureon-web";
import { App } from "./App.js";
import { applyA11y } from "./settings.js";
import "./styles.css";

// Apply the saved Light/Dark/Auto + accent theme + accessibility prefs before first paint.
initAureonTheme();
try { applyA11y({ largeText: false, highContrast: false, ...JSON.parse(localStorage.getItem("supreme.a11y") ?? "{}") }); } catch { /* defaults */ }

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
