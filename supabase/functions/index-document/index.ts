import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  // Auth check
  const authHeader = req.headers.get('Authorization') ?? '';
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Verify caller is the admin
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user || user.email !== 'arpanmajmundar@gmail.com') {
    return new Response(JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  const { project_id, filename, chunks } = await req.json() as {
    project_id: string;
    filename:   string;
    chunks:     Array<{ page_num: number; content: string }>;
  };

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!project_id || !UUID_RE.test(project_id) || !filename || !chunks?.length) {
    return new Response(JSON.stringify({ error: 'Missing or invalid fields' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  // Auto-generate a descriptive name FIRST (before embedding — avoids timeout)
  let suggested_name: string | null = null;
  try {
    const sample = chunks.slice(0, 3).map(c => c.content).join('\n').slice(0, 800);
    const nameRes = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('CEREBRAS_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-oss-120b',
        max_tokens: 20,
        messages: [
          { role: 'system', content: 'You generate short document titles. Respond with ONLY a title, 2-6 words, no punctuation, no explanation.' },
          { role: 'user', content: `Document content:\n${sample}\n\nTitle:` }
        ],
      }),
    });
    if (nameRes.ok) {
      const nameData = await nameRes.json();
      suggested_name = nameData.choices?.[0]?.message?.content?.trim() || null;
    }
  } catch { /* non-fatal */ }

  const VOYAGE_API_KEY = Deno.env.get('VOYAGE_API_KEY')!;
  const BATCH_SIZE = 100;

  // Embed in batches
  const allEmbeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch  = chunks.slice(i, i + BATCH_SIZE);
    const res    = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VOYAGE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input:      batch.map(c => c.content),
        model:      'voyage-3-lite',
        input_type: 'document',
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      return new Response(JSON.stringify({ error: 'Voyage API error: ' + err }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    const data = await res.json();
    allEmbeddings.push(...data.data.map((d: { embedding: number[] }) => d.embedding));
  }

  // Delete existing chunks for this file + project (re-index support)
  const { error: deleteError } = await supabase
    .from('document_chunks')
    .delete()
    .eq('project_id', project_id)
    .eq('filename', filename);
  if (deleteError) {
    return new Response(JSON.stringify({ error: 'Failed to clear existing chunks: ' + deleteError.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  // Insert new chunks
  const rows = chunks.map((c, i) => ({
    project_id,
    filename,
    page_num:  c.page_num,
    content:   c.content,
    embedding: allEmbeddings[i],
  }));

  const { error: insertError } = await supabase
    .from('document_chunks')
    .insert(rows);

  if (insertError) {
    return new Response(JSON.stringify({ error: insertError.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  return new Response(
    JSON.stringify({ ok: true, chunks_indexed: rows.length, suggested_name }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } }
  );
});
