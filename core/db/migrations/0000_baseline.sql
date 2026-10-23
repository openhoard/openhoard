-- The schema as drizzle-kit generates it from src/schema.ts, squashed (T-1408) from migrations
-- 0000-0071 as they stood at 8ccdef5; 0001_rls.sql adds what drizzle-kit doesn't generate.
--
-- Vector search (T-407, T-502) needs pgvector in this database, before version_embeddings is
-- made. pgvector doesn't mark itself a trusted extension, so only a superuser can create it, and
-- OpenHoard never connects as one (core/db refuses superusers: they skip row-level security). A
-- DBA runs, once per database,
--
--   CREATE EXTENSION vector;
--
-- (core/db README, "Server requirements"). This tries it anyway, in case a later pgvector is
-- trusted or the role was given the right, and otherwise stops the migrations with that
-- instruction instead of failing on an unknown type. PGlite creates it on open.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    BEGIN
      CREATE EXTENSION vector;
    EXCEPTION
      WHEN insufficient_privilege OR undefined_file OR feature_not_supported THEN
        RAISE EXCEPTION 'pgvector is not installed in database %', current_database()
          USING ERRCODE = 'object_not_in_prerequisite_state',
                HINT = 'A superuser must run CREATE EXTENSION vector; in this database once (pgvector 0.8 or later), then start OpenHoard again. See the core/db README, "Server requirements".';
    END;
  END IF;
END $$;
--> statement-breakpoint
CREATE SCHEMA "audit";
--> statement-breakpoint
CREATE TABLE "activity_events" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"actor" text NOT NULL,
	"type" text NOT NULL,
	"object_id" text NOT NULL,
	"version_id" text,
	"client_id" text,
	"client_trust" text,
	"origin" text DEFAULT 'openhoard' NOT NULL,
	"external_id" text,
	CONSTRAINT "activity_events_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "activity_events_id_format" CHECK (id ~ '^act_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "activity_events_at_milliseconds" CHECK (at = date_trunc('milliseconds', at)),
	CONSTRAINT "activity_events_actor_principal" CHECK (actor ~ '^[a-z]+:.+$'),
	CONSTRAINT "activity_events_type_valid" CHECK (type in ('view', 'open', 'edit', 'share')),
	CONSTRAINT "activity_events_client_complete" CHECK ((client_id is null) = (client_trust is null)),
	CONSTRAINT "activity_events_client_trust_valid" CHECK (client_trust is null or client_trust in ('first-party', 'local', 'commercial', 'consumer')),
	CONSTRAINT "activity_events_client_id_length" CHECK (client_id is null or char_length(client_id) between 1 and 256),
	CONSTRAINT "activity_events_origin_format" CHECK (origin ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
	CONSTRAINT "activity_events_external_id_length" CHECK (external_id is null or char_length(external_id) between 1 and 512)
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"user_id" text NOT NULL,
	"user_kind" text DEFAULT 'service' NOT NULL,
	"zone_ids" text[],
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"actions" text[] NOT NULL,
	"zones" text[] NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "api_keys_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "api_keys_service_only" CHECK (user_kind = 'service'),
	CONSTRAINT "api_keys_zone_ids_valid" CHECK (zone_ids is null or (cardinality(zone_ids) between 1 and 100
        and array_position(zone_ids, null) is null
        and array_to_string(zone_ids, ',') ~ '^(zon_[0-9a-hjkmnp-tv-z]{26})(,zon_[0-9a-hjkmnp-tv-z]{26})*$')),
	CONSTRAINT "api_keys_id_format" CHECK (id ~ '^key_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "api_keys_name_length" CHECK (char_length(name) between 1 and 200),
	CONSTRAINT "api_keys_secret_hash_format" CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "api_keys_actions_valid" CHECK (cardinality(actions) > 0 and actions <@ array['search', 'read', 'open', 'tag']::text[]),
	CONSTRAINT "api_keys_zones_valid" CHECK (cardinality(zones) > 0 and zones <@ array['managed', 'indexed', 'local-only', 'code']::text[]),
	CONSTRAINT "api_keys_expiry" CHECK (expires_at > created_at and expires_at <= created_at + interval '366 days'),
	CONSTRAINT "api_keys_created_by_principal" CHECK (created_by ~ '^(user|system):.+$'),
	CONSTRAINT "api_keys_revocation_complete" CHECK ((revoked_at is null) = (revoked_by is null) and (revoked_at is null or revoked_at >= created_at)),
	CONSTRAINT "api_keys_revoked_by_principal" CHECK (revoked_by is null or revoked_by ~ '^(user|system):.+$')
);
--> statement-breakpoint
CREATE TABLE "audit"."events" (
	"tenant_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"decision" text NOT NULL,
	"client" text,
	"object" text,
	"version" text,
	"event" text NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "events_tenant_id_seq_pk" PRIMARY KEY("tenant_id","seq"),
	CONSTRAINT "audit_events_seq_positive" CHECK (seq > 0),
	CONSTRAINT "audit_events_decision_valid" CHECK (decision in ('allow', 'deny')),
	CONSTRAINT "audit_events_hash_format" CHECK (hash ~ '^[0-9a-f]{64}$' and prev_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
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
	"public" boolean DEFAULT false NOT NULL,
	"single" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facets_tenant_id_key_pk" PRIMARY KEY("tenant_id","key"),
	CONSTRAINT "facets_key_format" CHECK (key ~ '^[a-z][a-z0-9-]{0,63}$'),
	CONSTRAINT "facets_label_length" CHECK (char_length(label) between 1 and 200)
);
--> statement-breakpoint
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
	CONSTRAINT "groups_external_id_length" CHECK (external_id is null or char_length(external_id) between 1 and 512),
	CONSTRAINT "groups_external_id_scim" CHECK (source = 'scim' or external_id is null)
);
--> statement-breakpoint
CREATE TABLE "injection_reviews" (
	"tenant_id" text NOT NULL,
	"object_id" text NOT NULL,
	"version_id" text NOT NULL,
	"blob_id" text NOT NULL,
	"title" text,
	"folders" text[],
	"reviewed_by" text NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "injection_reviews_tenant_id_object_id_pk" PRIMARY KEY("tenant_id","object_id"),
	CONSTRAINT "injection_reviews_by_user" CHECK (reviewed_by ~ '^user:usr_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "injection_reviews_blob_format" CHECK (blob_id ~ '^b3t:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"user_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"passkey_id" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "invites_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "invites_id_format" CHECK (id ~ '^inv_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "invites_secret_hash_format" CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "invites_expiry" CHECK (expires_at > created_at and expires_at <= created_at + interval '168 hours'),
	CONSTRAINT "invites_created_by_principal" CHECK (created_by ~ '^(user|system):.+$'),
	CONSTRAINT "invites_passkey_id_format" CHECK (passkey_id ~ '^pky_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "invites_use_complete" CHECK ((used_at is null) = (passkey_id is null) and (used_at is null or used_at >= created_at)),
	CONSTRAINT "invites_revocation_complete" CHECK ((revoked_at is null) = (revoked_by is null) and (revoked_at is null or revoked_at >= created_at)),
	CONSTRAINT "invites_revoked_by_principal" CHECK (revoked_by is null or revoked_by ~ '^(user|system|scim):.+$'),
	CONSTRAINT "invites_one_end" CHECK (used_at is null or revoked_at is null)
);
--> statement-breakpoint
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
CREATE TABLE "oauth_clients" (
	"tenant_id" text NOT NULL,
	"client_key" text NOT NULL,
	"kind" text NOT NULL,
	"client_ref" text NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"trust" text,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "oauth_clients_tenant_id_client_key_pk" PRIMARY KEY("tenant_id","client_key"),
	CONSTRAINT "oauth_clients_last_used" CHECK (last_used_at is null or last_used_at >= requested_at),
	CONSTRAINT "oauth_clients_key_format" CHECK (client_key ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "oauth_clients_kind_valid" CHECK (kind in ('cimd', 'dcr')),
	CONSTRAINT "oauth_clients_ref_length" CHECK (char_length(client_ref) between 1 and 2048),
	CONSTRAINT "oauth_clients_name_length" CHECK (char_length(name) between 1 and 200),
	CONSTRAINT "oauth_clients_redirects" CHECK (cardinality(redirect_uris) between 1 and 20 and array_position(redirect_uris, null) is null),
	CONSTRAINT "oauth_clients_status_valid" CHECK (status in ('pending', 'approved', 'refused')),
	CONSTRAINT "oauth_clients_trust" CHECK ((status = 'approved') = (trust is not null) and (trust is null or trust in ('local', 'commercial', 'consumer'))),
	CONSTRAINT "oauth_clients_decision" CHECK ((status = 'pending') = (decided_at is null) and (decided_at is null) = (decided_by is null)),
	CONSTRAINT "oauth_clients_requested_by" CHECK (requested_by ~ '^(user|system):.+$'),
	CONSTRAINT "oauth_clients_decided_by" CHECK (decided_by is null or decided_by ~ '^(user|system):.+$')
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"user_kind" text NOT NULL,
	"client_key" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"scopes" text[] NOT NULL,
	"resource" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"grant_id" text,
	CONSTRAINT "oauth_codes_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "oauth_codes_id_format" CHECK (id ~ '^oac_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "oauth_codes_person_only" CHECK (user_kind in ('member', 'guest')),
	CONSTRAINT "oauth_codes_secret_hash_format" CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "oauth_codes_redirect_length" CHECK (char_length(redirect_uri) between 1 and 2048),
	CONSTRAINT "oauth_codes_challenge_format" CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "oauth_codes_scopes" CHECK (cardinality(scopes) between 1 and 3 and scopes <@ array['files:read', 'files:tag', 'files:add']::text[]),
	CONSTRAINT "oauth_codes_resource_length" CHECK (char_length(resource) between 1 and 2048),
	CONSTRAINT "oauth_codes_expiry" CHECK (expires_at > created_at and expires_at <= created_at + interval '10 minutes'),
	CONSTRAINT "oauth_codes_used" CHECK (used_at is null or used_at >= created_at)
);
--> statement-breakpoint
CREATE TABLE "oauth_grants" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"user_id" text NOT NULL,
	"user_kind" text NOT NULL,
	"client_key" text NOT NULL,
	"scopes" text[] NOT NULL,
	"resource" text NOT NULL,
	"refresh_hash" text NOT NULL,
	"previous_refresh_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refreshed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "oauth_grants_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "oauth_grants_id_format" CHECK (id ~ '^ogr_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "oauth_grants_person_only" CHECK (user_kind in ('member', 'guest')),
	CONSTRAINT "oauth_grants_scopes" CHECK (cardinality(scopes) between 1 and 3 and scopes <@ array['files:read', 'files:tag', 'files:add']::text[]),
	CONSTRAINT "oauth_grants_resource_length" CHECK (char_length(resource) between 1 and 2048),
	CONSTRAINT "oauth_grants_refresh_format" CHECK (refresh_hash ~ '^[0-9a-f]{64}$' and (previous_refresh_hash is null or previous_refresh_hash ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "oauth_grants_expiry" CHECK (expires_at > created_at and expires_at <= created_at + interval '90 days'),
	CONSTRAINT "oauth_grants_revocation_complete" CHECK ((revoked_at is null) = (revoked_by is null) and (revoked_at is null or revoked_at >= created_at)),
	CONSTRAINT "oauth_grants_revoked_by_principal" CHECK (revoked_by is null or revoked_by ~ '^(user|system|scim):.+$')
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"grant_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "oauth_tokens_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "oauth_tokens_scopes" CHECK (cardinality(scopes) between 1 and 3 and scopes <@ array['files:read', 'files:tag', 'files:add']::text[]),
	CONSTRAINT "oauth_tokens_id_format" CHECK (id ~ '^oat_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "oauth_tokens_secret_hash_format" CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "oauth_tokens_expiry" CHECK (expires_at > created_at and expires_at <= created_at + interval '1 day')
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
	"model_applied_by" text,
	"model_confidence" real,
	"primary_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "object_tags_tenant_id_object_id_facet_value_pk" PRIMARY KEY("tenant_id","object_id","facet","value"),
	CONSTRAINT "object_tags_source_valid" CHECK (source in ('rule', 'model', 'user', 'pack')),
	CONSTRAINT "object_tags_confidence_range" CHECK (confidence >= 0 and confidence <= 1),
	CONSTRAINT "object_tags_applied_by_principal" CHECK (applied_by is null or applied_by ~ '^[a-z]+:.+$'),
	CONSTRAINT "object_tags_applied_by_matches_source" CHECK (applied_by is null or starts_with(applied_by, source || ':')),
	CONSTRAINT "object_tags_primary_trusted" CHECK (primary_by is null or (primary_by ~ '^(user|rule|pack):.+$' and (source <> 'model' or reviewed))),
	CONSTRAINT "object_tags_model_provenance" CHECK ((model_confidence is null and model_applied_by is null)
       or (source in ('rule', 'pack') and model_confidence >= 0 and model_confidence <= 1
           and (model_applied_by is null or model_applied_by ~ '^model:.+$')))
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
	"display_title" text,
	"display_title_by" text,
	"display_title_for" text,
	CONSTRAINT "objects_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "objects_id_format" CHECK (id ~ '^obj_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "objects_title_length" CHECK (char_length(title) between 1 and 1024),
	CONSTRAINT "objects_owner_principal" CHECK (owner_id ~ '^[a-z]+:.+$'),
	CONSTRAINT "objects_display_title_length" CHECK (display_title is null or char_length(display_title) between 1 and 1024),
	CONSTRAINT "objects_display_title_by" CHECK (display_title_by is null or display_title_by ~ '^(user|model):.+$'),
	CONSTRAINT "objects_display_title_has_author" CHECK (display_title is null or display_title_by is not null),
	CONSTRAINT "objects_display_title_decision" CHECK ((display_title_by is null) = (display_title_for is null))
);
--> statement-breakpoint
CREATE TABLE "passkey_challenges" (
	"tenant_id" text NOT NULL,
	"challenge_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "passkey_challenges_tenant_id_challenge_hash_pk" PRIMARY KEY("tenant_id","challenge_hash"),
	CONSTRAINT "passkey_challenges_hash_format" CHECK (challenge_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "passkeys" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"user_id" text NOT NULL,
	"rp_id" text,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"algorithm" integer NOT NULL,
	"sign_count" bigint DEFAULT 0 NOT NULL,
	"transports" text[] NOT NULL,
	"backup_eligible" boolean NOT NULL,
	"backed_up" boolean NOT NULL,
	"aaguid" text NOT NULL,
	"name" text NOT NULL,
	"invite_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "passkeys_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "passkeys_credential_unique" UNIQUE("tenant_id","credential_id"),
	CONSTRAINT "passkeys_id_format" CHECK (id ~ '^pky_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "passkeys_credential_id_format" CHECK (credential_id ~ '^[A-Za-z0-9_-]+$' and char_length(credential_id) between 22 and 1364),
	CONSTRAINT "passkeys_public_key_format" CHECK (public_key ~ '^[A-Za-z0-9_-]+$' and char_length(public_key) between 40 and 4096),
	CONSTRAINT "passkeys_algorithm_valid" CHECK (algorithm in (-7, -8, -257)),
	CONSTRAINT "passkeys_sign_count_range" CHECK (sign_count between 0 and 4294967295),
	CONSTRAINT "passkeys_transports_valid" CHECK (cardinality(transports) <= 8 and array_position(transports, null) is null
        and array_to_string(transports, ',') ~ '^([a-z][a-z0-9-]{0,31}(,[a-z][a-z0-9-]{0,31})*)?$'),
	CONSTRAINT "passkeys_backup_state" CHECK (backup_eligible or not backed_up),
	CONSTRAINT "passkeys_aaguid_format" CHECK (aaguid ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "passkeys_name_length" CHECK (char_length(name) between 1 and 100),
	CONSTRAINT "passkeys_invite_id_format" CHECK (invite_id ~ '^inv_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "passkeys_last_used" CHECK (last_used_at is null or last_used_at >= created_at),
	CONSTRAINT "passkeys_rp_id_length" CHECK (rp_id is null or char_length(rp_id) between 1 and 253)
);
--> statement-breakpoint
CREATE TABLE "principal_epochs" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"epoch" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scim_tokens" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "scim_tokens_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "scim_tokens_id_format" CHECK (id ~ '^sct_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "scim_tokens_name_length" CHECK (char_length(name) between 1 and 200),
	CONSTRAINT "scim_tokens_secret_hash_format" CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "scim_tokens_expiry" CHECK (expires_at > created_at and expires_at <= created_at + interval '366 days'),
	CONSTRAINT "scim_tokens_last_used" CHECK (last_used_at is null or last_used_at >= created_at),
	CONSTRAINT "scim_tokens_created_by_principal" CHECK (created_by ~ '^(user|system):.+$'),
	CONSTRAINT "scim_tokens_revocation_complete" CHECK ((revoked_at is null) = (revoked_by is null) and (revoked_at is null or revoked_at >= created_at)),
	CONSTRAINT "scim_tokens_revoked_by_principal" CHECK (revoked_by is null or revoked_by ~ '^(user|system):.+$')
);
--> statement-breakpoint
CREATE TABLE "search_documents" (
	"tenant_id" text NOT NULL,
	"object_id" text NOT NULL,
	"version_id" text,
	"title_tsv" "tsvector" DEFAULT ''::tsvector NOT NULL,
	"other_title_tsv" "tsvector" DEFAULT ''::tsvector NOT NULL,
	"tags_tsv" "tsvector" DEFAULT ''::tsvector NOT NULL,
	"trusted_tags_tsv" "tsvector" DEFAULT ''::tsvector NOT NULL,
	"public_tags_tsv" "tsvector" DEFAULT ''::tsvector NOT NULL,
	"path_tsv" "tsvector" DEFAULT ''::tsvector NOT NULL,
	"summary_tsv" "tsvector" DEFAULT ''::tsvector NOT NULL,
	"summary_provider_kind" text,
	"body_tsv" "tsvector" DEFAULT ''::tsvector NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_documents_tenant_id_object_id_pk" PRIMARY KEY("tenant_id","object_id"),
	CONSTRAINT "search_documents_provider_kind_valid" CHECK (summary_provider_kind is null or summary_provider_kind in ('local', 'commercial', 'consumer'))
);
--> statement-breakpoint
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
CREATE TABLE "sign_in_links" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"user_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"session_id" text,
	CONSTRAINT "sign_in_links_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "sign_in_links_id_format" CHECK (id ~ '^sil_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "sign_in_links_secret_hash_format" CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sign_in_links_expiry" CHECK (expires_at > created_at and expires_at <= created_at + interval '1 hour'),
	CONSTRAINT "sign_in_links_created_by_principal" CHECK (created_by ~ '^(user|system):.+$'),
	CONSTRAINT "sign_in_links_use_complete" CHECK ((used_at is null) = (session_id is null) and (used_at is null or used_at >= created_at))
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
	"source_modified_at" timestamp with time zone,
	"source_modified_by" text,
	"source_created_by" text,
	"path" text[],
	CONSTRAINT "source_refs_tenant_id_source_external_id_pk" PRIMARY KEY("tenant_id","source","external_id"),
	CONSTRAINT "source_refs_source_format" CHECK (source ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
	CONSTRAINT "source_refs_external_id_length" CHECK (char_length(external_id) between 1 and 2048),
	CONSTRAINT "source_refs_path_length" CHECK (cardinality(path) between 1 and 1024),
	CONSTRAINT "source_refs_source_users_length" CHECK (char_length(source_modified_by) between 1 and 1024 and char_length(source_created_by) between 1 and 1024)
);
--> statement-breakpoint
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
CREATE TABLE "source_skips" (
	"tenant_id" text NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"reason" text NOT NULL,
	"path" text[],
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_skips_tenant_id_source_external_id_pk" PRIMARY KEY("tenant_id","source","external_id"),
	CONSTRAINT "source_skips_reason_format" CHECK (reason ~ '^[a-z0-9][a-z0-9:-]{0,63}$'),
	CONSTRAINT "source_skips_external_id_length" CHECK (char_length(external_id) between 1 and 1024),
	CONSTRAINT "source_skips_path_length" CHECK (path is null or cardinality(path) between 1 and 1024)
);
--> statement-breakpoint
CREATE TABLE "source_syncs" (
	"tenant_id" text NOT NULL,
	"source" text NOT NULL,
	"zone_id" text NOT NULL,
	"connector" text NOT NULL,
	"phase" text NOT NULL,
	"token" text,
	"reconcile_from" timestamp with time zone,
	"source_identity" text,
	"reconcile_held" integer,
	"reconcile_confirmed" integer,
	"reconcile_deferred" boolean DEFAULT false NOT NULL,
	"delta_deletes" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"last_counts" jsonb,
	"last_current_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"stopped_error" text,
	"owner_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_syncs_tenant_id_source_pk" PRIMARY KEY("tenant_id","source"),
	CONSTRAINT "source_syncs_source_format" CHECK (source ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
	CONSTRAINT "source_syncs_connector_format" CHECK (connector ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
	CONSTRAINT "source_syncs_phase_valid" CHECK (phase in ('crawl', 'delta')),
	CONSTRAINT "source_syncs_token_length" CHECK (token is null or char_length(token) between 1 and 65536),
	CONSTRAINT "source_syncs_delta_cursor" CHECK (phase = 'crawl' or token is not null),
	CONSTRAINT "source_syncs_identity_length" CHECK (source_identity is null or char_length(source_identity) between 1 and 1024),
	CONSTRAINT "source_syncs_reconcile_counts" CHECK ((reconcile_held is null or reconcile_held >= 0) and (reconcile_confirmed is null or reconcile_confirmed >= 0)),
	CONSTRAINT "source_syncs_delta_deletes" CHECK (delta_deletes >= 0),
	CONSTRAINT "source_syncs_last_status_valid" CHECK (last_status is null or last_status in ('done', 'partial', 'retry', 'failed', 'cancelled')),
	CONSTRAINT "source_syncs_error_format" CHECK ((last_error is null or last_error ~ '^[a-z0-9][a-z0-9-]{0,63}$') and (stopped_error is null or stopped_error ~ '^[a-z0-9][a-z0-9-]{0,63}$')),
	CONSTRAINT "source_syncs_last_counts_object" CHECK (last_counts is null or jsonb_typeof(last_counts) = 'object'),
	CONSTRAINT "source_syncs_stop_complete" CHECK ((stopped_at is null) = (stopped_error is null)),
	CONSTRAINT "source_syncs_owner_format" CHECK (owner_id is null or owner_id ~ '^user:usr_[0-9a-hjkmnp-tv-z]{26}$')
);
--> statement-breakpoint
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
	CONSTRAINT "tag_reviews_reason_valid" CHECK (reason in ('new-value', 'low-confidence', 'sensitive', 'conflict', 'primary', 'agent')),
	CONSTRAINT "tag_reviews_source_valid" CHECK (source in ('rule', 'model', 'user', 'pack')),
	CONSTRAINT "tag_reviews_confidence_range" CHECK (confidence >= 0 and confidence <= 1),
	CONSTRAINT "tag_reviews_applied_by_principal" CHECK (applied_by is null or applied_by ~ '^[a-z]+:.+$'),
	CONSTRAINT "tag_reviews_applied_by_matches_source" CHECK (applied_by is null or starts_with(applied_by, source || ':')),
	CONSTRAINT "tag_reviews_resolution_complete" CHECK ((decision is null and resolved_by is null and resolved_at is null and merged_into is null)
       or (decision is not null and decision in ('approved', 'rejected', 'merged', 'withdrawn')
           and resolved_by is not null and resolved_by ~ '^[a-z]+:.+$'
           and resolved_at is not null and resolved_at >= created_at
           and (decision = 'merged') = (merged_into is not null)))
);
--> statement-breakpoint
CREATE TABLE "tenant_packs" (
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"applied_by" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_packs_tenant_id_name_pk" PRIMARY KEY("tenant_id","name"),
	CONSTRAINT "tenant_packs_name_format" CHECK (name ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
	CONSTRAINT "tenant_packs_version_length" CHECK (char_length(version) between 5 and 64),
	CONSTRAINT "tenant_packs_hash_format" CHECK (content_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tenant_packs_applied_by_principal" CHECK (applied_by ~ '^[a-z]+:.+$')
);
--> statement-breakpoint
CREATE TABLE "tenant_storage" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret" text,
	"previous" jsonb,
	"phase" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"lost" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" text NOT NULL,
	CONSTRAINT "tenant_storage_kind" CHECK (kind in ('local', 's3', 'azblob')),
	CONSTRAINT "tenant_storage_phase" CHECK (phase in ('moving', 'active', 'cleaning')),
	CONSTRAINT "tenant_storage_counts" CHECK (total >= 0 and done >= 0 and failed >= 0 and lost >= 0),
	CONSTRAINT "tenant_storage_version" CHECK (version >= 1),
	CONSTRAINT "tenant_storage_error_length" CHECK (last_error is null or char_length(last_error) <= 1024)
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"default_visibility" text DEFAULT 'hidden' NOT NULL,
	"default_exposure" text DEFAULT 'metadata-only' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_id_format" CHECK (id ~ '^ten_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "tenants_name_length" CHECK (char_length(name) between 1 and 200),
	CONSTRAINT "tenants_default_visibility_valid" CHECK (default_visibility in ('hidden', 'discoverable', 'readable')),
	CONSTRAINT "tenants_default_exposure_valid" CHECK (default_exposure in ('metadata-only', 'local-only', 'commercial-only', 'full'))
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
	"email" text,
	"email_key" text,
	"display_name" text NOT NULL,
	"kind" text DEFAULT 'member' NOT NULL,
	"source" text NOT NULL,
	"external_id" text,
	"user_name" text,
	"user_name_key" text,
	"given_name" text,
	"family_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"provider_disabled_at" timestamp with time zone,
	"provider_disabled_by" text,
	"retired_at" timestamp with time zone,
	"retired_by" text,
	"admin_at" timestamp with time zone,
	"admin_by" text,
	CONSTRAINT "users_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "users_kind_unique" UNIQUE("tenant_id","id","kind"),
	CONSTRAINT "users_id_format" CHECK (id ~ '^usr_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "users_email_length" CHECK (char_length(email) between 3 and 320),
	CONSTRAINT "users_email_key_length" CHECK (char_length(email_key) between 3 and 320),
	CONSTRAINT "users_display_name_length" CHECK (char_length(display_name) between 1 and 256),
	CONSTRAINT "users_kind_valid" CHECK (kind in ('member', 'guest', 'service')),
	CONSTRAINT "users_service_email" CHECK ((kind = 'service') = (email is null) and (email is null) = (email_key is null)),
	CONSTRAINT "users_service_local" CHECK (kind <> 'service' or source = 'local'),
	CONSTRAINT "users_source_valid" CHECK (source in ('scim', 'local')),
	CONSTRAINT "users_external_id_length" CHECK (external_id is null or char_length(external_id) between 1 and 512),
	CONSTRAINT "users_external_id_scim" CHECK (source = 'scim' or external_id is null),
	CONSTRAINT "users_user_name_scim" CHECK (source = 'scim' or user_name is null),
	CONSTRAINT "users_user_name_complete" CHECK ((user_name is null) = (user_name_key is null)
       and (user_name is null or char_length(user_name) between 1 and 512)
       and (user_name_key is null or char_length(user_name_key) between 1 and 512)),
	CONSTRAINT "users_name_parts_length" CHECK ((given_name is null or char_length(given_name) between 1 and 256)
       and (family_name is null or char_length(family_name) between 1 and 256)),
	CONSTRAINT "users_lock_complete" CHECK ((locked_at is null) = (locked_by is null)),
	CONSTRAINT "users_locked_by_admin" CHECK (locked_by is null or locked_by ~ '^(user|system):.+$'),
	CONSTRAINT "users_provider_disabled_complete" CHECK ((provider_disabled_at is null) = (provider_disabled_by is null)),
	CONSTRAINT "users_provider_disabled_by_scim" CHECK (provider_disabled_by is null or (provider_disabled_by ~ '^scim:.+$' and source = 'scim')),
	CONSTRAINT "users_retired_complete" CHECK ((retired_at is null) = (retired_by is null)),
	CONSTRAINT "users_retired_by_principal" CHECK (retired_by is null or retired_by ~ '^(user|system|scim):.+$'),
	CONSTRAINT "users_admin_complete" CHECK ((admin_at is null) = (admin_by is null)),
	CONSTRAINT "users_admin_by_principal" CHECK (admin_by is null or admin_by ~ '^(user|system):.+$'),
	CONSTRAINT "users_admin_person" CHECK (admin_at is null or kind <> 'service'),
	CONSTRAINT "users_admin_current" CHECK (admin_at is null or retired_at is null)
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
	CONSTRAINT "version_cards_reason_valid" CHECK ((status = 'skipped') = (reason is not null) and (reason is null or reason in ('no-text', 'flagged', 'budget', 'no-provider', 'model-output', 'refused', 'bad-response', 'too-large', 'unavailable'))),
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
CREATE TABLE "version_embeddings" (
	"tenant_id" text NOT NULL,
	"version_id" text NOT NULL,
	"object_id" text NOT NULL,
	"model" text NOT NULL,
	"part" text NOT NULL,
	"seq" integer NOT NULL,
	"dimensions" integer NOT NULL,
	"provider_kind" text NOT NULL,
	"text_hash" text NOT NULL,
	"embedding" vector NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "version_embeddings_tenant_id_version_id_model_part_seq_pk" PRIMARY KEY("tenant_id","version_id","model","part","seq"),
	CONSTRAINT "version_embeddings_part_valid" CHECK (part in ('summary', 'chunk')),
	CONSTRAINT "version_embeddings_model_format" CHECK (model ~ '^[a-z0-9][a-z0-9-]{0,62}/[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
	CONSTRAINT "version_embeddings_seq_range" CHECK (seq between 0 and 1000),
	CONSTRAINT "version_embeddings_dimensions" CHECK (dimensions between 1 and 16000 and vector_dims(embedding) = dimensions),
	CONSTRAINT "version_embeddings_provider_kind_valid" CHECK (provider_kind in ('local', 'commercial', 'consumer')),
	CONSTRAINT "version_embeddings_text_hash_format" CHECK (text_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
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
CREATE TABLE "versions" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"object_id" text NOT NULL,
	"seq" integer NOT NULL,
	"blob_id" text NOT NULL,
	"mime" text NOT NULL,
	"author_id" text,
	"source_version" text,
	"processed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "versions_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "versions_seq_unique" UNIQUE("tenant_id","object_id","seq"),
	CONSTRAINT "versions_object_id_unique" UNIQUE("tenant_id","object_id","id"),
	CONSTRAINT "versions_id_format" CHECK (id ~ '^ver_[0-9a-hjkmnp-tv-z]{26}$'),
	CONSTRAINT "versions_seq_positive" CHECK (seq > 0),
	CONSTRAINT "versions_mime_format" CHECK (mime ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'),
	CONSTRAINT "versions_author_principal" CHECK (author_id is null or author_id ~ '^[a-z]+:.+$'),
	CONSTRAINT "versions_processed_after_creation" CHECK (processed_at is null or processed_at >= created_at),
	CONSTRAINT "versions_superseded_unprocessed" CHECK (superseded_at is null or (processed_at is null and superseded_at >= created_at))
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
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."objects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_version_fk" FOREIGN KEY ("tenant_id","object_id","version_id") REFERENCES "public"."versions"("tenant_id","object_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_fk" FOREIGN KEY ("tenant_id","user_id","user_kind") REFERENCES "public"."users"("tenant_id","id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit"."events" ADD CONSTRAINT "events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facet_values" ADD CONSTRAINT "facet_values_facet_fk" FOREIGN KEY ("tenant_id","facet") REFERENCES "public"."facets"("tenant_id","key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facets" ADD CONSTRAINT "facets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_tag_fk" FOREIGN KEY ("tenant_id","facet","value") REFERENCES "public"."facet_values"("tenant_id","facet","value") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."objects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_fk" FOREIGN KEY ("tenant_id","group_id") REFERENCES "public"."groups"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "injection_reviews" ADD CONSTRAINT "injection_reviews_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."objects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "injection_reviews" ADD CONSTRAINT "injection_reviews_version_fk" FOREIGN KEY ("tenant_id","object_id","version_id") REFERENCES "public"."versions"("tenant_id","object_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_usage" ADD CONSTRAINT "model_usage_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_user_fk" FOREIGN KEY ("tenant_id","user_id","user_kind") REFERENCES "public"."users"("tenant_id","id","kind") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_client_fk" FOREIGN KEY ("tenant_id","client_key") REFERENCES "public"."oauth_clients"("tenant_id","client_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_user_fk" FOREIGN KEY ("tenant_id","user_id","user_kind") REFERENCES "public"."users"("tenant_id","id","kind") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_client_fk" FOREIGN KEY ("tenant_id","client_key") REFERENCES "public"."oauth_clients"("tenant_id","client_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_grant_fk" FOREIGN KEY ("tenant_id","grant_id") REFERENCES "public"."oauth_grants"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_tags" ADD CONSTRAINT "object_tags_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."objects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_tags" ADD CONSTRAINT "object_tags_value_fk" FOREIGN KEY ("tenant_id","facet","value") REFERENCES "public"."facet_values"("tenant_id","facet","value") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_zone_fk" FOREIGN KEY ("tenant_id","zone_id") REFERENCES "public"."zones"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey_challenges" ADD CONSTRAINT "passkey_challenges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal_epochs" ADD CONSTRAINT "principal_epochs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."objects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_fk" FOREIGN KEY ("tenant_id","user_id","user_kind") REFERENCES "public"."users"("tenant_id","id","kind") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sign_in_links" ADD CONSTRAINT "sign_in_links_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_refs" ADD CONSTRAINT "source_refs_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."objects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_shares" ADD CONSTRAINT "source_shares_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."objects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_skips" ADD CONSTRAINT "source_skips_sync_fk" FOREIGN KEY ("tenant_id","source") REFERENCES "public"."source_syncs"("tenant_id","source") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_syncs" ADD CONSTRAINT "source_syncs_zone_fk" FOREIGN KEY ("tenant_id","zone_id") REFERENCES "public"."zones"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_reviews" ADD CONSTRAINT "tag_reviews_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."objects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_reviews" ADD CONSTRAINT "tag_reviews_value_fk" FOREIGN KEY ("tenant_id","facet","value") REFERENCES "public"."facet_values"("tenant_id","facet","value") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_reviews" ADD CONSTRAINT "tag_reviews_merged_fk" FOREIGN KEY ("tenant_id","facet","merged_into") REFERENCES "public"."facet_values"("tenant_id","facet","value") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_packs" ADD CONSTRAINT "tenant_packs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_storage" ADD CONSTRAINT "tenant_storage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_cards" ADD CONSTRAINT "version_cards_version_fk" FOREIGN KEY ("tenant_id","object_id","version_id") REFERENCES "public"."versions"("tenant_id","object_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_embeddings" ADD CONSTRAINT "version_embeddings_version_fk" FOREIGN KEY ("tenant_id","object_id","version_id") REFERENCES "public"."versions"("tenant_id","object_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_extracts" ADD CONSTRAINT "version_extracts_version_fk" FOREIGN KEY ("tenant_id","object_id","version_id") REFERENCES "public"."versions"("tenant_id","object_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."objects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_blob_fk" FOREIGN KEY ("tenant_id","blob_id") REFERENCES "public"."blobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_events_actor_idx" ON "activity_events" USING btree ("tenant_id","actor","at");--> statement-breakpoint
CREATE INDEX "activity_events_object_idx" ON "activity_events" USING btree ("tenant_id","object_id","at");--> statement-breakpoint
CREATE INDEX "activity_events_at_idx" ON "activity_events" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_events_external_unique" ON "activity_events" USING btree ("tenant_id","origin","external_id") WHERE external_id is not null;--> statement-breakpoint
CREATE INDEX "api_keys_user_idx" ON "api_keys" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "audit_events_at_idx" ON "audit"."events" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE INDEX "audit_events_object_idx" ON "audit"."events" USING btree ("tenant_id","object");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit"."events" USING btree ("tenant_id","actor","seq");--> statement-breakpoint
CREATE INDEX "grants_principal_idx" ON "grants" USING btree ("tenant_id","principal");--> statement-breakpoint
CREATE INDEX "grants_object_idx" ON "grants" USING btree ("tenant_id","object_id");--> statement-breakpoint
CREATE INDEX "grants_tag_idx" ON "grants" USING btree ("tenant_id","facet","value") WHERE facet is not null;--> statement-breakpoint
CREATE INDEX "group_members_user_idx" ON "group_members" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_external_id_unique" ON "groups" USING btree ("tenant_id","external_id") WHERE external_id is not null;--> statement-breakpoint
CREATE INDEX "invites_user_idx" ON "invites" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "oauth_codes_expires_idx" ON "oauth_codes" USING btree ("tenant_id","expires_at");--> statement-breakpoint
CREATE INDEX "oauth_codes_grant_idx" ON "oauth_codes" USING btree ("tenant_id","grant_id");--> statement-breakpoint
CREATE INDEX "oauth_grants_user_idx" ON "oauth_grants" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "oauth_grants_client_idx" ON "oauth_grants" USING btree ("tenant_id","client_key");--> statement-breakpoint
CREATE INDEX "oauth_tokens_grant_idx" ON "oauth_tokens" USING btree ("tenant_id","grant_id");--> statement-breakpoint
CREATE INDEX "oauth_tokens_expires_idx" ON "oauth_tokens" USING btree ("tenant_id","expires_at");--> statement-breakpoint
CREATE INDEX "object_tags_tag_idx" ON "object_tags" USING btree ("tenant_id","facet","value");--> statement-breakpoint
CREATE UNIQUE INDEX "object_tags_one_primary" ON "object_tags" USING btree ("tenant_id","object_id") WHERE primary_by is not null;--> statement-breakpoint
CREATE INDEX "objects_zone_idx" ON "objects" USING btree ("tenant_id","zone_id");--> statement-breakpoint
CREATE INDEX "objects_owner_idx" ON "objects" USING btree ("tenant_id","owner_id");--> statement-breakpoint
CREATE INDEX "passkey_challenges_expiry_idx" ON "passkey_challenges" USING btree ("tenant_id","expires_at");--> statement-breakpoint
CREATE INDEX "passkeys_user_idx" ON "passkeys" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("tenant_id","expires_at");--> statement-breakpoint
CREATE INDEX "sign_in_links_user_idx" ON "sign_in_links" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "source_refs_object_idx" ON "source_refs" USING btree ("tenant_id","object_id");--> statement-breakpoint
CREATE INDEX "source_shares_kind_idx" ON "source_shares" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE INDEX "source_shares_object_idx" ON "source_shares" USING btree ("tenant_id","object_id");--> statement-breakpoint
CREATE INDEX "source_skips_reason_idx" ON "source_skips" USING btree ("tenant_id","source","reason");--> statement-breakpoint
CREATE INDEX "tag_reviews_open_idx" ON "tag_reviews" USING btree ("tenant_id","created_at","id") WHERE resolved_at is null;--> statement-breakpoint
CREATE INDEX "tag_reviews_tag_idx" ON "tag_reviews" USING btree ("tenant_id","facet","value") WHERE resolved_at is null;--> statement-breakpoint
CREATE INDEX "tag_reviews_object_idx" ON "tag_reviews" USING btree ("tenant_id","object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_reviews_one_open" ON "tag_reviews" USING btree ("tenant_id","object_id","facet","value") WHERE resolved_at is null and reason <> 'primary';--> statement-breakpoint
CREATE UNIQUE INDEX "tag_reviews_one_open_primary" ON "tag_reviews" USING btree ("tenant_id","object_id") WHERE resolved_at is null and reason = 'primary';--> statement-breakpoint
CREATE INDEX "user_identities_user_idx" ON "user_identities" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("tenant_id","email_key") WHERE retired_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "users_external_id_unique" ON "users" USING btree ("tenant_id","external_id") WHERE external_id is not null and retired_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "users_user_name_unique" ON "users" USING btree ("tenant_id","user_name_key") WHERE user_name_key is not null and retired_at is null;--> statement-breakpoint
CREATE INDEX "version_cards_object_idx" ON "version_cards" USING btree ("tenant_id","object_id");--> statement-breakpoint
CREATE INDEX "version_embeddings_object_idx" ON "version_embeddings" USING btree ("tenant_id","object_id","model");--> statement-breakpoint
CREATE INDEX "version_embeddings_model_idx" ON "version_embeddings" USING btree ("tenant_id","model","version_id");--> statement-breakpoint
CREATE INDEX "version_extracts_object_idx" ON "version_extracts" USING btree ("tenant_id","object_id");--> statement-breakpoint
CREATE INDEX "versions_blob_idx" ON "versions" USING btree ("tenant_id","blob_id");--> statement-breakpoint
CREATE INDEX "versions_pending_idx" ON "versions" USING btree ("tenant_id","object_id","seq") WHERE processed_at is null and superseded_at is null;