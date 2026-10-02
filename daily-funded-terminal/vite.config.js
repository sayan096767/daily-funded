import { defineConfig } from "vite";

const workerOrigin = "https://throbbing-bonus-6fed.dailyfunded.workers.dev";

export default defineConfig({
  server: {
    proxy: {
      "/market": {
        target: workerOrigin,
        changeOrigin: true,
        secure: true,
      },
    },
  },
});