/* ARC account sync — merge-safe cloud sync over the shared Supabase project.

   Classic script loaded BEFORE app.js (like metabolic.js): it reads app.js
   globals (DB, getLogs, getProfile, goalCals, showToast, …) at call time.
   The Supabase client lives in cloud.js (a module) and arrives via
   window.arcReady.

   Model: one row per day (store 'calories', key 'YYYY-MM-DD') carrying the day's
   entries plus ARC's summary fields, and 'cai:*' rows for the rest. Merging is
   per entry id (newest `upd || ts` wins) with per-day tombstones for deletes, so
   two devices — or ARC re-uploading an older copy of a row — never drop entries:
   every full sync re-pushes whatever the cloud is missing. */

const arcApi = (ms = 8000) =>
  Promise.race([window.arcReady || Promise.resolve(null), new Promise(r => setTimeout(() => r(null), ms))]);
var arcUser = null;   // {id, email} once known; var so app.js can read it early

const getStamps = () => DB.get('cai_stamps') || {};
function stampKey(k) { const s = getStamps(); s[k] = Date.now(); DB.set('cai_stamps', s); }
const getTombs = () => DB.get('cai_deleted') || {};
function tombstone(date, id) {
  const t = getTombs();
  t[date] = t[date] || [];
  if (!t[date].includes(id)) t[date].push(id);
  DB.set('cai_deleted', t);
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const hashStr = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33 ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };

function dayValue(date, entries) {
  const t = entries.reduce((a, e) => ({ cal: a.cal + (+e.cal || 0), p: a.p + (+e.p || 0), c: a.c + (+e.c || 0), f: a.f + (+e.f || 0) }),
    { cal: 0, p: 0, c: 0, f: 0 });
  const prof = getProfile();
  return {
    app: 'calorieai',
    kcal: Math.round(t.cal), protein: Math.round(t.p), carbs: Math.round(t.c), fat: Math.round(t.f),
    goal: prof ? goalCals(prof) : null,
    proteinGoal: prof?.macroTargets?.protein || null,
    entries,
    deleted: getTombs()[date] || [],
  };
}

function buildArcRows() {
  const logs = getLogs(), tombs = getTombs(), st = getStamps();
  const days = new Set([...Object.keys(logs), ...Object.keys(tombs)]);
  const rows = [...days].filter(d => DAY_KEY.test(d)).map(d => ({ key: d, value: dayValue(d, logs[d] || []) }));
  if (getProfile()) rows.push({ key: 'cai:profile', value: { data: getProfile(), t: st.profile || 0 } });
  rows.push({ key: 'cai:favs',    value: { data: getFavs(),    t: st.favs || 0 } });
  rows.push({ key: 'cai:weights', value: { data: getWeights() } });
  rows.push({ key: 'cai:gki',     value: { data: getGki() } });
  return rows;
}

// Merge cloud rows into localStorage. Returns true if anything local changed.
function mergeArcRows(rows) {
  let changed = false;
  const logs = getLogs(), tombs = getTombs(), st = getStamps();
  for (const { key, value: v } of rows) {
    if (!v || typeof v !== 'object') continue;
    if (DAY_KEY.test(key)) {
      if (!Array.isArray(v.entries)) continue;   // not ours (ARC probes this store defensively too)
      const dead = new Set([...(tombs[key] || []), ...(v.deleted || [])]);
      const byId = new Map();
      for (const e of [...(logs[key] || []), ...v.entries]) {
        if (!e || e.id == null || dead.has(e.id)) continue;
        const cur = byId.get(e.id);
        if (!cur || (e.upd || e.ts || 0) > (cur.upd || cur.ts || 0)) byId.set(e.id, e);
      }
      const merged = [...byId.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0));
      if (JSON.stringify(merged) !== JSON.stringify(logs[key] || [])) { changed = true; }
      if (merged.length) logs[key] = merged; else delete logs[key];
      if (dead.size) tombs[key] = [...dead];
    } else if (key === 'cai:profile' || key === 'cai:favs') {
      const k = key.slice(4);
      if (v.data && (v.t || 0) > (st[k] || 0)) {
        DB.set(k === 'profile' ? K.PROFILE : 'cai_favs', v.data);
        st[k] = v.t; changed = true;
      }
    } else if (key === 'cai:weights' && Array.isArray(v.data)) {
      const map = new Map(getWeights().map(w => [w.date, w]));
      for (const w of v.data) {
        const cur = map.get(w.date);
        if (!cur || (w.upd || 0) > (cur.upd || 0)) { if (!cur || cur.kg !== w.kg) changed = true; map.set(w.date, w); }
      }
      DB.set(K.WEIGHTS, [...map.values()].sort((a, b) => a.date.localeCompare(b.date)));
    } else if (key === 'cai:gki' && Array.isArray(v.data)) {
      const local = getGki(), ids = new Set(local.map(r => r.id));
      const add = v.data.filter(r => r && !ids.has(r.id));
      if (add.length) { DB.set('cai_gki', [...local, ...add].sort((a, b) => (a.ts || 0) - (b.ts || 0))); changed = true; }
    }
  }
  DB.set(K.LOGS, logs);
  DB.set('cai_deleted', tombs);
  DB.set('cai_stamps', st);
  return changed;
}

function setArcStatus(text) {
  document.querySelectorAll('.arc-sync-status').forEach(el => { el.textContent = text; });
}

async function pushRows(api, rows) {
  const pushed = DB.get('cai_pushed') || {};
  const todo = rows.filter(r => pushed[r.key] !== hashStr(JSON.stringify(r.value)));
  if (!todo.length) return 0;
  await api.upsert(todo);
  todo.forEach(r => { pushed[r.key] = hashStr(JSON.stringify(r.value)); });
  DB.set('cai_pushed', pushed);
  return todo.length;
}

// Debounced push after every local save (afterSave → scheduleArcPush).
let arcPushTimer = null;
function scheduleArcPush(delay = 1500) {
  if (!arcUser) return;
  clearTimeout(arcPushTimer);
  arcPushTimer = setTimeout(arcPushNow, delay);
}
async function arcPushNow() {
  clearTimeout(arcPushTimer);
  const api = await arcApi();
  if (!api || !arcUser) return;
  try {
    await pushRows(api, buildArcRows());
    setArcStatus(`Synced ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`);
  } catch (e) {
    setArcStatus(`Sync failed: ${e.message}. Will retry.`);
  }
}

// Full sync: pull → merge → push whatever the cloud lacks (diffed against the
// cloud copy, so a stale row re-uploaded by another app is healed here).
async function arcSync() {
  const api = await arcApi();
  if (!api) { setArcStatus('ARC account unavailable offline'); return false; }
  arcUser = await api.user();
  renderArcAccount();
  if (!arcUser) return false;
  try {
    setArcStatus('Syncing…');
    const remote = await api.pullAll();
    const changed = mergeArcRows(remote || []);
    const remoteHash = Object.fromEntries((remote || []).map(r => [r.key, hashStr(JSON.stringify(r.value))]));
    DB.set('cai_pushed', remoteHash);   // what the cloud holds right now
    await pushRows(api, buildArcRows());
    setArcStatus(`Synced ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`);
    return changed;
  } catch (e) {
    setArcStatus(`Sync failed: ${e.message}`);
    return false;
  }
}

// ── Account UI (rendered into the setup screen and Profile) ─────────────────
let arcPendingEmail = '';
function renderArcAccount() {
  document.querySelectorAll('[data-arc-account]').forEach(box => {
    if (arcUser) {
      box.innerHTML = `
        <p class="hint">Signed in as <strong>${esc(arcUser.email || '')}</strong>. Your log syncs to your ARC account, and ARC shows today's calories and protein.</p>
        <div class="arc-sync-status sync-status"></div>
        <button type="button" class="btn-secondary full-width" data-arc="sync" style="margin-top:10px">Sync now</button>
        <button type="button" class="btn-danger full-width" data-arc="signout" style="margin-top:8px">Sign out</button>`;
    } else {
      box.innerHTML = `
        <p class="hint">Use the email you sign in to ARC with. We'll send a 6-digit code.</p>
        <div class="field"><label for="arc-email-${box.dataset.arcAccount}">Email</label>
          <input type="email" id="arc-email-${box.dataset.arcAccount}" class="input" autocomplete="email" inputmode="email" value="${esc(arcPendingEmail)}" placeholder="you@example.com"></div>
        <div class="field ${arcPendingEmail ? '' : 'hidden'}" data-arc-code-row><label for="arc-code-${box.dataset.arcAccount}">Code from email</label>
          <input type="text" id="arc-code-${box.dataset.arcAccount}" class="input" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456"></div>
        <button type="button" class="btn-primary full-width" data-arc="${arcPendingEmail ? 'verify' : 'send'}">${arcPendingEmail ? 'Verify and sign in' : 'Send code'}</button>
        <div class="arc-sync-status sync-status" aria-live="polite"></div>`;
    }
  });
  if (typeof checkStaleInstall === 'function') checkStaleInstall();   // backup wording depends on sign-in
  const acctNote = document.getElementById('api-key-optional');
  if (acctNote) acctNote.classList.toggle('hidden', !arcUser);
}

document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-arc]');
  if (!btn) return;
  const box = btn.closest('[data-arc-account]');
  const api = await arcApi();
  if (!api) { setArcStatus('Can’t reach ARC. Check your connection.'); return; }
  const action = btn.dataset.arc;
  btn.disabled = true;
  try {
    if (action === 'send') {
      const email = box.querySelector('input[type=email]').value.trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) { setArcStatus('Enter a valid email.'); return; }
      await api.sendCode(email);
      arcPendingEmail = email;
      renderArcAccount();
      setArcStatus(`Code sent to ${email}.`);
    } else if (action === 'verify') {
      const code = box.querySelector('[data-arc-code-row] input').value.trim();
      await api.verifyCode(arcPendingEmail, code);
      arcPendingEmail = '';
      await onArcSignedIn();
    } else if (action === 'sync') {
      if (await arcSync()) refreshAfterArcSync();
    } else if (action === 'signout') {
      await api.signOut();
      arcUser = null;
      renderArcAccount();
      setArcStatus('Signed out. Data stays on this device.');
    }
  } catch (err) {
    setArcStatus(err.message);
  } finally {
    btn.disabled = false;
  }
});

async function onArcSignedIn() {
  const changed = await arcSync();
  renderTrainTile();
  showToast('Signed in to ARC');
  const onSetup = !document.getElementById('setup-screen').classList.contains('hidden');
  if (onSetup && getProfile()) launchApp();       // restored an existing profile
  else if (changed) refreshAfterArcSync();
}

function refreshAfterArcSync() {
  if (!getProfile()) return;
  // Fresh install already signed in (e.g. via ARC in the same browser): the
  // restore brought a profile back, so skip setup.
  if (!document.getElementById('setup-screen').classList.contains('hidden')) { launchApp(); return; }
  updateTodayView();
  renderProfileView();
}

// ── Train tile: what ARC says about today (done / planned / rest) ─────────
async function renderTrainTile() {
  const val = document.getElementById('train-val');
  if (!val) return;
  const lbl = document.getElementById('train-lbl'), sub = document.getElementById('train-sub');
  const open = `Open ${icon('arrow-right', 11)}`;
  const api = await arcApi(6000);
  let t = null;
  try { if (api && arcUser) t = await api.training(todayStr()); } catch { t = null; }
  if (t?.status === 'done') {
    val.textContent = t.title; lbl.textContent = 'Trained today';
    sub.innerHTML = t.mins ? `${t.mins} min · ${open}` : open;
  } else if (t?.status === 'planned') {
    val.textContent = t.title; lbl.textContent = 'Planned today';
    sub.innerHTML = `${t.exercises} exercises · ${open}`;
  } else {
    val.textContent = 'ARC'; lbl.textContent = t ? 'Rest day' : 'Training'; sub.innerHTML = open;
  }
}

// Boot: learn the session, render the account boxes, then full-sync.
function initArcSync() {
  renderArcAccount();
  arcSync().then(changed => { if (changed) refreshAfterArcSync(); renderTrainTile(); });
  window.addEventListener('online', () => { if (arcUser) arcSync().then(c => { if (c) refreshAfterArcSync(); }); });
  window.addEventListener('pagehide', () => { if (arcUser) arcPushNow(); });
}
