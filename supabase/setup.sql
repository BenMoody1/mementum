-- MeMentum household sync: run this once.
-- Supabase dashboard > SQL Editor > New query > paste all of this > Run.

create table if not exists public.mm_items (
  household  text        not null check (char_length(household) >= 24),
  key        text        not null,
  data       jsonb,
  deleted    boolean     not null default false,
  device     text,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (household, key)
);
create index if not exists mm_items_changes on public.mm_items (household, updated_at, key);

-- the server stamps every change, so devices with slightly wrong clocks still sync correctly
create or replace function public.mm_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;
drop trigger if exists mm_touch on public.mm_items;
create trigger mm_touch before insert or update on public.mm_items
  for each row execute function public.mm_touch();

-- a device can only see and change rows for the household code it sends
alter table public.mm_items enable row level security;
drop policy if exists mm_household on public.mm_items;
create policy mm_household on public.mm_items for all to anon, authenticated
  using      (household = (current_setting('request.headers', true)::json ->> 'x-household'))
  with check (household = (current_setting('request.headers', true)::json ->> 'x-household'));
grant select, insert, update, delete on public.mm_items to anon, authenticated;
