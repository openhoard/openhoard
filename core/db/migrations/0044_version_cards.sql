CREATE TABLE "model_usage" (
	"tenant_id" text NOT NULL,
	"day" text NOT NULL,
	"tokens" bigint DEFAULT 0 NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_usage_tenant_id_day_pk" PRIMARY KEY("tenant_id","day"),
	CONSTRAINT "model_usage_day_format" CHECK (day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
	CONSTRAINT "model_usage_counts" CHECK (tokens >= 0 and calls >= 0)
);
--> statement-breakpoint
CREATE TABLE "version_cards" (
	"tenant_id" text NOT NULL,
	"version_id" text NOT NULL,
	"object_id" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"summary" text DEFAULT '' NOT NULL,
	"provider_id" text,
	"provider_kind" text,
	"model" text,
	"prompt_version" text NOT NULL,
	"filtered" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "version_cards_tenant_id_version_id_pk" PRIMARY KEY("tenant_id","version_id"),
	CONSTRAINT "version_cards_status_valid" CHECK (status in ('summarized', 'skipped')),
	CONSTRAINT "version_cards_reason_valid" CHECK ((status = 'skipped') = (reason is not null) and (reason is null or reason in ('no-text', 'flagged', 'budget', 'no-provider'))),
	CONSTRAINT "version_cards_provider_when_summarized" CHECK ((status = 'summarized') = (provider_id is not null and provider_kind is not null and model is not null)),
	CONSTRAINT "version_cards_provider_kind_valid" CHECK (provider_kind is null or provider_kind in ('local', 'commercial', 'consumer')),
	CONSTRAINT "version_cards_provider_id_format" CHECK (provider_id is null or provider_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
	CONSTRAINT "version_cards_model_length" CHECK (model is null or char_length(model) between 1 and 200),
	CONSTRAINT "version_cards_summary_only_summarized" CHECK (status = 'summarized' or summary = ''),
	CONSTRAINT "version_cards_summary_size" CHECK (char_length(summary) <= 2000),
	CONSTRAINT "version_cards_prompt_version_format" CHECK (prompt_version ~ '^[a-z0-9][a-z0-9./-]{0,63}$'),
	CONSTRAINT "version_cards_counts" CHECK (filtered >= 0 and input_tokens >= 0 and output_tokens >= 0)
);
--> statement-breakpoint
ALTER TABLE "model_usage" ADD CONSTRAINT "model_usage_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_cards" ADD CONSTRAINT "version_cards_version_fk" FOREIGN KEY ("tenant_id","object_id","version_id") REFERENCES "public"."versions"("tenant_id","object_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "version_cards_object_idx" ON "version_cards" USING btree ("tenant_id","object_id");