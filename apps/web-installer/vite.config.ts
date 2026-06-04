import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Installer Portal dev/build. In production this is served behind the optional
// cloud or directly from the hub; it talks to the Supreme API via @supreme/sdk.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174 },
});
