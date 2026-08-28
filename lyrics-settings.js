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

document.getElementById('ls-reset').addEventListener('click', () => {
  window.lyricsOverlay.resetSettings().then(paint).catch(() => {});
});
document.getElementById('ls-close').addEventListener('click', () => window.lyricsOverlay.closeSettings());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.lyricsOverlay.closeSettings(); });

window.lyricsOverlay.onSettings(paint);
window.lyricsOverlay.getSettings().then(paint).catch(() => {});
