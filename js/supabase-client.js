import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL      = 'https://sgtryrxsgbilbprrqtxw.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_1bal5_yoGdKefugSRde5bA_SlwVXurL';

export const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * True if the signed-in user is an admin. Data-driven: checks the
 * `admins` table via the `is_admin()` RPC (not a hardcoded email).
 * Manage admins in Supabase: `insert into public.admins (email) values (...)`.
 */
export async function isAdmin() {
  const { data, error } = await db.rpc('is_admin');
  if (error) { console.error('is_admin() check failed:', error.message); return false; }
  return data === true;
}

/**
 * Redirect to login if no session exists.
 * Returns the session if authenticated, null if redirecting.
 */
export async function requireAuth(redirectTo = '/login.html') {
  const { data: { session } } = await db.auth.getSession();
  if (!session) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `${redirectTo}?next=${next}`;
    return null;
  }
  return session;
}

/**
 * Require an admin account (data-driven via the `admins` table). Blocks non-admins.
 */
export async function requireAdmin() {
  const session = await requireAuth();
  if (!session) return null;
  if (!(await isAdmin())) {
    document.body.innerHTML =
      '<div style="color:var(--text);padding:40px;font-family:Arial">Access denied. <button onclick="import(\'/js/supabase-client.js\').then(m=>m.db.auth.signOut()).then(()=>window.location.href=\'/login.html\')" style="margin-left:12px;padding:6px 14px;background:#CCA452;color:#071E33;border:none;border-radius:4px;cursor:pointer;font-weight:600">Sign Out</button></div>';
    return null;
  }
  return session;
}

/**
 * Get a signed URL for a file in the project-documents bucket.
 * Expires in 1 hour.
 */
export async function getFileUrl(path) {
  const { data, error } = await db.storage
    .from('project-documents')
    .createSignedUrl(path, 3600);
  if (error) throw error;
  return data.signedUrl;
}
