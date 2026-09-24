CREATE TABLE "grants" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"principal" text NOT NULL,
	"role" text NOT NULL,
	"facet" text,
	"value" text,
	"object_id" text,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "grants_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "grants_id_format" CHECK (id ~ '^grt_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "grants_principal_format" CHECK (principal ~ '^(user|group):.+$'),
	CONSTRAINT "grants_role_valid" CHECK (role in ('read', 'write')),
	CONSTRAINT "grants_one_target" CHECK ((facet is not null and value is not null and object_id is null)
       or (facet is null and value is null and object_id is not null)),
	CONSTRAINT "grants_granted_by_principal" CHECK (granted_by ~ '^[a-z]+:.+$'),
	CONSTRAINT "grants_expiry_after_creation" CHECK (expires_at is null or expires_at > created_at),
	CONSTRAINT "grants_revoked_after_creation" CHECK (revoked_at is null or revoked_at >= created_at),
	CONSTRAINT "grants_revocation_complete" CHECK ((revoked_at is null and revoked_by is null)
       or (revoked_at is not null and revoked_by is not null and revoked_by ~ '^[a-z]+:.+$'))
);
--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_tag_fk" FOREIGN KEY ("tenant_id","facet","value") REFERENCES "public"."facet_values"("tenant_id","facet","value") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."objects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grants_principal_idx" ON "grants" USING btree ("tenant_id","principal");--> statement-breakpoint
CREATE INDEX "grants_object_idx" ON "grants" USING btree ("tenant_id","object_id");