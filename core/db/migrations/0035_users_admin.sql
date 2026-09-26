ALTER TABLE "users" ADD COLUMN "admin_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "admin_by" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_admin_complete" CHECK ((admin_at is null) = (admin_by is null));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_admin_by_principal" CHECK (admin_by is null or admin_by ~ '^(user|system):.+$');--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_admin_person" CHECK (admin_at is null or kind <> 'service');--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_admin_current" CHECK (admin_at is null or retired_at is null);