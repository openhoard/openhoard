import type { Answer, Mode } from "./background.js";

/* The toolbar popup: save this page or the selection, or go and connect first. */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status");
const ask = (message: unknown) => chrome.runtime.sendMessage(message) as Promise<Answer>;

function show(server: string | null): void {
  $("setup").hidden = server !== null;
  $("ready").hidden = server === null;
  if (server !== null) $("where").textContent = new URL(server).host;
}

async function saving(mode: Mode): Promise<void> {
  const buttons = [...document.querySelectorAll("button")];
  for (const b of buttons) b.disabled = true;
  status.textContent = "Saving…";
  const answer = await ask({ type: "save", mode }).catch((): Answer => ({
    ok: false,
    code: "failed",
    message: "Something went wrong.",
  }));
  for (const b of buttons) b.disabled = false;
  if (answer.ok) {
    const saved = answer.saved;
    status.textContent = !saved
      ? "Saved."
      : saved.created
        ? `Saved "${saved.title}".`
        : saved.newVersion
          ? `Saved a new version of "${saved.title}".`
          : `"${saved.title}" was saved already.`;
    return;
  }
  status.textContent = answer.message;
  if (answer.code === "connect") show(null);
}

const settings = (e?: Event) => {
  e?.preventDefault();
  void chrome.runtime.openOptionsPage();
};
$("set-up").addEventListener("click", () => settings());
$("settings").addEventListener("click", settings);
$("save-page").addEventListener("click", () => void saving("page"));
$("save-selection").addEventListener("click", () => void saving("selection"));
void ask({ type: "state" }).then((answer) => show(answer.ok ? answer.server : null));
