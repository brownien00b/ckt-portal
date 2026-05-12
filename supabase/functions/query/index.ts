import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

const SYSTEM_PROMPT =
  'You are a precise document assistant. Answer using ONLY the provided documents. ' +
  'Write in clean, natural prose — no bullet separators, no ASCII lines, no markdown headers. ' +
  'Cite sources inline using ONLY this exact format: [CITE:filename.pdf:3] ' +
  'where 3 is the page number as a plain integer. No word \'page\', no spaces. ' +
  'Example: The operating voltage is 24V [CITE:132607.pdf:3]. ' +
  'After your answer, add a blank line then write \'Sources:\' followed by each cited source ' +
  'on its own line as: [CITE:filename.pdf:3] — one sentence verbatim excerpt. ' +
  'If the answer is not in the documents, say so clearly.';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  const authHeader = req.headers.get('Authorization') ?? '';

  // Verify caller is authenticated and authorized for this project
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  const { query, project_id } = await req.json() as { query: string; project_id: string };
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!query?.trim() || !project_id || !UUID_RE.test(project_id)) {
    return new Response(JSON.stringify({ error: 'Missing or invalid query/project_id' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  // Verify user has access to this project (RLS via user client)
  const { data: projectCheck, error: projectError } = await userClient
    .from('projects')
    .select('id')
    .eq('id', project_id)
    .single();
  if (projectError || !projectCheck) {
    return new Response(JSON.stringify({ error: 'Project not found or access denied' }),
      { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  const VOYAGE_API_KEY   = Deno.env.get('VOYAGE_API_KEY')!;
  const CEREBRAS_API_KEY = Deno.env.get('CEREBRAS_API_KEY')!;
  const TOP_K = 8;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Run vector search and keyword search in parallel
  const keywords = query.toLowerCase().match(/\b[a-z0-9_\-]{3,}\b/g) ?? [];

  const [embedRes, keywordRes] = await Promise.all([
    // Vector search
    fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${VOYAGE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: [query], model: 'voyage-3-lite', input_type: 'query' }),
    }),
    // Keyword search: match any keyword against content or filename
    keywords.length
      ? supabase.rpc('keyword_search_chunks', {
          project_id_filter: project_id,
          keywords,
          match_count: TOP_K,
        })
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (!embedRes.ok) {
    return new Response(JSON.stringify({ error: 'Embedding failed' }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
  const embedData = await embedRes.json();
  const queryVec  = embedData.data[0].embedding;

  const { data: vectorChunks, error: searchError } = await supabase.rpc('match_chunks', {
    query_embedding: queryVec,
    project_id_filter: project_id,
    match_count: TOP_K,
  });

  if (searchError) {
    return new Response(JSON.stringify({ error: 'Search failed: ' + searchError.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  // Merge vector + keyword results, deduplicate by id, vector results first
  const keywordChunks = (keywordRes as { data: unknown[] | null }).data ?? [];
  const seen = new Set<string>();
  const chunks: Array<{ id: string; filename: string; page_num: number; content: string; similarity: number }> = [];
  for (const c of [...(vectorChunks ?? []), ...keywordChunks]) {
    const chunk = c as { id: string; filename: string; page_num: number; content: string; similarity: number };
    if (!seen.has(chunk.id)) { seen.add(chunk.id); chunks.push(chunk); }
  }

  if (!chunks.length) {
    return new Response(
      JSON.stringify({ answer: 'No relevant content was found in the indexed documents for this project. Try uploading and indexing PDFs in the admin panel.', provider: 'none', model: 'none' }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }

  // Build context — strip [DocTitle] prefix from content (used for embedding, confuses LLM)
  const context = chunks
    .map((c: { filename: string; page_num: number; content: string }) => {
      const clean = c.content.replace(/^\[[^\]]+\]\s*/, '');
      return `[${c.filename} — Page ${c.page_num}]\n${clean}`;
    })
    .join('\n\n');

  // LLM_PROVIDER=anthropic to use Claude Haiku; default is Cerebras
  const provider = Deno.env.get('LLM_PROVIDER') ?? 'cerebras';
  let answer: string;

  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Documents:\n${context}\n\nQuestion: ${query}` }],
      }),
    });
    if (!res.ok) {
      return new Response(JSON.stringify({ error: 'LLM error: ' + await res.text() }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    answer = (await res.json()).content[0].text;
  } else {
    const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CEREBRAS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-oss-120b',
        max_tokens: 1024,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Documents:\n${context}\n\nQuestion: ${query}` },
        ],
      }),
    });
    if (!res.ok) {
      return new Response(JSON.stringify({ error: 'LLM error: ' + await res.text() }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    answer = (await res.json()).choices[0].message.content;
  }

  return new Response(
    JSON.stringify({ answer, provider, model: provider === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'gpt-oss-120b' }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } }
  );
});
