-- Accounts, sessions and failed sign-ins (E02). Sessions live in the database, so every server instance accepts them.
CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username              text NOT NULL,
  display_name          text NOT NULL,
  password_hash         text NOT NULL,
  must_change_password  boolean NOT NULL DEFAULT true,
  roles                 text[] NOT NULL DEFAULT '{}',
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  totp_secret           text,
  totp_enabled          boolean NOT NULL DEFAULT false,
  locked_until          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  version               integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX users_username_key ON users (lower(username));

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL UNIQUE,
  user_id     uuid NOT NULL REFERENCES users(id),
  mfa         boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  user_agent  text
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE login_failures (
  id       bigserial PRIMARY KEY,
  user_id  uuid NOT NULL REFERENCES users(id),
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_failures_user_idx ON login_failures (user_id, at);
