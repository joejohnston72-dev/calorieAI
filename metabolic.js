'use strict';

/* ────────────────────────────────────────────────────────────────
   Metabolic tracking — Glycemic Load (GL) + Glucose-Ketone Index (GKI)

   Loaded BEFORE app.js so these function declarations exist by the time
   app.js's init()/render calls them. All references to app.js helpers
   (DB, getLogs, todayStr, afterSave, esc, showToast, charts…) resolve at
   CALL time, by which point app.js has run — so cross-script sharing is safe.

   • Glycemic Load: GL = glycemic index × carbs(g) ÷ 100. The AI returns an
     estimated GI per food; we compute + store GL per entry. Standard,
     transparent formula. Per-food and per-day totals with low/med/high zones.
   • GKI = blood glucose (mmol/L) ÷ blood ketones (mmol/L). A real metabolic
     marker that needs actual finger-prick readings. We support BOTH: log real
     readings for a true GKI, AND show a rough meal-based ESTIMATE (clearly
     labelled) for days/times without a reading, so there's always a trend.
   ──────────────────────────────────────────────────────────────── */

// ── Glycemic Load ─────────────────────────────────────────────────
function clampGI(v)  { const n = Math.round(Number(v)); return isFinite(n) ? Math.max(0, Math.min(110, n)) : 0; }
function computeGL(gi, carbs) {
  const g = Number(gi), c = Number(carbs);
  if (!isFinite(g) || !isFinite(c) || g <= 0 || c <= 0) return 0;
  return Math.round((g * c) / 100);
}
// Per-food GL zone (per serving): low ≤10, medium 11–19, high ≥20.
function glZone(gl) {
  if (gl == null || gl <= 0) return { label: 'Low', cls: 'low' };
  if (gl <= 10) return { label: 'Low',  cls: 'low' };
  if (gl < 20)  return { label: 'Med',  cls: 'med' };
  return { label: 'High', cls: 'high' };
}
// Whole-day GL zone: low ≤100, moderate 101–150, high >150 (common references).
function dailyGLZone(gl) {
  if (gl <= 100) return { label: 'Low',      cls: 'low' };
  if (gl <= 150) return { label: 'Moderate', cls: 'med' };
  return { label: 'High', cls: 'high' };
}
function entryGL(e) {
  if (typeof e.gl === 'number') return e.gl;
  if (typeof e.gi === 'number') return computeGL(e.gi, e.c);   // derive if only GI stored
  return 0;
}
function dayGL(entries) { return (entries || []).reduce((s, e) => s + entryGL(e), 0); }

// Small pill shown on each food-log entry.
function glBadgeHTML(e) {
  const gl = entryGL(e);
  if (!gl) return '';
  const z = glZone(gl);
  return `<span class="gl-badge gl-${z.cls}" title="Glycemic load — ${z.label}">GL ${gl}</span>`;
}

// ── GKI storage ───────────────────────────────────────────────────
// cai_gki: [{ id, date:"YYYY-MM-DD", ts, glucose, ketones }] (mmol/L)
function getGki()  { return DB.get('cai_gki') || []; }
function saveGki(v){ DB.set('cai_gki', v); afterSave(); }

function realGKI(glucose, ketones) {
  const g = Number(glucose), k = Number(ketones);
  if (!isFinite(g) || !isFinite(k) || k <= 0) return null;
  return g / k;
}
// Latest measured reading on a given date (or null).
function measuredGKIForDate(dateStr) {
  const todays = getGki().filter(r => r.date === dateStr).sort((a, b) => b.ts - a.ts);
  if (!todays.length) return null;
  const r = todays[0];
  return realGKI(r.glucose, r.ketones);
}

// ── Estimated GKI (rough, meal-based — NOT a clinical value) ──────
// Transparent heuristic: carbs raise estimated glucose and suppress ketones;
// a longer gap since the last meal lowers glucose and raises ketones. Ketosis
// realistically needs sustained low carbs, so ketones only climb as daily
// carbs fall below ~60g. Clamped to physiologically plausible ranges.
function estimateGKIRaw(carbs, hoursSinceLast) {
  let glu = 4.9 + Math.min(2.6, carbs / 40) - Math.min(1.0, hoursSinceLast / 6);
  glu = Math.max(3.9, Math.min(8.5, glu));
  let ket = 0.1 + Math.max(0, (60 - carbs) / 60) * 1.0 + Math.min(1.2, hoursSinceLast / 8);
  ket = Math.max(0.05, Math.min(4, ket));
  return glu / ket;
}
function estimateGKIForDay(entries, refTs) {
  if (!(entries || []).length) return null;   // nothing logged → no basis for an estimate
  const carbs = (entries || []).reduce((s, e) => s + (e.c || 0), 0);
  const lastTs = (entries || []).length ? Math.max(...entries.map(e => e.ts || 0)) : null;
  const hrs = lastTs ? Math.max(0, (refTs - lastTs) / 3600000) : 10;
  return estimateGKIRaw(carbs, hrs);
}

// GKI ketosis zones (Seyfried): lower = deeper ketosis.
function gkiZone(g) {
  if (g == null || !isFinite(g)) return { label: '—', cls: 'none' };
  if (g <= 1) return { label: 'Deep ketosis',    cls: 'deep' };
  if (g <= 3) return { label: 'High ketosis',    cls: 'high' };
  if (g <= 6) return { label: 'Moderate ketosis', cls: 'mod' };
  if (g <= 9) return { label: 'Light / transitioning', cls: 'light' };
  return { label: 'Not in ketosis', cls: 'out' };
}
const fmtGKI = g => (g == null || !isFinite(g)) ? '--' : (g >= 10 ? Math.round(g) : g.toFixed(1));

// ── Today card ────────────────────────────────────────────────────
function renderMetabolicToday(entries) {
  const card = document.getElementById('metabolic-card');
  if (!card) return;
  entries = entries || [];

  // Glycemic Load
  const gl = Math.round(dayGL(entries));
  const glZ = dailyGLZone(gl);
  const glValEl = document.getElementById('metab-gl-val');
  glValEl.textContent = gl || '0';
  glValEl.className = `metab-value gl-text-${glZ.cls}`;
  document.getElementById('metab-gl-zone').textContent = `${glZ.label} · today`;

  // GKI — prefer a measured reading today, else the meal-based estimate.
  const today = todayStr();
  const measured = measuredGKIForDate(today);
  const gki = measured != null ? measured : estimateGKIForDay(entries, Date.now());
  const z = gkiZone(gki);
  const gkiValEl = document.getElementById('metab-gki-val');
  // An estimate is a heuristic, so it is shown as a zone only — never as an
  // exact-looking number. Only a blood reading gets a GKI value.
  const isEst = measured == null && gki != null;
  gkiValEl.textContent = isEst ? z.label : fmtGKI(gki);
  gkiValEl.className = `metab-value gki-text-${z.cls}${isEst ? ' metab-value-zone' : ''}`;
  document.getElementById('metab-gki-zone').textContent = isEst ? 'likely zone' : z.label;
  document.getElementById('metab-gki-src').textContent = measured != null ? 'measured' : gki == null ? '' : 'estimated';
  document.getElementById('metab-gki-src').className =
    `metab-src ${measured != null ? 'src-measured' : 'src-estimated'}`;

  document.getElementById('metab-hint').textContent = measured != null
    ? 'GKI from your latest blood reading today.'
    : 'Zone estimated from today’s carbs and time since eating. Log a blood reading for your actual GKI.';
}

// ── Log-reading modal ─────────────────────────────────────────────
function openGkiModal() {
  document.getElementById('gki-glucose').value = '';
  document.getElementById('gki-ketones').value = '';
  document.getElementById('gki-error').classList.add('hidden');
  updateGkiPreview();
  document.getElementById('gki-modal').classList.remove('hidden');
}
function closeGkiModal() { document.getElementById('gki-modal').classList.add('hidden'); }
function updateGkiPreview() {
  const g = parseFloat(document.getElementById('gki-glucose').value);
  const k = parseFloat(document.getElementById('gki-ketones').value);
  const gki = realGKI(g, k);
  const el = document.getElementById('gki-preview');
  if (gki == null) { el.textContent = ''; return; }
  const z = gkiZone(gki);
  el.textContent = `GKI ${fmtGKI(gki)} — ${z.label}`;
  el.className = `metab-zone gki-text-${z.cls}`;
}
function saveGkiReading() {
  const g = parseFloat(document.getElementById('gki-glucose').value);
  const k = parseFloat(document.getElementById('gki-ketones').value);
  const err = document.getElementById('gki-error');
  if (!isFinite(g) || g <= 0 || g > 40)  { err.textContent = 'Enter a glucose value in mmol/L (e.g. 5.2).'; err.classList.remove('hidden'); return; }
  if (!isFinite(k) || k < 0.1 || k > 10) { err.textContent = 'Enter a ketone value from 0.1 to 10 mmol/L (meters read "LO" below 0.1).'; err.classList.remove('hidden'); return; }
  const list = getGki();
  list.push({ id: Date.now().toString(), date: todayStr(), ts: Date.now(), glucose: g, ketones: k });
  saveGki(list);
  closeGkiModal();
  showToast('Blood reading logged');
  updateTodayView();
}

// ── Stats charts ──────────────────────────────────────────────────
function renderMetabolicStats() {
  const logs = getLogs();
  const days = last14();
  const labels = days.map(d => {
    const dt = new Date(d + 'T00:00:00');
    return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  });

  // GKI series — blood readings only (estimates are zone-only, see Today card).
  const measured = days.map(d => { const m = measuredGKIForDate(d); return m != null ? +m.toFixed(1) : null; });

  const gkiCtx = document.getElementById('chart-gki')?.getContext('2d');
  if (gkiCtx) {
    if (charts.gki) charts.gki.destroy();
    charts.gki = new Chart(gkiCtx, {
      data: {
        labels,
        datasets: [
          { type: 'line', label: 'Measured', data: measured, borderColor: '#8fc2bb',
            backgroundColor: '#8fc2bb', borderWidth: 2, pointRadius: 4, pointStyle: 'circle',
            spanGaps: true, tension: 0.3 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false, labels: { font: { size: 10 }, color: '#979ca4', boxWidth: 12 } },
          tooltip: { callbacks: { label: c => c.raw == null ? '' : `GKI ${c.raw} — ${gkiZone(c.raw).label}` } } },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 9 }, color: '#979ca4' } },
          y: { grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { font: { size: 9 }, color: '#979ca4' }, beginAtZero: true },
        },
      },
    });
  }

  // Daily Glycemic Load bars.
  const glData = days.map(d => Math.round(dayGL(logs[d] || [])));
  const glCtx = document.getElementById('chart-gl')?.getContext('2d');
  if (glCtx) {
    if (charts.gl) charts.gl.destroy();
    charts.gl = new Chart(glCtx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: glData,
          backgroundColor: glData.map(v => v === 0 ? '#262a2f' : v > 150 ? '#d88685' : v > 100 ? '#d8b774' : '#93c2a4'),
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false },
          tooltip: { callbacks: { label: c => `GL ${c.raw} — ${dailyGLZone(c.raw).label}` } } },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 9 }, color: '#979ca4' } },
          y: { grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { font: { size: 9 }, color: '#979ca4' }, beginAtZero: true },
        },
      },
    });
  }
}
