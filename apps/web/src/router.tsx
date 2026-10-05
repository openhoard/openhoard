import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

/*
 * Pages by path under /admin/, with the browser's own history: a link is a real link (it opens
 * in a new tab, it can be copied), and the server answers any path under /admin/ with the app.
 */

export const BASE = "/admin";

/** The page's path within the app: "/" for /admin and /admin/, "/x" for /admin/x. */
export function appPath(pathname: string): string {
  const inside = pathname === BASE || pathname.startsWith(`${BASE}/`);
  const rest = inside ? pathname.slice(BASE.length) : pathname;
  const trimmed = rest.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

const CHANGED = "oh:navigate";

export function navigate(to: string): void {
  window.history.pushState(null, "", BASE + (to === "/" ? "/" : to));
  window.dispatchEvent(new Event(CHANGED));
}

export function usePath(): string {
  const [path, setPath] = useState(() => appPath(window.location.pathname));
  useEffect(() => {
    const read = () => setPath(appPath(window.location.pathname));
    window.addEventListener("popstate", read);
    window.addEventListener(CHANGED, read);
    return () => {
      window.removeEventListener("popstate", read);
      window.removeEventListener(CHANGED, read);
    };
  }, []);
  return path;
}

export function Link(props: { to: string; current?: boolean; children: ReactNode }) {
  const follow = (e: MouseEvent<HTMLAnchorElement>) => {
    // A new tab, a download, a middle click: the browser's.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    navigate(props.to);
  };
  return (
    <a
      href={BASE + (props.to === "/" ? "/" : props.to)}
      onClick={follow}
      {...(props.current ? { "aria-current": "page" as const } : {})}
    >
      {props.children}
    </a>
  );
}
