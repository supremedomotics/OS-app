-- ADR 0100 Management: organizational tags on automations (never a runtime concept).
ALTER TABLE automations ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]';
