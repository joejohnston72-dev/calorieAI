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

const getLogs    = ()    => DB.get(K.LOGS)    || {};
const saveLogs   = v     => DB.set(K.LOGS, v);
const getWeights = ()    => DB.get(K.WEIGHTS) || [];
const saveWeights= v     => DB.set(K.WEIGHTS, v);
const getProfile = ()    => DB.get(K.PROFILE);
const saveProfile= v     => DB.set(K.PROFILE, v);
const getApiKey  = ()    => DB.get(K.API) || '';
const saveApiKey = v     => DB.set(K.API, v);
const getFavs    = ()    => DB.get('cai_favs') || [];
const saveFavs   = v     => DB.set('cai_favs', v);

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
const todayStr = () => new Date().toISOString().slice(0, 10);

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
  if (p.goalType === 'cut')    return tdee - 500;
  if (p.goalType === 'bulk')   return tdee + 300;
  if (p.goalType === 'custom') return parseInt(p.customGoal) || tdee;
  return tdee;
}

// ── CLAUDE API ─────────────────────────────────────────────────
async function callClaude(messages, apiKey, maxTokens = 300) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${res.status}`);
  }
  const data = await res.json();
  const text = data.content[0].text.trim();
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

Respond with ONLY valid JSON, no other text:
{
  "name": "clean short display name",
  "serving": "serving description used (e.g. '2 large eggs', '1 can 400g')",
  "calories": <integer>,
  "protein_g": <number to 1dp>,
  "carbs_g": <number to 1dp>,
  "fat_g": <number to 1dp>,
  "confidence": "high|medium|low"
}`;

  return callClaude([{ role: 'user', content: prompt }], apiKey);
}

async function lookupNutritionFromImage(base64, mediaType, apiKey, extraContext = '') {
  const contextLine = extraContext
    ? `\nExtra context from user: "${extraContext}" — use this to refine your estimate (e.g. portion size, restaurant name, cooking method).`
    : '';

  const prompt = `Analyse this food photo and estimate the nutrition information.${contextLine}

Identify all food items visible. Estimate portion sizes using visual cues (plate size, utensils, hands, packaging for scale).
Be systematic: list what you see, estimate weights/quantities, then calculate nutrition.

Respond with ONLY this JSON (no other text):
{
  "name": "brief meal description",
  "serving": "estimated portions e.g. 'approx 150g chicken, 200g rice'",
  "calories": <integer>,
  "protein_g": <number to 1dp>,
  "carbs_g": <number to 1dp>,
  "fat_g": <number to 1dp>,
  "confidence": "high|medium|low"
}`;

  return callClaude([{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
      { type: 'text', text: prompt }
    ]
  }], apiKey, 400);
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

  const titles = { today: 'Today', stats: 'Stats', weight: 'Weight', profile: 'Profile' };
  document.getElementById('header-title').textContent = titles[view];

  const profile = getProfile();
  if (view === 'today' && profile) {
    document.getElementById('header-sub').textContent = `Goal: ${goalCals(profile).toLocaleString()} kcal`;
  } else {
    document.getElementById('header-sub').textContent = '';
  }

  if (view === 'stats')   renderStats();
  if (view === 'weight')  renderWeightView();
  if (view === 'profile') renderProfileView();
}

// ── TODAY VIEW ─────────────────────────────────────────────────
function updateTodayView() {
  const profile = getProfile();
  const logs    = getLogs();
  const entries = logs[todayStr()] || [];

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
    tot.cal > goal * 1.05 ? '#ef4444' : '#22c55e';
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
  document.getElementById('goal-display').innerHTML = profile ? `
    Goal: <strong>${goal.toLocaleString()}</strong> kcal<br>
    Protein: <strong>${pg}g</strong> · Carbs: <strong>${cg}g</strong> · Fat: <strong>${fg}g</strong>
  ` : '';

  document.getElementById('log-date-label').textContent = fmtDate(todayStr());

  // Over/under projection — apply bias per confidence level
  // Research: restaurant/visual estimates typically undercount by 10-20%
  const projEl = document.getElementById('projection-display');
  if (entries.length > 0) {
    const projectedCal = entries.reduce((sum, e) => {
      const bias = e.conf >= 90 ? 1.00 : e.conf >= 75 ? 1.10 : 1.18;
      return sum + (e.cal * bias);
    }, 0);
    const diff     = Math.round(projectedCal - tot.cal);
    const projTotal= Math.round(projectedCal);
    const vsGoal   = projTotal - goal;

    if (diff < 20) {
      // All high confidence — logged is accurate
      projEl.className = 'projection-display proj-on';
      projEl.textContent = '✓ Estimates look accurate';
    } else {
      const sign  = vsGoal > 0 ? 'over' : 'under';
      const absDiff = Math.abs(vsGoal);
      const cls   = vsGoal > goal * 0.1 ? 'proj-exceed' : vsGoal > 0 ? 'proj-over' : 'proj-on';
      projEl.className = `projection-display ${cls}`;
      projEl.innerHTML = `⚠ Likely actual: ~${projTotal.toLocaleString()} kcal<br><span style="font-weight:400">+${diff} from portion estimates · ${absDiff > 0 ? Math.abs(vsGoal).toLocaleString()+' kcal '+sign+' goal' : 'on target'}</span>`;
    }
    projEl.classList.remove('hidden');
  } else {
    projEl.classList.add('hidden');
  }

  // Accuracy badge — weighted average of entries that have conf
  const confEntries = entries.filter(e => e.conf);
  const badge = document.getElementById('accuracy-badge');
  if (confEntries.length) {
    const avg = Math.round(confEntries.reduce((s, e) => s + e.conf, 0) / confEntries.length);
    const cls = confClass(avg);
    badge.textContent = `~${avg}% accurate`;
    badge.className   = `accuracy-badge accuracy-${cls}`;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  renderFoodLog(entries);
  renderFavourites();
}

function renderFoodLog(entries) {
  const el = document.getElementById('food-log');
  if (!entries.length) {
    el.innerHTML = '<div class="empty-log">No food logged yet.<br>Add something above!</div>';
    return;
  }

  const order  = ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
  const groups = {};
  entries.forEach(e => {
    const m = mealFromTs(e.ts);
    (groups[m] = groups[m] || []).push(e);
  });

  const favIds = new Set(getFavs().map(f => f.favId));

  el.innerHTML = order.filter(m => groups[m]).map(meal => `
    <div class="meal-group">
      <div class="meal-group-header">${meal}</div>
      ${groups[meal].map(e => {
        const accPct = e.conf || null;
        const accCls = accPct ? confClass(accPct) : '';
        const isFav  = favIds.has(e.id) || getFavs().some(f => f.name === e.name && f.cal === e.cal);
        return `
        <div class="food-entry">
          <div class="food-entry-info">
            <div class="food-entry-name">${e.fromPhoto ? '📷 ' : ''}${esc(e.name)}</div>
            <div class="food-entry-serving">${esc(e.serving)}</div>
            <div class="food-entry-macros">
              <span class="mp">P ${Math.round(e.p)}g</span>
              <span class="mc">C ${Math.round(e.c)}g</span>
              <span class="mf">F ${Math.round(e.f)}g</span>
              ${accPct ? `<span class="entry-accuracy entry-acc-${accCls}">~${accPct}%</span>` : ''}
            </div>
          </div>
          <div class="food-entry-right">
            <div class="food-entry-cal">${Math.round(e.cal)}</div>
            <div class="food-entry-cal-sub">kcal</div>
          </div>
          <div class="entry-actions">
            <button class="entry-action-btn" onclick="openEditModal('${e.id}')" title="Edit">✏️</button>
            <button class="entry-action-btn" onclick="toggleFavourite('${e.id}')" title="${isFav ? 'Remove favourite' : 'Save as favourite'}">${isFav ? '⭐' : '☆'}</button>
            <button class="entry-action-btn" onclick="deleteEntry('${e.id}')" title="Delete">×</button>
          </div>
        </div>`;
      }).join('')}
    </div>
  `).join('');
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function addFood() {
  const input = document.getElementById('food-input');
  const desc  = input.value.trim();

  // Need at least text OR a photo
  if (!desc && !pendingPhoto) return;

  const apiKey = getApiKey();
  if (!apiKey) {
    showAddError('No API key — go to Profile to add one.');
    return;
  }

  const btn     = document.getElementById('add-btn');
  const loading = document.getElementById('add-loading');
  const loadTxt = document.getElementById('loading-text');
  const errEl   = document.getElementById('add-error');

  btn.disabled = true;
  errEl.classList.add('hidden');

  try {
    let n;
    if (pendingPhoto && desc) {
      // Combined: photo + text context
      loadTxt.textContent = '📷 Analysing photo + context...';
      loading.classList.remove('hidden');
      n = await lookupNutritionFromImage(pendingPhoto.base64, pendingPhoto.mediaType, apiKey, desc);
    } else if (pendingPhoto) {
      // Photo only
      loadTxt.textContent = '📷 Analysing photo...';
      loading.classList.remove('hidden');
      n = await lookupNutritionFromImage(pendingPhoto.base64, pendingPhoto.mediaType, apiKey);
    } else {
      // Text only
      loadTxt.textContent = 'Looking up nutrition...';
      loading.classList.remove('hidden');
      n = await lookupNutrition(desc, apiKey);
    }

    const wasPhoto = !!pendingPhoto;
    const logs = getLogs();
    const d    = todayStr();
    if (!logs[d]) logs[d] = [];
    logs[d].push({
      id:        Date.now().toString(),
      ts:        Date.now(),
      name:      n.name,
      serving:   n.serving,
      cal:       n.calories,
      p:         n.protein_g,
      c:         n.carbs_g,
      f:         n.fat_g,
      conf:      confPct(n.confidence),
      fromPhoto: wasPhoto
    });
    saveLogs(logs);
    input.value = '';
    if (wasPhoto) { clearPendingPhoto(); showToast('📷 Photo analysed!'); }
    updateTodayView();
  } catch (err) {
    errEl.textContent = `Error: ${err.message}`;
    errEl.classList.remove('hidden');
  } finally {
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
  const d    = todayStr();
  if (logs[d]) {
    logs[d] = logs[d].filter(e => e.id !== id);
    saveLogs(logs);
    updateTodayView();
  }
}

// ── EDIT MODAL ─────────────────────────────────────────────────
let editingId = null;

function openEditModal(id) {
  const logs    = getLogs();
  const entries = logs[todayStr()] || [];
  const entry   = entries.find(e => e.id === id);
  if (!entry) return;

  editingId = id;
  document.getElementById('edit-name').value    = entry.name;
  document.getElementById('edit-serving').value = entry.serving;
  document.getElementById('edit-cal').value     = entry.cal;
  document.getElementById('edit-protein').value = entry.p;
  document.getElementById('edit-carbs').value   = entry.c;
  document.getElementById('edit-fat').value     = entry.f;
  document.getElementById('edit-modal').classList.remove('hidden');
}

function closeEditModal() {
  editingId = null;
  document.getElementById('edit-modal').classList.add('hidden');
}

function saveEdit() {
  if (!editingId) return;
  const logs = getLogs();
  const d    = todayStr();
  const idx  = (logs[d] || []).findIndex(e => e.id === editingId);
  if (idx < 0) return;

  const cal = parseFloat(document.getElementById('edit-cal').value)     || 0;
  const p   = parseFloat(document.getElementById('edit-protein').value) || 0;
  const c   = parseFloat(document.getElementById('edit-carbs').value)   || 0;
  const f   = parseFloat(document.getElementById('edit-fat').value)     || 0;

  logs[d][idx] = {
    ...logs[d][idx],
    name:    document.getElementById('edit-name').value.trim(),
    serving: document.getElementById('edit-serving').value.trim(),
    cal, p, c, f,
    conf: null // manually edited — no confidence score
  };
  saveLogs(logs);
  closeEditModal();
  updateTodayView();
  showToast('Entry updated!');
}

// ── FAVOURITES ─────────────────────────────────────────────────
function toggleFavourite(entryId) {
  const logs  = getLogs();
  const entry = (logs[todayStr()] || []).find(e => e.id === entryId);
  if (!entry) return;

  let favs = getFavs();
  const existing = favs.findIndex(f => f.name === entry.name && f.cal === entry.cal);

  if (existing >= 0) {
    favs.splice(existing, 1);
    showToast('Removed from favourites');
  } else {
    favs.push({ favId: entry.id, name: entry.name, serving: entry.serving, cal: entry.cal, p: entry.p, c: entry.c, f: entry.f });
    showToast('⭐ Saved to favourites!');
  }
  saveFavs(favs);
  updateTodayView();
}

function quickAddFavourite(fav) {
  const logs = getLogs();
  const d    = todayStr();
  if (!logs[d]) logs[d] = [];
  logs[d].push({
    id:      Date.now().toString(),
    ts:      Date.now(),
    name:    fav.name,
    serving: fav.serving,
    cal:     fav.cal,
    p:       fav.p,
    c:       fav.c,
    f:       fav.f,
    conf:    null
  });
  saveLogs(logs);
  updateTodayView();
  showToast(`Added ${fav.name}`);
}

function renderFavourites() {
  const favs    = getFavs();
  const section = document.getElementById('fav-section');
  const chips   = document.getElementById('fav-chips');

  if (!favs.length) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');

  chips.innerHTML = favs.map((f, i) => `
    <div class="fav-chip" onclick="quickAddFavourite(${JSON.stringify(f).replace(/"/g,'&quot;')})">
      <div class="fav-chip-name">${esc(f.name)}</div>
      <div class="fav-chip-cal">${Math.round(f.cal)} kcal</div>
      <div class="fav-chip-macros">P${Math.round(f.p)} C${Math.round(f.c)} F${Math.round(f.f)}</div>
    </div>
  `).join('');
}

// ── STATS VIEW ─────────────────────────────────────────────────
function last14() {
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (13 - i));
    return d.toISOString().slice(0, 10);
  });
}
function last7() { return last14().slice(7); }

function calcStreak() {
  const logs = getLogs();
  let streak = 0;
  const d = new Date();
  if (!(logs[todayStr()] || []).length) d.setDate(d.getDate() - 1);
  while (true) {
    const k = d.toISOString().slice(0, 10);
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
  const days7 = last7().map(d => (logs[d] || []).reduce((s, e) => s + e.cal, 0)).filter(x => x > 0);
  const avg   = days7.length ? Math.round(days7.reduce((a, b) => a + b, 0) / days7.length) : 0;
  document.getElementById('stat-avg').textContent    = avg ? avg.toLocaleString() : '--';
  document.getElementById('stat-streak').textContent = calcStreak();

  renderCalChart(logs, profile);
  renderMacroChart(logs);
  renderWeightChartIn('chart-weight-stats', 'weightStats');
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
          backgroundColor: data.map(v => v === 0 ? '#334155' : v > goal * 1.05 ? '#f87171' : '#4ade80'),
          borderRadius: 4,
          order: 2
        },
        {
          type: 'line',
          data: new Array(14).fill(goal),
          borderColor: '#22c55e',
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
        x: { grid: { display: false }, ticks: { font: { size: 9 }, color: '#94a3b8' } },
        y: { grid: { color: '#1e293b' }, ticks: { font: { size: 9 }, color: '#94a3b8' } }
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
  if (!n) return;

  const ctx = document.getElementById('chart-macros').getContext('2d');
  if (charts.macros) charts.macros.destroy();
  charts.macros = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Protein', 'Carbs', 'Fat'],
      datasets: [{
        data: [+(p/n).toFixed(1), +(c/n).toFixed(1), +(f/n).toFixed(1)],
        backgroundColor: ['#60a5fa', '#fbbf24', '#fb923c'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { font: { size: 11 }, padding: 10, color: '#94a3b8' } },
        tooltip: { callbacks: { label: c => `${c.label}: ${c.raw}g avg` } }
      }
    }
  });
}

function renderWeightChartIn(canvasId, chartKey) {
  const weights = getWeights().slice(-60);
  if (weights.length < 2) return;
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
        borderColor: '#22c55e',
        backgroundColor: 'rgba(34,197,94,0.08)',
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
        x: { grid: { display: false }, ticks: { font: { size: 9 }, color: '#94a3b8' } },
        y: { grid: { color: '#1e293b' }, ticks: { font: { size: 9 }, color: '#94a3b8' } }
      }
    }
  });
}

// ── WEIGHT VIEW ────────────────────────────────────────────────
function renderWeightView() {
  renderWeightHistory();
  renderWeightChartIn('chart-weight', 'weight');
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
  if (i >= 0) weights[i].kg = kg; else weights.push({ date: d, kg });
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
}

function updateMacroCalPreview() {
  const p = parseInt(document.getElementById('p-macro-protein').value) || 0;
  const c = parseInt(document.getElementById('p-macro-carbs').value)   || 0;
  const f = parseInt(document.getElementById('p-macro-fat').value)     || 0;
  const kcal = p * 4 + c * 4 + f * 9;
  document.getElementById('macro-cal-preview').textContent = kcal ? `${kcal.toLocaleString()} kcal` : '--';
}

function saveProfileFromForm() {
  const p = getProfile() || {};
  p.name       = document.getElementById('p-name').value.trim();
  p.age        = parseInt(document.getElementById('p-age').value);
  p.sex        = document.getElementById('p-sex').value;
  p.height     = parseFloat(document.getElementById('p-height').value);
  p.weight     = parseFloat(document.getElementById('p-weight').value);
  p.activity   = document.getElementById('p-activity').value;
  p.goalType   = 'custom';
  p.customGoal = parseInt(document.getElementById('p-goal').value);
  saveProfile(p);
  showToast('Profile saved!');
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

  if (!apiKey.startsWith('sk-'))       return fail('Enter a valid Anthropic API key (starts with sk-)');
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

  saveApiKey(apiKey);
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
  document.querySelectorAll('.nav-item').forEach(btn =>
    btn.addEventListener('click', () => navigate(btn.dataset.view)));

  document.getElementById('add-btn').addEventListener('click', addFood);
  document.getElementById('food-input').addEventListener('keypress', e => {
    if (e.key === 'Enter') addFood();
  });

  // Camera — stage the photo, don't submit yet
  document.getElementById('camera-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const base64    = await fileToBase64(file);
    const mediaType = file.type || 'image/jpeg';
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

  // Manage favourites (long list: just clear all for now)
  document.getElementById('fav-manage-btn').addEventListener('click', () => {
    if (confirm('Clear all favourites?')) { saveFavs([]); renderFavourites(); }
  });

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

  // Live kcal preview as user types macro targets
  ['p-macro-protein','p-macro-carbs','p-macro-fat'].forEach(id => {
    document.getElementById(id).addEventListener('input', updateMacroCalPreview);
  });

  document.getElementById('save-api-btn').addEventListener('click', () => {
    const k = document.getElementById('p-api-key').value.trim();
    if (k) { saveApiKey(k); showToast('API key updated!'); }
  });

  document.getElementById('export-btn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({
      profile: getProfile(), logs: getLogs(), weights: getWeights()
    }, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `calorieai-${todayStr()}.json`
    });
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.getElementById('clear-btn').addEventListener('click', () => {
    if (confirm('Delete all data? This cannot be undone.')) {
      localStorage.clear();
      location.reload();
    }
  });
}

function init() {
  initSetup();
  initEvents();
  if (getProfile()) {
    launchApp();
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
