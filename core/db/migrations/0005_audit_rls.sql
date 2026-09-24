-- The audit log is append-only (T-701). In its tenant a row can be read and inserted; nothing
-- can change or remove one:
--
-- - Forced row-level security with policies for SELECT and INSERT only. With no UPDATE or DELETE
--   policy, those statements match no rows, for the owner too.
-- - Triggers refuse UPDATE, DELETE and TRUNCATE outright, for roles that skip row-level security
--   (superusers) and for TRUNCATE, which row-level security does not cover.
-- - A trigger checks every insert extends the chain: the next seq, linked to the head's hash.
--   core/audit takes a lock so its appends never race; this catches anything else inserting.
--
-- Neither stops someone who can run arbitrary SQL as the owner (they could drop the trigger).
-- That is what the hash chain is for: core/audit's verify detects any edit, gap or reorder.
ALTER TABLE audit.events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit.events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_read ON audit.events FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY tenant_append ON audit.events FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE FUNCTION audit.refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only' USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON audit.events
  FOR EACH ROW EXECUTE FUNCTION audit.refuse_change();
--> statement-breakpoint
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON audit.events
  FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();
--> statement-breakpoint
CREATE FUNCTION audit.check_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  head audit.events%ROWTYPE;
BEGIN
  SELECT * INTO head FROM audit.events
    WHERE tenant_id = NEW.tenant_id ORDER BY seq DESC LIMIT 1;
  IF NEW.seq <> coalesce(head.seq, 0) + 1
     OR NEW.prev_hash <> coalesce(head.hash, repeat('0', 64)) THEN
    RAISE EXCEPTION 'audit event % does not extend the chain', NEW.seq
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER events_extend_chain BEFORE INSERT ON audit.events
  FOR EACH ROW EXECUTE FUNCTION audit.check_link();
