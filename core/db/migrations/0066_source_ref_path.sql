ALTER TABLE "source_refs" ADD COLUMN "path" text[];--> statement-breakpoint
ALTER TABLE "source_refs" ADD CONSTRAINT "source_refs_path_length" CHECK (cardinality(path) between 1 and 1024);