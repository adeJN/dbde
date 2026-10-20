import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./theme.css";
import { initializeTheme } from "./lib/theme";
import { loadDetachedWorkspace } from "./lib/api";
initializeTheme();
async function start() {
  await loadDetachedWorkspace();
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
void start().catch(() => {
  document.getElementById("root")!.textContent =
    "The workspace could not be loaded. Your original tab remains in its window.";
});
