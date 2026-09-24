CREATE SCHEMA "audit";
--> statement-breakpoint
CREATE TABLE "audit"."events" (
	"tenant_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"decision" text NOT NULL,
	"client" text,
	"object" text,
	"version" text,
	"event" text NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "events_tenant_id_seq_pk" PRIMARY KEY("tenant_id","seq"),
	CONSTRAINT "audit_events_seq_positive" CHECK (seq > 0),
	CONSTRAINT "audit_events_decision_valid" CHECK (decision in ('allow', 'deny')),
	CONSTRAINT "audit_events_hash_format" CHECK (hash ~ '^[0-9a-f]{64}$' and prev_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "audit"."events" ADD CONSTRAINT "events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_at_idx" ON "audit"."events" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE INDEX "audit_events_object_idx" ON "audit"."events" USING btree ("tenant_id","object");