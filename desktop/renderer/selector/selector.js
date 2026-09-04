// desktop/renderer/selector/selector.js
// Runs inside the fullscreen transparent overlay BrowserWindow that
// main.js's start-area-select IPC handler creates. Reports the selected
// rectangle (in logical/CSS screen pixels) back to the main process via
// window.satylens.sendAreaSelectResult, which resolves the caller's
// promise in home.js. This is the desktop equivalent of the extension's
// content-script overlay -- same drag-select interaction, different
// transport (IPC instead of chrome.runtime.sendMessage) since there's no
// "inject into a web page" step needed; this overlay IS its own window.
(function () {
  const box = document.getElementById('box');
  const dimsLabel = document.getElementById('dimsLabel');
  const cancelBtn = document.getElementById('cancelBtn');
  const captureBtn = document.getElementById('captureBtn');

  let startX = 0;
  let startY = 0;
  let currentRect = null;
  let dragging = false;

  function updateBox(x1, y1, x2, y2) {
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);
    currentRect = { x: left, y: top, w: width, h: height };
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
    dimsLabel.textContent = `${Math.round(width)} × ${Math.round(height)}`;
  }

  document.getElementById('root').addEventListener('mousedown', (e) => {
    if (e.target.closest('.toolbar')) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    box.style.display = 'block';
    updateBox(startX, startY, startX, startY);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  });

  function onMouseMove(e) {
    if (!dragging) return;
    updateBox(startX, startY, e.clientX, e.clientY);
  }

  function onMouseUp() {
    dragging = false;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    captureBtn.disabled = !currentRect || currentRect.w < 4 || currentRect.h < 4;
  }

  function confirmSelection() {
    if (!currentRect || currentRect.w < 4 || currentRect.h < 4) return;
    window.satylens.sendAreaSelectResult(currentRect);
  }

  function cancel() {
    window.satylens.sendAreaSelectResult(null);
  }

  cancelBtn.addEventListener('click', cancel);
  captureBtn.addEventListener('click', confirmSelection);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancel();
  });
})();
