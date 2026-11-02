import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { DemoProvider } from "./components/DemoContext";
import "./styles.css";
createRoot(document.getElementById("root")!).render(
  <StrictMode><DemoProvider><BrowserRouter><App /></BrowserRouter></DemoProvider></StrictMode>,
);
