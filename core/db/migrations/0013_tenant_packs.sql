CREATE TABLE "tenant_packs" (
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"applied_by" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_packs_tenant_id_name_pk" PRIMARY KEY("tenant_id","name"),
	CONSTRAINT "tenant_packs_name_format" CHECK (name ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
	CONSTRAINT "tenant_packs_version_length" CHECK (char_length(version) between 5 and 64),
	CONSTRAINT "tenant_packs_hash_format" CHECK (content_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tenant_packs_applied_by_principal" CHECK (applied_by ~ '^[a-z]+:.+$')
);
--> statement-breakpoint
ALTER TABLE "tenant_packs" ADD CONSTRAINT "tenant_packs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;