CREATE TABLE "source_syncs" (
	"tenant_id" text NOT NULL,
	"source" text NOT NULL,
	"zone_id" text NOT NULL,
	"connector" text NOT NULL,
	"phase" text NOT NULL,
	"token" text,
	"reconcile_from" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_syncs_tenant_id_source_pk" PRIMARY KEY("tenant_id","source"),
	CONSTRAINT "source_syncs_source_format" CHECK (source ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
	CONSTRAINT "source_syncs_connector_format" CHECK (connector ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
	CONSTRAINT "source_syncs_phase_valid" CHECK (phase in ('crawl', 'delta')),
	CONSTRAINT "source_syncs_token_length" CHECK (token is null or char_length(token) between 1 and 65536),
	CONSTRAINT "source_syncs_delta_cursor" CHECK (phase = 'crawl' or token is not null)
);
--> statement-breakpoint
ALTER TABLE "source_syncs" ADD CONSTRAINT "source_syncs_zone_fk" FOREIGN KEY ("tenant_id","zone_id") REFERENCES "public"."zones"("tenant_id","id") ON DELETE no action ON UPDATE no action;