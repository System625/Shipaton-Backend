-- search_lab_docs — the vague-search measurement corpus.
--
-- NOT part of the product schema, deliberately. It lives in the same project so
-- the measurements run against real Postgres with the real normalizer, but it is
-- applied by hand rather than by a migration, and it is meant to be dropped:
--
--   drop table if exists search_lab_docs cascade;
--   drop function if exists shelf_lab_search(text, int);
--   drop function if exists shelf_lab_orquery(text);
--   drop function if exists shelf_lab_set_doc();
--
-- Load it with: pull-corpus.ts -> load-corpus.ts -> pull-steam-tags.ts -> load-enrichment.ts

create table if not exists search_lab_docs (
  igdb_id      int primary key,
  name         text not null,
  summary      text,
  storyline    text,
  themes       text[] not null default '{}',
  genres       text[] not null default '{}',
  keywords     text[] not null default '{}',
  perspectives text[] not null default '{}',
  modes        text[] not null default '{}',
  ratings      int not null default 0,
  year         int,
  steam_appid  text,
  steam_tags   text[],   -- SteamSpy crowd tags; null = not fetched, {} = fetched, none
  enrichment   text,     -- the LLM-written "how a player half-remembers it" paragraph
  doc          tsvector
);

-- RLS on with no policies: service role only. Nothing here is exposed to anon or
-- authenticated, because none of it is product data.
alter table search_lab_docs enable row level security;

-- A trigger, not a generated column. array_to_string() is STABLE rather than
-- IMMUTABLE (it can invoke type output functions), and Postgres rejects a STABLE
-- call in a generation expression -- `ERROR: 42P17 generation expression is not
-- immutable`. Same reason 'english' is cast to regconfig explicitly: the bare
-- literal can resolve to the single-argument, STABLE to_tsvector.
--
-- Weights: A title, B structured facets, C keywords, D free text. Keywords sit
-- above prose because IGDB prose is marketing copy, but note that IGDB keywords are
-- ~77 per popular game and heavily polluted with award-show trivia
-- ("the game awards - best art direction - nominee").
create or replace function shelf_lab_set_doc()
returns trigger language plpgsql set search_path = public as $$
begin
  new.doc :=
    setweight(to_tsvector('english'::regconfig, coalesce(new.name,'')), 'A') ||
    setweight(to_tsvector('english'::regconfig,
      concat_ws(' ', array_to_string(new.themes,' '), array_to_string(new.genres,' '),
                     array_to_string(new.perspectives,' '), array_to_string(new.modes,' '))), 'B') ||
    setweight(to_tsvector('english'::regconfig, coalesce(array_to_string(new.keywords,' '),'')), 'C') ||
    setweight(to_tsvector('english'::regconfig,
      concat_ws(' ', new.summary, new.storyline, array_to_string(new.steam_tags,' '), new.enrichment)), 'D');
  return new;
end;
$$;

drop trigger if exists search_lab_docs_doc on search_lab_docs;
create trigger search_lab_docs_doc before insert or update on search_lab_docs
  for each row execute function shelf_lab_set_doc();

create index if not exists search_lab_docs_fts on search_lab_docs using gin (doc);

-- Vague queries share almost no words with any single document, so plainto_tsquery's
-- AND semantics returns nothing at all. ORing the stemmed lexemes is the
-- recall-oriented lexical baseline -- the most generous reading of "just index what
-- we already have" -- which is the number any proposal has to beat.
create or replace function shelf_lab_orquery(q text)
returns tsquery language sql immutable as $$
  select nullif(string_agg(distinct lex, ' | '), '')::tsquery
  from (
    select (regexp_split_to_array(strip(to_tsvector('english'::regconfig, w))::text, ''''))[2] as lex
    from unnest(string_to_array(regexp_replace(lower(q), '[^a-z0-9 ]', ' ', 'g'), ' ')) as w
    where length(w) > 2
  ) t
  where lex is not null and lex <> '';
$$;

create or replace function shelf_lab_search(q text, n int default 5)
returns table(rank int, name text, year int, ratings int, score real)
language sql stable as $$
  with tq as (select shelf_lab_orquery(q) as query)
  select (row_number() over (order by ts_rank_cd('{0.1,0.25,0.6,1.0}'::float4[], d.doc, tq.query) desc,
                             d.ratings desc))::int,
         d.name, d.year, d.ratings,
         ts_rank_cd('{0.1,0.25,0.6,1.0}'::float4[], d.doc, tq.query)
    from search_lab_docs d, tq
   where tq.query is not null and d.doc @@ tq.query
   order by 1
   limit n;
$$;
