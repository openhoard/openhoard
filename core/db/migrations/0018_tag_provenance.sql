ALTER TABLE "tag_reviews" DROP CONSTRAINT "tag_reviews_resolution_complete";--> statement-breakpoint
ALTER TABLE "object_tags" ADD COLUMN "model_applied_by" text;--> statement-breakpoint
ALTER TABLE "object_tags" ADD COLUMN "model_confidence" real;--> statement-breakpoint
ALTER TABLE "object_tags" ADD CONSTRAINT "object_tags_model_provenance" CHECK ((model_confidence is null and model_applied_by is null)
       or (source in ('rule', 'pack') and model_confidence >= 0 and model_confidence <= 1
           and (model_applied_by is null or model_applied_by ~ '^model:.+$')));--> statement-breakpoint
ALTER TABLE "tag_reviews" ADD CONSTRAINT "tag_reviews_resolution_complete" CHECK ((decision is null and resolved_by is null and resolved_at is null and merged_into is null)
       or (decision is not null and decision in ('approved', 'rejected', 'merged', 'withdrawn')
           and resolved_by is not null and resolved_by ~ '^[a-z]+:.+$'
           and resolved_at is not null and resolved_at >= created_at
           and (decision = 'merged') = (merged_into is not null)));