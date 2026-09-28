'use strict';

// ── STORAGE ────────────────────────────────────────────────────
const DB = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
};
const K = {
  API:     'cai_api',
  PROFILE: 'cai_profile',
  LOGS:    'cai_logs',    // { "YYYY-MM-DD": [{id,ts,name,serving,cal,p,c,f}] }
  WEIGHTS: 'cai_weights', // [{date:"YYYY-MM-DD", kg:number}]
};

// touchMeta + scheduleBackup are defined later (function declarations, hoisted).
// Each save bumps a lastModified timestamp and queues a cloud backup.
function afterSave() { touchMeta(); scheduleBackup(); scheduleArcPush(); }

const getLogs    = ()    => DB.get(K.LOGS)    || {};
const saveLogs   = v     => { DB.set(K.LOGS, v);     afterSave(); };
const getWeights = ()    => DB.get(K.WEIGHTS) || [];
const saveWeights= v     => { DB.set(K.WEIGHTS, v);  afterSave(); };
const getProfile = ()    => DB.get(K.PROFILE);
const saveProfile= v     => { DB.set(K.PROFILE, v);  stampKey('profile'); afterSave(); };
const getApiKey  = ()    => DB.get(K.API) || '';
const saveApiKey = v     => DB.set(K.API, v); // API key is device-local, not backed up
const getFavs    = ()    => DB.get('cai_favs') || [];
const saveFavs   = v     => { DB.set('cai_favs', v); stampKey('favs'); afterSave(); };

// ── CLOUD BACKUP (GitHub Gist) ─────────────────────────────────
const GIST_FILENAME = 'calorieai-backup.json';
const GIST_DESC     = 'CalorieAI Backup — do not delete';

const getGistToken = () => localStorage.getItem('cai_gist_token') || '';
const setGistToken = t  => localStorage.setItem('cai_gist_token', t);
const getGistId    = () => localStorage.getItem('cai_gist_id') || '';
const setGistId    = id => localStorage.setItem('cai_gist_id', id);
const getMeta      = () => DB.get('cai_meta') || { lastModified: 0 };

function touchMeta() { DB.set('cai_meta', { lastModified: Date.now() }); }

function cloudEnabled() { return !!getGistToken(); }

function buildBackupPayload() {
  return {
    app: 'calorieai',
    version: 1,
    lastModified: getMeta().lastModified || Date.now(),
    profile: getProfile(),
    logs:    getLogs(),
    weights: getWeights(),
    favs:    getFavs(),
    gki:     getGki()
  };
}

// Write a backup payload into localStorage WITHOUT re-triggering a backup
function applyBackupPayload(data) {
  if (!data) return;
  if (data.profile) DB.set(K.PROFILE, data.profile);
  if (data.logs)    DB.set(K.LOGS, data.logs);
  if (data.weights) DB.set(K.WEIGHTS, data.weights);
  if (data.favs)    DB.set('cai_favs', data.favs);
  if (data.gki)     DB.set('cai_gki', data.gki);
  DB.set('cai_meta', { lastModified: data.lastModified || Date.now() });
}

async function ghFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${getGistToken()}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    let msg = `GitHub error ${res.status}`;
    if (res.status === 401) msg = 'Invalid token (needs "gist" scope)';
    throw new Error(msg);
  }
  return res;
}

// Find an existing backup gist by filename — lets us restore with only the token
async function findBackupGist() {
  const res   = await ghFetch('https://api.github.com/gists?per_page=100');
  const gists = await res.json();
  const match = gists.find(g => g.files && g.files[GIST_FILENAME]);
  return match ? match.id : null;
}

async function cloudPush() {
  if (!cloudEnabled()) return;
  const content = JSON.stringify(buildBackupPayload(), null, 2);
  const body    = JSON.stringify({
    description: GIST_DESC,
    public: false,
    files: { [GIST_FILENAME]: { content } }
  });

  let id = getGistId();
  if (!id) {
    id = await findBackupGist();         // reuse if one already exists
    if (id) setGistId(id);
  }

  if (id) {
    await ghFetch(`https://api.github.com/gists/${id}`, { method: 'PATCH', body });
  } else {
    const res  = await ghFetch('https://api.github.com/gists', { method: 'POST', body });
    const gist = await res.json();
    setGistId(gist.id);
  }
  setSyncStatus(`Last synced: ${new Date().toLocaleString('en-GB')}`);
}

async function cloudPull() {
  if (!cloudEnabled()) return null;
  let id = getGistId();
  if (!id) { id = await findBackupGist(); if (id) setGistId(id); }
  if (!id) return null;
  const res  = await ghFetch(`https://api.github.com/gists/${id}`);
  const gist = await res.json();
  const file = gist.files[GIST_FILENAME];
  if (!file) return null;
  // Large gists are truncated — fetch raw_url if so
  const raw = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
  return JSON.parse(raw);
}

// Debounced auto-backup
let backupTimer = null;
let backupPending = false;
function scheduleBackup() {
  if (!cloudEnabled()) return;
  backupPending = true;
  setSyncStatus('Backing up…');
  clearTimeout(backupTimer);
  backupTimer = setTimeout(async () => {
    try { await cloudPush(); backupPending = false; }
    catch (e) { setSyncStatus(`Backup failed: ${e.message}`); }
  }, 2500);
}

function setSyncStatus(text) {
  const el = document.getElementById('sync-status');
  if (el) el.textContent = text;
}

// On startup: pull cloud and restore if it's newer (or local is empty)
async function syncOnLaunch() {
  if (!cloudEnabled()) return;
  try {
    setSyncStatus('Checking cloud…');
    const cloud = await cloudPull();
    if (!cloud) { setSyncStatus('No cloud backup yet'); return; }

    const localMod = getMeta().lastModified || 0;
    const localHasProfile = !!getProfile();

    if (!localHasProfile || cloud.lastModified > localMod) {
      applyBackupPayload(cloud);
      setSyncStatus(`Restored from cloud: ${new Date(cloud.lastModified).toLocaleString('en-GB')}`);
      return true; // signal that data changed
    }
    // local is newer → push it up
    await cloudPush();
  } catch (e) {
    setSyncStatus(`Sync error: ${e.message}`);
  }
  return false;
}

// ── Lucide icons (vendored subset, https://lucide.dev · ISC) — shared ARC style
const ICONS = {
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  star:   '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
  x:      '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  bot:    '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
};
function icon(name, size = 18, filled = false) {
  return `<svg class="lc" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// confidence → percentage
function confPct(conf) {
  if (conf === 'high')   return 95;
  if (conf === 'medium') return 80;
  return 60;
}
function confClass(pct) {
  if (pct >= 90) return 'high';
  if (pct >= 75) return 'medium';
  return 'low';
}

// ── DATE ───────────────────────────────────────────────────────
// Local calendar day (toISOString is UTC — logged into yesterday after midnight BST)
const ymdLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayStr = () => ymdLocal(new Date());

// The day the Today screen is showing. null = today (follows the clock);
// a 'YYYY-MM-DD' string when browsing back to edit a past day.
var viewDay = null;
const activeDay = () => viewDay || todayStr();
const isViewingToday = () => activeDay() === todayStr();
// Timestamp for something logged on the viewed day: now, or the same clock
// time on a past day (so it lands in the right meal group).
function tsForActiveDay() {
  if (isViewingToday()) return Date.now();
  const [y, m, d] = activeDay().split('-').map(Number);
  const now = new Date();
  return new Date(y, m - 1, d, now.getHours(), now.getMinutes()).getTime();
}
function shiftViewDay(delta) {
  const [y, m, d] = activeDay().split('-').map(Number);
  const next = ymdLocal(new Date(y, m - 1, d + delta, 12));
  if (next > todayStr()) return;
  viewDay = next === todayStr() ? null : next;
  updateTodayView();
}

function fmtDate(s) {
  const d = new Date(s + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function mealFromTs(ts) {
  const h = new Date(ts).getHours();
  if (h >= 5  && h < 11) return 'Breakfast';
  if (h >= 11 && h < 15) return 'Lunch';
  if (h >= 15 && h < 20) return 'Dinner';
  return 'Snacks';
}

// ── CALCULATIONS ───────────────────────────────────────────────
function calcBMR({ weight, height, age, sex }) {
  const base = 10 * weight + 6.25 * height - 5 * age;
  return sex === 'male' ? base + 5 : base - 161;
}
function calcTDEE(p) { return Math.round(calcBMR(p) * parseFloat(p.activity)); }
function calcBMI(p)  { const h = p.height / 100; return (p.weight / (h * h)).toFixed(1); }
function bmiCat(b)   {
  if (b < 18.5) return 'Underweight';
  if (b < 25)   return 'Normal weight';
  if (b < 30)   return 'Overweight';
  return 'Obese';
}
function goalCals(p) {
  const tdee = calcTDEE(p);
  // A cut never goes below BMR or the usual safe minimum (1,500 men / 1,200 women).
  if (p.goalType === 'cut')    return Math.max(tdee - 500, Math.round(calcBMR(p)), p.sex === 'female' ? 1200 : 1500);
  if (p.goalType === 'bulk')   return tdee + 300;
  if (p.goalType === 'custom') return parseInt(p.customGoal) || tdee;
  return tdee;
}

// ── CLAUDE API ─────────────────────────────────────────────────
// Structured output: a forced tool whose input schema IS the nutrition record,
// so the reply is always a JSON object in a fixed shape (no text to regex out).
const NUTRITION_TOOL = {
  name: 'record_nutrition',
  description: 'Record the nutrition estimate for the food described or shown.',
  input_schema: {
    type: 'object',
    properties: {
      name:           { type: 'string', description: 'Short display name' },
      serving:        { type: 'string', description: "Serving used, e.g. '2 large eggs' or 'approx 150g chicken, 200g rice'" },
      calories:       { type: 'integer' },
      protein_g:      { type: 'number' },
      carbs_g:        { type: 'number' },
      fat_g:          { type: 'number' },
      glycemic_index: { type: 'integer', description: 'Estimated GI 0-110 of the carb sources; 0 if no meaningful carbs' },
      confidence:     { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['name', 'serving', 'calories', 'protein_g', 'carbs_g', 'fat_g', 'glycemic_index', 'confidence'],
  },
};

const AI_TIMEOUT_MS = 45000;
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Prefer ARC's Edge Function proxy (server-side key, retries upstream) when
// signed in; fall back to this device's own key.
async function callClaude(messages, apiKey, maxTokens = 600) {
  const body = {
    model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, messages,
    tools: [NUTRITION_TOOL], tool_choice: { type: 'tool', name: NUTRITION_TOOL.name },
  };
  let proxyErr = null;
  if (arcUser) {
    const api = await arcApi(4000);
    if (api) {
      try { return parseAIJson(await withTimeout(api.ai(body), AI_TIMEOUT_MS, 'Timed out')); }
      catch (e) { proxyErr = e; }
    }
  }
  if (!apiKey) {
    const e = new Error(proxyErr
      ? `ARC's AI service didn't answer (${proxyErr.message}). Add your own API key in Profile to keep logging.`
      : 'Sign in to your ARC account or add an API key in Profile.');
    e.network = !!proxyErr && !navigator.onLine;
    throw e;
  }

  // Direct call: timeout per attempt, up to 2 retries on 429/5xx/network.
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), AI_TIMEOUT_MS);
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctl.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify(body)
      });
    } catch (err) {
      clearTimeout(timer);
      if (attempt < 2 && navigator.onLine) { await sleep(800 * (attempt + 1)); continue; }
      const e = new Error(err.name === 'AbortError' ? 'The lookup timed out. Check your connection and try again.' : 'Couldn’t reach Claude. Check your connection.');
      e.network = true;
      throw e;
    }
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      if (data.stop_reason === 'max_tokens') throw new Error('The answer was cut off. Try a shorter description.');
      const tool = (data.content || []).find(b => b.type === 'tool_use');
      if (tool) return tool.input;
      return parseAIJson((data.content || []).map(b => b.text || '').join(''));
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 1000 * (attempt + 1);
      await sleep(Math.min(wait, 8000));
      continue;
    }
    const err = await res.json().catch(() => ({}));
    const msg = {
      401: 'That API key was rejected (401). Update it in Profile.',
      403: 'That API key isn’t allowed to use this model (403).',
      429: 'Rate limited by Anthropic (429). Try again in a minute.',
      529: 'Claude is overloaded right now (529). Try again shortly.',
    }[res.status];
    throw new Error(msg || err.error?.message || `API error ${res.status}`);
  }
}

// The proxy streams the forced tool call back as JSON text; tolerate stray prose.
function parseAIJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw).trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Unexpected AI response');
  return JSON.parse(match[0]);
}

async function lookupNutrition(desc, apiKey) {
  const prompt = `You are a nutrition database. Given a food description, return precise calorie and macro data.

Food: "${desc}"

Rules:
- Branded/packaged product: use the actual nutrition label values
- Restaurant item: use the restaurant's published nutrition data if known
- Home cooking or vague description: calculate based on typical ingredients
- Return data for the EXACT quantity described (e.g. "2 eggs" = data for 2 eggs)
- If no quantity given, use a standard single serving

Record the result with the record_nutrition tool.`;

  return callClaude([{ role: 'user', content: prompt }], apiKey);
}

async function lookupNutritionFromImage(base64, mediaType, apiKey, extraContext = '') {
  const contextLine = extraContext
    ? `\nExtra context from user: "${extraContext}" — use this to refine your estimate (e.g. portion size, restaurant name, cooking method).`
    : '';

  const prompt = `Analyse this food photo and estimate the nutrition information.${contextLine}

Identify all food items visible. Estimate portion sizes using visual cues (plate size, utensils, hands, packaging for scale).
Be systematic: list what you see, estimate weights/quantities, then calculate nutrition.

Record the result with the record_nutrition tool (name = brief meal description, serving = estimated portions).`;

  return callClaude([{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
      { type: 'text', text: prompt }
    ]
  }], apiKey, 900);
}

// ── NAV ────────────────────────────────────────────────────────
let charts = {};
let pendingPhoto = null; // { base64, mediaType }

function clearPendingPhoto() {
  pendingPhoto = null;
  document.getElementById('photo-preview-row').classList.add('hidden');
  document.getElementById('photo-thumb').src        = '';
  document.getElementById('food-input').placeholder = 'e.g. Weetabix 2 biscuits, Big Mac, chicken breast 150g...';
}

function navigate(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');
  document.querySelector(`.nav-item[data-view="${view}"]`).classList.add('active');

  // Same header as ARC: the weekday as the title on Today, meta on the right.
  const titles = { today: new Date().toLocaleDateString('en-GB', { weekday: 'long' }), stats: 'Progress', weight: 'Body', profile: 'Profile' };
  document.getElementById('header-title').textContent = titles[view];

  const profile = getProfile();
  if (view === 'today' && profile) {
    document.getElementById('header-sub').textContent = `Goal ${goalCals(profile).toLocaleString()} kcal`;
  } else {
    document.getElementById('header-sub').textContent = '';
  }

  if (view === 'stats')   renderStats();
  if (view === 'weight')  renderWeightView();
  if (view === 'profile') renderProfileView();
}

// ── TODAY VIEW ─────────────────────────────────────────────────
function updateTodayView() {
  lastShownDay = todayStr();
  const day     = activeDay();
  const profile = getProfile();
  const logs    = getLogs();
  const entries = logs[day] || [];

  const tot = entries.reduce((a, e) => ({
    cal: a.cal + e.cal,
    p:   a.p   + e.p,
    c:   a.c   + e.c,
    f:   a.f   + e.f
  }), { cal: 0, p: 0, c: 0, f: 0 });

  const goal = profile ? goalCals(profile) : 2000;

  // Use custom macro targets if set, otherwise fall back to % of calories
  const mt = profile?.macroTargets;
  const pg = mt?.protein || Math.round(goal * 0.30 / 4);
  const cg = mt?.carbs   || Math.round(goal * 0.45 / 4);
  const fg = mt?.fat     || Math.round(goal * 0.25 / 9);

  // Helper: update a ring SVG element
  function setRing(id, value, max, circumference) {
    const pct = Math.min(value / max, 1);
    const el  = document.getElementById(id);
    el.style.strokeDashoffset = circumference - pct * circumference;
  }

  // CALORIE ring (large: r=56, circ=351.86)
  const calCirc = 351.86;
  setRing('ring-cal', tot.cal, goal, calCirc);
  document.getElementById('ring-cal').style.stroke =
    tot.cal > goal * 1.05 ? '#d88685' : '#d6b48e';
  document.getElementById('ring-cal-val').textContent = Math.round(tot.cal);
  const calRem = goal - tot.cal;
  document.getElementById('ring-cal-sub').textContent =
    calRem >= 0 ? `${Math.round(calRem)} left` : `${Math.round(-calRem)} over`;

  // PROTEIN ring (large: r=56, circ=351.86)
  setRing('ring-protein', tot.p, pg, calCirc);
  document.getElementById('ring-protein-val').textContent = `${Math.round(tot.p)}g`;
  const protRem = pg - tot.p;
  document.getElementById('ring-protein-sub').textContent =
    protRem >= 0 ? `${Math.round(protRem)} left` : `${Math.round(-protRem)} over`;

  // CARBS ring (small: r=37, circ=232.48)
  const smCirc = 232.48;
  setRing('ring-carbs', tot.c, cg, smCirc);
  document.getElementById('ring-carbs-val').textContent = `${Math.round(tot.c)}g`;

  // FAT ring (small: r=37, circ=232.48)
  setRing('ring-fat', tot.f, fg, smCirc);
  document.getElementById('ring-fat-val').textContent = `${Math.round(tot.f)}g`;

  // Goal info text
  // Goal kcal is in the header meta; the hero lists the macro targets only.
  document.getElementById('goal-display').innerHTML = profile ? `
    <span class="gi-lbl">Targets</span>
    <span><b class="ring-label-protein">${pg}g</b> protein</span>
    <span><b class="ring-label-carbs">${cg}g</b> carbs</span>
    <span><b class="ring-label-fat">${fg}g</b> fat</span>
  ` : '';

  document.getElementById('log-date-label').textContent = isViewingToday() ? 'Today' : fmtDate(day);
  document.getElementById('day-next').disabled = isViewingToday();
  document.getElementById('hero-day').textContent = isViewingToday() ? 'today' : fmtDate(day);
  if (document.getElementById('view-today').classList.contains('active')) {
    document.getElementById('header-title').textContent = new Date(day + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long' });
  }

  // Snapshot streak tile (Progress pillar: open, teal)
  const streak = calcStreak();
  document.getElementById('snap-streak').textContent = streak;
  document.getElementById('snap-streak-sub').textContent = (logs => {
    const n = last7().filter(d => (logs[d] || []).length).length;
    return `${n}/7 this week`;
  })(getLogs());

  // Over/under projection — apply bias per confidence level
  // Research: restaurant/visual estimates typically undercount by 10-20%
  const projEl = document.getElementById('projection-display');
  if (entries.length > 0) {
    const projectedCal = entries.reduce((sum, e) => {
      const bias = e.conf == null || e.conf >= 90 ? 1.00 : e.conf >= 75 ? 1.10 : 1.18;
      return sum + (e.cal * bias);
    }, 0);
    const diff     = Math.round(projectedCal - tot.cal);
    const projTotal= Math.round(projectedCal);
    const vsGoal   = projTotal - goal;

    // ARC's coach voice: only speak when there's something to say (no "all good" nag).
    if (diff < 20) {
      projEl.classList.add('hidden');
    } else {
      const sign = vsGoal > 0 ? 'over' : 'under';
      projEl.innerHTML = `<div class="eyebrow eyebrow-coach">${icon('bot', 14)}Estimate check</div>
        <p>Portion estimates usually run low, so you're likely at <b>~${projTotal.toLocaleString()} kcal</b>, not ${Math.round(tot.cal).toLocaleString()}: +${diff} from ${entries.filter(e => e.conf != null && e.conf < 90).length} lower-confidence ${entries.filter(e => e.conf != null && e.conf < 90).length === 1 ? 'entry' : 'entries'}. That puts you ${vsGoal === 0 ? 'on target' : `${Math.abs(vsGoal).toLocaleString()} kcal ${sign} goal`}.</p>`;
      projEl.classList.remove('hidden');
    }
  } else {
    projEl.classList.add('hidden');
  }

  renderFoodLog(entries);
  renderFavourites();
  renderMetabolicToday(entries, day);
}

function renderFoodLog(entries) {
  const el = document.getElementById('food-log');
  const queued = getQueue().filter(q => q.date === activeDay());
  const pendingHTML = queued.map(q => `
    <div class="food-entry food-entry-pending">
      <div class="food-entry-info">
        <div class="food-entry-name">${esc(q.desc)}</div>
        <div class="food-entry-serving">Saved offline · looks up when you’re back online</div>
      </div>
    </div>`).join('');
  if (!entries.length && !queued.length) {
    el.innerHTML = `<div class="empty-log">${isViewingToday() ? 'Nothing logged yet. Describe a meal above, snap a photo, or tap a quick add.' : 'Nothing logged on this day. Add something above to backfill it.'}</div>`;
    return;
  }

  const order  = ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
  const groups = {};
  entries.forEach(e => {
    const m = mealFromTs(e.ts);
    (groups[m] = groups[m] || []).push(e);
  });

  el.innerHTML = order.filter(m => groups[m]).map(meal => `
    <div class="meal-group">
      <div class="meal-group-header">${meal}</div>
      ${groups[meal].map(e => {
        const acc = e.conf != null && e.conf < 90 ? e.conf : null;   // only flag the estimates the note talks about
        const fav = isFavEntry(e);
        return `
        <div class="food-entry" role="button" tabindex="0" data-entry-id="${esc(e.id)}" aria-label="Edit ${esc(e.name)}, ${Math.round(e.cal)} kcal">
          <div class="food-entry-info">
            <div class="food-entry-name">${e.fromPhoto ? icon('camera', 13) : ''}${fav ? `<span class="fav-mark">${icon('star', 12, true)}</span>` : ''}${esc(e.name)}</div>
            <div class="food-entry-serving">${esc(e.serving)}</div>
            <div class="food-entry-macros">
              <span class="mp">P ${Math.round(e.p)}g</span>
              <span class="mc">C ${Math.round(e.c)}g</span>
              <span class="mf">F ${Math.round(e.f)}g</span>
              ${glBadgeHTML(e)}
              ${acc ? `<span class="entry-accuracy entry-acc-${confClass(acc)}" title="Estimate confidence">~${acc}%</span>` : ''}
            </div>
          </div>
          <div class="food-entry-right">
            <div class="food-entry-cal">${Math.round(e.cal)}</div>
            <div class="food-entry-cal-sub">kcal</div>
          </div>
          <span class="food-entry-chev" aria-hidden="true">${icon('chevron-right', 16)}</span>
        </div>`;
      }).join('')}
    </div>
  `).join('') + pendingHTML;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Long edge 1568px, JPEG q0.82 — ~200–400 KB instead of a 3–12 MB original.
function downscaleImage(file, maxEdge = 1568) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve({ base64: c.toDataURL('image/jpeg', 0.82).split(',')[1], mediaType: 'image/jpeg' });
    };
    img.onerror = e => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The model's numbers are untrusted: strings concatenate and nulls NaN the totals.
function entryFromAI(n, ts, fromPhoto = false) {
  const num = v => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : NaN; };
  const cal = num(n.calories), p = num(n.protein_g), c = num(n.carbs_g), f = num(n.fat_g);
  if ([cal, p, c, f].some(Number.isNaN)) throw new Error('The AI returned incomplete numbers. Try again, or add more detail.');
  const gi = clampGI(n.glycemic_index);
  return {
    id: `${ts}-${Math.random().toString(36).slice(2, 6)}`, ts,
    name: String(n.name || 'Meal').slice(0, 120), serving: String(n.serving || '').slice(0, 120),
    cal, p, c, f, gi, gl: computeGL(gi, c), conf: confPct(n.confidence), fromPhoto,
  };
}
function addEntry(date, entry) {
  const logs = getLogs();
  (logs[date] = logs[date] || []).push(entry);
  saveLogs(logs);
}

// ── Offline queue: text descriptions typed without a connection ──
const getQueue = () => DB.get('cai_queue') || [];
function enqueueLookup(desc) {
  const q = getQueue();
  q.push({ id: Date.now().toString(), desc, date: activeDay(), ts: tsForActiveDay() });
  DB.set('cai_queue', q);
}
let queueRunning = false;
async function processQueue() {
  if (queueRunning || !navigator.onLine || !getQueue().length) return;
  queueRunning = true;
  try {
    for (const item of getQueue()) {
      try {
        const n = await lookupNutrition(item.desc, getApiKey());
        n.name = n.name || item.desc;
        addEntry(item.date, entryFromAI(n, item.ts));
        DB.set('cai_queue', getQueue().filter(q => q.id !== item.id));
      } catch (e) {
        if (e.network) break;   // still offline — try again on the next 'online'
        DB.set('cai_queue', getQueue().filter(q => q.id !== item.id));
        showToast(`Couldn’t look up “${item.desc}”: ${e.message}`);
      }
    }
  } finally {
    queueRunning = false;
    updateTodayView();
  }
}
window.addEventListener('online', processQueue);

let addInFlight = false;
async function addFood() {
  if (addInFlight) return;
  const input = document.getElementById('food-input');
  const desc  = input.value.trim();

  // Need at least text OR a photo
  if (!desc && !pendingPhoto) return;

  const apiKey = getApiKey();
  if (!apiKey && !arcUser) {
    showAddError('Sign in to your ARC account or add an API key in Profile.');
    return;
  }

  const btn     = document.getElementById('add-btn');
  const loading = document.getElementById('add-loading');
  const loadTxt = document.getElementById('loading-text');
  const errEl   = document.getElementById('add-error');

  const wasPhoto = !!pendingPhoto;
  addInFlight = true;
  btn.disabled = true;
  errEl.classList.add('hidden');

  try {
    let n;
    if (pendingPhoto && desc) {
      // Combined: photo + text context
      loadTxt.textContent = 'Analysing photo and context…';
      loading.classList.remove('hidden');
      n = await lookupNutritionFromImage(pendingPhoto.base64, pendingPhoto.mediaType, apiKey, desc);
    } else if (pendingPhoto) {
      // Photo only
      loadTxt.textContent = 'Analysing photo…';
      loading.classList.remove('hidden');
      n = await lookupNutritionFromImage(pendingPhoto.base64, pendingPhoto.mediaType, apiKey);
    } else {
      // Text only
      loadTxt.textContent = 'Looking up nutrition...';
      loading.classList.remove('hidden');
      n = await lookupNutrition(desc, apiKey);
    }

    n.name = n.name || desc;

    addEntry(activeDay(), entryFromAI(n, tsForActiveDay(), wasPhoto));
    input.value = '';
    if (wasPhoto) { clearPendingPhoto(); showToast('Photo logged'); }
    updateTodayView();
  } catch (err) {
    // Offline with a text description: keep it and look it up later.
    if (err.network && !wasPhoto && desc) {
      enqueueLookup(desc);
      input.value = '';
      updateTodayView();
      showToast('Offline. Saved, and will look it up when you’re back online.');
      return;
    }
    errEl.textContent = err.network && wasPhoto
      ? `${err.message} Photos need a connection. Try again, or tap “Enter manually”.`
      : err.message;
    errEl.classList.remove('hidden');
  } finally {
    addInFlight = false;
    btn.disabled = false;
    loading.classList.add('hidden');
  }
}

function showAddError(msg) {
  const el = document.getElementById('add-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function deleteEntry(id) {
  const logs = getLogs();
  const d    = activeDay();
  if (logs[d]) {
    logs[d] = logs[d].filter(e => e.id !== id);
    tombstone(d, id);   // so a synced copy on another device/ARC can't resurrect it
    saveLogs(logs);
    updateTodayView();
  }
}

// ── EDIT / ADD SHEET ───────────────────────────────────────────
// One sheet for editing an entry (tap its row) and for manual entry.
let editingId = null;

function findEntry(id) { return (getLogs()[activeDay()] || []).find(e => e.id === id); }

function openEditModal(id) {
  const entry = id ? findEntry(id) : null;
  if (id && !entry) return;
  editingId = id || null;
  const v = entry || { name: '', serving: '', cal: '', p: '', c: '', f: '' };
  document.getElementById('edit-title').textContent = entry ? 'Edit entry' : 'Add entry';
  document.getElementById('edit-name').value    = v.name;
  document.getElementById('edit-serving').value = v.serving;
  document.getElementById('edit-cal').value     = v.cal;
  document.getElementById('edit-protein').value = v.p;
  document.getElementById('edit-carbs').value   = v.c;
  document.getElementById('edit-fat').value     = v.f;
  document.getElementById('edit-error').classList.add('hidden');
  document.getElementById('edit-save-btn').textContent = entry ? 'Save changes' : 'Add entry';
  document.getElementById('edit-entry-actions').classList.toggle('hidden', !entry);
  if (entry) {
    const fav = isFavEntry(entry);
    document.getElementById('edit-fav-btn').innerHTML = `${icon('star', 16, fav)}${fav ? 'Remove from quick add' : 'Add to quick add'}`;
  }
  openSheet('edit-modal', entry ? null : 'edit-name');
}

function closeEditModal() {
  editingId = null;
  closeSheet('edit-modal');
}

function saveEdit() {
  const val = id => document.getElementById(id).value;
  const name = val('edit-name').trim();
  const nums = ['edit-cal', 'edit-protein', 'edit-carbs', 'edit-fat'].map(id => val(id) === '' ? 0 : Number(val(id)));
  const errEl = document.getElementById('edit-error');
  if (!name || nums.some(x => !Number.isFinite(x) || x < 0) || !(nums[0] > 0)) {
    errEl.textContent = 'Add a name and calories (numbers of 0 or more).';
    errEl.classList.remove('hidden');
    return;
  }
  const [cal, p, c, f] = nums;
  const logs = getLogs();
  const d    = activeDay();
  if (!editingId) {
    const ts = tsForActiveDay();
    (logs[d] = logs[d] || []).push({ id: `${ts}-m`, ts, name, serving: val('edit-serving').trim(), cal, p, c, f, gi: 0, gl: 0, conf: null, upd: Date.now() });
    saveLogs(logs);
    closeEditModal();
    updateTodayView();
    showToast(`Added ${name}`);
    return;
  }
  const idx = (logs[d] || []).findIndex(e => e.id === editingId);
  if (idx < 0) return;
  const gi = logs[d][idx].gi || 0;   // keep the food's GI; recompute load from edited carbs
  logs[d][idx] = {
    ...logs[d][idx],
    name, serving: val('edit-serving').trim(),
    cal, p, c, f,
    gi,
    gl:   computeGL(gi, c),
    conf: null, // manually edited — no confidence score
    upd:  Date.now()   // newest edit wins in the ARC sync merge
  };
  saveLogs(logs);
  closeEditModal();
  updateTodayView();
  showToast('Entry updated');
}

// ── Accessible bottom sheets: focus in, Tab trapped, Escape closes ──
let sheetReturnFocus = null;
function openSheet(id, focusId) {
  const el = document.getElementById(id);
  sheetReturnFocus = document.activeElement;
  el.classList.remove('hidden');
  const target = (focusId && document.getElementById(focusId)) || el.querySelector('.modal-close');
  setTimeout(() => target?.focus(), 50);
}
function closeSheet(id) {
  document.getElementById(id).classList.add('hidden');
  if (sheetReturnFocus && document.contains(sheetReturnFocus)) sheetReturnFocus.focus();
  sheetReturnFocus = null;
}
document.addEventListener('keydown', e => {
  const open = [...document.querySelectorAll('.modal-overlay')].find(m => !m.classList.contains('hidden'));
  if (!open) return;
  if (e.key === 'Escape') { open.id === 'gki-modal' ? closeGkiModal() : closeEditModal(); return; }
  if (e.key !== 'Tab') return;
  const f = [...open.querySelectorAll('button, input, select, [tabindex="0"]')].filter(x => !x.disabled && x.offsetParent);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// ── FAVOURITES ─────────────────────────────────────────────────
// A favourite is linked to entries by id: `favId` is the source entry's id, and
// entries added from quick add carry `favRef`. Matching on name+kcal broke as
// soon as an entry was edited (a second star added a duplicate).
function favFor(entry, favs = getFavs()) {
  return favs.find(f => f.favId === entry.id || (entry.favRef && f.favId === entry.favRef))
    || favs.find(f => !f.favId && f.name === entry.name);
}
const isFavEntry = e => !!favFor(e);

function toggleFavourite(entryId) {
  const entry = findEntry(entryId);
  if (!entry) return;
  const favs = getFavs();
  const existing = favFor(entry, favs);
  if (existing) {
    saveFavs(favs.filter(f => f !== existing));
    showToast('Removed from quick add');
  } else {
    favs.push({ favId: entry.favRef || entry.id, name: entry.name, serving: entry.serving, cal: entry.cal, p: entry.p, c: entry.c, f: entry.f, gi: entry.gi || 0, gl: entryGL(entry) });
    saveFavs(favs);
    showToast('Saved to quick add');
  }
  updateTodayView();
}

function quickAddFavourite(fav) {
  const ts = tsForActiveDay();
  addEntry(activeDay(), {
    id:      `${ts}-q`,
    ts,
    favRef:  fav.favId,
    name:    fav.name,
    serving: fav.serving,
    cal:     fav.cal,
    p:       fav.p,
    c:       fav.c,
    f:       fav.f,
    gi:      fav.gi || 0,
    gl:      typeof fav.gl === 'number' ? fav.gl : computeGL(fav.gi || 0, fav.c),
    conf:    null
  });
  updateTodayView();
  showToast(`Added ${fav.name}`);
}

let favManage = false;
function renderFavourites() {
  const favs    = getFavs();
  const section = document.getElementById('fav-section');
  const chips   = document.getElementById('fav-chips');

  if (!favs.length) { favManage = false; section.classList.add('hidden'); return; }
  section.classList.remove('hidden');
  document.getElementById('fav-manage-btn').textContent = favManage ? 'Done' : 'Edit';
  chips.classList.toggle('managing', favManage);

  chips.innerHTML = favs.map((f, i) => `
    <button type="button" class="fav-chip" data-fav-idx="${i}" aria-label="${favManage ? `Remove ${esc(f.name)} from quick add` : `Add ${esc(f.name)}, ${Math.round(f.cal)} kcal`}">
      ${favManage ? `<span class="fav-chip-x" aria-hidden="true">${icon('x', 12)}</span>` : ''}
      <div class="fav-chip-name">${esc(f.name)}</div>
      <div class="fav-chip-cal">${Math.round(f.cal)} kcal</div>
      <div class="fav-chip-macros">P${Math.round(f.p)} C${Math.round(f.c)} F${Math.round(f.f)}</div>
    </button>
  `).join('');
}

// ── STATS VIEW ─────────────────────────────────────────────────
function last14() {
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - (13 - i));
    return ymdLocal(d);
  });
}
function last7() { return last14().slice(7); }

function calcStreak() {
  const logs = getLogs();
  let streak = 0;
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  if (!(logs[todayStr()] || []).length) d.setDate(d.getDate() - 1);
  while (true) {
    const k = ymdLocal(d);
    if (!(logs[k] || []).length) break;
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

function renderStats() {
  const profile = getProfile();
  if (!profile) return;

  const bmi  = calcBMI(profile);
  const tdee = calcTDEE(profile);
  document.getElementById('stat-bmi').textContent     = bmi;
  document.getElementById('stat-bmi-cat').textContent = bmiCat(parseFloat(bmi));
  document.getElementById('stat-tdee').textContent    = tdee.toLocaleString();

  const logs  = getLogs();
  // Last 7 complete days — today is still in progress and would drag it down.
  const days7 = last14().slice(6, 13).map(d => (logs[d] || []).reduce((s, e) => s + e.cal, 0)).filter(x => x > 0);
  const avg   = days7.length ? Math.round(days7.reduce((a, b) => a + b, 0) / days7.length) : 0;
  document.getElementById('stat-avg').textContent    = avg ? avg.toLocaleString() : '--';
  document.getElementById('stat-streak').textContent = calcStreak();

  loadCharts().then(() => {
    renderCalChart(logs, profile);
    renderMacroChart(logs);
    renderMetabolicStats();
    renderWeightChartIn('chart-weight-stats', 'weightStats');
  }).catch(() => showToast('Charts couldn’t load. Check your connection.'));
}

// Chart.js is only needed on Progress/Body, so it loads on first use (pinned,
// with Subresource Integrity) instead of on every launch.
const CHART_SRC = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.js';
const CHART_SRI = 'sha384-FcQlsUOd0TJjROrBxhJdUhXTUgNJQxTMcxZe6nHbaEfFL1zjQ+bq/uRoBQxb0KMo';
let chartPromise = null;
function loadCharts() {
  if (window.Chart) return Promise.resolve();
  if (!chartPromise) {
    chartPromise = new Promise((resolve, reject) => {
      const s = Object.assign(document.createElement('script'), { src: CHART_SRC, integrity: CHART_SRI, crossOrigin: 'anonymous' });
      s.onload = resolve;
      s.onerror = () => { chartPromise = null; reject(new Error('Chart.js failed to load')); };
      document.head.appendChild(s);
    });
  }
  return chartPromise;
}

function renderCalChart(logs, profile) {
  const days  = last14();
  const goal  = goalCals(profile);
  const data  = days.map(d => Math.round((logs[d] || []).reduce((s, e) => s + e.cal, 0)));
  const labels = days.map(d => {
    const dt = new Date(d + 'T00:00:00');
    return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  });

  const ctx = document.getElementById('chart-calories').getContext('2d');
  if (charts.calories) charts.calories.destroy();
  charts.calories = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          data,
          backgroundColor: data.map(v => v === 0 ? '#262a2f' : v > goal * 1.05 ? '#d88685' : '#d6b48e'),
          borderRadius: 4,
          order: 2
        },
        {
          type: 'line',
          data: new Array(14).fill(goal),
          borderColor: '#979ca4',
          borderWidth: 1.5,
          borderDash: [4, 4],
          pointRadius: 0,
          order: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${c.raw} kcal` } } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 9 }, color: '#979ca4' } },
        y: { grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { font: { size: 9 }, color: '#979ca4' } }
      }
    }
  });
}

function renderMacroChart(logs) {
  const days = last7();
  let p = 0, c = 0, f = 0, n = 0;
  days.forEach(d => {
    const entries = logs[d] || [];
    if (!entries.length) return;
    n++;
    entries.forEach(e => { p += e.p; c += e.c; f += e.f; });
  });
  if (!n) { if (charts.macros) { charts.macros.destroy(); charts.macros = null; } return; }

  const ctx = document.getElementById('chart-macros').getContext('2d');
  if (charts.macros) charts.macros.destroy();
  charts.macros = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Protein', 'Carbs', 'Fat'],
      datasets: [{
        // Share of calories (fat is 9 kcal/g), not grams — grams understate fat.
        data: [Math.round(p * 4 / n), Math.round(c * 4 / n), Math.round(f * 9 / n)],
        backgroundColor: ['#9fb8cc', '#cfc07e', '#d49ab8'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { font: { size: 11 }, padding: 10, color: '#979ca4' } },
        tooltip: { callbacks: { label: c => {
          const tot = c.dataset.data.reduce((a, b) => a + b, 0) || 1;
          return `${c.label}: ${c.raw} kcal/day (${Math.round(c.raw / tot * 100)}%)`;
        } } }
      }
    }
  });
}

function renderWeightChartIn(canvasId, chartKey) {
  const weights = getWeights().slice(-60);
  if (weights.length < 2) { if (charts[chartKey]) { charts[chartKey].destroy(); charts[chartKey] = null; } return; }
  const ctx = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return;
  if (charts[chartKey]) charts[chartKey].destroy();
  charts[chartKey] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: weights.map(w => {
        const d = new Date(w.date + 'T00:00:00');
        return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      }),
      datasets: [{
        data: weights.map(w => w.kg),
        borderColor: '#d6b48e',
        backgroundColor: 'rgba(214,180,142,0.08)',
        borderWidth: 2,
        pointRadius: 3,
        fill: true,
        tension: 0.3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 9 }, color: '#979ca4' } },
        y: { grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { font: { size: 9 }, color: '#979ca4' } }
      }
    }
  });
}

// ── WEIGHT VIEW ────────────────────────────────────────────────
function renderWeightView() {
  renderWeightHistory();
  loadCharts().then(() => renderWeightChartIn('chart-weight', 'weight')).catch(() => {});
}

function logWeight() {
  const input = document.getElementById('weight-input');
  const kg    = parseFloat(input.value);
  const errEl = document.getElementById('weight-error');

  if (!kg || kg < 20 || kg > 500) {
    errEl.textContent = 'Enter a valid weight.';
    errEl.classList.remove('hidden');
    return;
  }
  errEl.classList.add('hidden');

  const weights = getWeights();
  const d = todayStr();
  const i = weights.findIndex(w => w.date === d);
  if (i >= 0) { weights[i].kg = kg; weights[i].upd = Date.now(); } else weights.push({ date: d, kg, upd: Date.now() });
  weights.sort((a, b) => a.date.localeCompare(b.date));
  saveWeights(weights);

  // keep profile weight in sync
  const profile = getProfile();
  if (profile) { profile.weight = kg; saveProfile(profile); }

  input.value = '';
  showToast('Weight logged!');
  renderWeightView();
}

function renderWeightHistory() {
  const weights = getWeights().slice().reverse().slice(0, 30);
  const el      = document.getElementById('weight-history-list');

  if (!weights.length) {
    el.innerHTML = '<div class="empty-log">No weight entries yet.</div>';
    return;
  }
  el.innerHTML = weights.map(w => `
    <div class="weight-entry">
      <span class="weight-entry-date">${fmtDate(w.date)}</span>
      <span class="weight-entry-val">${w.kg} kg</span>
    </div>
  `).join('');
}

// ── PROFILE VIEW ───────────────────────────────────────────────
function renderProfileView() {
  const p = getProfile();
  if (!p) return;
  document.getElementById('p-name').value     = p.name     || '';
  document.getElementById('p-age').value      = p.age      || '';
  document.getElementById('p-sex').value      = p.sex      || 'male';
  document.getElementById('p-height').value   = p.height   || '';
  document.getElementById('p-weight').value   = p.weight   || '';
  document.getElementById('p-activity').value = p.activity || '1.55';
  document.getElementById('p-goal').value     = goalCals(p);
  document.getElementById('p-api-key').value  = getApiKey();

  const mt = p.macroTargets || {};
  const goal = goalCals(p);
  document.getElementById('p-macro-protein').value = mt.protein || Math.round(goal * 0.30 / 4);
  document.getElementById('p-macro-carbs').value   = mt.carbs   || Math.round(goal * 0.45 / 4);
  document.getElementById('p-macro-fat').value     = mt.fat     || Math.round(goal * 0.25 / 9);
  updateMacroCalPreview();

  // Cloud backup state
  document.getElementById('p-gist-token').value = getGistToken();
  const connected = cloudEnabled();
  document.getElementById('gist-disconnect-btn').classList.toggle('hidden', !connected);
  document.getElementById('gist-connect-btn').textContent = connected ? 'Back Up Now' : 'Connect & Back Up Now';
  if (connected && !document.getElementById('sync-status').textContent.trim()) {
    setSyncStatus('Connected');
  } else if (!connected) {
    setSyncStatus('Not connected');
  }
}

function updateMacroCalPreview() {
  const p = parseInt(document.getElementById('p-macro-protein').value) || 0;
  const c = parseInt(document.getElementById('p-macro-carbs').value)   || 0;
  const f = parseInt(document.getElementById('p-macro-fat').value)     || 0;
  const kcal = p * 4 + c * 4 + f * 9;
  document.getElementById('macro-cal-preview').textContent = kcal ? `${kcal.toLocaleString()} kcal` : '--';
  const prof = getProfile();
  const gap = prof && kcal ? kcal - goalCals(prof) : 0;
  const note = document.getElementById('macro-goal-note');
  note.textContent = !prof || !kcal ? '' : Math.abs(gap) < 25 ? 'Matches your daily goal.'
    : `${Math.abs(gap).toLocaleString()} kcal ${gap > 0 ? 'above' : 'below'} your ${goalCals(prof).toLocaleString()} kcal goal.`;
  document.getElementById('macro-fit-btn').classList.toggle('hidden', !prof || !kcal || Math.abs(gap) < 25);
}

// Keep protein and fat, fill the rest of the calorie goal with carbs.
function fitMacrosToGoal() {
  const prof = getProfile(); if (!prof) return;
  const p = parseInt(document.getElementById('p-macro-protein').value) || 0;
  const f = parseInt(document.getElementById('p-macro-fat').value) || 0;
  document.getElementById('p-macro-carbs').value = Math.max(0, Math.round((goalCals(prof) - p * 4 - f * 9) / 4));
  updateMacroCalPreview();
}

function saveProfileFromForm() {
  const old = getProfile() || {};
  const v = id => document.getElementById(id).value;
  const age = parseInt(v('p-age')), height = parseFloat(v('p-height')), weight = parseFloat(v('p-weight'));
  const goalIn = parseInt(v('p-goal'));
  const bad = !v('p-name').trim() ? 'Enter your name.'
    : !(age >= 10 && age <= 120) ? 'Enter an age from 10 to 120.'
    : !(height >= 100 && height <= 260) ? 'Enter a height from 100 to 260 cm.'
    : !(weight >= 20 && weight <= 500) ? 'Enter a weight from 20 to 500 kg.'
    : !(goalIn >= 800 && goalIn <= 10000) ? 'Enter a daily goal from 800 to 10,000 kcal.' : '';
  if (bad) { showToast(bad); return; }

  const p = { ...old, name: v('p-name').trim(), age, sex: v('p-sex'), height, weight, activity: v('p-activity') };
  // Only a goal you typed becomes a fixed custom goal. Otherwise keep the goal
  // type (maintain/cut/bulk) so it keeps following weight and activity.
  if (goalIn !== goalCals(old)) { p.goalType = 'custom'; p.customGoal = goalIn; }
  saveProfile(p);
  renderProfileView();
  showToast('Profile saved');
  updateTodayView();
}

// ── SETUP ──────────────────────────────────────────────────────
let setupGoalType = 'tdee';

function initSetup() {
  document.querySelectorAll('.goal-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.goal-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      setupGoalType = btn.dataset.goal;
      document.getElementById('s-custom-goal').classList.toggle('hidden', setupGoalType !== 'custom');
    });
  });

  document.getElementById('setup-btn').addEventListener('click', handleSetup);
}

function handleSetup() {
  const apiKey   = document.getElementById('api-key-input').value.trim();
  const name     = document.getElementById('s-name').value.trim();
  const age      = parseInt(document.getElementById('s-age').value);
  const sex      = document.getElementById('s-sex').value;
  const height   = parseFloat(document.getElementById('s-height').value);
  const weight   = parseFloat(document.getElementById('s-weight').value);
  const activity = document.getElementById('s-activity').value;
  const errEl    = document.getElementById('setup-error');

  const fail = msg => { errEl.textContent = msg; errEl.classList.remove('hidden'); };

  if (!arcUser && !apiKey.startsWith('sk-')) return fail('Sign in to your ARC account above, or enter an Anthropic API key (starts with sk-)');
  if (apiKey && !apiKey.startsWith('sk-'))    return fail('That API key doesn’t look right (it starts with sk-)');
  if (!name)                           return fail('Please enter your name');
  if (!age || age < 10 || age > 120)   return fail('Enter a valid age');
  if (!height || height < 100 || height > 260) return fail('Enter a valid height in cm');
  if (!weight || weight < 20 || weight > 500)  return fail('Enter a valid weight in kg');

  let customGoal = null;
  if (setupGoalType === 'custom') {
    customGoal = parseInt(document.getElementById('s-custom-goal').value);
    if (!customGoal || customGoal < 500 || customGoal > 10000)
      return fail('Enter a valid calorie goal (500–10000)');
  }

  if (apiKey) saveApiKey(apiKey);
  saveProfile({ name, age, sex, height, weight, activity, goalType: setupGoalType, customGoal });

  const weights = getWeights();
  if (!weights.find(w => w.date === todayStr()))
    saveWeights([...weights, { date: todayStr(), kg: weight }]);

  launchApp();
}

// ── APP BOOT ───────────────────────────────────────────────────
function launchApp() {
  document.getElementById('setup-screen').classList.add('hidden');
  document.getElementById('main-app').classList.remove('hidden');
  navigate('today');
  updateTodayView();
}

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.setAttribute('aria-live', 'polite');
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => t.classList.add('show'));
  });
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, 2500);
}

function initEvents() {
  document.querySelectorAll('.nav-item, [data-view-link]').forEach(btn =>
    btn.addEventListener('click', () => navigate(btn.dataset.view || btn.dataset.viewLink)));

  document.getElementById('add-btn').addEventListener('click', addFood);
  document.getElementById('fav-chips').addEventListener('click', e => {
    const chip = e.target.closest('[data-fav-idx]');
    const favs = getFavs();
    const fav = chip && favs[+chip.dataset.favIdx];
    if (!fav) return;
    if (favManage) { saveFavs(favs.filter(f => f !== fav)); renderFavourites(); showToast(`Removed ${fav.name}`); }
    else quickAddFavourite(fav);
  });
  document.getElementById('food-input').addEventListener('keypress', e => {
    if (e.key === 'Enter') addFood();
  });

  // Camera — stage the photo, don't submit yet
  document.getElementById('camera-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    let base64, mediaType;
    try { ({ base64, mediaType } = await downscaleImage(file)); }
    catch { base64 = await fileToBase64(file); mediaType = file.type || 'image/jpeg'; }
    pendingPhoto = { base64, mediaType };

    // Show preview
    document.getElementById('photo-thumb').src        = `data:${mediaType};base64,${base64}`;
    document.getElementById('photo-preview-row').classList.remove('hidden');
    document.getElementById('food-input').placeholder = 'Add context: portion size, restaurant name... (optional)';
    document.getElementById('food-input').focus();
    e.target.value = '';
  });

  // Clear pending photo
  document.getElementById('photo-clear-btn').addEventListener('click', clearPendingPhoto);

  // Edit modal
  document.getElementById('modal-close').addEventListener('click', closeEditModal);
  document.getElementById('edit-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('edit-modal')) closeEditModal();
  });
  document.getElementById('edit-save-btn').addEventListener('click', saveEdit);

  // Quick add: Edit toggles per-chip removal
  document.getElementById('fav-manage-btn').addEventListener('click', () => {
    favManage = !favManage;
    renderFavourites();
  });

  // Food log: tap (or Enter/Space on) a row to open its edit sheet
  const logEl = document.getElementById('food-log');
  logEl.addEventListener('click', e => {
    const row = e.target.closest('[data-entry-id]');
    if (row) openEditModal(row.dataset.entryId);
  });
  logEl.addEventListener('keydown', e => {
    const row = e.target.closest('[data-entry-id]');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openEditModal(row.dataset.entryId); }
  });
  document.getElementById('edit-fav-btn').addEventListener('click', () => {
    const id = editingId; closeEditModal(); toggleFavourite(id);
  });
  document.getElementById('edit-delete-btn').addEventListener('click', () => {
    const id = editingId, e = findEntry(id);
    closeEditModal();
    if (e) { deleteEntry(id); showToast(`Deleted ${e.name}`); }
  });
  document.getElementById('manual-add-btn').addEventListener('click', () => openEditModal(null));
  document.getElementById('day-prev').addEventListener('click', () => shiftViewDay(-1));
  document.getElementById('day-next').addEventListener('click', () => shiftViewDay(1));

  // Metabolic — GKI blood-reading modal
  document.getElementById('log-gki-btn').addEventListener('click', openGkiModal);
  document.getElementById('gki-close').addEventListener('click', closeGkiModal);
  document.getElementById('gki-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('gki-modal')) closeGkiModal();
  });
  document.getElementById('gki-save-btn').addEventListener('click', saveGkiReading);
  ['gki-glucose', 'gki-ketones'].forEach(id =>
    document.getElementById(id).addEventListener('input', updateGkiPreview));

  document.getElementById('log-weight-btn').addEventListener('click', logWeight);
  document.getElementById('weight-input').addEventListener('keypress', e => {
    if (e.key === 'Enter') logWeight();
  });

  document.getElementById('save-profile-btn').addEventListener('click', saveProfileFromForm);

  // Macro targets
  document.getElementById('save-macros-btn').addEventListener('click', () => {
    const p = getProfile();
    if (!p) return;
    const protein = parseInt(document.getElementById('p-macro-protein').value);
    const carbs   = parseInt(document.getElementById('p-macro-carbs').value);
    const fat     = parseInt(document.getElementById('p-macro-fat').value);
    if (!protein || !carbs || !fat) { showToast('Fill in all three macro targets'); return; }
    p.macroTargets = { protein, carbs, fat };
    saveProfile(p);
    showToast('Macro targets saved!');
    updateTodayView();
  });

  document.getElementById('macro-fit-btn').addEventListener('click', fitMacrosToGoal);

  // Live kcal preview as user types macro targets
  ['p-macro-protein','p-macro-carbs','p-macro-fat'].forEach(id => {
    document.getElementById(id).addEventListener('input', updateMacroCalPreview);
  });

  document.getElementById('save-api-btn').addEventListener('click', () => {
    const k = document.getElementById('p-api-key').value.trim();
    if (k) { saveApiKey(k); showToast('API key updated!'); }
  });

  // ── Cloud backup handlers ──
  document.getElementById('gist-connect-btn').addEventListener('click', async () => {
    const token = document.getElementById('p-gist-token').value.trim();
    if (!token) { setSyncStatus('Enter a token first'); return; }
    if (token !== getGistToken()) localStorage.removeItem('cai_gist_id');
    setGistToken(token);
    setSyncStatus('Connecting…');
    try {
      // A backup may already exist (reinstall / new device). Pushing now would
      // replace that history with this device's data, so restore first.
      const existing = await cloudPull().catch(() => null);
      if (existing && existing.lastModified > (getMeta().lastModified || 0)) {
        applyBackupPayload(existing);
        updateTodayView(); renderProfileView();
        setSyncStatus(`Restored cloud backup from ${new Date(existing.lastModified).toLocaleString('en-GB')}`);
        showToast('Restored from cloud');
        document.getElementById('gist-disconnect-btn').classList.remove('hidden');
        return;
      }
      await cloudPush();
      showToast('Backed up to cloud');
      document.getElementById('gist-disconnect-btn').classList.remove('hidden');
      document.getElementById('gist-connect-btn').textContent = 'Back Up Now';
    } catch (e) {
      setSyncStatus(`Failed: ${e.message}`);
    }
  });

  document.getElementById('gist-restore-btn').addEventListener('click', async () => {
    const token = document.getElementById('p-gist-token').value.trim() || getGistToken();
    if (!token) { setSyncStatus('Enter your token first'); return; }
    setGistToken(token);
    if (!confirm('Restore from cloud? This overwrites your current data on this device.')) return;
    setSyncStatus('Restoring…');
    try {
      const cloud = await cloudPull();
      if (!cloud) { setSyncStatus('No backup found for this token'); return; }
      applyBackupPayload(cloud);
      showToast('Restored from cloud');
      renderProfileView();
      updateTodayView();
      setSyncStatus(`Restored: ${new Date(cloud.lastModified).toLocaleString('en-GB')}`);
    } catch (e) {
      setSyncStatus(`Failed: ${e.message}`);
    }
  });

  document.getElementById('gist-disconnect-btn').addEventListener('click', () => {
    if (!confirm('Disconnect cloud backup? Your data stays on this device and in the gist, but auto-backup stops.')) return;
    localStorage.removeItem('cai_gist_token');
    localStorage.removeItem('cai_gist_id');
    document.getElementById('p-gist-token').value = '';
    document.getElementById('gist-disconnect-btn').classList.add('hidden');
    document.getElementById('gist-connect-btn').textContent = 'Connect & Back Up Now';
    setSyncStatus('Not connected');
    showToast('Disconnected');
  });

  // ── Setup screen restore ──
  document.getElementById('setup-restore-btn').addEventListener('click', () => {
    document.getElementById('restore-panel').classList.toggle('hidden');
  });

  document.getElementById('restore-go-btn').addEventListener('click', async () => {
    const token  = document.getElementById('restore-token').value.trim();
    const status = document.getElementById('restore-status');
    if (!token) { status.textContent = 'Enter your token'; return; }
    setGistToken(token);
    status.textContent = 'Searching for your backup…';
    try {
      const cloud = await cloudPull();
      if (!cloud || !cloud.profile) { status.textContent = 'No backup found for this token'; return; }
      applyBackupPayload(cloud);
      status.textContent = 'Restored! Loading…';
      launchApp();
      updateTodayView();
      showToast('Restored from cloud');
    } catch (e) {
      status.textContent = `Failed: ${e.message}`;
    }
  });

  document.getElementById('export-btn').addEventListener('click', async () => {
    const data = {
      app: 'arc-fuel', exported: new Date().toISOString(),
      profile: getProfile(), logs: getLogs(), weights: getWeights(), favs: getFavs(), gki: getGki()
    };
    const name = `arc-fuel-${todayStr()}.json`;
    const file = new File([JSON.stringify(data, null, 2)], name, { type: 'application/json' });
    // iOS home-screen apps ignore <a download>; the share sheet can save to Files.
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'ARC Fuel export' }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);   // revoking at once can cancel the download
  });

  document.getElementById('clear-btn').addEventListener('click', () => {
    if (confirm(arcUser ? 'Delete all data on this device? Your ARC cloud copy is kept and will restore on next sync — sign out first to keep this device empty.' : 'Delete all data? This cannot be undone.')) {
      // Same origin as ARC (joejohnston72-dev.github.io) — never localStorage.clear().
      Object.keys(localStorage).filter(k => k.startsWith('cai_')).forEach(k => localStorage.removeItem(k));
      location.reload();
    }
  });
}

var lastShownDay = null;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !getProfile()) return;
  if (lastShownDay !== todayStr()) updateTodayView();
  processQueue();
  if (cloudEnabled()) syncOnLaunch().then(changed => { if (changed) { updateTodayView(); renderProfileView(); } });
  arcSync().then(changed => { if (changed) refreshAfterArcSync(); renderTrainTile(); });
});

function init() {
  initSetup();
  initEvents();
  initArcSync();
  lastShownDay = todayStr();
  setTimeout(processQueue, 1500);
  if (getProfile()) {
    launchApp();
    // Background sync: pull newer data from other devices, then refresh
    if (cloudEnabled()) {
      syncOnLaunch().then(changed => {
        if (changed) { updateTodayView(); renderProfileView(); }
      });
    }
  } else {
    document.getElementById('setup-screen').classList.remove('hidden');
    document.getElementById('main-app').classList.add('hidden');
  }
}

// register service worker for PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
