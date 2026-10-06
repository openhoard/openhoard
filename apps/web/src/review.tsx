import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  SignedOut,
  type Api,
  type ReviewDecision,
  type ReviewInbox,
  type ReviewItem,
  type Reviewed,
  type VocabularyFacet,
} from "./api.js";
import { Link } from "./router.js";
import { reviewReasonText, suggestedBy, tagParts, when } from "./words.js";

type Loaded =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ready"; inbox: ReviewInbox; facets: Map<string, VocabularyFacet> };

interface Outcome {
  id: string;
  title: string;
  tag: string;
  /** The item proposed the file's main tag, not a tag. */
  primary: boolean;
  /** What was asked, as it was asked: a question back is answered about this, nothing newer. */
  asked: ReviewDecision;
  ended: Reviewed;
}

const itemId = (id: string) => `review-${id}`;

const NOT_DONE: Record<Exclude<Reviewed["ended"], "done" | "replace">, string> = {
  gone: "That suggestion is no longer waiting: someone decided it meanwhile, or it isn't yours to decide.",
  "not-yours": "You can see that file but aren't allowed to tag it, so this isn't yours to decide.",
  "admin-only": "That decision takes an admin of your organization.",
  invalid: "That can't be done for this suggestion.",
  failed: "That didn't go through. Check the list below, and try again if nothing changed.",
};

/**
 * Tags to review (T-903): what AI suggested for files the signed-in person may tag, to approve,
 * reject, or file under a value the vocabulary already has. The server decides who may decide
 * what (core/catalog review-inbox.ts) and audits it; after a decision the list is read again.
 */
export function Review(props: { api: Api; onSignedOut: () => void }) {
  const { api, onSignedOut } = props;
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const load = useCallback(
    async (quietly: boolean) => {
      if (!quietly) setLoaded({ state: "loading" });
      try {
        const inbox = await api.review();
        // The vocabulary names values and offers the ones to file under. For someone it is
        // not for (it is an admin's to read) the suggestions still show, by their tags.
        const vocabulary = await api.vocabulary().catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 403) return { facets: [], cut: false };
          throw err;
        });
        setLoaded({
          state: "ready",
          inbox,
          facets: new Map(vocabulary.facets.map((f) => [f.key, f])),
        });
      } catch (err) {
        if (err instanceof SignedOut) onSignedOut();
        else setLoaded({ state: "failed" });
      }
    },
    [api, onSignedOut],
  );
  useEffect(() => {
    void load(false);
  }, [load, attempt]);

  const decide = async (item: ReviewItem, decision: ReviewDecision) => {
    if (busy) return;
    setBusy(true);
    setOutcome(null);
    const about = {
      id: item.id,
      title: item.title,
      tag: item.tag,
      primary: item.reason === "primary",
      asked: decision,
    };
    try {
      const ended = await api.decideReview(item.id, decision);
      // A question back (replace?) changes nothing: the list stands as it is.
      if (ended.ended !== "replace") await load(true);
      setOutcome({ ...about, ended });
    } catch (err) {
      if (err instanceof SignedOut) onSignedOut();
      else setOutcome({ ...about, ended: { ended: "failed" } });
    } finally {
      setBusy(false);
    }
  };

  // After a decision the item is gone from the list, and the button pressed with it.
  useEffect(() => {
    if (outcome === null) return;
    const to = document.getElementById(itemId(outcome.id)) ?? document.getElementById("review-top");
    to?.focus();
  }, [outcome]);

  const items = loaded.state === "ready" ? loaded.inbox.items : [];
  const said =
    outcome !== null && (outcome.ended.ended === "done" || !items.some((i) => i.id === outcome.id))
      ? outcome
      : null;

  return (
    <>
      <h1 id="review-top" tabIndex={-1}>
        Tags to review
      </h1>
      <p className="muted">
        Tags that AI suggested for your files and that wait for a person. A suggested tag gives
        nobody access until it is approved; one that restricts a file already does while it waits.
        You see suggestions for the files you are allowed to tag; being an admin doesn't show you
        more.
      </p>
      <div role="status">
        {loaded.state === "loading" && <p>Loading…</p>}
        {said?.ended.ended === "done" && <p className="done">{doneText(said, said.ended)}</p>}
      </div>
      <div role="alert">
        {said !== null && said.ended.ended !== "done" && said.ended.ended !== "replace" && (
          <p className="notice">
            {said.title}: {NOT_DONE[said.ended.ended]}
          </p>
        )}
      </div>
      {loaded.state === "failed" && (
        <div className="notice" role="alert">
          <p>The suggestions couldn't be loaded.</p>
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}
      {loaded.state === "ready" && items.length === 0 && (
        <p className="card">
          {loaded.inbox.capped
            ? "None of the suggestions looked at are on files you may tag, and there were too many to look at them all."
            : "Nothing is waiting for you. Suggestions appear here when they are on a file you are allowed to tag."}
        </p>
      )}
      {loaded.state === "ready" && items.length > 0 && (
        <>
          <ul className="cards">
            {items.map((item) => (
              <ReviewCard
                key={item.id}
                item={item}
                facet={loaded.facets.get(tagParts(item.tag).facet)}
                busy={busy}
                outcome={outcome !== null && outcome.id === item.id ? outcome : null}
                onDecide={(d) => void decide(item, d)}
              />
            ))}
          </ul>
          {loaded.inbox.more && (
            <p className="muted">
              More are waiting: decide some of these and the next ones appear.
            </p>
          )}
          {loaded.inbox.capped && (
            <p className="next">
              So many files have suggestions that not all were looked at. There may be more for you
              that deciding these won't bring up.
            </p>
          )}
        </>
      )}
      <p className="muted">
        <Link to="/vocabulary">See the whole vocabulary</Link>
      </p>
    </>
  );
}

function doneText(o: Outcome, done: Extract<Reviewed, { ended: "done" }>): string {
  const off = done.replaced.length > 0 ? `, in place of ${done.replaced.join(", ")}` : "";
  const did = o.asked.decision;
  if (o.primary) {
    return did === "reject"
      ? `${o.title}: ${o.tag} stays on the file, and isn't its main tag.`
      : `${o.title}: ${o.tag} is now its main tag.`;
  }
  if (did === "reject") {
    const others =
      done.alsoClosed > 0
        ? ` ${done.alsoClosed.toLocaleString("en")} other ${done.alsoClosed === 1 ? "suggestion" : "suggestions"} of the same value closed with it.`
        : "";
    return `${o.title}: ${o.tag} rejected.${others}`;
  }
  if (did === "merge") {
    return `${o.title}: tagged ${done.applied ?? o.tag}${off}, instead of ${o.tag}.`;
  }
  return `${o.title}: ${o.tag} approved${off}.`;
}

function ReviewCard(props: {
  item: ReviewItem;
  facet: VocabularyFacet | undefined;
  busy: boolean;
  outcome: Outcome | null;
  onDecide: (decision: ReviewDecision) => void;
}) {
  const { item, facet, busy, outcome, onDecide } = props;
  const { facet: kind, value } = tagParts(item.tag);
  const known = facet?.values.find((v) => v.value === value);
  // Values to file it under instead: the approved ones of the same kind.
  const others = (facet?.values ?? []).filter((v) => v.approved && v.value !== value);
  const [into, setInto] = useState("");
  const question = outcome?.ended.ended === "replace" ? outcome : null;
  const replaces = question?.ended.ended === "replace" ? question.ended.replaces : [];
  const failed =
    outcome !== null && outcome.ended.ended !== "done" && outcome.ended.ended !== "replace"
      ? outcome.ended.ended
      : null;
  const primary = item.reason === "primary";

  return (
    <li className="card">
      <div className="card-head">
        <h3 id={itemId(item.id)} tabIndex={-1}>
          {item.title === "" ? "(a file with no title)" : item.title}
        </h3>
        {item.admin && <span className="badge badge-busy">Admin decides</span>}
      </div>
      <p>
        {primary ? "Suggested main tag: " : "Suggested tag: "}
        <strong className="tag">
          {facet?.label ?? kind}: {known?.label ?? value}
        </strong>
        {/* A value not yet approved is named by whoever proposed it: its own id beside it. */}
        {known !== undefined && !known.approved && (
          <>
            {" "}
            <span className="muted">(as {item.tag})</span>
          </>
        )}
      </p>
      <p>{reviewReasonText(item, known?.approved === true)}</p>
      <p className="muted">
        {suggestedBy(item.appliedBy)}
        {item.createdAt !== null && (
          <>
            , <time dateTime={item.createdAt}>{when(item.createdAt)}</time>
          </>
        )}
        .
      </p>
      <div className="decide">
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => onDecide({ decision: "approve" })}
          >
            {primary ? "Make it the main tag" : "Approve"}
          </button>
          <button type="button" disabled={busy} onClick={() => onDecide({ decision: "reject" })}>
            {primary ? "Leave it as it is" : "Reject"}
          </button>
        </div>
        {!primary && others.length > 0 && (
          <div className="instead">
            <label>
              Or use a value you already have:{" "}
              <select
                value={into}
                disabled={busy || question !== null}
                onChange={(e) => setInto(e.target.value)}
              >
                <option value="">Choose…</option>
                {others.map((v) => (
                  <option key={v.value} value={v.value}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={busy || into === "" || question !== null}
              onClick={() => onDecide({ decision: "merge", into })}
            >
              Use that instead
            </button>
          </div>
        )}
        {question !== null && (
          <div className="next" role="alert">
            <p>
              This file can have only one {facet?.label ?? kind} value, and it has{" "}
              {replaces.length > 0 ? <strong>{replaces.join(", ")}</strong> : "another"}. Going
              ahead takes that off the file and puts{" "}
              <strong>
                {question.asked.decision === "merge" ? `${kind}:${question.asked.into}` : item.tag}
              </strong>{" "}
              on it.
            </p>
            <div className="actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => onDecide({ ...question.asked, replace: true } as ReviewDecision)}
              >
                Replace it
              </button>
            </div>
          </div>
        )}
      </div>
      <div role="alert">{failed !== null && <p className="notice">{NOT_DONE[failed]}</p>}</div>
    </li>
  );
}
