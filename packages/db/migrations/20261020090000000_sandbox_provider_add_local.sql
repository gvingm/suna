-- Add 'local' to the sandbox_provider enum: the self-hosted backend that runs an
-- agent sandbox as a plain Docker container on the same host as the API, so a
-- deployment needs no cloud provider account (no Daytona / E2B / Platinum).
--
-- ADD VALUE only (never USED in this txn) — matches the existing precedent for
-- adding enum values (executor_connector_provider 'channel'/'computer',
-- sandbox_provider 'managed'). Non-destructive + idempotent.
ALTER TYPE "kortix"."sandbox_provider" ADD VALUE IF NOT EXISTS 'local';
