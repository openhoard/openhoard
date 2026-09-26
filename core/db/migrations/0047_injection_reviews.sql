CREATE TABLE "injection_reviews" (
	"tenant_id" text NOT NULL,
	"object_id" text NOT NULL,
	"reviewed_by" text NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "injection_reviews_tenant_id_object_id_pk" PRIMARY KEY("tenant_id","object_id"),
	CONSTRAINT "injection_reviews_by_user" CHECK (reviewed_by ~ '^user:usr_[0-9a-hjkmnp-tv-z]{26}$')
);
--> statement-breakpoint
ALTER TABLE "version_cards" DROP CONSTRAINT "version_cards_reason_valid";--> statement-breakpoint
ALTER TABLE "injection_reviews" ADD CONSTRAINT "injection_reviews_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."objects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_cards" ADD CONSTRAINT "version_cards_reason_valid" CHECK ((status = 'skipped') = (reason is not null) and (reason is null or reason in ('no-text', 'flagged', 'budget', 'no-provider', 'model-output', 'refused', 'bad-response', 'too-large', 'unavailable')));