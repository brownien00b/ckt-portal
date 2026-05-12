import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL      = 'https://sgtryrxsgbilbprrqtxw.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_1bal5_yoGdKefugSRde5bA_SlwVXurL';

export const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export const ADMIN_EMAIL = 'arpanmajmundar@gmail.com';

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
 * Require Arpan's admin account. Blocks non-admins.
 */
export async function requireAdmin() {
  const session = await requireAuth();
  if (!session) return null;
  if (session.user.email !== ADMIN_EMAIL) {
    document.body.innerHTML =
      '<div style="color:var(--text);padding:40px;font-family:Arial">Access denied.</div>';
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
