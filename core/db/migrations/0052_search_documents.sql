CREATE TABLE "search_documents" (
	"tenant_id" text NOT NULL,
	"object_id" text NOT NULL,
	"version_id" text,
	"title_tsv" "tsvector" DEFAULT ''::tsvector NOT NULL,
	"other_title_tsv" "tsvector" DEFAULT ''::tsvector NOT NULL,
	"tags_tsv" "tsvector" DEFAULT ''::tsvector NOT NULL,
	"trusted_tags_tsv" "tsvector" DEFAULT ''::tsvector NOT NULL,
	"public_tags_tsv" "tsvector" DEFAULT ''::tsvector NOT NULL,
	"summary_tsv" "tsvector" DEFAULT ''::tsvector NOT NULL,
	"summary_provider_kind" text,
	"body_tsv" "tsvector" DEFAULT ''::tsvector NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_documents_tenant_id_object_id_pk" PRIMARY KEY("tenant_id","object_id"),
	CONSTRAINT "search_documents_provider_kind_valid" CHECK (summary_provider_kind is null or summary_provider_kind in ('local', 'commercial', 'consumer'))
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
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."objects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_embeddings" ADD CONSTRAINT "version_embeddings_version_fk" FOREIGN KEY ("tenant_id","object_id","version_id") REFERENCES "public"."versions"("tenant_id","object_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "version_embeddings_object_idx" ON "version_embeddings" USING btree ("tenant_id","object_id","model");--> statement-breakpoint
CREATE INDEX "version_embeddings_model_idx" ON "version_embeddings" USING btree ("tenant_id","model","version_id");