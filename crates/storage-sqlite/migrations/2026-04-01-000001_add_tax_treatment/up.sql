-- Add tax treatment column to accounts
ALTER TABLE accounts ADD COLUMN tax_treatment TEXT NOT NULL DEFAULT 'TAXABLE';
