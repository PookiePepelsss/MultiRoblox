let accounts = [], launchAcc = null, editAcc = null, toastTimer;
let packages = [], editingPackageId = null;
const _launchedIds = new Set();

// ── Logs ─────────────────────────────────────────────────────────────────────
const _logs = [];
const MAX_LOGS = 2000;
const LOG_CATS = { launch:'launch', crash:'crash', kill:'kill', cookie:'cookie', afk:'afk', enc:'enc', system:'system', close:'close' };

function logEntry(level, category, message, meta) {
  const entry = { ts: Date.now(), level, category, message, meta: meta || {} };
  _logs.push(entry);
  if (_logs.length > MAX_LOGS) _logs.shift(); // keep the most-recent tail
  if (document.getElementById('page-logs')?.classList.contains('active')) _appendLogRow(entry);
}

// Surface uncaught invoke() rejections in the Logs page instead of losing them silently.
window.addEventListener('unhandledrejection', (e) => {
  const msg = (e.reason && (e.reason.message || e.reason)) || 'Unknown error';
  logEntry('err', 'system', `Unhandled error: ${msg}`);
});

// Enter/Space activates role="button" elements for keyboard/AT users.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest('[role="button"]');
  if (!el) return;
  e.preventDefault();
  el.click();
});

function _logLine(e) {
  const t = new Date(e.ts);
  const ts = t.toLocaleTimeString('en-GB', { hour12:false }) + '.' + String(t.getMilliseconds()).padStart(3,'0');
  const cat = String(e.category || '').toUpperCase();
  const keys = Object.keys(e.meta || {}).filter(k => e.meta[k] !== null && e.meta[k] !== undefined);
  const meta = keys.length ? ' <span class="lg-meta">' + keys.map(k => `${esc(k)}=${esc(e.meta[k])}`).join(' ') + '</span>' : '';
  return `<div class="log-row log-row-${esc(e.level)}"><span class="lg-ts">${esc(ts)}</span><span class="lg-cat">${esc(cat)}</span><span class="lg-msg">${esc(e.message)}${meta}</span></div>`;
}

function renderLogs() {
  const el = document.getElementById('logs-list');
  if (!el) return;
  if (!_logs.length) { el.innerHTML = '<div class="logs-empty"><span class="material-icons-round">terminal</span>No log entries yet.</div>'; return; }
  // Tail behaviour: only auto-scroll to the newest line if already near the end.
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.innerHTML = _logs.map(_logLine).join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

// Appends one row instead of rejoining/replacing the whole log list.
function _appendLogRow(entry) {
  const el = document.getElementById('logs-list');
  if (!el) return;
  if (el.querySelector('.logs-empty')) el.innerHTML = '';
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.insertAdjacentHTML('beforeend', _logLine(entry));
  while (el.children.length > MAX_LOGS) el.removeChild(el.firstChild);
  if (atBottom) el.scrollTop = el.scrollHeight;
}

// Native-style find (Ctrl+F) over the rendered log text. Uses window.find so
// selection, scroll-to-match and Ctrl+A/Ctrl+C all behave like a normal viewer.
function openLogFind() {
  const bar = document.getElementById('log-find');
  const inp = document.getElementById('log-find-input');
  if (!bar || !inp) return;
  bar.style.display = 'flex';
  inp.focus(); inp.select();
}
function closeLogFind() {
  const bar = document.getElementById('log-find');
  if (bar) bar.style.display = 'none';
  const sel = window.getSelection && window.getSelection();
  if (sel) sel.removeAllRanges();
  const c = document.getElementById('log-find-count');
  if (c) c.textContent = '';
}
function logFind(backwards) {
  const inp = document.getElementById('log-find-input');
  const c = document.getElementById('log-find-count');
  if (!inp) return;
  const q = inp.value;
  if (!q) { if (c) c.textContent = ''; return; }
  const found = window.find(q, false, !!backwards, true, false, false, false);
  if (c) c.textContent = found ? '' : 'No matches';
}
const _avatarCache = {};
let settings = {};

let _encMode = null;
function showEncModal(mode) {
  _encMode = mode;
  const title = document.getElementById('enc-title');
  const desc = document.getElementById('enc-desc');
  const action = document.getElementById('enc-action');
  const skip = document.getElementById('enc-skip');
  const err = document.getElementById('enc-err');
  const inp = document.getElementById('enc-input');
  if (err) err.style.display = 'none';
  if (inp) inp.value = '';
  if (action) action.disabled = false;
  if (mode === 'setup') {
    title.textContent = 'Create an encryption key';
    desc.textContent = 'Set an encryption key to protect your saved accounts. You will be asked for it every time you open the app.';
    action.textContent = 'Set key';
    if (skip) if (skip) skip.style.display = 'none';
  } else {
    title.textContent = 'Enter your encryption key';
    desc.textContent = 'Enter the key you set to unlock your saved accounts.';
    action.textContent = 'Unlock';
    if (skip) skip.style.display = 'none';
  }
  openModal('m-enc');
  setTimeout(() => inp && inp.focus(), 60);
}
function _encErr(m) { const e = document.getElementById('enc-err'); if (e) { e.textContent = m; e.style.display = 'block'; } }
async function submitEnc() {
  const inp = document.getElementById('enc-input');
  const action = document.getElementById('enc-action');
  const val = inp ? inp.value : '';
  if (action) action.disabled = true;
  try {
    if (_encMode === 'setup') {
      if (!val) { _encErr('Please enter an encryption key.'); action.disabled = false; return; }
      const r = await api.encSetKey(val);
      if (!r || !r.ok) {
        const reason = r && r.error === 'decrypt failed'
          ? 'One or more saved accounts cannot be decrypted (their cookies may be from a different PC or Windows profile). Remove those accounts and try again.'
          : (r && r.error ? 'Could not set encryption key: ' + r.error : 'Could not set encryption key. Please try again.');
        _encErr(reason);
        action.disabled = false;
        return;
      }
    } else {
      if (!val) { _encErr('Please enter your encryption key.'); action.disabled = false; return; }
      const r = await api.encUnlock(val);
      if (!r || !r.ok) { _encErr('Wrong key. Please try again.'); logEntry('warn', 'enc', 'Failed encryption unlock attempt (wrong key)'); action.disabled = false; inp.value = ''; inp.focus(); return; }
      logEntry('ok', 'enc', 'Encryption key accepted, accounts unlocked');
    }
    closeModal('m-enc');
    await continueInit();
  } catch (e) { _encErr('Something went wrong. Please try again.'); if (action) action.disabled = false; }
}
async function skipEnc() {
  const skip = document.getElementById('enc-skip');
  if (skip) skip.disabled = true;
  try { await api.encSetKey(''); } catch {}
  closeModal('m-enc');
  await continueInit();
}

function clearAppData() {
  confirmAction('Delete ALL saved accounts, settings and this encryption key? This cannot be undone.', async () => {
    const btn = document.getElementById('enc-clear-data');
    if (btn) { btn.disabled = true; btn.textContent = 'Clearing...'; }
    let res;
    try { res = await api.clearAppData(); } catch (e) { res = { ok: false, error: e?.message || String(e) }; }
    if (res && res.ok) {
      // Full reload, not just re-running init(): the Rust side's own
      // in-memory caches get reset by the backend, but this is the simplest
      // way to guarantee every bit of frontend state (accounts, settings,
      // caches) starts completely fresh against the now-empty storage too.
      location.reload();
    } else {
      if (btn) { btn.disabled = false; btn.textContent = 'Clear data'; }
      _encErr(res && res.error ? 'Could not clear data: ' + res.error : 'Could not clear data. Please try again.');
    }
  });
}

async function init() {
  // Encryption gate: in passphrase mode the cookies can't be read until the key is
  // entered for this boot session. Show the popup first; only load data once ready.
  try {
    const st = await api.encStatus();
    if (st && st.mode === 'locked') { showEncModal('locked'); return; }
    if (st && st.mode === 'setup') { showEncModal('setup'); return; }
  } catch {}
  await continueInit();
}

// Decrypt failure is itself proof a cookie is unusable -- flag it instantly
// (no network round-trip needed) instead of waiting on recheckAllCookies.
function flagInvalidCookies(list) {
  for (const a of list) {
    if (a._cookieInvalid) {
      _cookieStatus[a.id] = 'dead';
      logEntry('warn', 'cookie', `Cookie could not be decrypted for ${a.username || a.id} (corrupted or wrong key)`, { accountId: a.id, username: a.username || null, userId: a.userId || null });
    }
  }
}

async function continueInit() {
  [accounts, settings, packages] = await Promise.all([api.loadAccounts(), api.loadSettings(), api.loadPackages()]);
  logEntry('info', 'system', `Loaded ${accounts.length} account${accounts.length === 1 ? '' : 's'} from storage`);
  flagInvalidCookies(accounts);
  recheckAllCookies(true); // kick a full check off the moment cookies are readable, not on the 60s tick
  render();
  // put the toolbar back to the saved view + filter
  document.getElementById('vt-grid').classList.toggle('active', _acctView === 'grid');
  document.getElementById('vt-list').classList.toggle('active', _acctView === 'list');
  document.querySelectorAll('#filter-menu button').forEach(b => b.classList.toggle('active', b.dataset.f === _acctFilter));
  document.getElementById('filter-btn').classList.toggle('on', _acctFilter !== 'all');
  renderPackages();
  applySettings();
  refreshMultiStatus();
  positionNavSlider(); // covers landing on the default page without a goTo() call
  detectRobloxVersion();
  showAppVersion();
  startStatusPoll();
  if (settings.autoTrim) startAutoTrimLoop();
  startTrackingLoop();
  logEntry('info', 'system', 'MultiRoblox started', { version: 'v1', accounts: accounts.length, platform: navigator.platform });
  try { const k = localStorage.getItem('bloxgen_apikey'); if (k) { const el = document.getElementById('gen-apikey'); if (el) el.value = k; } } catch {}
  try { const afkStat = await api.antiAfkStatus(); if (afkStat && afkStat.enabled) logEntry('info', 'afk', `Anti-AFK is enabled on startup (active: ${afkStat.active})`, { enabled: afkStat.enabled, active: afkStat.active }); } catch {}
  try { _genHistory = (await api.readGenHistory()) || []; genRenderHistory(); } catch {}

  // Forward main-process log events into the renderer log
  api.onLogEntry(data => logEntry(data.level, data.category, data.message, data.meta));

  // main pushes the count off the watch tick; the local poll backs off below
  api.onRobloxCount(n => { _lastCountPushAt = Date.now(); _mixRunning = n; setRunningBadges(n); });

  // Fires the moment the process actually exists (see native.rs do_launch),
  // instead of waiting on the whole launch call -- CSRF fetch, auth ticket,
  // inter-launch stagger, trailing bookkeeping -- to resolve back to the
  // caller. markLaunched() is idempotent, so the doLaunch() success path
  // below calling it again once its own await resolves is harmless.
  api.onRobloxStarted(id => markLaunched(id));

  api.onRobloxClosed(id => {
    _launchedIds.delete(id);
    const closedAcct = accounts.find(a => a.id === id);
    logEntry('info', 'close', `Roblox closed for ${closedAcct ? closedAcct.username : id}`, { accountId: id, username: closedAcct?.username || null, userId: closedAcct?.userId || null });
    const card = document.querySelector(`.card[data-id="${id}"]`);
    if (card) card.classList.remove('is-live', 'in-game');
    const dot = document.querySelector(`.card[data-id="${id}"] .card-dot`);
    if (dot) { dot.classList.remove('launched', 'in-game'); dot.title = 'Not launched'; }
    refreshPkgAvatarStatus();
    pollRunningCount();
    stopPresencePollIfIdle();
  });

  api.onAllRobloxClosed(() => {
    logEntry('warn', 'close', 'All Roblox instances closed');
    _launchedIds.clear();
    document.querySelectorAll('.card.is-live').forEach(c => c.classList.remove('is-live', 'in-game'));
    document.querySelectorAll('.card-dot.launched').forEach(d => { d.classList.remove('launched', 'in-game'); d.title = 'Not launched'; });
    refreshPkgAvatarStatus();
    pollRunningCount();
    stopPresencePollIfIdle();
    if (document.getElementById('page-mixer')?.classList.contains('active')) mixRefreshRunning();
  });

  // Chrome download progress
  api.onChromeProgress(data => {
    const dlDiv = document.getElementById('login-dl');
    const waitDiv = document.getElementById('login-waiting');
    if (!dlDiv || !waitDiv) return;
    if (data.status === 'downloading') {
      dlDiv.style.display = '';
      waitDiv.style.display = 'none';
      if (data.percent !== undefined) {
        document.getElementById('dl-bar').style.width = data.percent + '%';
        document.getElementById('dl-pct').textContent = data.percent + '%';
      }
    } else if (data.status === 'done') {
      dlDiv.style.display = 'none';
      waitDiv.style.display = '';
    }
  });
}
init();

// ── Theme ──────────────────────────────────────────────────────────────────
var THEMES = ['dark','light','midnight','aurora','sunset','crimson','ocean','grape','forest','amber','rose','graphite'];
function applyTheme(name) {
  if (THEMES.indexOf(name) < 0) name = 'dark';
  document.body.classList.remove('light');
  THEMES.forEach(t => { if (t !== 'dark' && t !== 'light') document.body.classList.remove('theme-' + t); });
  if (name === 'light') document.body.classList.add('light');
  else if (name !== 'dark') document.body.classList.add('theme-' + name);
  document.querySelectorAll('.theme-card').forEach(c => c.classList.toggle('sel', c.dataset.theme === name));
}
function currentTheme() { try { return localStorage.getItem('ui-theme') || 'dark'; } catch { return 'dark'; } }
function setTheme(name) {
  if (THEMES.indexOf(name) < 0) name = 'dark';
  applyTheme(name);
  try { localStorage.setItem('ui-theme', name); } catch {}
}
function openDiscord() {
  api.openExternal('https://discord.gg/kZ8MZZ8dTF');
}
(function() {
  let t;
  try {
    t = localStorage.getItem('ui-theme');
    if (!t) { const old = localStorage.getItem('theme'); t = (old === 'light') ? 'light' : 'dark'; }
  } catch { t = 'dark'; }
  setTheme(t || 'dark');
})();

// ── BloxGen API key persistence ────────────────────────────────────────────
(function() {
  try {
    const saved = localStorage.getItem('bloxgen_apikey');
    if (saved) {
      const el = document.getElementById('gen-apikey');
      if (el) el.value = saved;
    }
  } catch {}
})();
document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('gen-apikey');
  if (el) el.addEventListener('input', () => {
    try { localStorage.setItem('bloxgen_apikey', el.value); } catch {}
  });
});


async function detectRobloxVersion() {
  try {
    const ver = await api.getRobloxVersion(settings.lockChannel ? settings.robloxChannel : '');
    if (ver) {
      // Show full hash in titlebar badge, also update settings stat
      document.getElementById('tb-roblox-ver').textContent = ver;
      const el = document.getElementById('stat-rblx-ver');
      if (el) el.textContent = ver;
    } else {
      document.getElementById('tb-roblox-ver').textContent = '-';
      const el = document.getElementById('stat-rblx-ver');
      if (el) el.textContent = 'Not detected';
    }
  } catch {
    document.getElementById('tb-roblox-ver').textContent = '-';
    const el = document.getElementById('stat-rblx-ver');
    if (el) el.textContent = 'Not detected';
  }
}

async function showAppVersion() {
  let v;
  try { v = await api.getAppVersion(); } catch { return; }
  const verEl = document.getElementById('stat-app-ver');
  if (verEl && v) verEl.textContent = 'Version ' + v;
}

function applySettings() {
  // Reports what the backend actually writes rather than offering a choice it
  // doesn't honour: scrypt-derived AES-256-GCM once a key is set, otherwise
  // Windows DPAPI tied to the logged-in account (see encryption.rs).
  const encAlgo = document.getElementById('stat-enc-algo');
  const encDesc = document.getElementById('stat-enc-algo-desc');
  if (encAlgo) encAlgo.textContent = settings.keySet ? 'AES-256-GCM' : 'Windows DPAPI';
  if (encDesc) {
    encDesc.textContent = settings.keySet
      ? 'Cookies are encrypted with your key (scrypt + AES-256-GCM).'
      : 'Cookies are encrypted with Windows DPAPI, tied to your Windows account. Set a key below to use a passphrase instead.';
  }
  const keyIn = document.getElementById('custom-key');
  if (keyIn) { keyIn.value = ''; keyIn.placeholder = settings.keySet ? 'Key is set, type to update it' : 'e.g. SecureKey1234@A#'; }
  const afk = document.getElementById('set-antiafk');
  if (afk) afk.checked = !!settings.antiAfk;
  const afkSb = document.getElementById('sb-antiafk');
  if (afkSb) afkSb.checked = !!settings.antiAfk;
  const afkIv = document.getElementById('set-antiafk-interval');
  if (afkIv) {
    const mins = Math.round((settings.antiAfkInterval || 19 * 60) / 60);
    afkIv.value = mins;
    updateSliderFill(afkIv);
    const afkIvVal = document.getElementById('set-antiafk-interval-val');
    if (afkIvVal) afkIvVal.textContent = mins + ' min';
  }
  const trim = document.getElementById('set-autotrim');
  if (trim) trim.checked = !!settings.autoTrim;
  const trimIv = document.getElementById('set-autotrim-interval');
  if (trimIv) {
    const mins = settings.autoTrimIntervalMin || 5;
    trimIv.value = mins;
    updateSliderFill(trimIv);
    const trimIvVal = document.getElementById('set-autotrim-interval-val');
    if (trimIvVal) trimIvVal.textContent = mins + ' min';
  }
  const relaunch = document.getElementById('set-autorelaunch');
  if (relaunch) relaunch.checked = !!settings.autoRelaunch;
  const lowPriority = document.getElementById('set-lowpriority');
  if (lowPriority) lowPriority.checked = settings.lowPriorityMultiInstance !== false;
  const lockChannel = document.getElementById('set-lockchannel');
  if (lockChannel) lockChannel.checked = !!settings.lockChannel;
  robloxChannelUpdateUI(settings.robloxChannel || '');
}

let _acctQuery = '', _acctFilter = (() => { try { const f = localStorage.getItem('mr-acct-filter'); return (f && f !== 'running' && f !== 'idle') ? f : 'all'; } catch { return 'all'; } })(), _acctView = (() => { try { return localStorage.getItem('mr-acct-view') === 'list' ? 'list' : 'grid'; } catch { return 'grid'; } })();
function visibleAccounts() {
  let list = [...accounts];
  if (_acctQuery) {
    const q = _acctQuery;
    list = list.filter(a => (a.nickname || a.username || '').toLowerCase().includes(q) || String(a.userId || '').includes(q));
  }
  if (_acctFilter === 'running') list = list.filter(a => _launchedIds.has(a.id));
  else if (_acctFilter === 'idle') list = list.filter(a => !_launchedIds.has(a.id));
  else if (_acctFilter === 'valid-first') list.sort((a, b) => {
    const s = id => _cookieStatus[id] === 'dead' ? 1 : 0;
    return s(a.id) - s(b.id);
  });
  else if (_acctFilter === 'invalid-first') list.sort((a, b) => {
    const s = id => _cookieStatus[id] === 'dead' ? 0 : 1;
    return s(a.id) - s(b.id);
  });
  return list;
}
let _searchTimer;
function onAcctSearch(v) {
  _acctQuery = (v || '').trim().toLowerCase();
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(render, 120); // debounce so a long list isn't rebuilt on every keystroke
}
function toggleFilterMenu(e) { if (e) e.stopPropagation(); document.getElementById('filter-menu').classList.toggle('open'); }
function setAcctFilter(f) {
  _acctFilter = f;
  try { localStorage.setItem('mr-acct-filter', (f === 'running' || f === 'idle') ? 'all' : f); } catch {}
  document.querySelectorAll('#filter-menu button').forEach(b => b.classList.toggle('active', b.dataset.f === f));
  document.getElementById('filter-menu').classList.remove('open');
  document.getElementById('filter-btn').classList.toggle('on', f !== 'all');
  render();
}
function setAcctView(v) {
  _acctView = v;
  try { localStorage.setItem('mr-acct-view', v); } catch {}
  document.getElementById('vt-grid').classList.toggle('active', v === 'grid');
  document.getElementById('vt-list').classList.toggle('active', v === 'list');
  render();
}
document.addEventListener('click', e => {
  const fm = document.getElementById('filter-menu');
  if (fm && fm.classList.contains('open') && !e.target.closest('.filter-wrap')) fm.classList.remove('open');
});

function toggleAntiAfk(src) {
  const el = document.getElementById(src === 'sb' ? 'sb-antiafk' : 'set-antiafk');
  const on = el.checked;
  settings.antiAfk = on;
  api.saveSettings({ antiAfk: on });
  const a = document.getElementById('set-antiafk'); if (a) a.checked = on;
  const b = document.getElementById('sb-antiafk'); if (b) b.checked = on;
  toast(on ? 'Anti-AFK on, accounts stay connected' : 'Anti-AFK off', on ? 'ok' : 'err');
}

function antiAfkIntervalInput(v) {
  document.getElementById('set-antiafk-interval-val').textContent = v + ' min';
  updateSliderFill(document.getElementById('set-antiafk-interval'));
}
function antiAfkIntervalCommit() {
  const mins = parseInt(document.getElementById('set-antiafk-interval').value, 10);
  const secs = mins * 60;
  settings.antiAfkInterval = secs;
  api.saveSettings({ antiAfkInterval: secs });
  toast('Anti-AFK interval: ' + mins + ' min', 'ok');
}

// Silent trim -- no toast/button spinner, just logs. Skips the tasklist
// round-trip entirely when nothing is running.
let _autoTrimTimer = null;
async function _autoTrimTick() {
  if (_mixRunning <= 0) return;
  let res;
  try { res = await api.trimRobloxMemory(); } catch { return; }
  if (res && res.ok && res.total > 0) logEntry('info', 'system', `Auto-trimmed ${res.trimmed}/${res.total} Roblox instance(s)`);
}
function startAutoTrimLoop() {
  stopAutoTrimLoop();
  const mins = settings.autoTrimIntervalMin || 5;
  _autoTrimTimer = setInterval(_autoTrimTick, mins * 60 * 1000);
}
function stopAutoTrimLoop() {
  if (_autoTrimTimer) { clearInterval(_autoTrimTimer); _autoTrimTimer = null; }
}
function toggleAutoRelaunch() {
  const el = document.getElementById('set-autorelaunch');
  const on = el.checked;
  settings.autoRelaunch = on;
  api.saveSettings({ autoRelaunch: on });
  toast(on ? 'Relaunch on disconnect on' : 'Relaunch on disconnect off', on ? 'ok' : 'err');
}
// Releasing/re-acquiring the mutex happens inside the helper and isn't
// instant, so re-read the real state afterwards instead of assuming the badge
// can be derived from the checkbox.
async function toggleMultiInstance() {
  const el = document.getElementById('set-multiinstance');
  const on = el.checked;
  el.disabled = true;
  settings.multiInstance = on;
  try {
    await api.saveSettings({ multiInstance: on });
    toast(on ? 'Multi-instance on' : 'Multi-instance off, Roblox will allow one client', on ? 'ok' : 'err');
  } finally {
    el.disabled = false;
  }
  await refreshMultiStatus();
}
function toggleLowPriority() {
  const el = document.getElementById('set-lowpriority');
  const on = el.checked;
  settings.lowPriorityMultiInstance = on;
  api.saveSettings({ lowPriorityMultiInstance: on });
  toast(on ? 'Multi-instance priority lowering on' : 'Multi-instance priority lowering off', on ? 'ok' : 'err');
}
function toggleLockChannel() {
  const el = document.getElementById('set-lockchannel');
  const on = el.checked;
  settings.lockChannel = on;
  api.saveSettings({ lockChannel: on });
  toast(on ? 'Channel locked' : 'Channel unlocked', on ? 'ok' : 'err');
  detectRobloxVersion();
}
function toggleAutoTrim() {
  const el = document.getElementById('set-autotrim');
  const on = el.checked;
  settings.autoTrim = on;
  api.saveSettings({ autoTrim: on });
  if (on) startAutoTrimLoop(); else stopAutoTrimLoop();
  toast(on ? 'Auto trim on' : 'Auto trim off', on ? 'ok' : 'err');
}
function autoTrimIntervalInput(v) {
  document.getElementById('set-autotrim-interval-val').textContent = v + ' min';
  updateSliderFill(document.getElementById('set-autotrim-interval'));
}
function autoTrimIntervalCommit() {
  const mins = parseInt(document.getElementById('set-autotrim-interval').value, 10);
  settings.autoTrimIntervalMin = mins;
  api.saveSettings({ autoTrimIntervalMin: mins });
  if (settings.autoTrim) startAutoTrimLoop();
  toast('Auto trim interval: ' + mins + ' min', 'ok');
}

function toggleCdd(name) {
  const trigger = document.getElementById('cdd-' + name + '-trigger');
  const menu = document.getElementById('cdd-' + name + '-menu');
  const open = menu.classList.contains('open');
  closeAllCdd();
  if (!open) { trigger.classList.add('open'); menu.classList.add('open'); }
}
function closeAllCdd() {
  document.querySelectorAll('.cdd-trigger.open').forEach(t => t.classList.remove('open'));
  document.querySelectorAll('.cdd-menu.open').forEach(m => m.classList.remove('open'));
}
document.addEventListener('click', e => { if (!e.target.closest('.cdd')) closeAllCdd(); });

// Called after any navigation/tab switch so slider fills are always correct.
function refreshAllSliderFills() {
  document.querySelectorAll('.fps-slider').forEach(updateSliderFill);
}

// Segments aren't equal width, so the pill's left/width are computed in
// real pixels from the active button's own rect rather than assumed from
// index -- this is also what lets one CSS rule work for both tab bars
// (Settings' 6 segments and Charts' 3) without hardcoding either count.
function positionTabSlider(barEl) {
  if (!barEl) return;
  let slider = barEl.querySelector('.tab-slider');
  const isNew = !slider;
  if (isNew) {
    slider = document.createElement('div');
    slider.className = 'tab-slider';
    barEl.insertBefore(slider, barEl.firstChild);
  }
  const active = barEl.querySelector('.tab-btn.active');
  if (!active) { slider.style.opacity = '0'; return; }
  if (isNew) slider.style.transition = 'none';
  // offsetLeft/offsetWidth, not getBoundingClientRect: they're relative to
  // the padding edge of the nearest positioned ancestor (here, barEl itself,
  // since both are its direct children) -- exactly what CSS `left` on an
  // absolutely-positioned sibling measures from. getBoundingClientRect
  // instead gives the border-box's outer edge, so subtracting two of those
  // was off by the bar's own border-width in every direction: a small,
  // constant, one-sided-looking gap.
  slider.style.left = active.offsetLeft + 'px';
  slider.style.width = active.offsetWidth + 'px';
  slider.style.opacity = '1';
  if (isNew) {
    void slider.offsetWidth; // force layout so the disabled transition applies before restoring it
    slider.style.transition = '';
  }
}
// Same technique as positionTabSlider, vertical instead of horizontal -- nav
// items are flex-stacked with gaps rather than a fixed row height, so top/
// height come from the active item's measured rect, not an assumed index.
function positionNavSlider() {
  const bar = document.getElementById('sidebar');
  if (!bar) return;
  let slider = bar.querySelector('.nav-slider');
  const isNew = !slider;
  if (isNew) {
    slider = document.createElement('div');
    slider.className = 'nav-slider';
    bar.insertBefore(slider, bar.firstChild);
  }
  const active = bar.querySelector('.nav-item.active');
  if (!active) { slider.style.opacity = '0'; return; }
  if (isNew) slider.style.transition = 'none';
  // See positionTabSlider's comment -- offsetTop/offsetHeight, not
  // getBoundingClientRect, for the same padding-edge-vs-border-edge reason.
  slider.style.top = active.offsetTop + 'px';
  slider.style.height = active.offsetHeight + 'px';
  slider.style.opacity = '1';
  if (isNew) {
    void slider.offsetWidth;
    slider.style.transition = '';
  }
}
window.addEventListener('resize', () => {
  document.querySelectorAll('.tab-bar').forEach(bar => {
    if (bar.querySelector('.tab-btn.active')) positionTabSlider(bar);
  });
  positionNavSlider();
});

function settingsTab(tab) {
  ['general','performance','roblox','privacy','themes'].forEach(t => {
    const panel = document.getElementById('stab-panel-' + t);
    const btn = document.getElementById('stab-' + t);
    if (panel) panel.style.display = t === tab ? '' : 'none';
    if (btn) btn.classList.toggle('active', t === tab);
  });
  if (tab === 'performance') renderEngineInit();
  refreshAllSliderFills();
  positionTabSlider(document.getElementById('stab-general')?.closest('.tab-bar'));
}

function goTo(p) {
  if (p === 'themes') { goTo('settings'); settingsTab(p); return; }
  document.querySelectorAll('.page').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
  document.getElementById('page-' + p).classList.add('active');
  document.getElementById('nav-' + p).classList.add('active');
  positionNavSlider();
  if (p === 'settings') {
    document.getElementById('stat-count').textContent = accounts.length;
    refreshMultiStatus();
    // Covers landing here without ever clicking a tab -- the default-active
    // tab still needs the pill positioned under it at least once.
    positionTabSlider(document.getElementById('stab-general')?.closest('.tab-bar'));
  }
  if (p === 'logs') renderLogs();
  if (p === 'charts') {
    if (!chartsLoaded) loadCharts();
    positionTabSlider(document.getElementById('ctab-popular')?.closest('.tab-bar'));
  }
  if (p === 'packages') renderPackages();
  if (p === 'mixer') mixInit();
  if (p === 'tracking') renderTrackingPage();
  // generator page
  refreshAllSliderFills();
}

function markLaunched(id) {
  _launchedIds.add(id);
  const card = document.querySelector(`.card[data-id="${id}"]`);
  if (card) {
    card.classList.add('is-live');
    const dot = card.querySelector('.card-dot');
    if (dot) { dot.classList.add('launched'); dot.title = 'Launched'; }

  }
  refreshPkgAvatarStatus();
  ensurePresencePoll();
}

function markInGame(id, inGame) {
  const card = document.querySelector(`.card[data-id="${id}"]`);
  if (card) card.classList.toggle('in-game', inGame);
  const dot = card ? card.querySelector('.card-dot') : null;
  if (dot) dot.classList.toggle('in-game', inGame);
}

// Blue-vs-green needs Roblox's own presence data, which the process being up
// (do_launch's PID) can't tell you -- a client can be fully launched and
// sitting on the home menu for a while before it ever joins a place. Polled
// rather than pushed since nothing local changes state when a game is
// joined; the interval only runs while at least one account is launched.
let _presencePollTimer = null;
const PRESENCE_POLL_MS = 12000;
function ensurePresencePoll() {
  if (_presencePollTimer || _launchedIds.size === 0) return;
  _presencePollTimer = setInterval(pollPresence, PRESENCE_POLL_MS);
  pollPresence();
}
function stopPresencePollIfIdle() {
  if (_launchedIds.size === 0 && _presencePollTimer) {
    clearInterval(_presencePollTimer);
    _presencePollTimer = null;
  }
}
async function pollPresence() {
  const launched = accounts.filter(a => _launchedIds.has(a.id) && a.userId);
  if (!launched.length) { stopPresencePollIfIdle(); return; }
  const cookie = launched.find(a => a.cookie)?.cookie;
  if (!cookie) return;
  const userIds = [...new Set(launched.map(a => a.userId))];
  let inGameIds;
  try {
    inGameIds = await api.robloxInGameIds(cookie, userIds);
  } catch {
    return; // transient failure -- leave existing indicators as they were
  }
  if (!Array.isArray(inGameIds)) return;
  const inGameSet = new Set(inGameIds);
  launched.forEach(a => markInGame(a.id, inGameSet.has(a.userId)));
}

async function killOne(id) {
  const a = accounts.find(x => x.id === id);
  logEntry('warn', 'kill', `Killing Roblox instance for ${a ? a.username : id}...`, { accountId: id, username: a?.username, userId: a?.userId });
  const res = await api.killOneRoblox(id);
  if (!res || !res.ok) toast(res?.error || 'Could not kill that instance', 'err');
  else logEntry('ok', 'kill', `Killed instance for ${a ? a.username : id}`, { accountId: id });
}

// ── Card context menu ─────────────────────────────────────────────────────
let _ctxMenuId = null;
function showCardMenu(id, x, y) {
  closeCardMenu();
  _ctxMenuId = id;
  const a = accounts.find(x => x.id === id);
  const isLive = _launchedIds.has(id);
  const menu = document.createElement('div');
  menu.id = 'card-ctx-menu';
  menu.className = 'ctx-menu';
  menu.innerHTML = `
    <div class="ctx-header">${esc(a ? (a.nickname || a.username || 'Unknown') : id)}</div>
    ${isLive ? `<button class="ctx-item ctx-danger" onclick="ctxKill('${id}')"><span class="material-icons-round">power_settings_new</span>Kill instance</button>` : ''}
    ${isLive ? `<button class="ctx-item" onclick="ctxTrim('${id}')"><span class="material-icons-round">memory</span>Trim memory</button>` : ''}
    ${isLive ? `
    <div class="ctx-item ctx-has-sub">
      <span class="material-icons-round">speed</span>Set priority
      <span class="material-icons-round ctx-sub-arrow">chevron_right</span>
      <div class="ctx-submenu">
        ${['realtime', 'high', 'abovenormal', 'normal', 'belownormal', 'low'].map(p =>
          `<button class="ctx-item${_accountPriority[id] === p ? ' ctx-active' : ''}" onclick="ctxSetPriority('${id}','${p}')">${PRIORITY_LABELS[p]}</button>`
        ).join('')}
      </div>
    </div>` : ''}
    <button class="ctx-item" onclick="ctxLaunch('${id}')"><span class="material-icons-round">rocket_launch</span>${isLive ? 'Relaunch' : 'Launch'}</button>
    <button class="ctx-item" onclick="ctxEdit('${id}')"><span class="material-icons-round">edit</span>Edit account</button>
    <div class="ctx-sep"></div>
    <button class="ctx-item" onclick="ctxCopyId('${id}')"><span class="material-icons-round">tag</span>Copy user ID</button>
    <button class="ctx-item" onclick="ctxCopyUser('${id}')"><span class="material-icons-round">person</span>Copy username</button>
    <button class="ctx-item" onclick="ctxCopyCookie('${id}')"><span class="material-icons-round">cookie</span>Copy cookie</button>
    <button class="ctx-item" onclick="ctxOpenBrowser('${id}')"><span class="material-icons-round">open_in_browser</span>Open in browser</button>
  `;
  document.body.appendChild(menu);
  positionCardMenu(menu, x, y);
  setTimeout(() => document.addEventListener('click', closeCardMenu, { once: true }), 0);
}

const CTX_EDGE_GAP = 8;

// Keeps the menu (and its submenu) fully on screen. Previously this assumed a
// 200px-wide menu and only clamped the far edge, so a menu wider than that --
// the width grows with the account name and the "Set priority" row -- still
// ran off the right, and a clamp that went negative pushed the top of the menu
// above the viewport where it couldn't be reached.
function positionCardMenu(menu, x, y) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const rect = menu.getBoundingClientRect();
  let h = rect.height;

  // Defensive: a menu taller than the window would otherwise have to be
  // positioned partly off-screen. Scroll it instead of hiding items.
  if (h > vh - CTX_EDGE_GAP * 2) {
    h = vh - CTX_EDGE_GAP * 2;
    menu.style.maxHeight = h + 'px';
    menu.style.overflowY = 'auto';
  }

  // Clamp both ends: Math.min alone keeps it off the right/bottom edge but
  // happily produces a negative left/top on a small window.
  menu.style.left = Math.max(CTX_EDGE_GAP, Math.min(x, vw - rect.width - CTX_EDGE_GAP)) + 'px';
  menu.style.top = Math.max(CTX_EDGE_GAP, Math.min(y, vh - h - CTX_EDGE_GAP)) + 'px';

  positionCardSubmenu(menu, vw, vh);
}

// The priority submenu opens to the right at left:100%. Near the right edge
// that put it entirely outside the window -- the row highlighted on hover but
// nothing appeared, which is the "menu goes invisible" case. It's laid out
// (opacity:0, not display:none), so it can be measured before it's shown.
function positionCardSubmenu(menu, vw, vh) {
  const parent = menu.querySelector('.ctx-has-sub');
  const sub = parent && parent.querySelector('.ctx-submenu');
  if (!sub) return;

  const menuRect = menu.getBoundingClientRect();
  const subRect = sub.getBoundingClientRect();

  // Flip to the left of the menu when there isn't room on the right, unless
  // there's even less room on that side.
  const roomRight = vw - menuRect.right;
  const roomLeft = menuRect.left;
  if (roomRight < subRect.width + CTX_EDGE_GAP && roomLeft > roomRight) {
    parent.classList.add('ctx-flip-x');
  }

  // And lift it when it would run past the bottom of the window.
  const overflowBelow = parent.getBoundingClientRect().top - 4 + subRect.height + CTX_EDGE_GAP - vh;
  if (overflowBelow > 0) sub.style.top = (-4 - overflowBelow) + 'px';
}
function closeCardMenu() { const m = document.getElementById('card-ctx-menu'); if (m) m.remove(); _ctxMenuId = null; }
async function ctxKill(id) { closeCardMenu(); await killOne(id); }
async function ctxTrim(id) {
  closeCardMenu();
  const a = accounts.find(x => x.id === id);
  let res;
  try { res = await api.trimAccountMemory(id); } catch { res = null; }
  if (res?.ok) {
    logEntry('info', 'system', `Trimmed memory for ${a?.username || id}`, { accountId: id, username: a?.username, userId: a?.userId });
    toast(`Trimmed memory for ${a?.nickname || a?.username || 'instance'}`, 'ok');
  } else {
    toast(res?.error || 'Could not trim this instance', 'err');
  }
}
const PRIORITY_LABELS = { realtime: 'Realtime', high: 'High', abovenormal: 'Above normal', normal: 'Normal', belownormal: 'Below normal', low: 'Low' };
const _accountPriority = {}; // id -> last priority manually set this session, drives the ctx-active highlight
async function ctxSetPriority(id, priority) {
  closeCardMenu();
  const a = accounts.find(x => x.id === id);
  let res;
  try { res = await api.setAccountPriority(id, priority); } catch { res = null; }
  if (res?.ok) {
    _accountPriority[id] = priority;
    toast(`Priority set to ${PRIORITY_LABELS[priority]} for ${a?.nickname || a?.username || 'instance'}`, 'ok');
  } else {
    toast(res?.error || 'Could not set priority', 'err');
  }
}

function ctxLaunch(id) { closeCardMenu(); const a = accounts.find(x => x.id === id); if (a) { launchAcc = a; openModal('m-launch'); } }
function ctxEdit(id) { closeCardMenu(); editAccount(id); }
function ctxCopyId(id) { closeCardMenu(); const a = accounts.find(x => x.id === id); if (a?.userId) navigator.clipboard.writeText(a.userId).then(() => toast('User ID copied', 'ok')); else toast('No user ID', 'err'); }
function ctxCopyUser(id) { closeCardMenu(); const a = accounts.find(x => x.id === id); if (a?.username) navigator.clipboard.writeText(a.username).then(() => toast('Username copied', 'ok')); else toast('No username', 'err'); }
function ctxCopyCookie(id) { closeCardMenu(); const a = accounts.find(x => x.id === id); if (a?.cookie) navigator.clipboard.writeText(a.cookie).then(() => toast('Cookie copied', 'ok')); else toast('No cookie saved for this account', 'err'); }
async function ctxOpenBrowser(id) {
  closeCardMenu();
  const a = accounts.find(x => x.id === id);
  if (!a?.cookie) { toast('No cookie saved for this account', 'err'); return; }
  toast('Opening browser…', 'ok');
  let res;
  try { res = await api.openAccountInBrowser(a.cookie); } catch { res = null; }
  if (!res || !res.ok) toast((res && res.error) || 'Could not open browser', 'err');
}

function refreshPkgAvatarStatus() {
  document.querySelectorAll('.pkg-avatar[data-acc-id]').forEach(av => {
    av.classList.toggle('online', _launchedIds.has(av.dataset.accId));
  });
  // Keeps each group's Kill button in sync even when instances start/stop
  // outside launchPackage/killPackage.
  packages.forEach(p => {
    const btn = document.querySelector('.pkg-card[data-id="' + p.id + '"] .pkg-kill-btn');
    if (!btn || btn.dataset.busy === '1') return;
    const anyRunning = (p.accountIds || []).some(id => _launchedIds.has(id));
    btn.disabled = !anyRunning;
  });
}

function render() {
  const grid = document.getElementById('grid'), empty = document.getElementById('empty'), sub = document.getElementById('acct-sub');
  sub.textContent = accounts.length ? accounts.length + ' account' + (accounts.length !== 1 ? 's' : '') + ' saved' : 'No accounts saved';
  const savedCount = document.getElementById('sb-saved-count');
  if (savedCount) savedCount.textContent = accounts.length ? accounts.length + ' account' + (accounts.length !== 1 ? 's' : '') + ' saved' : 'No accounts saved';
  const savedTime = document.getElementById('sb-saved-time'); if (savedTime) savedTime.textContent = 'Last saved just now';
  if (!accounts.length) { grid.innerHTML = ''; empty.style.display = 'flex'; return; }
  empty.style.display = 'none';
  const list = visibleAccounts();
  grid.classList.toggle('list-view', _acctView === 'list');
  if (!list.length) {
    grid.classList.remove('list-view');
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--t3);font-size:12.5px;padding:40px 0">No accounts match your search or filter.</div>';
    return;
  }
  grid.innerHTML = list.map((a, i) => `
    <div class="card${_launchedIds.has(a.id) ? ' is-live' : ''}${_cookieStatus[a.id] === 'dead' ? ' cookie-dead' : ''}" data-id="${a.id}" style="animation-delay:${i * 18}ms">
      <div class="card-dot${_launchedIds.has(a.id) ? ' launched' : ''}" title="${_launchedIds.has(a.id) ? 'Launched' : 'Not launched'}"></div>
      <span class="material-icons-round drag-handle">drag_indicator</span>
      <div class="card-av" id="av-${a.id}">${esc((a.username || '?')[0].toUpperCase())}</div>
      <div class="card-id">
        <div class="card-name-row">
          <div class="card-name">${esc(a.nickname || a.username || 'Unknown')}</div>
          <span class="card-expired" title="This account's cookie is no longer valid. Re-add the account to refresh it."><span class="material-icons-round">error_outline</span>Expired</span>
        </div>
        <div class="card-uid">${a.userId ? 'ID ' + a.userId : 'No ID'}</div>
      </div>
      <div class="card-game ${a.gameTarget ? 'visible' : ''}" id="gt-${a.id}" title="${esc(a.gameTarget || '')}">${a.gameTarget ? esc(truncate(_gameNameCache[a.id] || extractTargetLabel(a.gameTarget), 22)) : ''}</div>
      <div class="card-row">
        <button class="btn btn-launch" onclick="openLaunch('${a.id}')">
          Start
        </button>
        <button class="btn btn-edit" onclick="openEdit('${a.id}')" aria-label="Edit account">
          <span class="material-icons-round">edit</span>
        </button>
        <button class="btn btn-del" onclick="removeAcc('${a.id}')" aria-label="Remove account">
          <span class="material-icons-round">delete_outline</span>
        </button>
      </div>
    </div>`).join('') + `<div class="card-add" onclick="openLogin()"><span class="material-icons-round card-add-icon">add</span><span class="card-add-label">Add account</span></div>`;
  loadAvatarsBatch(list);
  list.forEach(a => { if (a.gameTarget && !_gameNameCache[a.id]) fetchGameName(a.id, a.gameTarget); });
  checkCookieHealth(list);
  document.querySelectorAll('.card[data-id]').forEach(card => {
    card.addEventListener('contextmenu', e => { e.preventDefault(); showCardMenu(card.dataset.id, e.clientX, e.clientY); });
  });
  initDrag();
}

const _cookieStatus = {}; // id -> 'checking' | 'ok' | 'dead' | 'unknown'
function applyCookieStatus(id) {
  const card = document.querySelector(`.card[data-id="${id}"]`);
  if (card) card.classList.toggle('cookie-dead', _cookieStatus[id] === 'dead');
}
// Surfaces a likely-expired cookie right after a launch auth failure, without
// waiting for the periodic health check. Only genuine auth/cookie errors
// flip the badge, not rate-limits or transient HTTP errors.
function _flagCookieMaybeDead(id, error) {
  if (id && error && /cookie|expired|\b403\b/i.test(error)) {
    _cookieStatus[id] = 'dead';
    applyCookieStatus(id);
  }
}
// Runs `worker` over `items` with at most `limit` in flight at once.
async function _runWithConcurrency(items, limit, worker) {
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

let _cookieCheckRunning = false;
async function checkCookieHealth(list) {
  if (_cookieCheckRunning) return;
  const todo = list.filter(a => a.cookie && _cookieStatus[a.id] === undefined);
  if (!todo.length) return;
  _cookieCheckRunning = true;
  try {
    await _runWithConcurrency(todo, 4, async (a) => {
      if (_cookieStatus[a.id] !== undefined) return;
      _cookieStatus[a.id] = 'checking';
      try {
        const res = await api.validateCookie(a.cookie);
        const st = (res && res.ok) ? 'ok' : 'dead';
        _cookieStatus[a.id] = st;
        if (st === 'dead') logEntry('warn', 'cookie', `Cookie invalid for ${a.username || a.id}`, { accountId: a.id, username: a.username || null, userId: a.userId || null });
        else logEntry('info', 'cookie', `Cookie valid for ${a.username || a.id}`, { accountId: a.id, username: a.username || null, userId: a.userId || null });
      } catch { _cookieStatus[a.id] = 'unknown'; logEntry('warn', 'cookie', `Cookie check failed for ${a.username || a.id}`, { accountId: a.id }); }
      applyCookieStatus(a.id);
    });
  } finally { _cookieCheckRunning = false; }
}

// Recheck ALL cookies every 60s so status stays live
let _recheckRunning = false;
const _cookieCheckedAt = {};            // id -> last validation epoch ms
const OK_RECHECK_MS = 5 * 60 * 1000;    // re-check known-good cookies at most every 5 min
async function recheckAllCookies(force) {
  if (_recheckRunning) return; // bail if a previous pass is still going
  _recheckRunning = true;
  // Flag before the first await so checkCookieHealth's render() pass doesn't race us.
  for (const a of accounts) if (a.cookie && _cookieStatus[a.id] === undefined) _cookieStatus[a.id] = 'checking';
  try {
  let changed = false;
  const now = Date.now();
  const todo = accounts.filter(a => {
    if (!a.cookie) return false;
    // Known-good cookies recheck every few minutes; dead/unknown ones every tick.
    if (!force && _cookieStatus[a.id] === 'ok' && _cookieCheckedAt[a.id] && (now - _cookieCheckedAt[a.id]) < OK_RECHECK_MS) return false;
    return true;
  });
  await _runWithConcurrency(todo, 4, async (a) => {
    const prev = _cookieStatus[a.id];
    _cookieStatus[a.id] = 'checking';
    try {
      const res = await api.validateCookie(a.cookie);
      _cookieCheckedAt[a.id] = Date.now();
      const next = (res && res.ok) ? 'ok' : 'dead';
      if (next !== prev) {
        _cookieStatus[a.id] = next;
        applyCookieStatus(a.id); // toggles .cookie-dead on the card (badge + ring)
        changed = true;
        if (next === 'dead') logEntry('warn', 'cookie', `Cookie expired for ${a.username || a.id}`, { accountId: a.id, username: a.username, userId: a.userId });
        else if (prev === 'dead' && next === 'ok') logEntry('ok', 'cookie', `Cookie re-validated for ${a.username || a.id}`, { accountId: a.id, username: a.username, userId: a.userId });
      } else {
        _cookieStatus[a.id] = next;
      }
    } catch { _cookieStatus[a.id] = prev || 'unknown'; }
  });
  if (changed) render(); // rebuild once at the end so the cards match
  } finally { _recheckRunning = false; }
}
setInterval(() => { if (accounts.length) recheckAllCookies(false); }, 60000);


const _gameNameCache = {}; // accountId -> resolved game name
let _gameNamePersist = {}; // target -> resolved name, persisted to localStorage
try { _gameNamePersist = JSON.parse(localStorage.getItem('mr-gamenames') || '{}'); } catch { _gameNamePersist = {}; }
function _saveGameNames() { try { localStorage.setItem('mr-gamenames', JSON.stringify(_gameNamePersist)); } catch {} }

function extractTargetLabel(target) {
  if (!target) return '';
  const t = target.trim();
  if (/^\d+$/.test(t)) return t;
  try {
    const u = new URL(t.startsWith('http') ? t : 'https://' + t);
    const parts = u.pathname.split('/').filter(Boolean);
    // extract linkCode or share code for private servers
    const name = (parts[2] || parts[1] || '').replace(/-/g, ' ').trim();
    return name || u.hostname;
  } catch { return truncate(target, 22); }
}

async function fetchGameName(accountId, target) {
  if (!target) return;
  const t = target.trim();
  // Persistent cache hit: skip the network entirely.
  if (_gameNamePersist[t]) {
    _gameNameCache[accountId] = _gameNamePersist[t];
    updateGameLabel(accountId);
    return;
  }
  // Find the account to get its cookie for authenticated requests
  const acct = accounts.find(a => a.id === accountId);
  const cookie = acct ? acct.cookie : null;
  let placeId = null;
  if (/^\d+$/.test(t)) {
    placeId = t;
  } else {
    try {
      const u = new URL(t.startsWith('http') ? t : 'https://' + t);
      const parts = u.pathname.split('/').filter(Boolean);
      // /games/<placeId>/... or /games/<placeId>
      if (parts[0] === 'games' && parts[1] && /^\d+$/.test(parts[1])) placeId = parts[1];
      if (!placeId) placeId = u.searchParams.get('placeId');
      // PlaceLauncher URLs: ?placeId=...
      if (!placeId) { const m = t.match(/[?&]placeId=(\d+)/); if (m) placeId = m[1]; }
    } catch {}
  }
  if (!cookie) {
    _gameNameCache[accountId] = extractTargetLabel(target);
    updateGameLabel(accountId);
    return;
  }
  // Fetch via main process (authenticated with cookie)
  const name = await api.getGameName(placeId || t, cookie);
  _gameNameCache[accountId] = name || extractTargetLabel(target);
  // Persist only genuine resolved names (not the raw fallback label).
  if (name) { _gameNamePersist[t] = name; _saveGameNames(); }
  updateGameLabel(accountId);
}

function updateGameLabel(accountId) {
  const el = document.getElementById('gt-' + accountId);
  if (!el) return;
  const a = accounts.find(x => x.id === accountId);
  if (!a || !a.gameTarget) return;
  el.textContent = truncate(_gameNameCache[accountId] || extractTargetLabel(a.gameTarget), 22);
}

function truncate(s, n) { return s.length > n ? s.slice(0, n) + '\u2026' : s; }

let _dragSaveTimer = null;
let _dragging = null, _dragClone = null, _dragOffX = 0, _dragOffY = 0, _dragOverId = null;

function initDrag() {
  const grid = document.getElementById('grid');

  grid.querySelectorAll('.card').forEach(card => {
    const handle = card.querySelector('.drag-handle');
    const startEl = handle || card;

    startEl.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      if (e.target.closest('button')) return;
      e.preventDefault();

      _dragging = card;
      const rect = card.getBoundingClientRect();
      _dragOffX = e.clientX - rect.left;
      _dragOffY = e.clientY - rect.top;

      // Create floating clone
      _dragClone = card.cloneNode(true);
      _dragClone.querySelectorAll('.card-kill, .drag-handle').forEach(el => el.remove());
      _dragClone.style.cssText = `
        position:fixed;left:${rect.left}px;top:${rect.top}px;
        width:${rect.width}px;height:${rect.height}px;
        opacity:0.85;pointer-events:none;z-index:9999;
        box-shadow:0 16px 40px rgba(0,0,0,.6);
        transform:scale(1.04);border-color:var(--ac);
        transition:box-shadow .15s;border-radius:var(--r);
        background:var(--s2);border:1px solid var(--ac);
      `;
      if (grid.classList.contains('list-view')) _dragClone.classList.add('drag-list-clone');
      document.body.appendChild(_dragClone);
      card.style.opacity = '0.3';

      document.addEventListener('mousemove', onDragMove);
      document.addEventListener('mouseup', onDragEnd);
    });
  });
}

function onDragMove(e) {
  if (!_dragging || !_dragClone || !_dragging.isConnected) return;
  _dragClone.style.left = (e.clientX - _dragOffX) + 'px';
  _dragClone.style.top  = (e.clientY - _dragOffY) + 'px';

  // nudge the scroll when the cursor gets near the top/bottom edge
  const wrap = document.querySelector('.grid-wrap');
  if (wrap) {
    const wr = wrap.getBoundingClientRect();
    if (e.clientY < wr.top + 60) wrap.scrollTop -= 16;
    else if (e.clientY > wr.bottom - 60) wrap.scrollTop += 16;
  }

  // Find the card under the cursor (the clone is hidden for the hit-test so it
  // never matches itself).
  _dragClone.style.display = 'none';
  const el = document.elementFromPoint(e.clientX, e.clientY);
  _dragClone.style.display = '';
  const target = el ? el.closest('.card[data-id]') : null;
  if (!target || target === _dragging) return;
  const newId = target.dataset.id;
  if (newId === _dragOverId) return; // already settled against this neighbour
  _dragOverId = newId;

  // Move the dragged node in place instead of a full re-render.
  const grid = document.getElementById('grid');
  const cards = Array.from(grid.querySelectorAll('.card[data-id]'));
  const srcPos = cards.indexOf(_dragging);
  const tgtPos = cards.indexOf(target);
  if (srcPos < 0 || tgtPos < 0) return;
  grid.insertBefore(_dragging, srcPos < tgtPos ? target.nextSibling : target);
  _syncAccountsOrderFromDom();
}

// Reorders `accounts` to match the on-screen card order; accounts hidden by
// an active search/filter keep their positions.
function _syncAccountsOrderFromDom() {
  const grid = document.getElementById('grid');
  const visIds = Array.from(grid.querySelectorAll('.card[data-id]')).map(c => c.dataset.id);
  const visSet = new Set(visIds);
  const byId = new Map(accounts.filter(a => visSet.has(a.id)).map(a => [a.id, a]));
  const queue = visIds.map(id => byId.get(id)).filter(Boolean);
  let qi = 0;
  accounts = accounts.map(a => (visSet.has(a.id) ? queue[qi++] : a));
}

function onDragEnd() {
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);

  if (_dragClone) { _dragClone.remove(); _dragClone = null; }
  if (_dragging) { _dragging.style.opacity = ''; _dragging = null; }
  _dragOverId = null;

  // settle the DOM and rebind the drag handlers with one render
  render();

  clearTimeout(_dragSaveTimer);
  _dragSaveTimer = setTimeout(() => {
    api.reorderAccounts(accounts.map(a => a.id));
  }, 400);
}

function loadAvatar(id, uid) {
  if (_avatarCache[uid]) {
    paintAccountAvatar(id, uid, _avatarCache[uid]);
    return;
  }
  api.robloxGet('https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=' + uid + '&size=48x48&format=Png')
    .then(res => res.data).then(d => {
      const url = d?.data?.[0]?.imageUrl;
      if (url) {
        _avatarCache[uid] = url;
        paintAccountAvatar(id, uid, url);
      }
    }).catch(() => {});
}

function paintAccountAvatar(id, uid, url) {
  ['av-' + id, 'pkg-picker-av-' + id, 'tracking-av-' + id].forEach(elId => {
    const el = document.getElementById(elId);
    if (el && !el.querySelector('img')) el.innerHTML = '<img src="' + esc(url) + '" alt=""/>';
  });
}

// One batched request for uncached accounts instead of one per account.
async function loadAvatarsBatch(list) {
  const paint = a => {
    if (a.userId && _avatarCache[a.userId]) {
      paintAccountAvatar(a.id, a.userId, _avatarCache[a.userId]);
    }
  };
  const need = [], seen = new Set();
  for (const a of list) {
    if (!a.userId) continue;
    if (_avatarCache[a.userId]) { paint(a); continue; }
    if (!seen.has(a.userId)) { seen.add(a.userId); need.push(a.userId); }
  }
  for (let i = 0; i < need.length; i += 100) {
    const chunk = need.slice(i, i + 100);
    try {
      const res = await api.robloxGet('https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=' + chunk.join(',') + '&size=48x48&format=Png');
      const d = res.data;
      (d?.data || []).forEach(item => { if (item && item.targetId && item.imageUrl) _avatarCache[item.targetId] = item.imageUrl; });
      list.forEach(paint);
    } catch {
      chunk.forEach(uid => { const a = list.find(x => x.userId === uid); if (a) loadAvatar(a.id, uid); });
    }
  }
}

function loadPkgAvatar(pkgId, accountId, uid, attempt) {
  const elId = 'pkg-av-' + pkgId + '-' + accountId;
  const paint = url => {
    _avatarCache[uid] = url;
    const el = document.getElementById(elId);
    if (el) el.innerHTML = '<img src="' + esc(url) + '" alt=""/><span class="pkg-avatar-dot"></span>';
  };
  if (_avatarCache[uid]) { paint(_avatarCache[uid]); return; }
  api.robloxGet('https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=' + uid + '&size=48x48&format=Png')
    .then(res => res.data).then(d => {
      const item = d?.data?.[0];
      if (item && item.imageUrl && item.state === 'Completed') { paint(item.imageUrl); return; }
      // Roblox returns Pending while it generates the thumbnail; retry briefly.
      if (item && item.state === 'Pending' && (attempt || 0) < 3) {
        setTimeout(() => loadPkgAvatar(pkgId, accountId, uid, (attempt || 0) + 1), 1500);
      } else if (item && item.imageUrl) { paint(item.imageUrl); }
    }).catch(() => {});
}

// ── Avatar hover card ───────────────────────────────────────────────────────
const _userInfoCache = {};
function loadUserInfo(uid, cb) {
  if (_userInfoCache[uid]) { cb(_userInfoCache[uid]); return; }
  api.robloxGet('https://users.roblox.com/v1/users/' + uid)
    .then(res => res.data).then(d => { _userInfoCache[uid] = d; cb(d); })
    .catch(() => cb(null));
}

function positionAvTip(av, tip) {
  const rect = av.getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = rect.left + rect.width / 2 - tw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  let top = rect.top - th - 10;
  if (top < 8) top = rect.bottom + 10;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

function showAvTip(av) {
  const uid = av.dataset.uid || '';
  const uname = av.dataset.uname || '';
  const nick = av.dataset.nick || '';
  const tip = document.getElementById('av-tip');
  tip.dataset.uid = uid;
  document.getElementById('av-tip-name').textContent = nick && nick !== uname ? nick : (uname || 'Unknown');
  document.getElementById('av-tip-uname').textContent = uname ? '@' + uname : (uid ? 'ID ' + uid : '');
  const avEl = document.getElementById('av-tip-av');
  avEl.innerHTML = _avatarCache[uid] ? '<img src="' + _avatarCache[uid] + '" alt=""/>' : (uname || '?')[0].toUpperCase();
  document.getElementById('av-tip-created').textContent = uid ? 'Loading\u2026' : 'Unknown';
  tip.classList.add('show');
  positionAvTip(av, tip);
  if (uid) {
    loadUserInfo(uid, info => {
      if (tip.dataset.uid !== uid || !tip.classList.contains('show')) return;
      const createdEl = document.getElementById('av-tip-created');
      if (info && info.created) {
        const d = new Date(info.created);
        createdEl.textContent = 'Created ' + d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      } else {
        createdEl.textContent = 'Unknown';
      }
      positionAvTip(av, tip);
    });
  }
}

function hideAvTip() {
  document.getElementById('av-tip').classList.remove('show');
}

document.addEventListener('mouseover', e => {
  const av = e.target.closest('.pkg-avatar:not(.more)');
  if (av) showAvTip(av);
});
document.addEventListener('mouseout', e => {
  const av = e.target.closest('.pkg-avatar:not(.more)');
  if (av && !(e.relatedTarget && av.contains(e.relatedTarget))) hideAvTip();
});
window.addEventListener('scroll', hideAvTip, true);

function _showPanel(panel) {
  ['choose','cookie','browser'].forEach(p => {
    document.getElementById('login-panel-' + p).style.display = p === panel ? '' : 'none';
  });
  document.getElementById('btn-cookie-add').style.display = panel === 'cookie' ? '' : 'none';
  document.getElementById('btn-login-back').style.display = panel === 'choose' ? 'none' : '';
  setStatus('login-status', 'hidden', '');
}

function openLogin() {
  document.getElementById('cookie-input').value = '';
  _showPanel('choose');
  openModal('m-login');
}

function showCookiePanel() {
  _showPanel('cookie');
  setTimeout(() => document.getElementById('cookie-input').focus(), 50);
}

function backToChoose() {
  _showPanel('choose');
}

async function startBrowserLogin() {
  _showPanel('browser');
  // Show waiting state by default - only switch to download UI if Chrome needs to be downloaded
  document.getElementById('login-dl').style.display = 'none';
  document.getElementById('login-waiting').style.display = '';
  document.getElementById('dl-bar').style.width = '0%';
  document.getElementById('dl-pct').textContent = '0%';
  const res = await api.openLogin();
  if (!document.getElementById('m-login').classList.contains('open')) return;
  if (!res || !res.success) {
    if (res && res.error && res.error !== 'Login window closed') {
      _showPanel('choose');
      setStatus('login-status', 'err', '<span class="material-icons-round">error_outline</span>' + esc(res.error));
    } else {
      closeModal('m-login');
    }
    return;
  }
  await finishLogin(res);
}

async function addByCookie() {
  let cookie = document.getElementById('cookie-input').value.trim();
  if (!cookie) return;
  // Strip any prefix the user may have accidentally included
  if (cookie.startsWith('.ROBLOSECURITY=')) cookie = cookie.slice('.ROBLOSECURITY='.length);
  if (cookie.startsWith('ROBLOSECURITY=')) cookie = cookie.slice('ROBLOSECURITY='.length);
  // Remove any surrounding quotes
  cookie = cookie.replace(/^["']|["']$/g, '').trim();
  if (!cookie || cookie.length < 100) {
    setStatus('login-status', 'err', '<span class="material-icons-round">error_outline</span>Cookie looks too short - make sure you copied the full value');
    return;
  }
  const btn = document.getElementById('btn-cookie-add');
  btn.disabled = true;
  btn.innerHTML = '<div class="spin"></div>Verifying';
  setStatus('login-status', 'load', '<div class="spin"></div>Verifying cookie…');
  const res = await api.validateCookie(cookie);
  btn.disabled = false;
  btn.innerHTML = '<span class="material-icons-round" style="font-size:15px">check</span>Add Account';
  if (!res.ok) {
    setStatus('login-status', 'err', '<span class="material-icons-round">error_outline</span>' + (res.reason || 'Invalid cookie: make sure you copied the full .ROBLOSECURITY value'));
    return;
  }
  await finishLogin({ success: true, cookie, username: res.username, userId: res.userId });
}

function cancelLogin() {
  closeModal('m-login');
  api.cancelLogin && api.cancelLogin();
}

async function finishLogin(res) {
  setStatus('login-status', 'ok', '<span class="material-icons-round">check_circle</span>Signed in as ' + esc(res.username));
  const a = await api.addAccount({ username: res.username, userId: res.userId, cookie: res.cookie, gameTarget: '' });
  accounts.push(a); render();
  setTimeout(() => {
    closeModal('m-login');
    toast('Added ' + esc(res.username), 'ok');
    const grid = document.getElementById('grid');
    if (grid) grid.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 800);
}

function openEdit(id) {
  editAcc = accounts.find(a => a.id === id); if (!editAcc) return;
  document.getElementById('edit-title').textContent = 'Edit account';
  document.getElementById('edit-head-name').textContent = editAcc.username || 'Unknown';
  document.getElementById('edit-head-meta').textContent =
    (editAcc.username ? '@' + editAcc.username : '') +
    (editAcc.userId ? (editAcc.username ? ' · ' : '') + 'ID ' + editAcc.userId : '');
  // Letter fallback first, then swap in the cached headshot if we have one.
  const av = document.getElementById('edit-av');
  av.innerHTML = esc((editAcc.username || '?')[0].toUpperCase());
  if (editAcc.userId && _avatarCache[editAcc.userId]) {
    av.innerHTML = '<img src="' + esc(_avatarCache[editAcc.userId]) + '" alt=""/>';
  }
  document.getElementById('in-nickname').value = editAcc.nickname || '';
  document.getElementById('in-description').value = editAcc.description || '';
  document.getElementById('in-target').value = editAcc.gameTarget || '';
  openModal('m-edit');
  setTimeout(() => document.getElementById('in-nickname').focus(), 220);
}

async function saveEdit() {
  if (!editAcc) return;
  const target = document.getElementById('in-target').value.trim();
  const nickname = document.getElementById('in-nickname').value.trim();
  const description = document.getElementById('in-description').value.trim();
  const updated = await api.updateAccount(editAcc.id, { gameTarget: target, nickname, description });
  if (updated) {
    const idx = accounts.findIndex(a => a.id === editAcc.id);
    if (idx !== -1) {
      accounts[idx] = updated;
      delete _gameNameCache[editAcc.id]; // clear stale name
      render();
      if (target) fetchGameName(editAcc.id, target); // fetch new name immediately
    } else { render(); }
  }
  closeModal('m-edit');
  toast('Saved', 'ok');
}

function confirmAction(message, onConfirm) {
  document.getElementById('m-confirm-delete-msg').textContent = message;
  const btn = document.getElementById('m-confirm-delete-btn');
  const newBtn = btn.cloneNode(true); // clone to remove old listeners
  btn.parentNode.replaceChild(newBtn, btn);
  newBtn.addEventListener('click', () => { closeModal('m-confirm-delete'); onConfirm(); });
  // All overlays share the same z-index, so equal-z stacking falls back to
  // DOM order -- moving this to the end of <body> guarantees it renders on
  // top even when triggered from inside another already-open modal (e.g.
  // "Clear data" on the encryption lock screen), instead of silently
  // rendering underneath it.
  document.body.appendChild(document.getElementById('m-confirm-delete'));
  openModal('m-confirm-delete');
}

async function removeAcc(id) {
  const a = accounts.find(x => x.id === id);
  if (!a) return;
  confirmAction('Remove "' + a.username + '"? This cannot be undone.', async () => {
    await api.removeAccount(id); accounts = accounts.filter(x => x.id !== id); render();
    if (packages.some(p => p.accountIds.includes(id))) {
      packages.forEach(p => { p.accountIds = p.accountIds.filter(aid => aid !== id); });
      api.savePackages(packages);
      renderPackages();
    }
    forgetTrackingAccount(id);
    toast('Removed ' + a.username, 'err');
  });
}
async function clearAll() {
  if (!accounts.length) return;
  const genCount = _genHistory.length;
  const msg = 'Remove all ' + accounts.length + ' account' + (accounts.length === 1 ? '' : 's')
    + (genCount ? ' and ' + genCount + ' generated account' + (genCount === 1 ? '' : 's') + ' from the generator history' : '')
    + '? This cannot be undone.';
  confirmAction(msg, async () => {
    for (const a of accounts) { await api.removeAccount(a.id); forgetTrackingAccount(a.id); }
    accounts = []; render(); document.getElementById('stat-count').textContent = '0';
    packages.forEach(p => { p.accountIds = []; });
    api.savePackages(packages);
    renderPackages();
    // The generator history holds usernames, passwords and cookies of its own,
    // so "remove all saved accounts and sign-in data" has to take it too --
    // otherwise the most sensitive records survive the wipe.
    if (genCount) {
      _genHistory = [];
      _lastGenData = null;
      genRenderHistory();
      try { await api.clearGenHistory(); } catch {}
    }
    toast('All accounts cleared', 'err');
  });
}

function openLaunch(id) {
  launchAcc = accounts.find(a => a.id === id); if (!launchAcc) return;
  const target = launchAcc.gameTarget || '';
  const gameName = _gameNameCache[launchAcc.id] || (target ? extractTargetLabel(target) : '');
  const p = document.getElementById('launch-prev');
  p.innerHTML = '<div class="prev-av" id="prev-av">' + esc((launchAcc.username || '?')[0].toUpperCase()) + '</div>' +
    '<div><div class="prev-name">' + esc(launchAcc.username) + '</div>' +
    '<div class="prev-uid">' + esc(gameName || 'Opens home screen') + '</div></div>';
  // Avatar
  if (launchAcc.userId) {
    api.robloxGet('https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=' + launchAcc.userId + '&size=48x48&format=Png')
      .then(res => res.data).then(d => {
        const url = d?.data?.[0]?.imageUrl, el = document.getElementById('prev-av');
        if (url && el) el.innerHTML = '<img src="' + esc(url) + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>';
      }).catch(() => {});
  }

  setStatus('launch-status', 'hidden', '');
  _launchingId = null;
  const btn = document.getElementById('btn-launch');
  btn.disabled = false; btn.innerHTML = 'Start';
  openModal('m-launch');
}
// The Cancel button doubles as "abandon the launch in progress": a launch can
// take ~30s (stagger, ticket retries, spawn retries), so closing the modal
// alone would leave it running with no way to stop it.
let _launchingId = null;
async function cancelLaunchOrClose() {
  if (_launchingId) {
    const id = _launchingId;
    try { await api.cancelLaunch(id); } catch {}
    logEntry('warn', 'launch', 'Launch cancelled', { accountId: id });
  }
  closeModal('m-launch');
}

async function doLaunch() {
  if (!launchAcc) return;
  const btn = document.getElementById('btn-launch');
  if (btn.disabled) return;
  _launchingId = launchAcc.id;
  btn.disabled = true; btn.innerHTML = '<div class="spin"></div>Launching';
  setStatus('launch-status', 'load', '<div class="spin"></div>Getting auth ticket\u2026');
  logEntry('info', 'launch', `Launching Roblox for ${launchAcc.username || launchAcc.id}...`, { accountId: launchAcc.id, username: launchAcc.username, userId: launchAcc.userId, target: launchAcc.gameTarget || 'Roblox home' });
  let res;
  try {
    res = await api.launchRoblox(launchAcc.id, launchAcc.cookie, launchAcc.gameTarget || null);
  } catch (e) {
    // Should never reject in practice (the backend command always resolves
    // with {success:false,...} on failure), but if it ever does, the button
    // must not stay stuck on "Launching..." forever with no way out.
    res = { success: false, error: e?.message || String(e) };
  }
  _launchingId = null;
  if (res.cancelled) {
    // The user already asked for this and the modal is closing - don't shout
    // an error at them on the way out.
    btn.disabled = false; btn.innerHTML = 'Start';
    closeModal('m-launch');
    return;
  }
  if (!res.success) {
    logEntry('err', 'launch', `Launch failed for ${launchAcc.username || launchAcc.id}: ${res.error}`, { accountId: launchAcc.id });
    setStatus('launch-status', 'err', '<span class="material-icons-round">error_outline</span>' + esc(res.error));
    _flagCookieMaybeDead(launchAcc.id, res.error);
    btn.disabled = false; btn.innerHTML = 'Start';
    return;
  }
  setStatus('launch-status', 'ok', '<span class="material-icons-round">check_circle</span>Launched as ' + launchAcc.username);
  logEntry('ok', 'launch', `Roblox launched successfully as ${launchAcc.username || launchAcc.id}`, { accountId: launchAcc.id, username: launchAcc.username, userId: launchAcc.userId });
  markLaunched(launchAcc.id);
  setTimeout(() => { closeModal('m-launch'); toast('Launched as ' + launchAcc.username, 'ok'); }, 700);
}

// ── Packages ──────────────────────────────────────────────────────────────
function renderPackages() {
  const list = document.getElementById('pkg-list'), empty = document.getElementById('pkg-empty');
  if (!list) return;
  if (!packages.length) { list.innerHTML = ''; empty.style.display = 'flex'; return; }
  empty.style.display = 'none';
  list.innerHTML = packages.map((p, i) => {
    const members = (p.accountIds || []).map(id => accounts.find(a => a.id === id)).filter(Boolean);
    const shown = members.slice(0, 6);
    const extra = members.length - shown.length;
    const avatarsHtml = shown.map(m => `<div class="pkg-avatar${_launchedIds.has(m.id) ? ' online' : ''}" id="pkg-av-${p.id}-${m.id}" data-acc-id="${m.id}" data-uid="${m.userId || ''}" data-uname="${esc(m.username || '')}" data-nick="${esc(m.nickname || '')}">${esc((m.username || '?')[0].toUpperCase())}<span class="pkg-avatar-dot"></span></div>`).join('')
      + (extra > 0 ? `<div class="pkg-avatar more">+${extra}</div>` : '');
    return `
    <div class="pkg-card" data-id="${p.id}" style="animation-delay:${i * 18}ms">
      <div class="pkg-card-top">
        <div class="sr-icon"><span class="material-icons-round">groups</span></div>
        <div class="pkg-card-info">
          <div class="pkg-name">${esc(p.name)}</div>
          <div class="pkg-meta">${members.length} account${members.length !== 1 ? 's' : ''}</div>
        </div>
        <div class="pkg-avatars">${avatarsHtml}</div>
        <div class="pkg-card-actions">
          <button class="btn btn-edit" onclick="openEditPackage('${p.id}')" aria-label="Manage accounts">
            <span class="material-icons-round">group</span>
          </button>
          <button class="btn btn-del" onclick="deletePackage('${p.id}')" aria-label="Delete package">
            <span class="material-icons-round">delete_outline</span>
          </button>
        </div>
      </div>
      <div class="pkg-link-row">
        <div class="pkg-link-field">
          <span class="material-icons-round pkg-link-icon">link</span>
          <input type="text" class="pkg-link-input" id="pkg-link-${p.id}" placeholder="Game ID or server link for everyone to join…"
            value="${esc(p.link || '')}" onchange="setPackageLink('${p.id}', this.value)"
            onkeydown="if(event.key==='Enter'){this.blur();launchPackage('${p.id}');}"/>
        </div>
        <button class="btn btn-launch pkg-launch-btn" onclick="launchPackage('${p.id}')" ${members.length ? '' : 'disabled'}>
          Start All
        </button>
        <button class="btn btn-del pkg-kill-btn" onclick="killPackage('${p.id}')" ${members.some(m => _launchedIds.has(m.id)) ? '' : 'disabled'}>
          <span class="material-icons-round">power_settings_new</span>
        </button>
      </div>
      <div class="pkg-progress" id="pkg-progress-${p.id}"></div>
    </div>`;
  }).join('');
  packages.forEach(p => {
    (p.accountIds || []).slice(0, 6).forEach(id => {
      const m = accounts.find(a => a.id === id);
      if (m && m.userId) loadPkgAvatar(p.id, m.id, m.userId);
    });
  });
  refreshPkgAvatarStatus();
}

function openCreatePackage() {
  editingPackageId = null;
  document.getElementById('pkg-modal-title').textContent = 'New group';
  document.getElementById('in-pkg-name').value = '';
  renderPackagePicker([]);
  openModal('m-package');
  setTimeout(() => document.getElementById('in-pkg-name').focus(), 220);
}

function openEditPackage(id) {
  const p = packages.find(x => x.id === id); if (!p) return;
  editingPackageId = id;
  document.getElementById('pkg-modal-title').textContent = 'Edit group';
  document.getElementById('in-pkg-name').value = p.name || '';
  renderPackagePicker(p.accountIds || []);
  openModal('m-package');
}

function renderPackagePicker(selectedIds) {
  const wrap = document.getElementById('pkg-account-picker');
  if (!accounts.length) {
    wrap.innerHTML = '<div class="pkg-pick-empty">No accounts yet. Add one from the Accounts tab first.</div>';
    updatePkgCount();
    return;
  }
  wrap.innerHTML = accounts.map(a => `
    <label class="pm-row">
      <input type="checkbox" value="${a.id}" ${selectedIds.includes(a.id) ? 'checked' : ''}/>
      <span class="pm-av" id="pkg-picker-av-${a.id}">${esc((a.username || '?')[0].toUpperCase())}</span>
      <span class="pm-info">
        <span class="pm-name">${esc(a.nickname || a.username || 'Unknown')}</span>
        <span class="pm-meta">${a.userId ? 'ID ' + a.userId : 'No ID'}</span>
      </span>
      <span class="pm-check"><span class="material-icons-round">check</span></span>
    </label>`).join('');
  updatePkgCount();
  loadAvatarsBatch(accounts);
}

function updatePkgCount() {
  const el = document.getElementById('pkg-count');
  if (!el) return;
  const n = document.querySelectorAll('#pkg-account-picker input:checked').length;
  el.textContent = n + ' selected';
}

function savePackageModal() {
  const name = document.getElementById('in-pkg-name').value.trim();
  if (!name) { toast('Give the group a name', 'err'); return; }
  const checked = Array.from(document.querySelectorAll('#pkg-account-picker input:checked')).map(c => c.value);
  if (editingPackageId) {
    const p = packages.find(x => x.id === editingPackageId);
    if (p) { p.name = name; p.accountIds = checked; }
  } else {
    packages.push({ id: crypto.randomUUID(), name, accountIds: checked, link: '' });
  }
  api.savePackages(packages);
  renderPackages();
  closeModal('m-package');
  toast('Group saved', 'ok');
}

function deletePackage(id) {
  const p = packages.find(x => x.id === id); if (!p) return;
  confirmAction('Delete package "' + p.name + '"? The accounts themselves won\u2019t be removed.', () => {
    packages = packages.filter(x => x.id !== id);
    api.savePackages(packages);
    renderPackages();
    toast('Group deleted', 'err');
  });
}

function setPackageLink(id, value) {
  const p = packages.find(x => x.id === id); if (!p) return;
  p.link = value.trim();
  api.savePackages(packages);
}

async function launchPackage(id) {
  const p = packages.find(x => x.id === id); if (!p) return;
  const members = (p.accountIds || []).map(aid => accounts.find(a => a.id === aid)).filter(Boolean);
  if (!members.length) { toast('This group has no accounts yet', 'err'); return; }

  const card = document.querySelector('.pkg-card[data-id="' + id + '"]');
  const btn = card ? card.querySelector('.pkg-launch-btn') : null;
  const killBtn = card ? card.querySelector('.pkg-kill-btn') : null;
  // launchPackage/killPackage share the same progress chips -- block one while the other runs.
  if (btn && btn.dataset.busy === '1') return;
  if (killBtn && killBtn.dataset.busy === '1') { toast('A kill is already in progress for this group', 'err'); return; }
  if (btn) btn.dataset.busy = '1';
  if (killBtn) killBtn.disabled = true;
  const progress = document.getElementById('pkg-progress-' + id);
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spin"></div>Launching'; }
  if (progress) {
    progress.innerHTML = members.map(m => `
      <span class="pkg-chip load" id="pkg-chip-${id}-${m.id}">
        <div class="spin" style="width:9px;height:9px;border-width:2px"></div>${esc(m.nickname || m.username || '')}
      </span>`).join('');
  }

  const link = (p.link || '').trim();
  let okCount = 0;
  await Promise.all(members.map(async (m) => {
    const target = link || m.gameTarget || null;
    logEntry('info', 'launch', `Launching Roblox for ${m.username || m.id} (package)...`, { accountId: m.id, username: m.username || null, userId: m.userId || null, target: target || 'Roblox home' });
    const res = await api.launchRoblox(m.id, m.cookie, target);
    const chip = document.getElementById('pkg-chip-' + id + '-' + m.id);
    if (res.success) {
      okCount++;
      logEntry('ok', 'launch', `Launched as ${m.username || m.id} (package)`, { accountId: m.id, username: m.username || null });
      markLaunched(m.id);
      if (chip) { chip.className = 'pkg-chip ok'; chip.innerHTML = '<span class="material-icons-round">check_circle</span>' + esc(m.nickname || m.username || ''); }
    } else if (chip) {
      chip.className = 'pkg-chip err';
      chip.title = res.error || '';
      chip.innerHTML = '<span class="material-icons-round">error_outline</span>' + esc(m.nickname || m.username || '');
      _flagCookieMaybeDead(m.id, res.error);
    }
  }));

  if (btn) { btn.disabled = false; btn.innerHTML = 'Start All'; delete btn.dataset.busy; }
  if (killBtn && killBtn.dataset.busy !== '1') killBtn.disabled = !members.some(m => _launchedIds.has(m.id));
  toast('Launched ' + okCount + '/' + members.length + ' accounts in "' + p.name + '"', okCount === members.length ? 'ok' : 'err');
}

async function killPackage(id) {
  const p = packages.find(x => x.id === id); if (!p) return;
  const members = (p.accountIds || []).map(aid => accounts.find(a => a.id === aid)).filter(Boolean);
  const running = members.filter(m => _launchedIds.has(m.id));
  if (!running.length) { toast('No running instances in this group', 'err'); return; }

  const card = document.querySelector('.pkg-card[data-id="' + id + '"]');
  const btn = card ? card.querySelector('.pkg-kill-btn') : null;
  const launchBtn = card ? card.querySelector('.pkg-launch-btn') : null;
  if (btn && btn.dataset.busy === '1') return;
  if (launchBtn && launchBtn.dataset.busy === '1') { toast('A launch is already in progress for this group', 'err'); return; }
  if (btn) btn.dataset.busy = '1';
  if (launchBtn) launchBtn.disabled = true;
  const progress = document.getElementById('pkg-progress-' + id);
  if (btn) btn.disabled = true;
  if (progress) {
    progress.innerHTML = running.map(m => `
      <span class="pkg-chip load" id="pkg-chip-${id}-${m.id}">
        <div class="spin" style="width:9px;height:9px;border-width:2px"></div>${esc(m.nickname || m.username || '')}
      </span>`).join('');
  }

  let okCount = 0;
  await Promise.all(running.map(async (m) => {
    logEntry('warn', 'kill', `Killing Roblox instance for ${m.username || m.id} (package)...`, { accountId: m.id, username: m.username || null, userId: m.userId || null });
    const res = await api.killOneRoblox(m.id);
    const chip = document.getElementById('pkg-chip-' + id + '-' + m.id);
    if (res && res.ok) {
      okCount++;
      logEntry('ok', 'kill', `Killed instance for ${m.username || m.id} (package)`, { accountId: m.id });
      if (chip) { chip.className = 'pkg-chip ok'; chip.innerHTML = '<span class="material-icons-round">check_circle</span>' + esc(m.nickname || m.username || ''); }
    } else if (chip) {
      chip.className = 'pkg-chip err';
      chip.title = (res && res.error) || '';
      chip.innerHTML = '<span class="material-icons-round">error_outline</span>' + esc(m.nickname || m.username || '');
    }
  }));

  if (btn) { btn.disabled = !members.some(m => _launchedIds.has(m.id)); delete btn.dataset.busy; }
  if (launchBtn && launchBtn.dataset.busy !== '1') launchBtn.disabled = false;
  toast('Killed ' + okCount + '/' + running.length + ' instances in "' + p.name + '"', okCount === running.length ? 'ok' : 'err');
}

function toggleKeyVisibility(inputId = 'custom-key', iconId = 'key-vis-icon') {
  const input = document.getElementById(inputId), icon = document.getElementById(iconId);
  if (input.type === 'password') { input.type = 'text'; icon.textContent = 'visibility_off'; }
  else { input.type = 'password'; icon.textContent = 'visibility'; }
}
let _saveKeyTimer;
function onKeyInput() {
  const btn = document.getElementById('btn-save-key');
  if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
}
async function saveKeySettings() {
  const keyVal = document.getElementById('custom-key').value;
  const btn = document.getElementById('btn-save-key');
  if (btn.disabled) return;
  clearTimeout(_saveKeyTimer);
  btn.disabled = true; btn.textContent = 'Saving';
  _saveKeyTimer = setTimeout(async () => {
    try {
      // enc:setKey changes the key and re-encrypts accounts in one step.
      const r = await api.encSetKey(keyVal);
      if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'could not update key');
      if (!keyVal.trim()) throw new Error('Encryption key cannot be empty.');
      settings.keySet = true;
      document.getElementById('custom-key').value = '';
      // Reload accounts so the renderer holds cookies under the new key.
      try { accounts = await api.loadAccounts(); flagInvalidCookies(accounts); render(); } catch {}
      toast('Encryption key updated', 'ok');
      applySettings();
    } catch (e) {
      toast('Save failed: ' + e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Save';
    }
  }, 300);
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function setStatus(id, type, html) { const el = document.getElementById(id); el.className = 'mst ' + type; el.innerHTML = html; }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function toast(msg, type) {
  type = type || '';
  const el = document.getElementById('toast'), icon = type === 'ok' ? 'check_circle' : 'cancel';
  el.innerHTML = '<span class="material-icons-round">' + icon + '</span>' + esc(msg);
  el.className = 'toast show ' + type; clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2700);
}

// Defaults multi-instance on for a fresh install, but leaves an explicit
// `false` alone -- this used to force it back on every time the Settings page
// was opened, so the setting could never stay off.
async function refreshMultiStatus() {
  const s = await api.multiInstanceStatus();
  // Driven off the backend's own view rather than the local settings copy, so
  // the switch can't sit out of sync with what the helper is actually doing.
  // That side defaults to on now, so a fresh install shows the switch already
  // enabled without needing the setting written out first.
  const cb = document.getElementById('set-multiinstance');
  if (cb) cb.checked = !!s.enabled;
}

document.querySelectorAll('.overlay').forEach(o => {
  o.addEventListener('mousedown', e => {
    if (e.target === o && o.dataset.backdropClose === 'true') o.classList.remove('open');
  });
});
document.addEventListener('keydown', e => {
  // Ctrl/Cmd+F opens native-style find on the logs page.
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F') && document.getElementById('page-logs')?.classList.contains('active')) {
    e.preventDefault(); openLogFind(); return;
  }
  // Find-bar keys: Enter = next, Shift+Enter = previous, Esc = close.
  if (e.target && e.target.id === 'log-find-input') {
    if (e.key === 'Enter') { e.preventDefault(); logFind(e.shiftKey); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeLogFind(); return; }
  }
  if (e.key === 'Escape') {
    const lf = document.getElementById('log-find');
    if (lf && lf.style.display !== 'none') { closeLogFind(); return; }
    closeAllCdd();
    const editEl = document.getElementById('m-edit');
    if (editEl.classList.contains('open')) {
      // Escape shouldn't discard the modal out from under someone mid-typing.
      const typing = ['in-target', 'in-nickname', 'in-description']
        .some(f => document.activeElement === document.getElementById(f));
      if (!typing) closeModal('m-edit');
    } else document.querySelectorAll('.overlay.open').forEach(m => m.classList.remove('open'));
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); openLogin(); }
  // "/" focuses the account search (when not already typing in a field).
  if (e.key === '/' && document.getElementById('page-accounts')?.classList.contains('active')
      && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
    e.preventDefault();
    document.getElementById('acct-search')?.focus();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && document.getElementById('m-edit').classList.contains('open')) {
    e.preventDefault(); saveEdit();
  }
});

let chartTab = 'popular';
let allCharts = {};
let chartsLoaded = false;

function switchChartTab(tab) {
  chartTab = tab;
  document.querySelectorAll('#page-charts .tab-btn').forEach(t => t.classList.remove('active'));
  document.getElementById('ctab-' + tab).classList.add('active');
  const s = document.getElementById('chart-search'); if (s) s.value = '';
  _searchMode = false;
  if (chartsLoaded) renderCharts(allCharts[tab] || [], false);
  positionTabSlider(document.getElementById('ctab-' + tab).closest('.tab-bar'));
}

async function loadCharts() {
  const grid = document.getElementById('charts-grid');
  const loading = document.getElementById('charts-loading');
  const empty = document.getElementById('charts-empty');
  chartsLoaded = false;
  grid.style.display = 'none'; empty.style.display = 'none'; loading.style.display = 'flex';

  try {
    // Use official Roblox explore-api with a random sessionId per load
    const [popular, trending, favorited] = await Promise.all([
      fetchRobloxGames('top-playing-now'),
      fetchRobloxGames('top-rated'),
      fetchRobloxGames('top-earning'),
    ]);
    allCharts = { popular, trending, favorited };
    chartsLoaded = true;
    loading.style.display = 'none';
    renderCharts(allCharts[chartTab] || [], false);
  } catch(e) {
    console.error('Charts load error:', e);
    loading.style.display = 'none';
    empty.style.display = 'flex';
  }
}

function randomGuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

async function fetchRobloxGames(sortId) {
  // Official Roblox explore API
  const sessionId = randomGuid();
  const url = `https://apis.roblox.com/explore-api/v1/get-sort-content?sessionId=${sessionId}&sortId=${sortId}&device=computer&country=all`;
  const r = await api.robloxGet(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = r.data;

  // Response shape: { sorts: [{ games: [...] }] } or { games: [...] }
  const games = d.games || (d.sorts && d.sorts[0] && d.sorts[0].games) || [];
  if (!games.length) throw new Error('No games in response');

  // Fetch thumbnails for all universeIds
  let thumbMap = {};
  try {
    const universeIds = games.map(g => g.universeId).filter(Boolean).join(',');
    const thumbRes = await api.robloxGet(
      `https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeIds}&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false`
    );
    if (thumbRes.ok) {
      const thumbData = thumbRes.data;
      (thumbData.data || []).forEach(t => { thumbMap[t.targetId] = t.imageUrl; });
    }
  } catch {}

  return games.map(g => ({
    universeId: g.universeId,
    placeId: g.rootPlaceId || g.placeId,
    name: g.name,
    playerCount: g.playerCount,
    thumbUrl: thumbMap[g.universeId] || ''
  }));
}

let _chartGameMap = {};
let _searchDebounce = null;
let _searchMode = false;

function renderCharts(games, searchMode) {
  const grid = document.getElementById('charts-grid');
  const emptyEl = document.getElementById('charts-empty');
  const loading = document.getElementById('charts-loading');
  loading.style.display = 'none';
  _chartGameMap = {};
  if (!games || !games.length) {
    emptyEl.style.display = 'flex';
    grid.style.display = 'none';
    return;
  }
  emptyEl.style.display = 'none';
  grid.style.display = 'grid';
  grid.innerHTML = games.map((g, i) => {
    _chartGameMap[i] = g;
    const players = typeof g.playerCount === 'number' ? Number(g.playerCount).toLocaleString() + ' playing' : '';
    // Rank only means something against the chart order; a search result list
    // has no ranking to show, so the overlay badge is skipped there instead of
    // labelling every card with the same "Search result" text.
    const rankLabel = searchMode ? '' : `<div class="chart-card-rank">#${i + 1}</div>`;
    const thumb = g.thumbUrl
      ? `<img class="chart-card-thumb" src="${esc(g.thumbUrl)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=chart-card-thumb-ph><span class=material-icons-round>videogame_asset</span></div>'"/>`
      : `<div class="chart-card-thumb-ph"><span class="material-icons-round">videogame_asset</span></div>`;
    return `<div class="chart-card" style="animation-delay:${i * 12}ms" onclick="openGameModal(${i})" title="View game info">
      ${thumb}
      ${rankLabel}
      <div class="chart-card-body">
        <div class="chart-card-name">${esc(g.name || 'Unknown')}</div>
        ${players ? `<div class="chart-card-stat"><span class="material-icons-round">people</span>${players}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

async function searchRobloxGames(query) {
  const sessionId = randomGuid();
  const url = `https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(query)}&sessionId=${sessionId}`;
  const r = await api.robloxGet(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = r.data;

  // Extract game universe IDs from omni-search results
  const contents = d.searchResults || [];
  const gameSection = contents.find(s => s.contentGroupType === 'Game') || contents[0];
  if (!gameSection || !gameSection.contents) return [];

  const universeIds = gameSection.contents.map(c => c.contentId).filter(Boolean);
  if (!universeIds.length) return [];

  // Fetch full game details
  const detailsRes = await api.robloxGet(`https://games.roblox.com/v1/games?universeIds=${universeIds.join(',')}`);
  const details = detailsRes.ok ? detailsRes.data : { data: [] };
  const detailMap = {};
  (details.data || []).forEach(g => { detailMap[g.id] = g; });

  // Fetch thumbnails
  let thumbMap = {};
  try {
    const thumbRes = await api.robloxGet(
      `https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeIds.join(',')}&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false`
    );
    if (thumbRes.ok) {
      const td = thumbRes.data;
      (td.data || []).forEach(t => { thumbMap[t.targetId] = t.imageUrl; });
    }
  } catch {}

  return universeIds.map(uid => {
    const det = detailMap[uid] || {};
    return {
      universeId: uid,
      placeId: det.rootPlaceId,
      name: det.name,
      playerCount: det.playing,
      thumbUrl: thumbMap[uid] || ''
    };
  }).filter(g => g.placeId);
}

function filterCharts(val) {
  clearTimeout(_searchDebounce);
  const query = val.trim();
  if (!query) {
    _searchMode = false;
    if (chartsLoaded) renderCharts(allCharts[chartTab] || [], false);
    else {
      document.getElementById('charts-grid').style.display = 'none';
      document.getElementById('charts-empty').style.display = 'none';
      document.getElementById('charts-loading').style.display = 'flex';
    }
    return;
  }
  _searchMode = true;
  _searchDebounce = setTimeout(async () => {
    const grid = document.getElementById('charts-grid');
    const loading = document.getElementById('charts-loading');
    const emptyEl = document.getElementById('charts-empty');
    grid.style.display = 'none';
    emptyEl.style.display = 'none';
    loading.style.display = 'flex';
    try {
      const results = await searchRobloxGames(query);
      // Only apply if search box still has same value
      if (document.getElementById('chart-search').value.trim() === query) {
        renderCharts(results, true);
      }
    } catch(e) {
      console.error('Search error:', e);
      loading.style.display = 'none';
      emptyEl.style.display = 'flex';
    }
  }, 420);
}

let _gameModal = {};
function openGameModal(idx) {
  const g = _chartGameMap[idx];
  if (!g) return;
  _gameModal = g;
  const thumb = document.getElementById('game-modal-thumb');
  if (g.thumbUrl) { thumb.src = g.thumbUrl; thumb.style.display = 'block'; }
  else { thumb.style.display = 'none'; }
  document.getElementById('game-modal-name').textContent = g.name || 'Unknown';
  document.getElementById('game-modal-id').textContent = g.placeId || '-';
  const stat = typeof g.playerCount === 'number' ? Number(g.playerCount).toLocaleString() + ' playing now' : '';
  document.getElementById('game-modal-stat').textContent = stat;
  openModal('m-game');
}
function copyGameId() {
  const id = String(_gameModal.placeId || '');
  if (!id) return;
  navigator.clipboard.writeText(id).then(() => toast('Place ID copied', 'ok'));
}
function gamePageOpen() {
  if (_gameModal.placeId) api.openExternal('https://www.roblox.com/games/' + _gameModal.placeId);
}


// ── Mixer (graphics / fps / volume / kill) ─────────────────────────────────
const FF_GFX = 'DFIntDebugFRMQualityLevelOverride';
const FF_FPS = 'DFIntTaskSchedulerTargetFps';
let _volTimer = null, _mixRunning = 0;

async function mixInit() {
  // Pull current values from saved Fast Flags + settings.
  let flags = {};
  try { flags = (await api.readFFlags()) || {}; } catch {}

  // Graphics
  const gfxRaw = flags[FF_GFX];
  const gfxAuto = (gfxRaw === undefined || gfxRaw === null || gfxRaw === '');
  document.getElementById('mix-gfx-auto').checked = gfxAuto;
  const gfxVal = clampInt(gfxRaw, 1, 21, 10);
  document.getElementById('mix-gfx').value = gfxVal;
  document.getElementById('mix-gfx-val').textContent = gfxAuto ? 'Auto' : gfxVal;
  document.getElementById('mix-gfx').disabled = gfxAuto;

  // FPS - read from GlobalBasicSettings_13.xml via new ipc
  try {
    const fpsCap = await api.readFpsCap();
    const fpsUnl = (fpsCap === 0);
    document.getElementById('mix-fps-unl').checked = fpsUnl;
    document.getElementById('mix-fps').value = fpsUnl ? 60 : Math.max(10, fpsCap || 60);
    document.getElementById('mix-fps-val').textContent = fpsUnl ? '\u221e' : (fpsCap || 60);
    document.getElementById('mix-fps').disabled = fpsUnl;
  } catch {}

  // Volume
  const vol = (typeof settings.masterVolume === 'number') ? settings.masterVolume : 100;
  document.getElementById('mix-vol').value = vol;
  document.getElementById('mix-vol-val').textContent = vol + '%';

  updateSliderFill(document.getElementById('mix-gfx'));
  updateSliderFill(document.getElementById('mix-fps'));
  updateSliderFill(document.getElementById('mix-vol'));
  mixRefreshRunning();
}

// FPS
function mixFpsInput(v) {
  v = parseInt(v, 10);
  const snapped = v >= 9999 ? 9999 : Math.round(v / 5) * 5;
  const sl = document.getElementById('mix-fps');
  if (sl.value != snapped) sl.value = snapped;
  document.getElementById('mix-fps-val').textContent = snapped;
  updateSliderFill(sl);
}
async function mixFpsUnlToggle() {
  const unl = document.getElementById('mix-fps-unl').checked;
  document.getElementById('mix-fps').disabled = unl;
  if (unl) {
    document.getElementById('mix-fps-val').textContent = '\u221e';
    const res = await api.writeFpsCap(0);
    if (res && res.ok === false) toast(res.error || 'Failed to set FPS cap', 'err');
    else toast('FPS set to unlimited (next launch)', 'ok');
  } else {
    mixFpsCommit();
  }
}
async function mixFpsCommit() {
  if (document.getElementById('mix-fps-unl').checked) return;
  const v = parseInt(document.getElementById('mix-fps').value, 10);
  document.getElementById('mix-fps-val').textContent = v;
  const res = await api.writeFpsCap(v);
  if (res && res.ok === false) { toast(res.error || 'Failed to set FPS cap', 'err'); return; }
  toast('FPS cap: ' + v + ' (next launch)', 'ok');
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function setRunningBadges(n) {
  const txt = n + ' running';
  const tb = document.getElementById('tb-running');
  if (tb) {
    tb.textContent = txt;
    tb.classList.toggle('live', n > 0);
    tb.style.display = n > 0 ? 'inline-flex' : 'none';
  }
}

let _statusPoll = null;
let _lastCountPushAt = 0;
async function pollRunningCount() {
  // Skip if a push from the backend landed recently.
  if (Date.now() - _lastCountPushAt < 6500) return;
  let n = 0;
  try { n = await api.getRunningCount(); } catch { n = 0; }
  _mixRunning = n;
  setRunningBadges(n);
}

// Reconciles card state against the backend's watched/alive list, in case a
// push event (onRobloxClosed etc) was missed or lagged.
async function pollWatchedIds() {
  let ids;
  try { ids = await api.getWatchedIds(); } catch { return; }
  const watched = new Set(ids);
  // Cards that drop out of the active filter get pulled from the DOM
  // directly instead of a full render(), which would replay entrance
  // animations and flicker on every poll tick.
  const dropFromFilter = (_acctFilter === 'running' || _acctFilter === 'idle')
    ? id => (_acctFilter === 'running' ? !watched.has(id) : watched.has(id))
    : null;
  document.querySelectorAll('.card[data-id]').forEach(card => {
    const id = card.dataset.id;
    const shouldBeLive = watched.has(id);
    const isLive = card.classList.contains('is-live');
    if (shouldBeLive !== isLive) {
      card.classList.toggle('is-live', shouldBeLive);
      if (!shouldBeLive) card.classList.remove('in-game');
      const dot = card.querySelector('.card-dot');
      if (dot) {
        dot.classList.toggle('launched', shouldBeLive);
        if (!shouldBeLive) dot.classList.remove('in-game');
        dot.title = shouldBeLive ? 'Launched' : 'Not launched';
      }
      if (shouldBeLive) { _launchedIds.add(id); ensurePresencePoll(); } else { _launchedIds.delete(id); }
      if (dropFromFilter && dropFromFilter(id)) card.remove();
    }
  });
  stopPresencePollIfIdle();
}
function pollStatus() {
  pollRunningCount();
  pollWatchedIds();
}
function startStatusPoll() {
  if (_statusPoll) return;
  pollStatus();
  _statusPoll = setInterval(pollStatus, 3000);
}

async function mixRefreshRunning() {
  try {
    _mixRunning = await api.getRunningCount();
  } catch { _mixRunning = 0; }
  setRunningBadges(_mixRunning);
  // No guessing which accounts are live from lastUsed any more: the count now
  // only includes instances the backend actually tracks, and pollWatchedIds()
  // syncs the real set every 3s, so a guess could only mislabel cards.
}

// Merge a single key into the on-disk Fast Flags without disturbing others.
async function mixWriteFlag(key, value) {
  let flags = {};
  try { flags = (await api.readFFlags()) || {}; } catch {}
  if (value === null) delete flags[key];
  else flags[key] = String(value);
  try { await api.writeFFlags(flags); } catch {}
}

// ── Rendering engine (Settings > Performance) ────────────────────────────
// D3D9 removed -- Roblox dropped that render path, forcing it now crashes
// the client with a missing-DLL error instead of falling back.
const RENDER_ENGINE_FLAGS = {
  d3d11: 'FFlagDebugGraphicsPreferD3D11',
  opengl: 'FFlagDebugGraphicsPreferOpenGL',
  vulkan: 'FFlagDebugGraphicsPreferVulkan',
};
const RENDER_ENGINE_LABELS = { '': 'Automatic', d3d11: 'Direct3D 11', opengl: 'OpenGL', vulkan: 'Vulkan' };

async function renderEngineInit() {
  let flags = {};
  try { flags = (await api.readFFlags()) || {}; } catch {}
  // Purge a stale D3D9 flag from before it was removed -- forcing it now
  // crashes the client on launch instead of degrading gracefully.
  if ('FFlagDebugGraphicsPreferD3D9' in flags) {
    delete flags['FFlagDebugGraphicsPreferD3D9'];
    try { await api.writeFFlags(flags); } catch {}
  }
  let current = '';
  for (const [engine, flagName] of Object.entries(RENDER_ENGINE_FLAGS)) {
    if (String(flags[flagName]).toLowerCase() === 'true') { current = engine; break; }
  }
  renderEngineUpdateUI(current);
}

function renderEngineUpdateUI(engine) {
  const label = document.getElementById('cdd-rendereng-label');
  if (label) label.textContent = RENDER_ENGINE_LABELS[engine] || 'Automatic';
  document.querySelectorAll('#cdd-rendereng-menu .cdd-option').forEach(o =>
    o.classList.toggle('selected', o.dataset.value === engine));
}

async function setRenderEngine(engine) {
  let flags = {};
  try { flags = (await api.readFFlags()) || {}; } catch {}
  for (const flagName of Object.values(RENDER_ENGINE_FLAGS)) delete flags[flagName];
  if (engine && RENDER_ENGINE_FLAGS[engine]) flags[RENDER_ENGINE_FLAGS[engine]] = 'True';
  try { await api.writeFFlags(flags); } catch {}
  renderEngineUpdateUI(engine);
  closeAllCdd();
  toast('Rendering engine: ' + (RENDER_ENGINE_LABELS[engine] || 'Automatic') + ' (next launch)', 'ok');
}

// ── Roblox deployment channel (Settings > Roblox) ─────────────────────────
const ROBLOX_CHANNEL_LABELS = { '': 'Production (LIVE)', zcanary: 'Canary', zintegration: 'Integration', znext: 'Next' };

function robloxChannelUpdateUI(channel) {
  const label = document.getElementById('cdd-channel-label');
  if (label) label.textContent = ROBLOX_CHANNEL_LABELS[channel] || 'Production (LIVE)';
  document.querySelectorAll('#cdd-channel-menu .cdd-option').forEach(o =>
    o.classList.toggle('selected', o.dataset.value === channel));
}

function setRobloxChannel(channel) {
  settings.robloxChannel = channel;
  api.saveSettings({ robloxChannel: channel });
  robloxChannelUpdateUI(channel);
  closeAllCdd();
  toast('Roblox channel: ' + (ROBLOX_CHANNEL_LABELS[channel] || 'Production (LIVE)') + (settings.lockChannel ? '' : ' (enable Lock channel to apply)'), 'ok');
  if (settings.lockChannel) detectRobloxVersion();
}

// Smoothly fill the slider track up to the current value.
function updateSliderFill(el) {
  if (!el) return;
  const min = parseFloat(el.min) || 0, max = parseFloat(el.max) || 100, v = parseFloat(el.value);
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  el.style.background = 'linear-gradient(90deg, var(--ac) ' + pct + '%, var(--s4) ' + pct + '%)';
}

// Delegated listener so slider fill stays correct without every call site remembering to update it.
document.addEventListener('input', e => {
  if (e.target.matches && e.target.matches('.fps-slider')) updateSliderFill(e.target);
});

// Graphics
function mixGfxInput(v) {
  document.getElementById('mix-gfx-val').textContent = v;
  updateSliderFill(document.getElementById('mix-gfx'));
}
function mixGfxAutoToggle() {
  const auto = document.getElementById('mix-gfx-auto').checked;
  document.getElementById('mix-gfx').disabled = auto;
  if (auto) {
    document.getElementById('mix-gfx-val').textContent = 'Auto';
    mixWriteFlag(FF_GFX, null);
    toast('Graphics set to Auto', 'ok');
  } else {
    mixGfxCommit();
  }
}
function mixGfxCommit() {
  if (document.getElementById('mix-gfx-auto').checked) return;
  const v = document.getElementById('mix-gfx').value;
  document.getElementById('mix-gfx-val').textContent = v;
  mixWriteFlag(FF_GFX, v);
  toast('Graphics quality: ' + v + ' (next launch)', 'ok');
}

// Volume - applies live while dragging (debounced so we don't spawn the helper
// on every drag tick), and saves + confirms on release.
function mixVolInput(v) {
  document.getElementById('mix-vol-val').textContent = v + '%';
  updateSliderFill(document.getElementById('mix-vol'));
  clearTimeout(_volTimer);
  _volTimer = setTimeout(() => { api.setRobloxVolume(parseInt(v, 10)); }, 90);
}
function mixVolCommit() {
  const v = parseInt(document.getElementById('mix-vol').value, 10);
  document.getElementById('mix-vol-val').textContent = v + '%';
  updateSliderFill(document.getElementById('mix-vol'));
  settings.masterVolume = v;
  api.saveSettings({ masterVolume: v });
  clearTimeout(_volTimer);
  _volTimer = setTimeout(async () => {
    const res = await api.setRobloxVolume(v);
    if (res && res.ok) {
      toast('Volume ' + v + '%', 'ok');
    } else {
      toast('Couldn\u2019t set volume' + (res && res.error ? ': ' + res.error : ''), 'err');
    }
  }, 60);
}

// Kill all
async function mixKillAll() {
  const btns = Array.from(document.querySelectorAll('.kill-roblox-btn'));
  if (!btns.length || btns[0].disabled) return;
  btns.forEach(b => { b.disabled = true; });
  const res = await api.killAllRoblox();
  // Reset all dots / launched state.
  _launchedIds.clear();
  document.querySelectorAll('.card.is-live').forEach(c => c.classList.remove('is-live', 'in-game'));
  document.querySelectorAll('.card-dot.launched').forEach(d => { d.classList.remove('launched', 'in-game'); d.title = 'Not launched'; });
  refreshPkgAvatarStatus();
  stopPresencePollIfIdle();
  await mixRefreshRunning();
  btns.forEach(b => { b.disabled = false; });
  if (res && res.ok) {
    const n = res.killed || 0;
    // Only instances this app launched are killed, so say how many rather
    // than claiming everything Roblox-shaped on the machine is gone.
    let msg = n ? `Closed ${n} instance${n === 1 ? '' : 's'}` : 'No instances launched by MultiRoblox';
    if (res.untracked) msg += ` (${res.untracked} couldn't be identified)`;
    toast(msg, 'ok');
  } else toast('Kill failed' + (res && res.error ? ': ' + res.error : ''), 'err');
}

// Re-pushes current graphics/fps/volume values and confirms; doesn't touch
// any running process (that's the separate Kill all Roblox button).
async function mixApply() {
  const btn = document.getElementById('mix-relaunch-btn');
  if (btn.disabled) return;
  btn.disabled = true;
  const orig = btn.innerHTML;

  mixGfxCommit();
  mixFpsCommit();
  try { await api.setRobloxVolume(document.getElementById('mix-vol').value); } catch {}

  btn.disabled = false;
  btn.innerHTML = orig;
  toast('Settings applied', 'ok');
}

async function mixTrimMemory(btnId = 'set-trim-btn') {
  const btn = document.getElementById(btnId);
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const orig = btn.innerHTML;

  let res;
  try { res = await api.trimRobloxMemory(); } catch { res = null; }

  btn.disabled = false;
  btn.innerHTML = orig;
  if (res && res.ok) {
    toast(res.total > 0 ? `Trimmed ${res.trimmed}/${res.total} instance(s)` : 'No running instances', 'ok');
  } else {
    toast('Trim failed', 'err');
  }
}

function genToggleKey() {
  const inp = document.getElementById('gen-apikey');
  const icon = document.getElementById('gen-eye-icon');
  if (inp.type === 'password') { inp.type = 'text'; icon.textContent = 'visibility_off'; }
  else { inp.type = 'password'; icon.textContent = 'visibility'; }
}

// Provider is auto-detected from the key's prefix so the single API-key field
// works for either service: BLOX- = BloxGen, MG_ = Altgen (altgen.me/docs).
async function genCombo() {
  const apiKey = (document.getElementById('gen-apikey').value || '').trim();
  try { localStorage.setItem('bloxgen_apikey', document.getElementById('gen-apikey').value); } catch {}

  let provider;
  if (apiKey.startsWith('BLOX-')) provider = 'bloxgen';
  else if (apiKey.startsWith('MG_')) provider = 'altgen';
  else {
    toast('Enter a valid API key (BloxGen: BLOX-... or Altgen: MG_...)', 'err');
    return;
  }

  const btn = document.getElementById('gen-btn');
  const out = document.getElementById('gen-output');
  if (btn) { btn.textContent = 'Generating'; btn.disabled = true; }

  try {
    const d = provider === 'bloxgen' ? await genBloxgen(apiKey) : await genAltgen(apiKey);

    out.value = d.username + ':' + d.password;
    out.select();

    // Store in history
    if (_genClearPromise) await _genClearPromise; // let a pending Clear's disk write land first
    _lastGenData = d;
    _genHistory.unshift({ username: d.username, password: d.password, cookie: d.cookie });
    if (_genHistory.length > 500) _genHistory.length = 500; // bound the persisted history
    api.writeGenHistory(_genHistory).catch(() => {});
    _ghPrepend();

    // Copy cookie to clipboard if available, else username:password
    const toCopy = d.cookie || (d.username + ':' + d.password);
    navigator.clipboard.writeText(toCopy).catch(() => {});

    if (btn) { btn.textContent = 'Generate'; btn.disabled = false; }

  } catch (e) {
    toast(e.message || 'Generation failed', 'err');
    if (btn) { btn.textContent = 'Generate'; btn.disabled = false; }
  }
}

async function genBloxgen(apiKey) {
  const resp = await fetch('https://core.bloxgen.net/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey, type: 'alt' })
  });
  const data = await resp.json();
  if (!data.success) throw new Error(data.message || data.error || 'Generation failed');
  return data.data;
}

async function genAltgen(apiKey) {
  const res = await api.altgenGenerate(apiKey, 1);
  const data = res.data;
  if (!data || !data.success) {
    throw new Error((data && data.error && data.error.message) || 'Generation failed');
  }
  const acct = data.data && data.data.accounts && data.data.accounts[0];
  if (!acct) throw new Error('No account returned');
  return { username: acct.username, password: acct.password, cookie: acct.cookie };
}

let _genHistory = [];
let _lastGenData = null;

const GH_ITEM_H = 36;
const GH_VISIBLE = 4;
const GH_BATCH = 40;
let _ghRendered = 0;

function genRenderHistory() {
  const list = document.getElementById('gen-history-list');
  const sc = document.getElementById('gen-history-sc');
  if (!list || !sc) return;
  if (_genHistory.length === 0) { sc.style.display = 'none'; return; }
  sc.style.display = '';
  if (_genHistory.length > GH_VISIBLE) {
    list.style.maxHeight = (GH_ITEM_H * GH_VISIBLE) + 'px';
  } else {
    list.style.maxHeight = '';
  }
  _ghRendered = 0;
  list.innerHTML = '';
  _ghAppendBatch(list);
  list.onscroll = () => {
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 20) _ghAppendBatch(list);
  };
}

function _ghAppendBatch(list) {
  const end = Math.min(_ghRendered + GH_BATCH, _genHistory.length);
  if (_ghRendered >= end) return;
  const frag = document.createDocumentFragment();
  for (let i = _ghRendered; i < end; i++) {
    const h = _genHistory[i];
    const row = document.createElement('div');
    row.className = 'gen-hist-item';
    row.dataset.idx = i;
    row.innerHTML =
      '<span class="gh-user"><span style="color:var(--t3)">User:</span> ' + esc(h.username) + '  <span style="color:var(--t3)">Pass:</span> ' + esc(h.password) + '</span>' +
      '<div class="gh-actions">' +
        '<button class="btn btn-ghost"><span class="material-icons-round" style="font-size:15px">content_copy</span></button>' +
        '<button class="btn btn-ghost"><span class="material-icons-round" style="font-size:15px">person_add</span></button>' +
      '</div>';
    const btns = row.querySelectorAll('button');
    btns[0].onclick = () => genHistCopy(i);
    btns[1].onclick = () => genHistAdd(i);
    frag.appendChild(row);
  }
  list.appendChild(frag);
  _ghRendered = end;
}

function _ghPrepend() {
  const list = document.getElementById('gen-history-list');
  const sc = document.getElementById('gen-history-sc');
  if (!list || !sc) return;
  sc.style.display = '';
  if (_genHistory.length > GH_VISIBLE) list.style.maxHeight = (GH_ITEM_H * GH_VISIBLE) + 'px';
  // Re-index existing rows so their onclick indices stay correct
  list.querySelectorAll('.gen-hist-item').forEach(row => {
    const old = +row.dataset.idx;
    const ni = old + 1;
    row.dataset.idx = ni;
    const btns = row.querySelectorAll('button');
    btns[0].onclick = () => genHistCopy(ni);
    btns[1].onclick = () => genHistAdd(ni);
  });
  _ghRendered++;
  const h = _genHistory[0];
  const row = document.createElement('div');
  row.className = 'gen-hist-item';
  row.dataset.idx = 0;
  row.innerHTML =
    '<span class="gh-user"><span style="color:var(--t3)">User:</span> ' + esc(h.username) + '  <span style="color:var(--t3)">Pass:</span> ' + esc(h.password) + '</span>' +
    '<div class="gh-actions">' +
      '<button class="btn btn-ghost"><span class="material-icons-round" style="font-size:15px">content_copy</span></button>' +
      '<button class="btn btn-ghost"><span class="material-icons-round" style="font-size:15px">person_add</span></button>' +
    '</div>';
  const btns = row.querySelectorAll('button');
  btns[0].onclick = () => genHistCopy(0);
  btns[1].onclick = () => genHistAdd(0);
  list.insertBefore(row, list.firstChild);
  list.scrollTop = 0;
}

function genHistCopy(i) {
  const h = _genHistory[i];
  if (!h) return;
  navigator.clipboard.writeText(h.username + ':' + h.password).then(() => toast('Copied ' + h.username, 'ok'));
}

async function genHistAdd(i) {
  const h = _genHistory[i];
  if (!h || !h.cookie) { toast('No cookie available for this account', 'err'); return; }
  try {
    const res = await api.validateCookie(h.cookie);
    if (!res || !res.username) { toast('Cookie invalid or expired', 'err'); return; }
    const a = await api.addAccount({ username: res.username, userId: res.userId, cookie: h.cookie, gameTarget: '', nickname: '' });
    if (a) { accounts.push(a); render(); toast('Added ' + res.username + ' to accounts', 'ok'); }
  } catch(e) { toast('Failed to add: ' + e.message, 'err'); }
}

async function genAddToAccounts() {
  if (!_lastGenData || !_lastGenData.cookie) { toast('No cookie available', 'err'); return; }
  const btn = document.getElementById('gen-add-btn');
  if (btn) { btn.disabled = true; }
  try {
    const res = await api.validateCookie(_lastGenData.cookie);
    if (!res || !res.username) { toast('Cookie invalid or expired', 'err'); if(btn)btn.disabled=false; return; }
    const a = await api.addAccount({ username: res.username, userId: res.userId, cookie: _lastGenData.cookie, gameTarget: '', nickname: '' });
    if (a) { accounts.push(a); render(); toast('Added ' + res.username + ' to accounts!', 'ok'); }
    if(btn)btn.disabled=false;
  } catch(e) { toast('Failed: ' + e.message, 'err'); if(btn)btn.disabled=false; }
}

// Tracked so a Generate right after Clear can wait for the clear's write to land first.
let _genClearPromise = null;
async function genClearHistory() {
  _genHistory = [];
  _lastGenData = null;
  genRenderHistory();
  toast('History cleared', 'ok');
  _genClearPromise = api.clearGenHistory().catch(() => {});
  await _genClearPromise;
  _genClearPromise = null;
}

function genDetailsCopy() {
  const details = document.getElementById('gen-details');
  const text = details ? details.innerText.replace('copy', '').trim() : '';
  if (!text) { toast('No details to copy', 'err'); return; }
  const btn = document.getElementById('gen-details-copy-btn');
  navigator.clipboard.writeText(text).then(() => {
    if (btn) { const s = btn.querySelector('span:last-child'); if(s){s.textContent='done'; setTimeout(()=>{s.textContent='details';},1500);} }
    toast('Details copied', 'ok');
  });
}

function genCopy() {
  const val = document.getElementById('gen-output').value;
  if (!val) { toast('Nothing to copy', 'err'); return; }
  const btn = document.getElementById('gen-copy-btn');
  navigator.clipboard.writeText(val).then(() => {
    if (btn) {
      const icon = btn.querySelector('.material-icons-round');
      if (icon) { icon.textContent = 'check'; setTimeout(() => { icon.textContent = 'content_copy'; }, 1500); }
    }
    toast('Copied to clipboard', 'ok');
  });
}

// ── Tracking (timed screenshots -> Discord webhook) ─────────────────────────
function getTrackingWebhookUrl() { return settings.trackingWebhookUrl || ''; }
function getTrackingIntervalSec() {
  const s = Number(settings.trackingIntervalSec);
  return Number.isFinite(s) ? Math.min(3600, Math.max(30, Math.round(s))) : 300;
}
function getTrackingTimedIds() { return new Set(Array.isArray(settings.trackingTimedIds) ? settings.trackingTimedIds : []); }
function getTrackingRegions(id) {
  const r = (settings.trackingRegions || {})[id];
  return Array.isArray(r) ? r : [];
}
function formatTrackingInterval(sec) {
  if (sec < 60) return sec + 's';
  return Math.round(sec / 60) + ' min';
}
// Strips orphaned tracking settings when an account is removed.
function forgetTrackingAccount(id) {
  let changed = false;
  const regions = Object.assign({}, settings.trackingRegions || {});
  if (id in regions) { delete regions[id]; settings.trackingRegions = regions; changed = true; }
  const timedIds = getTrackingTimedIds();
  if (timedIds.has(id)) { timedIds.delete(id); settings.trackingTimedIds = [...timedIds]; changed = true; }
  if (changed) api.saveSettings({ trackingRegions: settings.trackingRegions, trackingTimedIds: settings.trackingTimedIds });
}

function renderTrackingPage() {
  const urlInput = document.getElementById('tracking-webhook-url');
  if (urlInput) urlInput.value = getTrackingWebhookUrl();
  const interval = document.getElementById('tracking-interval');
  const intervalSec = getTrackingIntervalSec();
  if (interval) interval.value = intervalSec;
  const intervalVal = document.getElementById('tracking-interval-val');
  if (intervalVal) intervalVal.textContent = formatTrackingInterval(intervalSec);

  const container = document.getElementById('tracking-accounts');
  if (!container) return;
  const timedIds = getTrackingTimedIds();
  if (!accounts.length) {
    container.innerHTML = '<div class="tracking-empty">No accounts yet. Add an account first.</div>';
    return;
  }
  container.innerHTML = accounts.map(a => {
    const regions = getTrackingRegions(a.id);
    const metaText = regions.length ? (regions.length + ' spot' + (regions.length !== 1 ? 's' : '')) : 'Full window';
    return `
    <div class="tracking-account">
      <span class="pm-av" id="tracking-av-${a.id}">${esc((a.username || '?')[0].toUpperCase())}</span>
      <div class="tracking-account-info">
        <div class="tracking-account-name">${esc(a.nickname || a.username || 'Unknown')}</div>
        <div class="tracking-account-meta">${metaText}</div>
      </div>
      <div class="tracking-account-actions">
        <label class="toggle sm" title="Include in timed capture"><input type="checkbox" data-track-timed="${a.id}" onchange="toggleTimedTrackingAccount('${a.id}')" ${timedIds.has(a.id) ? 'checked' : ''}/><span class="toggle-trk"></span></label>
        <button class="btn btn-ghost" onclick="openRegionPicker('${a.id}')"><span class="material-icons-round" style="font-size:15px">crop</span></button>
        <button class="btn btn-ghost" data-track-capture="${a.id}" onclick="captureTrackingNow('${a.id}')" ${_launchedIds.has(a.id) ? '' : 'disabled'}><span class="material-icons-round" style="font-size:15px">photo_camera</span></button>
      </div>
    </div>`;
  }).join('');
  loadAvatarsBatch(accounts);
}

function trackingIntervalInput(v) {
  document.getElementById('tracking-interval-val').textContent = formatTrackingInterval(Number(v));
  updateSliderFill(document.getElementById('tracking-interval'));
}
function saveTrackingInterval() {
  const sec = Math.min(3600, Math.max(30, parseInt(document.getElementById('tracking-interval').value, 10) || 300));
  settings.trackingIntervalSec = sec;
  api.saveSettings({ trackingIntervalSec: sec });
  startTrackingLoop();
  toast('Tracking interval: ' + formatTrackingInterval(sec), 'ok');
}

async function saveTrackingWebhookUrl() {
  const input = document.getElementById('tracking-webhook-url');
  if (!input) return;
  const url = input.value.trim();
  // Clearing the field just turns tracking off; only a non-empty value has to
  // be a real Discord webhook (the backend enforces this too).
  if (url) {
    let check;
    try { check = await api.trackingValidateWebhook(url); } catch { check = null; }
    if (check && !check.ok) { toast(check.error || 'That webhook URL is not valid', 'err'); return; }
  }
  settings.trackingWebhookUrl = url;
  api.saveSettings({ trackingWebhookUrl: url });
  startTrackingLoop();
  toast(url ? 'Webhook saved' : 'Webhook cleared', 'ok');
}

function toggleTimedTrackingAccount(id) {
  const enabled = getTrackingTimedIds();
  const toggle = document.querySelector(`[data-track-timed="${id}"]`);
  if (toggle && toggle.checked) enabled.add(id); else enabled.delete(id);
  settings.trackingTimedIds = [...enabled];
  api.saveSettings({ trackingTimedIds: settings.trackingTimedIds });
  startTrackingLoop();
}

let _trackingTimer = null;
let _trackingRunning = false;
function startTrackingLoop() {
  if (_trackingTimer) clearInterval(_trackingTimer);
  _trackingTimer = null;
  if (!getTrackingTimedIds().size || !getTrackingWebhookUrl()) return;
  _trackingTimer = setInterval(captureTimedTracking, getTrackingIntervalSec() * 1000);
}

async function captureTimedTracking() {
  if (_trackingRunning) return;
  const webhookUrl = getTrackingWebhookUrl();
  if (!webhookUrl) return;
  _trackingRunning = true;
  try {
    for (const id of getTrackingTimedIds()) {
      if (!_launchedIds.has(id)) continue;
      const a = accounts.find(x => x.id === id);
      if (!a) continue;
      try { await api.trackingCaptureAndSend(id, a.nickname || a.username || id, webhookUrl, getTrackingRegions(id)); } catch {}
    }
  } finally {
    _trackingRunning = false;
  }
}

async function captureTrackingNow(id) {
  const webhookUrl = getTrackingWebhookUrl();
  if (!webhookUrl) { toast('Set a webhook URL first', 'err'); return; }
  const a = accounts.find(x => x.id === id);
  if (!a) return;
  const button = document.querySelector(`[data-track-capture="${id}"]`);
  if (button) button.disabled = true;
  try {
    const res = await api.trackingCaptureAndSend(id, a.nickname || a.username || id, webhookUrl, getTrackingRegions(id));
    if (res && res.ok) toast('Sent to webhook', 'ok');
    else toast((res && res.error) || 'Capture failed', 'err');
  } catch (e) {
    toast((e && e.message) || 'Capture failed', 'err');
  } finally {
    if (button) button.disabled = false;
  }
}

// ── Region picker: drag rectangles to outline capture spots, saved as 0-1 fractions of the window.
let _regionPickerAccountId = null;
let _regionPickerDrag = null;
let _regionPickerRects = [];

async function openRegionPicker(id) {
  const a = accounts.find(x => x.id === id);
  if (!a) return;
  if (!_launchedIds.has(id)) { toast('Launch this account first to outline a spot', 'err'); return; }
  _regionPickerAccountId = id;
  _regionPickerRects = getTrackingRegions(id).slice();
  openModal('m-region-picker');
  const img = document.getElementById('region-picker-img');
  img.removeAttribute('src');
  renderRegionBoxes();
  let res;
  try { res = await api.trackingCapturePreview(id); } catch { res = null; }
  if (!res || !res.ok) {
    toast((res && res.error) || 'Could not capture a preview', 'err');
    closeRegionPicker();
    return;
  }
  img.onload = renderRegionBoxes;
  img.src = res.dataUrl;
}

function closeRegionPicker() {
  closeModal('m-region-picker');
  _regionPickerAccountId = null;
  _regionPickerDrag = null;
}

function resetRegionPicker() {
  _regionPickerRects = [];
  renderRegionBoxes();
}

function renderRegionBoxes() {
  const img = document.getElementById('region-picker-img');
  const wrap = document.getElementById('region-picker-wrap');
  wrap.querySelectorAll('.region-picker-box').forEach(el => el.remove());
  if (!img.clientWidth || !img.clientHeight) return;
  _regionPickerRects.forEach((rect, i) => {
    const box = document.createElement('div');
    box.className = 'region-picker-box';
    box.dataset.idx = i;
    box.title = 'Click to remove';
    box.style.left = (rect.x * img.clientWidth) + 'px';
    box.style.top = (rect.y * img.clientHeight) + 'px';
    box.style.width = (rect.w * img.clientWidth) + 'px';
    box.style.height = (rect.h * img.clientHeight) + 'px';
    box.style.pointerEvents = 'auto';
    box.onclick = e => {
      e.stopPropagation();
      _regionPickerRects.splice(i, 1);
      renderRegionBoxes();
    };
    wrap.appendChild(box);
  });
}

function saveRegionPicker() {
  if (!_regionPickerAccountId) return;
  const regions = Object.assign({}, settings.trackingRegions || {});
  if (_regionPickerRects.length) regions[_regionPickerAccountId] = _regionPickerRects;
  else delete regions[_regionPickerAccountId];
  settings.trackingRegions = regions;
  api.saveSettings({ trackingRegions: regions });
  closeRegionPicker();
  renderTrackingPage();
  toast('Capture spots saved', 'ok');
}

(function initRegionPickerDrag() {
  const wrap = document.getElementById('region-picker-wrap');
  if (!wrap) return;
  let draftBox = null;
  wrap.addEventListener('mousedown', e => {
    if (e.target.classList.contains('region-picker-box')) return; // handled by its own onclick
    const img = document.getElementById('region-picker-img');
    if (!img.clientWidth) return;
    const rect = img.getBoundingClientRect();
    const startX = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    const startY = Math.min(Math.max(e.clientY - rect.top, 0), rect.height);
    _regionPickerDrag = { startX, startY, imgRect: rect };
    draftBox = document.createElement('div');
    draftBox.className = 'region-picker-box region-picker-box-draft';
    draftBox.style.left = startX + 'px';
    draftBox.style.top = startY + 'px';
    draftBox.style.width = '0px';
    draftBox.style.height = '0px';
    wrap.appendChild(draftBox);
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!_regionPickerDrag || !draftBox) return;
    const { startX, startY, imgRect } = _regionPickerDrag;
    const x = Math.min(Math.max(e.clientX - imgRect.left, 0), imgRect.width);
    const y = Math.min(Math.max(e.clientY - imgRect.top, 0), imgRect.height);
    draftBox.style.left = Math.min(x, startX) + 'px';
    draftBox.style.top = Math.min(y, startY) + 'px';
    draftBox.style.width = Math.abs(x - startX) + 'px';
    draftBox.style.height = Math.abs(y - startY) + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!_regionPickerDrag) return;
    const img = document.getElementById('region-picker-img');
    const left = draftBox ? parseFloat(draftBox.style.left) : 0;
    const top = draftBox ? parseFloat(draftBox.style.top) : 0;
    const w = draftBox ? parseFloat(draftBox.style.width) : 0;
    const h = draftBox ? parseFloat(draftBox.style.height) : 0;
    if (draftBox) { draftBox.remove(); draftBox = null; }
    _regionPickerDrag = null;
    if (w < 8 || h < 8 || !img.clientWidth || !img.clientHeight) return;
    _regionPickerRects.push({
      x: left / img.clientWidth,
      y: top / img.clientHeight,
      w: w / img.clientWidth,
      h: h / img.clientHeight,
    });
    renderRegionBoxes();
  });
})();
