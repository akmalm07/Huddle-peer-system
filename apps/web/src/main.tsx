import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./style/index.css";

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js");
}

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Missing application root");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
