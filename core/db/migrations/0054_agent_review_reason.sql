-- An AI assistant's tag proposal (T-804, the MCP `tag` tool) waits in the review inbox as its
-- own reason, `agent`: an agent never applies a tag, a person approves it in OpenHoard's app.
ALTER TABLE "tag_reviews" DROP CONSTRAINT "tag_reviews_reason_valid";--> statement-breakpoint
ALTER TABLE "tag_reviews" ADD CONSTRAINT "tag_reviews_reason_valid" CHECK (reason in ('new-value', 'low-confidence', 'sensitive', 'conflict', 'primary', 'agent'));
