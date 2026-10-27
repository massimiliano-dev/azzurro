-- Azzurro: schema idempotente, eseguito a ogni avvio.

-- Store generico per oggetti ARM e Microsoft Graph.
-- id e parent sono sempre in minuscolo (gli ID ARM sono case-insensitive);
-- il casing originale resta dentro data.
CREATE TABLE IF NOT EXISTS objects (
  collection  text        NOT NULL,
  id          text        NOT NULL,
  parent      text,
  data        jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS objects_parent_idx ON objects (collection, parent);
CREATE INDEX IF NOT EXISTS objects_prefix_idx ON objects (collection, id text_pattern_ops);
CREATE INDEX IF NOT EXISTS objects_data_idx ON objects USING gin (data jsonb_path_ops);

-- Activity log ARM, audit di directory e log di accesso.
CREATE TABLE IF NOT EXISTS events (
  id               bigserial   PRIMARY KEY,
  kind             text        NOT NULL,          -- activity | audit | signin
  ts               timestamptz NOT NULL DEFAULT now(),
  subscription_id  text,
  resource_id      text,
  actor_id         text,
  data             jsonb       NOT NULL
);
CREATE INDEX IF NOT EXISTS events_kind_ts_idx ON events (kind, ts DESC);
CREATE INDEX IF NOT EXISTS events_sub_idx ON events (subscription_id, ts DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id          text        PRIMARY KEY,
  user_id     text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  data        jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS keys (
  name        text        PRIMARY KEY,
  data        jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id     text        PRIMARY KEY,
  data        jsonb       NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint    text        PRIMARY KEY,
  user_id     text        NOT NULL,
  data        jsonb       NOT NULL,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id);

CREATE TABLE IF NOT EXISTS notifications (
  id          bigserial   PRIMARY KEY,
  user_id     text        NOT NULL,
  ts          timestamptz NOT NULL DEFAULT now(),
  category    text        NOT NULL,
  title       text        NOT NULL,
  body        text        NOT NULL,
  url         text,
  read_at     timestamptz
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, ts DESC);
