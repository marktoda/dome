import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import manifestUrl from "./manifest.webmanifest?url";

const link = document.createElement("link");
link.rel = "manifest";
link.href = manifestUrl;
document.head.appendChild(link);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
