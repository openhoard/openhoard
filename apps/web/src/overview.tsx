import { useEffect, useRef, useState } from "react";
import { ApiError, SignedOut, type Api, type Source, type SourceSkips } from "./api.js";
import {
  connectorName,
  count,
  countsText,
  leftOutText,
  sourceStatus,
  unmatchedText,
  when,
} from "./words.js";

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
              <SourceCard
                key={s.source}
                source={s}
                tenantId={tenantId}
                api={api}
                onSignedOut={onSignedOut}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

const TONE_WORD = { ok: "OK", busy: "Working", attention: "Needs attention" } as const;

function SourceCard(props: {
  source: Source;
  tenantId: string;
  api: Api;
  onSignedOut: () => void;
}) {
  const { source: s, tenantId, api, onSignedOut } = props;
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
      {s.lastRunAt !== null && (
        <LeftOut source={s.source} tenantId={tenantId} api={api} onSignedOut={onSignedOut} />
      )}
    </li>
  );
}

type Skipped =
  | { state: "closed" }
  | { state: "loading" }
  | { state: "failed" }
  | { state: "refused" }
  /** `busy`: another reason is being asked for; what is shown is the last answer. */
  | { state: "ready"; found: SourceSkips; reason: string | null; busy: boolean };

const NOTHING: SourceSkips = { total: 0, byReason: {}, skips: [] };

/**
 * What the source's syncs left out, and why (core/jobs skips.ts), asked for when opened: each
 * reason with how many, and the items themselves, most recently met first. An item is said by
 * where it is in its source, as text.
 */
function LeftOut(props: { source: string; tenantId: string; api: Api; onSignedOut: () => void }) {
  const { source, tenantId, api, onSignedOut } = props;
  const [skipped, setSkipped] = useState<Skipped>({ state: "closed" });
  const [asked, setAsked] = useState<{ reason: string | null; n: number } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  /** Where focus goes after the next render: the panel's heading, or back to the opener. */
  const [focus, setFocus] = useState<"heading" | "opener" | null>(null);

  useEffect(() => {
    if (focus === "heading") heading.current?.focus();
    if (focus === "opener") opener.current?.focus();
    if (focus !== null) setFocus(null);
  }, [focus]);

  useEffect(() => {
    if (asked === null) return;
    let current = true;
    setSkipped((was) => (was.state === "ready" ? { ...was, busy: true } : { state: "loading" }));
    api.sourceSkips(source, asked.reason ?? undefined).then(
      (found) =>
        current && setSkipped({ state: "ready", found, reason: asked.reason, busy: false }),
      (err: unknown) => {
        if (!current) return;
        if (err instanceof SignedOut) onSignedOut();
        else if (err instanceof ApiError && err.status === 403) setSkipped({ state: "refused" });
        // No sync row yet (a first crawl under way): nothing is kept yet.
        else if (err instanceof ApiError && err.status === 404) {
          setSkipped({ state: "ready", found: NOTHING, reason: null, busy: false });
        } else setSkipped({ state: "failed" });
      },
    );
    return () => {
      current = false;
    };
  }, [api, source, asked, onSignedOut]);

  if (skipped.state === "closed") {
    return (
      <button
        type="button"
        ref={opener}
        aria-label={`What was left out of ${source}`}
        onClick={() => {
          // Open now, so the heading is there to take focus.
          setSkipped({ state: "loading" });
          setAsked({ reason: null, n: 0 });
          setFocus("heading");
        }}
      >
        What was left out
      </button>
    );
  }
  const id = `left-out-${source}`;
  return (
    <section className="left-out" aria-labelledby={id}>
      <div className="card-head">
        <h4 id={id} ref={heading} tabIndex={-1}>
          Left out of {source}
        </h4>
        <button
          type="button"
          onClick={() => {
            setAsked(null);
            setSkipped({ state: "closed" });
            setFocus("opener");
          }}
        >
          Hide
        </button>
      </div>
      <div role="status">
        {(skipped.state === "loading" || (skipped.state === "ready" && skipped.busy)) && (
          <p>Loading…</p>
        )}
      </div>
      {skipped.state === "failed" && (
        <div className="notice" role="alert">
          <p>What was left out couldn't be loaded.</p>
          <button
            type="button"
            onClick={() => setAsked((a) => ({ reason: a?.reason ?? null, n: (a?.n ?? 0) + 1 }))}
          >
            Try again
          </button>
        </div>
      )}
      {skipped.state === "refused" && (
        <p className="notice" role="alert">
          You aren't allowed to see this. Your admin role may have been taken away since you signed
          in.
        </p>
      )}
      {skipped.state === "ready" && (
        <LeftOutList
          skipped={skipped}
          command={`admin source skips --tenant ${tenantId} --source ${source}`}
          onReason={(reason) => setAsked({ reason, n: 0 })}
        />
      )}
    </section>
  );
}

function LeftOutList(props: {
  skipped: Extract<Skipped, { state: "ready" }>;
  command: string;
  onReason: (reason: string | null) => void;
}) {
  const { found, reason, busy } = props.skipped;
  if (found.total === 0) {
    return (
      <p className="muted">
        Nothing is kept as left out. (A sync's own count, above, can include items it couldn't
        name.)
      </p>
    );
  }
  const reasons = Object.entries(found.byReason).sort((a, b) => b[1] - a[1]);
  const shown = reason === null ? found.total : (found.byReason[reason] ?? 0);
  return (
    <>
      <p>
        {count(found.total, "item")} left out. They aren't in OpenHoard, so nobody finds them
        through it; the source still has them.
      </p>
      <ul className="left-out-reasons">
        {reasons.map(([code, n]) => (
          <li key={code}>
            <button
              type="button"
              aria-pressed={reason === code}
              disabled={busy}
              onClick={() => props.onReason(reason === code ? null : code)}
            >
              {leftOutText(code)}: {n.toLocaleString("en")}
            </button>
          </li>
        ))}
      </ul>
      <ul className="values" aria-busy={busy}>
        {found.skips.map((k) => (
          <li key={k.externalId}>
            <span className="value-name">
              <strong>{k.path === null ? k.externalId : k.path.join(" / ")}</strong>
            </span>
            <span className="muted">
              {leftOutText(k.reason)}. Left out since{" "}
              <time dateTime={k.firstSeenAt}>{when(k.firstSeenAt)}</time>.
            </span>
          </li>
        ))}
      </ul>
      {shown > found.skips.length && (
        <p className="muted">
          The {found.skips.length.toLocaleString("en")} met most recently are shown, of{" "}
          {shown.toLocaleString("en")}. On the server, <code>{props.command}</code> lists more.
        </p>
      )}
    </>
  );
}
