import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  ApiError,
  SignedOut,
  type Api,
  type Probe,
  type Storage as StorageNow,
  type StorageAsked,
  type StorageChoice,
} from "./api.js";
import { count, PROBE_STEPS, PROBE_WORDS, placeText, when } from "./words.js";

/*
 * Where the organization's files are kept (the Storage page): the server's own disk, or a
 * bucket of the organization's own on Amazon S3 (or another S3-compatible service) or Azure Blob
 * Storage. The page walks an admin through it: pick the service, follow what to set up there,
 * fill in the details, try them (a small file written, read back and removed), then use them.
 * The files already kept are then copied over in the background, and the copies here removed
 * when the admin says so. The server decides and checks everything; the page asks and shows.
 */

type Loaded =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "refused" }
  | { state: "ready"; storage: StorageNow };

type Kind = StorageChoice["kind"];

/** The form's fields, as typed. */
interface Draft {
  bucket: string;
  region: string;
  endpoint: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  accountName: string;
  container: string;
  accountKey: string;
}
const EMPTY: Draft = {
  bucket: "",
  region: "",
  endpoint: "",
  prefix: "",
  accessKeyId: "",
  secretAccessKey: "",
  accountName: "",
  container: "",
  accountKey: "",
};

/** The choice the form says, as the server takes it. */
function choiceOf(kind: Kind, d: Draft): StorageChoice {
  const opt = (v: string) => (v.trim() === "" ? undefined : v.trim());
  if (kind === "local") return { kind };
  const common = {
    ...(opt(d.endpoint) ? { endpoint: opt(d.endpoint) as string } : {}),
    ...(opt(d.prefix) ? { prefix: opt(d.prefix) as string } : {}),
  };
  if (kind === "s3") {
    return {
      kind,
      bucket: d.bucket.trim(),
      region: d.region.trim(),
      accessKeyId: d.accessKeyId.trim(),
      ...common,
      ...(opt(d.secretAccessKey) ? { secretAccessKey: d.secretAccessKey.trim() } : {}),
    };
  }
  return {
    kind,
    accountName: d.accountName.trim(),
    container: d.container.trim(),
    ...common,
    ...(opt(d.accountKey) ? { accountKey: d.accountKey.trim() } : {}),
  };
}

/** The form filled in from where files are kept now (never its key). */
function draftOf(s: StorageNow): Draft {
  return { ...EMPTY, ...s.settings };
}

const KIND_WORDS: Record<Kind, { title: string; means: string }> = {
  local: {
    title: "This server's disk",
    means: "Files are kept with OpenHoard, on the machine it runs on. Back up its data folder.",
  },
  s3: {
    title: "Amazon S3 (or S3-compatible)",
    means:
      "A bucket of your organization's own, on Amazon S3, or on a service that speaks S3 (Cloudflare R2, Backblaze B2, MinIO) where this server allows it.",
  },
  azblob: {
    title: "Azure Blob Storage",
    means: "A container in your organization's own Azure Storage account.",
  },
};

export function Storage(props: {
  api: Api;
  onSignedOut: () => void;
  onSignInAgain: () => Promise<boolean>;
}) {
  const { api, onSignedOut, onSignInAgain } = props;
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [asked, setAsked] = useState<StorageAsked | null>(null);
  const [busy, setBusy] = useState(false);
  const [stuck, setStuck] = useState(false);

  const load = useCallback(
    (quiet: boolean) => {
      let current = true;
      if (!quiet) setLoaded({ state: "loading" });
      api.storage().then(
        (storage) => current && setLoaded({ state: "ready", storage }),
        (err: unknown) => {
          if (!current) return;
          if (err instanceof SignedOut) onSignedOut();
          else if (err instanceof ApiError && err.status === 403) setLoaded({ state: "refused" });
          else if (!quiet) setLoaded({ state: "failed" });
        },
      );
      return () => {
        current = false;
      };
    },
    [api, onSignedOut],
  );
  useEffect(() => load(false), [load, attempt]);

  // While files move, the page follows it.
  const working =
    loaded.state === "ready" && loaded.storage.phase !== "active" ? loaded.storage.phase : null;
  useEffect(() => {
    if (working === null) return;
    let stop: (() => void) | undefined;
    const timer = setInterval(() => {
      stop?.();
      stop = load(true);
    }, 3000);
    return () => {
      clearInterval(timer);
      stop?.();
    };
  }, [working, load]);

  const run = (ask: () => Promise<StorageAsked>) => {
    setBusy(true);
    setStuck(false);
    ask().then(
      (ended) => {
        setAsked(ended);
        setBusy(false);
        if (ended.ended === "done") load(true);
      },
      (err: unknown) => {
        setBusy(false);
        if (err instanceof SignedOut) onSignedOut();
        else setAsked({ ended: "failed" });
      },
    );
  };

  return (
    <div className="storage">
      <h1>Storage</h1>
      <p className="muted">
        Where OpenHoard keeps the files it holds itself: uploads and mail-in. Files it only indexes,
        in SharePoint or a folder, stay where they are whatever you choose here.
      </p>
      <div role="status">{loaded.state === "loading" && <p>Loading…</p>}</div>
      {loaded.state === "failed" && (
        <div className="notice" role="alert">
          <p>Storage couldn't be loaded.</p>
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
        <>
          <Now storage={loaded.storage} />
          <Asked
            asked={asked}
            stuck={stuck}
            onSignInAgain={() => void onSignInAgain().then((left) => setStuck(!left))}
          />
          <Moving
            storage={loaded.storage}
            busy={busy}
            onRetry={() => run(() => api.retryStorageMove())}
            onRemoveOld={() => run(() => api.removeOldCopies())}
          />
          {loaded.storage.available &&
            loaded.storage.phase === "active" &&
            !loaded.storage.previous && (
              <Change
                api={api}
                storage={loaded.storage}
                busy={busy}
                onSignedOut={onSignedOut}
                onKeep={(choice) => run(() => api.keepStorage(choice))}
              />
            )}
          {!loaded.storage.available && (
            <p className="notice">This server doesn't let storage be changed from here.</p>
          )}
        </>
      )}
    </div>
  );
}

function Now({ storage: s }: { storage: StorageNow }) {
  return (
    <section className="card" aria-labelledby="storage-now">
      <h2 id="storage-now">Where files are kept now</h2>
      <p>
        <strong>{upFirst(placeText(s.kind, s.settings))}</strong>
      </p>
      {s.changedAt && (
        <p className="muted">
          Chosen <time dateTime={s.changedAt}>{when(s.changedAt)}</time>
          {s.changedByName || s.changedBy ? ` by ${s.changedByName ?? s.changedBy}` : ""}.
        </p>
      )}
      {!s.keepsFiles && (
        <p className="next">
          This server doesn't keep any files yet: uploads and mail-in are off in its settings. What
          you choose here applies once they're on.
        </p>
      )}
    </section>
  );
}

function Asked(props: { asked: StorageAsked | null; stuck: boolean; onSignInAgain: () => void }) {
  const { asked, stuck } = props;
  return (
    <div role="alert">
      {asked?.ended === "sign-in-again" && (
        <div className="notice">
          <p>
            Changing where files are kept takes a recent sign-in, so a session left open can't do
            it. Nothing was changed. Sign in again, then come back to this page.
          </p>
          <button type="button" onClick={props.onSignInAgain}>
            Sign out and in again
          </button>
          {stuck && <p>Signing out didn't go through. Try again.</p>}
        </div>
      )}
      {asked?.ended === "refused" && (
        <p className="notice">
          You aren't allowed to do this. Your admin role may have been taken away since you signed
          in.
        </p>
      )}
      {asked?.ended === "busy" && <p className="notice">Not now: {asked.message}.</p>}
      {asked?.ended === "invalid" && <p className="notice">{asked.message}.</p>}
      {asked?.ended === "probe-failed" && (
        <div className="notice">
          <p>That place didn't work when tried again, so nothing was changed.</p>
          <ProbeSteps probe={asked.probe} />
        </div>
      )}
      {asked?.ended === "failed" && <p className="notice">That didn't go through. Try again.</p>}
      {asked?.ended === "done" && asked.outcome === "unchanged" && (
        <p className="done">Nothing changed: files are kept there already.</p>
      )}
      {asked?.ended === "done" && asked.outcome === "rekeyed" && (
        <p className="done">The new key is kept. Files stay where they are.</p>
      )}
    </div>
  );
}

function Moving(props: {
  storage: StorageNow;
  busy: boolean;
  onRetry: () => void;
  onRemoveOld: () => void;
}) {
  const { storage: s, busy } = props;
  const [confirming, setConfirming] = useState(false);
  const confirm = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (confirming) confirm.current?.focus();
  }, [confirming]);
  if (s.phase === "active" && !s.previous) {
    return s.lastError ? <p className="muted">{s.lastError}.</p> : null;
  }
  const from = s.previous ? placeText(s.previous.kind, s.previous.settings) : "";
  const shown = Math.min(s.done + s.failed + s.lost, s.total);
  const lost =
    s.lost > 0
      ? `${count(s.lost, "file")} ${s.lost === 1 ? "was" : "were"} in neither place: lost before the move (restore ${s.lost === 1 ? "it" : "them"} from a backup of the old place if you have one).`
      : null;
  return (
    <section className="card" aria-labelledby="storage-move">
      <h2 id="storage-move">
        {s.phase === "moving"
          ? "Copying files over"
          : s.phase === "cleaning"
            ? "Removing the old copies"
            : "The old copies are still kept"}
      </h2>
      {s.phase !== "active" && (
        <>
          <p>
            {s.phase === "moving"
              ? `From ${from}. New files already go to the new place; a file not copied yet is read from the old one.`
              : `From ${from}. Each file is checked in the new place before its old copy is removed.`}
          </p>
          <progress max={Math.max(s.total, 1)} value={shown} aria-label="Files done" />
          <p className="muted">
            {s.total === 0
              ? "Counting files…"
              : `${count(shown, "file")} of ${s.total.toLocaleString("en")}`}
            {s.failed > 0 ? `, ${count(s.failed, "failure")}` : ""}.
          </p>
          <p className="muted">
            Not moving for a while (the server restarted, say)?{" "}
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={s.phase === "moving" ? props.onRetry : props.onRemoveOld}
            >
              Start it again
            </button>{" "}
            It goes on where it stopped.
          </p>
        </>
      )}
      {s.phase === "active" && s.previous && (
        <>
          {lost && <p className="next">{lost}</p>}
          {s.failed > 0 ? (
            <>
              <p className="notice">
                {count(s.failed, "file")} couldn't be copied or removed
                {s.lastError ? ` (the last: ${s.lastError})` : ""}. They're still read from {from}.
                Try the move again; files already copied are skipped.
              </p>
              <div className="actions">
                <button type="button" className="primary" disabled={busy} onClick={props.onRetry}>
                  Try the move again
                </button>
              </div>
            </>
          ) : (
            <>
              <p>
                Every file was copied to the new place and checked. The copies on {from} are still
                kept until you remove them; you can choose another place once they're gone.
              </p>
              {confirming ? (
                <div
                  className="decide"
                  ref={confirm}
                  tabIndex={-1}
                  role="group"
                  aria-label="Remove the old copies?"
                >
                  <p>
                    <strong>Remove every file's copy on {from}?</strong> Each is checked in the new
                    place first. This can't be undone from here.
                  </p>
                  <div className="actions">
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      onClick={() => {
                        setConfirming(false);
                        props.onRemoveOld();
                      }}
                    >
                      Yes, remove them
                    </button>
                    <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
                      Keep them
                    </button>
                  </div>
                </div>
              ) : (
                <div className="actions">
                  <button type="button" disabled={busy} onClick={() => setConfirming(true)}>
                    Remove the old copies
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function ProbeSteps({ probe }: { probe: Probe }) {
  return (
    <ul className="probe">
      {probe.steps.map((s) => (
        <li key={s.step} className={s.ok ? "probe-ok" : "probe-failed"}>
          <span aria-hidden="true">{s.ok ? "✓" : "✗"}</span>
          <span className="sr-only">{s.ok ? "Passed: " : "Failed: "}</span> {PROBE_STEPS[s.step]}
          {s.ok ? "" : ": "}
          {!s.ok && (
            <>
              {PROBE_WORDS[s.problem ?? "failed"]}
              {s.code && (
                <>
                  {" "}
                  (<code className="inline">{s.code}</code>)
                </>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Choosing a place: the service, what to set up there, the details, a try, then use it. */
function Change(props: {
  api: Api;
  storage: StorageNow;
  busy: boolean;
  onSignedOut: () => void;
  onKeep: (choice: StorageChoice) => void;
}) {
  const { api, storage, busy, onSignedOut } = props;
  const [kind, setKind] = useState<Kind | null>(null);
  const [draft, setDraft] = useState<Draft>(() => draftOf(storage));
  const [tested, setTested] = useState<{ said: string; probe: Probe } | null>(null);
  const [testing, setTesting] = useState(false);
  const [problem, setProblem] = useState<{ field: string | null; message: string } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const ids = useId();

  const choice = kind === null ? null : choiceOf(kind, draft);
  const said = choice === null ? "" : JSON.stringify(choice);
  const sameKind = kind === storage.kind;
  const works = tested !== null && tested.said === said && tested.probe.ok;

  // Focus goes to the details when a service is first chosen, not as arrow keys move through
  // the choices.
  const chosen = kind !== null;
  useEffect(() => {
    if (chosen) heading.current?.focus();
  }, [chosen]);

  const field = (name: keyof Draft) => ({
    id: `${ids}-${name}`,
    value: draft[name],
    "aria-invalid": problem?.field === name,
    "aria-describedby": problem?.field === name ? `${ids}-problem` : undefined,
    onChange: (e: { target: { value: string } }) => {
      setDraft((d) => ({ ...d, [name]: e.target.value }));
      setProblem(null);
    },
  });

  const test = (e: FormEvent) => {
    e.preventDefault();
    if (choice === null) return;
    setTesting(true);
    setProblem(null);
    api.testStorage(choice).then(
      (ended) => {
        setTesting(false);
        if (ended.ended === "tested") setTested({ said, probe: ended.probe });
        else if (ended.ended === "invalid")
          setProblem({ field: ended.field, message: ended.message });
        else setProblem({ field: null, message: "The test couldn't be run. Try again." });
      },
      (err: unknown) => {
        setTesting(false);
        if (err instanceof SignedOut) onSignedOut();
        else setProblem({ field: null, message: "The test couldn't be run. Try again." });
      },
    );
  };

  return (
    <section aria-labelledby={`${ids}-change`}>
      <h2 id={`${ids}-change`}>Change where files are kept</h2>
      <fieldset className="kinds">
        <legend>Where should files be kept?</legend>
        {(["local", "s3", "azblob"] as const).map((k) => (
          <label key={k} className="choice">
            <input
              type="radio"
              name={`${ids}-kind`}
              value={k}
              checked={kind === k}
              onChange={() => {
                setKind(k);
                setTested(null);
                setProblem(null);
              }}
            />
            <span>
              <strong>{KIND_WORDS[k].title}</strong>
              {k === storage.kind && " (now)"}
              <br />
              <span className="muted">{KIND_WORDS[k].means}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {kind !== null && (
        <form
          className="card storage-form"
          onSubmit={test}
          noValidate
          aria-labelledby={`${ids}-details`}
        >
          <h3 id={`${ids}-details`} ref={heading} tabIndex={-1}>
            {KIND_WORDS[kind].title}
          </h3>
          {kind === "s3" && <S3Help draft={draft} />}
          {kind === "azblob" && <AzureHelp />}
          {kind === "local" && (
            <p>
              Files go back to this server's disk: new files at once, and those kept in your bucket
              are copied back in the background, the copies there kept until you remove them.
            </p>
          )}
          {kind === "s3" && (
            <div className="audit-filters">
              <label htmlFor={`${ids}-bucket`}>
                Bucket name
                <input {...field("bucket")} autoComplete="off" spellCheck={false} />
              </label>
              <label htmlFor={`${ids}-region`}>
                Region
                <input
                  {...field("region")}
                  placeholder="us-east-1"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label htmlFor={`${ids}-accessKeyId`}>
                Access key ID
                <input {...field("accessKeyId")} autoComplete="off" spellCheck={false} />
              </label>
              <label htmlFor={`${ids}-secretAccessKey`}>
                Secret access key
                <input
                  {...field("secretAccessKey")}
                  type="password"
                  autoComplete="new-password"
                  placeholder={sameKind && storage.hasSecret ? "Kept: leave empty to keep it" : ""}
                />
              </label>
              <label htmlFor={`${ids}-prefix`}>
                Folder in the bucket (optional)
                <input
                  {...field("prefix")}
                  placeholder="openhoard"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              {storage.allowEndpoints && (
                <label htmlFor={`${ids}-endpoint`}>
                  Endpoint (only for services other than Amazon S3)
                  <input
                    {...field("endpoint")}
                    placeholder="https://…"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              )}
            </div>
          )}
          {kind === "azblob" && (
            <div className="audit-filters">
              <label htmlFor={`${ids}-accountName`}>
                Storage account name
                <input {...field("accountName")} autoComplete="off" spellCheck={false} />
              </label>
              <label htmlFor={`${ids}-container`}>
                Container name
                <input {...field("container")} autoComplete="off" spellCheck={false} />
              </label>
              <label htmlFor={`${ids}-accountKey`}>
                Access key
                <input
                  {...field("accountKey")}
                  type="password"
                  autoComplete="new-password"
                  placeholder={sameKind && storage.hasSecret ? "Kept: leave empty to keep it" : ""}
                />
              </label>
              <label htmlFor={`${ids}-prefix`}>
                Folder in the container (optional)
                <input
                  {...field("prefix")}
                  placeholder="openhoard"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              {storage.allowEndpoints && (
                <label htmlFor={`${ids}-endpoint`}>
                  Endpoint (only for Azurite or another cloud)
                  <input
                    {...field("endpoint")}
                    placeholder="https://…"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              )}
            </div>
          )}
          <div role="alert">
            {problem && (
              <p className="notice" id={`${ids}-problem`}>
                {problem.message}
              </p>
            )}
          </div>
          <div className="actions">
            <button type="submit" disabled={testing || busy}>
              {testing ? "Testing…" : "Test the connection"}
            </button>
            <button
              type="button"
              className="primary"
              disabled={!works || busy || choice === null}
              onClick={() => choice !== null && props.onKeep(choice)}
            >
              Use this storage
            </button>
          </div>
          <div role="status">
            {tested !== null && tested.said === said && (
              <>
                <p className={tested.probe.ok ? "done" : ""}>
                  {tested.probe.ok
                    ? "It works. Files already kept will be copied there in the background once you use it; the copies they have now are kept until you remove them."
                    : "It didn't work:"}
                </p>
                <ProbeSteps probe={tested.probe} />
              </>
            )}
            {tested !== null && tested.said !== said && (
              <p className="muted">The details changed since the test: test them again.</p>
            )}
          </div>
        </form>
      )}
    </section>
  );
}

function S3Help({ draft }: { draft: Draft }) {
  const bucket = draft.bucket.trim() || "YOUR-BUCKET";
  const prefix = draft.prefix.trim();
  const policy = JSON.stringify(
    {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
          Resource: `arn:aws:s3:::${bucket}/${prefix ? `${prefix}/` : ""}*`,
        },
        { Effect: "Allow", Action: ["s3:ListBucket"], Resource: `arn:aws:s3:::${bucket}` },
      ],
    },
    null,
    2,
  );
  return (
    <details className="help" open>
      <summary>What to set up in AWS first</summary>
      <ol>
        <li>
          In the S3 console, <strong>create a bucket</strong> for OpenHoard, in the region you want.
          Keep "Block all public access" on: OpenHoard never shares files from the bucket.
        </li>
        <li>
          Under the bucket's <strong>Management</strong> tab, add a lifecycle rule that deletes
          incomplete multipart uploads after 1 day. Large uploads cut off part way otherwise stay,
          and are billed.
        </li>
        <li>
          In IAM, <strong>create a user</strong> for OpenHoard (no console access) and give it this
          policy, which allows only what OpenHoard does, in this bucket only. Listing the bucket
          lets S3 answer "not found" for a file that isn't there, which OpenHoard relies on. If the
          bucket encrypts with a KMS key of your own (SSE-KMS), also allow this user to use that
          key.
          <pre className="snippet">{policy}</pre>
        </li>
        <li>
          Create an <strong>access key</strong> for that user ("Application running outside AWS"),
          and paste its ID and secret below. The secret is kept encrypted on the server and never
          shown again.
        </li>
      </ol>
    </details>
  );
}

function AzureHelp() {
  return (
    <details className="help" open>
      <summary>What to set up in Azure first</summary>
      <ol>
        <li>
          In the Azure portal, <strong>create a storage account</strong> (Standard, StorageV2), or
          use one you have.
        </li>
        <li>
          Under <strong>Data storage → Containers</strong>, create a container for OpenHoard, with
          its access level <strong>Private</strong>.
        </li>
        <li>
          Under <strong>Security + networking → Access keys</strong>, copy <strong>key1</strong>.
          Paste the account name, the container name and that key below. The key is kept encrypted
          on the server and never shown again. An account key opens everything in the storage
          account, so a storage account used for OpenHoard alone is best. Under{" "}
          <strong>Configuration</strong>, "Allow storage account key access" must be on.
        </li>
        <li>
          If the account's network access is limited, allow this server's address in its firewall.
        </li>
      </ol>
    </details>
  );
}

const upFirst = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
