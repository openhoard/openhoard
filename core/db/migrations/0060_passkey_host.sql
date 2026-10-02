-- T-1205: the host each passkey belongs to, so a server that moved (a new tunnel address) can tell
-- which passkeys it left behind.
ALTER TABLE "passkeys" ADD COLUMN "rp_id" text;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_rp_id_length" CHECK (rp_id is null or char_length(rp_id) between 1 and 253);