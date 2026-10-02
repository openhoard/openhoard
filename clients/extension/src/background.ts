import { capturePage, type Captured } from "./capture.js";
import { browserEnv } from "./env.js";
import { fileName, pdfName, save, SaveError, type Saved } from "./lib.js";

/*
 * The extension's worker (T-1207): saves the tab the person points at, from the toolbar popup
 * or the page's menu. Connecting happens on the options page (options.ts), which stays open
 * through a sign-in; this worker only needs a moment per save.
 *
 * - A page: its readable text as Markdown (capture.ts, run inside the page), with its address.
 * - A PDF (the tab shows one, or the page can't be read and its address is a PDF's): the file
 *   itself, fetched again as the person (their cookies), with its address.
 * - A selection: its text as Markdown, named with the time, so two selections from one page
 *   are two files.
 * `activeTab` is what lets it read the tab, and only when the person asks.
 */

export type Mode = "page" | "selection";
export type Answer =
  { ok: true; server: string | null; saved?: Saved } | { ok: false; code: string; message: string };

const env = browserEnv();
const PDF_MAX = 100 * 1024 * 1024;

async function savePdf(address: string): Promise<Saved> {
  if (!/^https?:\/\//i.test(address)) {
    throw new SaveError("failed", "Only pages and PDFs on the web can be saved.");
  }
  let res: Response;
  try {
    res = await fetch(address, { credentials: "include" });
  } catch {
    throw new SaveError("failed", "This page can't be read by an extension.");
  }
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  if (!res.ok || !type.includes("pdf")) {
    throw new SaveError("failed", "This page can't be read by an extension.");
  }
  // Held whole in memory on its way: not the place for a huge one, whatever its length says.
  const tooLarge = () =>
    new SaveError("too-large", "This PDF is too large to save from the browser.");
  if (Number(res.headers.get("content-length") ?? "0") > PDF_MAX) throw tooLarge();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  for (;;) {
    const read = await reader?.read();
    if (!read || read.done) break;
    size += read.value.byteLength;
    if (size > PDF_MAX) {
      await reader?.cancel();
      throw tooLarge();
    }
    parts.push(read.value as Uint8Array<ArrayBuffer>);
  }
  return save(env, {
    name: pdfName(address),
    type: "application/pdf",
    body: new Blob(parts, { type: "application/pdf" }),
    url: address,
  });
}

async function saveTab(tab: chrome.tabs.Tab | undefined, mode: Mode): Promise<Saved> {
  if (tab?.id === undefined || !tab.url) throw new SaveError("failed", "No page to save.");
  let captured: Captured | undefined;
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: capturePage,
      args: [mode],
    });
    captured = frame?.result;
  } catch {
    // The browser's own PDF viewer, or a page it keeps extensions out of.
  }
  if (mode === "page" && (captured === undefined || captured.contentType === "application/pdf")) {
    return savePdf(tab.url);
  }
  if (captured === undefined) {
    throw new SaveError("failed", "This page can't be read by an extension.");
  }
  if (!captured.found) {
    throw new SaveError(
      "failed",
      mode === "selection" ? "Nothing is selected." : "Nothing to save on this page.",
    );
  }
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", ".");
  return save(env, {
    name:
      mode === "selection"
        ? fileName(`Selection from ${captured.title} (${stamp})`, "md")
        : fileName(captured.title, "md"),
    type: "text/markdown; charset=utf-8",
    body: captured.markdown,
    url: captured.url,
  });
}

const failure = (e: unknown): Answer =>
  e instanceof SaveError
    ? { ok: false, code: e.code, message: e.message }
    : { ok: false, code: "failed", message: "Something went wrong." };

/** Says how a save from the page's menu went, on the toolbar button. */
async function badge(tabId: number | undefined, answer: Answer): Promise<void> {
  const where = tabId === undefined ? {} : { tabId };
  await chrome.action.setBadgeBackgroundColor({ color: answer.ok ? "#2e7d32" : "#b3261e" });
  await chrome.action.setBadgeText({ text: answer.ok ? "OK" : "!", ...where });
  await chrome.action.setTitle({
    title: answer.ok ? "Saved to OpenHoard" : answer.message,
    ...where,
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.contextMenus.removeAll().then(() => {
    chrome.contextMenus.create({
      id: "page",
      title: "Save page to OpenHoard",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: "selection",
      title: "Save selection to OpenHoard",
      contexts: ["selection"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const mode: Mode = info.menuItemId === "selection" ? "selection" : "page";
  void saveTab(tab, mode)
    .then((saved): Answer => ({ ok: true, server: null, saved }), failure)
    .then((answer) => badge(tab?.id, answer));
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Its own pages only (the popup): never a page of the web, or another extension.
  if ((sender as { id?: string }).id !== chrome.runtime.id) return undefined;
  const m = message as { type?: string; mode?: Mode };
  const work = async (): Promise<Answer> => {
    if (m.type === "state") return { ok: true, server: (await env.load())?.server ?? null };
    if (m.type === "save" && (m.mode === "page" || m.mode === "selection")) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const saved = await saveTab(tab, m.mode);
      return { ok: true, server: (await env.load())?.server ?? null, saved };
    }
    return { ok: false, code: "failed", message: "Unknown request." };
  };
  work().then(respond, (e: unknown) => respond(failure(e)));
  return true;
});
