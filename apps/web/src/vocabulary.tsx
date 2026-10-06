import { useEffect, useState } from "react";
import { ApiError, SignedOut, type Api, type Vocabulary as Vocab } from "./api.js";
import { Link } from "./router.js";
import { count, valueEffects } from "./words.js";

type Loaded =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "refused" }
  | { state: "ready"; vocabulary: Vocab };

/**
 * The vocabulary (T-903): the kinds of tag the organization uses and their values, what a
 * value does to a file that carries it, and which values are only proposed so far. Read-only:
 * packs on the server set it, and a proposed value is approved from Tags to review.
 */
export function Vocabulary(props: { api: Api; onSignedOut: () => void }) {
  const { api, onSignedOut } = props;
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setLoaded({ state: "loading" });
    api.vocabulary().then(
      (vocabulary) => current && setLoaded({ state: "ready", vocabulary }),
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
  }, [api, onSignedOut, attempt]);

  const facets = loaded.state === "ready" ? loaded.vocabulary.facets : [];
  return (
    <>
      <h1>Vocabulary</h1>
      <p className="muted">
        The tags your organization uses: each kind of tag and its values. Tags decide who finds a
        file and which AI gets its content. The vocabulary is set on the server; a value an AI
        proposes is added by approving it in <Link to="/review">Tags to review</Link>.
      </p>
      <div role="status">{loaded.state === "loading" && <p>Loading…</p>}</div>
      {loaded.state === "failed" && (
        <div className="notice" role="alert">
          <p>The vocabulary couldn't be loaded.</p>
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
      {loaded.state === "ready" && facets.length === 0 && (
        <p className="card">
          There is no vocabulary yet. Applying a pack on the server adds a starting set of tags.
        </p>
      )}
      {loaded.state === "ready" && loaded.vocabulary.cut && (
        <p className="next">
          The vocabulary is too large to show whole: the last kinds are cut short.
        </p>
      )}
      {facets.map((f) => (
        <section key={f.key} aria-labelledby={`facet-${f.key}`}>
          <h2 id={`facet-${f.key}`}>{f.label}</h2>
          <p className="muted">
            {f.single ? "A file has one of these at most. " : "A file can have several of these. "}
            {f.public
              ? "Shown on a file's card even to people who can't open it, when they can see the card at all."
              : "Shown only to people who can open the file."}
          </p>
          {f.values.length === 0 ? (
            <p className="muted">No values yet.</p>
          ) : (
            <ul className="values">
              {f.values.map((v) => {
                const effects = valueEffects(v);
                return (
                  <li key={v.value}>
                    <span className="value-name">
                      <strong>{v.label}</strong>
                      {!v.approved && <span className="badge badge-busy">Proposed</span>}
                    </span>
                    {effects.length > 0 && <span className="value-does">{effects.join(" ")}</span>}
                    {v.waiting > 0 && (
                      <span className="muted">
                        {count(v.waiting, "suggestion")} waiting in{" "}
                        <Link to="/review">Tags to review</Link>.
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
    </>
  );
}
