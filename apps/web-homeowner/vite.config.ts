import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Homeowner web app dev/build. Served from the hub (or the optional cloud); talks to
// the Supreme API via @supreme/sdk only — no backend (HA) concept anywhere.
export default defineConfig({
  plugins: [react()],
  server: { port: 5175 },
});
