import { db, requireAdmin } from '/js/supabase-client.js';

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
  el.innerHTML = Object.entries(byFile).map(([file, pages]) => `
    <div style="display:flex;align-items:center;justify-content:space-between;
                padding:8px 12px;background:var(--dark);border-radius:6px;margin-bottom:6px;font-size:13px">
      <span>📄 ${esc(file)}</span>
      <span class="text-muted">${pages} chunks</span>
    </div>`).join('');
}

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

// ES module scripts are deferred — DOM is ready, attach directly
document.getElementById('pdf-file-input')?.addEventListener('change', uploadPdf);

async function uploadPdf(e) {
  const file = e.target.files?.[0];
  if (!file || !file.name.endsWith('.pdf') || file.type !== 'application/pdf') return;
  const projectId = document.getElementById('pdf-upload-area').dataset.projectId;
  if (!projectId) { alert('Save the project first before uploading PDFs.'); return; }

  const progress = document.getElementById('upload-progress');
  progress.classList.remove('hidden');
  progress.textContent = 'Uploading to storage…';

  // 1. Upload to Supabase Storage
  const storagePath = `${projectId}/${file.name}`;
  const { error: storageError } = await db.storage
    .from('project-documents')
    .upload(storagePath, file, { upsert: true });

  if (storageError) {
    progress.textContent = '❌ Upload failed: ' + storageError.message;
    return;
  }

  try {
    progress.textContent = 'Parsing PDF…';

    // 2. Parse PDF in browser using PDF.js, send chunks to edge function
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask  = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdfDoc       = await loadingTask.promise;

    const chunks = [];
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page    = await pdfDoc.getPage(i);
      const content = await page.getTextContent();
      const text    = content.items.map(item => item.str).join(' ').trim().slice(0, 2000);
      if (text) chunks.push({ page_num: i, content: text });
    }

    progress.textContent = `Indexing ${chunks.length} pages…`;

    // 3. Send chunks to edge function
    const { data: { session } } = await db.auth.getSession();
    if (!session) { progress.textContent = '❌ Session expired — please reload.'; return; }
    const res = await fetch(
      'https://sgtryrxsgbilbprrqtxw.supabase.co/functions/v1/index-document',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ project_id: projectId, filename: file.name, chunks })
      }
    );

    if (!res.ok) {
      const err = await res.text();
      progress.textContent = '❌ Indexing failed: ' + err;
      return;
    }

    progress.textContent = `✅ Indexed ${chunks.length} chunks`;
    e.target.value = '';
    await loadRagDocs(projectId);
  } catch (err) {
    progress.textContent = '❌ Error: ' + err.message;
  }
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
