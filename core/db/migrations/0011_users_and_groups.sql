CREATE TABLE "group_members" (
	"tenant_id" text NOT NULL,
	"group_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_members_tenant_id_group_id_user_id_pk" PRIMARY KEY("tenant_id","group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "groups_id_format" CHECK (id ~ '^grp_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "groups_name_length" CHECK (char_length(name) between 1 and 256),
	CONSTRAINT "groups_source_valid" CHECK (source in ('scim', 'local')),
	CONSTRAINT "groups_external_id_length" CHECK (external_id is null or char_length(external_id) between 1 and 512)
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"tenant_id" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_identities_tenant_id_issuer_subject_pk" PRIMARY KEY("tenant_id","issuer","subject"),
	CONSTRAINT "user_identities_issuer_length" CHECK (char_length(issuer) between 1 and 1024),
	CONSTRAINT "user_identities_subject_length" CHECK (char_length(subject) between 1 and 512)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"email" text NOT NULL,
	"email_key" text NOT NULL,
	"display_name" text NOT NULL,
	"kind" text DEFAULT 'member' NOT NULL,
	"source" text NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"provider_disabled_at" timestamp with time zone,
	"provider_disabled_by" text,
	"retired_at" timestamp with time zone,
	"retired_by" text,
	CONSTRAINT "users_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "users_id_format" CHECK (id ~ '^usr_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "users_email_length" CHECK (char_length(email) between 3 and 320),
	CONSTRAINT "users_email_key_length" CHECK (char_length(email_key) between 3 and 320),
	CONSTRAINT "users_display_name_length" CHECK (char_length(display_name) between 1 and 256),
	CONSTRAINT "users_kind_valid" CHECK (kind in ('member', 'guest')),
	CONSTRAINT "users_source_valid" CHECK (source in ('scim', 'local')),
	CONSTRAINT "users_external_id_length" CHECK (external_id is null or char_length(external_id) between 1 and 512),
	CONSTRAINT "users_lock_complete" CHECK ((locked_at is null) = (locked_by is null)),
	CONSTRAINT "users_locked_by_admin" CHECK (locked_by is null or locked_by ~ '^(user|system):.+$'),
	CONSTRAINT "users_provider_disabled_complete" CHECK ((provider_disabled_at is null) = (provider_disabled_by is null)),
	CONSTRAINT "users_provider_disabled_by_scim" CHECK (provider_disabled_by is null or (provider_disabled_by ~ '^scim:.+$' and source = 'scim')),
	CONSTRAINT "users_retired_complete" CHECK ((retired_at is null) = (retired_by is null)),
	CONSTRAINT "users_retired_by_principal" CHECK (retired_by is null or retired_by ~ '^(user|system|scim):.+$')
);
--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_fk" FOREIGN KEY ("tenant_id","group_id") REFERENCES "public"."groups"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_members_user_idx" ON "group_members" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_external_id_unique" ON "groups" USING btree ("tenant_id","external_id") WHERE external_id is not null;--> statement-breakpoint
CREATE INDEX "user_identities_user_idx" ON "user_identities" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("tenant_id","email_key") WHERE retired_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "users_external_id_unique" ON "users" USING btree ("tenant_id","external_id") WHERE external_id is not null and retired_at is null;