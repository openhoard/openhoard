CREATE TABLE "sessions" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"user_id" text NOT NULL,
	"user_kind" text NOT NULL,
	"secret_hash" text NOT NULL,
	"provider" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idle_seconds" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "sessions_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "sessions_id_format" CHECK (id ~ '^ses_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "sessions_person_only" CHECK (user_kind in ('member', 'guest')),
	CONSTRAINT "sessions_secret_hash_format" CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sessions_provider_format" CHECK (provider ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
	CONSTRAINT "sessions_issuer_length" CHECK (char_length(issuer) between 1 and 1024),
	CONSTRAINT "sessions_subject_length" CHECK (char_length(subject) between 1 and 512),
	CONSTRAINT "sessions_idle_range" CHECK (idle_seconds between 60 and 2592000),
	CONSTRAINT "sessions_expiry" CHECK (expires_at > created_at and expires_at <= created_at + interval '30 days'),
	CONSTRAINT "sessions_revocation_complete" CHECK ((revoked_at is null) = (revoked_by is null) and (revoked_at is null or revoked_at >= created_at)),
	CONSTRAINT "sessions_revoked_by_principal" CHECK (revoked_by is null or revoked_by ~ '^(user|system|scim):.+$')
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_fk" FOREIGN KEY ("tenant_id","user_id","user_kind") REFERENCES "public"."users"("tenant_id","id","kind") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("tenant_id","expires_at");