import { db, requireAuth, ADMIN_EMAIL } from '/js/supabase-client.js';

async function init() {
  const session = await requireAuth();
  if (!session) return;

  if (session.user.email === ADMIN_EMAIL) {
    document.getElementById('admin-nav').style.removeProperty('display');
  }

  const params = new URLSearchParams(window.location.search);
  const projectId = params.get('id');
  if (!projectId) { showError('No project ID specified in URL.'); return; }

  const { data: project, error } = await db
    .from('projects')
    .select('*, project_documents(*)')
    .eq('project_number', projectId)
    .single();

  if (error || !project) {
    showError('Project not found or you do not have access.');
    return;
  }

  // Fetch unique PDF filenames from document_chunks for this project
  const { data: chunks } = await db
    .from('document_chunks')
    .select('filename')
    .eq('project_id', project.id);

  const ragFilenames = [...new Set((chunks || []).map(c => c.filename))].sort();

  document.title = `${project.name} — CKT Group`;
  document.getElementById('project-number').textContent = project.project_number;
  renderProject(project, ragFilenames);
}

function renderProject(project, ragFilenames = []) {
  const VALID_STATUSES = ['active', 'complete', 'pending'];
  const safeStatus = VALID_STATUSES.includes(project.status.toLowerCase())
    ? project.status.toLowerCase()
    : 'pending';

  const content = document.getElementById('project-content');
  content.innerHTML = `
    <div class="title-block">
      <h1>${escHtml(project.name)}</h1>
      <p class="client-name">${escHtml(project.client_name || '')}</p>
      <span class="status-badge status-${safeStatus}">${escHtml(project.status)}</span>
    </div>

    <div class="milestone-section">
      <div class="section-title">Project Milestones</div>
      <div class="milestone-tracker" id="milestone-tracker"></div>
    </div>

    <div class="documents-section">
      <div class="section-title">Documents</div>
      <div class="documents-grid" id="documents-grid"></div>
    </div>

    <div id="rag-mount"></div>
  `;

  renderMilestones(project.milestone_labels, project.current_milestone);
  renderDocuments(project.project_documents, ragFilenames, project.id);
  mountRag(project.id);
}

function renderMilestones(labels, current) {
  const el = document.getElementById('milestone-tracker');
  if (!labels || !labels.length) {
    el.innerHTML = '<p class="text-muted">No milestones defined.</p>';
    return;
  }
  const items = labels.map((label, i) => {
    const step = i + 1;
    const cls  = step < current ? 'done' : step === current ? 'active' : 'pending';
    const dot  = step < current ? '✓' : String(step);
    return `
      ${i > 0 ? `<div class="milestone-connector ${step <= current ? 'done' : ''}"></div>` : ''}
      <div class="milestone-step ${cls}">
        <div class="milestone-dot">${dot}</div>
        <div class="milestone-label">${escHtml(label)}</div>
      </div>
    `;
  });
  el.innerHTML = items.join('');
}

async function renderDocuments(docs, ragFilenames, projectId) {
  const el = document.getElementById('documents-grid');

  // Build RAG PDF cards with signed download URLs
  const ragCards = await Promise.all(ragFilenames.map(async filename => {
    try {
      const { data } = await db.storage
        .from('project-documents')
        .createSignedUrl(`${projectId}/${filename}`, 3600);
      const url = data?.signedUrl;
      const label = filename.replace(/\.pdf$/i, '');
      return url
        ? `<div class="doc-card">
             <span class="doc-label">${escHtml(label)}</span>
             <a class="btn-download" href="${escHtml(url)}" target="_blank" rel="noopener noreferrer">Download</a>
           </div>`
        : '';
    } catch { return ''; }
  }));

  // Drive URL doc cards (non-PDF files)
  const sorted = [...(docs || [])].sort((a, b) => a.display_order - b.display_order);
  const driveCards = sorted.map(doc => {
    if (doc.drive_url && isSafeUrl(doc.drive_url)) {
      return `
        <div class="doc-card">
          <span class="doc-label">${escHtml(doc.label)}</span>
          <a class="btn-download" href="${escHtml(doc.drive_url)}"
             target="_blank" rel="noopener noreferrer">Download</a>
        </div>`;
    }
    return `
      <div class="doc-card coming-soon">
        <span class="doc-label">${escHtml(doc.label)}</span>
        <span class="coming-soon-label">Coming Soon</span>
      </div>`;
  });

  const all = [...ragCards.filter(Boolean), ...driveCards];
  el.innerHTML = all.length ? all.join('') : '<p class="text-muted">No documents added yet.</p>';
}

// ── RAG Section ───────────────────────────────────────────────

let _projectDbId = null; // set when project renders
let pdfDoc = null, totalPages = 0, currentFile = null;
let userZoom = 1.0;
let pageTextContent = {}, pageTextDivs = {};
let findMatches = [], findCurrent = -1;

function mountRag(projectId) {
  _projectDbId = projectId;
  const mount = document.getElementById('rag-mount');
  mount.innerHTML = `
    <div class="rag-section">
      <div class="section-title">Document Search</div>
      <div class="rag-workspace" id="rag-workspace">
        <div class="rag-main" id="rag-main">
          <div class="rag-search-area">
            <div class="rag-search-box">
              <input class="rag-input" id="rag-query" type="text"
                     placeholder="Ask anything about this project's documents…">
              <button class="btn btn-primary" id="rag-submit" onclick="ragSubmit()"
                      style="padding:10px 18px;font-size:14px">Ask</button>
            </div>
          </div>
          <div class="rag-answer-area" id="rag-answer"></div>
        </div>
        <div class="resize-handle" id="rag-resize"></div>
        <div class="pdf-panel" id="pdf-panel">
          <div class="pdf-toolbar">
            <span class="pdf-title" id="pdf-title">—</span>
            <div class="pdf-controls">
              <span class="pdf-page-info" id="pdf-page-info"></span>
              <button onclick="changeZoom(-0.25)">−</button>
              <button onclick="changeZoom(0.25)">+</button>
              <button onclick="resetZoom()" id="zoom-label" style="min-width:46px;font-size:12px">100%</button>
              <button onclick="openFind()" style="font-size:12px;padding:4px 9px">⌕</button>
            </div>
            <button class="close-pdf" onclick="closePdf()">✕</button>
          </div>
          <div class="pdf-find-bar" id="pdf-find-bar">
            <input class="pdf-find-input" id="pdf-find-input" type="text"
                   placeholder="Find in document…"
                   oninput="pdfFindRun()"
                   onkeydown="pdfFindKey(event)">
            <span class="pdf-find-count" id="pdf-find-count"></span>
            <button class="pdf-find-btn" onclick="pdfFindPrev()">↑</button>
            <button class="pdf-find-btn" onclick="pdfFindNext()">↓</button>
            <button class="pdf-find-close" onclick="closeFind()">✕</button>
          </div>
          <div class="pdf-canvas-wrap" id="pdf-canvas-wrap">
            <div id="pdf-pages"></div>
          </div>
        </div>
      </div>
    </div>`;

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  initResizeHandle();
  initPdfPan();

  document.getElementById('rag-query').addEventListener('keydown', e => {
    if (e.key === 'Enter') ragSubmit();
  });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f' &&
        document.getElementById('pdf-panel').classList.contains('open')) {
      e.preventDefault(); openFind();
    }
  });
}

window.ragSubmit = async function() {
  const q    = document.getElementById('rag-query').value.trim();
  const area = document.getElementById('rag-answer');
  if (!q) return;
  area.innerHTML = '<div class="rag-status"><div class="spinner"></div> Searching documents…</div>';
  document.getElementById('rag-submit').disabled = true;

  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) {
      area.innerHTML = '<div class="error-msg">Session expired — please <a href="/login.html">sign in again</a>.</div>';
      document.getElementById('rag-submit').disabled = false;
      return;
    }
    const res = await fetch(
      'https://sgtryrxsgbilbprrqtxw.supabase.co/functions/v1/query',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ query: q, project_id: _projectDbId }),
      }
    );
    document.getElementById('rag-submit').disabled = false;
    const data = await res.json();
    if (data.error) {
      area.innerHTML = `<div class="error-msg">${escHtml(data.error)}</div>`;
      return;
    }
    renderAnswer(data.answer);
  } catch (e) {
    document.getElementById('rag-submit').disabled = false;
    area.innerHTML = '<div class="error-msg">Request failed.</div>';
  }
};

function renderAnswer(raw) {
  const sourcesIdx = raw.search(/\nSources:/i);
  const mainText   = sourcesIdx >= 0 ? raw.slice(0, sourcesIdx).trim() : raw.trim();
  const sourcesText= sourcesIdx >= 0 ? raw.slice(sourcesIdx).trim() : '';

  const citeMap = {};
  let citeIdx = 0;
  function stashCites(text) {
    return text.replace(/\[CITE:([^\]:]+):(?:page\s*)?(\d+)\]/gi, (_, file, page) => {
      const key = `%%CITE${citeIdx++}%%`;
      const safeFile = escHtml(file.trim());
      const safePage = parseInt(page) || 1;
      citeMap[key] = `<a class="cite-link" onclick="openPdf('${safeFile}', ${safePage})"
                        title="${safeFile}, p.${safePage}">[${safeFile.replace('.pdf','')}, p.${safePage}]</a>`;
      return key;
    });
  }
  function restoreCites(html) {
    return html.replace(/%%CITE\d+%%/g, k => citeMap[k] || k);
  }

  const stashed  = stashCites(mainText);
  const bodyHtml = restoreCites(marked.parse(stashed));

  let sourcesHtml = '';
  if (sourcesText) {
    const items = sourcesText.replace(/^Sources:/i, '').trim()
      .split('\n').filter(Boolean)
      .map(l => `<div class="source-item">${restoreCites(stashCites(l.trim()))}</div>`).join('');
    sourcesHtml = `<div class="sources-section"><div class="sources-label">Sources</div>${items}</div>`;
  }

  document.getElementById('rag-answer').innerHTML =
    `<div class="rag-answer-block"><div class="rag-answer-body">${bodyHtml}</div>${sourcesHtml}</div>`;
}

// ── PDF viewer ────────────────────────────────────────────────

window.openPdf = async function(filename, page) {
  page = parseInt(page) || 1;
  const panel      = document.getElementById('pdf-panel');
  const resizeH    = document.getElementById('rag-resize');
  const ragMain    = document.getElementById('rag-main');
  panel.classList.add('open');
  resizeH.style.display = 'block';
  ragMain.style.flex    = 'none';
  ragMain.style.width   = '40%';
  panel.style.width     = '60%';

  if (currentFile !== filename) {
    currentFile = filename;
    pdfDoc = null;
    userZoom = 1.0;
    updateZoomLabel();
    pageTextContent = {}; pageTextDivs = {};
    findMatches = []; findCurrent = -1; updateFindCount();
    document.getElementById('pdf-title').textContent = filename;
    document.getElementById('pdf-pages').innerHTML = '';

    // Get signed URL from Supabase Storage
    const { data: { session } } = await db.auth.getSession();
    if (!session) {
      document.getElementById('pdf-pages').innerHTML =
        '<p style="color:var(--red);padding:20px">Session expired — please reload and sign in.</p>';
      return;
    }
    const storagePath = `${_projectDbId}/${filename}`;
    const { data, error } = await db.storage
      .from('project-documents')
      .createSignedUrl(storagePath, 3600);
    if (error) {
      document.getElementById('pdf-pages').innerHTML =
        '<p style="color:var(--red);padding:20px">Could not load PDF.</p>';
      return;
    }

    pdfDoc = await pdfjsLib.getDocument(data.signedUrl).promise;
    totalPages = pdfDoc.numPages;
    document.getElementById('pdf-page-info').textContent = `${totalPages} pages`;
    await renderAllPages();
    scrollToPage(page);
    return;
  }
  scrollToPage(page);
};

async function renderAllPages() {
  if (!pdfDoc) return;
  const container = document.getElementById('pdf-pages');
  container.innerHTML = '';
  pageTextDivs = {};
  const wrap   = document.getElementById('pdf-canvas-wrap');
  const availW = wrap.clientWidth - 32;

  for (let n = 1; n <= totalPages; n++) {
    const pageObj   = await pdfDoc.getPage(n);
    const baseScale = Math.min(availW / pageObj.getViewport({ scale: 1 }).width, 2.0);
    const viewport  = pageObj.getViewport({ scale: baseScale * userZoom });

    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page-wrap';
    wrapper.id = `pdf-page-${n}`;
    wrapper.style.width  = viewport.width + 'px';
    wrapper.style.height = viewport.height + 'px';

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    wrapper.appendChild(canvas);

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'text-layer';
    textLayerDiv.style.width  = viewport.width + 'px';
    textLayerDiv.style.height = viewport.height + 'px';
    wrapper.appendChild(textLayerDiv);
    container.appendChild(wrapper);

    await pageObj.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    if (!pageTextContent[n]) {
      try { pageTextContent[n] = await pageObj.getTextContent(); } catch {}
    }
    if (pageTextContent[n]) {
      const divs = [];
      try {
        await pdfjsLib.renderTextLayer({
          textContent: pageTextContent[n],
          container: textLayerDiv,
          viewport,
          textDivs: divs,
        }).promise;
      } catch {}
      pageTextDivs[n] = divs;
    }
  }
}

function scrollToPage(num) {
  document.getElementById(`pdf-page-${num}`)?.scrollIntoView({ behavior: 'instant', block: 'start' });
}

window.changeZoom = async function(delta) {
  userZoom = Math.min(Math.max(userZoom + delta, 0.5), 4.0);
  updateZoomLabel();
  if (pdfDoc) {
    const wrap   = document.getElementById('pdf-canvas-wrap');
    const pages  = document.getElementById('pdf-pages');
    const ratio  = wrap.scrollTop / (wrap.scrollHeight || 1);
    pages.style.visibility = 'hidden';
    await renderAllPages();
    wrap.scrollTop = ratio * wrap.scrollHeight;
    pages.style.visibility = 'visible';
    const q = document.getElementById('pdf-find-input').value.trim();
    if (q) pdfFindRun();
  }
};
window.resetZoom = async function() { userZoom = 1.0; updateZoomLabel(); await window.changeZoom(0); };
function updateZoomLabel() {
  document.getElementById('zoom-label').textContent = Math.round(userZoom * 100) + '%';
}

window.closePdf = function() {
  closeFind();
  const panel = document.getElementById('pdf-panel');
  const resizeH = document.getElementById('rag-resize');
  const ragMain = document.getElementById('rag-main');
  panel.classList.remove('open');
  resizeH.style.display = 'none';
  ragMain.style.flex = '1';
  ragMain.style.width = 'auto';
  currentFile = null; pdfDoc = null;
  pageTextContent = {}; pageTextDivs = {};
  findMatches = []; findCurrent = -1;
  document.getElementById('pdf-pages').innerHTML = '';
};

// ── Find in PDF ───────────────────────────────────────────────

window.openFind = function() {
  document.getElementById('pdf-find-bar').classList.add('open');
  const inp = document.getElementById('pdf-find-input');
  inp.focus(); inp.select();
};
window.closeFind = function() {
  document.getElementById('pdf-find-bar').classList.remove('open');
  clearFindHighlights();
  findMatches = []; findCurrent = -1; updateFindCount();
};
window.pdfFindKey = function(e) {
  if (e.key === 'Escape') closeFind();
  if (e.key === 'Enter') e.shiftKey ? pdfFindPrev() : pdfFindNext();
};
window.pdfFindRun = function() {
  clearFindHighlights();
  findMatches = []; findCurrent = -1;
  const q = document.getElementById('pdf-find-input').value.trim().toLowerCase();
  if (!q || !pdfDoc) { updateFindCount(); return; }
  for (let n = 1; n <= totalPages; n++) {
    for (const div of (pageTextDivs[n] || [])) {
      if (div.textContent?.toLowerCase().includes(q)) {
        findMatches.push({ pageNum: n, div });
        div.classList.add('search-hit');
      }
    }
  }
  if (findMatches.length) { findCurrent = 0; activateFindMatch(0); }
  updateFindCount();
};
window.pdfFindNext = function() {
  if (!findMatches.length) return;
  findCurrent = (findCurrent + 1) % findMatches.length;
  activateFindMatch(findCurrent); updateFindCount();
};
window.pdfFindPrev = function() {
  if (!findMatches.length) return;
  findCurrent = (findCurrent - 1 + findMatches.length) % findMatches.length;
  activateFindMatch(findCurrent); updateFindCount();
};
function activateFindMatch(idx) {
  findMatches.forEach(m => m.div.classList.remove('search-current'));
  const m = findMatches[idx];
  if (!m) return;
  m.div.classList.add('search-current');
  scrollToPage(m.pageNum);
  requestAnimationFrame(() => m.div.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}
function clearFindHighlights() {
  findMatches.forEach(m => m.div.classList.remove('search-hit', 'search-current'));
}
function updateFindCount() {
  const el   = document.getElementById('pdf-find-count');
  const q    = document.getElementById('pdf-find-input').value.trim();
  if (!q)                    { el.textContent = ''; return; }
  if (!findMatches.length)   { el.textContent = 'No results'; el.style.color = 'var(--red)'; return; }
  el.textContent = `${findCurrent + 1} of ${findMatches.length}`;
  el.style.color = 'var(--muted)';
}

// ── Resize handle ─────────────────────────────────────────────

function initResizeHandle() {
  const handle  = document.getElementById('rag-resize');
  const ragMain = document.getElementById('rag-main');
  const panel   = document.getElementById('pdf-panel');
  let resizing  = false, startX = 0, startMain = 0, startPdf = 0;
  handle.addEventListener('mousedown', e => {
    resizing  = true;
    startX    = e.clientX;
    startMain = ragMain.getBoundingClientRect().width;
    startPdf  = panel.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.style.cursor      = 'col-resize';
    document.body.style.userSelect  = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!resizing) return;
    const dx = e.clientX - startX;
    ragMain.style.width = Math.max(200, startMain + dx) + 'px';
    panel.style.width   = Math.max(200, startPdf - dx) + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    handle.classList.remove('dragging');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
  });
}

// ── PDF pan ───────────────────────────────────────────────────

function initPdfPan() {
  const wrap = document.getElementById('pdf-canvas-wrap');
  if (!wrap) return;
  let panning = false, px = 0, py = 0, sl = 0, st = 0;
  wrap.addEventListener('mousedown', e => {
    panning = true; px = e.clientX; py = e.clientY;
    sl = wrap.scrollLeft; st = wrap.scrollTop;
    wrap.classList.add('panning');
  });
  document.addEventListener('mousemove', e => {
    if (!panning) return;
    wrap.scrollLeft = sl - (e.clientX - px);
    wrap.scrollTop  = st - (e.clientY - py);
  });
  document.addEventListener('mouseup', () => { panning = false; wrap.classList.remove('panning'); });
  wrap.addEventListener('wheel', e => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); window.changeZoom(e.deltaY < 0 ? 0.15 : -0.15); }
  }, { passive: false });
}

function showError(msg) {
  document.getElementById('project-content').innerHTML =
    `<div class="card" style="margin-top:40px">
       <p class="error-msg">${escHtml(msg)}</p>
     </div>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isSafeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch { return false; }
}

init();
