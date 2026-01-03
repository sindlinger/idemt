import "./monaco/setup";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

const log = (message: string, scope = "renderer") => {
  if (typeof window?.api?.log === "function") {
    window.api.log({ scope, message });
  }
};

log("main.tsx loaded");

window.addEventListener("error", (event) => {
  log(
    `error ${event.message} @ ${event.filename}:${event.lineno}:${event.colno}`,
    "renderer:error"
  );
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason ? String(event.reason) : "unknown";
  log(`unhandledrejection ${reason}`, "renderer:error");
});

window.addEventListener("beforeunload", () => {
  log("beforeunload", "renderer:close");
});

window.addEventListener("unload", () => {
  log("unload", "renderer:close");
});

const Root = import.meta.env.DEV ? (
  <App />
) : (
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

ReactDOM.createRoot(document.getElementById("root")!).render(Root);
