import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Installer Portal dev/build. In production this is served behind the optional
// cloud or directly from the hub; it talks to the Supreme API via @supreme/sdk.
export default defineConfig({
  // Root in dev; behind the hub edge the portal is served under /installer/.
  base: process.env.VITE_BASE ?? "/",
  plugins: [react()],
  server: { port: 5174 },
});
