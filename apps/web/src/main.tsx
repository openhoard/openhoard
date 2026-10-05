import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createApi } from "./api.js";
import { App, type Browser } from "./app.js";
import "./theme.css";

/** The tab's own notes; a browser that refuses storage just doesn't remember. */
const browser: Browser = {
  // Replaced, not added: Back from the sign-in goes to where the person was before, not to a
  // page that sends them forward again.
  leave: (url) => window.location.replace(url),
  here: () => window.location.pathname + window.location.search,
  onRestored: (again) => {
    const shown = (e: PageTransitionEvent) => {
      if (e.persisted) again();
    };
    window.addEventListener("pageshow", shown);
    return () => window.removeEventListener("pageshow", shown);
  },
  recall: (key) => {
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  remember: (key, value) => {
    try {
      if (value === null) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, value);
    } catch {
      // Without storage a sign-in that doesn't stick isn't noticed; nothing else changes.
    }
  },
  now: () => Date.now(),
};

const api = createApi((input, init) => window.fetch(input, init));

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App api={api} browser={browser} />
  </StrictMode>,
);
