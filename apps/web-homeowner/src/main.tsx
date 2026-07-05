import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initAureonTheme } from "@supreme/aureon-web";
import { App } from "./App.js";
import "./styles.css";

// Apply the saved Light/Dark/Auto + accent theme before first paint.
initAureonTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
