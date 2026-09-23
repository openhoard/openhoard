-- Candidate core schema for the parity spike (S2). Not the final data model (E3), but it uses
-- every Postgres feature the core plans to rely on: composite tenant keys, checks, cascades,
-- generated tsvector columns, GIN on arrays, pgvector HNSW, JSONB, triggers and row-level
-- security.

create extension if not exists vector;

create table tenants (
  id text primary key,
  name text not null
);

create table objects (
  tenant_id text not null references tenants (id),
  id text not null,
  title text not null,
  zone text not null check (zone in ('managed', 'indexed', 'local-only', 'code')),
  owner_id text not null,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);

create table versions (
  tenant_id text not null,
  id text not null,
  object_id text not null,
  blob_id text not null,
  size bigint not null check (size >= 0),
  mime text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, object_id) references objects (tenant_id, id) on delete cascade
);

create table object_tags (
  tenant_id text not null,
  object_id text not null,
  tag text not null check (tag ~ '^[a-z][a-z0-9-]*:[^\s:]\S*$'),
  applied_by text not null check (applied_by in ('rule', 'model', 'user', 'pack')),
  confidence real not null check (confidence between 0 and 1),
  primary key (tenant_id, object_id, tag),
  foreign key (tenant_id, object_id) references objects (tenant_id, id) on delete cascade
);

-- Tag grants as data (spike S3): who may read which tag.
create table grants (
  tenant_id text not null,
  principal text not null,
  tag text not null,
  role text not null check (role in ('read', 'write')),
  primary key (tenant_id, principal, tag, role)
);

create table search_docs (
  tenant_id text not null,
  object_id text not null,
  title text not null,
  content text not null default '',
  visible_to text[] not null,
  body tsvector generated always as (
    setweight(to_tsvector('simple', title), 'A') || setweight(to_tsvector('simple', content), 'B')
  ) stored,
  embedding vector(8),
  primary key (tenant_id, object_id),
  foreign key (tenant_id, object_id) references objects (tenant_id, id) on delete cascade
);
create index search_docs_body on search_docs using gin (body);
create index search_docs_visible on search_docs using gin (visible_to);
create index search_docs_embedding on search_docs using hnsw (embedding vector_cosine_ops);

create table audit_events (
  tenant_id text not null,
  seq bigint not null,
  prev_hash text not null,
  hash text not null,
  body jsonb not null,
  primary key (tenant_id, seq)
);

create table jobs (
  id bigserial primary key,
  queue text not null,
  state text not null default 'created',
  payload jsonb not null
);

create function touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger objects_touch before update on objects
  for each row execute function touch_updated_at();

-- Row-level security: every tenant table filters on app.tenant_id. An unset setting yields
-- NULL, which matches nothing, so a missing tenant context fails closed.
create role app nologin;
grant select, insert, update, delete on all tables in schema public to app;
alter table objects enable row level security;
alter table objects force row level security;
create policy tenant_isolation on objects
  using (tenant_id = current_setting('app.tenant_id', true));
alter table search_docs enable row level security;
alter table search_docs force row level security;
create policy tenant_isolation on search_docs
  using (tenant_id = current_setting('app.tenant_id', true));
