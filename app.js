const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const previewArea = document.getElementById('preview-area');
const previewImg = document.getElementById('preview-img');
const btnRemove = document.getElementById('btn-remove');
const btnAnalyze = document.getElementById('btn-analyze');
const btnNew = document.getElementById('btn-new');
const btnRetry = document.getElementById('btn-retry');
const uploadSection = document.getElementById('upload-section');
const resultsSection = document.getElementById('results-section');
const loadingCard = document.getElementById('loading-card');
const resultCard = document.getElementById('result-card');
const errorCard = document.getElementById('error-card');

let currentFile = null;

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// Drag & drop
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) loadPreview(file);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) loadPreview(fileInput.files[0]);
});

function loadPreview(file) {
  if (file.size > MAX_FILE_SIZE) {
    resultsSection.classList.remove('hidden');
    hideAll();
    showError('Файл слишком большой', `Максимальный размер — 10 МБ. Ваш файл: ${(file.size / 1024 / 1024).toFixed(1)} МБ`);
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

btnRemove.addEventListener('click', () => {
  currentFile = null;
  previewImg.src = '';
  fileInput.value = '';
  previewArea.classList.add('hidden');
  dropZone.classList.remove('hidden');
  resultsSection.classList.add('hidden');
  hideAll();
});

btnAnalyze.addEventListener('click', analyzeImage);
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
}

async function analyzeImage() {
  if (!currentFile) return;

  btnAnalyze.disabled = true;
  resultsSection.classList.remove('hidden');
  loadingCard.classList.remove('hidden');
  resultCard.classList.add('hidden');
  errorCard.classList.add('hidden');

  try {
    const base64 = await toBase64(currentFile);
    const response = await fetch('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: base64,
        mime_type: currentFile.type
      })
    });

    const data = await response.json();
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

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const b64 = e.target.result.split(',')[1];
      resolve(b64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function showResult(data) {
  document.getElementById('calories-number').textContent = data.total_calories ?? '—';
  document.getElementById('val-protein').textContent = data.protein ?? '—';
  document.getElementById('val-fat').textContent = data.fat ?? '—';
  document.getElementById('val-carbs').textContent = data.carbs ?? '—';
  document.getElementById('result-description').textContent = data.description ?? '';

  const dishesList = document.getElementById('dishes-list');
  dishesList.innerHTML = '';
  if (data.dishes && data.dishes.length) {
    data.dishes.forEach(d => {
      const li = document.createElement('li');
      li.className = 'dish-item';
      li.innerHTML = `<span class="dish-name">${d.name}</span><span class="dish-calories">${d.calories} ккал</span>`;
      dishesList.appendChild(li);
    });
  }

  resultCard.classList.remove('hidden');
}

function showError(title, message) {
  document.getElementById('error-title').textContent = title;
  document.getElementById('error-message').textContent = message;
  errorCard.classList.remove('hidden');
}

// ── История питания ──────────────────────────────────────────────────────────

const HISTORY_KEY = 'kalorikan_history';

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function saveMeal(data) {
  const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  const now = new Date();
  history.push({
    id: now.getTime(),
    date: getTodayKey(),
    time: now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
    total_calories: data.total_calories || 0,
    protein: data.protein || 0,
    fat: data.fat || 0,
    carbs: data.carbs || 0,
    description: data.description || '',
    dishes: data.dishes || []
  });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  renderHistory();
}

function deleteMeal(id) {
  const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.filter(m => m.id !== id)));
  renderHistory();
}

function clearTodayHistory() {
  const today = getTodayKey();
  const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.filter(m => m.date !== today)));
  renderHistory();
}

function renderHistory() {
  const today = getTodayKey();
  const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  const meals = history.filter(m => m.date === today);

  const section = document.getElementById('history-section');
  const list = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');
  const totalEl = document.getElementById('history-daily-total');

  if (meals.length === 0) {
    empty.classList.remove('hidden');
    list.classList.add('hidden');
    totalEl.classList.add('hidden');
    return;
  }

  empty.classList.add('hidden');
  list.classList.remove('hidden');
  totalEl.classList.remove('hidden');

  const totals = meals.reduce((acc, m) => ({
    calories: acc.calories + m.total_calories,
    protein: acc.protein + m.protein,
    fat: acc.fat + m.fat,
    carbs: acc.carbs + m.carbs
  }), { calories: 0, protein: 0, fat: 0, carbs: 0 });

  totalEl.innerHTML = `
    <span class="daily-cal">${totals.calories} ккал</span>
    <span class="daily-macros">Б: ${totals.protein}г · Ж: ${totals.fat}г · У: ${totals.carbs}г</span>
  `;

  list.innerHTML = meals.map(m => `
    <li class="history-item">
      <div class="history-item-header">
        <span class="history-time">${m.time}</span>
        <span class="history-cal">${m.total_calories} ккал</span>
        <button class="btn-delete-meal" onclick="deleteMeal(${m.id})" title="Удалить">✕</button>
      </div>
      <p class="history-desc">${m.description || m.dishes.map(d => d.name).join(', ')}</p>
    </li>
  `).join('');
}

document.getElementById('btn-clear-history').addEventListener('click', clearTodayHistory);

renderHistory();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}
