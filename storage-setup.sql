-- Run AFTER creating the 'project-documents' bucket in Supabase Storage dashboard
-- Bucket must be set to PRIVATE (not public)

-- Allow authenticated users to read files from projects they're authorized on
-- Storage path format: {project_id}/{filename}
create policy "storage_select" on storage.objects for select
  using (
    bucket_id = 'project-documents'
    and (
      auth.email() = 'arpanmajmundar@gmail.com'
      or exists (
        select 1 from public.project_access pa
        where pa.project_id::text = split_part(name, '/', 1)
          and pa.email = auth.email()
      )
    )
  );

create policy "storage_insert" on storage.objects for insert
  with check (
    bucket_id = 'project-documents'
    and auth.email() = 'arpanmajmundar@gmail.com'
  );

create policy "storage_delete" on storage.objects for delete
  using (
    bucket_id = 'project-documents'
    and auth.email() = 'arpanmajmundar@gmail.com'
  );
