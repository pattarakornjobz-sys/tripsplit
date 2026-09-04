/* ===== Trip Split — shared app logic ===== */

const SUPABASE_URL = 'https://uhefxwccuqagnbrbidbh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVoZWZ4d2NjdXFhZ25icmJpZGJoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwMDI1NDYsImV4cCI6MjEwMTU3ODU0Nn0.EE5QWPVjSkZpUTU37hgiz4LsGMAfq87dxFOkt9OYynY';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const CATS = [
  { id: 'food', name: 'อาหาร' },
  { id: 'stay', name: 'ที่พัก' },
  { id: 'transport', name: 'เดินทาง' },
  { id: 'ticket', name: 'ตั๋ว/เข้าชม' },
  { id: 'shopping', name: 'ช้อปปิ้ง' },
  { id: 'other', name: 'อื่นๆ' },
];

function money(n, cur) {
  cur = cur || 'THB';
  const sym = cur === 'THB' ? '฿' : cur + ' ';
  const v = Number(n || 0);
  return sym + v.toLocaleString('th-TH', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

function initials(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

function avatarColor(seed) {
  const colors = ['#1F6F5C', '#B4622E', '#5B5FEF', '#C0392B', '#8E7CC3', '#2E86AB', '#7A8B3F'];
  let h = 0;
  for (const c of String(seed || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return colors[h % colors.length];
}

function fmtDateRange(start, end) {
  const M = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const f = (d) => { const dt = new Date(d); return isNaN(dt) ? '' : dt.getDate() + ' ' + M[dt.getMonth()]; };
  if (!start && !end) return 'ไม่ระบุวันที่';
  return f(start) + ' – ' + f(end);
}

function genCode(len) {
  len = len || 6;
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:var(--toast-bg,#16201C);color:var(--toast-fg,#fff);padding:11px 18px;border-radius:999px;font-size:13.5px;z-index:999;box-shadow:0 10px 30px rgba(0,0,0,.25);max-width:88%;text-align:center;opacity:0;transition:opacity .2s';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 2200);
}

/* ---------- Auth ---------- */

async function requireAuth() {
  // Surface a real OAuth error instead of silently bouncing back to login.
  const url = new URL(location.href);
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
  const errDesc = hashParams.get('error_description') || url.searchParams.get('error_description')
    || hashParams.get('error') || url.searchParams.get('error');
  if (errDesc) {
    console.error('OAuth error:', errDesc);
    alert('ล็อกอินไม่สำเร็จ: ' + decodeURIComponent(errDesc));
  }

  let { data: { session } } = await sb.auth.getSession();

  // Right after the Google redirect, supabase-js may still be parsing the
  // URL / exchanging the code for a session. Give it a short grace window
  // via onAuthStateChange instead of bouncing to the login page immediately.
  if (!session && (url.searchParams.get('code') || hashParams.get('access_token'))) {
    session = await new Promise((resolve) => {
      const { data: sub } = sb.auth.onAuthStateChange((_event, s) => {
        if (s) { sub.subscription.unsubscribe(); resolve(s); }
      });
      setTimeout(() => { sub.subscription.unsubscribe(); resolve(null); }, 3000);
    });
  }

  if (!session) {
    const pending = qs('code');
    if (pending) localStorage.setItem('ts_pending_code', pending);
    location.href = 'index.html';
    return null;
  }
  // Clean the auth tokens/code out of the visible URL now that we have a session.
  if (url.hash || url.searchParams.get('code')) {
    history.replaceState(null, '', location.pathname);
  }
  await ensureProfile(session.user);
  return session.user;
}

async function ensureProfile(user) {
  const meta = user.user_metadata || {};
  await sb.from('profiles').upsert({
    id: user.id,
    email: user.email,
    display_name: meta.full_name || meta.name || (user.email ? user.email.split('@')[0] : 'ผู้ใช้'),
    avatar_url: meta.avatar_url || meta.picture || null,
  }, { onConflict: 'id' });
}

async function signInWithGoogle() {
  const redirectTo = location.origin + '/trips.html';
  await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
}

async function signOut() {
  await sb.auth.signOut();
  location.href = 'index.html';
}

/* ---------- Debt simplification ---------- */
// balances: { userId: netAmount }  positive = should receive, negative = owes
function computeSettlements(balances) {
  const creditors = [];
  const debtors = [];
  Object.entries(balances).forEach(([id, amt]) => {
    if (amt > 0.01) creditors.push({ id, amt });
    else if (amt < -0.01) debtors.push({ id, amt: -amt });
  });
  creditors.sort((a, b) => b.amt - a.amt);
  debtors.sort((a, b) => b.amt - a.amt);
  const transfers = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amt, creditors[j].amt);
    if (pay > 0.01) {
      transfers.push({ from: debtors[i].id, to: creditors[j].id, amount: Math.round(pay * 100) / 100 });
    }
    debtors[i].amt -= pay;
    creditors[j].amt -= pay;
    if (debtors[i].amt < 0.01) i++;
    if (creditors[j].amt < 0.01) j++;
  }
  return transfers;
}

/* ---------- Bottom tab bar ---------- */
function renderTabBar(active) {
  const el = document.getElementById('tabbar');
  if (!el) return;
  const tabs = [
    { id: 'trips', href: 'trips.html', label: 'ทริป', icon: '🧳' },
    { id: 'history', href: 'history.html', label: 'ประวัติ', icon: '🗂️' },
    { id: 'profile', href: 'account.html', label: 'บัญชี', icon: '☺' },
  ];
  el.innerHTML = tabs.map(t => `
    <div class="tab ${t.id === active ? 'tab-active' : ''}" data-href="${t.href}">
      <div class="tab-icon">${t.icon}</div>
      <div class="tab-label">${t.label}</div>
    </div>`).join('');
  el.querySelectorAll('.tab').forEach(node => {
    node.addEventListener('click', () => {
      if (node.dataset.href === '#') { signOutConfirm(); return; }
      location.href = node.dataset.href;
    });
  });
}

function signOutConfirm() {
  if (confirm('ออกจากระบบ?')) signOut();
}

/* ---------- PWA install ---------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

let __deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  __deferredInstallPrompt = e;
});

function isStandaloneApp() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIOSDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
}

// Call this once, right after a successful login, on a page that has an
// empty <div id="installPromptRoot"></div> somewhere in its markup.
function maybeShowInstallPrompt() {
  if (isStandaloneApp()) return;
  if (localStorage.getItem('ts_install_dismissed') === '1') return;
  const root = document.getElementById('installPromptRoot');
  if (!root) return;

  if (isIOSDevice()) {
    renderInstallCard(root, {
      body: 'แตะปุ่ม แชร์ (สี่เหลี่ยมมีลูกศรชี้ขึ้น) ที่แถบด้านล่างของ Safari แล้วเลือก “เพิ่มไปที่หน้าจอโฮม”',
      showButton: false,
    });
    return;
  }

  if (__deferredInstallPrompt) {
    showAndroidInstallCard(root);
  } else {
    // beforeinstallprompt may not have fired yet — give it a moment.
    const handler = () => { showAndroidInstallCard(root); };
    window.addEventListener('beforeinstallprompt', handler, { once: true });
    setTimeout(() => window.removeEventListener('beforeinstallprompt', handler), 5000);
  }
}

function showAndroidInstallCard(root) {
  renderInstallCard(root, {
    body: 'ติดตั้งไว้ที่หน้าจอโฮม เปิดใช้งานได้เร็วเหมือนแอพจริง',
    showButton: true,
    onInstall: async () => {
      if (!__deferredInstallPrompt) return;
      __deferredInstallPrompt.prompt();
      await __deferredInstallPrompt.userChoice;
      __deferredInstallPrompt = null;
      root.innerHTML = '';
    },
  });
}

function renderInstallCard(root, opts) {
  root.innerHTML = `
    <div style="position:fixed;left:0;right:0;bottom:0;z-index:200;padding:0 14px calc(env(safe-area-inset-bottom,0) + 14px);">
      <div style="max-width:432px;margin:0 auto;background:#16201C;color:#fff;border-radius:16px;padding:14px 14px 14px 12px;display:flex;align-items:center;gap:12px;box-shadow:0 12px 34px rgba(0,0,0,.3);">
        <img src="icons/icon-192.png" style="width:44px;height:44px;border-radius:12px;flex-shrink:0;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13.5px;font-weight:600;">ติดตั้ง TripSplit</div>
          <div style="margin-top:2px;font-size:11.5px;line-height:1.5;color:rgba(255,255,255,.68);">${opts.body}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;">
          ${opts.showButton ? '<button id="tsInstallBtn" style="height:32px;padding:0 14px;border:none;border-radius:9px;background:#1F6F5C;color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;">ติดตั้ง</button>' : ''}
          <div id="tsInstallDismiss" style="text-align:center;font-size:11px;color:rgba(255,255,255,.5);cursor:pointer;">ไม่ใช่ตอนนี้</div>
        </div>
      </div>
    </div>`;
  const dismiss = document.getElementById('tsInstallDismiss');
  if (dismiss) dismiss.addEventListener('click', () => {
    localStorage.setItem('ts_install_dismissed', '1');
    root.innerHTML = '';
  });
  const btn = document.getElementById('tsInstallBtn');
  if (btn && opts.onInstall) btn.addEventListener('click', opts.onInstall);
}

/* ---------- Theme (light / dark / auto) ---------- */
// Call initTheme() in <head>, right after app.js, so the first paint is correct.
function initTheme() {
  applyTheme(localStorage.getItem('ts_theme') || 'auto');
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if ((localStorage.getItem('ts_theme') || 'auto') === 'auto') applyTheme('auto'); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
}

function currentThemeMode() {
  return localStorage.getItem('ts_theme') || 'auto';
}

function applyTheme(mode) {
  const dark = mode === 'dark' || (mode === 'auto' && window.matchMedia
    && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  localStorage.setItem('ts_theme', mode);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0F1512' : '#EFEDE8');
}

// Renders the light / dark / auto segmented control into #themeSeg.
function renderThemeSeg() {
  const seg = document.getElementById('themeSeg');
  if (!seg) return;
  const sync = () => {
    const mode = currentThemeMode();
    seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  };
  seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    applyTheme(b.dataset.mode);
    sync();
  }));
  sync();
}

/* ---------- Masking + clipboard ---------- */
// maskDigits('123-4-56789-0', 4) -> '•••-•-•••89-0'  (separators kept)
function maskDigits(value, keep) {
  keep = keep || 4;
  const chars = String(value || '').split('');
  const total = chars.filter(c => /[0-9]/.test(c)).length;
  let seen = 0;
  return chars.map(c => {
    if (!/[0-9]/.test(c)) return c;
    seen++;
    return seen > total - keep ? c : '•';
  }).join('');
}

async function copyText(value, label) {
  const v = String(value || '').trim();
  if (!v) { toast('ยังไม่ได้ใส่' + (label || 'ข้อมูล') + ' — กด “แก้ไข” เพื่อเพิ่ม'); return; }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(v);
    } else {
      const ta = document.createElement('textarea');
      ta.value = v; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    toast('คัดลอก' + (label || '') + 'แล้ว · ' + v);
  } catch (e) {
    toast('คัดลอกไม่สำเร็จ — กดค้างที่ตัวเลขเพื่อคัดลอกเอง');
  }
}

/* ---------- Payment methods ---------- */
const PAY_METHODS = {
  promptpay: { label: 'พร้อมเพย์', icon: '฿' },
  bank: { label: 'โอนเข้าบัญชี', icon: 'B' },
  qr: { label: 'สแกน QR', icon: 'Q' },
};

const BANK_NAMES = {
  scb: 'ไทยพาณิชย์', kbank: 'กสิกรไทย', ktb: 'กรุงไทย', bbl: 'กรุงเทพ',
  bay: 'กรุงศรี', ttb: 'ทีทีบี', gsb: 'ออมสิน', other: 'ธนาคาร',
};

// Which method the person actually ticked, falling back to whatever they filled in.
function payMethodOf(p) {
  p = p || {};
  if (p.pay_method === 'qr' && p.qr_url) return 'qr';
  if (p.pay_method === 'bank' && p.bank_account) return 'bank';
  if (p.pay_method === 'promptpay' && p.phone) return 'promptpay';
  if (p.qr_url) return 'qr';
  if (p.bank_account) return 'bank';
  if (p.phone) return 'promptpay';
  return null;
}

function payMethodSummary(p) {
  const m = payMethodOf(p);
  if (!m) return 'ยังไม่ได้ตั้งช่องทางรับเงิน';
  if (m === 'qr') return 'สะดวกรับผ่าน QR';
  if (m === 'bank') return 'สะดวกรับเข้าบัญชี ' + (BANK_NAMES[p.bank_code] || 'ธนาคาร');
  return 'สะดวกรับผ่านพร้อมเพย์';
}

// Bottom sheet: how this person prefers to be paid. amount/currency optional.
function openPayeeSheet(p, amount, currency) {
  p = p || {};
  const name = p.nickname || p.display_name || 'เพื่อนร่วมทริป';
  const pref = payMethodOf(p);
  const rows = [];

  if (p.phone) rows.push({
    key: 'promptpay', label: 'พร้อมเพย์ · เบอร์โทร', value: p.phone, copyLabel: 'เบอร์',
  });
  if (p.bank_account) rows.push({
    key: 'bank', label: (BANK_NAMES[p.bank_code] || 'ธนาคาร') + ' · เลขที่บัญชี', value: p.bank_account,
    copyLabel: 'เลขบัญชี', extra: p.account_holder ? 'ชื่อบัญชี ' + p.account_holder : '',
  });

  const order = rows.slice().sort((a, b) => (a.key === pref ? -1 : b.key === pref ? 1 : 0));

  const rowHtml = order.map(r => `
    <div class="row" style="padding-left:0;padding-right:0;">
      <div class="row-body">
        <div class="row-label">${r.label}${r.key === pref ? ' <span class="tag-pref">สะดวกสุด</span>' : ''}</div>
        <div class="row-value" data-full="${r.value}">${maskDigits(r.value, 4)}</div>
        ${r.extra ? '<div style="margin-top:3px;font-size:11.5px;color:var(--faint);">' + r.extra + '</div>' : ''}
      </div>
      <button class="icon-btn" data-reveal>⌢</button>
      <button class="copy-btn" data-copy="${r.value}" data-copylabel="${r.copyLabel}">คัดลอก</button>
    </div>`).join('');

  const qrHtml = p.qr_url ? `
    <div style="margin-top:14px;">
      <div class="row-label" style="margin-bottom:7px;">QR รับเงิน${pref === 'qr' ? ' <span class="tag-pref">สะดวกสุด</span>' : ''}</div>
      <img src="${p.qr_url}" alt="QR รับเงินของ ${name}" class="pay-sheet-qr">
      <a href="${p.qr_url}" target="_blank" rel="noopener" style="display:block;margin-top:8px;text-align:center;font-size:12.5px;font-weight:600;">เปิดรูปเต็ม / บันทึกรูป</a>
    </div>` : '';

  const body = (rows.length || p.qr_url)
    ? rowHtml + qrHtml
    : '<div class="empty">' + escapeHtmlSafe(name) + ' ยังไม่ได้ใส่ช่องทางรับเงิน<br>ทักไปบอกให้เปิดหน้า “บัญชี” แล้วกรอกก่อนนะ</div>';

  const sheet = document.createElement('div');
  sheet.className = 'modal-bg';
  sheet.innerHTML = `
    <div class="modal-sheet">
      <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:4px;">
        <div style="flex:1;min-width:0;">
          <h3 style="margin:0;">โอนให้ ${escapeHtmlSafe(name)}</h3>
          <div style="margin-top:3px;font-size:12px;color:var(--faint);">${payMethodSummary(p)}</div>
        </div>
        ${amount != null ? '<div style="font-size:20px;font-weight:600;color:var(--ink);white-space:nowrap;">' + money(amount, currency) + '</div>' : ''}
      </div>
      <div style="margin-top:10px;">${body}</div>
      <button class="btn btn-outline" data-close style="margin-top:16px;border-radius:25px;">ปิด</button>
    </div>`;

  sheet.addEventListener('click', (e) => {
    if (e.target === sheet || e.target.hasAttribute('data-close')) { sheet.remove(); return; }
    const rev = e.target.closest('[data-reveal]');
    if (rev) {
      const val = rev.parentElement.querySelector('.row-value');
      const full = val.dataset.full;
      const hidden = val.textContent.indexOf('\u2022') >= 0;
      val.textContent = hidden ? full : maskDigits(full, 4);
      rev.textContent = hidden ? '⌣' : '⌢';
      return;
    }
    const cp = e.target.closest('[data-copy]');
    if (cp) copyText(cp.dataset.copy, cp.dataset.copylabel);
  });
  document.body.appendChild(sheet);
}

function escapeHtmlSafe(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

/* ---------- QR image: center-crop to 1:1 and upload ---------- */
async function squareCropBlob(file, size) {
  size = size || 720;
  const bitmap = await new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
  URL.revokeObjectURL(bitmap.src);
  return await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.9));
}

async function uploadQrImage(userId, file) {
  const blob = await squareCropBlob(file, 720);
  const path = userId + '.jpg';
  const { error } = await sb.storage.from('qr').upload(path, blob, {
    upsert: true, contentType: 'image/jpeg', cacheControl: '3600',
  });
  if (error) throw error;
  const { data } = sb.storage.from('qr').getPublicUrl(path);
  return data.publicUrl + '?v=' + Date.now();
}

async function removeQrImage(userId) {
  await sb.storage.from('qr').remove([userId + '.jpg']);
}
