CREATE TABLE "principal_epochs" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"epoch" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "principal_epochs" ADD CONSTRAINT "principal_epochs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;