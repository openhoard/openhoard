-- Every insert into audit.events must be a verifiable link (T-701). 0005_audit_rls.sql checked
-- only the position: the next seq, linked to the head's hash. Code inside withTenant() could
-- still insert a row in the right place with a hash or event that doesn't check out, and
-- verifyAudit would then stop at that row for good: nothing after it could ever be verified.
--
-- Now the row must also carry its own proof, as core/audit/src/chain.ts computes it:
--
-- - `hash` is the SHA-256 of `event`, exactly the stored text in UTF-8;
-- - `event` is a JSON object with the chain's fields only (never the hash itself), and a
--   `detail` of plain values, if any;
-- - the event's seq, prevHash, tenantId, actor, action, decision, client, object, version and
--   at say what the columns say, `at` in the form JavaScript's toISOString() writes.
--
-- What it can't check is that the text is the canonical serialization (sorted keys, no
-- whitespace); verifyAudit does.
CREATE OR REPLACE FUNCTION audit.check_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  head audit.events%ROWTYPE;
  e jsonb;
BEGIN
  SELECT * INTO head FROM audit.events
    WHERE tenant_id = NEW.tenant_id ORDER BY seq DESC LIMIT 1;
  IF NEW.seq <> coalesce(head.seq, 0) + 1
     OR NEW.prev_hash <> coalesce(head.hash, repeat('0', 64)) THEN
    RAISE EXCEPTION 'audit event % does not extend the chain', NEW.seq
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.hash <> encode(sha256(convert_to(NEW.event, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'audit event % does not match its hash', NEW.seq
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT pg_input_is_valid(NEW.event, 'jsonb') THEN
    RAISE EXCEPTION 'audit event % is not JSON', NEW.seq USING ERRCODE = 'check_violation';
  END IF;
  e := NEW.event::jsonb;
  IF jsonb_typeof(e) IS DISTINCT FROM 'object'
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(e) AS k
        WHERE k NOT IN ('tenantId', 'seq', 'prevHash', 'at', 'actor', 'action', 'decision',
                        'client', 'object', 'version', 'detail'))
     OR (e ? 'detail' AND (
       jsonb_typeof(e->'detail') <> 'object'
       OR EXISTS (
         SELECT 1 FROM jsonb_each(e->'detail') AS d
          WHERE jsonb_typeof(d.value) NOT IN ('string', 'number', 'boolean'))))
     OR (e->'seq') IS DISTINCT FROM to_jsonb(NEW.seq)
     OR (e->'prevHash') IS DISTINCT FROM to_jsonb(NEW.prev_hash)
     OR (e->'tenantId') IS DISTINCT FROM to_jsonb(NEW.tenant_id)
     OR (e->'actor') IS DISTINCT FROM to_jsonb(NEW.actor)
     OR (e->'action') IS DISTINCT FROM to_jsonb(NEW.action)
     OR (e->'decision') IS DISTINCT FROM to_jsonb(NEW.decision)
     OR (e->'client') IS DISTINCT FROM to_jsonb(NEW.client)
     OR (e->'object') IS DISTINCT FROM to_jsonb(NEW.object)
     OR (e->'version') IS DISTINCT FROM to_jsonb(NEW.version)
     -- Milliseconds, like a JavaScript Date, and written as toISOString() writes it.
     OR date_trunc('milliseconds', NEW.at) <> NEW.at
     OR (e->'at') IS DISTINCT FROM
        to_jsonb(to_char(NEW.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) THEN
    RAISE EXCEPTION 'audit event % disagrees with its columns', NEW.seq
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
