-- Enable pgvector
create extension if not exists vector;

-- Projects table
create table if not exists public.projects (
  id                uuid primary key default gen_random_uuid(),
  project_number    text not null unique,
  name              text not null,
  client_name       text,
  status            text not null default 'Pending',
  milestone_labels  text[] not null default '{}',
  current_milestone int not null default 1,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- Project documents table
create table if not exists public.project_documents (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  label         text not null,
  drive_url     text,
  display_order int default 0,
  created_at    timestamptz default now()
);

-- Project access table (controls which emails can see which projects)
create table if not exists public.project_access (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  email      text not null,
  created_at timestamptz default now(),
  unique(project_id, email)
);

-- Document chunks table (RAG vectors)
create table if not exists public.document_chunks (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  filename   text not null,
  page_num   int not null,
  content    text not null,
  embedding  vector(512),
  created_at timestamptz default now()
);

create index if not exists document_chunks_embedding_idx
  on public.document_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- Enable RLS on all tables
alter table public.projects enable row level security;
alter table public.project_documents enable row level security;
alter table public.project_access enable row level security;
alter table public.document_chunks enable row level security;

-- RLS: projects
drop policy if exists "projects_select" on public.projects;
create policy "projects_select" on public.projects for select
  using (
    auth.email() = 'arpanmajmundar@gmail.com'
    or exists (
      select 1 from public.project_access pa
      where pa.project_id = projects.id
        and pa.email = auth.email()
    )
  );

drop policy if exists "projects_insert" on public.projects;
create policy "projects_insert" on public.projects for insert
  with check (auth.email() = 'arpanmajmundar@gmail.com');

drop policy if exists "projects_update" on public.projects;
create policy "projects_update" on public.projects for update
  using (auth.email() = 'arpanmajmundar@gmail.com');

drop policy if exists "projects_delete" on public.projects;
create policy "projects_delete" on public.projects for delete
  using (auth.email() = 'arpanmajmundar@gmail.com');

-- RLS: project_documents
drop policy if exists "docs_select" on public.project_documents;
create policy "docs_select" on public.project_documents for select
  using (
    auth.email() = 'arpanmajmundar@gmail.com'
    or exists (
      select 1 from public.project_access pa
      where pa.project_id = project_documents.project_id
        and pa.email = auth.email()
    )
  );

drop policy if exists "docs_insert" on public.project_documents;
create policy "docs_insert" on public.project_documents for insert
  with check (auth.email() = 'arpanmajmundar@gmail.com');

drop policy if exists "docs_update" on public.project_documents;
create policy "docs_update" on public.project_documents for update
  using (auth.email() = 'arpanmajmundar@gmail.com');

drop policy if exists "docs_delete" on public.project_documents;
create policy "docs_delete" on public.project_documents for delete
  using (auth.email() = 'arpanmajmundar@gmail.com');

-- RLS: project_access (admin only)
drop policy if exists "access_all" on public.project_access;
create policy "access_all" on public.project_access for all
  using (auth.email() = 'arpanmajmundar@gmail.com')
  with check (auth.email() = 'arpanmajmundar@gmail.com');

-- RLS: document_chunks
drop policy if exists "chunks_select" on public.document_chunks;
create policy "chunks_select" on public.document_chunks for select
  using (
    auth.email() = 'arpanmajmundar@gmail.com'
    or exists (
      select 1 from public.project_access pa
      where pa.project_id = document_chunks.project_id
        and pa.email = auth.email()
    )
  );

drop policy if exists "chunks_insert" on public.document_chunks;
create policy "chunks_insert" on public.document_chunks for insert
  with check (auth.email() = 'arpanmajmundar@gmail.com');

drop policy if exists "chunks_delete" on public.document_chunks;
create policy "chunks_delete" on public.document_chunks for delete
  using (auth.email() = 'arpanmajmundar@gmail.com');

-- match_chunks function for vector similarity search
create or replace function match_chunks(
  query_embedding vector(512),
  project_id_filter uuid,
  match_count int default 12
)
returns table (
  id uuid,
  filename text,
  page_num int,
  content text,
  similarity float
)
language sql stable
as $$
  select
    id, filename, page_num, content,
    1 - (embedding <=> query_embedding) as similarity
  from document_chunks
  where project_id = project_id_filter
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- Keyword search: matches chunks where content OR filename contains any of the supplied keywords
create or replace function keyword_search_chunks(
  project_id_filter uuid,
  keywords text[],
  match_count int default 8
)
returns table (
  id uuid,
  filename text,
  page_num int,
  content text,
  similarity float
)
language sql stable
as $$
  select
    id, filename, page_num, content,
    0.5 as similarity   -- fixed score; vector results rank higher
  from document_chunks
  where project_id = project_id_filter
    and (
      exists (
        select 1 from unnest(keywords) k
        where lower(content)  ilike '%' || k || '%'
           or lower(filename) ilike '%' || k || '%'
      )
    )
  order by page_num
  limit match_count;
$$;
