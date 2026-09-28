// ARC account bridge — the same Supabase project, auth and `entries` table as ARC
// (joejohnston72-dev/arc, shared/db.js). Loaded as a module (deferred), so it
// resolves `window.arcReady` for the classic scripts rather than exporting.
//
// Rows written here: store 'calories', one row per day keyed 'YYYY-MM-DD' (ARC's
// getNutritionToday() reads {kcal, goal, protein} from it), plus 'cai:*' rows for
// profile / weights / favourites / GKI readings.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://xjcnkivlkfzdycbyxxlx.supabase.co';
// Public anon key (same one ARC ships) — row access is enforced by RLS on user_id.
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqY25raXZsa2Z6ZHljYnl4eGx4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0MjQwODIsImV4cCI6MjA5NjAwMDA4Mn0.bt4X0cz2gu7GUdb8OC7uvVLPDKJWws8RyvSmwGkHcVI';
const PROXY_URL = `${SUPABASE_URL}/functions/v1/coach`;
const STORE = 'calories';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function session() {
  try { return (await sb.auth.getSession())?.data?.session || null; } catch { return null; }
}

const api = {
  async user() {
    const s = await session();
    return s ? { id: s.user.id, email: s.user.email } : null;
  },

  async sendCode(email) {
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    if (error) throw new Error(error.message);
  },

  async verifyCode(email, token) {
    const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
    if (error) throw new Error(error.message);
  },

  async signOut() { await sb.auth.signOut(); },

  // Paginated: PostgREST caps a select at 1000 rows (ARC lost history to this once).
  async pullAll() {
    const s = await session();
    if (!s) return null;
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('entries')
        .select('key, value')
        .eq('user_id', s.user.id).eq('store', STORE)
        .order('key', { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      out.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    return out;
  },

  // Read-only peek at ARC's own store for the Train tile: today's logged
  // session(s), else the routine planned for today. Small, targeted queries.
  async training(date) {
    const s = await session();
    if (!s) return null;
    const uid = s.user.id;
    const { data: done } = await sb.from('entries').select('value')
      .eq('user_id', uid).eq('store', 'workout').like('key', 'session-%').eq('value->>date', date).limit(5);
    if (done && done.length) {
      const v = done[0].value || {};
      return { status: 'done', title: v.title || 'Workout', mins: Math.round((v.duration || 0) / 60), count: done.length };
    }
    const { data: plan } = await sb.from('entries').select('key, value')
      .eq('user_id', uid).eq('store', 'workout').in('key', ['week-plan', 'templates']);
    const get = k => (plan || []).find(r => r.key === k)?.value;
    const tid = (get('week-plan') || {})[date];
    const tpl = tid && (get('templates') || []).find(t => t.id === tid);
    return tpl ? { status: 'planned', title: tpl.name, exercises: (tpl.exercises || []).length } : { status: 'none' };
  },

  async upsert(rows) {
    const s = await session();
    if (!s || !rows.length) return 0;
    let n = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200).map(r => ({ user_id: s.user.id, store: STORE, key: r.key, value: r.value }));
      const { error } = await sb.from('entries').upsert(chunk);
      if (error) throw new Error(error.message);
      n += chunk.length;
    }
    return n;
  },

  // Anthropic Messages call through ARC's Edge Function (server-side key, SSE).
  // Returns the concatenated text. Throws Error with .code for the caller's fallback.
  async ai(body) {
    const s = await session();
    if (!s) { const e = new Error('Not signed in'); e.code = 'auth'; throw e; }
    const res = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${s.access_token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const e = new Error(j.detail || j.error || `AI proxy error ${res.status}`);
      e.code = j.error || String(res.status);
      throw e;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        try {
          const ev = JSON.parse(line.slice(5));
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') text += ev.delta.text;
          if (ev.type === 'error') throw new Error(ev.error?.message || 'AI stream error');
        } catch (e) { if (e.message && !(e instanceof SyntaxError)) throw e; }
      }
    }
    return text;
  },
};

sb.auth.onAuthStateChange(evt => {
  if (evt === 'SIGNED_IN' || evt === 'SIGNED_OUT') window.dispatchEvent(new CustomEvent('arc-auth', { detail: evt }));
});

window.__arcResolve(api);
