CREATE TABLE "source_shares" (
	"tenant_id" text NOT NULL,
	"source" text NOT NULL,
	"object_id" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"role" text NOT NULL,
	"inherited" boolean NOT NULL,
	"expires_at" timestamp with time zone,
	"matched" boolean NOT NULL,
	CONSTRAINT "source_shares_tenant_id_source_object_id_kind_key_pk" PRIMARY KEY("tenant_id","source","object_id","kind","key"),
	CONSTRAINT "source_shares_source_format" CHECK (source ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
	CONSTRAINT "source_shares_kind_valid" CHECK (kind in ('link-anyone', 'link-organization', 'link-specific', 'organization', 'guest', 'user', 'group')),
	CONSTRAINT "source_shares_role_valid" CHECK (role in ('read', 'write', 'owner')),
	CONSTRAINT "source_shares_key_length" CHECK (char_length(key) <= 1024)
);
--> statement-breakpoint
ALTER TABLE "source_refs" ADD COLUMN "source_modified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_refs" ADD COLUMN "source_modified_by" text;--> statement-breakpoint
ALTER TABLE "source_refs" ADD COLUMN "source_created_by" text;--> statement-breakpoint
ALTER TABLE "source_shares" ADD CONSTRAINT "source_shares_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."objects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_shares_kind_idx" ON "source_shares" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE INDEX "source_shares_object_idx" ON "source_shares" USING btree ("tenant_id","object_id");--> statement-breakpoint
ALTER TABLE "source_refs" ADD CONSTRAINT "source_refs_source_users_length" CHECK (char_length(source_modified_by) between 1 and 1024 and char_length(source_created_by) between 1 and 1024);