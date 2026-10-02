ALTER TABLE "oauth_codes" DROP CONSTRAINT "oauth_codes_scopes";--> statement-breakpoint
ALTER TABLE "oauth_grants" DROP CONSTRAINT "oauth_grants_scopes";--> statement-breakpoint
ALTER TABLE "oauth_tokens" DROP CONSTRAINT "oauth_tokens_scopes";--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_scopes" CHECK (cardinality(scopes) between 1 and 3 and scopes <@ array['files:read', 'files:tag', 'files:add']::text[]);--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_scopes" CHECK (cardinality(scopes) between 1 and 3 and scopes <@ array['files:read', 'files:tag', 'files:add']::text[]);--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_scopes" CHECK (cardinality(scopes) between 1 and 3 and scopes <@ array['files:read', 'files:tag', 'files:add']::text[]);