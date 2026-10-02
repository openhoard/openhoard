/*
 * The part of the WebExtensions API this extension uses, as Chrome, Edge and Firefox (121 and
 * later) all provide it under `chrome`, with promises. Declared here rather than taken from a
 * types package: it is a page of types, and one dependency fewer.
 */
declare namespace chrome {
  namespace runtime {
    const lastError: { message?: string } | undefined;
    const id: string;
    function sendMessage(message: unknown): Promise<unknown>;
    function openOptionsPage(): Promise<void>;
    const onMessage: {
      addListener(
        listener: (
          message: unknown,
          sender: unknown,
          sendResponse: (response: unknown) => void,
        ) => boolean | undefined,
      ): void;
    };
    const onInstalled: { addListener(listener: () => void): void };
  }
  namespace storage {
    const local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(key: string): Promise<void>;
    };
  }
  namespace identity {
    function getRedirectURL(path?: string): string;
    function launchWebAuthFlow(details: {
      url: string;
      interactive: boolean;
    }): Promise<string | undefined>;
  }
  namespace permissions {
    function request(permissions: { origins: string[] }): Promise<boolean>;
    function contains(permissions: { origins: string[] }): Promise<boolean>;
  }
  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      title?: string;
    }
    function query(query: { active: boolean; currentWindow: boolean }): Promise<Tab[]>;
  }
  namespace scripting {
    function executeScript<A extends unknown[], R>(injection: {
      target: { tabId: number };
      func: (...args: A) => R;
      args: A;
    }): Promise<{ result?: R }[]>;
  }
  namespace contextMenus {
    function create(properties: { id: string; title: string; contexts: string[] }): void;
    function removeAll(): Promise<void>;
    const onClicked: {
      addListener(listener: (info: { menuItemId: string | number }, tab?: tabs.Tab) => void): void;
    };
  }
  namespace action {
    function setBadgeText(details: { text: string; tabId?: number }): Promise<void>;
    function setBadgeBackgroundColor(details: { color: string }): Promise<void>;
    function setTitle(details: { title: string; tabId?: number }): Promise<void>;
  }
}
