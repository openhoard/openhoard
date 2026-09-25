CREATE TABLE "activity_events" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"actor" text NOT NULL,
	"type" text NOT NULL,
	"object_id" text NOT NULL,
	"version_id" text,
	"client_id" text,
	"client_trust" text,
	"origin" text DEFAULT 'openhoard' NOT NULL,
	"external_id" text,
	CONSTRAINT "activity_events_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "activity_events_id_format" CHECK (id ~ '^act_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "activity_events_at_milliseconds" CHECK (at = date_trunc('milliseconds', at)),
	CONSTRAINT "activity_events_actor_principal" CHECK (actor ~ '^[a-z]+:.+$'),
	CONSTRAINT "activity_events_type_valid" CHECK (type in ('view', 'open', 'edit', 'share')),
	CONSTRAINT "activity_events_client_complete" CHECK ((client_id is null) = (client_trust is null)),
	CONSTRAINT "activity_events_client_trust_valid" CHECK (client_trust is null or client_trust in ('first-party', 'local', 'commercial', 'consumer')),
	CONSTRAINT "activity_events_client_id_length" CHECK (client_id is null or char_length(client_id) between 1 and 256),
	CONSTRAINT "activity_events_origin_format" CHECK (origin ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
	CONSTRAINT "activity_events_external_id_length" CHECK (external_id is null or char_length(external_id) between 1 and 512)
);
--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_object_id_unique" UNIQUE("tenant_id","object_id","id");--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."objects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_version_fk" FOREIGN KEY ("tenant_id","object_id","version_id") REFERENCES "public"."versions"("tenant_id","object_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_events_actor_idx" ON "activity_events" USING btree ("tenant_id","actor","at");--> statement-breakpoint
CREATE INDEX "activity_events_object_idx" ON "activity_events" USING btree ("tenant_id","object_id","at");--> statement-breakpoint
CREATE INDEX "activity_events_at_idx" ON "activity_events" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_events_external_unique" ON "activity_events" USING btree ("tenant_id","origin","external_id") WHERE external_id is not null;
