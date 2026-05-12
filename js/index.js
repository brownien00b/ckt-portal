import { db, requireAdmin } from '/js/supabase-client.js';

async function init() {
  const session = await requireAdmin();
  if (!session) return;

  document.getElementById('signout-btn').addEventListener('click', async () => {
    await db.auth.signOut({ scope: 'local' });
    window.location.href = '/login.html';
  });

  const { data: projects, error } = await db
    .from('projects')
    .select('id, project_number, name, client_name, status, current_milestone, milestone_labels')
    .order('created_at', { ascending: false });

  const listEl = document.getElementById('project-list');

  if (error || !projects || !projects.length) {
    listEl.innerHTML = '<p class="text-muted">No projects yet. <a href="/admin.html" class="text-gold">Add one in Admin →</a></p>';
    return;
  }

  const VALID_STATUSES = ['active', 'complete', 'pending'];

  listEl.innerHTML = `<div class="project-list">${projects.map(p => {
    const totalSteps = p.milestone_labels?.length || 0;
    const progress   = totalSteps ? `Step ${p.current_milestone} of ${totalSteps}` : '—';
    const safeStatus = VALID_STATUSES.includes(p.status.toLowerCase())
      ? p.status.toLowerCase()
      : 'pending';
    return `
      <div class="project-row">
        <span class="project-row-number">${escHtml(p.project_number)}</span>
        <span class="project-row-name">${escHtml(p.name)}</span>
        <span class="project-row-client">${escHtml(p.client_name || '—')}</span>
        <span class="status-badge status-${safeStatus}">${escHtml(p.status)}</span>
        <span class="text-muted" style="font-size:12px;min-width:90px">${progress}</span>
        <div class="project-row-actions">
          <a href="/project.html?id=${encodeURIComponent(p.project_number)}"
             class="btn btn-secondary" style="font-size:12px;padding:6px 12px"
             target="_blank">View</a>
          <a href="/admin.html?edit=${encodeURIComponent(p.project_number)}"
             class="btn btn-secondary" style="font-size:12px;padding:6px 12px">Edit</a>
        </div>
      </div>`;
  }).join('')}</div>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

init();
