const sel = document.getElementById('scale');
const fullWidthCb = document.getElementById('fullWidth');

chrome.storage.sync.get({ scale: '2', fullWidth: false }, ({ scale, fullWidth }) => {
  sel.value = scale;
  fullWidthCb.checked = fullWidth;
});

sel.addEventListener('change', () => {
  chrome.storage.sync.set({ scale: sel.value });
});

fullWidthCb.addEventListener('change', () => {
  chrome.storage.sync.set({ fullWidth: fullWidthCb.checked });
});

function formatMB(bytes) {
  if (bytes === 0) return '0 MB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: 'getCacheStats' }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      document.getElementById('count').textContent = '0';
      document.getElementById('ram').textContent = '0 MB';
      return;
    }
    document.getElementById('count').textContent = resp.count;
    document.getElementById('ram').textContent = formatMB(resp.bytes);
  });
});