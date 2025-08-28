// === ตั้งค่า URL ของ Web App (Apps Script) ===
const PRODUCTS_URL = "https://script.google.com/macros/s/AKfycbysfEp0VkUnNIjPWSlkJU-YpIA6lnl8XK6pXl3TE2lFsy2-qqsJwuaItIpX9JYn6BT5wg/exec";
const SALES_URL = PRODUCTS_URL;

// ใส่ URL/พาธของรูป QR คุณ (ตัวอย่างชื่อไฟล์ที่คุณส่งมา)
const QR_IMAGE_URL = 'kplusshop_qr.jpg';  // หรือใส่ลิงก์เต็มถ้าอยู่บน CDN

// ปิดดาวน์โหลดใบเสร็จอัตโนมัติเมื่อปิดบิล
const AUTO_DOWNLOAD_RECEIPT = false;

// ====== ดีบาวน์คำนวณเงินทอน ======
let cashTimer = null;

// ====== ป้องกัน Enter รัว และทำ Fast Close ======
let submitting = false;          // ล็อกการส่งบิล
let enterGuardTimer = null;      // กันกดซ้ำช่วงสั้น ๆ
const ENTER_GUARD_MS = 1500;     // กันซ้ำ 1.5 วินาที

// ====== ตัวแปรหลัก ======
const productMap = new Map();
const cart = [];
window.cart = cart;
// ====== อ้างอิง DOM ======
const el = (id) => document.getElementById(id);
const scanInput  = el('scan-input');
const cartBody   = el('cart-body');
const subtotalEl = el('subtotal');
const cashEl     = el('cash');
const changeEl   = el('change');


// คลิกแถว = ลบ, คลิกปุ่มดินสอ = แก้ไข
if (cartBody) {
  // คลิกเดี่ยว: ปุ่มดินสอ = เปิดแก้ไข (คงพฤติกรรมเดิม)
  cartBody.addEventListener('click', (e) => {
    const editBtn = e.target.closest('.edit-btn');
    if (!editBtn) return;
    const idx = Number(editBtn.dataset.idx);
    if (!Number.isNaN(idx)) openEditModal(idx);
  });

  // ดับเบิลคลิกที่แถว: ลบรายการ
  cartBody.addEventListener('dblclick', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;

    // ถ้าดับเบิลคลิกตรงปุ่ม/ส่วนควบคุมจำนวน ให้ไม่ลบ
    if (e.target.closest('.qty') || e.target.closest('button') || e.target.closest('.edit-btn')) return;

    const rowIndex = [...cartBody.children].indexOf(tr);
    if (rowIndex > -1) removeLine(rowIndex);
  });
}



function focusCash(fillIfNeeded = false) {
  const cash = document.getElementById('cash');
  if (!cash) return;
  cash.focus();
  cash.select?.();

  if (fillIfNeeded) {
    const sub = getSubtotal?.() ?? 0;
    const cur = Number(cash.value || 0);
    // ถ้ายังว่างหรือใส่น้อยกว่า -> ใส่ยอดรวมให้เลย
    if (!cur || cur < sub) {
      cash.value = String(sub);
      calcChange?.();
    }
  }
}


function openEditModal(idx){
  const line = cart[idx];
  if (!line) return;

  const overlay = document.createElement('div');
  overlay.id = 'np-overlay';  // ใช้สไตล์ overlay ใบเสร็จเดิม (เราทำเป็นโทนสว่างแล้ว)
  overlay.style.display = 'flex';

  const modal = document.createElement('div');
  modal.innerHTML = `
    <h2>แก้ไขรายการ</h2>
    <div style="margin-bottom:8px;color:#475569">รหัส: <b>${line.code ?? '-'}</b></div>
    <label style="display:block;margin-bottom:8px;">
      <span>ชื่อสินค้า</span>
      <input id="ed-name" type="text" value="${line.name ?? ''}">
    </label>
    <label style="display:block;margin-bottom:8px;">
      <span>ราคา (บาท)</span>
      <input id="ed-price" type="number" min="0" step="1" value="${Number(line.price)||0}">
    </label>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;">
      <button id="ed-cancel">ยกเลิก</button>
      <button class="btn-save" id="ed-save">บันทึก</button>
    </div>
  `;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const close = ()=> overlay.remove();
  modal.querySelector('#ed-cancel')?.addEventListener('click', close);

  modal.querySelector('#ed-save')?.addEventListener('click', () => {
  const name  = String(modal.querySelector('#ed-name').value || '').trim();
  const price = Math.max(0, Number(modal.querySelector('#ed-price').value || 0));

  // อัปเดตในตะกร้าทันที (ลื่นไหล)
  cart[idx].name  = name || cart[idx].name;
  cart[idx].price = price;
  renderCart();

  // ปิด modal **ทันที** (ไม่ await network)
  close();

  // ยิงบันทึกขึ้นชีตแบบ background
  if (line.code) {
    updateProductOnSheet(line.code, name, price)
      .then(ok => {
        if (ok) toast('บันทึกขึ้นชีตแล้ว');
        else    toast('บันทึกขึ้นชีตไม่สำเร็จ (แก้ในตะกร้าแล้ว)');
      })
      .catch(() => toast('บันทึกขึ้นชีตไม่สำเร็จ (แก้ในตะกร้าแล้ว)'));
  } else {
    toast('อัปเดตรายการในบิลแล้ว'); // สินค้าที่ไม่มี code
  }
});

}

// อัปเดตสินค้าบน Google Sheet ผ่าน Apps Script
async function updateProductOnSheet(code, name, price){
  const payload = {
    action: 'updateProduct',
    code: String(code),
    name: String(name || ''),
    price: Number(price) || 0
  };
  const body = JSON.stringify(payload);

  try {
    // simple request: ไม่มี preflight
    const res = await fetch(PRODUCTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body
    });

    // ถ้า Apps Script ตอบ JSON ปกติ จะอ่านได้เลย
    if (res.ok) {
      // บางกรณี Apps Script ตอบเป็น text → ลอง parse อย่างยืดหยุ่น
      const txt = await res.text();
      try {
        const json = JSON.parse(txt);
        return json?.ok !== false; // ok:true หรือไม่มี ok ก็ถือว่าสำเร็จ
      } catch {
        // ไม่ใช่ JSON ก็ถือว่าเรียกถึงปลายทางแล้ว
        return true;
      }
    }
  } catch (e) {
    console.error('updateProductOnSheet error (simple request)', e);
  }

  // fallback สุดท้าย: ยิงแบบ no-cors (จะไม่รู้ผล แต่ส่งถึงปลายทาง)
  try {
    await fetch(PRODUCTS_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body
    });
    return true;
  } catch (e) {
    console.error('updateProductOnSheet error (no-cors fallback)', e);
    return false;
  }
}





   
// === Live Thai clock ===
// === Live Thai clock (time only) ===
function startLiveClock() {
  const el = document.getElementById('clock');
  if (!el) return;

  const fmt = new Intl.DateTimeFormat('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const tick = () => {
    el.textContent = fmt.format(new Date()); // แสดงเฉพาะ HH:MM
  };

  tick();
  setInterval(tick, 1000); // ยังอัปเดตทุกวิ แต่ไม่มีวินาที
}


// ===== QR ใต้ตะกร้า: โชว์เมื่อโฟกัสช่องรับเงิน =====
const qrWrap   = document.getElementById('qr-pay-wrap');
const qrAmtEl  = document.getElementById('qr-amt');
const qrImg    = document.getElementById('qr-img');
const qrCountEl = document.getElementById('qr-count');


const cashInput =
  document.getElementById('cash-input') ||
  document.getElementById('cash') ||
  document.querySelector('input[data-role="cash"], input[name="cash"]');

function getSubtotal() {
  try {
    return Array.isArray(cart)
      ? cart.reduce((s, l) => s + (Number(l.price)||0) * (Number(l.qty)||0), 0)
      : 0;
  } catch { return 0; }
}

function getItemPieces() {
  // รวม qty ของทุกบรรทัดในตะกร้า
  return Array.isArray(cart)
    ? cart.reduce((sum, l) => sum + (Number(l.qty) || 0), 0)
    : 0;
}



function updateQRAmount(amount) {
  if (qrAmtEl)   qrAmtEl.textContent = Number(amount||0).toLocaleString('th-TH');
  if (qrCountEl) qrCountEl.textContent = `(${getItemPieces()} รายการ)`;
}



function showQR() {
  if (!qrWrap) return;
  // ตั้งรูปถ้ายังไม่ได้ตั้ง
  if (qrImg && !qrImg.src) {
    qrImg.src = QR_IMAGE_URL;
    qrImg.loading = 'lazy';
    qrImg.decoding = 'async';
    qrImg.onerror = () => console.warn('โหลดรูป QR ไม่สำเร็จ:', QR_IMAGE_URL);
  }
  updateQRAmount(getSubtotal());
  qrWrap.classList.add('show');
  qrWrap.classList.remove('hidden');
}

function hideQR() {
  if (!qrWrap) return;
  qrWrap.classList.remove('show');
  qrWrap.classList.add('hidden');
}

// ป้องกัน “blur แล้วซ่อน” ถ้าผู้ใช้กำลังกดในโซน QR
let mouseInQR = false;
if (qrWrap) {
  qrWrap.addEventListener('pointerenter', () => { mouseInQR = true; });
  qrWrap.addEventListener('pointerleave', () => { mouseInQR = false; });
}

if (cashInput) {
  cashInput.addEventListener('focus', showQR);
  cashInput.addEventListener('blur', () => {
    // ถ้าย้ายเมาส์ไปแตะ QR ให้ยังแสดงต่อ (ไม่ซ่อนทันที)
    if (!mouseInQR) hideQR();
  });
}

// ให้ QR อัปเดตตามยอดตะกร้าเมื่อ renderCart() (ถ้ามันกำลังโชว์)
const _renderCart_orig = typeof renderCart === 'function' ? renderCart : null;
if (_renderCart_orig) {
  window.renderCart = function() {
    _renderCart_orig();
    if (qrWrap && qrWrap.classList.contains('show')) {
      updateQRAmount(getSubtotal());
    }
  }
}


document.addEventListener('DOMContentLoaded', startLiveClock);


// ===== Global numpad shortcuts (ไม่ให้พิมพ์ . และ + ลง input) =====
(function setupGlobalNumpadShortcuts(){
  const scan = document.getElementById('scan-input');

  function focusScan() {
    if (!scan) return;
    scan.focus();
    // ถ้าอยากให้พร้อมสแกนทับค่าเดิมให้ select ด้วย
    scan.select?.();
  }

  document.addEventListener('keydown', (e) => {
    // กันค้าง
    if (e.repeat) return;

    // Numpad .
   // Numpad .
    if (e.code === 'NumpadDecimal') {
      e.preventDefault();
      focusScan();
      hideQR();           // ✅ บังคับซ่อน กรณี blur ของ cash ไม่ยิง/ติด mouseInQR
      return;
    }


    // Numpad +
  // Numpad +  = โฟกัสช่องรับเงิน (ไม่เพิ่มจำนวนสินค้า)
if (e.code === 'NumpadAdd') {
  e.preventDefault();
  focusCash();
  return;
}

  });
})();

document.addEventListener('focusin', (e) => {
  if (!qrWrap) return;
  // ถ้าโฟกัสไปที่ช่องรับเงิน -> ให้โผล่ตาม logic เดิม ไม่ยุ่ง
  if (e.target === cashInput || e.target === cashEl) return;
  // ถ้าโฟกัสอยู่ในกล่อง QR เอง (แทบไม่มี) -> ข้าม
  if (qrWrap.contains(e.target)) return;

  // โฟกัสที่อื่นทั้งหมด -> ซ่อน
  hideQR();
});






document.addEventListener('DOMContentLoaded', startLiveClock);

// จดจำ "รายการที่เพิ่งเพิ่มล่าสุด"
let lastAddedKey = null;
const makeLineKey = (line) => (line.code ? `code:${line.code}` : `price:${Number(line.price)}`);

function applyLastAddedHighlight(){
  const tbody = document.getElementById('cart-body');
  if (!tbody || !lastAddedKey) return;
  [...tbody.children].forEach(tr => tr.classList.remove('cart-current'));
  const idx = cart.findIndex(l => makeLineKey(l) === lastAddedKey);
  if (idx > -1) {
    const tr = tbody.children[idx];
    if (tr) tr.classList.add('cart-current');
  }
}

// หา index ของสินค้าในตะกร้า (ตาม code/price)
const findCartIndexByCode  = (code)  => cart.findIndex(l => l.code === code);
const findCartIndexByPrice = (price) => cart.findIndex(l => l.code === null && Number(l.price) === Number(price));

// วางไว้ด้านบนของ app.js เลย
function fmt(n) {
  return (Number(n) || 0).toLocaleString('th-TH');
}


function toggleGrandShrink(shouldShrink) {
  const box = document.getElementById('subtotal'); // ย่อเฉพาะตัวเลขยอดรวม
  if (!box) return;
  box.classList.toggle('shrink', !!shouldShrink);
}

// ย้ายบรรทัดในตะกร้าไปอยู่บนสุด (index > 0 เท่านั้น)
function moveLineToFront(idx) {
  if (idx > 0) {
    cart.unshift(cart.splice(idx, 1)[0]);
  }
}


// ====== โหลดสินค้า (แคช) ======
async function preloadProducts() {
  try {
    const res = await fetch(PRODUCTS_URL);
    const data = await res.json();
    if (Array.isArray(data)) {
      data.forEach(item => {
        if (item && item.code) productMap.set(String(item.code).trim(), item);
      });
    }
  } catch (e) {
    console.error('โหลดสินค้าไม่สำเร็จ', e);
  }
}

// ====== พูดภาษาไทย ======
function speakThai(text) {
  try {
    const u = new SpeechSynthesisUtterance(String(text));
    u.lang = 'th-TH';
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch (_) {}
}

// ===== Safe storage + toast (fallback เมื่อ localStorage ใช้ไม่ได้) =====
const _memStore = {};
function safeSet(key, value) {
  try { localStorage.setItem(key, value); return true; }
  catch { _memStore[key] = value; return false; }
}
function safeGet(key) {
  try { return localStorage.getItem(key) ?? _memStore[key] ?? null; }
  catch { return _memStore[key] ?? null; }
}
function safeRemove(key) {
  try { localStorage.removeItem(key); delete _memStore[key]; }
  catch { delete _memStore[key]; }
}
function toast(msg) {
  try { speakThai(msg); } catch {}
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = `
    position:fixed; right:16px; bottom:16px; z-index:10000;
    background:#111827; color:#e5e7eb; border:1px solid #334155;
    border-radius:12px; padding:10px 12px; box-shadow:0 8px 24px rgba(0,0,0,.35)
  `;
  document.body.appendChild(t);
  setTimeout(()=> t.remove(), 1500);
}


// ====== Utilities ======
function format(n) { return Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 }); }

function findCartLineByCode(code, price) {
  return cart.find(line =>
    (code ? line.code === code : false) ||
    (price ? (line.code === null && line.price === price) : false)
  );
}

// ====== เพิ่มรายการจาก "ราคา" ======
function addToCartByPrice(price) {
  const p = Number(price);
  if (!(p >= 1 && p <= 9999)) return;

  let idx = findCartIndexByPrice(p);
  if (idx > -1) {
    cart[idx].qty += 1;
  } else {
    cart.push({ code: null, name: `ราคา ${p} บาท`, price: p, qty: 1 });
    idx = cart.length - 1; // แถวใหม่อยู่ท้าย
  }

  // ⭐ ย้ายขึ้นบนสุดเสมอ
  moveLineToFront(idx);

  // ⭐ จดจำแถวล่าสุด (ตอนนี้อยู่ index 0 แน่นอน)
  lastAddedKey = makeLineKey(cart[0]);
  const qtyNow = Number(cart[0].qty) || 0;
  renderCart();
  speakThai(`${p} บาท`);
  if (typeof animateAddToCartVisual === 'function') animateAddToCartVisual(`฿${p}`);
}



// ====== เพิ่มรายการจาก "รหัสสินค้า" ======
// ====== เพิ่มรายการจาก "รหัสสินค้า" (Fast fallback modal) ======
async function addToCartByCode(code) {
  const key = String(code ?? '').trim();
  if (!key) { toast('กรุณาใส่รหัสสินค้า'); return; }
  // กัน "0" หรือ "000" ถูกส่งมาถึงฟังก์ชันนี้
  if (!key || /^0+$/.test(key)) { return; }

  // มีในแคช → ใส่/บวก แล้วจำแถว
  let item = productMap.get(key);
  if (item && item.code) {
    let idx = findCartIndexByCode(item.code);
    if (idx > -1) {
      cart[idx].qty += 1;
    } else {
      cart.push({ code: item.code, name: item.name, price: Number(item.price)||0, qty: 1 });
      idx = cart.length - 1;
    }

    moveLineToFront(idx);
    lastAddedKey = makeLineKey(cart[0]);

    // lastAddedKey = makeLineKey(cart[idx]);
    const qtyNow = Number(cart[0].qty) || 0;
    renderCart(); speakThai(`${item.price} บาท`);
    if (typeof animateAddToCartVisual === 'function') animateAddToCartVisual(`+1`);
    return;
  }

  // หาในชีต แต่ถ้าช้ากว่า FALLOUT_MS ให้เปิดป๊อปอัป
  const FALLOUT_MS = 150;
  const ctrl = new AbortController();
  let opened = false;
  const openTimer = setTimeout(() => { opened = true; try{ctrl.abort();}catch(_){}
    speakThai('ไม่มี'); 
    openCreateProductModal(key);
  }, FALLOUT_MS);

  try {
    const res = await fetch(`${PRODUCTS_URL}?code=${encodeURIComponent(key)}`, { signal: ctrl.signal });
    if (res.ok) {
      const data = await res.json().catch(()=>null);
      if (data && data.code) {
        clearTimeout(openTimer);
        if (!opened) {
          productMap.set(data.code, data);
          let idx = findCartIndexByCode(data.code);
          if (idx > -1) cart[idx].qty += 1;
          else { cart.push({ code: data.code, name: data.name, price: Number(data.price)||0, qty: 1 }); idx = cart.length - 1; }

          moveLineToFront(idx);
          lastAddedKey = makeLineKey(cart[0]);

          // lastAddedKey = makeLineKey(cart[idx]);
          renderCart(); speakThai(`${data.price} บาท`);
          if (typeof animateAddToCartVisual === 'function') animateAddToCartVisual(`+1`);
          return;
        }
      }
    }
  } catch(_) { /* เงียบไว้ ให้ fallback จัดการ */ }

  // ไม่พบ → เปิดป๊อปอัป (ถ้ายัง)
  if (!opened) { clearTimeout(openTimer); 
    speakThai('ไม่มี');
    openCreateProductModal(key); }
}




// ====== จัดการตะกร้า ======
function removeLine(idx) { 
  cart.splice(idx, 1); renderCart(); 
}


function getLatestLineIndex() {
  if (!Array.isArray(cart) || cart.length === 0) return -1;
  if (typeof lastAddedKey === 'string' && lastAddedKey) {
    const i = cart.findIndex(l => makeLineKey(l) === lastAddedKey);
    if (i >= 0) return i;
  }
  return 0; // fallback: แถวบนสุด (เรา move-to-top อยู่แล้ว)
}

function incLatestLine() {
  const idx = getLatestLineIndex();
  if (idx < 0) return false;

  const cur = Number(cart[idx].qty) || 0;
  const newQty = cur + 1;
  cart[idx].qty = newQty;

  if (typeof moveLineToFront === 'function') moveLineToFront(idx);
  lastAddedKey = makeLineKey(cart[0]);

  renderCart();
  if (typeof animateAddToCartVisual === 'function') animateAddToCartVisual('+1');

  // ✅ พูดจำนวนปัจจุบันหลังเพิ่ม
  speakQty(newQty);
  return true;
}


function decLatestLine() {
  const idx = getLatestLineIndex();
  if (idx < 0) return false;

  const line = cart[idx];
  const curQty = Number(line.qty) || 0;

  // ✅ ถ้าจำนวน = 1 → ไม่ลด (กันลบรายการ)
  if (curQty <= 1) {
    // จะเพิ่มเสียงแจ้งก็ได้ เช่น speakThai('อย่างน้อยหนึ่ง'); หรือ toast('ขั้นต่ำ 1');
    return false;
  }

  const newQty = curQty - 1;
  line.qty = newQty;

  if (typeof moveLineToFront === 'function') moveLineToFront(idx);
  lastAddedKey = makeLineKey(cart[0]);

  renderCart();
  if (typeof animateAddToCartVisual === 'function') animateAddToCartVisual('−1');

  // (ออปชัน) จะพูดจำนวนที่เหลือหลังลดก็ได้
  speakQty(newQty);
  return true;
}




// พูดตัวเลขเป็นภาษาไทย (ใช้ SpeechSynthesis เดิมของโปรเจกต์คุณ)
function speakQty(q) {
  if (typeof speakThai === 'function') {
    const n = Number(q) || 0;
    if (n > 0) speakThai(String(n)); // พูด "1", "2", "3", ...
  }
}






function changeQty(idx, d) {
  cart[idx].qty = Math.max(1, cart[idx].qty + d);

  // พูดจำนวนล่าสุด (ทั้งเพิ่มและลด)
  if (typeof speakThai === "function") {
    speakThai(String(cart[idx].qty));
  }

  renderCart();
}



function calcTotals() {
  const sub = cart.reduce((s, it) => s + (it.price * it.qty), 0);
  return { sub };
}

function renderCart() {
  if (!cartBody) return;
  cartBody.innerHTML = '';
  let totalItems = 0;

  cart.forEach((it, idx) => {
    totalItems += it.qty;

    const tr = document.createElement('tr');
    tr.title = 'ดับเบิลคลิกเพื่อลบ';
tr.innerHTML = `
  <td>${it.code ?? '-'}</td>
  <td>${it.name}</td>
  <td class="num">${format(it.price)}</td>
  <td class="num">
    <div class="qty">
      <button onclick="changeQty(${idx}, -1)">-</button>
      <span>${it.qty}</span>
      <button onclick="changeQty(${idx}, 1)">+</button>
    </div>
  </td>
  <td class="num">${format(it.price * it.qty)}</td>

  <!-- ปุ่มแก้ไข (ไอคอนดินสอ) -->
  <td>
    <button class="icon-btn edit-btn" data-idx="${idx}" title="แก้ไขรายการ">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 
                 7.04a1.003 1.003 0 000-1.42l-2.34-2.34a1.003 1.003 0 00-1.42 
                 0l-1.83 1.83 3.75 3.75 1.84-1.82z" fill="currentColor"/>
      </svg>
    </button>
  </td>
`;
cartBody.appendChild(tr);

  });

  const { sub } = calcTotals();
  if (subtotalEl) subtotalEl.textContent = format(sub);

  // ⭐ เพิ่มบรรทัดนี้: อัปเดตจำนวนสินค้า
  const itemCountEl = document.getElementById('item-count');
  if (itemCountEl) itemCountEl.textContent = `${totalItems} รายการ`;

  updateShrinkUI();
  applyLastAddedHighlight();
}


function clearCart() {
  cart.length = 0; 
  renderCart();

  // ⭐ เคลียร์ช่องรับเงินด้วย
  if (cashEl) {
    cashEl.value = '';   // หรือ '0' ถ้าอยากให้โชว์ศูนย์แทน
  }
  calcChange();          // อัปเดตเงินทอนเป็น 0
}


// ====== พักบิล/ดึงบิล ======
// ====== พักบิล/ดึงบิล (แบบเสถียร มี fallback) ======
// ====== พักบิลหลายใบ + ตะกร้า (ใช้ safeSet/safeGet/safeRemove/toast เดิม) ======
const HELD_LIST_KEY = 'pos_held_bills_v1';

function loadHeldList() {
  const raw = safeGet(HELD_LIST_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function saveHeldList(list) { safeSet(HELD_LIST_KEY, JSON.stringify(list)); }

function thTime(ts) {
  try { return new Date(ts).toLocaleString('th-TH'); }
  catch { return new Date().toLocaleString('th-TH'); }
}
function calcCartSummary(items) {
  const count = items.reduce((n, it)=> n + (Number(it.qty||1)), 0);
  const total = items.reduce((s, it)=> s + Number(it.price||0) * Number(it.qty||1), 0);
  return { count, total };
}
function updateHeldBadge() {
  const el = document.getElementById('held-count-badge');
  if (!el) return;
  const n = loadHeldList().length;
  el.textContent = String(n);
  el.style.display = n > 0 ? 'inline-block' : 'none';
}

// พักบิล (หลายใบ) + เคลียร์ตะกร้าหลังพัก
function holdBillMulti() {
  try {
    if (!Array.isArray(cart) || cart.length === 0) { toast('ยังไม่มีสินค้าในบิล'); return; }
    const now = Date.now();
    const items = cart.map(it => ({
      code: it.code ?? null,
      name: String(it.name ?? ''),
      price: Number(it.price || 0),
      qty: Math.max(1, Number(it.qty || 1)),
    }));
    const { count, total } = calcCartSummary(items);
    const entry = { id: now, datetime: thTime(now), items, summary: { count, total } };

    const list = loadHeldList();
    list.unshift(entry);           // บิลล่าสุดอยู่บนสุด
    saveHeldList(list);
    updateHeldBadge();

    // เคลียร์ทันทีตามที่ต้องการ
    clearCart();
    renderCart?.();
    toast('พักบิล');
  } catch (e) {
    console.error('[holdBillMulti] error:', e);
    toast('พักบิลไม่สำเร็จ');
  }
}

// ป๊อปอัปเลือกบิลที่พักไว้
function openHeldCenter() {
  const list = loadHeldList();

  const backdrop = document.createElement('div');
  backdrop.className = 'held-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'held-modal';
  modal.innerHTML = `
    <header>
      <div>บิลที่พักไว้ (${list.length} บิล)</div>
      <div><button id="held-close" style="padding:6px 10px;border-radius:10px;border:1px solid #334155;background:#1f2937;color:#e5e7eb;cursor:pointer;">ปิด</button></div>
    </header>
    <div class="held-list">
      ${
        list.length === 0
        ? `<div style="padding:16px; color:#9ca3af;">ยังไม่มีบิลที่พักไว้</div>`
        : list.map(r => `
          <div class="held-item" data-id="${r.id}">
            <div>
              <div><strong>เวลา:</strong> ${r.datetime}</div>
              <div><strong>จำนวน:</strong> ${r.summary?.count ?? r.items?.length ?? 0} รายการ</div>
              <div><strong>ยอดรวม:</strong> ${(r.summary?.total ?? 0).toLocaleString('th-TH')} ฿</div>
            </div>
            <div class="held-actions">
              <button class="btn-resume" title="เรียกบิลนี้">เรียกบิล</button>
              <button class="btn-delete" title="ลบบิลนี้">ลบ</button>
            </div>
            <div style="justify-self:end; color:#94a3b8; font-size:12px;">#${r.id}</div>
          </div>
        `).join('')
      }
    </div>
  `;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const close = ()=> backdrop.remove();
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  modal.querySelector('#held-close')?.addEventListener('click', close);

  modal.querySelectorAll('.btn-resume').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = Number(btn.closest('.held-item').dataset.id);
      resumeHeldBill(id);
      close();
    });
  });
  modal.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = Number(btn.closest('.held-item').dataset.id);
      deleteHeldBill(id);
      close();
      openHeldCenter(); // รีเฟรชรายการ
    });
  });
}

// เรียกบิล (และลบออกจากตะกร้าหลังเรียก)
function resumeHeldBill(id) {
  try {
    const list = loadHeldList();
    const idx = list.findIndex(x => x.id === id);
    if (idx === -1) { toast('ไม่พบบิลนี้'); return; }

    const r = list[idx];
    if (!r.items?.length) { toast('บิลนี้ไม่มีรายการ'); return; }

    clearCart();
    r.items.forEach(src => {
      cart.push({
        code: src.code ?? null,
        name: String(src.name ?? ''),
        price: Number(src.price || 0),
        qty: Math.max(1, Number(src.qty || 1)),
      });
    });
    renderCart?.();

    list.splice(idx, 1);             // ถ้าอยาก “ไม่ลบ” ให้คอมเมนต์บรรทัดนี้
    saveHeldList(list);
    updateHeldBadge();

    // toast('เรียกบิลแล้ว');
  } catch (e) {
    console.error('[resumeHeldBill] error:', e);
    toast('เรียกบิลไม่สำเร็จ');
  }
}

function deleteHeldBill(id) {
  try {
    const list = loadHeldList();
    const idx = list.findIndex(x => x.id === id);
    if (idx === -1) return;
    list.splice(idx, 1);
    saveHeldList(list);
    updateHeldBadge();
    toast('ลบบิลแล้ว');
  } catch (e) {
    console.error('[deleteHeldBill] error:', e);
  }
}

// hook ปุ่มตะกร้า + อัปเดตแบดจ์
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('held-bills-button')?.addEventListener('click', openHeldCenter);
  updateHeldBadge();
});

// ให้ฟังก์ชันเดิมยังเรียกได้ (รองรับปุ่มเก่า/คีย์ลัด)
window.holdBill = holdBillMulti;
window.resumeBill = openHeldCenter;



// ====== เงินทอน ======
function calcChange() {
  const { sub } = calcTotals();
  const cash = Number(cashEl?.value || 0);
  const change = cash - sub;
  if (changeEl) changeEl.textContent = format(change >= 0 ? change : 0);
  updateShrinkUI();
}

// ดีบาวน์คำนวณเงินทอน 3 วิหลังหยุดพิมพ์
if (cashEl) {
  cashEl.addEventListener('input', () => {
    if (cashTimer) clearTimeout(cashTimer);
    cashTimer = setTimeout(() => { calcChange(); }, 1000);
  });

  // Enter ที่ "รับเงิน" = ปิดบิล (กันกดรัว)
  cashEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (submitting) { e.preventDefault(); return; }
      if (enterGuardTimer) { e.preventDefault(); return; }
      enterGuardTimer = setTimeout(() => { enterGuardTimer = null; }, ENTER_GUARD_MS);
      e.preventDefault();
      finalizeSale();
    }
  });
}

// ====== อินพุตสแกน/พิมพ์ ======
if (scanInput) {
  scanInput.addEventListener('keydown', (e) => {
    const isNumpad = e.location === KeyboardEvent.DOM_KEY_LOCATION_NUMPAD;

    // กันพิมพ์ "." จาก numpad และใช้เป็นคีย์ลัดไปช่องสแกน (select ทับ)
    if (isNumpad && (e.key === '.' || e.code === 'NumpadDecimal')) {
      e.preventDefault();
      scanInput.select?.();
      return;
    }

    // คีย์ลัด: Numpad "+" = โฟกัสไปช่องรับเงิน (ห้ามพิมพ์ +)
    if (isNumpad && (e.key === '+' || e.code === 'NumpadAdd')) {
      e.preventDefault();
      focusCash();
      return;
    }

    // คีย์ลัด: Numpad "-" = ลดจำนวน (กันกดค้าง)
    const isNumpadMinus =
      (isNumpad && e.key === '-') || e.code === 'NumpadSubtract';

    if ((e.key === 'Enter' || isNumpadMinus) && e.repeat) {
      e.preventDefault();
      return;
    }
    if (isNumpadMinus) {
      e.preventDefault();
      if (Array.isArray(cart) && cart.length > 0) decLatestLine();
      return;
    }

    // เพิ่มจำนวน / เพิ่มรายการ (Enter)
    if (e.key === 'Enter') {
      e.preventDefault();
      const raw = (scanInput.value || '').trim();
      scanInput.value = '';

      if (raw === '' || /^0+$/.test(raw)) {
        if (Array.isArray(cart) && cart.length > 0) incLatestLine();
        return;
      }

      const num = Number(raw);
      if (/^\d{1,4}$/.test(raw) && num >= 1 && num <= 9999) {
        addToCartByPrice(num);
      } else {
        if (!/^0+$/.test(raw)) addToCartByCode(raw);
      }
      return;
    }

    // ช็อตคัตเดิมอื่นๆ
    if (e.key === 'Backspace' && e.ctrlKey) { e.preventDefault(); clearCart(); }
    if (e.key.toLowerCase() === 'p' && e.ctrlKey) { e.preventDefault(); window.print(); }
    if (e.key.toLowerCase() === 'h' && e.ctrlKey) { e.preventDefault(); holdBillMulti(); }
    if (e.key.toLowerCase() === 'r' && e.ctrlKey) { e.preventDefault(); openHeldCenter(); }
  });
}





  // เคลียร์ช่องรับเงินทุกครั้งที่โฟกัสช่องสแกน
  // เคลียร์ช่องรับเงินทุกครั้งที่โฟกัสช่องสแกน + ซ่อน QR ทันที
if (scanInput) {
  scanInput.addEventListener('focus', () => {
    hideQR();                     // ✅ ซ่อนทันที ไม่สน mouseInQR
    if (cashEl) {
      cashEl.value = '';
      calcChange();
    }
  });
}



// ====== ปุ่มต่างๆ (มีการ์ด ?. ป้องกัน null) ======
el('clear-input')?.addEventListener('click', () => { if (scanInput) scanInput.value = ''; });
el('clear-cart')?.addEventListener('click', clearCart);
el('hold-bill')?.addEventListener('click', holdBillMulti);
el('resume-bill')?.addEventListener('click', openHeldCenter);
el('calc-change')?.addEventListener('click', calcChange);
el('print')?.addEventListener('click', () => window.print());
el('view-receipts')?.addEventListener('click', openReceiptCenter);

// ====== เริ่มต้น ======
preloadProducts().then(() => renderCart());

// ====== เตรียมข้อมูลสำหรับบันทึก ======
function buildSalePayload() {
  const { sub } = calcTotals();
  const cash = Number(cashEl?.value || 0);
  const change = Math.max(0, cash - sub);

  const datetime = formatDateTimeISO(); // A: วันที่เวลา (ค.ศ. มาตรฐาน)
  const itemsText = cart.map(it => {
    const n = it.name || '';
    const c = it.code ? `(${it.code})` : '';
    return `${n}${c} x${it.qty} @${it.price}=${it.qty*it.price}`;
  }).join(' | '); // B: รายการสินค้า

  const qtyTotal = cart.reduce((s, it) => s + it.qty, 0); // C: จำนวน
  const total = sub;                                      // D: ราคารวม
  // E: cash, F: change

  return { datetime, itemsText, qtyTotal, total, cash, change };
}

// ====== ยิง POST แบบกันตาย: ปกติ -> ล้ม -> no-cors ======
async function saveSaleRow(payload) {
  const url = (typeof SALES_URL !== 'undefined' && SALES_URL) ? SALES_URL : PRODUCTS_URL;
  const body = JSON.stringify({
    action: 'appendSale',
    sheetName: 'รายการขาย',
    row: [payload.datetime, payload.itemsText, payload.qtyTotal, payload.total, payload.cash, payload.change]
  });

  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (res.ok) return true;
  } catch (_) {}

  try {
    await fetch(url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body });
    return true;
  } catch (_) {}

  return false;
}

// ====== ปิดบิล (FAST CLOSE) ======
async function finalizeSale() {
  if (submitting) return;
  submitting = true;

  if (cashTimer) { clearTimeout(cashTimer); cashTimer = null; }

  const payload = buildSalePayload();
  payload.saleId = Date.now().toString();
  payload.itemsText += ` [#${payload.saleId}]`;

  // ✅ เก็บ snapshot รายการก่อนเคลียร์
  const itemsSnapshot = cart.map(it => ({ ...it }));

  try {
    const html = buildReceiptHTML(payload, itemsSnapshot); // ใช้ snapshot
    const filename = `receipt_${payload.saleId}.html`;
    if (AUTO_DOWNLOAD_RECEIPT) downloadTextFile(filename, html);
    saveReceiptHistory(filename, html, payload.datetime, payload.total, payload.cash, payload.change);
  } catch (e) { console.error('สร้างใบเสร็จล้มเหลว', e); }

  // ✅ แสดงป๊อปอัปเล็กกลางจอ 10 วินาที
  showReceiptPopup(payload, itemsSnapshot);

  // เคลียร์/พูดขอบคุณ (เดิม)
  clearCart();
  if (cashEl) cashEl.value = '';
  toggleGrandShrink(false);
  calcChange();
  speakThai('ขอบคุณค่ะ'); // กด Enter รับเงินแล้วพูดขอบคุณ ณ จุดนี้
  saveSaleRow(payload).catch(err => console.error('บันทึกชีตไม่สำเร็จ', err));
  setTimeout(() => { submitting = false; }, ENTER_GUARD_MS);
}


// ====== สร้าง HTML ใบเสร็จแบบง่าย ======
function buildReceiptHTML(payload, items) {
  const lines = items.map(it => `
    <tr>
      <td>${it.code ?? '-'}</td>
      <td>${it.name}</td>
      <td style="text-align:right">${format(it.price)}</td>
      <td style="text-align:right">${it.qty}</td>
      <td style="text-align:right">${format(it.price * it.qty)}</td>
    </tr>
  `).join('');

  return `
<!doctype html>
<meta charset="utf-8" />
<title>ใบเสร็จ ${payload.datetime}</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding: 16px; }
  h1 { font-size: 18px; margin: 0 0 8px 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { border-bottom: 1px solid #ddd; padding: 6px; }
  .right { text-align: right; }
  .totals { margin-top: 12px; font-size: 16px; }
  .meta { color: #444; margin-top: 4px; }
  .print { margin-top: 12px; }
</style>
<h1>ใบเสร็จรับเงิน</h1>
<div class="meta">วันที่เวลา: ${payload.datetime}</div>
<div class="meta">รวมจำนวนสินค้า: ${payload.qtyTotal}</div>
<table>
  <thead>
    <tr>
      <th>รหัส</th>
      <th>ชื่อสินค้า</th>
      <th class="right">ราคา</th>
      <th class="right">จำนวน</th>
      <th class="right">รวม</th>
    </tr>
  </thead>
  <tbody>${lines}</tbody>
</table>
<div class="totals">
  <div>ยอดรวม: <b>${format(payload.total)}</b></div>
  <div>รับเงิน: ${format(payload.cash)}</div>
  <div>เงินทอน: ${format(payload.change)}</div>
</div>
<div class="print"><button onclick="window.print()">พิมพ์</button></div>
`;
}

// ====== ดาวน์โหลดไฟล์ข้อความ (ใช้สำหรับใบเสร็จ .html) ======
function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(a.href);
  a.remove();
}

// ====== เก็บประวัติใบเสร็จลง LocalStorage เพื่อ “ดูใบเสร็จ” ภายหลัง ======
const RECEIPT_KEY = 'pos_receipts_v1';
function saveReceiptHistory(filename, html, datetime, total, cash, change) {
  const raw = localStorage.getItem(RECEIPT_KEY);
  const list = raw ? JSON.parse(raw) : [];
  list.unshift({ id: Date.now(), filename, html, datetime, total, cash, change });
  while (list.length > 100) list.pop();
  localStorage.setItem(RECEIPT_KEY, JSON.stringify(list));
}

// ====== เปิด “ศูนย์ใบเสร็จ” แบบโมดอล ======
function openReceiptCenter() {
  const raw = localStorage.getItem(RECEIPT_KEY);
  const list = raw ? JSON.parse(raw) : [];

  // overlay สว่าง
  const overlay = document.createElement('div');
  overlay.id = 'np-overlay';
  overlay.style.cssText = `
    position:fixed; inset:0; background:rgba(0,0,0,.28); z-index:9999;
    display:flex; align-items:center; justify-content:center; padding:16px;
  `;

  // modal สว่าง
  const modal = document.createElement('div');
  modal.style.cssText = `
    width:min(900px, 100%); max-height:80vh; overflow:auto;
    background:#fff; color:#0f172a;
    border:1px solid #e5e7eb; border-radius:14px;
    box-shadow:0 10px 30px rgba(0,0,0,.18);
    padding:16px;
    font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  `;

  const rows = list.map((r, i) => `
    <div class="receipt-card" style="border:1px dashed #e5e7eb;border-radius:12px;padding:12px;margin-bottom:12px;background:#fff;color:#0f172a;">
      <h3 style="margin:0 0 6px 0;font-size:16px;color:#0f172a;">#${i+1} — ${r.datetime}</h3>
      <div>ยอดรวม: <b>${format(r.total)}</b> | รับเงิน: ${format(r.cash)} | ทอน: ${format(r.change)}</div>
      <div style="margin:8px 0; display:flex; gap:8px; flex-wrap:wrap;">
        <button data-id="${r.id}" class="btn-preview"
          style="padding:6px 10px;border:1px solid #e5e7eb;border-radius:10px;background:#fff;color:#0f172a;cursor:pointer;">
          เปิดดู
        </button>
      </div>
    </div>
  `).join('') || '<div class="receipt-card" style="border:1px dashed #e5e7eb;border-radius:12px;padding:12px;">ยังไม่มีใบเสร็จ</div>';

  modal.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <h2 style="margin:0;font-size:18px;color:#0f172a;">ใบเสร็จย้อนหลัง</h2>
      <button id="rc-close"
        style="padding:6px 10px;border:1px solid #e5e7eb;border-radius:10px;background:#fff;color:#0f172a;cursor:pointer;">
        ปิด
      </button>
    </div>
    ${rows}
    <small style="color:#64748b;">หมายเหตุ: เปิดดู/พิมพ์ได้ แต่ไม่มีการดาวน์โหลดไฟล์</small>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // ปิด
  modal.querySelector('#rc-close')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  // เปิดดูใบเสร็จ
  modal.querySelectorAll('.btn-preview').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = Number(btn.getAttribute('data-id'));
      const r = list.find(x => x.id === id);
      if (!r) return;
      const win = window.open('', '_blank');
      if (!win) { alert('เบราว์เซอร์บล็อกหน้าต่างใหม่ กรุณาอนุญาต'); return; }
      win.document.open();
      win.document.write(r.html);
      win.document.close();
    });
  });
}


// ===== DOM ใหม่สำหรับป๊อปอัปสรุปยอด =====
const appTitle   = document.getElementById('app-title');
const salesPopup = document.getElementById('sales-popup');
let salesTimer = null;

// ===== ดึงสรุปยอดจาก Apps Script =====
// ===== ดึงสรุปยอดจาก Apps Script (แก้ ReferenceError + ขยาย timeout) =====
async function fetchSalesSummary() {
  const ctrl = new AbortController();
  // เพิ่มเวลาเผื่อสคริปต์ช้า (12s)
  const t = setTimeout(() => ctrl.abort(), 12000);

  let text = ''; // ประกาศนอก try เพื่อใช้ได้ทั้ง try/catch
  try {
    const url = `${PRODUCTS_URL}?action=summary&t=${Date.now()}`;
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    text = await res.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error('SUMMARY non-JSON:', text.slice(0, 300));
      return null;
    }
    return data; // { today, yesterday, last30, ...optional error }
  } catch (e) {
    clearTimeout(t);
    if (e.name === 'AbortError') {
      console.warn('SUMMARY aborted (timeout)'); // หมดเวลาเฉย ๆ
    } else {
      console.error('โหลดสรุปยอดไม่สำเร็จ', e);
    }
    if (text) console.error('SUMMARY non-JSON:', text.slice(0, 300));
    return null;
  }
}

// ===== เมื่อคลิกหัวข้อแอป: โชว์ทันที แล้วอัปเดตผล =====
appTitle?.addEventListener('click', async () => {
  if (!salesPopup) return;
  // ตอนกำลังโหลด
// ตอนกำลังโหลด


appTitle?.addEventListener('click', async () => {
  if (!salesPopup) return;

  // ตอนกำลังโหลด
  salesPopup.innerHTML = `
    <h3>สรุปยอดขาย</h3>
    <div class="row"><span>วันนี้</span><span class="num">กำลังโหลด…</span></div>
    <div class="row"><span>เมื่อวาน</span><span class="num">กำลังโหลด…</span></div>
    <div class="row"><span>เดือนนี้</span><span class="num">กำลังโหลด…</span></div>
    <small>ปิดเองใน 10 วินาที</small>`;

  salesPopup.classList.remove('hidden');
  if (salesTimer) clearTimeout(salesTimer);
  salesTimer = setTimeout(()=> salesPopup.classList.add('hidden'), 15000);

  // ✅ ดึงข้อมูลสรุปยอด
  const s = await fetchSalesSummary();
  if (!s) {
    salesPopup.innerHTML = `<h3>สรุปยอดขาย</h3><div class="row"><small>โหลดข้อมูลไม่สำเร็จ</small></div>`;
    return;
  }

  // ✅ ประกาศ fmt ก่อนใช้
  const fmt = (n)=> Number(n||0).toLocaleString('th-TH');

  // ✅ อัปเดต UI หลังจากได้ข้อมูลแล้ว
  salesPopup.innerHTML = `
    <h3>สรุปยอดขาย</h3>
    <div class="row"><span>วันนี้</span><span class="num">${fmt(s.today)}</span></div>
    <div class="row"><span>เมื่อวาน</span><span class="num">${fmt(s.yesterday)}</span></div>
    <div class="row"><span>เดือนนี้${s.monthLabel ? ' ('+s.monthLabel+')' : ''}</span><span class="num">${fmt(s.last30)}</span></div>
    ${s.error 
        ? `<small style="color:#f88">หมายเหตุ: ${String(s.error).slice(0,120)}</small>` 
        : `<small>ปิดเองใน 10 วินาที</small>`}
  `;
});



  salesPopup.classList.remove('hidden');
  if (salesTimer) clearTimeout(salesTimer);
  salesTimer = setTimeout(()=> salesPopup.classList.add('hidden'), 15000);

  const s = await fetchSalesSummary();
  if (!s) {
    salesPopup.innerHTML = `<h3>สรุปยอดขาย</h3><div class="row"><small>โหลดข้อมูลไม่สำเร็จ</small></div>`;
    return;
  }
  const fmt = (n)=> Number(n||0).toLocaleString('th-TH');
  salesPopup.innerHTML = `
    <h3>สรุปยอดขาย</h3>
    <div class="row"><span>วันนี้</span><span class="num">${fmt(s.today)}</span></div>
    <div class="row"><span>เมื่อวาน</span><span class="num">${fmt(s.yesterday)}</span></div>
    <div class="row"><span>ย้อนหลัง 30 วัน</span><span class="num">${fmt(s.last30)}</span></div>
    ${s.error ? `<small style="color:#f88">หมายเหตุ: ${String(s.error).slice(0,120)}</small>` : `<small>ปิดเองใน 10 วินาที</small>`}
  `;
});

function formatDateTimeISO(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function toggleShrink(elm, on) {
  if (elm) elm.classList.toggle('shrink', !!on);
}

// อัปเดตการย่อ/ขยายตามสถานะปัจจุบัน
function updateShrinkUI() {
  const { sub } = calcTotals();
  const cashHasValue = (cashEl?.value || '').trim() !== '';

  // ยอดรวม (#subtotal): ย่อเมื่อ "ไม่มีรายการ" หรือ "กำลังคำนวณเงินทอน"
  toggleShrink(subtotalEl, sub === 0 || cashHasValue);

  // เงินทอน (#change): ย่อเมื่อ "ไม่มีรายการ" หรือ "ยังไม่ได้พิมพ์รับเงิน"
  toggleShrink(changeEl, sub === 0 || !cashHasValue);
}


// ===== Hotkeys & Input Guard for cash/scan =====
(function setupCashScanShortcuts(){
  const cash = document.getElementById('cash');
  const scan = document.getElementById('scan-input');

  function focusAndSelect(el) {
    if (!el) return;
    el.focus({ preventScroll: true });
    if (typeof el.select === 'function') el.select();
  }

  // คีย์ลัดทั้งหน้า
  document.addEventListener('keydown', (e) => {
    if (isModalOpen()) return;
    // ถ้ามี Ctrl/Alt/Meta ให้ปล่อยผ่าน (กันชนกับคีย์ลัดอื่น)
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    // + บน Numpad (และ + ปกติ) -> โฟกัสช่องรับเงิน
    if (e.code === 'NumpadAdd' || e.key === '+') {
      e.preventDefault();
      focusAndSelect(cash);
      return;
    }

    // . (และ Numpad Decimal) -> โฟกัสช่องสแกน
    if (e.code === 'NumpadDecimal' || e.key === '.') {
      e.preventDefault();
      focusAndSelect(scan);
      return;
    }
  });

  if (cash) {
    // อนุญาตเฉพาะตัวเลข 0-9 และปุ่มควบคุมที่จำเป็น
    cash.addEventListener('keydown', (e) => {
      const allowed = new Set([
        'Backspace','Delete','Tab','ArrowLeft','ArrowRight','Home','End','Enter'
      ]);
      if (allowed.has(e.key)) return;

      // อนุญาตคีย์ลัด Ctrl/⌘ + A/C/V/X
      if ((e.ctrlKey || e.metaKey) && /[acvx]/i.test(e.key)) return;

      // อนุญาตตัวเลข 0-9 (รวม numpad ที่ส่งเป็น '0'..'9' เหมือนกัน)
      if (/^[0-9]$/.test(e.key)) return;

      // นอกเหนือจากนี้บล็อก (รวม '.', '-', ฯลฯ)
      e.preventDefault();
    });

    // วาง (paste) ให้คงไว้เฉพาะตัวเลข
    cash.addEventListener('paste', (e) => {
      const txt = (e.clipboardData || window.clipboardData).getData('text') || '';
      if (/\D/.test(txt)) {
        e.preventDefault();
        const sanitized = txt.replace(/\D/g, '');
        const start = cash.selectionStart ?? cash.value.length;
        const end   = cash.selectionEnd ?? cash.value.length;
        cash.setRangeText(sanitized, start, end, 'end');
        // กระตุ้นให้ logic เดิมที่ฟัง 'input' ทำงานต่อ (เช่น คำนวณเงินทอน)
        cash.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });

    // กันการพิมพ์อักษรแปลก ๆ (เช่น IME) ให้เหลือแต่ตัวเลข
    cash.addEventListener('input', () => {
      const clean = cash.value.replace(/\D/g, '');
      if (cash.value !== clean) cash.value = clean;
    });
  }
})();

// ===== Force Scan Focus While Cart Is Empty =====
(function enforceScanFocusWhenEmpty(){
  const scan = document.getElementById('scan-input');

  function isCartEmpty() {
    try { return !Array.isArray(window.cart) || window.cart.length === 0; }
    catch { return true; }
  }
  function focusScan() {
    if (!scan) return;
    if (isModalOpen()) return; // หยุดถ้ามี modal
    scan.focus({ preventScroll: true });
    // ถ้าอยากให้ลบค่าก่อนพิมพ์ ให้เปิดบรรทัดนี้:
    // scan.select();
  }

  // โฟกัสช่องสแกนทันทีตอนหน้าโหลด ถ้าตะกร้าว่าง
  document.addEventListener('DOMContentLoaded', () => {
    if (isCartEmpty()) focusScan();
  });

  // ห่อ clearCart() ให้โฟกัสกลับช่องสแกนเมื่อเคลียร์แล้วตะกร้ายังว่าง
  if (typeof window.clearCart === 'function' && !window.clearCart.__wrappedForScanFocus) {
    const _clearCart = window.clearCart;
    window.clearCart = function wrappedClearCart(...args) {
      const ret = _clearCart.apply(this, args);
      if (isCartEmpty()) focusScan();
      return ret;
    };
    window.clearCart.__wrappedForScanFocus = true;
  }

  // ปุ่ม '.' หรือ NumpadDecimal -> โฟกัสช่องสแกนเสมอ (เสริมความชัวร์)
  document.addEventListener('keydown', (e) => {
    if (isModalOpen()) return; // อย่าดึงโฟกัสจาก modal
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'NumpadDecimal' || e.key === '.') {
      e.preventDefault();
      focusScan();
    }
  });

  // เมื่อ "ตะกร้ายังว่าง" ให้พิมพ์ตัวเลขที่ไหนก็เด้งไปช่องสแกน และแทรกเลขนั้นให้ทันที
  document.addEventListener('keydown', (e) => {
    if (isModalOpen()) return; // อย่าดึงโฟกัสจาก modal
    if (!isCartEmpty()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const isDigit = /^[0-9]$/.test(e.key);
    const isNumPadDigit = e.code?.startsWith('Numpad') && /^[0-9]$/.test(e.key);

    if ((isDigit || isNumPadDigit) && scan) {
      // ถ้ายังไม่ได้โฟกัส scan ให้ย้ายโฟกัสและแทรกตัวเลขนั้นทันที
      if (document.activeElement !== scan) {
        e.preventDefault();
        focusScan();

        const start = scan.selectionStart ?? scan.value.length;
        const end   = scan.selectionEnd ?? scan.value.length;
        scan.setRangeText(e.key, start, end, 'end');
        scan.dispatchEvent(new Event('input', { bubbles: true }));
      }
      // ถ้าโฟกัสอยู่ที่ scan อยู่แล้ว ปล่อยผ่านให้พิมพ์ต่อปกติ
    }
  });
})();

// ===== Speech for Cash Flow (Sum / Change / Thank you) =====
(function setupCashSpeech(){
  const cashEl = document.getElementById('cash');

  // ฟอร์แมตจำนวนเงินแบบไทย (ไม่มีทศนิยม)
  const fmt = (n) => Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 0 });

  // คำนวณยอดรวมจากตะกร้า
  function getCartTotal() {
    try {
      if (Array.isArray(cart) && cart.length > 0) {
        return cart.reduce((s, it) => s + Number(it.price || 0) * Number(it.qty || 1), 0);
      }
    } catch {}
    return 0;
  }

  // 1) โฟกัสช่องรับเงิน -> พูด "รวม X บาท" (ถ้ามีสินค้าและยอดรวม > 0)
  cashEl?.addEventListener('focus', () => {
    const total = getCartTotal();
    if (total > 0) {
      try { speakThai(`รวม ${fmt(total)} บาท`); } catch {}
    }
  });

  // 2) หลังคำนวณเงินทอนเสร็จ -> พูด "รับเงิน Y เงินทอน Z บาท"
  //    วิธีหลัก: พัน (wrap) calcChange() ถ้ามี
  function speakChangeIfReady() {
    const total = getCartTotal();
    const cash  = Number(cashEl?.value || 0);
    const change = cash - total;
    if (total > 0 && cash > 0 && Number.isFinite(change) && change >= 0) {
      try { speakThai(`รับเงิน ${fmt(cash)} เงินทอน ${fmt(change)} บาท`); } catch {}
    }
  }

  if (typeof window.calcChange === 'function' && !window.calcChange.__wrappedForSpeech) {
    const _calcChange = window.calcChange;
    window.calcChange = function wrappedCalcChange(...args) {
      const ret = _calcChange.apply(this, args);
      // รอให้ UI อัพเดตก่อนค่อยพูด (สั้นมาก)
      setTimeout(speakChangeIfReady, 10);
      return ret;
    };
    window.calcChange.__wrappedForSpeech = true;
  } else if (cashEl) {
    // Fallback: ถ้าไม่มี calcChange ให้หน่วงเล็กน้อยหลังพิมพ์
    let _t = null;
    cashEl.addEventListener('input', () => {
      clearTimeout(_t);
      _t = setTimeout(speakChangeIfReady, 350); // ปรับได้ตามดีบาวน์ที่คุณตั้งไว้
    });
    cashEl.addEventListener('blur', speakChangeIfReady);
  }

  // 3) กด Enter เพื่อบันทึกยอด -> พูด "ขอบคุณค่ะ" (มีสินค้าและรับเงิน >= ยอดรวม)
  cashEl?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const total = getCartTotal();
    const cash  = Number(cashEl.value || 0);
    if (total > 0 && cash >= total) {
      // หน่วงสั้นๆ ให้การบันทึกทำงานก่อน แล้วค่อยพูด
      setTimeout(() => { try { speakThai('ขอบคุณค่ะ'); } catch {} }, 30);
    }
  });

  // ถ้าเคลียร์ตะกร้าแล้ว อย่าให้พูด "เปลี่ยนทอน" จากค่าเดิมที่ยังค้าง
  if (typeof window.clearCart === 'function' && !window.clearCart.__wrappedForSpeech) {
    const _clearCart = window.clearCart;
    window.clearCart = function wrappedClearCart(...args) {
      const ret = _clearCart.apply(this, args);
      // เคลียร์ข้อความ/สถานะ (ถ้าจำเป็น) ไม่พูดอะไรเพิ่ม
      return ret;
    };
    window.clearCart.__wrappedForSpeech = true;
  }
})();

// ====== เพิ่มสินค้าใหม่เมื่อไม่พบรหัส ======
function openCreateProductModal(missingCode) {
  if (isModalOpen()) return; // กันเปิดซ้อน
  const code = String(missingCode || '').trim();

  const overlay = document.createElement('div');
  overlay.id = 'np-overlay'; // สำคัญ: ให้ isModalOpen() มองเห็นว่ามี modal
  overlay.style.cssText = `
    position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:9999;
    display:flex; align-items:center; justify-content:center; padding:16px;
  `;

  const modal = document.createElement('div');
  modal.style.cssText = `
    width:min(520px, 100%); max-height:80vh; overflow:auto;
    background:#0b1220; color:#e5e7eb;
    border:1px solid #334155; border-radius:14px;
    box-shadow:0 10px 30px rgba(0,0,0,.35);
    padding:16px; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  `;
  modal.innerHTML = `
    <h2 style="margin:0 0 10px 0; font-size:18px;">เพิ่มสินค้าใหม่</h2>
    <div style="color:#94a3b8; margin-bottom:10px;">ไม่พบรหัส: <b>${code || '-'}</b></div>
    <div style="display:grid; gap:10px;">
      <label style="display:grid; gap:6px;">
        <span style="color:#94a3b8;">รหัสสินค้า</span>
        <input id="np-code" type="text" value="${code}" readonly
               style="padding:10px 12px; border-radius:10px; border:1px solid #334155; background:#0b1220; color:#e5e7eb;">
      </label>
      <label style="display:grid; gap:6px;">
        <span style="color:#94a3b8;">ชื่อสินค้า (ไม่บังคับ)</span>
        <input id="np-name" type="text" placeholder="เว้นว่างได้"
               style="padding:10px 12px; border-radius:10px; border:1px solid #334155; background:#0b1220; color:#e5e7eb;">
      </label>
      <label style="display:grid; gap:6px;">
        <span style="color:#94a3b8;">ราคา (บาท) — กด Enter เพื่อยืนยัน</span>
        <input id="np-price" type="number" min="1" step="1" placeholder="เช่น 25"
               style="padding:10px 12px; border-radius:10px; border:1px solid #334155; background:#0b1220; color:#e5e7eb;">
      </label>
      <div style="display:flex; gap:8px; justify-content:flex-end;">
        <button id="np-cancel" style="padding:8px 12px; border-radius:10px; border:1px solid #334155; background:#1f2937; color:#e5e7eb; cursor:pointer;">ยกเลิก</button>
        <button id="np-save"   style="padding:8px 12px; border-radius:10px; border:1px solid #334155; background:#0b1220; color:#e5e7eb; cursor:pointer;">บันทึก & ใส่ตะกร้า</button>
      </div>
      <small style="color:#94a3b8;">บันทึกลงชีต “รายการสินค้า” และเพิ่มลงตะกร้าทันที</small>
    </div>
  `;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const elPrice = modal.querySelector('#np-price');
  const elName  = modal.querySelector('#np-name');
  const elSave  = modal.querySelector('#np-save');
  const elCancel= modal.querySelector('#np-cancel');

  // โฟกัสไปที่ "ราคา" ทันที
   // โฟกัสไปที่ "ราคา" ทันที และย้ำอีกเล็กน้อยกันโดนแย่ง
 const focusPrice = () => { elPrice?.focus({preventScroll:true}); elPrice?.select?.(); };
 requestAnimationFrame(focusPrice);
 setTimeout(focusPrice, 0);
 setTimeout(focusPrice, 50);

  function close() {
   overlay.remove();
 }

  function confirmSave() {
    const price = Number((elPrice.value || '').trim());
    if (!Number.isFinite(price) || price <= 0) {
      toast('กรุณาใส่ราคาให้ถูกต้อง');
      elPrice.focus(); elPrice.select?.();
      return;
    }
    const rawName = (elName.value || '').trim();
    const name = rawName || 'สินค้าอื่นๆ';
    addAndSaveNewProduct({ code, name, price });
    close();
  }

  elSave?.addEventListener('click', confirmSave);
  elCancel?.addEventListener('click', close);

  // Enter ที่ช่องราคา = ยืนยัน, Esc = ยกเลิก
  elPrice?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmSave(); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  // กันคลิกนอก modal
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

// เพิ่มเข้าตะกร้าทันที + บันทึกขึ้นชีตแบบ async
function addAndSaveNewProduct({ code, name, price }) {
  try {
    const item = { code, name, price: Number(price)||0 };
    productMap.set(String(code), item);

    let idx = findCartIndexByCode(item.code);
    if (idx > -1) {
      cart[idx].qty += 1;
    } else {
      cart.push({ code: item.code, name: item.name, price: item.price, qty: 1 });
      idx = cart.length - 1;
    }

    // ⭐ ย้ายขึ้นบนสุด
    moveLineToFront(idx);

    // ⭐ จดจำคีย์ล่าสุด (ตอนนี้ index 0)
    lastAddedKey = makeLineKey(cart[0]);
    const qtyNow = Number(cart[0].qty) || 0;

    renderCart();
    speakThai(`${item.price} บาท`);

    // บันทึกขึ้นชีตแบบ background เหมือนเดิม
    saveProductRow({ code, name, price: Number(price)||0 })
      .then(ok => { if (ok) toast('บันทึกสินค้าแล้ว'); else toast('บันทึกสินค้าล้มเหลว'); })
      .catch(()=> toast('บันทึกสินค้าล้มเหลว'));
  } catch (e) {
    console.error('เพิ่มสินค้าใหม่ไม่สำเร็จ:', e);
    toast('เพิ่มสินค้าไม่สำเร็จ');
  }
}


// ยิงไป Apps Script หลายโหมด (เผื่อแอ็กชันต่างกัน)
async function saveProductRow({ code, name, price }) {
  const url = (typeof PRODUCTS_URL !== 'undefined' && PRODUCTS_URL) ? PRODUCTS_URL : '';
  if (!url) return false;

  const payloads = [
    { action:'appendProduct', sheetName:'รายการสินค้า', row:[code, name, price] },
    { action:'upsertProduct', sheetName:'รายการสินค้า', row:[code, name, price] },
  ];

  // โหมด POST JSON ปกติ
  for (const bodyObj of payloads) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify(bodyObj),
      });
      if (res.ok) return true;
    } catch (_) {}
  }

  // โหมด POST no-cors กันตาย
  try {
    await fetch(url, {
      method: 'POST', mode:'no-cors',
      headers: { 'Content-Type':'text/plain;charset=utf-8' },
      body: JSON.stringify({ action:'appendProduct', sheetName:'รายการสินค้า', row:[code, name, price] }),
    });
    return true;
  } catch (_) {}

  // โหมด GET กันตาย (ถ้าสคริปต์รองรับ)
  try {
    const qs = new URLSearchParams({
      action: 'addProduct',
      sheetName: 'รายการสินค้า',
      code: code, name: name, price: String(price)
    });
    const res = await fetch(`${url}?${qs.toString()}`);
    if (res.ok) return true;
  } catch (_) {}

  return false;
}

// ==== Modal guard ====
function isModalOpen() {
  return !!document.getElementById('np-overlay'); // modal เพิ่มสินค้า
}

// ============ ANIMATIONS: เมื่อเพิ่มสินค้าลงตะกร้า ============
function animateAddToCartVisual(labelText = '+1') {
  try {
    const cartBtn  = document.getElementById('held-bills-button');
    const fromEl   = document.getElementById('scan-input');
    const tbody    = document.getElementById('cart-body');

    // 1) ไฮไลต์แถวล่าสุด (ไม่ต้อง setTimeout)
    if (tbody) {
      const row = tbody.firstElementChild; // สมมติแถวล่าสุดถูกย้ายขึ้นบนสุดแล้ว
      if (row) {
        row.classList.add('cart-added');
        row.addEventListener('animationend', () => {
          row.classList.remove('cart-added');
        }, { once: true });
      }
    }

    // 2) เด้งปุ่มตะกร้า
    if (cartBtn) {
      cartBtn.classList.add('btn-bump');
      cartBtn.addEventListener('animationend', () => {
        cartBtn.classList.remove('btn-bump');
      }, { once: true });
    }

    // 3) ชิปบินจากช่องสแกน -> ปุ่มตะกร้า (เอา animation finish จัดการลบ)
    if (fromEl && cartBtn) {
      const fr = fromEl.getBoundingClientRect();
      const tr = cartBtn.getBoundingClientRect();
      const cx = fr.left + fr.width  * 0.85;
      const cy = fr.top  + fr.height * 0.5;
      const tx = tr.left + tr.width  * 0.5;
      const ty = tr.top  + tr.height * 0.5;

      const chip = document.createElement('div');
      chip.className = 'fly-chip';
      chip.textContent = labelText;
      chip.style.left = `${cx}px`;
      chip.style.top  = `${cy}px`;
      document.body.appendChild(chip);

      const anim = chip.animate(
        [
          { transform: 'translate(-50%,-50%) scale(1)',   opacity: 1 },
          { transform: `translate(${tx-cx-50}%, ${ty-cy-50}%) scale(.55)`, opacity: 0.1 }
        ],
        { duration: 600, easing: 'cubic-bezier(.2,.9,.25,1.2)' }
      );
      anim.onfinish = () => chip.remove();
    }

    // 4) เด้งยอดรวม
    const sub = document.getElementById('subtotal');
    if (sub) {
      sub.classList.add('pulse');
      sub.addEventListener('animationend', () => {
        sub.classList.remove('pulse');
      }, { once: true });
    }
  } catch (_) {}
}

// === Mini Receipt Popup (10s auto hide) ===
function showReceiptPopup(payload, items) {
  const shop = document.getElementById('app-title')?.textContent?.trim() || 'ร้านของฉัน';
  const dt   = payload?.datetime || new Date().toLocaleString('th-TH');

  // จำกัดจำนวนบรรทัดเพื่อให้ "เล็ก" อ่านง่าย
  const MAX_LINES = 6;
  const shown = (items || []).slice(0, MAX_LINES);
  const more  = (items?.length || 0) - shown.length;

  const lines = shown.map(it => `
    <div class="mr-line">
      <span class="n">${it.name}</span>
      <span class="p">${format(it.price)} × ${it.qty}</span>
      <span class="t">${format(it.price * it.qty)}</span>
    </div>
  `).join('') + (more > 0 ? `<div class="mr-more">… และอีก ${more} รายการ</div>` : '');

  // สร้างโครง popup (non-blocking, pointer-events เฉพาะกล่อง)
  const wrap = document.createElement('div');
  wrap.id = 'mini-receipt';
  wrap.innerHTML = `
    <div class="mr-card" role="dialog" aria-live="polite">
      <div class="mr-head">
        <div class="shop">${shop}</div>
        <div class="dt">${dt}</div>
      </div>
      <div class="mr-body">
        ${lines || '<div class="mr-empty">ไม่มีรายการ</div>'}
      </div>
      <div class="mr-foot">
        <div>ยอดรวม <b>${format(payload.total)}</b></div>
        <div>รับเงิน ${format(payload.cash)}</div>
        <div>เงินทอน ${format(payload.change)}</div>
      </div>
    </div>
  `;
      document.body.appendChild(wrap);

  // ===== คำนวณจุดกึ่งกลางของ "กล่องรายการสินค้า" =====
  function getCartBox() {
    // ไล่หา element ที่เป็นกล่องรายการ (เผื่อโปรเจกต์ใช้ชื่อไม่เหมือนกัน)
    const candidates = [
      '#cart-area', '#cart-panel', '#cart-box', '#cart-wrap',
      '.cart-wrap', '.cart-container', '.cart-area', '.cart', '#cart-body'
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  const card = wrap.querySelector('.mr-card');
  let cx = window.innerWidth / 2, cy = window.innerHeight / 2;

  const cartBox = getCartBox();
  if (cartBox) {
    const r = cartBox.getBoundingClientRect();
    cx = r.left + r.width  / 2;
    cy = r.top  + r.height / 2;
  }

  // วางการ์ดไว้ "กลางกล่องรายการ"
   // วางการ์ดไว้ "กลางกล่องรายการ" แล้วขยับขึ้นอีกนิด
    const OFFSET_Y = -0.08 * (cartBox ? cartBox.getBoundingClientRect().height : 500);
  card.style.top = `${cy + OFFSET_Y}px`;



  // ปิดเมื่อครบเวลา/คลิก
  const close = () => wrap.remove();
  setTimeout(close, 10000);
  card.addEventListener('click', close, { once:true });
  // คลิกที่ที่ว่างก็กดปิดได้
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); }, { once:true });
}





// ===== Quick Tiles (สินค้าไม่มีบาร์โค้ด) =====
const QUICK_TILES_KEY = 'pos_quick_tiles_v1';
const quickTilesWrap = document.getElementById('quick-tiles');
const addQuickTileBtn = document.getElementById('add-quick-tile');

// เก็บ/โหลด
function loadQuickTiles(){
  const raw = safeGet(QUICK_TILES_KEY);
  if (!raw) return [];
  try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; }
  catch { return []; }
}
function saveQuickTiles(list){ safeSet(QUICK_TILES_KEY, JSON.stringify(list)); }

// เพิ่มไทล์ใหม่
function addQuickTileEntry(name, price, color){
  const list = loadQuickTiles();
  const entry = {
    id: Date.now(),
    name: String(name || '').trim(),
    price: Math.max(0, Number(price) || 0),
    color: color || pickPastelByName(name)
  };
  if (!entry.name || !entry.price) { toast('กรุณาใส่ชื่อ/ราคาให้ถูกต้อง'); return false; }
  list.unshift(entry);
  saveQuickTiles(list);
  renderQuickTiles();
  toast('เพิ่มปุ่มสินค้าแล้ว');
  return true;
}

// เรนเดอร์ไทล์
function renderQuickTiles(){
  if (!quickTilesWrap) return;
  const list = loadQuickTiles();
  quickTilesWrap.innerHTML = '';

  list.forEach(ent => {
    const card = document.createElement('button');
    card.className = 'qtile';
    card.type = 'button';
    card.setAttribute('data-color', ent.color || 'green');
    card.innerHTML = `
      <div class="name">${escapeHTML(ent.name)}</div>
      <div class="price">฿${Number(ent.price).toLocaleString('th-TH')}</div>
    `;

    // ====== กดค้าง 3 วินาที → เปิดแก้ไข/ลบ ======
    let pressTimer = null;
    let longPressTriggered = false;

    function startPress(e){
      // กัน tap ซ้อนบนมือถือ
      if (e.type === 'touchstart') e.preventDefault();
      longPressTriggered = false;
      pressTimer = setTimeout(() => {
        longPressTriggered = true;
        openEditQuickTileModal(ent.id);   // 👉 เปิด modal แก้ไข/ลบ
      }, 3000); // 3 วินาที
    }
    function cancelPress(){
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    }

    card.addEventListener('mousedown', startPress);
    card.addEventListener('touchstart', startPress, { passive:false });
    card.addEventListener('mouseup', cancelPress);
    card.addEventListener('mouseleave', cancelPress);
    card.addEventListener('touchend', cancelPress);

    // ====== คลิกสั้น → เพิ่มสินค้า ======
    card.addEventListener('click', (e) => {
      if (longPressTriggered) { e.preventDefault(); return; }
      // เพิ่มลงตะกร้าแบบ code=null
      let idx = cart.findIndex(l =>
        l.code === null &&
        l.name === ent.name &&
        Number(l.price) === Number(ent.price)
      );
      if (idx > -1) {
        cart[idx].qty += 1;
      } else {
        cart.push({ code: null, name: ent.name, price: Number(ent.price)||0, qty: 1 });
        idx = cart.length - 1;
      }
      if (typeof moveLineToFront === 'function') moveLineToFront(idx);
      lastAddedKey = `price:${ent.price}`;   // key สำหรับไฮไลต์ล่าสุด
      renderCart?.();
      if (typeof animateAddToCartVisual === 'function') animateAddToCartVisual(`฿${ent.price}`);
      speakThai?.(`${ent.price} บาท`);
    });

    quickTilesWrap.appendChild(card);
  });
}


// ปุ่ม “+ เพิ่มปุ่มสินค้า”
addQuickTileBtn?.addEventListener('click', openAddQuickTileModal);

// โมดัลสร้างไทล์ใหม่ (ชื่อ + ราคา + สี)
function openAddQuickTileModal(){
  const overlay = document.createElement('div');
  overlay.id = 'np-overlay';
  overlay.style.display = 'flex';

  const modal = document.createElement('div');
  modal.innerHTML = `
    <h2>เพิ่มปุ่มสินค้า (ไม่มีบาร์โค้ด)</h2>
    <label style="display:block;margin-bottom:8px;">
      <span>ชื่อสินค้า</span>
      <input id="qt-name" type="text" placeholder="เช่น ไข่ไก่" />
    </label>
    <label style="display:block;margin-bottom:8px;">
      <span>ราคา (บาท)</span>
      <input id="qt-price" type="number" min="0" step="1" placeholder="เช่น 5" />
    </label>
    <label style="display:block;margin-bottom:8px;">
      <span>สีการ์ด</span>
      <select id="qt-color">
        <option value="green">เขียว</option>
        <option value="blue">ฟ้า</option>
        <option value="pink">ชมพู</option>
        <option value="amber">เหลือง</option>
        <option value="teal">เขียวอมฟ้า</option>
      </select>
    </label>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;">
      <button id="qt-cancel">ยกเลิก</button>
      <button class="btn-save" id="qt-save">บันทึก</button>
    </div>
  `;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const close = ()=> overlay.remove();
  modal.querySelector('#qt-cancel')?.addEventListener('click', close);
  modal.querySelector('#qt-save')?.addEventListener('click', () => {
    const name  = String(modal.querySelector('#qt-name').value || '').trim();
    const price = Number(modal.querySelector('#qt-price').value || 0);
    const color = String(modal.querySelector('#qt-color').value || 'green');
    if (addQuickTileEntry(name, price, color)) close();
  });
}

// ยูทิลลดความเสี่ยง XSS เล็กน้อย
function escapeHTML(s){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

// เลือกสีพาสเทลอัตโนมัติจากชื่อ (ถ้าไม่เลือกเอง)
function pickPastelByName(name){
  const arr = ['green','blue','pink','amber','teal'];
  let h = 0; for (let i=0;i<name.length;i++) h = (h*31 + name.charCodeAt(i))>>>0;
  return arr[h % arr.length];
}

// เริ่มต้น
document.addEventListener('DOMContentLoaded', renderQuickTiles);


function openEditQuickTileModal(id){
  const list = loadQuickTiles();
  const ent = list.find(x => x.id === id);
  if (!ent) return;

  const overlay = document.createElement('div');
  overlay.id = 'np-overlay';
  overlay.style.display = 'flex';

  const modal = document.createElement('div');
  modal.innerHTML = `
    <h2>แก้ไขปุ่มสินค้า</h2>
    <label style="display:block;margin-bottom:8px;">
      <span>ชื่อสินค้า</span>
      <input id="qt-edit-name" type="text" value="${escapeHTML(ent.name)}" />
    </label>
    <label style="display:block;margin-bottom:8px;">
      <span>ราคา (บาท)</span>
      <input id="qt-edit-price" type="number" value="${ent.price}" min="0" step="1" />
    </label>
    <label style="display:block;margin-bottom:8px;">
      <span>สีการ์ด</span>
      <select id="qt-edit-color">
        <option value="green">เขียว</option>
        <option value="blue">ฟ้า</option>
        <option value="pink">ชมพู</option>
        <option value="amber">เหลือง</option>
        <option value="teal">เขียวอมฟ้า</option>
      </select>
    </label>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;">
      <button id="qt-delete">ลบ</button>
      <button id="qt-cancel">ยกเลิก</button>
      <button class="btn-save" id="qt-save">บันทึก</button>
    </div>
  `;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  modal.querySelector('#qt-edit-color').value = ent.color || 'green';
  const close = ()=> overlay.remove();

  modal.querySelector('#qt-cancel')?.addEventListener('click', close);

  modal.querySelector('#qt-delete')?.addEventListener('click', () => {
    const newList = list.filter(x => x.id !== id);
    saveQuickTiles(newList);
    renderQuickTiles();
    toast('ลบปุ่มแล้ว');
    close();
  });

  modal.querySelector('#qt-save')?.addEventListener('click', () => {
    const name  = String(modal.querySelector('#qt-edit-name').value || '').trim();
    const price = Math.max(0, Number(modal.querySelector('#qt-edit-price').value || 0));
    const color = String(modal.querySelector('#qt-edit-color').value || 'green');

    if (!name || !price) { toast('กรุณากรอกชื่อ/ราคาให้ถูกต้อง'); return; }

    ent.name  = name;
    ent.price = price;
    ent.color = color;

    saveQuickTiles(list);
    renderQuickTiles();
    toast('แก้ไขปุ่มแล้ว');
    close();
  });
}
