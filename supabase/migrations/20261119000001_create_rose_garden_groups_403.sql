-- 四年三班《正方形玫瑰花圃（百格紙）》雙人合作互動網站資料表（公開觀課獨立隔離版）
create table if not exists public.rose_garden_groups_403 (
  group_key text primary key,
  group_no integer not null check (group_no between 1 and 15),
  seats integer[] not null check (cardinality(seats) between 1 and 3),
  grid text not null default repeat('.', 100) check (char_length(grid) = 100 and grid ~ '^[.GRBW]{100}$'),
  title text not null default '',
  note text not null default '',
  attempts integer not null default 0 check (attempts >= 0),
  wrong_attempts integer not null default 0 check (wrong_attempts >= 0),
  misconceptions jsonb not null default '[]'::jsonb,
  processed_ops jsonb not null default '[]'::jsonb,
  is_completed boolean not null default false,
  completed_at timestamptz,
  is_featured boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_rose_garden_groups_403_active_no
  on public.rose_garden_groups_403 (group_no)
  where is_active = true;

create index if not exists idx_rose_garden_groups_403_active_seats
  on public.rose_garden_groups_403 using gin (seats)
  where is_active = true;

alter table public.rose_garden_groups_403 enable row level security;

-- 最小權限原則：禁止前端匿名或一般帳號直接讀寫，統一由 Edge Function 存取
revoke all on table public.rose_garden_groups_403 from public, anon, authenticated;
grant select, insert, update, delete on table public.rose_garden_groups_403 to service_role;

drop policy if exists "deny_direct_client_access" on public.rose_garden_groups_403;
create policy "deny_direct_client_access"
  on public.rose_garden_groups_403
  for all
  to anon, authenticated
  using (false)
  with check (false);

create or replace function public.set_rose_garden_groups_403_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_rose_garden_groups_403_updated_at on public.rose_garden_groups_403;
create trigger trg_rose_garden_groups_403_updated_at
  before update on public.rose_garden_groups_403
  for each row
  execute function public.set_rose_garden_groups_403_updated_at();
