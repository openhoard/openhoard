import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ApiError,
  SignedOut,
  type Api,
  type Changed,
  type HealthFinding,
  type HealthQuery,
  type HealthReportPage,
  type HealthSheet,
} from "./api.js";
import { saveFile } from "./audit.js";
import { count, when } from "./words.js";

/*
 * The File Health Report (T-1002): what an admin should look at among the organization's
 * files, most pressing first, in the server's words (core/catalog healthPage(), the same as
 * `admin health report`), and the spreadsheet with every file listed. Read-only. Reading it is
 * recorded: it names every file by its title.
 */

type Loaded =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "refused" }
  | { state: "ready"; report: HealthReportPage };

type Sheet = null | { state: "busy" } | HealthSheet;

/** What the thresholds fields hold, as typed. */
interface Draft {
  staleYears: string;
  largeMb: string;
}

/** A link to a file where its source keeps it, only when it is a web address. */
const webAddress = (url: string | null) => (url !== null && /^https?:\/\//i.test(url) ? url : null);

export function Health(props: {
  api: Api;
  onSignedOut: () => void;
  onSignInAgain: () => Promise<boolean>;
  /** How a download is handed to the person (tests pass their own). */
  save?: (file: Blob, name: string) => void;
}) {
  const { api, onSignedOut, onSignInAgain, save = saveFile } = props;
  const [query, setQuery] = useState<HealthQuery>({});
  const [draft, setDraft] = useState<Draft>({ staleYears: "", largeMb: "" });
  /** A field the server wouldn't take, and why. */
  const [problem, setProblem] = useState<{ field: "stale" | "large"; message: string } | null>(
    null,
  );
  /** Whether the person typed in the fields since they last sent them: a load leaves them be. */
  const edited = useRef(false);
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [stuck, setStuck] = useState(false);
  /** Which download is the one to show: one taken before the thresholds changed is dropped. */
  const taking = useRef(0);

  useEffect(() => {
    let current = true;
    setLoaded({ state: "loading" });
    api.health(query).then(
      (report) => {
        if (!current) return;
        setLoaded({ state: "ready", report });
        // The fields say what the report was judged by, unless they are being changed.
        if (edited.current) return;
        setDraft({
          staleYears: String(Number((report.thresholds.staleAfterDays / 365).toFixed(4))),
          largeMb: String(Math.round(report.thresholds.largeBytes / (1024 * 1024))),
        });
      },
      (err: unknown) => {
        if (!current) return;
        if (err instanceof SignedOut) onSignedOut();
        else if (err instanceof ApiError && err.status === 403) setLoaded({ state: "refused" });
        else setLoaded({ state: "failed" });
      },
    );
    return () => {
      current = false;
    };
  }, [api, query, attempt, onSignedOut]);

  const apply = (e: FormEvent) => {
    e.preventDefault();
    const years = Number(draft.staleYears);
    const mb = Number(draft.largeMb);
    const staleDays = Math.round(years * 365);
    if (draft.staleYears.trim() === "" || !(staleDays >= 1 && staleDays <= 36_500)) {
      setProblem({ field: "stale", message: "“Not changed in” is a number of years, up to 100." });
      return;
    }
    if (draft.largeMb.trim() === "" || !(Number.isInteger(mb) && mb >= 1 && mb <= 1_000_000)) {
      setProblem({ field: "large", message: "“Larger than” is a whole number of MB, from 1." });
      return;
    }
    setProblem(null);
    edited.current = false;
    taking.current += 1;
    setSheet(null);
    setQuery({ staleDays, largeMb: mb });
  };

  const take = () => {
    const mine = ++taking.current;
    setSheet({ state: "busy" });
    setStuck(false);
    api.exportHealth(query).then(
      (ended) => {
        if (taking.current !== mine) return;
        if (ended.ended === "done") save(ended.file, ended.name);
        setSheet(ended);
      },
      (err: unknown) => {
        if (err instanceof SignedOut) onSignedOut();
        else if (taking.current === mine) setSheet({ ended: "failed" });
      },
    );
  };

  const busy = sheet !== null && "state" in sheet;
  const ended = sheet !== null && "ended" in sheet ? sheet : null;
  return (
    <>
      <h1>File health</h1>
      <p className="muted">
        What to look at among your organization's files: what is shared too widely, tied to people
        who have left, old, copied or large. Most pressing first. Opening this page is recorded in
        the audit log, as it names every file it lists.
      </p>

      <form className="audit-filters" onSubmit={apply} aria-label="What counts" noValidate>
        <label>
          Not changed in (years)
          <input
            type="number"
            min="0.01"
            max="100"
            step="any"
            inputMode="decimal"
            value={draft.staleYears}
            aria-invalid={problem?.field === "stale"}
            aria-describedby={problem?.field === "stale" ? "health-problem" : undefined}
            onChange={(e) => {
              edited.current = true;
              setDraft({ ...draft, staleYears: e.target.value });
            }}
          />
        </label>
        <label>
          Larger than (MB)
          <input
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            value={draft.largeMb}
            aria-invalid={problem?.field === "large"}
            aria-describedby={problem?.field === "large" ? "health-problem" : undefined}
            onChange={(e) => {
              edited.current = true;
              setDraft({ ...draft, largeMb: e.target.value });
            }}
          />
        </label>
        <div className="actions">
          <button type="submit" className="primary">
            Check again
          </button>
          <button type="button" disabled={busy || loaded.state !== "ready"} onClick={take}>
            Download the spreadsheet
          </button>
        </div>
        <div role="alert">
          {problem && (
            <p className="notice" id="health-problem">
              {problem.message}
            </p>
          )}
        </div>
      </form>
      <p className="muted">
        The spreadsheet lists every file of every finding, not only the first few. Taking it is
        recorded too.
      </p>
      <div role="status">
        {busy && <p>Preparing the spreadsheet…</p>}
        {ended?.ended === "done" && (
          <p className="done">
            Downloaded {ended.name}.
            {ended.cut > 0 &&
              ` It leaves out ${count(ended.cut, "file")} past the first 10,000 of a finding.`}
          </p>
        )}
      </div>
      <div role="alert">
        {ended?.ended === "sign-in-again" && (
          <div className="notice">
            <p>
              The spreadsheet takes a recent sign-in, so a session left open can't take it. Sign in
              again, then download. (If you sign in with a one-time link, you'll need a new one from
              the server.)
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
        {ended?.ended === "refused" && (
          <p className="notice">
            You aren't allowed to take the spreadsheet. Your admin role may have been taken away
            since you signed in.
          </p>
        )}
        {ended?.ended === "invalid" && (
          <p className="notice">
            The server didn't accept those thresholds. Change them and try again.
          </p>
        )}
        {ended?.ended === "failed" && (
          <p className="notice">The download didn't finish. Try again.</p>
        )}
      </div>

      <div role="status">{loaded.state === "loading" && <p>Checking your files…</p>}</div>
      {loaded.state === "failed" && (
        <div className="notice" role="alert">
          <p>The report couldn't be made.</p>
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
      {loaded.state === "ready" && (
        <Report report={loaded.report} dismiss={{ api, onSignedOut, onSignInAgain }} />
      )}
    </>
  );
}

function Report({ report, dismiss }: { report: HealthReportPage; dismiss: Dismissing }) {
  return (
    <>
      <p>
        {report.looked} {report.summary}{" "}
        <span className="muted">
          (As of <time dateTime={report.generatedAt}>{when(report.generatedAt)}</time>.)
        </span>
      </p>
      {report.oneThing !== null && (
        <section className="card" aria-labelledby="health-one-thing">
          <h2 id="health-one-thing">One thing to do</h2>
          <p>{report.oneThing}</p>
        </section>
      )}
      {report.findings.map((f) => (
        <Finding key={f.section} finding={f} {...(f.section === "flagged" ? { dismiss } : {})} />
      ))}
      {report.clean.length > 0 && (
        <section aria-labelledby="health-clean">
          <h2 id="health-clean">
            {report.findings.length === 0 ? "What was checked" : "Nothing found"}
          </h2>
          <ul>
            {report.clean.map((heading) => (
              <li key={heading}>{heading}</li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="health-gaps">
        <h2 id="health-gaps">What this report can't tell you</h2>
        <ul className="muted">
          {report.gaps.map((gap) => (
            <li key={gap}>{gap}</li>
          ))}
        </ul>
      </section>
    </>
  );
}

/** What a flagged file's "not an injection" button needs. */
interface Dismissing {
  api: Api;
  onSignedOut: () => void;
  onSignInAgain: () => Promise<boolean>;
}

/** What an admin's verdict on a flagged file came to, said where the button was. */
const DISMISSED: Record<Exclude<Changed, "conflict">, string> = {
  done: "Marked as not an injection: AI assistants can find it again.",
  "sign-in-again": "This needs a recent sign-in.",
  gone: "That file is gone.",
  refused: "The server refused.",
  failed: "That didn't work. Try again.",
};

function Finding({ finding: f, dismiss }: { finding: HealthFinding; dismiss?: Dismissing }) {
  const id = `health-${f.section}`;
  return (
    <section aria-labelledby={id} className="health-finding">
      <h2 id={id}>
        {f.heading}: {count(f.count, "file")}
        {f.size !== null && <span className="muted"> ({f.size})</span>}
      </h2>
      <p>{f.advice}</p>
      {f.also !== null && <p className="notice">Also: {f.also}</p>}
      <ul className="values">
        {f.items.map((item) => {
          const href = webAddress(item.url);
          return (
            <li key={item.objectId}>
              <span className="value-name">
                {href !== null ? (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    <strong>{item.title}</strong>
                  </a>
                ) : (
                  <strong>{item.title}</strong>
                )}
                {item.size !== null && <span className="muted">{item.size}</span>}
              </span>
              {item.why !== "" && <span className="value-does">{item.why}</span>}
              {dismiss !== undefined && <Dismiss objectId={item.objectId} {...dismiss} />}
            </li>
          );
        })}
      </ul>
      {f.more > 0 && (
        <p className="muted">… and {count(f.more, "more file")}. The spreadsheet lists them all.</p>
      )}
    </section>
  );
}

/**
 * "Not an injection", for one flagged file: the admin's verdict that it is fine as it is now
 * (the server takes the detector's flag off, and records it as theirs). It asks for a recent
 * sign-in, since AI assistants then see the file.
 */
function Dismiss(props: Dismissing & { objectId: string }) {
  const { api, onSignedOut, onSignInAgain, objectId } = props;
  const [ended, setEnded] = useState<Changed | "busy" | null>(null);
  const [stuck, setStuck] = useState(false);
  const decide = () => {
    setEnded("busy");
    api.dismissInjection(objectId).then(setEnded, (err: unknown) => {
      if (err instanceof SignedOut) onSignedOut();
      else setEnded("failed");
    });
  };
  if (ended === "done") return <span className="notice">{DISMISSED.done}</span>;
  return (
    <span className="decide">
      <button type="button" disabled={ended === "busy"} onClick={decide}>
        Not an injection
      </button>
      {ended !== null && ended !== "busy" && ended !== "conflict" && (
        <span role="status">{DISMISSED[ended]}</span>
      )}
      {ended === "sign-in-again" && (
        <button type="button" onClick={() => void onSignInAgain().then((left) => setStuck(!left))}>
          Sign out and in again
        </button>
      )}
      {stuck && <span>Signing out didn't go through. Try again.</span>}
    </span>
  );
}
