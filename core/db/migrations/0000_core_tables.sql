CREATE TABLE "blobs" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"size" bigint NOT NULL,
	"location" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blobs_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "blobs_id_format" CHECK (id ~ '^b3t:[0-9a-f]{64}$'),
	CONSTRAINT "blobs_size_nonnegative" CHECK (size >= 0)
);
--> statement-breakpoint
CREATE TABLE "objects" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"zone_id" text NOT NULL,
	"title" text NOT NULL,
	"owner_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "objects_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "objects_id_format" CHECK (id ~ '^obj_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "objects_title_length" CHECK (char_length(title) between 1 and 1024),
	CONSTRAINT "objects_owner_principal" CHECK (owner_id ~ '^[a-z]+:.+$')
);
--> statement-breakpoint
CREATE TABLE "source_refs" (
	"tenant_id" text NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"object_id" text NOT NULL,
	"url" text,
	"etag" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_refs_tenant_id_source_external_id_pk" PRIMARY KEY("tenant_id","source","external_id"),
	CONSTRAINT "source_refs_source_format" CHECK (source ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
	CONSTRAINT "source_refs_external_id_length" CHECK (char_length(external_id) between 1 and 2048)
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_id_format" CHECK (id ~ '^ten_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "tenants_name_length" CHECK (char_length(name) between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "versions" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"object_id" text NOT NULL,
	"seq" integer NOT NULL,
	"blob_id" text NOT NULL,
	"mime" text NOT NULL,
	"author_id" text,
	"source_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "versions_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "versions_seq_unique" UNIQUE("tenant_id","object_id","seq"),
	CONSTRAINT "versions_id_format" CHECK (id ~ '^ver_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "versions_seq_positive" CHECK (seq > 0),
	CONSTRAINT "versions_mime_format" CHECK (mime ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'),
	CONSTRAINT "versions_author_principal" CHECK (author_id is null or author_id ~ '^[a-z]+:.+$')
);
--> statement-breakpoint
CREATE TABLE "zones" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zones_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "zones_name_unique" UNIQUE("tenant_id","name"),
	CONSTRAINT "zones_id_format" CHECK (id ~ '^zon_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "zones_kind_valid" CHECK (kind in ('managed', 'indexed', 'local-only', 'code')),
	CONSTRAINT "zones_name_length" CHECK (char_length(name) between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_zone_fk" FOREIGN KEY ("tenant_id","zone_id") REFERENCES "public"."zones"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_refs" ADD CONSTRAINT "source_refs_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."objects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."objects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_blob_fk" FOREIGN KEY ("tenant_id","blob_id") REFERENCES "public"."blobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "objects_zone_idx" ON "objects" USING btree ("tenant_id","zone_id");--> statement-breakpoint
CREATE INDEX "source_refs_object_idx" ON "source_refs" USING btree ("tenant_id","object_id");--> statement-breakpoint
CREATE INDEX "versions_blob_idx" ON "versions" USING btree ("tenant_id","blob_id");