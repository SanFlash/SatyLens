// extension/selector/selector.js
// Content script injected on every http(s) page (see manifest.json).
// Stays completely dormant until the background service worker sends
// an ACTIVATE_AREA_SELECT message, so it has near-zero footprint normally.

(function () {
  let root = null;
  let box = null;
  let dimsLabel = null;
  let toolbar = null;
  let startX = 0;
  let startY = 0;
  let currentRect = null;
  let dragging = false;

  function buildOverlay() {
    root = document.createElement('div');
    root.id = 'satylens-overlay-root';

    toolbar = document.createElement('div');
    toolbar.className = 'cf-toolbar';
    toolbar.innerHTML = `
      <span>Drag to select an area · Esc to cancel</span>
      <button class="cf-btn-cancel" type="button">Cancel</button>
      <button class="cf-btn-capture" type="button" disabled>Capture</button>
    `;

    box = document.createElement('div');
    box.className = 'cf-selection-box';
    dimsLabel = document.createElement('div');
    dimsLabel.className = 'cf-dims-label';
    box.appendChild(dimsLabel);

    root.appendChild(box);
    root.appendChild(toolbar);
    document.documentElement.appendChild(root);

    toolbar.querySelector('.cf-btn-cancel').addEventListener('click', teardown);
    toolbar.querySelector('.cf-btn-capture').addEventListener('click', confirmSelection);

    root.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
  }

  function onMouseDown(e) {
    if (e.target.closest('.cf-toolbar')) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    box.style.display = 'block';
    updateBox(startX, startY, startX, startY);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  }

  function onMouseMove(e) {
    if (!dragging) return;
    updateBox(startX, startY, e.clientX, e.clientY);
  }

  function onMouseUp() {
    dragging = false;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    const captureBtn = toolbar.querySelector('.cf-btn-capture');
    captureBtn.disabled = !currentRect || currentRect.width < 4 || currentRect.height < 4;
  }

  function updateBox(x1, y1, x2, y2) {
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);
    currentRect = { left, top, width, height };
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
    dimsLabel.textContent = `${Math.round(width)} × ${Math.round(height)}`;
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') teardown();
  }

  function confirmSelection() {
    if (!currentRect || currentRect.width < 4 || currentRect.height < 4) return;
    const payload = {
      action: 'AREA_SELECTED',
      rect: currentRect,
      devicePixelRatio: window.devicePixelRatio || 1,
      pageUrl: location.href
    };
    teardown();
    chrome.runtime.sendMessage(payload);
  }

  function teardown() {
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    currentRect = null;
    chrome.runtime.sendMessage({ action: 'AREA_SELECT_CANCELLED' });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'ACTIVATE_AREA_SELECT') {
      if (!root) buildOverlay();
      sendResponse({ ok: true });
    }
    if (message.action === 'GET_PAGE_METRICS') {
      // Used for full-page capture: total scrollable size + current viewport.
      sendResponse({
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
        scrollX: window.scrollX,
        scrollY: window.scrollY
      });
    }
    if (message.action === 'SCROLL_TO') {
      window.scrollTo(message.x, message.y);
      // Give the page a moment to repaint (lazy-loaded images, sticky headers).
      setTimeout(() => sendResponse({ ok: true }), 120);
      return true; // keep the message channel open for the async response
    }
    return undefined;
  });
})();
