import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  ApiError,
  SignedOut,
  TRUSTS,
  type Api,
  type Changed,
  type Client,
  type ClientDecision,
  type Trust,
} from "./api.js";
import {
  clientIdentity,
  clientStanding,
  clientUseText,
  TRUST_WORDS,
  when,
  type ClientStanding,
} from "./words.js";

type Loaded =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "refused" }
  | { state: "ready"; clients: Client[] };

/** What the last change came to. */
type Outcome = {
  clientKey: string;
  title: string;
  ended: Changed;
  did: ClientDecision["action"] | "relabel";
};

const SECTIONS: readonly { title: string; has: readonly ClientStanding[]; none?: string }[] = [
  { title: "Waiting for your decision", has: ["waiting"], none: "Nothing is waiting." },
  { title: "Approved", has: ["approved", "approved-by-config"] },
  { title: "Not approved", has: ["refused", "lapsed"] },
];

const DID = {
  approve: "approved",
  relabel: "its kind was changed",
  refuse: "refused",
  revoke: "revoked",
} as const;

const cardId = (clientKey: string) => `client-${clientKey}`;

const OUTCOME_WORDS: Record<Exclude<Changed, "done" | "sign-in-again">, string> = {
  conflict:
    "That no longer applies: another admin decided meanwhile, or the server's config file decides for this app. The list shows where it stands now.",
  gone: "That app's request is no longer there: it lapsed, or was removed. Nothing was changed.",
  refused: "You aren't allowed to do that.",
  failed:
    "That didn't go through. Check where the app stands below, and try again if nothing changed.",
};

/**
 * The AI clients page (T-904): which AI apps the tenant's people may connect, with what trust
 * label, and how much each is used. The admin API decides and audits; after a change the page
 * shows the list as the server gives it.
 */
export function Clients(props: {
  api: Api;
  /** Ends the session and goes to sign in; false when that couldn't be done. */
  onSignInAgain: () => Promise<boolean>;
  onSignedOut: () => void;
}) {
  const { api, onSignInAgain, onSignedOut } = props;
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const load = useCallback(
    async (quietly: boolean) => {
      if (!quietly) setLoaded({ state: "loading" });
      try {
        setLoaded({ state: "ready", clients: await api.clients() });
      } catch (err) {
        if (err instanceof SignedOut) onSignedOut();
        else if (err instanceof ApiError && err.status === 403) setLoaded({ state: "refused" });
        else setLoaded({ state: "failed" });
      }
    },
    [api, onSignedOut],
  );
  useEffect(() => {
    void load(false);
  }, [load, attempt]);

  const decide = async (client: Client, decision: ClientDecision) => {
    if (busy) return;
    setBusy(true);
    setOutcome(null);
    const about = {
      clientKey: client.clientKey,
      title: clientIdentity(client).title,
      did:
        decision.action === "approve" && clientStanding(client) === "approved"
          ? ("relabel" as const)
          : decision.action,
    };
    try {
      const ended = await api.decideClient(client.clientKey, decision);
      // Whatever happened, the list is the server's: read it again.
      if (ended !== "sign-in-again") await load(true);
      setOutcome({ ...about, ended });
    } catch (err) {
      if (err instanceof SignedOut) onSignedOut();
      else setOutcome({ ...about, ended: "failed" });
    } finally {
      setBusy(false);
    }
  };

  // After a change the card may have moved or gone, and the button that was pressed with it:
  // the keyboard goes to the app the change was about, or to the top of the page.
  useEffect(() => {
    if (outcome === null || outcome.ended === "sign-in-again") return;
    const to =
      document.getElementById(cardId(outcome.clientKey)) ?? document.getElementById("clients-top");
    to?.focus();
  }, [outcome]);

  const shown = loaded.state === "ready" ? loaded.clients : [];
  // Said at the top when it went well, or when the app it is about is no longer listed.
  const orphaned =
    outcome !== null &&
    outcome.ended !== "done" &&
    !shown.some((c) => c.clientKey === outcome.clientKey);

  return (
    <>
      <h1 id="clients-top" tabIndex={-1}>
        AI clients
      </h1>
      <p className="muted">
        The AI apps your people have tried to connect to OpenHoard. An app gets nothing until it is
        approved, here or in the server's config file, and then only what the person using it may
        see.
      </p>
      <div role="status">
        {loaded.state === "loading" && <p>Loading…</p>}
        {outcome?.ended === "done" && (
          <p className="done">
            {outcome.title}: {DID[outcome.did]}.
          </p>
        )}
      </div>
      <div role="alert">
        {orphaned && outcome.ended !== "sign-in-again" && (
          <p className="notice">
            {outcome.title}: {OUTCOME_WORDS[outcome.ended as keyof typeof OUTCOME_WORDS]}
          </p>
        )}
      </div>
      {loaded.state === "failed" && (
        <div className="notice" role="alert">
          <p>The AI clients couldn't be loaded.</p>
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
      {loaded.state === "ready" && shown.length === 0 && (
        <p className="card">
          No AI app has asked to connect yet. When someone adds OpenHoard to their AI assistant and
          signs in, the app appears here for you to approve.
        </p>
      )}
      {shown.length > 0 &&
        SECTIONS.map((section) => {
          const clients = shown.filter((c) => section.has.includes(clientStanding(c)));
          if (clients.length === 0 && section.none === undefined) return null;
          return (
            <section key={section.title} aria-label={section.title}>
              <h2>{section.title}</h2>
              {clients.length === 0 ? (
                <p className="muted">{section.none}</p>
              ) : (
                <ul className="cards">
                  {clients.map((c) => (
                    <ClientCard
                      // A card starts over when the app's standing changes under it: no choice
                      // made for how it stood before is carried into how it stands now.
                      key={`${c.clientKey}:${c.status}:${c.trust ?? ""}:${c.configTrust ?? ""}`}
                      client={c}
                      busy={busy}
                      outcome={
                        outcome !== null &&
                        outcome.clientKey === c.clientKey &&
                        outcome.ended !== "done"
                          ? outcome.ended
                          : null
                      }
                      onSignInAgain={onSignInAgain}
                      onDecide={(d) => void decide(c, d)}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
    </>
  );
}

function ClientCard(props: {
  client: Client;
  busy: boolean;
  outcome: Exclude<Changed, "done"> | null;
  onSignInAgain: () => Promise<boolean>;
  onDecide: (decision: ClientDecision) => void;
}) {
  const { client: c, busy, outcome, onSignInAgain, onDecide } = props;
  const who = clientIdentity(c);
  const standing = clientStanding(c);
  // The config's label is the only one an approval here may use for an app it lists.
  const [trust, setTrust] = useState<Trust | "">(c.configTrust ?? c.trust ?? "");
  const [revoking, setRevoking] = useState(false);
  const [stuck, setStuck] = useState(false);
  const pick = useId();
  const confirm = useRef<HTMLDivElement>(null);
  const revoke = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);
  useEffect(() => {
    // The keyboard goes where the question is, and back to where it was asked from.
    if (revoking) confirm.current?.focus();
    else if (asked.current) revoke.current?.focus();
    asked.current = revoking;
  }, [revoking]);

  return (
    <li className="card">
      <div className="card-head">
        <h3 id={cardId(c.clientKey)} tabIndex={-1}>
          {who.title}
        </h3>
        {c.trust !== null && <span className="badge badge-ok">{TRUST_WORDS[c.trust].label}</span>}
      </div>
      <p className="muted">
        {c.claimedName === "" ? "It gives itself no name." : <>Calls itself “{c.claimedName}”.</>}{" "}
        Any app can claim any name: go by the address.
      </p>
      <p>{who.detail}</p>
      <Addresses list={who.addresses} />
      {who.returnsTo.length > 0 && (
        <>
          <p className="muted">A sign-in through it returns to:</p>
          <Addresses list={who.returnsTo} />
        </>
      )}
      <p className="muted">
        {clientUseText(c)}
        {c.requestedAt !== null && (
          <>
            {" "}
            First asked for <time dateTime={c.requestedAt}>{when(c.requestedAt)}</time>.
          </>
        )}
      </p>
      {standing === "lapsed" && (
        <p className="next">
          The server's config file approved this app and no longer lists it, so it gets nothing now.
          Approving it here lets it in again, for the people who had connected it too; refusing it
          ends those connections for good.
        </p>
      )}

      {standing === "approved-by-config" ? (
        <p className="next">
          Approved in the server's config file, which decides for this app. To change or remove it,
          change the file.
        </p>
      ) : (
        <div className="decide">
          {c.configTrust !== null ? (
            <p>
              The server's config file lists this app as{" "}
              <strong>{TRUST_WORDS[c.configTrust].label}</strong>: approving it here lets it in as
              that. {TRUST_WORDS[c.configTrust].means}
            </p>
          ) : (
            <fieldset disabled={busy}>
              <legend>
                {standing === "approved"
                  ? "Change what kind of app this is"
                  : "What kind of app is this?"}
              </legend>
              {TRUSTS.map((t) => (
                <label key={t} className="choice">
                  <input
                    type="radio"
                    name={pick}
                    value={t}
                    checked={trust === t}
                    onChange={() => setTrust(t)}
                  />
                  <span>
                    <strong>{TRUST_WORDS[t].label}.</strong> {TRUST_WORDS[t].means}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={busy || trust === "" || (standing === "approved" && trust === c.trust)}
              onClick={() => trust !== "" && onDecide({ action: "approve", trust })}
            >
              {standing === "approved"
                ? "Save"
                : standing === "refused"
                  ? "Approve after all"
                  : "Approve"}
            </button>
            {standing === "waiting" && (
              <button type="button" disabled={busy} onClick={() => onDecide({ action: "refuse" })}>
                Refuse
              </button>
            )}
            {/* Still approved on record: refusing it for good ends what it holds. */}
            {standing === "lapsed" && (
              <button type="button" disabled={busy} onClick={() => onDecide({ action: "revoke" })}>
                Refuse
              </button>
            )}
            {standing === "approved" && !revoking && (
              <button ref={revoke} type="button" disabled={busy} onClick={() => setRevoking(true)}>
                Revoke…
              </button>
            )}
          </div>
          {standing === "approved" && revoking && (
            <div
              ref={confirm}
              className="next"
              role="group"
              aria-label="Revoke this app?"
              tabIndex={-1}
            >
              <p>
                Revoke it? Everyone connected through it is cut off at their next request, and it
                stays refused until an admin approves it again.
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => onDecide({ action: "revoke" })}
                >
                  Yes, revoke
                </button>
                <button type="button" disabled={busy} onClick={() => setRevoking(false)}>
                  Keep it
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div role="alert">
        {outcome === "sign-in-again" && (
          <div className="notice">
            <p>
              Approving an app, or changing its kind, takes a recent sign-in, so a session left open
              can't do it. Nothing was changed. Sign in again, then make the change. (If you sign in
              with a one-time link, you'll need a new one from the server.)
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
        {outcome !== null && outcome !== "sign-in-again" && (
          <p className="notice">{OUTCOME_WORDS[outcome]}</p>
        )}
      </div>
    </li>
  );
}

function Addresses({ list }: { list: string[] }) {
  return (
    <ul className="addresses">
      {list.map((a) => (
        <li key={a}>
          <code>{a}</code>
        </li>
      ))}
    </ul>
  );
}
