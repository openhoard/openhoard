import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SignedOut, type Api, type Me } from "./api.js";
import { Clients } from "./clients.js";
import { Overview } from "./overview.js";
import { Review } from "./review.js";
import { BASE, Link, usePath } from "./router.js";
import { Vocabulary } from "./vocabulary.js";

/*
 * The shell (T-901): who is signed in, the way around, the way out. It holds nothing of
 * anyone's; what it shows it asks the server for as the signed-in person, and the server
 * decides.
 */

export interface Browser {
  /** Leaves the app for another page of this server (the sign-in). */
  leave(url: string): void;
  /**
   * Calls back when the page is shown again as it was left (Back, out of the browser's cache of
   * whole pages): nothing ran meanwhile, so who is signed in is asked again. Returns the undo.
   */
  onRestored(again: () => void): () => void;
  /** Where the browser is, to come back to after signing in. */
  here(): string;
  /** A note that lasts as long as the tab: how a sign-in that doesn't stick is noticed. */
  recall(key: string): string | null;
  remember(key: string, value: string | null): void;
  now(): number;
}

type Session =
  | { state: "loading" }
  | { state: "leaving" }
  | { state: "unreachable" }
  | { state: "stuck" }
  | { state: "signed-out" }
  | { state: "in"; me: Me };

const TRIED = "oh-sign-in-tried";
/** A second trip to the sign-in this soon after the first means the first didn't stick. */
const STICK_MS = 60_000;

/** The sign-in, and back to a page of this app (the server checks the path again). */
export const signInUrl = (returnTo: string) =>
  `/auth/sign-in?return_to=${encodeURIComponent(returnTo === BASE || returnTo.startsWith(`${BASE}/`) ? returnTo : `${BASE}/`)}`;

const PAGES: readonly { path: string; label: string }[] = [
  { path: "/", label: "Overview" },
  { path: "/review", label: "Tags to review" },
  { path: "/clients", label: "AI clients" },
  { path: "/vocabulary", label: "Vocabulary" },
];

export function App({ api, browser }: { api: Api; browser: Browser }) {
  const [session, setSession] = useState<Session>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const path = usePath();

  /** Nobody is signed in: to the sign-in and back here, unless that was just tried. */
  const toSignIn = useCallback(() => {
    const tried = Number(browser.recall(TRIED));
    if (tried > 0 && browser.now() - tried < STICK_MS) {
      browser.remember(TRIED, null);
      setSession({ state: "stuck" });
      return;
    }
    browser.remember(TRIED, String(browser.now()));
    setSession({ state: "leaving" });
    browser.leave(signInUrl(browser.here()));
  }, [browser]);

  useEffect(() => {
    let current = true;
    setSession({ state: "loading" });
    api.me().then(
      (me) => {
        if (!current) return;
        browser.remember(TRIED, null);
        setSession({ state: "in", me });
      },
      (err: unknown) => {
        if (!current) return;
        if (err instanceof SignedOut) toSignIn();
        else setSession({ state: "unreachable" });
      },
    );
    return () => {
      current = false;
    };
  }, [api, browser, toSignIn, attempt]);

  // Back to this page as it was left: ask again who is there. Not after signing out here:
  // that would send them to sign in, and a provider still signed in lets them straight back.
  const state = useRef(session.state);
  state.current = session.state;
  useEffect(
    () =>
      browser.onRestored(() => {
        if (state.current !== "signed-out") setAttempt((n) => n + 1);
      }),
    [browser],
  );

  // A new page: to its top, and the keyboard and screen readers with it.
  const shown = useRef(path);
  useEffect(() => {
    if (shown.current === path) return;
    shown.current = path;
    window.scrollTo(0, 0);
    document.getElementById("main")?.focus();
  }, [path]);

  const signOut = async () => {
    try {
      await api.signOut();
    } catch (err) {
      // Already signed out is signed out; anything else, the session is still there.
      if (!(err instanceof SignedOut)) {
        setSession({ state: "unreachable" });
        return;
      }
    }
    setSession({ state: "signed-out" });
  };

  /**
   * A fresh sign-in, for what the server asks one for. The session is ended first: the sign-in
   * page sends whoever is signed in straight back, as they were.
   */
  const signInAgain = useCallback(async () => {
    try {
      await api.signOut();
    } catch (err) {
      if (!(err instanceof SignedOut)) return false;
    }
    // Noted as any trip to the sign-in is: one that doesn't stick is said, not repeated.
    browser.remember(TRIED, String(browser.now()));
    setSession({ state: "leaving" });
    browser.leave(signInUrl(browser.here()));
    return true;
  }, [api, browser]);

  const page = PAGES.find((p) => p.path === path);
  const inside = session.state === "in" && session.me.admin;
  useEffect(() => {
    document.title = inside && page ? `${page.label} · OpenHoard` : "OpenHoard";
  }, [inside, page]);

  switch (session.state) {
    case "loading":
      return (
        <Alone>
          <p role="status">Loading…</p>
        </Alone>
      );
    case "leaving":
      return (
        <Alone>
          <p role="status">Taking you to sign in…</p>
          <a className="button" href={signInUrl(browser.here())}>
            Sign in
          </a>
        </Alone>
      );
    case "unreachable":
      return (
        <Alone title="OpenHoard couldn't be reached">
          <p>The server didn't answer as expected. Your files and settings are untouched.</p>
          <button type="button" className="primary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </Alone>
      );
    case "stuck":
      return (
        <Alone title="You're not signed in">
          <p>
            You were sent to sign in and came back without being signed in. If you did sign in, this
            browser may be blocking cookies for this site, or your account may not be allowed in.
          </p>
          <a className="button primary" href={signInUrl(browser.here())}>
            Sign in
          </a>
        </Alone>
      );
    case "signed-out":
      return (
        <Alone title="You've signed out">
          <p>Close this tab, or sign in again.</p>
          <a className="button primary" href={signInUrl(`${BASE}/`)}>
            Sign in
          </a>
        </Alone>
      );
    case "in":
      break;
  }

  const { me } = session;
  const who = me.user.email ?? me.user.displayName;
  if (!me.admin) {
    return (
      <Alone title="This area is for admins">
        <p>
          You're signed in as <strong>{who}</strong>, who isn't one of your organization's OpenHoard
          admins. Your files are reached through your AI assistant, not from here.
        </p>
        <button type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </Alone>
    );
  }

  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to the page
      </a>
      <header className="top">
        <Brand />
        <div className="who">
          <span className="who-name" title={who}>
            {me.user.displayName}
          </span>
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <nav className="side" aria-label="Sections">
        <ul>
          {PAGES.map((p) => (
            <li key={p.path}>
              <Link to={p.path} current={p.path === path}>
                {p.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <main id="main" tabIndex={-1}>
        {page ? (
          <Failsafe key={path}>
            {page.path === "/clients" ? (
              <Clients api={api} onSignedOut={toSignIn} onSignInAgain={signInAgain} />
            ) : page.path === "/review" ? (
              <Review api={api} onSignedOut={toSignIn} />
            ) : page.path === "/vocabulary" ? (
              <Vocabulary api={api} onSignedOut={toSignIn} />
            ) : (
              <Overview api={api} tenantId={me.tenantId} onSignedOut={toSignIn} />
            )}
          </Failsafe>
        ) : (
          <>
            <h1>Nothing here</h1>
            <p>
              There's no page at this address. <Link to="/">Back to the overview</Link>
            </p>
          </>
        )}
      </main>
    </div>
  );
}

function Brand() {
  return (
    <span className="brand">
      <img src={`${BASE}/logo.svg`} alt="" width="28" height="28" />
      OpenHoard
    </span>
  );
}

/** A page with nothing around it: before anyone is known, and for those the app has nothing for. */
function Alone(props: { title?: string; children: ReactNode }) {
  return (
    <main className="alone">
      <Brand />
      {props.title && <h1>{props.title}</h1>}
      {props.children}
    </main>
  );
}

/** A page that falls over says so, inside the shell: the way around and the way out stay. */
class Failsafe extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="notice" role="alert">
        <h1>This page couldn't be shown</h1>
        <p>
          Something went wrong showing it. Nothing was changed. Loading the page again may help.
        </p>
      </div>
    );
  }
}
