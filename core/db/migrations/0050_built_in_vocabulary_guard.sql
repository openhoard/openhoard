-- Built-in vocabulary is the system's (T-408): `risk:injection` must stay approved, exposure
-- metadata-only and visibility unset in every tenant, or a detector's flag would stop meaning
-- "no AI gets this" (or, with visibility hidden, hide files from people too). A pack or an admin
-- trying to change it, or to remove it, is refused here with a clear error, whatever code path
-- they take; the label may change. core/catalog planPack() refuses such a pack earlier, in its
-- plan.
CREATE FUNCTION openhoard_built_in_vocabulary_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.facet = 'risk' AND OLD.value = 'injection' THEN
      RAISE EXCEPTION 'risk:injection is built-in vocabulary and can''t be removed'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.facet = 'risk' AND OLD.value = 'injection'
     AND (NEW.facet <> 'risk' OR NEW.value <> 'injection') THEN
    RAISE EXCEPTION 'risk:injection is built-in vocabulary and can''t be renamed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.facet = 'risk' AND NEW.value = 'injection'
     AND (NEW.approved IS NOT TRUE OR NEW.exposure IS DISTINCT FROM 'metadata-only'
          OR NEW.visibility IS NOT NULL) THEN
    RAISE EXCEPTION 'risk:injection is built-in vocabulary: it stays approved, exposure metadata-only, no visibility'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER facet_values_built_in_guard
  BEFORE INSERT OR UPDATE OR DELETE ON facet_values
  FOR EACH ROW EXECUTE FUNCTION openhoard_built_in_vocabulary_guard();
