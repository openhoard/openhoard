CREATE TABLE "facet_values" (
	"tenant_id" text NOT NULL,
	"facet" text NOT NULL,
	"value" text NOT NULL,
	"label" text NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"visibility" text,
	"exposure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facet_values_tenant_id_facet_value_pk" PRIMARY KEY("tenant_id","facet","value"),
	CONSTRAINT "facet_values_value_format" CHECK (value ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
	CONSTRAINT "facet_values_label_length" CHECK (char_length(label) between 1 and 200),
	CONSTRAINT "facet_values_visibility_valid" CHECK (visibility is null or visibility in ('hidden', 'discoverable', 'readable')),
	CONSTRAINT "facet_values_exposure_valid" CHECK (exposure is null or exposure in ('metadata-only', 'local-only', 'commercial-only', 'full'))
);
--> statement-breakpoint
CREATE TABLE "facets" (
	"tenant_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facets_tenant_id_key_pk" PRIMARY KEY("tenant_id","key"),
	CONSTRAINT "facets_key_format" CHECK (key ~ '^[a-z][a-z0-9-]{0,63}$'),
	CONSTRAINT "facets_label_length" CHECK (char_length(label) between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "object_tags" (
	"tenant_id" text NOT NULL,
	"object_id" text NOT NULL,
	"facet" text NOT NULL,
	"value" text NOT NULL,
	"source" text NOT NULL,
	"applied_by" text,
	"confidence" real NOT NULL,
	"reviewed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "object_tags_tenant_id_object_id_facet_value_pk" PRIMARY KEY("tenant_id","object_id","facet","value"),
	CONSTRAINT "object_tags_source_valid" CHECK (source in ('rule', 'model', 'user', 'pack')),
	CONSTRAINT "object_tags_confidence_range" CHECK (confidence >= 0 and confidence <= 1),
	CONSTRAINT "object_tags_applied_by_principal" CHECK (applied_by is null or applied_by ~ '^[a-z]+:.+$')
);
--> statement-breakpoint
ALTER TABLE "facet_values" ADD CONSTRAINT "facet_values_facet_fk" FOREIGN KEY ("tenant_id","facet") REFERENCES "public"."facets"("tenant_id","key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facets" ADD CONSTRAINT "facets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_tags" ADD CONSTRAINT "object_tags_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."objects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_tags" ADD CONSTRAINT "object_tags_value_fk" FOREIGN KEY ("tenant_id","facet","value") REFERENCES "public"."facet_values"("tenant_id","facet","value") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "object_tags_tag_idx" ON "object_tags" USING btree ("tenant_id","facet","value");