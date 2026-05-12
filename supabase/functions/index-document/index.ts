import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

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

  const { project_id, filename } = await req.json() as {
    project_id: string;
    filename:   string;
  };

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!project_id || !UUID_RE.test(project_id) || !filename) {
    return new Response(JSON.stringify({ error: 'Missing or invalid fields' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  const EXTRACT_URL = Deno.env.get('EXTRACT_SERVICE_URL');
  const EXTRACT_KEY = Deno.env.get('EXTRACT_API_KEY') ?? '';

  // Get signed URL for the PDF in storage
  const { data: signedData, error: signedError } = await supabase.storage
    .from('project-documents')
    .createSignedUrl(`${project_id}/${filename}`, 300);
  if (signedError || !signedData?.signedUrl) {
    return new Response(JSON.stringify({ error: 'Could not create signed URL: ' + signedError?.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  let chunks: Array<{ page_num: number; content: string }>;

  if (EXTRACT_URL) {
    // Use Railway PyMuPDF extraction service
    const extractRes = await fetch(`${EXTRACT_URL}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': EXTRACT_KEY },
      body: JSON.stringify({ url: signedData.signedUrl }),
    });
    if (!extractRes.ok) {
      return new Response(JSON.stringify({ error: 'Extraction service error: ' + await extractRes.text() }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    chunks = (await extractRes.json()).chunks;
  } else {
    return new Response(JSON.stringify({ error: 'EXTRACT_SERVICE_URL not configured' }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  if (!chunks?.length) {
    return new Response(JSON.stringify({ error: 'No text extracted from PDF' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  // Auto-name via Cerebras (non-fatal)
  let suggested_name: string | null = null;
  try {
    const sample  = chunks.slice(0, 3).map(c => c.content).join('\n').slice(0, 800);
    const nameRes = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${Deno.env.get('CEREBRAS_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-oss-120b', max_tokens: 20,
        messages: [
          { role: 'system', content: 'Generate a short document title. Respond with ONLY 2-6 words, no punctuation.' },
          { role: 'user',   content: `Document:\n${sample}\n\nTitle:` },
        ],
      }),
    });
    if (nameRes.ok) suggested_name = (await nameRes.json()).choices?.[0]?.message?.content?.trim() || null;
  } catch { /* non-fatal */ }

  const VOYAGE_API_KEY = Deno.env.get('VOYAGE_API_KEY')!;
  const BATCH_SIZE = 100;

  // Embed clean page text — no title prefix so each page's semantic content is distinct
  const allEmbeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const res   = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${VOYAGE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: batch.map(c => c.content), model: 'voyage-3-lite', input_type: 'document' }),
    });
    if (!res.ok) {
      return new Response(JSON.stringify({ error: 'Voyage API error: ' + await res.text() }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    allEmbeddings.push(...(await res.json()).data.map((d: { embedding: number[] }) => d.embedding));
  }

  // Delete existing chunks
  await supabase.from('document_chunks').delete()
    .eq('project_id', project_id).eq('filename', filename);

  // Insert new chunks (store clean content without title prefix for LLM context)
  const rows = chunks.map((c, i) => ({
    project_id,
    filename,
    page_num:  c.page_num,
    content:   c.content,
    embedding: allEmbeddings[i],
  }));

  const { error: insertError } = await supabase.from('document_chunks').insert(rows);
  if (insertError) {
    return new Response(JSON.stringify({ error: insertError.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  return new Response(
    JSON.stringify({ ok: true, chunks_indexed: rows.length, suggested_name }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } }
  );
});
