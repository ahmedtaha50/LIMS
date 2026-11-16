-- Directory sign-on (E17). An account is either local (password here) or from the company directory (password there,
-- roles from its groups at every sign-in). Break-glass accounts are local by definition and always work, also when the
-- directory cannot be reached.
ALTER TABLE users ADD COLUMN auth_source text NOT NULL DEFAULT 'local' CHECK (auth_source IN ('local', 'directory'));
ALTER TABLE users ADD COLUMN break_glass boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN directory_dn text;
ALTER TABLE users ADD CONSTRAINT users_break_glass_local CHECK (NOT break_glass OR auth_source = 'local');
