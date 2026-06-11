import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The dashboard reuses the embed engines directly from source
      // (directory alias so subpath imports like ./engine3d resolve too).
      "@liveface/embed": fileURLToPath(new URL("../embed/src", import.meta.url)),
    },
  },
  server: {
    host: true, // listen on LAN so phones/tablets on the same Wi-Fi can test
    allowedHosts: [".trycloudflare.com"], // remote testing via cloudflared tunnels
    port: 5174,
    proxy: {
      "/api": {
        target: "http://localhost:7002",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
