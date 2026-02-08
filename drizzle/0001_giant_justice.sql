ALTER TABLE "users" ADD COLUMN "reset_token" varchar(64);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reset_token_expires_at" timestamp;