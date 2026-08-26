const DEFAULT_LYRICS_SETTINGS = {
  width: 760,
  height: 240,
  backgroundOpacity: 94,
  fontSize: 16,
  showProgressBar: true,
  showPlaybackControls: true,
  showPreviousButton: true,
  showPauseButton: true,
  showNextButton: true,
  showTrackInfo: true,
  showAlbumArt: true,
  showStatus: true,
  alwaysOnTop: true,
};

let settings = { ...DEFAULT_LYRICS_SETTINGS };

const numberInputs = {
  width: document.getElementById('setting-width'),
  height: document.getElementById('setting-height'),
};
const rangeInputs = {
  backgroundOpacity: document.getElementById('setting-opacity'),
  fontSize: document.getElementById('setting-font-size'),
};
const rangeOutputs = {
  backgroundOpacity: document.getElementById('setting-opacity-value'),
  fontSize: document.getElementById('setting-font-size-value'),
};
const toggleInputs = {
  showProgressBar: document.getElementById('setting-progress'),
  showPlaybackControls: document.getElementById('setting-playback'),
  showPreviousButton: document.getElementById('setting-previous'),
  showPauseButton: document.getElementById('setting-pause'),
  showNextButton: document.getElementById('setting-next'),
  showTrackInfo: document.getElementById('setting-track-info'),
  showAlbumArt: document.getElementById('setting-cover'),
  showStatus: document.getElementById('setting-status'),
  alwaysOnTop: document.getElementById('setting-topmost'),
};

function applySettings(next) {
  settings = { ...settings, ...(next || {}) };
  for (const [key, input] of Object.entries(numberInputs)) input.value = settings[key];
  for (const [key, input] of Object.entries(rangeInputs)) {
    input.value = settings[key];
    rangeOutputs[key].textContent = key === 'fontSize' ? `${settings[key]}px` : `${settings[key]}%`;
  }
  for (const [key, input] of Object.entries(toggleInputs)) input.checked = !!settings[key];
}

function savePatch(patch) {
  const next = { ...settings, ...patch };
  applySettings(next);
  window.lyricsOverlay.saveSettings(next).catch(() => {});
}

for (const [key, input] of Object.entries(numberInputs)) {
  input.addEventListener('change', () => {
    const value = Number(input.value);
    if (Number.isFinite(value)) savePatch({ [key]: value });
    else applySettings(settings);
  });
}

for (const [key, input] of Object.entries(rangeInputs)) {
  input.addEventListener('input', () => savePatch({ [key]: Number(input.value) }));
}

for (const [key, input] of Object.entries(toggleInputs)) {
  input.addEventListener('change', () => savePatch({ [key]: input.checked }));
}

document.getElementById('settings-reset').addEventListener('click', () => {
  window.lyricsOverlay.saveSettings(DEFAULT_LYRICS_SETTINGS).then(applySettings).catch(() => {});
});

document.getElementById('settings-close').addEventListener('click', () => window.lyricsOverlay.closeSettings());
window.lyricsOverlay.onSettings(applySettings);
window.lyricsOverlay.getSettings().then(applySettings).catch(() => applySettings(settings));
