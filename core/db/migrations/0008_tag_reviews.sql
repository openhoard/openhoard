CREATE TABLE "tag_reviews" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"object_id" text NOT NULL,
	"facet" text NOT NULL,
	"value" text NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"applied_by" text,
	"confidence" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decision" text,
	"merged_into" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "tag_reviews_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "tag_reviews_id_format" CHECK (id ~ '^rev_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "tag_reviews_reason_valid" CHECK (reason in ('new-value', 'low-confidence', 'sensitive')),
	CONSTRAINT "tag_reviews_source_valid" CHECK (source in ('rule', 'model', 'user', 'pack')),
	CONSTRAINT "tag_reviews_confidence_range" CHECK (confidence >= 0 and confidence <= 1),
	CONSTRAINT "tag_reviews_applied_by_principal" CHECK (applied_by is null or applied_by ~ '^[a-z]+:.+$'),
	CONSTRAINT "tag_reviews_applied_by_matches_source" CHECK (applied_by is null or starts_with(applied_by, source || ':')),
	CONSTRAINT "tag_reviews_resolution_complete" CHECK ((decision is null and resolved_by is null and resolved_at is null and merged_into is null)
       or (decision is not null and decision in ('approved', 'rejected', 'merged')
           and resolved_by is not null and resolved_by ~ '^[a-z]+:.+$'
           and resolved_at is not null and resolved_at >= created_at
           and (decision = 'merged') = (merged_into is not null)))
);
--> statement-breakpoint
ALTER TABLE "tag_reviews" ADD CONSTRAINT "tag_reviews_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."objects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_reviews" ADD CONSTRAINT "tag_reviews_value_fk" FOREIGN KEY ("tenant_id","facet","value") REFERENCES "public"."facet_values"("tenant_id","facet","value") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_reviews" ADD CONSTRAINT "tag_reviews_merged_fk" FOREIGN KEY ("tenant_id","facet","merged_into") REFERENCES "public"."facet_values"("tenant_id","facet","value") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tag_reviews_open_idx" ON "tag_reviews" USING btree ("tenant_id","resolved_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_reviews_one_open" ON "tag_reviews" USING btree ("tenant_id","object_id","facet","value") WHERE resolved_at is null;--> statement-breakpoint
ALTER TABLE "object_tags" ADD CONSTRAINT "object_tags_applied_by_matches_source" CHECK (applied_by is null or starts_with(applied_by, source || ':'));