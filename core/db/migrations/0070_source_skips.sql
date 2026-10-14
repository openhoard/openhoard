-- What a source's syncs left out and why (core/jobs skips.ts), kept across runs.
CREATE TABLE "source_skips" (
	"tenant_id" text NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"reason" text NOT NULL,
	"path" text[],
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_skips_tenant_id_source_external_id_pk" PRIMARY KEY("tenant_id","source","external_id"),
	CONSTRAINT "source_skips_reason_format" CHECK (reason ~ '^[a-z0-9][a-z0-9:-]{0,63}$'),
	CONSTRAINT "source_skips_external_id_length" CHECK (char_length(external_id) between 1 and 1024),
	CONSTRAINT "source_skips_path_length" CHECK (path is null or cardinality(path) between 1 and 1024)
);
--> statement-breakpoint
ALTER TABLE "source_skips" ADD CONSTRAINT "source_skips_sync_fk" FOREIGN KEY ("tenant_id","source") REFERENCES "public"."source_syncs"("tenant_id","source") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_skips_reason_idx" ON "source_skips" USING btree ("tenant_id","source","reason");--> statement-breakpoint
-- Row-level security, as 0063 does for source_shares.
ALTER TABLE source_skips ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE source_skips FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON source_skips
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
