import { db, requireAuth, ADMIN_EMAIL } from '/js/supabase-client.js';

async function init() {
  const session = await requireAuth();
  if (!session) return;

  _isAdmin = session.user.email === ADMIN_EMAIL;
  if (_isAdmin) {
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

  _milestoneData = project.milestone_data || {};
  _projectNotes  = project.notes || '';

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
    <div class="project-header-row">
      <div class="title-block">
        <h1>${escHtml(project.name)}</h1>
        <div class="title-meta">
          <p class="client-name">${escHtml(project.client_name || '')}</p>
          <span class="status-badge status-${safeStatus}">${escHtml(project.status)}</span>
        </div>
      </div>
      <div class="milestone-tracker" id="milestone-tracker"></div>
    </div>

    ${(_projectNotes || _isAdmin) ? `
    <div class="project-notes-bar" id="project-notes-bar">
      <div class="project-notes-body">
        ${_projectNotes
          ? `<span class="project-notes-icon">📋</span><span class="project-notes-text">${escHtml(_projectNotes)}</span>`
          : `<span class="project-notes-text text-muted">No status note yet.</span>`}
      </div>
      ${_isAdmin ? `<button class="btn-notes-edit" onclick="editNotes()">Edit</button>` : ''}
    </div>` : ''}

    ${_isAdmin ? `
    <div id="milestone-modal" class="milestone-modal" style="display:none" onclick="if(event.target===this)closeMilestoneEdit()">
      <div class="milestone-modal-box">
        <div class="milestone-modal-title" id="milestone-modal-title">Edit Milestone</div>
        <label class="form-label">Date</label>
        <input type="date" id="milestone-modal-date" class="form-input">
        <label class="form-label" style="margin-top:8px">Note</label>
        <input type="text" id="milestone-modal-note" class="form-input" placeholder="Optional note…" maxlength="120">
        <div class="milestone-modal-actions">
          <button class="btn btn-primary" style="font-size:13px;padding:7px 16px" onclick="saveMilestoneStep()">Save</button>
          <button class="btn" style="font-size:13px;padding:7px 16px" onclick="closeMilestoneEdit()">Cancel</button>
        </div>
      </div>
    </div>` : ''}

    <div class="project-lower" id="project-lower">
      <div class="documents-section" id="docs-sidebar">
        <div class="sidebar-header">
          <span class="sidebar-brand">Project Files</span>
          <button class="btn-sidebar-toggle" id="sidebar-toggle"
                  onclick="toggleDocsSidebar()" title="Hide sidebar">✕</button>
        </div>

        <div class="sidebar-section open" id="section-docs">
          <div class="sidebar-section-header" onclick="toggleSidebarSection('section-docs')">
            <span class="sidebar-section-label">Documents</span>
            <span class="sidebar-section-chevron">▾</span>
          </div>
          <div class="sidebar-section-body">
            <div class="documents-grid" id="documents-grid"></div>
          </div>
        </div>

        <div class="sidebar-section" id="section-history" style="display:none">
          <div class="sidebar-section-header" onclick="toggleSidebarSection('section-history')">
            <span class="sidebar-section-label">Past Questions</span>
            <span class="sidebar-history-count" id="sidebar-history-count"></span>
            <span class="sidebar-section-chevron">▾</span>
          </div>
          <div class="sidebar-section-body">
            <div id="rag-history-list"></div>
          </div>
        </div>
      </div>
      <div id="rag-mount" class="rag-mount-col"></div>
    </div>
  `;

  renderMilestones(project.milestone_labels, project.current_milestone);
  renderDocuments(project.project_documents, ragFilenames, project.id);
  mountRag(project.id);
}

window.toggleDocsSidebar = function() {
  const sidebar = document.getElementById('docs-sidebar');
  const btn     = document.getElementById('sidebar-toggle');
  if (!sidebar) return;
  const collapsed = sidebar.classList.toggle('collapsed');
  btn.textContent = collapsed ? '☰' : '✕';
  btn.title       = collapsed ? 'Show sidebar' : 'Hide sidebar';
};

window.toggleSidebarSection = function(id) {
  document.getElementById(id)?.classList.toggle('open');
};

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
    const md   = _milestoneData[i] || {};
    const dateLine = md.date
      ? `<div class="milestone-date">${escHtml(md.date)}</div>` : '';
    const noteLine = md.note
      ? `<div class="milestone-note-text">${escHtml(md.note)}</div>` : '';
    const clickAttr = _isAdmin ? `onclick="openMilestoneEdit(${i})" title="Edit milestone"` : '';
    return `
      ${i > 0 ? `<div class="milestone-connector ${step <= current ? 'done' : ''}"></div>` : ''}
      <div class="milestone-step ${cls}${_isAdmin ? ' editable' : ''}" ${clickAttr}>
        <div class="milestone-dot">${dot}</div>
        <div class="milestone-label">${escHtml(label)}</div>
        ${dateLine}${noteLine}
      </div>
    `;
  });
  el.innerHTML = items.join('');
}

async function renderDocuments(docs, ragFilenames, projectId) {
  const el = document.getElementById('documents-grid');

  // Build RAG PDF cards — clickable to open inline PDF viewer
  const ragCards = ragFilenames.map(filename => {
    const label    = filename.replace(/\.pdf$/i, '');
    const safeName = escHtml(filename);
    return `<div class="doc-card doc-pdf-card" onclick="openPdf('${safeName}', 1)" title="Open ${escHtml(label)}">
               <span class="doc-icon">📄</span>
               <span class="doc-label">${escHtml(label)}</span>
             </div>`;
  });

  // Drive URL doc cards
  const sorted = [...(docs || [])].sort((a, b) => a.display_order - b.display_order);
  const driveCards = sorted.map(doc => {
    if (doc.drive_url && isSafeUrl(doc.drive_url)) {
      return `
        <div class="doc-card">
          <span class="doc-icon">🔗</span>
          <span class="doc-label">${escHtml(doc.label)}</span>
          <a class="btn-download" href="${escHtml(doc.drive_url)}"
             target="_blank" rel="noopener noreferrer">Open</a>
        </div>`;
    }
    return `
      <div class="doc-card coming-soon">
        <span class="doc-icon">📄</span>
        <span class="doc-label">${escHtml(doc.label)}</span>
        <span class="coming-soon-label">Coming Soon</span>
      </div>`;
  });

  const all = [...ragCards.filter(Boolean), ...driveCards];
  el.innerHTML = all.length ? all.join('') : '<p class="text-muted">No documents added yet.</p>';
}

// ── RAG Section ───────────────────────────────────────────────

let _projectDbId = null;
let _isAdmin = false;
let _milestoneData = {};
let _milestoneEditIdx = -1;
let _projectNotes = '';
let _historyItems = [];
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
  loadHistory(projectId);

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
    // Save to history
    const item = { question: q, answer: data.answer, created_at: new Date().toISOString() };
    db.from('project_conversations').insert({
      project_id: _projectDbId,
      user_id: session.user.id,
      question: q,
      answer: data.answer,
    }).then(({ error: he }) => { if (!he) prependHistory(item); });
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
  ragMain.style.width   = '30%';
  panel.style.width     = '70%';
  // Auto-collapse docs sidebar to give PDF max room
  const sidebar = document.getElementById('docs-sidebar');
  const sideBtn = document.getElementById('sidebar-toggle');
  if (sidebar && !sidebar.classList.contains('collapsed')) {
    sidebar.classList.add('collapsed');
    if (sideBtn) { sideBtn.textContent = '☰'; sideBtn.title = 'Show sidebar'; }
  }

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
    await renderAllPages(page);
    return;
  }
  scrollToPage(page);
};

async function renderAllPages(targetPage) {
  if (!pdfDoc) return;
  const container = document.getElementById('pdf-pages');
  container.innerHTML = '';
  pageTextDivs = {};
  const wrap   = document.getElementById('pdf-canvas-wrap');
  const availW = wrap.clientWidth - 32;

  // Use page 1 dimensions to pre-create all placeholder wrappers so scroll
  // positions are correct before any page renders
  const page1     = await pdfDoc.getPage(1);
  const base1     = Math.min(availW / page1.getViewport({ scale: 1 }).width, 2.0);
  const vp1       = page1.getViewport({ scale: base1 * userZoom });
  for (let n = 1; n <= totalPages; n++) {
    const ph = document.createElement('div');
    ph.className = 'pdf-page-wrap pdf-page-placeholder';
    ph.id = `pdf-page-${n}`;
    ph.style.width  = vp1.width + 'px';
    ph.style.height = vp1.height + 'px';
    container.appendChild(ph);
  }

  const renderPage = async (n) => {
    const pageObj   = await pdfDoc.getPage(n);
    const baseScale = Math.min(availW / pageObj.getViewport({ scale: 1 }).width, 2.0);
    const viewport  = pageObj.getViewport({ scale: baseScale * userZoom });

    const wrapper = document.getElementById(`pdf-page-${n}`);
    if (!wrapper) return;
    wrapper.classList.remove('pdf-page-placeholder');
    wrapper.innerHTML = '';
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
  };

  const target = Math.max(1, Math.min(targetPage || 1, totalPages));

  // Render target page first, scroll immediately — no page 1 flash
  await renderPage(target);
  scrollToPage(target);

  // Fill in all other pages lazily without blocking
  (async () => {
    for (let n = 1; n <= totalPages; n++) {
      if (n !== target) await renderPage(n);
    }
  })();
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
  // Restore docs sidebar
  const sidebar = document.getElementById('docs-sidebar');
  const sideBtn = document.getElementById('sidebar-toggle');
  if (sidebar && sidebar.classList.contains('collapsed')) {
    sidebar.classList.remove('collapsed');
    if (sideBtn) { sideBtn.textContent = '✕'; sideBtn.title = 'Hide sidebar'; }
  }
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

// ── Project notes ─────────────────────────────────────────────

window.editNotes = function() {
  const bar = document.getElementById('project-notes-bar');
  if (!bar) return;
  bar.innerHTML = `
    <textarea class="notes-edit-textarea" id="notes-edit-input"
      placeholder="Add a status update for the client…" maxlength="500">${escHtml(_projectNotes)}</textarea>
    <div class="notes-edit-actions">
      <button class="btn btn-primary" style="font-size:13px;padding:7px 16px" onclick="saveNotes()">Save</button>
      <button class="btn" style="font-size:13px;padding:7px 16px" onclick="cancelNotes()">Cancel</button>
    </div>`;
  document.getElementById('notes-edit-input').focus();
};

window.saveNotes = async function() {
  const val = document.getElementById('notes-edit-input').value.trim();
  const { error } = await db.from('projects').update({ notes: val || null }).eq('id', _projectDbId);
  if (error) { alert('Save failed: ' + error.message); return; }
  _projectNotes = val;
  renderNotesBar();
};

window.cancelNotes = function() { renderNotesBar(); };

function renderNotesBar() {
  const bar = document.getElementById('project-notes-bar');
  if (!bar) return;
  bar.innerHTML = `
    <div class="project-notes-body">
      ${_projectNotes
        ? `<span class="project-notes-icon">📋</span><span class="project-notes-text">${escHtml(_projectNotes)}</span>`
        : `<span class="project-notes-text text-muted">No status note yet.</span>`}
    </div>
    <button class="btn-notes-edit" onclick="editNotes()">Edit</button>`;
}

// ── Milestone editing ──────────────────────────────────────────

window.openMilestoneEdit = function(idx) {
  _milestoneEditIdx = idx;
  const labels = document.querySelectorAll('.milestone-step');
  const label  = labels[idx]?.querySelector('.milestone-label')?.textContent || `Milestone ${idx + 1}`;
  const md     = _milestoneData[idx] || {};
  document.getElementById('milestone-modal-title').textContent = `Edit: ${label}`;
  document.getElementById('milestone-modal-date').value = md.date || '';
  document.getElementById('milestone-modal-note').value = md.note || '';
  document.getElementById('milestone-modal').style.display = 'flex';
  document.getElementById('milestone-modal-date').focus();
};

window.closeMilestoneEdit = function() {
  document.getElementById('milestone-modal').style.display = 'none';
  _milestoneEditIdx = -1;
};

window.saveMilestoneStep = async function() {
  if (_milestoneEditIdx < 0) return;
  const date = document.getElementById('milestone-modal-date').value;
  const note = document.getElementById('milestone-modal-note').value.trim();
  _milestoneData[_milestoneEditIdx] = date || note ? { date, note } : undefined;
  if (!_milestoneData[_milestoneEditIdx]) delete _milestoneData[_milestoneEditIdx];
  const { error } = await db.from('projects')
    .update({ milestone_data: _milestoneData })
    .eq('id', _projectDbId);
  if (error) { alert('Save failed: ' + error.message); return; }
  closeMilestoneEdit();
  const { data: project } = await db.from('projects')
    .select('milestone_labels, current_milestone')
    .eq('id', _projectDbId).single();
  if (project) renderMilestones(project.milestone_labels, project.current_milestone);
};

// ── Q&A History ───────────────────────────────────────────────


async function loadHistory(projectId) {
  const { data } = await db
    .from('project_conversations')
    .select('id, question, answer, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(30);
  if (!data || !data.length) return;
  _historyItems = data;
  renderHistoryList();
  showHistorySection();
}

function prependHistory(item) {
  _historyItems.unshift(item);
  renderHistoryList();
  showHistorySection();
}

function renderHistoryList() {
  const listEl  = document.getElementById('rag-history-list');
  const countEl = document.getElementById('sidebar-history-count');
  if (!listEl) return;
  if (countEl) countEl.textContent = _historyItems.length ? `(${_historyItems.length})` : '';
  listEl.innerHTML = _historyItems.map((item, idx) => {
    const d   = new Date(item.created_at);
    const ts  = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric',
                  hour: 'numeric', minute: '2-digit' });
    const q   = item.question.length > 90 ? item.question.slice(0, 90) + '…' : item.question;
    return `<div class="history-item" onclick="restoreHistoryItem(${idx})">
      <div class="history-item-q">${escHtml(q)}</div>
      <div class="history-item-ts">${escHtml(ts)}</div>
    </div>`;
  }).join('');
}

function showHistorySection() {
  const sec = document.getElementById('section-history');
  if (!sec) return;
  sec.style.display = '';
  sec.classList.add('open');
}

window.restoreHistoryItem = function(idx) {
  const item = _historyItems[idx];
  if (!item) return;
  document.getElementById('rag-query').value = item.question;
  renderAnswer(item.answer);
};

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
