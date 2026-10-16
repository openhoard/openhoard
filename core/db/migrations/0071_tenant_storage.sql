CREATE TABLE "tenant_storage" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret" text,
	"previous" jsonb,
	"phase" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"lost" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" text NOT NULL,
	CONSTRAINT "tenant_storage_kind" CHECK (kind in ('local', 's3', 'azblob')),
	CONSTRAINT "tenant_storage_phase" CHECK (phase in ('moving', 'active', 'cleaning')),
	CONSTRAINT "tenant_storage_counts" CHECK (total >= 0 and done >= 0 and failed >= 0 and lost >= 0),
	CONSTRAINT "tenant_storage_version" CHECK (version >= 1),
	CONSTRAINT "tenant_storage_error_length" CHECK (last_error is null or char_length(last_error) <= 1024)
);
--> statement-breakpoint
ALTER TABLE "tenant_storage" ADD CONSTRAINT "tenant_storage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Row-level security, as 0063 does for source_shares.
ALTER TABLE tenant_storage ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenant_storage FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenant_storage
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
