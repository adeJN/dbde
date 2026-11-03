import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: { port: 1420, strictPort: true },
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/monaco-editor/"))
            return "monaco-editor";
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id))
            return "react-vendor";
        },
      },
    },
  },
  clearScreen: false,
});
