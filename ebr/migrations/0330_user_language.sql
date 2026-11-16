-- The interface language of each account (E26): English or Arabic, kept with the account on every device.
ALTER TABLE users ADD COLUMN language text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ar'));
