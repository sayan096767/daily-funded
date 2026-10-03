import { defineConfig } from "vite";

const workerOrigin = "https://throbbing-bonus-6fed.dailyfunded.workers.dev";

export default defineConfig({
  base: "/trade/",
  server: {
    proxy: {
      "/market": {
        target: workerOrigin,
        changeOrigin: true,
        secure: true,
      },
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },
});