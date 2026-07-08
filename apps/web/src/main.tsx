import "@fontsource-variable/inter";
import "@fontsource/amiri/400.css";
import "@fontsource/amiri/700.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./i18n";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
