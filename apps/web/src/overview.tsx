import { useEffect, useState } from "react";
import { ApiError, SignedOut, type Api, type Source } from "./api.js";
import { connectorName, countsText, sourceStatus, unmatchedText, when } from "./words.js";

type Loaded =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "refused" }
  | { state: "ready"; sources: Source[] };

/** Where each connected source stands: the first thing a pilot's admin wants to know. */
export function Overview(props: { api: Api; tenantId: string; onSignedOut: () => void }) {
  const { api, tenantId, onSignedOut } = props;
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setLoaded({ state: "loading" });
    api.sources().then(
      (sources) => current && setLoaded({ state: "ready", sources }),
      (err: unknown) => {
        if (!current) return;
        if (err instanceof SignedOut) onSignedOut();
        // Refused is an answer, not a failure: asking again changes nothing (and each refusal
        // is written to the audit log).
        else if (err instanceof ApiError && err.status === 403) setLoaded({ state: "refused" });
        else setLoaded({ state: "failed" });
      },
    );
    return () => {
      current = false;
    };
  }, [api, onSignedOut, attempt]);

  return (
    <>
      <h1>Overview</h1>
      <section aria-labelledby="sources-heading">
        <h2 id="sources-heading">Sources</h2>
        <p className="muted">
          Where your files live. OpenHoard reads them in place and keeps who can see what as the
          source has it.
        </p>
        <div role="status">{loaded.state === "loading" && <p>Loading…</p>}</div>
        {loaded.state === "failed" && (
          <div className="notice" role="alert">
            <p>The sources couldn't be loaded.</p>
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
        {loaded.state === "refused" && (
          <div className="notice" role="alert">
            <p>
              You aren't allowed to see this. Your admin role may have been taken away since you
              signed in.
            </p>
          </div>
        )}
        {loaded.state === "ready" && loaded.sources.length === 0 && (
          <p className="card">
            No source is connected yet. Sources are set in the server's config file; each appears
            here once the server has started reading it.
          </p>
        )}
        {loaded.state === "ready" && loaded.sources.length > 0 && (
          <ul className="cards">
            {loaded.sources.map((s) => (
              <SourceCard key={s.source} source={s} tenantId={tenantId} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

const TONE_WORD = { ok: "OK", busy: "Working", attention: "Needs attention" } as const;

function SourceCard({ source: s, tenantId }: { source: Source; tenantId: string }) {
  const status = sourceStatus(s, tenantId);
  const counted = countsText(s.lastCounts);
  const unmatched = unmatchedText(s.lastCounts);
  return (
    <li className="card">
      <div className="card-head">
        <h3>{s.source}</h3>
        <span className={`badge badge-${status.tone}`}>{TONE_WORD[status.tone]}</span>
      </div>
      <p className="muted">{connectorName(s.connector)}</p>
      <p>{status.text}</p>
      {status.steps && (
        <div className="next">
          <p>This is done on the server, by whoever runs it:</p>
          <ul>
            {status.steps.map((step) => (
              <li key={step.command}>
                {step.does}
                <code>{step.command}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {s.lastRunAt !== null && (
        <p className="muted">
          Last sync <time dateTime={s.lastRunAt}>{when(s.lastRunAt)}</time>
          {counted ? `: ${counted}.` : "."}
        </p>
      )}
      {unmatched && <p className="next">{unmatched}</p>}
    </li>
  );
}
