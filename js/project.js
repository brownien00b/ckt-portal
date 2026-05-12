import { db, requireAuth } from '/js/supabase-client.js';

async function init() {
  const session = await requireAuth();
  if (!session) return;

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

  document.title = `${project.name} — CKT Group`;
  document.getElementById('project-number').textContent = project.project_number;
  renderProject(project);
}

function renderProject(project) {
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
  renderDocuments(project.project_documents);
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

function renderDocuments(docs) {
  const el = document.getElementById('documents-grid');
  if (!docs || !docs.length) {
    el.innerHTML = '<p class="text-muted">No documents added yet.</p>';
    return;
  }
  const sorted = [...docs].sort((a, b) => a.display_order - b.display_order);
  el.innerHTML = sorted.map(doc => {
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
  }).join('');
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
    .replace(/"/g, '&quot;');
}

function isSafeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch { return false; }
}

init();
