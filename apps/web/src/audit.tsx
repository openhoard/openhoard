import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  ApiError,
  SignedOut,
  type Api,
  type AuditEvent,
  type AuditQuery,
  type Exported,
  type Verified,
} from "./api.js";
import { count, when } from "./words.js";

/*
 * The audit log (T-905): what happened, newest first, found by who, what and when; a check that
 * the log is whole; and a download of what was found, which the log records. Read-only: nothing
 * here changes anything but the log's own record of a download.
 */

type Loaded =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "refused" }
  | { state: "invalid" }
  | {
      state: "ready";
      events: AuditEvent[];
      next: number | null;
      older: "idle" | "busy" | "failed";
    };

type Checked = { state: "idle" } | { state: "busy" } | { state: "failed" } | Verified;

type Download = null | { state: "busy" } | Exported;

/** The fields as typed: applied when the form is sent. */
interface Draft {
  actor: string;
  action: string;
  decision: "" | "allow" | "deny";
  object: string;
  from: string;
  until: string;
}
const EMPTY: Draft = { actor: "", action: "", decision: "", object: "", from: "", until: "" };

function queryOf(d: Draft): AuditQuery {
  const q: AuditQuery = {};
  for (const key of ["actor", "action", "object", "from", "until"] as const) {
    const v = d[key].trim();
    if (v !== "") q[key] = v;
  }
  if (d.decision !== "") q.decision = d.decision;
  return q;
}

/** Saves a file the browser was handed, as a download. */
export function saveFile(file: Blob, name: string) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  // After the click has handed it over.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const FIELD_NAMES: Record<string, string> = {
  actor: "Who",
  action: "Action",
  actionPrefix: "Action",
  decision: "Outcome",
  object: "File or object",
  from: "From",
  to: "Until",
};

export function Audit(props: {
  api: Api;
  onSignedOut: () => void;
  onSignInAgain: () => Promise<boolean>;
  /** How a download is handed to the person (tests pass their own). */
  save?: (file: Blob, name: string) => void;
}) {
  const { api, onSignedOut, onSignInAgain, save = saveFile } = props;
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [query, setQuery] = useState<AuditQuery>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [checked, setChecked] = useState<Checked>({ state: "idle" });
  const [download, setDownload] = useState<Download>(null);
  const [stuck, setStuck] = useState(false);
  /** Which load a page of older events belongs to: one for an earlier load is dropped. */
  const load = useRef(0);
  /** Which download is the one to show: one taken before the filter changed is dropped. */
  const taking = useRef(0);
  /** The first of the older events just shown, to move focus to. */
  const [focusSeq, setFocusSeq] = useState<number | null>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (focusSeq === null) return;
    list.current?.querySelector<HTMLElement>(`[data-seq="${focusSeq}"]`)?.focus();
  }, [focusSeq]);

  const failedWith = useCallback(
    (err: unknown): Loaded | null => {
      if (err instanceof SignedOut) {
        onSignedOut();
        return null;
      }
      if (err instanceof ApiError && err.status === 403) return { state: "refused" };
      if (err instanceof ApiError && err.status === 400) return { state: "invalid" };
      return { state: "failed" };
    },
    [onSignedOut],
  );

  useEffect(() => {
    let current = true;
    load.current += 1;
    setFocusSeq(null);
    setLoaded({ state: "loading" });
    api.audit(query).then(
      (page) => current && setLoaded({ state: "ready", ...page, older: "idle" }),
      (err: unknown) => {
        if (!current) return;
        const next = failedWith(err);
        if (next) setLoaded(next);
      },
    );
    return () => {
      current = false;
    };
  }, [api, query, attempt, failedWith]);

  const showOlder = () => {
    if (loaded.state !== "ready" || loaded.next === null || loaded.older === "busy") return;
    const mine = load.current;
    const before = loaded.next;
    setLoaded({ ...loaded, older: "busy" });
    api.audit(query, before).then(
      (page) => {
        if (load.current !== mine) return;
        if (page.events[0]) setFocusSeq(page.events[0].seq);
        setLoaded((l) =>
          l.state === "ready"
            ? {
                state: "ready",
                events: [...l.events, ...page.events],
                next: page.next,
                older: "idle",
              }
            : l,
        );
      },
      (err: unknown) => {
        if (load.current !== mine) return;
        if (err instanceof SignedOut) onSignedOut();
        else setLoaded((l) => (l.state === "ready" ? { ...l, older: "failed" } : l));
      },
    );
  };

  const apply = (e: FormEvent) => {
    e.preventDefault();
    const q = queryOf(draft);
    if (q.from && q.until && q.from > q.until) {
      setProblem("“From” must be on or before “Until”.");
      return;
    }
    setProblem(null);
    forgetDownload();
    setQuery(q);
  };

  const clear = () => {
    setDraft(EMPTY);
    setProblem(null);
    forgetDownload();
    setQuery({});
  };

  /** A download under way is for the old filter: what it comes to isn't this one's. */
  const forgetDownload = () => {
    taking.current += 1;
    setDownload(null);
  };

  const check = () => {
    setChecked({ state: "busy" });
    api.verifyAudit().then(setChecked, (err: unknown) => {
      if (err instanceof SignedOut) onSignedOut();
      else setChecked({ state: "failed" });
    });
  };

  const take = (format: "csv" | "ndjson") => {
    const mine = ++taking.current;
    setDownload({ state: "busy" });
    setStuck(false);
    api.exportAudit(query, format).then(
      (ended) => {
        if (taking.current !== mine) return;
        if (ended.ended === "done") save(ended.file, ended.name);
        setDownload(ended);
      },
      (err: unknown) => {
        if (err instanceof SignedOut) onSignedOut();
        else if (taking.current !== mine) return;
        else setDownload({ ended: "failed" });
      },
    );
  };

  const filtered = Object.keys(query).length > 0;
  const downloading = download !== null && "state" in download;
  return (
    <>
      <h1>Audit log</h1>
      <p className="muted">
        Everything OpenHoard decided, newest first: who asked, for what, and whether it was allowed.
        Each event is linked to the one before it, so a change to any of them shows.
      </p>

      <section aria-labelledby="audit-check" className="card">
        <h2 id="audit-check">Check the log</h2>
        <p className="muted">Reads the whole log and checks every link.</p>
        <button
          type="button"
          disabled={"state" in checked && checked.state === "busy"}
          onClick={check}
        >
          Check the log
        </button>
        <div role="status">
          {"state" in checked && checked.state === "busy" && <p>Checking…</p>}
          {"ok" in checked && checked.ok && (
            <p className="done">
              The log is whole: {count(checked.count, "event")}, each linked to the one before.
            </p>
          )}
        </div>
        <div role="alert">
          {"ok" in checked && !checked.ok && (
            <p className="notice">
              The log has been changed or damaged at event {checked.seq}
              {checked.problem ? `: ${checked.problem}` : ""}. The {count(checked.count, "event")}{" "}
              before it are whole. Keep a copy of the log as it is and tell whoever runs your
              OpenHoard server.
            </p>
          )}
          {"state" in checked && checked.state === "failed" && (
            <p className="notice">The check couldn't be run. Try again.</p>
          )}
        </div>
      </section>

      <form className="audit-filters" onSubmit={apply} aria-label="Find events">
        <label>
          Who
          <input
            type="text"
            value={draft.actor}
            placeholder="user:usr_…"
            onChange={(e) => setDraft({ ...draft, actor: e.target.value })}
          />
        </label>
        <label>
          Action starts with
          <input
            type="text"
            value={draft.action}
            placeholder="source."
            onChange={(e) => setDraft({ ...draft, action: e.target.value })}
          />
        </label>
        <label>
          Outcome
          <select
            value={draft.decision}
            onChange={(e) => setDraft({ ...draft, decision: e.target.value as Draft["decision"] })}
          >
            <option value="">Any</option>
            <option value="allow">Allowed</option>
            <option value="deny">Refused</option>
          </select>
        </label>
        <label>
          File or object
          <input
            type="text"
            value={draft.object}
            onChange={(e) => setDraft({ ...draft, object: e.target.value })}
          />
        </label>
        <label>
          From
          <input
            type="date"
            aria-describedby="audit-dates"
            aria-invalid={problem !== null}
            value={draft.from}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
          />
        </label>
        <label>
          Until
          <input
            type="date"
            aria-describedby="audit-dates"
            aria-invalid={problem !== null}
            value={draft.until}
            onChange={(e) => setDraft({ ...draft, until: e.target.value })}
          />
        </label>
        <div className="actions">
          <button type="submit" className="primary">
            Show
          </button>
          <button type="button" onClick={clear}>
            Clear
          </button>
        </div>
        <div role="alert">{problem && <p className="notice">{problem}</p>}</div>
      </form>
      <p className="muted" id="audit-dates">
        Days and times are this browser's own; “Until” includes its day.
      </p>

      <div className="actions">
        <button type="button" disabled={downloading} onClick={() => take("csv")}>
          Download CSV
        </button>
        <button type="button" disabled={downloading} onClick={() => take("ndjson")}>
          Download NDJSON
        </button>
      </div>
      <p className="muted">
        Downloads {filtered ? "the events that match" : "the whole log"}, every page of it. Each
        download is recorded in the log.
      </p>
      <div role="status">
        {downloading && <p>Preparing the download…</p>}
        {download !== null && "ended" in download && download.ended === "done" && (
          <p className="done">Downloaded {download.name}.</p>
        )}
      </div>
      <div role="alert">
        {download !== null && "ended" in download && download.ended === "sign-in-again" && (
          <div className="notice">
            <p>
              Downloading the log takes a recent sign-in, so a session left open can't do it. Sign
              in again, then download. (If you sign in with a one-time link, you'll need a new one
              from the server.)
            </p>
            <button
              type="button"
              onClick={() => void onSignInAgain().then((left) => setStuck(!left))}
            >
              Sign out and in again
            </button>
            {stuck && <p>Signing out didn't go through. Try again.</p>}
          </div>
        )}
        {download !== null && "ended" in download && download.ended === "refused" && (
          <p className="notice">
            You aren't allowed to download the log. Your admin role may have been taken away since
            you signed in.
          </p>
        )}
        {download !== null && "ended" in download && download.ended === "invalid" && (
          <p className="notice">
            The server didn't accept the filter
            {download.field ? ` (${FIELD_NAMES[download.field] ?? download.field})` : ""}. Change it
            and try again.
          </p>
        )}
        {download !== null && "ended" in download && download.ended === "failed" && (
          <p className="notice">The download didn't finish. Try again.</p>
        )}
      </div>

      <h2>Events</h2>
      <div role="status">{loaded.state === "loading" && <p>Loading…</p>}</div>
      {loaded.state === "failed" && (
        <div className="notice" role="alert">
          <p>The log couldn't be loaded.</p>
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}
      {loaded.state === "refused" && (
        <p className="notice" role="alert">
          You aren't allowed to see this. Your admin role may have been taken away since you signed
          in.
        </p>
      )}
      {loaded.state === "invalid" && (
        <p className="notice" role="alert">
          The server didn't accept the filter. Change it and try again.
        </p>
      )}
      {loaded.state === "ready" && loaded.events.length === 0 && (
        <p className="card">{filtered ? "No events match." : "The log is empty."}</p>
      )}
      {loaded.state === "ready" && loaded.events.length > 0 && (
        <>
          <ul className="values audit-events" ref={list}>
            {loaded.events.map((e) => (
              <Event key={e.seq} event={e} />
            ))}
          </ul>
          {loaded.next !== null && (
            <div className="actions">
              <button type="button" disabled={loaded.older === "busy"} onClick={showOlder}>
                Show older
              </button>
            </div>
          )}
          <div role="alert">
            {loaded.older === "failed" && (
              <p className="notice">The older events couldn't be loaded. Try again.</p>
            )}
          </div>
        </>
      )}
    </>
  );
}

function Event({ event: e }: { event: AuditEvent }) {
  const detail = e.detail ? Object.entries(e.detail) : [];
  return (
    // Focusable from code only: where "Show older" leaves the reader.
    <li data-seq={e.seq} tabIndex={-1}>
      <span className="value-name">
        <strong>{e.action}</strong>
        {e.decision === "deny" ? (
          <span className="badge badge-attention">Refused</span>
        ) : (
          <span className="badge badge-ok">Allowed</span>
        )}
        <span className="muted">
          <time dateTime={e.at}>{when(e.at)}</time> · #{e.seq}
        </span>
      </span>
      <span>
        By <code>{e.actor}</code>
        {e.client && (
          <>
            {" "}
            through <code>{e.client}</code>
          </>
        )}
        {e.object && (
          <>
            {" "}
            on <code>{e.object}</code>
          </>
        )}
      </span>
      {detail.length > 0 && (
        <span className="muted audit-detail">
          {detail.map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}
        </span>
      )}
    </li>
  );
}
