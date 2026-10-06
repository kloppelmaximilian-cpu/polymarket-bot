-- Deterministic seed per experiment (reproducible simulations). Existing rows keep their old behaviour (id-based seed).
ALTER TABLE "experiments" ADD COLUMN "seed" text;--> statement-breakpoint
UPDATE "experiments" SET "seed" = "id"::text WHERE "seed" IS NULL;--> statement-breakpoint
ALTER TABLE "experiments" ALTER COLUMN "seed" SET NOT NULL;
