// ── Storage keys ──────────────────────────────────────────────────────────────
const HISTORY_KEY   = 'kaloriskan_history';
const GOALS_KEY      = 'kaloriskan_goals';
const WATER_KEY      = 'kaloriskan_water';
const WEIGHT_KEY     = 'kaloriskan_weight';
const DEVICE_ID_KEY  = 'kaloriskan_device_id';

const DEFAULT_GOALS = { cal: 2000, protein: 80, fat: 65, carbs: 250, water: 2000 };

// TODO: подставить реальную цену и ссылку на оплату ЮKassa после того, как они определены
const SUBSCRIPTION_PRICE_RUB = 299;
const PAYMENT_LINK = 'https://yookassa.ru/my/i/REPLACE_ME/l';

// ── Device ID (заменяет полноценные аккаунты на старте) ────────────────────────
function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

// ── Date ──────────────────────────────────────────────────────────────────────
function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function formatDate(s) {
  const [y, m, d] = s.split('-');
  return `${d}.${m}.${y}`;
}

// ── Goals ─────────────────────────────────────────────────────────────────────
function getGoals() {
  return JSON.parse(localStorage.getItem(GOALS_KEY) || 'null') || { ...DEFAULT_GOALS };
}

// ── Water ─────────────────────────────────────────────────────────────────────
function getWaterToday() {
  const data = JSON.parse(localStorage.getItem(WATER_KEY) || '{}');
  return data[getTodayKey()] || 0;
}

function setWaterToday(ml) {
  const data = JSON.parse(localStorage.getItem(WATER_KEY) || '{}');
  data[getTodayKey()] = Math.max(0, ml);
  localStorage.setItem(WATER_KEY, JSON.stringify(data));
}

function addWater(ml) { setWaterToday(getWaterToday() + ml); renderWater(); }
function resetWater() { setWaterToday(0); renderWater(); }

function renderWater() {
  const goals = getGoals();
  const ml = getWaterToday();
  const pct = Math.min(100, Math.round(ml / goals.water * 100));
  document.getElementById('water-text').textContent = `${ml} / ${goals.water} мл`;
  document.getElementById('water-fill').style.width = pct + '%';
}

// ── Meals / History ───────────────────────────────────────────────────────────
function getTodayMeals() {
  return (JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')).filter(m => m.date === getTodayKey());
}

function saveMeal(data) {
  const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  const now = new Date();
  history.push({
    id: now.getTime(),
    date: getTodayKey(),
    time: now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
    total_calories: Math.round(data.total_calories || 0),
    protein: Math.round((data.protein || 0) * 10) / 10,
    fat:     Math.round((data.fat     || 0) * 10) / 10,
    carbs:   Math.round((data.carbs   || 0) * 10) / 10,
    description: data.description || '',
    dishes: data.dishes || []
  });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  renderDiary();
}

function deleteMeal(id) {
  const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.filter(m => m.id !== id)));
  renderDiary();
}

function clearTodayHistory() {
  const today = getTodayKey();
  const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.filter(m => m.date !== today)));
  renderDiary();
}

// ── Diary tab render ──────────────────────────────────────────────────────────
function renderDiary() {
  renderProgress();
  renderHistory();
  renderWater();
}

function renderProgress() {
  const goals = getGoals();
  const meals = getTodayMeals();
  const t = meals.reduce((a, m) => ({
    cal:     a.cal     + m.total_calories,
    protein: a.protein + m.protein,
    fat:     a.fat     + m.fat,
    carbs:   a.carbs   + m.carbs
  }), { cal: 0, protein: 0, fat: 0, carbs: 0 });

  const items = [
    { key: 'cal',     label: 'ккал', goal: goals.cal     },
    { key: 'protein', label: 'г',    goal: goals.protein  },
    { key: 'fat',     label: 'г',    goal: goals.fat      },
    { key: 'carbs',   label: 'г',    goal: goals.carbs    },
  ];
  items.forEach(({ key, label, goal }) => {
    const val = Math.round(t[key] || 0);
    const pct = Math.min(100, Math.round(val / (goal || 1) * 100));
    document.getElementById(`prog-${key}-text`).textContent = `${val} / ${goal} ${label}`;
    document.getElementById(`prog-${key}-fill`).style.width = pct + '%';
  });
}

function renderHistory() {
  const meals = getTodayMeals();
  const list  = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');
  if (meals.length === 0) {
    empty.classList.remove('hidden');
    list.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  list.classList.remove('hidden');
  list.innerHTML = meals.map(m => `
    <li class="history-item">
      <div class="history-item-header">
        <span class="history-time">${m.time}</span>
        <span class="history-cal">${m.total_calories} ккал</span>
        <button class="btn-delete-meal" onclick="deleteMeal(${m.id})">✕</button>
      </div>
      <div class="history-macros">Б: ${m.protein}г · Ж: ${m.fat}г · У: ${m.carbs}г</div>
      <p class="history-desc">${m.description || (m.dishes || []).map(d => d.name).join(', ')}</p>
    </li>
  `).join('');
}

// ── Weight tracker ────────────────────────────────────────────────────────────
function getWeightLog() {
  return JSON.parse(localStorage.getItem(WEIGHT_KEY) || '[]');
}

function saveWeight(kg) {
  const log = getWeightLog();
  log.push({ date: getTodayKey(), kg });
  localStorage.setItem(WEIGHT_KEY, JSON.stringify(log));
  renderWeight();
}

function deleteWeight(idx) {
  const log = getWeightLog();
  log.splice(idx, 1);
  localStorage.setItem(WEIGHT_KEY, JSON.stringify(log));
  renderWeight();
}

function renderWeight() {
  const log = getWeightLog();
  const emptyChart = document.getElementById('weight-empty');
  const logEmpty   = document.getElementById('weight-log-empty');
  const logList    = document.getElementById('weight-log-list');
  const canvas     = document.getElementById('weight-chart');

  if (log.length === 0) {
    emptyChart.classList.remove('hidden');
    logEmpty.classList.remove('hidden');
    logList.innerHTML = '';
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  emptyChart.classList.add('hidden');
  logEmpty.classList.add('hidden');

  const recent = log.slice(-30);
  logList.innerHTML = [...recent].reverse().map((entry, i) => {
    const originalIdx = log.length - 1 - i;
    return `<li class="weight-log-item">
      <span class="weight-log-date">${formatDate(entry.date)}</span>
      <span class="weight-log-kg">${entry.kg} кг</span>
      <button class="btn-delete-meal" onclick="deleteWeight(${originalIdx})">✕</button>
    </li>`;
  }).join('');

  drawWeightChart(canvas, recent);
}

function drawWeightChart(canvas, data) {
  if (data.length < 2) {
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const dpr  = window.devicePixelRatio || 1;
  const W    = canvas.offsetWidth || 300;
  const H    = 200;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const pad = { top: 20, right: 16, bottom: 28, left: 40 };
  const cW  = W - pad.left - pad.right;
  const cH  = H - pad.top  - pad.bottom;

  const weights = data.map(d => d.kg);
  const minW = Math.min(...weights) - 1;
  const maxW = Math.max(...weights) + 1;
  const xS = i  => pad.left + (i / (data.length - 1)) * cW;
  const yS = kg => pad.top  + (1 - (kg - minW) / (maxW - minW)) * cH;

  ctx.clearRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.font = '10px system-ui';
  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (i / 4) * cH;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    ctx.fillText((maxW - (i / 4) * (maxW - minW)).toFixed(1), pad.left - 4, y + 4);
  }

  // Fill area
  const grad = ctx.createLinearGradient(0, pad.top, 0, H - pad.bottom);
  grad.addColorStop(0, 'rgba(34,197,94,0.22)');
  grad.addColorStop(1, 'rgba(34,197,94,0)');
  ctx.beginPath();
  ctx.moveTo(xS(0), yS(data[0].kg));
  data.forEach((d, i) => ctx.lineTo(xS(i), yS(d.kg)));
  ctx.lineTo(xS(data.length - 1), H - pad.bottom);
  ctx.lineTo(xS(0), H - pad.bottom);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(xS(0), yS(data[0].kg));
  data.forEach((d, i) => ctx.lineTo(xS(i), yS(d.kg)));
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Dots
  data.forEach((d, i) => {
    ctx.beginPath();
    ctx.arc(xS(i), yS(d.kg), 4, 0, Math.PI * 2);
    ctx.fillStyle = '#16a34a';
    ctx.fill();
  });
}

// ── Tab navigation ────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabId = btn.dataset.tab;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(tabId).classList.add('active');
    if (tabId === 'tab-diary')  renderDiary();
    if (tabId === 'tab-weight') renderWeight();
    if (tabId === 'tab-goals')  renderGoalsForm();
  });
});

// ── Goals form ────────────────────────────────────────────────────────────────
function renderGoalsForm() {
  const g = getGoals();
  document.getElementById('goal-cal').value     = g.cal;
  document.getElementById('goal-protein').value = g.protein;
  document.getElementById('goal-fat').value     = g.fat;
  document.getElementById('goal-carbs').value   = g.carbs;
  document.getElementById('goal-water').value   = g.water;
}

document.getElementById('btn-save-goals').addEventListener('click', () => {
  const goals = {
    cal:     parseInt(document.getElementById('goal-cal').value)     || DEFAULT_GOALS.cal,
    protein: parseInt(document.getElementById('goal-protein').value) || DEFAULT_GOALS.protein,
    fat:     parseInt(document.getElementById('goal-fat').value)     || DEFAULT_GOALS.fat,
    carbs:   parseInt(document.getElementById('goal-carbs').value)   || DEFAULT_GOALS.carbs,
    water:   parseInt(document.getElementById('goal-water').value)   || DEFAULT_GOALS.water,
  };
  localStorage.setItem(GOALS_KEY, JSON.stringify(goals));
  const el = document.getElementById('goals-saved');
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2000);
});

// ── Weight input ──────────────────────────────────────────────────────────────
document.getElementById('btn-save-weight').addEventListener('click', () => {
  const val = parseFloat(document.getElementById('weight-input').value);
  if (!val || val < 30 || val > 300) return;
  saveWeight(val);
  document.getElementById('weight-input').value = '';
});

// ── Manual entry modal ────────────────────────────────────────────────────────
let manualData = null;

function openManualModal() {
  manualData = null;
  document.getElementById('manual-name').value   = '';
  document.getElementById('manual-weight').value = '';
  document.getElementById('manual-result').classList.add('hidden');
  document.getElementById('manual-loading').classList.add('hidden');
  document.getElementById('manual-error').classList.add('hidden');
  document.getElementById('modal-manual').classList.remove('hidden');
}

function closeManualModal() {
  document.getElementById('modal-manual').classList.add('hidden');
}

document.getElementById('btn-open-manual').addEventListener('click', openManualModal);
document.getElementById('modal-manual-close').addEventListener('click', closeManualModal);
document.getElementById('modal-manual').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeManualModal();
});

document.getElementById('btn-manual-calc').addEventListener('click', async () => {
  const name   = document.getElementById('manual-name').value.trim();
  const weight = parseFloat(document.getElementById('manual-weight').value);
  if (!name || !weight || weight <= 0) return;

  document.getElementById('manual-result').classList.add('hidden');
  document.getElementById('manual-error').classList.add('hidden');
  document.getElementById('manual-loading').classList.remove('hidden');
  document.getElementById('btn-manual-calc').disabled = true;

  try {
    const res  = await fetch('/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, weight, device_id: getDeviceId() })
    });
    const data = await res.json();
    if (res.status === 402) {
      closeManualModal();
      showPaywall(data.used, data.limit);
      return;
    }
    if (!res.ok) throw new Error(data.error || 'Ошибка сервера');

    manualData = { ...data, name, weight };

    document.getElementById('manual-result-cal').textContent =
      `${data.total_calories} ккал`;
    document.getElementById('manual-result-macros').textContent =
      `Б: ${data.protein}г · Ж: ${data.fat}г · У: ${data.carbs}г`;
    document.getElementById('manual-result-note').textContent = data.note || '';
    document.getElementById('manual-result').classList.remove('hidden');
  } catch (err) {
    document.getElementById('manual-error').textContent = err.message;
    document.getElementById('manual-error').classList.remove('hidden');
  } finally {
    document.getElementById('manual-loading').classList.add('hidden');
    document.getElementById('btn-manual-calc').disabled = false;
  }
});

document.getElementById('btn-manual-save').addEventListener('click', () => {
  if (!manualData) return;
  saveMeal({
    total_calories: manualData.total_calories,
    protein:        manualData.protein,
    fat:            manualData.fat,
    carbs:          manualData.carbs,
    description:    `${manualData.name} (${manualData.weight}г)`,
    dishes: [{ name: `${manualData.name} (${manualData.weight}г)`, calories: manualData.total_calories }]
  });
  closeManualModal();
});

// ── Barcode scanner ───────────────────────────────────────────────────────────
let html5QrCode = null;
let barcodeProductData = null;

document.getElementById('btn-open-barcode').addEventListener('click', () => {
  document.getElementById('modal-barcode').classList.remove('hidden');
  document.getElementById('barcode-result').classList.add('hidden');
  document.getElementById('barcode-error').classList.add('hidden');
  document.getElementById('barcode-hint').classList.remove('hidden');
  startBarcodeScanner();
});

document.getElementById('modal-barcode-close').addEventListener('click', closeBarcodeModal);

function closeBarcodeModal() {
  stopBarcodeScanner();
  document.getElementById('modal-barcode').classList.add('hidden');
  barcodeProductData = null;
}

function startBarcodeScanner() {
  if (html5QrCode) return;
  html5QrCode = new Html5Qrcode('barcode-reader');
  html5QrCode.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 250, height: 120 } },
    onBarcodeDetected,
    () => {}
  ).catch(err => {
    const el = document.getElementById('barcode-error');
    el.textContent = 'Нет доступа к камере: ' + err;
    el.classList.remove('hidden');
  });
}

function stopBarcodeScanner() {
  if (!html5QrCode) return;
  const scanner = html5QrCode;
  html5QrCode = null;
  try { scanner.stop().catch(() => {}); } catch (e) {}
  try { scanner.clear(); } catch (e) {}
}

function updateBarcodePreview() {
  if (!barcodeProductData) return;
  const portion = parseFloat(document.getElementById('barcode-portion').value) || 0;
  const r = portion / 100;
  const cal  = Math.round(barcodeProductData.cal100  * r);
  const prot = Math.round(barcodeProductData.prot100 * r * 10) / 10;
  const fat  = Math.round(barcodeProductData.fat100  * r * 10) / 10;
  const carb = Math.round(barcodeProductData.carbs100 * r * 10) / 10;
  document.getElementById('barcode-total-preview').textContent =
    portion ? `${cal} ккал · Б ${prot}г · Ж ${fat}г · У ${carb}г` : '—';
}

async function onBarcodeDetected(barcode) {
  stopBarcodeScanner();
  document.getElementById('barcode-hint').classList.add('hidden');
  const errorEl  = document.getElementById('barcode-error');
  const resultEl = document.getElementById('barcode-result');
  errorEl.classList.add('hidden');
  resultEl.classList.add('hidden');

  try {
    const res  = await fetch(`https://world.openfoodfacts.org/api/v2/product/${barcode}?fields=product_name,nutriments,product_quantity`);
    const json = await res.json();
    if (json.status !== 1 || !json.product) throw new Error('Продукт не найден в базе Open Food Facts');
    const p = json.product;
    const n = p.nutriments || {};
    barcodeProductData = {
      name:     p.product_name || 'Неизвестный продукт',
      cal100:   Math.round(n['energy-kcal_100g'] || n['energy-kcal'] || 0),
      prot100:  Math.round((n.proteins_100g      || 0) * 10) / 10,
      fat100:   Math.round((n.fat_100g           || 0) * 10) / 10,
      carbs100: Math.round((n.carbohydrates_100g || 0) * 10) / 10,
    };
    document.getElementById('barcode-product-name').textContent = barcodeProductData.name;
    document.getElementById('barcode-per100').textContent = 'на 100 г:';
    document.getElementById('barcode-cal').textContent     = `${barcodeProductData.cal100} ккал`;
    document.getElementById('barcode-protein').textContent = `Б: ${barcodeProductData.prot100}г`;
    document.getElementById('barcode-fat').textContent     = `Ж: ${barcodeProductData.fat100}г`;
    document.getElementById('barcode-carbs').textContent   = `У: ${barcodeProductData.carbs100}г`;

    const pkgInput = document.getElementById('barcode-package');
    const qty = parseFloat(p.product_quantity);
    pkgInput.value = qty > 0 ? qty : '';

    document.getElementById('barcode-portion').value = 100;
    updateBarcodePreview();
    resultEl.classList.remove('hidden');
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
}

document.getElementById('barcode-portion').addEventListener('input', updateBarcodePreview);
document.getElementById('barcode-package').addEventListener('input', () => {
  const pkg     = parseFloat(document.getElementById('barcode-package').value);
  const portion = parseFloat(document.getElementById('barcode-portion').value);
  if (pkg > 0 && !portion) document.getElementById('barcode-portion').value = pkg;
  updateBarcodePreview();
});

document.getElementById('btn-barcode-add').addEventListener('click', () => {
  if (!barcodeProductData) return;
  const portion = parseFloat(document.getElementById('barcode-portion').value) || 100;
  const r = portion / 100;
  saveMeal({
    total_calories: Math.round(barcodeProductData.cal100  * r),
    protein:        Math.round(barcodeProductData.prot100 * r * 10) / 10,
    fat:            Math.round(barcodeProductData.fat100  * r * 10) / 10,
    carbs:          Math.round(barcodeProductData.carbs100 * r * 10) / 10,
    description:    `${barcodeProductData.name} (${portion}г)`,
    dishes: [{ name: `${barcodeProductData.name} (${portion}г)`, calories: Math.round(barcodeProductData.cal100 * r) }]
  });
  closeBarcodeModal();
});

// ── Analyze image ─────────────────────────────────────────────────────────────
const dropZone       = document.getElementById('drop-zone');
const fileInput      = document.getElementById('file-input');
const previewArea    = document.getElementById('preview-area');
const previewImg     = document.getElementById('preview-img');
const btnRemove      = document.getElementById('btn-remove');
const btnAnalyze     = document.getElementById('btn-analyze');
const btnNew         = document.getElementById('btn-new');
const btnRetry       = document.getElementById('btn-retry');
const resultsSection = document.getElementById('results-section');
const loadingCard    = document.getElementById('loading-card');
const resultCard     = document.getElementById('result-card');
const errorCard      = document.getElementById('error-card');
const paywallCard    = document.getElementById('paywall-card');

let currentFile = null;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith('image/')) loadPreview(f);
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadPreview(fileInput.files[0]); });

function loadPreview(file) {
  if (file.size > MAX_FILE_SIZE) {
    resultsSection.classList.remove('hidden');
    hideAll();
    showError('Файл слишком большой', `Максимум — 10 МБ. Ваш файл: ${(file.size/1024/1024).toFixed(1)} МБ`);
    return;
  }
  currentFile = file;
  const reader = new FileReader();
  reader.onload = e => {
    previewImg.src = e.target.result;
    dropZone.classList.add('hidden');
    previewArea.classList.remove('hidden');
    resultsSection.classList.add('hidden');
    hideAll();
  };
  reader.readAsDataURL(file);
}

btnRemove.addEventListener('click', resetUI);
btnNew.addEventListener('click', resetUI);
btnRetry.addEventListener('click', resetUI);

function resetUI() {
  currentFile = null;
  previewImg.src = '';
  fileInput.value = '';
  previewArea.classList.add('hidden');
  dropZone.classList.remove('hidden');
  resultsSection.classList.add('hidden');
  hideAll();
}

function hideAll() {
  loadingCard.classList.add('hidden');
  resultCard.classList.add('hidden');
  errorCard.classList.add('hidden');
  paywallCard.classList.add('hidden');
}

btnAnalyze.addEventListener('click', analyzeImage);

async function analyzeImage() {
  if (!currentFile) return;
  btnAnalyze.disabled = true;
  resultsSection.classList.remove('hidden');
  loadingCard.classList.remove('hidden');
  resultCard.classList.add('hidden');
  errorCard.classList.add('hidden');
  paywallCard.classList.add('hidden');
  try {
    const base64   = await resizeImage(currentFile);
    const response = await fetch('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64, mime_type: 'image/jpeg', device_id: getDeviceId() })
    });
    const data = await response.json();
    if (response.status === 402) {
      showPaywall(data.used, data.limit);
      return;
    }
    if (!response.ok) throw new Error(data.error || 'Ошибка сервера');
    saveMeal(data);
    showResult(data);
  } catch (err) {
    showError('Не удалось выполнить анализ', err.message);
  } finally {
    btnAnalyze.disabled = false;
    loadingCard.classList.add('hidden');
  }
}

const RESIZE_MAX_DIMENSION = 1568;
const RESIZE_JPEG_QUALITY  = 0.85;

function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const scale  = Math.min(1, RESIZE_MAX_DIMENSION / Math.max(img.width, img.height));
        const width  = Math.round(img.width * scale);
        const height = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width  = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', RESIZE_JPEG_QUALITY).split(',')[1]);
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function showResult(data) {
  document.getElementById('calories-number').textContent = data.total_calories ?? '—';
  document.getElementById('val-protein').textContent     = data.protein ?? '—';
  document.getElementById('val-fat').textContent         = data.fat     ?? '—';
  document.getElementById('val-carbs').textContent       = data.carbs   ?? '—';
  document.getElementById('result-description').textContent = data.description ?? '';
  const dl = document.getElementById('dishes-list');
  dl.innerHTML = '';
  (data.dishes || []).forEach(d => {
    const li = document.createElement('li');
    li.className = 'dish-item';
    li.innerHTML = `<span class="dish-name">${d.name}</span><span class="dish-calories">${d.calories} ккал</span>`;
    dl.appendChild(li);
  });
  resultCard.classList.remove('hidden');
}

function showError(title, message) {
  document.getElementById('error-title').textContent   = title;
  document.getElementById('error-message').textContent = message;
  errorCard.classList.remove('hidden');
}

// ── Paywall ───────────────────────────────────────────────────────────────────
function showPaywall(used, limit) {
  resultsSection.classList.remove('hidden');
  hideAll();
  document.getElementById('paywall-used').textContent  = used ?? '';
  document.getElementById('paywall-limit').textContent = limit ?? '';
  document.getElementById('paywall-price').textContent = `${SUBSCRIPTION_PRICE_RUB} ₽ / 30 дней безлимита`;
  document.getElementById('paywall-device-id').textContent = getDeviceId();
  document.getElementById('promo-input').value = '';
  document.getElementById('promo-message').classList.add('hidden');
  paywallCard.classList.remove('hidden');
}

document.getElementById('btn-promo-apply').addEventListener('click', async () => {
  const code = document.getElementById('promo-input').value.trim();
  const msgEl = document.getElementById('promo-message');
  if (!code) return;
  try {
    const res  = await fetch('/promo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: getDeviceId(), code })
    });
    const data = await res.json();
    msgEl.textContent = res.ok ? 'Промокод применён — лимит увеличен!' : (data.error || 'Не удалось применить промокод');
    msgEl.classList.toggle('promo-message-error', !res.ok);
    msgEl.classList.remove('hidden');
  } catch (err) {
    msgEl.textContent = 'Ошибка сети, попробуйте ещё раз';
    msgEl.classList.add('promo-message-error');
    msgEl.classList.remove('hidden');
  }
});

document.getElementById('btn-paywall-buy').addEventListener('click', () => {
  fetch('/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: getDeviceId(), type: 'buy_click' })
  }).catch(() => {});
  window.open(PAYMENT_LINK, '_blank');
});

document.getElementById('btn-clear-history').addEventListener('click', clearTodayHistory);

// ── Init ──────────────────────────────────────────────────────────────────────
renderDiary();
renderGoalsForm();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
