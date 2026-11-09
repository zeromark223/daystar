-- Accounts (from Authentik), Daystar's refresh tokens, rooms owned by accounts and
-- the people a room remembers (co-hosts, speakers who keep their role on reconnect).

CREATE TABLE users (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- OIDC "sub" from Authentik: stable, the only thing that identifies the account.
  authentik_sub  text NOT NULL UNIQUE,
  email          text,
  email_verified boolean NOT NULL DEFAULT false,
  display_name   text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);

-- One row per refresh token. Each refresh replaces the token with a new one in the
-- same family; presenting a token that was already used revokes the whole family.
CREATE TABLE refresh_tokens (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  -- SHA-256 of the token; the token itself is only ever in the browser's cookie.
  token_hash  bytea NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  revoked_at  timestamptz,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user ON refresh_tokens (user_id);

CREATE TABLE rooms (
  id             text PRIMARY KEY,
  owner_id       bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Who may join: anyone with the link, signed-in people, or one email domain.
  access         text NOT NULL DEFAULT 'open' CHECK (access IN ('open', 'signed_in', 'domain')),
  allowed_domain text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (access <> 'domain' OR allowed_domain IS NOT NULL)
);
CREATE INDEX rooms_owner ON rooms (owner_id);

CREATE TABLE room_members (
  room_id  text NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  user_id  bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role     text NOT NULL CHECK (role IN ('co_host', 'speaker')),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX room_members_user ON room_members (user_id);
