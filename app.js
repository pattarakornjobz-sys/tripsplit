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
    el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#16201C;color:#fff;padding:11px 18px;border-radius:999px;font-size:13.5px;z-index:999;box-shadow:0 10px 30px rgba(0,0,0,.25);max-width:88%;text-align:center;opacity:0;transition:opacity .2s';
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
    { id: 'profile', href: '#', label: 'บัญชี', icon: '⚙️' },
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
