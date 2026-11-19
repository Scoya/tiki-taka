-- =========================================================
-- 우리 디데이 · Supabase 설정
-- Supabase 대시보드 → SQL Editor → New query 에 전체를 붙여넣고 Run
-- 여러 번 실행해도 안전하게 만들어져 있어요.
-- =========================================================

-- 1) 커플 공간
create table if not exists public.couples (
  id uuid primary key default gen_random_uuid(),
  invite_code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  created_at timestamptz not null default now()
);

-- 2) 커플 구성원 (계정 1개 = 커플 1개, 커플당 최대 2명)
create table if not exists public.members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  couple_id uuid not null references public.couples (id) on delete cascade,
  slot text not null check (slot in ('me', 'you')),
  created_at timestamptz not null default now(),
  unique (couple_id, slot)
);

-- 3) 앱 데이터 (일정·디데이·메모·설정·사진 정보)
create table if not exists public.items (
  couple_id uuid not null references public.couples (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 60),
  kind text not null check (kind in ('event', 'dday', 'memo', 'settings', 'cats', 'photo')),
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) < 32768),
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (couple_id, id)
);
create index if not exists items_couple_updated on public.items (couple_id, updated_at);

-- 내 커플 id (보안 규칙에서 사용)
create or replace function public.my_couple()
returns uuid language sql stable security definer set search_path = public as $$
  select couple_id from public.members where user_id = auth.uid()
$$;

-- 저장 시각은 서버 시계로 기록 (동기화 기준)
create or replace function public.touch_item()
returns trigger language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  new.updated_by := auth.uid();
  return new;
end $$;
drop trigger if exists items_touch on public.items;
create trigger items_touch before insert or update on public.items
for each row execute function public.touch_item();

-- 4) 보안 규칙 (RLS): 내 커플 데이터만 읽고 쓸 수 있음
alter table public.couples enable row level security;
alter table public.members enable row level security;
alter table public.items enable row level security;

drop policy if exists couples_read on public.couples;
create policy couples_read on public.couples for select to authenticated using (id = public.my_couple());

drop policy if exists members_read on public.members;
create policy members_read on public.members for select to authenticated using (couple_id = public.my_couple());

drop policy if exists items_select on public.items;
drop policy if exists items_insert on public.items;
drop policy if exists items_update on public.items;
create policy items_select on public.items for select to authenticated using (couple_id = public.my_couple());
create policy items_insert on public.items for insert to authenticated with check (couple_id = public.my_couple());
create policy items_update on public.items for update to authenticated using (couple_id = public.my_couple()) with check (couple_id = public.my_couple());

grant select on public.couples, public.members to authenticated;
grant select, insert, update on public.items to authenticated;
revoke all on public.couples, public.members, public.items from anon;

-- 5) 커플 만들기 / 초대 코드로 연결
create or replace function public.create_couple()
returns json language plpgsql security definer set search_path = public as $$
declare c public.couples;
begin
  if auth.uid() is null then raise exception 'not_logged_in'; end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then raise exception 'already_member'; end if;
  insert into public.couples default values returning * into c;
  insert into public.members (user_id, couple_id, slot) values (auth.uid(), c.id, 'me');
  return json_build_object('couple_id', c.id, 'invite_code', c.invite_code, 'slot', 'me');
end $$;

create or replace function public.join_couple(code text)
returns json language plpgsql security definer set search_path = public as $$
declare c public.couples;
begin
  if auth.uid() is null then raise exception 'not_logged_in'; end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then raise exception 'already_member'; end if;
  select * into c from public.couples where invite_code = upper(trim(code)) for update;
  if not found then raise exception 'invalid_code'; end if;
  if (select count(*) from public.members where couple_id = c.id) >= 2 then raise exception 'couple_full'; end if;
  insert into public.members (user_id, couple_id, slot) values (auth.uid(), c.id, 'you');
  return json_build_object('couple_id', c.id, 'invite_code', c.invite_code, 'slot', 'you');
end $$;

revoke all on function public.create_couple() from public, anon;
revoke all on function public.join_couple(text) from public, anon;
grant execute on function public.create_couple() to authenticated;
grant execute on function public.join_couple(text) to authenticated;
revoke all on function public.my_couple() from public, anon;
grant execute on function public.my_couple() to authenticated;

-- 6) 실시간 반영 켜기
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'items') then
    alter publication supabase_realtime add table public.items;
  end if;
end $$;

-- 7) 사진 저장소 (비공개) + 내 커플 폴더만 접근
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 5242880, allowed_mime_types = array['image/jpeg'];

drop policy if exists photos_select on storage.objects;
drop policy if exists photos_insert on storage.objects;
drop policy if exists photos_update on storage.objects;
drop policy if exists photos_delete on storage.objects;
create policy photos_select on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = public.my_couple()::text);
create policy photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = public.my_couple()::text);
create policy photos_update on storage.objects for update to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = public.my_couple()::text);
create policy photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = public.my_couple()::text);
