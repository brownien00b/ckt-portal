create or replace function keyword_search_chunks(
  project_id_filter uuid,
  keywords text[],
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
    (
      select count(*)::float / array_length(keywords, 1)
      from unnest(keywords) k
      where lower(content)  ilike '%' || k || '%'
         or lower(filename) ilike '%' || k || '%'
    ) as similarity
  from document_chunks
  where project_id = project_id_filter
    and exists (
      select 1 from unnest(keywords) k
      where lower(content)  ilike '%' || k || '%'
         or lower(filename) ilike '%' || k || '%'
    )
  order by similarity desc, page_num asc
  limit match_count;
$$;
