import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyBrandTokens } from "@dojix-desktop/ui";
import "@dojix-desktop/ui/styles.css";
import { App } from "./App";
import { brand } from "./brand";
import { tauriIpc } from "./ipc";

applyBrandTokens(brand, document.documentElement);
document.title = brand.productName;

const container = document.getElementById("root");
if (!container) throw new Error("index.html is missing #root");

createRoot(container).render(
  <StrictMode>
    <App brand={brand} ipc={tauriIpc} />
  </StrictMode>,
);
