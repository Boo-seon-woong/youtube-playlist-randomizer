// 설정 팝업: 값은 main이 소유한다(lyrics-settings.json). 여기서는 읽어서 그리고, 바뀌면 저장을 요청할 뿐이다.
let settings = {};
const controls = [...document.querySelectorAll('[data-key]')];

function paint(next) {
  settings = { ...settings, ...(next || {}) };
  for (const el of controls) {
    const key = el.dataset.key;
    if (el.type === 'checkbox') el.checked = !!settings[key];
    else if (settings[key] != null) el.value = settings[key];
    const out = document.getElementById(`v-${key}`);
    if (out) out.textContent = key === 'fontSize' ? `${settings[key]}px` : key === 'width' || key === 'height' ? `${settings[key]}px` : `${settings[key]}%`;
  }
}

function save(patch) {
  paint(patch);
  window.lyricsOverlay.saveSettings(settings).then(paint).catch(() => {});
}

for (const el of controls) {
  const key = el.dataset.key;
  if (el.type === 'checkbox') el.addEventListener('change', () => save({ [key]: el.checked }));
  else if (el.tagName === 'SELECT') el.addEventListener('change', () => save({ [key]: el.value }));
  else el.addEventListener('input', () => save({ [key]: Number(el.value) })); // 슬라이더는 드래그 중 실시간 반영
}

// ── 레이아웃 프리셋 ──
const presetList = document.getElementById('preset-list');
const presetName = document.getElementById('preset-name');
const presetStatus = document.getElementById('preset-status');
const presetApply = document.getElementById('preset-apply');
const presetDelete = document.getElementById('preset-delete');

function paintPresets(names, select) {
  presetList.replaceChildren();
  if (!names || names.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = '저장된 프리셋 없음';
    opt.value = '';
    presetList.append(opt);
  } else {
    for (const name of names) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      presetList.append(opt);
    }
    if (select && names.includes(select)) presetList.value = select;
  }
  const empty = !names || names.length === 0;
  presetApply.disabled = empty;
  presetDelete.disabled = empty;
}

const say = (text) => { presetStatus.textContent = text; };

document.getElementById('preset-save').addEventListener('click', async () => {
  const name = presetName.value.trim();
  const r = await window.lyricsOverlay.presets.save(name).catch(() => null);
  if (!r) return say('저장에 실패했습니다');
  paintPresets(r.names, name);
  if (!r.ok) return say(r.error);
  presetName.value = '';
  say(`'${name}' 저장됨`);
});
presetName.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('preset-save').click(); });
presetApply.addEventListener('click', async () => {
  const name = presetList.value;
  if (!name) return;
  const next = await window.lyricsOverlay.presets.apply(name).catch(() => null);
  if (next) { paint(next); say(`'${name}' 적용됨`); }
});
presetDelete.addEventListener('click', async () => {
  const name = presetList.value;
  if (!name) return;
  const names = await window.lyricsOverlay.presets.remove(name).catch(() => null);
  if (names) { paintPresets(names); say(`'${name}' 삭제됨`); }
});
window.lyricsOverlay.presets.list().then((names) => paintPresets(names)).catch(() => paintPresets([]));

document.getElementById('ls-reset').addEventListener('click', () => {
  window.lyricsOverlay.resetSettings().then(paint).catch(() => {});
});
document.getElementById('ls-close').addEventListener('click', () => window.lyricsOverlay.closeSettings());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.lyricsOverlay.closeSettings(); });

// 메인 앱 테마 색을 따른다 (포인트 색 → 슬라이더·체크박스, 패널 색 → 카드 배경)
function applyTheme(theme) {
  if (!theme) return;
  const root = document.documentElement.style;
  if (theme.accent) root.setProperty('--accent', theme.accent);
  if (theme.panel) {
    const n = parseInt(String(theme.panel).replace('#', ''), 16);
    if (Number.isFinite(n)) {
      const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      root.setProperty('--bg', `rgba(${r}, ${g}, ${b}, 0.96)`);
      root.setProperty('--bg-2', `rgba(${Math.max(0, r - 8)}, ${Math.max(0, g - 8)}, ${Math.max(0, b - 8)}, 0.9)`);
    }
  }
}
window.lyricsOverlay.onTheme(applyTheme);
window.lyricsOverlay.getTheme().then(applyTheme).catch(() => {});

window.lyricsOverlay.onSettings(paint);
window.lyricsOverlay.getSettings().then(paint).catch(() => {});
