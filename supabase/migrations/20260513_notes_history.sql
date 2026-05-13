-- Project status notes + milestone data
alter table projects add column if not exists notes text;
alter table projects add column if not exists milestone_data jsonb default '{}';

-- Q&A conversation history
create table if not exists project_conversations (
  id          uuid        primary key default gen_random_uuid(),
  project_id  uuid        not null references projects(id) on delete cascade,
  user_id     uuid        not null references auth.users(id),
  question    text        not null,
  answer      text        not null,
  created_at  timestamptz not null default now()
);

alter table project_conversations enable row level security;

create policy "conversations_select" on project_conversations
  for select using (auth.uid() = user_id);

create policy "conversations_insert" on project_conversations
  for insert with check (auth.uid() = user_id);
