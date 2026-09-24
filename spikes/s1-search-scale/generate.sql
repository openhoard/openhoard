-- Spike S1 data: :rows synthetic document versions with text, an access list and a 128-d
-- embedding, generated inside Postgres (fast, deterministic with setseed).
--
-- Text: a 4-word title and 30 words of body, drawn from 5,000 words (w1…w5000) with a steep
-- skew, so some terms match most rows and others a handful, as in real corpora.
-- Access: each document belongs to one of 60 groups (by topic); 20% are also visible to
-- `group:everyone`; 1 in 1,000 is also shared with `user:u42`.
-- Embeddings: one of 200 topic centroids plus noise, L2-normalised, so nearest neighbours are
-- meaningful and filters correlate with topics, as departments do in real tenants.

select setseed(0.42);

drop table if exists docs;
drop table if exists centroids;

create table centroids as
  select t, array(select (random() * 2 - 1)::real from generate_series(1, 128 + t * 0)) as c
  from generate_series(0, 199) t;

create table docs (
  id bigint primary key,
  topic int not null,
  title text not null,
  content text not null,
  visible_to text[] not null,
  body tsvector generated always as (
    setweight(to_tsvector('simple', title), 'A') || setweight(to_tsvector('simple', content), 'B')
  ) stored,
  embedding vector(128) not null
);

insert into docs (id, topic, title, content, visible_to, embedding)
select
  g.id,
  g.topic,
  -- The "+ g.id * 0" makes each subquery correlated, so it runs (and draws) once per row.
  (select string_agg('w' || (1 + floor(power(random(), 3) * 4999))::int, ' ')
     from generate_series(1, 4 + g.id * 0) k),
  (select string_agg('w' || (1 + floor(power(random(), 3) * 4999))::int, ' ')
     from generate_series(1, 30 + g.id * 0) k),
  array['group:g' || (g.topic % 60)]
    || case when random() < 0.2 then array['group:everyone'] else array[]::text[] end
    || case when g.id % 1000 = 0 then array['user:u42'] else array[]::text[] end,
  l2_normalize((
    select array_agg(c.c[d] + (random() * 0.6 - 0.3)::real order by d)
    from generate_series(1, 128) d
  )::vector)
from (
  select id, (random() * 199)::int as topic from generate_series(1, :rows) id
) g
join centroids c on c.t = g.topic;

analyze docs;
