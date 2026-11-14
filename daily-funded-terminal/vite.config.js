import { defineConfig } from "vite";

const workerOrigin = "https://throbbing-bonus-6fed.dailyfunded.workers.dev";
const hostingStaticRoute =
  "^/(?!trade(?:/|$)|market(?:/|$)|api(?:/|$)|src(?:/|$)|node_modules(?:/|$)|@vite(?:/|$)|@id(?:/|$)|@fs(?:/|$)|__vite_ping(?:/|$)).*";

export default defineConfig({
  base: "/trade/",
  server: {
    host: "localhost",
    port: 5500,
    strictPort: true,
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
      [hostingStaticRoute]: {
        target: "http://127.0.0.1:5501",
        changeOrigin: true,
      },
    },
  },
});