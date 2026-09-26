CREATE TABLE "version_extracts" (
	"tenant_id" text NOT NULL,
	"version_id" text NOT NULL,
	"object_id" text NOT NULL,
	"status" text NOT NULL,
	"kind" text,
	"text" text DEFAULT '' NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failure" text,
	"extractor" text NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "version_extracts_tenant_id_version_id_pk" PRIMARY KEY("tenant_id","version_id"),
	CONSTRAINT "version_extracts_status_valid" CHECK (status in ('extracted', 'failed', 'unsupported', 'unavailable')),
	CONSTRAINT "version_extracts_kind_format" CHECK (kind is null or kind ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
	CONSTRAINT "version_extracts_kind_when_extracted" CHECK ((status = 'extracted') = (kind is not null)),
	CONSTRAINT "version_extracts_failure_when_failed" CHECK ((status = 'failed') = (failure is not null) and (failure is null or failure ~ '^[a-z0-9][a-z0-9-]{0,31}$')),
	CONSTRAINT "version_extracts_text_only_extracted" CHECK (status = 'extracted' or (text = '' and not truncated)),
	CONSTRAINT "version_extracts_text_size" CHECK (octet_length(text) <= 4194304),
	CONSTRAINT "version_extracts_metadata_object" CHECK (jsonb_typeof(metadata) = 'object'),
	CONSTRAINT "version_extracts_signals_array" CHECK (jsonb_typeof(signals) = 'array'),
	CONSTRAINT "version_extracts_warnings_array" CHECK (jsonb_typeof(warnings) = 'array'),
	CONSTRAINT "version_extracts_extractor_format" CHECK (extractor ~ '^[a-z0-9][a-z0-9./-]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE "version_extracts" ADD CONSTRAINT "version_extracts_version_fk" FOREIGN KEY ("tenant_id","object_id","version_id") REFERENCES "public"."versions"("tenant_id","object_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "version_extracts_object_idx" ON "version_extracts" USING btree ("tenant_id","object_id");