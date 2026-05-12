import { db, requireAdmin } from '/js/supabase-client.js';

// Extract text from a PDF.js page in reading order (top→bottom, left→right)
// Matches PyMuPDF's page.get_text() output quality for complex layouts
function extractPageText(textContent, maxChars = 2000) {
  const items = textContent.items.filter(i => i.str?.trim());
  // Sort by Y descending (top of page first), then X ascending (left to right)
  items.sort((a, b) => {
    const ay = a.transform[5], by = b.transform[5];
    if (Math.abs(ay - by) > 3) return by - ay;
    return a.transform[4] - b.transform[4];
  });
  // Add newline when Y position changes significantly (new line of text)
  const parts = [];
  let lastY = null;
  for (const item of items) {
    const y = item.transform[5];
    if (lastY !== null && Math.abs(y - lastY) > 8) parts.push('\n');
    parts.push(item.str);
    lastY = y;
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

let _session = null;

async function init() {
  _session = await requireAdmin();
  if (!_session) return;

  document.getElementById('signout-btn').addEventListener('click', async () => {
    await db.auth.signOut({ scope: 'local' });
    window.location.href = '/login.html';
  });

  await loadProjectList();

  // Open edit modal if ?edit= param present
  const params = new URLSearchParams(window.location.search);
  const editId = params.get('edit');
  if (editId) openEditModal(editId);
}

// ── Project list ──────────────────────────────────────────────

async function loadProjectList() {
  const { data: projects, error } = await db
    .from('projects')
    .select('id, project_number, name, client_name, status')
    .order('created_at', { ascending: false });

  const el = document.getElementById('project-list');
  if (error || !projects || !projects.length) {
    el.innerHTML = '<p class="text-muted">No projects yet. Click "+ New Project" to add one.</p>';
    return;
  }

  const VALID_STATUSES = ['active', 'complete', 'pending'];

  el.innerHTML = `<div class="project-list">${projects.map(p => {
    const safeStatus = VALID_STATUSES.includes((p.status || '').toLowerCase())
      ? p.status.toLowerCase()
      : 'pending';
    return `
    <div class="project-row">
      <span class="project-row-number">${esc(p.project_number)}</span>
      <span class="project-row-name">${esc(p.name)}</span>
      <span class="project-row-client">${esc(p.client_name || '—')}</span>
      <span class="status-badge status-${safeStatus}">${esc(p.status)}</span>
      <div class="project-row-actions">
        <a href="/project.html?id=${encodeURIComponent(p.project_number)}"
           class="btn btn-secondary" style="font-size:12px;padding:6px 12px"
           target="_blank" rel="noopener noreferrer">View</a>
        <button class="btn btn-secondary" style="font-size:12px;padding:6px 12px"
                onclick="openEditModal('${esc(p.project_number)}')">Edit</button>
      </div>
    </div>`;
  }).join('')}</div>`;
}

// ── Modal open/close ──────────────────────────────────────────

window.openNewModal = function() {
  document.getElementById('modal-title').textContent = 'New Project';
  document.getElementById('edit-project-id').value = '';
  document.getElementById('f-number').value = '';
  document.getElementById('f-name').value = '';
  document.getElementById('f-client').value = '';
  document.getElementById('f-status').value = 'Pending';
  document.getElementById('f-current-milestone').value = '1';
  document.getElementById('delete-btn').style.display = 'none';
  document.getElementById('pdf-upload-area').classList.add('hidden');
  renderMilestoneList([]);
  renderDocumentList([]);
  renderEmailList([]);
  renderRagDocList([]);
  document.getElementById('project-modal').classList.add('open');
};

async function openEditModal(projectNumber) {
  const { data: project, error } = await db
    .from('projects')
    .select('*, project_documents(*), project_access(*)')
    .eq('project_number', projectNumber)
    .single();

  if (error || !project) { alert('Could not load project.'); return; }

  document.getElementById('modal-title').textContent = 'Edit Project';
  document.getElementById('edit-project-id').value = project.id;
  document.getElementById('f-number').value = project.project_number;
  document.getElementById('f-name').value = project.name;
  document.getElementById('f-client').value = project.client_name || '';
  document.getElementById('f-status').value = project.status;
  document.getElementById('f-current-milestone').value = project.current_milestone;
  document.getElementById('delete-btn').style.display = 'block';
  document.getElementById('pdf-upload-area').classList.remove('hidden');

  renderMilestoneList(project.milestone_labels || []);
  renderDocumentList(project.project_documents || []);
  renderEmailList((project.project_access || []).map(a => a.email));
  await loadRagDocs(project.id);

  document.getElementById('project-modal').classList.add('open');
}
window.openEditModal = openEditModal;

window.closeModal = function() {
  document.getElementById('project-modal').classList.remove('open');
  loadProjectList();
};

// ── Milestone list editor ─────────────────────────────────────

function renderMilestoneList(labels) {
  const el = document.getElementById('milestone-list');
  el.innerHTML = labels.map((label, i) => `
    <div class="list-editor-item" id="ms-${i}">
      <input class="form-input" value="${esc(label)}"
             placeholder="e.g. Contract &amp; Kickoff"
             onchange="updateMilestoneMax()">
      <button class="btn-icon" onclick="this.closest('.list-editor-item').remove();updateMilestoneMax()">✕</button>
    </div>`).join('');
  updateMilestoneMax();
}

window.addMilestone = function() {
  const items = document.querySelectorAll('#milestone-list .list-editor-item');
  const newIdx = items.length;
  const div = document.createElement('div');
  div.className = 'list-editor-item';
  div.id = `ms-${newIdx}`;
  div.innerHTML = `
    <input class="form-input" placeholder="e.g. On-Site Installation"
           onchange="updateMilestoneMax()">
    <button class="btn-icon" onclick="this.closest('.list-editor-item').remove();updateMilestoneMax()">✕</button>`;
  document.getElementById('milestone-list').appendChild(div);
  updateMilestoneMax();
};


function updateMilestoneMax() {
  const count = document.querySelectorAll('#milestone-list .list-editor-item').length;
  const input = document.getElementById('f-current-milestone');
  input.max = Math.max(1, count);
  if (parseInt(input.value) > count) input.value = count;
}

function getMilestoneLabels() {
  return [...document.querySelectorAll('#milestone-list .list-editor-item input')]
    .map(i => i.value.trim())
    .filter(Boolean);
}

// ── Document list editor ──────────────────────────────────────

function renderDocumentList(docs) {
  const sorted = [...docs].sort((a, b) => a.display_order - b.display_order);
  const el = document.getElementById('document-list');
  el.innerHTML = sorted.map((doc, i) => `
    <div class="list-editor-item" id="doc-item-${i}">
      <input class="form-input" value="${esc(doc.label)}"
             placeholder="Label (e.g. Proposal)" style="flex:1">
      <input class="form-input" value="${esc(doc.drive_url || '')}"
             placeholder="Google Drive URL (leave blank = Coming Soon)" style="flex:2">
      <button class="btn-icon" onclick="this.closest('.list-editor-item').remove()">✕</button>
    </div>`).join('');
}

window.addDocument = function() {
  const items = document.querySelectorAll('#document-list .list-editor-item');
  const idx = items.length;
  const div = document.createElement('div');
  div.className = 'list-editor-item';
  div.id = `doc-item-${idx}`;
  div.innerHTML = `
    <input class="form-input" placeholder="Label (e.g. Proposal)" style="flex:1">
    <input class="form-input" placeholder="Google Drive URL (leave blank = Coming Soon)" style="flex:2">
    <button class="btn-icon" onclick="this.closest('.list-editor-item').remove()">✕</button>`;
  document.getElementById('document-list').appendChild(div);
};


function getDocuments() {
  return [...document.querySelectorAll('#document-list .list-editor-item')].map((row, i) => {
    const inputs = row.querySelectorAll('input');
    return {
      label: inputs[0].value.trim(),
      drive_url: inputs[1].value.trim() || null,
      display_order: i
    };
  }).filter(d => d.label);
}

// ── Email list editor ─────────────────────────────────────────

function renderEmailList(emails) {
  const el = document.getElementById('email-list');
  el.innerHTML = emails.map((email, i) => `
    <div class="list-editor-item" id="email-item-${i}">
      <input class="form-input" value="${esc(email)}"
             type="email" placeholder="client@company.com">
      <button class="btn-icon" onclick="this.closest('.list-editor-item').remove()">✕</button>
    </div>`).join('');
}

window.addEmail = function() {
  const items = document.querySelectorAll('#email-list .list-editor-item');
  const idx = items.length;
  const div = document.createElement('div');
  div.className = 'list-editor-item';
  div.id = `email-item-${idx}`;
  div.innerHTML = `
    <input class="form-input" type="email" placeholder="client@company.com">
    <button class="btn-icon" onclick="this.closest('.list-editor-item').remove()">✕</button>`;
  document.getElementById('email-list').appendChild(div);
};


function getEmails() {
  return [...document.querySelectorAll('#email-list .list-editor-item input')]
    .map(i => i.value.trim().toLowerCase())
    .filter(Boolean);
}

// ── RAG doc list (read-only in modal) ────────────────────────

async function loadRagDocs(projectId) {
  const { data, error } = await db
    .from('document_chunks')
    .select('filename, page_num')
    .eq('project_id', projectId)
    .order('filename');

  renderRagDocList(data || []);
  document.getElementById('pdf-upload-area').dataset.projectId = projectId;
}

function renderRagDocList(chunks) {
  const el = document.getElementById('rag-doc-list');
  if (!chunks.length) {
    el.innerHTML = '<p class="text-muted" style="font-size:13px">No PDFs indexed yet.</p>';
    return;
  }
  const byFile = {};
  chunks.forEach(c => {
    byFile[c.filename] = (byFile[c.filename] || 0) + 1;
  });
  const projectId = document.getElementById('pdf-upload-area').dataset.projectId;
  el.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
      <button onclick="reindexAll()" id="reindex-btn"
              style="background:none;border:1px solid var(--gold);color:var(--gold);
                     padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px">
        ↺ Re-index All
      </button>
    </div>` +
  Object.entries(byFile).map(([file, pages]) => `
    <div style="display:flex;align-items:center;justify-content:space-between;
                padding:8px 12px;background:var(--dark);border-radius:6px;margin-bottom:6px;font-size:13px">
      <span>📄 ${esc(file)}</span>
      <div style="display:flex;align-items:center;gap:10px">
        <span class="text-muted">${pages} chunks</span>
        <button onclick="renameRagDoc('${esc(file)}')"
                style="background:none;border:1px solid var(--border);color:var(--muted);
                       padding:2px 8px;border-radius:4px;cursor:pointer;font-size:12px">Rename</button>
        <button onclick="deleteRagDoc('${esc(file)}')"
                style="background:none;border:1px solid #c0392b;color:#e74c3c;
                       padding:2px 8px;border-radius:4px;cursor:pointer;font-size:12px">Delete</button>
      </div>
    </div>`).join('');
}

window.reindexAll = async function() {
  const projectId = document.getElementById('pdf-upload-area').dataset.projectId;
  if (!projectId) return;
  if (!confirm('Re-index all PDFs for this project? This rewrites all search chunks.')) return;

  const progress = document.getElementById('upload-progress');
  const { data: { session } } = await db.auth.getSession();
  if (!session) { alert('Session expired — please reload.'); return; }

  progress.classList.remove('hidden');
  const btn = document.getElementById('reindex-btn');
  if (btn) btn.disabled = true;

  // List all PDFs in storage for this project
  const { data: files, error: listErr } = await db.storage
    .from('project-documents').list(projectId);
  if (listErr || !files?.length) {
    progress.textContent = '❌ Could not list files: ' + (listErr?.message || 'no files found');
    if (btn) btn.disabled = false;
    return;
  }

  const pdfs = files.filter(f => f.name.toLowerCase().endsWith('.pdf'));
  let done = 0;
  for (const file of pdfs) {
    const filename = file.name;
    progress.textContent = `[${++done}/${pdfs.length}] Downloading ${filename}…`;

    // Download PDF from storage
    const { data: blob, error: dlErr } = await db.storage
      .from('project-documents').download(`${projectId}/${filename}`);
    if (dlErr) { progress.textContent = `❌ Download failed (${filename}): ` + dlErr.message; continue; }

    // Parse PDF
    const arrayBuffer = await blob.arrayBuffer();
    let pdfDoc;
    try {
      pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    } catch (e) {
      progress.textContent = `❌ Parse failed (${filename}): ` + e.message;
      continue;
    }

    // Extract text chunks, prefixing each with the filename so product names match queries
    progress.textContent = `[${done}/${pdfs.length}] Extracting ${pdfDoc.numPages} pages from ${filename}…`;
    const docTitle = filename.replace(/\.pdf$/i, '');
    const chunks = [];
    for (let p = 1; p <= pdfDoc.numPages; p++) {
      const page    = await pdfDoc.getPage(p);
      const content = await page.getTextContent();
      const text    = extractPageText(content, 1900);
      // Prepend doc title so product name is always in the embedding
      chunks.push({ page_num: p, content: `[${docTitle}] ${text || '(no text)'}` });
    }

    // Re-index via edge function
    progress.textContent = `[${done}/${pdfs.length}] Indexing ${chunks.length} chunks for ${filename}…`;
    const res = await fetch(
      'https://sgtryrxsgbilbprrqtxw.supabase.co/functions/v1/index-document',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        body: JSON.stringify({ project_id: projectId, filename, chunks }),
      }
    );
    if (!res.ok) {
      const err = await res.text();
      progress.textContent = `❌ Index failed (${filename}): ` + err;
      continue;
    }
  }

  progress.textContent = `✅ Re-indexed ${pdfs.length} file${pdfs.length !== 1 ? 's' : ''}`;
  if (btn) btn.disabled = false;
  await loadRagDocs(projectId);
};

window.renameRagDoc = async function(oldName) {
  const newName = prompt(`Rename "${oldName}" to:`, oldName.replace(/\.pdf$/i, ''));
  if (!newName || newName.trim() === oldName.replace(/\.pdf$/i, '')) return;
  const finalName = newName.trim().endsWith('.pdf') ? newName.trim() : newName.trim() + '.pdf';
  const projectId = document.getElementById('pdf-upload-area').dataset.projectId;
  const { error } = await db.from('document_chunks')
    .update({ filename: finalName })
    .eq('project_id', projectId)
    .eq('filename', oldName);
  if (error) { alert('Rename failed: ' + error.message); return; }
  // Move file in storage so PDF viewer stays in sync
  await db.storage.from('project-documents')
    .move(`${projectId}/${oldName}`, `${projectId}/${finalName}`);
  await loadRagDocs(projectId);
};

window.deleteRagDoc = async function(filename) {
  if (!confirm(`Delete "${filename}" and remove all its indexed content?`)) return;
  const projectId = document.getElementById('pdf-upload-area').dataset.projectId;
  const { error } = await db.from('document_chunks')
    .delete()
    .eq('project_id', projectId)
    .eq('filename', filename);
  if (error) { alert('Delete failed: ' + error.message); return; }
  await db.storage.from('project-documents').remove([`${projectId}/${filename}`]);
  await loadRagDocs(projectId);
};

// ── Save project ──────────────────────────────────────────────

window.saveProject = async function() {
  const btn = document.getElementById('save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  const projectId  = document.getElementById('edit-project-id').value;
  const isNew      = !projectId;
  const milestones = getMilestoneLabels();
  const documents  = getDocuments();
  const emails     = getEmails();

  const payload = {
    project_number:    document.getElementById('f-number').value.trim(),
    name:              document.getElementById('f-name').value.trim(),
    client_name:       document.getElementById('f-client').value.trim() || null,
    status:            document.getElementById('f-status').value,
    milestone_labels:  milestones,
    current_milestone: parseInt(document.getElementById('f-current-milestone').value) || 1,
    updated_at:        new Date().toISOString()
  };

  if (!payload.project_number || !payload.name) {
    alert('Project Number and Name are required.');
    btn.disabled = false;
    btn.textContent = 'Save Project';
    return;
  }

  let savedProjectId = projectId;

  if (isNew) {
    const { data, error } = await db.from('projects').insert(payload).select().single();
    if (error) { alert('Error: ' + error.message); btn.disabled = false; btn.textContent = 'Save Project'; return; }
    savedProjectId = data.id;
  } else {
    const { error } = await db.from('projects').update(payload).eq('id', projectId);
    if (error) { alert('Error: ' + error.message); btn.disabled = false; btn.textContent = 'Save Project'; return; }
  }

  // Replace documents
  const { error: delDocErr } = await db.from('project_documents').delete().eq('project_id', savedProjectId);
  if (delDocErr) { alert('Error saving documents: ' + delDocErr.message); btn.disabled = false; btn.textContent = 'Save Project'; return; }
  if (documents.length) {
    const { error: insDocErr } = await db.from('project_documents').insert(
      documents.map(d => ({ ...d, project_id: savedProjectId }))
    );
    if (insDocErr) { alert('Error saving documents: ' + insDocErr.message); btn.disabled = false; btn.textContent = 'Save Project'; return; }
  }

  // Replace access emails
  const { error: delEmailErr } = await db.from('project_access').delete().eq('project_id', savedProjectId);
  if (delEmailErr) { alert('Error saving access: ' + delEmailErr.message); btn.disabled = false; btn.textContent = 'Save Project'; return; }
  if (emails.length) {
    const { error: insEmailErr } = await db.from('project_access').insert(
      emails.map(email => ({ project_id: savedProjectId, email }))
    );
    if (insEmailErr) { alert('Error saving access: ' + insEmailErr.message); btn.disabled = false; btn.textContent = 'Save Project'; return; }
  }

  btn.disabled = false;
  btn.textContent = 'Save Project';
  closeModal();
};

// ── Delete project ────────────────────────────────────────────

window.deleteProject = async function() {
  const projectId = document.getElementById('edit-project-id').value;
  if (!projectId) return;
  const name = document.getElementById('f-name').value;
  if (!confirm(`Delete project "${name}"? This cannot be undone.`)) return;
  const { error } = await db.from('projects').delete().eq('id', projectId);
  if (error) { alert('Delete failed: ' + error.message); return; }
  closeModal();
};

// ── PDF upload (for RAG) ──────────────────────────────────────

document.getElementById('pdf-file-input')?.addEventListener('change', e => {
  const files = e.target.files;
  if (!files?.length) return;
  const nameInput = document.getElementById('pdf-display-name');
  if (files.length === 1) {
    nameInput.disabled = false;
    // Don't pre-fill — leave empty so smart naming (metadata/text/Cerebras) runs.
    // User can type here to override.
  } else {
    nameInput.value = '';
    nameInput.disabled = true;
  }
});

document.getElementById('pdf-file-input')?.addEventListener('change', uploadPdfs);

async function uploadPdfs(e) {
  const files = Array.from(e.target.files || []).filter(f => f.name.endsWith('.pdf') && f.type === 'application/pdf');
  if (!files.length) return;
  const projectId = document.getElementById('pdf-upload-area').dataset.projectId;
  if (!projectId) { alert('Save the project first before uploading PDFs.'); return; }

  const progress = document.getElementById('upload-progress');
  const nameInput = document.getElementById('pdf-display-name');
  const { data: { session } } = await db.auth.getSession();
  if (!session) { progress.textContent = '❌ Session expired — please reload.'; return; }

  progress.classList.remove('hidden');

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const label = (n) => files.length > 1 ? `[${i + 1}/${files.length}] ${n}` : n;

    try {
      // Step 1: Determine display name (manual → metadata → original filename)
      let displayName = file.name;
      if (files.length === 1 && nameInput.value.trim()) {
        displayName = nameInput.value.trim() + '.pdf';
      } else {
        try {
          const ab    = await file.arrayBuffer();
          const doc   = await pdfjsLib.getDocument({ data: ab }).promise;
          const meta  = await doc.getMetadata();
          const title = meta.info?.Title?.trim();
          if (title && title.length > 3 && title.length < 120 && !/^\d+$/.test(title)) {
            displayName = title.replace(/[<>:"/\\|?*\r\n]+/g, '').trim().slice(0, 80) + '.pdf';
          }
        } catch { /* non-fatal */ }
      }

      // Step 2: Upload to storage
      progress.textContent = label(`Uploading "${displayName}"…`);
      const { error: storageError } = await db.storage
        .from('project-documents')
        .upload(`${projectId}/${displayName}`, file, { upsert: true });
      if (storageError) {
        progress.textContent = `❌ Upload failed (${file.name}): ` + storageError.message;
        return;
      }

      // Step 3: Index — edge function downloads from storage and extracts with PyMuPDF
      progress.textContent = label(`Indexing "${displayName}"… (extracting with PyMuPDF)`);
      const res = await fetch(
        'https://sgtryrxsgbilbprrqtxw.supabase.co/functions/v1/index-document',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
          body: JSON.stringify({ project_id: projectId, filename: displayName })
        }
      );
      if (!res.ok) {
        const err = await res.text();
        progress.textContent = `❌ Indexing failed (${file.name}): ` + err;
        return;
      }

      // Step 4: Use AI-suggested name if returned
      try {
        const resData = await res.json();
        if (resData.suggested_name) {
          const aiName = resData.suggested_name.trim().replace(/\.pdf$/i, '') + '.pdf';
          if (aiName !== displayName) {
            progress.textContent = label(`Naming → "${aiName}"…`);
            await db.from('document_chunks').update({ filename: aiName })
              .eq('project_id', projectId).eq('filename', displayName);
            await db.storage.from('project-documents')
              .move(`${projectId}/${displayName}`, `${projectId}/${aiName}`)
              .catch(() => {});
          }
        }
      } catch { /* non-fatal */ }

    } catch (err) {
      progress.textContent = `❌ Error (${file.name}): ` + err.message;
      return;
    }
  }

  progress.textContent = files.length > 1
    ? `✅ Indexed ${files.length} files`
    : `✅ Indexed successfully`;
  e.target.value = '';
  nameInput.value = '';
  nameInput.disabled = false;
  await loadRagDocs(projectId);
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

init();
