import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const hqPort = Number(process.env.HQ_PORT ?? 7420);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Only scan the app; local, gitignored prototypes/ HTML files would pull in their own deps.
  optimizeDeps: { entries: ["index.html"] },
  server: {
    // The HQ server reloads itself; don't reload the page for its files.
    watch: { ignored: ["**/server/**", "**/.kh-team/**", "**/.jsmhq/**"] },
    // `pnpm dev:hq`: the UI talks to the HQ server through Vite.
    proxy: { "/ws": { target: `ws://127.0.0.1:${hqPort}`, ws: true } },
  },
});
