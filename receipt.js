'use strict';

/* Receipt scanning, entirely on-device.
 * Text is read with Tesseract.js (open-source OCR, downloaded from the CDN on first use and cached for
 * offline use); the photo never leaves the device. Simple rules then pick out the total, date, store
 * and currency, and guess a category from the store name or from your past entries at the same place.
 */
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const OCR_LANGS = { eng: 'English', jpn: '日本語' };

let tesseractLoading = null;
const ocrWorkers = {};
let ocrIdleTimer = null;
let ocrProgress = () => {};

function loadTesseract() {
  return tesseractLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESSERACT_URL;
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => { tesseractLoading = null; s.remove(); reject(new Error('Could not download the receipt reader. Connect to the internet for your first scan.')); };
    document.head.append(s);
  });
}

async function ocrWorker(lang) {
  ocrWorkers[lang] ||= loadTesseract()
    .then(T => T.createWorker(lang, 1, { logger: m => ocrProgress(m) }))
    .catch(e => { delete ocrWorkers[lang]; throw e; });
  return ocrWorkers[lang];
}

// OCR engines use a lot of memory (especially Japanese); free them when not scanning.
function releaseOcrSoon() {
  clearTimeout(ocrIdleTimer);
  ocrIdleTimer = setTimeout(async () => {
    for (const [lang, w] of Object.entries(ocrWorkers)) { delete ocrWorkers[lang]; (await w.catch(() => null))?.terminate(); }
  }, 120000);
}

/* ---------- image preparation ---------- */
async function loadImage(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally { URL.revokeObjectURL(url); }
  }
}

// Downscale big camera photos, convert to grayscale and stretch contrast — faster and more accurate OCR.
async function prepareReceipt(file) {
  const img = await loadImage(file);
  const iw = img.width, ih = img.height;
  const scale = Math.min(1, 2200 / Math.max(iw, ih));
  const w = Math.round(iw * scale), h = Math.round(ih * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);

  const t = document.createElement('canvas');
  const ts = Math.min(1, 240 / Math.max(w, h));
  t.width = Math.round(w * ts); t.height = Math.round(h * ts);
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  const thumb = t.toDataURL('image/jpeg', 0.7);

  const data = g.getImageData(0, 0, w, h);
  const px = data.data, hist = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) {
    const y = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 | 0;
    px[i] = y; hist[y]++;
  }
  // Ignore the darkest/lightest 2% when stretching, so shadows and glare don't dominate.
  const n = w * h;
  let lo = 0, hi = 255, acc = 0;
  while (lo < 255 && (acc += hist[lo]) < n * 0.02) lo++;
  acc = 0;
  while (hi > 0 && (acc += hist[hi]) < n * 0.02) hi--;
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < px.length; i += 4) {
    const v = Math.max(0, Math.min(255, (px[i] - lo) * 255 / range));
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  g.putImageData(data, 0, 0);
  return { canvas, thumb };
}

/* ---------- reading the text ---------- */
// Full-width (Japanese) digits and symbols → ASCII.
const toHalfWidth = s => s
  .replace(/[０-９Ａ-Ｚａ-ｚ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
  .replace(/，/g, ',').replace(/．/g, '.').replace(/[￥\\]/g, '¥').replace(/：/g, ':').replace(/／/g, '/').replace(/　/g, ' ');

const CJK = '\\u3040-\\u30ff\\u4e00-\\u9faf々ー・';
const CJK_GAPS = new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`, 'g');

function cleanLine(line) {
  return toHalfWidth(line)
    .replace(CJK_GAPS, '') // Japanese OCR puts spaces between characters: "ロー ソン" → "ローソン"
    .replace(/(?<=\d)[Oo](?=[\d.,\s]|$)|(?<=[\s¥$P₱])[Oo](?=\d)/g, '0') // OCR reads 0 as O
    .replace(/(\d)\s*,\s*(\d{2})(?!\d)/g, '$1.$2') // "250,00" → "250.00"
    .replace(/(\d)\s+\.\s*(\d{2})(?!\d)/g, '$1.$2'); // "250 .00" → "250.00"
}

function amountsIn(line) {
  const out = [];
  // Skip dates, times, phone/TIN-like runs so they aren't mistaken for prices.
  const masked = line
    .replace(/\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}/g, ' ')
    .replace(/\d{1,2}:\d{2}(:\d{2})?/g, ' ')
    .replace(/\d{3,}[-\s]\d{3,}([-\s]\d+)*/g, ' ');
  for (const m of masked.matchAll(/(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?![\d,])/g)) {
    const digits = m[1].replace(/,/g, '');
    if (digits.length > 8) continue;
    const n = parseFloat(digits + (m[2] ? '.' + m[2] : ''));
    if (n > 0) out.push({ n, decimals: !!m[2] });
  }
  return out;
}

const TOTAL_WORDS = /\b(grand\s*total|total(\s*(amount|due|sales|payable|price))?|amount\s*(due|payable)|net\s*(amount|total|sales)|balance\s*due|to\s*pay)\b|総?合\s*計|お?買上げ?計|お?買い?上げ?金額|ご?請求額|お会計|お支払い?金?額/i;
const NOT_TOTAL = /sub\s*-?\s*total|total\s*(items?|qty|quantity|discount|savings|vat|tax|no)|vatable|vat\s*(exempt|amount)|zero\s*rated|change|tender|小\s*計|お?釣|釣銭|お?預|点数|税率|対象|内税|消費税|値引/i;
const CURRENCY_MARK = /[¥$₱円]|\bPHP\b|\bUSD\b|\bJPY\b|(^|\s)P\s?\d/i;

function findTotal(lines) {
  const keyword = [];
  lines.forEach((line, i) => {
    if (!TOTAL_WORDS.test(line) || NOT_TOTAL.test(line)) return;
    let nums = amountsIn(line);
    if (!nums.length && lines[i + 1]) nums = amountsIn(lines[i + 1]); // amount printed on the next line
    if (nums.length) keyword.push(nums[nums.length - 1].n); // the rightmost number on a total line
  });
  // Grand total ≥ any other "total" line, so take the largest.
  if (keyword.length) return { amount: Math.max(...keyword), sure: true };
  const marked = lines.filter(l => CURRENCY_MARK.test(l) && !NOT_TOTAL.test(l)).flatMap(amountsIn).map(x => x.n);
  if (marked.length) return { amount: Math.max(...marked), sure: false };
  const priced = lines.filter(l => !NOT_TOTAL.test(l)).flatMap(amountsIn).filter(x => x.decimals).map(x => x.n);
  if (priced.length) return { amount: Math.max(...priced), sure: false };
  return null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function findDate(text) {
  const found = [];
  const add = (y, m, d) => {
    if (y < 100) y += 2000;
    const dt = new Date(y, m - 1, d);
    if (dt.getMonth() === m - 1 && dt.getDate() === d && y >= 2000 && dt <= new Date(Date.now() + 864e5)) found.push(ymd(dt));
  };
  for (const m of text.matchAll(/(20\d{2})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})/g)) add(+m[1], +m[2], +m[3]);
  for (const m of text.matchAll(/令和\s*(\d{1,2}|元)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})/g)) add(2018 + (m[1] === '元' ? 1 : +m[1]), +m[2], +m[3]);
  for (const m of text.matchAll(/\bR\s?(\d{1,2})[./](\d{1,2})[./](\d{1,2})\b/g)) add(2018 + +m[1], +m[2], +m[3]);
  for (const m of text.matchAll(/(?<![\d.])(\d{1,2})[/\-.](\d{1,2})[/\-.](20\d{2}|\d{2})(?![\d.])/g)) {
    const a = +m[1], b = +m[2], y = +m[3];
    if (a <= 12) add(y, a, b); else add(y, b, a); // month-first (PH/US) unless the first number can't be a month
  }
  for (const m of text.matchAll(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})\b/g)) if (MONTHS[m[1].toLowerCase()]) add(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  for (const m of text.matchAll(/\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(20\d{2})\b/g)) if (MONTHS[m[2].toLowerCase()]) add(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return found[0] || null;
}

const titleCase = s => (/[a-z]/.test(s) ? s : s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()));
function findStore(lines) {
  const skip = /receipt|official|invoice|\btin\b|vat|\breg\b|tel\b|phone|address|cashier|\bpos\b|\bsn\b|\bmin\b|permit|accred|thank|welcome|領収|レシート|電話|TEL|〒|登録番号|毎度|ありがとう|いらっしゃい/i;
  for (const raw of lines.slice(0, 6)) {
    const line = raw.replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N})]+$/gu, '').trim();
    const letters = (line.match(/[A-Za-z぀-ヿ一-龯]/g) || []).length;
    if (letters >= 3 && letters / line.length > 0.55 && !skip.test(line)) return titleCase(line).slice(0, 40);
  }
  return '';
}

function findCurrency(text) {
  if (/[¥円]|[぀-ヿ]/.test(text)) return 'JPY';
  if (/₱|\bPHP\b|VAT\s*REG|\bTIN\b|\bBIR\b|(^|\s)P\s?\d+\.\d{2}/im.test(text)) return 'PHP';
  if (/\$|\bUSD\b/.test(text)) return 'USD';
  return null;
}

// Store-name hints → default category names. Your own history at the same place always wins.
const STORE_HINTS = [
  [/jollibee|mcdo|mcdonald|\bkfc\b|chowking|greenwich|mang inasal|starbucks|coffee|\bcaf[eé]|bakery|bakeshop|restaurant|\bresto\b|\bgrill\b|pizza|burger|\btea\b|\bfoods?\b|eatery|7-?eleven|seven[- ]?eleven|ministop|family ?mart|lawson|supermarket|grocery|puregold|savemore|waltermart|\bmart\b|\bmarket\b|スーパー|コンビニ|セブン|ローソン|ファミリーマート|ファミマ|マクドナルド|吉野家|すき家|松屋|食堂|レストラン|カフェ|珈琲|コーヒー|イオン|西友|まいばすけっと|弁当|ベーカリー/i, 'Food'],
  [/\bshell\b|petron|caltex|seaoil|\bfuel\b|gas station|\bgrab\b|angkas|\btaxi\b|\btoll\b|parking|\blrt\b|\bmrt\b|\bjr\b|suica|pasmo|駅|ガソリン|ENEOS|エネオス|出光|タクシー|駐車|鉄道|バス/i, 'Transport'],
  [/mercury drug|watsons|pharmacy|\bdrug|clinic|hospital|medical|dental|薬局|薬品|ドラッグ|マツモトキヨシ|ツルハ|ウエルシア|クリニック|病院|歯科/i, 'Health'],
  [/daiso|ダイソー|ace hardware|handyman|true value|wilcon|ニトリ|ドン.?キホーテ|無印|\bmuji\b|\bikea\b|ホームセンター|セリア|キャンドゥ/i, 'Daily goods'],
  [/uniqlo|ユニクロ|h&m|\bzara\b|penshoppe|\bbench\b|しまむら|salon|barber|美容/i, 'Clothing & beauty'],
  [/meralco|maynilad|manila water|water district|電力|水道/i, 'Utilities'],
  [/\bglobe\b|\bsmart\b|\bpldt\b|converge|docomo|ドコモ|softbank|ソフトバンク|楽天モバイル/i, 'Phone & internet'],
  [/cinema|movie|timezone|netflix|spotify|映画|シネマ|カラオケ/i, 'Entertainment'],
  [/national book ?store|fully booked|bookstore|書店|ブックオフ|紀伊國屋/i, 'Education'],
];
function guessCategory(store, text) {
  const norm = s => String(s || '').trim().toLowerCase();
  if (store) {
    const prev = db.transactions.filter(t => t.type === 'expense' && norm(t.place) === norm(store)).sort(byNewest)[0];
    if (prev && catById(prev.categoryId)) return { categoryId: prev.categoryId, genre: prev.genre || '' };
  }
  const head = `${store}\n${text.slice(0, 300)}`;
  for (const [re, name] of STORE_HINTS) {
    if (!re.test(head)) continue;
    const c = db.categories.find(x => x.type === 'expense' && x.name === name);
    if (c) return { categoryId: c.id, genre: '' };
  }
  return null;
}

function parseReceipt(text) {
  const lines = text.split('\n').map(cleanLine).filter(l => l.trim());
  const joined = lines.join('\n');
  const store = findStore(lines);
  return {
    total: findTotal(lines),
    date: findDate(joined),
    store,
    currency: findCurrency(text),
    category: guessCategory(store, joined),
  };
}

/* ---------- entry sheet integration ---------- */
function scanSection(d) {
  const s = d.scan;
  const lang = db.settings.receiptLang || 'eng';
  if (s?.status === 'reading') {
    return `<div class="scan-box"><img src="${s.thumb}" alt="Receipt">
      <div class="scan-info"><b>Reading receipt…</b><div class="bar"><i id="scan-bar" style="width:${s.pct || 0}%"></i></div>
      <small class="muted" id="scan-msg">${esc(s.msg || 'Starting')}</small></div></div>`;
  }
  let html = `<div class="scan-row">
    <button type="button" class="btn secondary" data-act="scanReceipt">📷 ${s ? 'Scan again' : 'Scan receipt'}</button>
    <button type="button" class="cur-chip" data-act="scanLang" aria-label="Receipt language">${OCR_LANGS[lang]}</button></div>`;
  if (s?.status === 'done') {
    const found = s.found;
    const bits = [
      found.total && `total ${money(found.total.amount, d.currency)}`,
      found.date && dayLabel(found.date),
      found.store,
    ].filter(Boolean).map(esc).join(' · ');
    html += `<div class="scan-box"><img src="${s.thumb}" alt="Receipt">
      <div class="scan-info">${found.total
        ? `<b>✓ Filled from receipt</b><small>${bits}</small><small class="muted">${found.total.sure ? 'Please check before saving.' : "Couldn't find a TOTAL line — this is the largest amount, so please check it."}</small>`
        : `<b>Couldn't find the total</b><small class="muted">Type the amount — the scanned text is below.${bits ? ` Found: ${bits}` : ''}</small>`}
      </div></div>
      <details class="scan-text"><summary>Show scanned text</summary><pre>${esc(s.text.trim() || '(no text found — try a sharper, well-lit photo)')}</pre></details>`;
  }
  if (s?.status === 'error') html += `<div class="neg" style="font-size:13px;margin:4px">${esc(s.error)}</div>`;
  return html;
}

function afterTxSheet(d) {
  for (const k of d.scan?.filled || []) $(`#f-${k}`)?.classList.add('filled');
}

async function scanFile(file) {
  const d = draft;
  if (!d || !file) return;
  readTxForm();
  let prepared;
  try { prepared = await prepareReceipt(file); }
  catch { d.scan = { status: 'error', error: "Couldn't open that image. Try a JPG or PNG photo." }; renderTxSheet(); return; }
  const lang = db.settings.receiptLang || 'eng';
  d.scan = { status: 'reading', thumb: prepared.thumb, pct: 0, msg: 'Loading the receipt reader' };
  renderTxSheet();
  ocrProgress = m => {
    if (draft !== d) return;
    const labels = { 'loading tesseract core': 'Loading the receipt reader', 'loading language traineddata': `Downloading ${OCR_LANGS[lang]} text data (first time only)`, 'recognizing text': 'Reading text' };
    const pct = m.status === 'recognizing text' ? 20 + m.progress * 80 : Math.min(20, (m.progress || 0) * 20);
    d.scan.pct = Math.round(pct); d.scan.msg = labels[m.status] || d.scan.msg;
    const bar = $('#scan-bar'), msg = $('#scan-msg');
    if (bar) bar.style.width = `${d.scan.pct}%`;
    if (msg) msg.textContent = d.scan.msg;
  };
  try {
    const worker = await ocrWorker(lang);
    const { data } = await worker.recognize(prepared.canvas);
    if (draft !== d) return; // sheet was closed while reading
    readTxForm();
    const found = parseReceipt(data.text);
    const filled = [];
    if (found.currency && db.settings.currencies.includes(found.currency) && found.currency !== d.currency) {
      d.currency = found.currency; d.rate = undefined;
      const acc = db.accounts.find(a => a.currency === found.currency);
      if (acc && accById(d.accountId)?.currency !== found.currency) d.accountId = acc.id;
    }
    if (found.total) { d.amount = String(roundMoney(found.total.amount, d.currency)); filled.push('amount'); }
    if (found.date) { d.date = found.date; filled.push('date'); }
    if (found.store) { d.place = found.store; filled.push('place'); }
    if (found.category) { d.categoryId = found.category.categoryId; d.genre = found.category.genre; }
    d.scan = { status: 'done', thumb: prepared.thumb, text: data.text, found, filled };
  } catch (e) {
    if (draft !== d) return;
    d.scan = { status: 'error', error: e.message || 'Scanning failed — try again.' };
  } finally {
    ocrProgress = () => {};
    releaseOcrSoon();
  }
  renderTxSheet();
}

Object.assign(actions, {
  scanReceipt: () => {
    let input = $('#scanFile');
    if (!input) {
      input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', id: 'scanFile', hidden: true });
      input.addEventListener('change', () => { const f = input.files[0]; input.value = ''; scanFile(f); });
      document.body.append(input);
    }
    input.click();
  },
  scanLang: () => {
    readTxForm();
    db.settings.receiptLang = (db.settings.receiptLang || 'eng') === 'eng' ? 'jpn' : 'eng';
    save(); renderTxSheet();
    toast(`Receipts will be read as ${OCR_LANGS[db.settings.receiptLang]}`);
  },
});
