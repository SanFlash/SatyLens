// extension/editor/editor.js
// Canvas-based annotation editor. Objects are kept as independent, editable
// entities (not baked into pixels) until an explicit destructive operation
// (crop / rotate / resize image) bakes the composite into a new base image.

import { CaptureStore } from '../shared/storage.js';
import { copyTextToClipboard } from '../shared/clipboard.js';
import { createShareLink, getUploadDestination } from '../shared/share.js';
import { track } from '../shared/analytics.js';
import { uuid, timestampForFilename, generateImageThumbnail } from '../shared/utils.js';

const $ = (sel) => document.querySelector(sel);
const canvas = $('#editorCanvas');
// `ctx` is intentionally reassignable: renderComposite() briefly points it at
// an offscreen context so every draw* helper below (which all close over
// this module-level binding) can be reused for both on-screen rendering and
// off-screen export/crop/rotate/resize without duplicating any drawing code.
let ctx = canvas.getContext('2d');
const stage = $('#canvasStage');
const scrollWrap = $('#canvasScroll');
const textOverlay = $('#textEditOverlay');

const params = new URLSearchParams(location.search);
const captureId = params.get('id');

/* ============================== State ============================== */

const state = {
  capture: null,
  imageVersions: [], // [{dataUrl, width, height}]
  currentImageVersion: 0,
  history: [], // [{imageVersionIndex, objects: [...serializable]}]
  historyIndex: -1,
  objects: [], // live objects for current history entry
  selectedId: null,
  tool: 'select',
  zoom: 1,
  isDirty: false,
  imageCache: new Map(), // src -> HTMLImageElement (for imported assets)
  baseImageEl: null, // current decoded base image element
  interaction: null, // in-progress pointer interaction descriptor
  cropRect: null // {x,y,w,h} in image space, while crop tool active
};

const HISTORY_LIMIT = 40;
const HANDLE_SIZE = 9;
const ROTATE_HANDLE_OFFSET = 28;

/* ============================== Init ============================== */

async function init() {
  if (!captureId) {
    showToast('No screenshot was passed to the editor.', true);
    return;
  }
  const capture = await CaptureStore.get(captureId);
  if (!capture || capture.type !== 'screenshot') {
    showToast('This capture could not be opened for editing.', true);
    return;
  }
  state.capture = capture;
  $('#titleInput').value = capture.name.replace(/\.[a-z0-9]+$/i, '');

  const dataUrl = await blobToDataUrl(capture.blob);
  const img = await loadImage(dataUrl);

  pushImageVersion(dataUrl, img.naturalWidth, img.naturalHeight);
  pushHistory([], true);
  state.baseImageEl = img;

  sizeCanvasToImage();
  fitZoom();
  render();
  updateUndoRedoButtons();
  bindEvents();
  setActiveTool('select');
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function getCachedImage(src) {
  if (state.imageCache.has(src)) return state.imageCache.get(src);
  const img = new Image();
  img.src = src;
  state.imageCache.set(src, img);
  return img;
}

/* ============================== Image versions & history ============================== */

function pushImageVersion(dataUrl, width, height) {
  state.imageVersions.push({ dataUrl, width, height });
  state.currentImageVersion = state.imageVersions.length - 1;
}

function cloneObjectsForHistory(objects) {
  return JSON.parse(JSON.stringify(objects));
}

function pushHistory(objects, isNewImageVersion = false) {
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push({
    imageVersionIndex: state.currentImageVersion,
    objects: cloneObjectsForHistory(objects)
  });
  if (state.history.length > HISTORY_LIMIT) {
    state.history.shift();
  }
  state.historyIndex = state.history.length - 1;
  state.objects = objects;
  state.isDirty = true;
  updateUndoRedoButtons();
}

async function applyHistoryEntry(entry) {
  if (entry.imageVersionIndex !== state.currentImageVersion) {
    state.currentImageVersion = entry.imageVersionIndex;
    const version = state.imageVersions[entry.imageVersionIndex];
    state.baseImageEl = await loadImage(version.dataUrl);
    sizeCanvasToImage();
  }
  state.objects = cloneObjectsForHistory(entry.objects);
  state.selectedId = null;
  render();
  updatePropertyPanel();
  updateLayersPanel();
}

async function undo() {
  if (state.historyIndex <= 0) return;
  state.historyIndex -= 1;
  await applyHistoryEntry(state.history[state.historyIndex]);
  updateUndoRedoButtons();
}

async function redo() {
  if (state.historyIndex >= state.history.length - 1) return;
  state.historyIndex += 1;
  await applyHistoryEntry(state.history[state.historyIndex]);
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  $('#undoBtn').disabled = state.historyIndex <= 0;
  $('#redoBtn').disabled = state.historyIndex >= state.history.length - 1;
}

function commitObjects(nextObjects) {
  pushHistory(nextObjects, false);
}

/* ============================== Canvas sizing / zoom ============================== */

function sizeCanvasToImage() {
  const version = state.imageVersions[state.currentImageVersion];
  canvas.width = version.width;
  canvas.height = version.height;
  applyZoom();
}

function applyZoom() {
  stage.style.width = canvas.width + 'px';
  stage.style.height = canvas.height + 'px';
  stage.style.transform = `scale(${state.zoom})`;
  $('#zoomLabel').textContent = Math.round(state.zoom * 100) + '%';
}

function fitZoom() {
  const wrapRect = scrollWrap.getBoundingClientRect();
  const availW = wrapRect.width - 80;
  const availH = wrapRect.height - 80;
  const scale = Math.min(1, availW / canvas.width, availH / canvas.height);
  state.zoom = Math.max(0.1, scale);
  applyZoom();
}

function zoomBy(factor) {
  state.zoom = Math.min(4, Math.max(0.1, state.zoom * factor));
  applyZoom();
}

/* ============================== Coordinate helpers ============================== */

function screenToImage(evt) {
  const rect = canvas.getBoundingClientRect();
  const x = (evt.clientX - rect.left) / state.zoom;
  const y = (evt.clientY - rect.top) / state.zoom;
  return { x, y };
}

/* ============================== Object factory ============================== */

function currentShapeStyle() {
  return {
    strokeColor: $('#strokeColor').value,
    strokeWidth: Number($('#strokeWidth').value),
    fillColor: $('#fillColor').value,
    fillOpacity: Number($('#fillOpacity').value) / 100,
    cornerRadius: Number($('#cornerRadius').value),
    shadow: $('#shadowToggle').checked
  };
}

function currentTextStyle() {
  return {
    fontFamily: $('#fontFamily').value,
    fontSize: Number($('#fontSize').value),
    bold: $('#fontBold').classList.contains('active'),
    italic: $('#fontItalic').classList.contains('active'),
    underline: $('#fontUnderline').classList.contains('active'),
    align: document.querySelector('[data-align].active')?.dataset.align || 'left',
    color: $('#textColor').value,
    bgColor: $('#textBgColor').value,
    bgOpacity: Number($('#textBgOpacity').value) / 100
  };
}

function currentHighlightStyle() {
  return {
    color: $('#highlightColor').value,
    opacity: Number($('#highlightOpacity').value) / 100,
    solid: $('#highlightSolid').checked
  };
}

function currentRedactIntensity() {
  return Number($('#redactIntensity').value);
}

function newObjectId() {
  return 'o_' + Math.random().toString(36).slice(2, 10);
}

/* ============================== Rendering ============================== */

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (state.baseImageEl) {
    ctx.drawImage(state.baseImageEl, 0, 0, canvas.width, canvas.height);
  }

  for (const obj of state.objects) {
    if (state.interaction && state.interaction.editingTextId === obj.id) continue;
    drawObject(obj);
  }

  if (state.interaction && state.interaction.previewObject) {
    drawObject(state.interaction.previewObject);
  }

  const selected = state.objects.find((o) => o.id === state.selectedId);
  if (selected) drawSelectionHandles(selected);

  if (state.tool === 'crop' && state.cropRect) {
    drawCropOverlay(state.cropRect);
  }
}

function withObjectTransform(obj, fn) {
  ctx.save();
  if (obj.rotation) {
    const cx = obj.x + obj.w / 2;
    const cy = obj.y + obj.h / 2;
    ctx.translate(cx, cy);
    ctx.rotate(obj.rotation);
    ctx.translate(-cx, -cy);
  }
  fn();
  ctx.restore();
}

function drawObject(obj) {
  switch (obj.type) {
    case 'text':
      return withObjectTransform(obj, () => drawText(obj));
    case 'rect':
    case 'roundrect':
      return withObjectTransform(obj, () => drawRect(obj));
    case 'circle':
      return withObjectTransform(obj, () => drawCircle(obj));
    case 'image':
      return withObjectTransform(obj, () => drawImageObj(obj));
    case 'line':
      return drawLine(obj, false);
    case 'arrow':
      return drawLine(obj, true);
    case 'freehand':
      return drawFreehand(obj);
    case 'highlight-rect':
      return withObjectTransform(obj, () => drawHighlightRect(obj));
    case 'highlight-free':
      return drawFreehand(obj, true);
    case 'blur':
      return drawBlurRegion(obj, 'blur');
    case 'pixelate':
      return drawBlurRegion(obj, 'pixelate');
    default:
      return;
  }
}

function drawText(obj) {
  const { x, y, w, h } = obj;
  if (obj.bgOpacity > 0) {
    ctx.fillStyle = hexToRgba(obj.bgColor, obj.bgOpacity);
    ctx.fillRect(x, y, w, h);
  }
  let fontStr = '';
  if (obj.italic) fontStr += 'italic ';
  if (obj.bold) fontStr += '700 ';
  fontStr += `${obj.fontSize}px ${obj.fontFamily}`;
  ctx.font = fontStr;
  ctx.fillStyle = obj.color;
  ctx.textBaseline = 'top';
  ctx.textAlign = obj.align === 'center' ? 'center' : obj.align === 'right' ? 'right' : 'left';

  const lines = (obj.text || '').split('\n');
  const lineHeight = obj.fontSize * 1.25;
  const tx = obj.align === 'center' ? x + w / 2 : obj.align === 'right' ? x + w : x;

  lines.forEach((line, i) => {
    const ly = y + i * lineHeight;
    ctx.fillText(line, tx, ly);
    if (obj.underline) {
      const width = ctx.measureText(line).width;
      const underlineX = obj.align === 'center' ? tx - width / 2 : obj.align === 'right' ? tx - width : tx;
      ctx.strokeStyle = obj.color;
      ctx.lineWidth = Math.max(1, obj.fontSize / 16);
      ctx.beginPath();
      ctx.moveTo(underlineX, ly + obj.fontSize + 2);
      ctx.lineTo(underlineX + width, ly + obj.fontSize + 2);
      ctx.stroke();
    }
  });
}

function drawRect(obj) {
  const { x, y, w, h } = obj;
  ctx.save();
  if (obj.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 4;
  }
  ctx.beginPath();
  if (obj.type === 'roundrect') {
    roundedRectPath(x, y, w, h, Math.min(obj.cornerRadius, Math.abs(w) / 2, Math.abs(h) / 2));
  } else {
    ctx.rect(x, y, w, h);
  }
  if (obj.fillOpacity > 0) {
    ctx.fillStyle = hexToRgba(obj.fillColor, obj.fillOpacity);
    ctx.fill();
  }
  ctx.restore();
  if (obj.strokeWidth > 0) {
    ctx.save();
    ctx.beginPath();
    if (obj.type === 'roundrect') {
      roundedRectPath(x, y, w, h, Math.min(obj.cornerRadius, Math.abs(w) / 2, Math.abs(h) / 2));
    } else {
      ctx.rect(x, y, w, h);
    }
    ctx.strokeStyle = obj.strokeColor;
    ctx.lineWidth = obj.strokeWidth;
    ctx.stroke();
    ctx.restore();
  }
}

function roundedRectPath(x, y, w, h, r) {
  const rr = Math.max(0, r);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawCircle(obj) {
  const { x, y, w, h } = obj;
  ctx.save();
  if (obj.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 4;
  }
  ctx.beginPath();
  ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w) / 2, Math.abs(h) / 2, 0, 0, Math.PI * 2);
  if (obj.fillOpacity > 0) {
    ctx.fillStyle = hexToRgba(obj.fillColor, obj.fillOpacity);
    ctx.fill();
  }
  ctx.restore();
  if (obj.strokeWidth > 0) {
    ctx.strokeStyle = obj.strokeColor;
    ctx.lineWidth = obj.strokeWidth;
    ctx.stroke();
  }
}

function drawImageObj(obj) {
  const img = getCachedImage(obj.src);
  if (img.complete && img.naturalWidth) {
    ctx.drawImage(img, obj.x, obj.y, obj.w, obj.h);
  } else {
    img.onload = render;
  }
}

function drawLine(obj, arrow) {
  ctx.save();
  ctx.strokeStyle = obj.strokeColor;
  ctx.lineWidth = obj.strokeWidth;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(obj.x1, obj.y1);
  ctx.lineTo(obj.x2, obj.y2);
  ctx.stroke();

  if (arrow) {
    const angle = Math.atan2(obj.y2 - obj.y1, obj.x2 - obj.x1);
    const headLen = Math.max(10, obj.strokeWidth * 3.2);
    ctx.beginPath();
    ctx.moveTo(obj.x2, obj.y2);
    ctx.lineTo(
      obj.x2 - headLen * Math.cos(angle - Math.PI / 7),
      obj.y2 - headLen * Math.sin(angle - Math.PI / 7)
    );
    ctx.lineTo(
      obj.x2 - headLen * Math.cos(angle + Math.PI / 7),
      obj.y2 - headLen * Math.sin(angle + Math.PI / 7)
    );
    ctx.closePath();
    ctx.fillStyle = obj.strokeColor;
    ctx.fill();
  }
  ctx.restore();
}

function absPointsFor(obj) {
  return obj.points.map((p) => ({
    x: obj.x + p.nx * obj.w,
    y: obj.y + p.ny * obj.h
  }));
}

function drawFreehand(obj, isHighlight = false) {
  const pts = absPointsFor(obj);
  if (pts.length < 2) return;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (isHighlight) {
    ctx.globalAlpha = obj.solid ? 1 : obj.opacity;
    ctx.strokeStyle = obj.color;
    ctx.lineWidth = Math.max(14, obj.strokeWidth || 18);
  } else {
    ctx.strokeStyle = obj.strokeColor;
    ctx.lineWidth = obj.strokeWidth;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
  ctx.restore();
}

function drawHighlightRect(obj) {
  ctx.save();
  ctx.globalAlpha = obj.solid ? 1 : obj.opacity;
  ctx.fillStyle = obj.color;
  ctx.fillRect(obj.x, obj.y, obj.w, obj.h);
  ctx.restore();
}

function drawBlurRegion(obj, mode) {
  if (!state.baseImageEl) return;
  const x = Math.round(Math.min(obj.x, obj.x + obj.w));
  const y = Math.round(Math.min(obj.y, obj.y + obj.h));
  const w = Math.max(1, Math.round(Math.abs(obj.w)));
  const h = Math.max(1, Math.round(Math.abs(obj.h)));

  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const offCtx = off.getContext('2d');

  if (mode === 'blur') {
    offCtx.filter = `blur(${obj.intensity}px)`;
    offCtx.drawImage(state.baseImageEl, x, y, w, h, -obj.intensity, -obj.intensity, w + obj.intensity * 2, h + obj.intensity * 2);
  } else {
    const factor = Math.max(1, obj.intensity);
    const smallW = Math.max(1, Math.round(w / factor));
    const smallH = Math.max(1, Math.round(h / factor));
    const tiny = document.createElement('canvas');
    tiny.width = smallW;
    tiny.height = smallH;
    const tinyCtx = tiny.getContext('2d');
    tinyCtx.imageSmoothingEnabled = false;
    tinyCtx.drawImage(state.baseImageEl, x, y, w, h, 0, 0, smallW, smallH);
    offCtx.imageSmoothingEnabled = false;
    offCtx.drawImage(tiny, 0, 0, smallW, smallH, 0, 0, w, h);
  }

  ctx.drawImage(off, x, y);
}

function hexToRgba(hex, alpha) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/* ============================== Selection handles ============================== */

function getBBox(obj) {
  if (obj.type === 'line' || obj.type === 'arrow') {
    return {
      x: Math.min(obj.x1, obj.x2),
      y: Math.min(obj.y1, obj.y2),
      w: Math.abs(obj.x2 - obj.x1),
      h: Math.abs(obj.y2 - obj.y1)
    };
  }
  return { x: obj.x, y: obj.y, w: obj.w, h: obj.h };
}

function drawSelectionHandles(obj) {
  ctx.save();
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1.5 / state.zoom;
  ctx.setLineDash([5 / state.zoom, 4 / state.zoom]);

  if (obj.type === 'line' || obj.type === 'arrow') {
    ctx.strokeRect(
      Math.min(obj.x1, obj.x2) - 4,
      Math.min(obj.y1, obj.y2) - 4,
      Math.abs(obj.x2 - obj.x1) + 8,
      Math.abs(obj.y2 - obj.y1) + 8
    );
    ctx.setLineDash([]);
    drawHandle(obj.x1, obj.y1);
    drawHandle(obj.x2, obj.y2);
    ctx.restore();
    return;
  }

  withObjectTransform(obj, () => {
    ctx.strokeRect(obj.x, obj.y, obj.w, obj.h);
  });
  ctx.setLineDash([]);

  const rotation = obj.rotation || 0;
  const cx = obj.x + obj.w / 2;
  const cy = obj.y + obj.h / 2;
  const corners = [
    { x: obj.x, y: obj.y },
    { x: obj.x + obj.w, y: obj.y },
    { x: obj.x, y: obj.y + obj.h },
    { x: obj.x + obj.w, y: obj.y + obj.h },
    { x: obj.x + obj.w / 2, y: obj.y },
    { x: obj.x + obj.w / 2, y: obj.y + obj.h },
    { x: obj.x, y: obj.y + obj.h / 2 },
    { x: obj.x + obj.w, y: obj.y + obj.h / 2 }
  ];
  const canRotate = ['text', 'rect', 'roundrect', 'circle', 'image'].includes(obj.type);

  for (const c of corners) {
    const p = rotatePoint(c.x, c.y, cx, cy, rotation);
    drawHandle(p.x, p.y);
  }

  if (canRotate) {
    const rp = rotatePoint(cx, obj.y - ROTATE_HANDLE_OFFSET / state.zoom, cx, cy, rotation);
    const anchor = rotatePoint(cx, obj.y, cx, cy, rotation);
    ctx.beginPath();
    ctx.moveTo(anchor.x, anchor.y);
    ctx.lineTo(rp.x, rp.y);
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5 / state.zoom;
    ctx.stroke();
    drawHandle(rp.x, rp.y, true);
  }

  ctx.restore();
}

function drawHandle(x, y, isRotate = false) {
  const s = HANDLE_SIZE / state.zoom;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1.5 / state.zoom;
  ctx.beginPath();
  if (isRotate) {
    ctx.arc(x, y, s / 2, 0, Math.PI * 2);
  } else {
    ctx.rect(x - s / 2, y - s / 2, s, s);
  }
  ctx.fill();
  ctx.stroke();
}

function rotatePoint(x, y, cx, cy, angle) {
  const dx = x - cx;
  const dy = y - cy;
  return {
    x: cx + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: cy + dx * Math.sin(angle) + dy * Math.cos(angle)
  };
}

function drawCropOverlay(rect) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, canvas.width, rect.y);
  ctx.fillRect(0, rect.y + rect.h, canvas.width, canvas.height - rect.y - rect.h);
  ctx.fillRect(0, rect.y, rect.x, rect.h);
  ctx.fillRect(rect.x + rect.w, rect.y, canvas.width - rect.x - rect.w, rect.h);
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 2 / state.zoom;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

/* ============================== Hit testing ============================== */

function hitTestObject(obj, px, py) {
  const bbox = getBBox(obj);
  if (obj.rotation && obj.type !== 'line' && obj.type !== 'arrow') {
    const cx = obj.x + obj.w / 2;
    const cy = obj.y + obj.h / 2;
    const local = rotatePoint(px, py, cx, cy, -obj.rotation);
    px = local.x;
    py = local.y;
  }
  if (obj.type === 'line' || obj.type === 'arrow') {
    return distToSegment(px, py, obj.x1, obj.y1, obj.x2, obj.y2) < Math.max(8, obj.strokeWidth);
  }
  const pad = 2;
  return px >= bbox.x - pad && px <= bbox.x + bbox.w + pad && py >= bbox.y - pad && py <= bbox.y + bbox.h + pad;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const A = px - x1;
  const B = py - y1;
  const C = x2 - x1;
  const D = y2 - y1;
  const dot = A * C + B * D;
  const lenSq = C * C + D * D || 1;
  let t = dot / lenSq;
  t = Math.max(0, Math.min(1, t));
  const nx = x1 + t * C;
  const ny = y1 + t * D;
  return Math.hypot(px - nx, py - ny);
}

function getHandleAt(obj, px, py) {
  const s = HANDLE_SIZE / state.zoom;
  const cx = obj.x + obj.w / 2;
  const cy = obj.y + obj.h / 2;
  const rotation = obj.rotation || 0;

  if (obj.type === 'line' || obj.type === 'arrow') {
    if (Math.hypot(px - obj.x1, py - obj.y1) < s) return 'p1';
    if (Math.hypot(px - obj.x2, py - obj.y2) < s) return 'p2';
    return null;
  }

  const canRotate = ['text', 'rect', 'roundrect', 'circle', 'image'].includes(obj.type);
  if (canRotate) {
    const rp = rotatePoint(cx, obj.y - ROTATE_HANDLE_OFFSET / state.zoom, cx, cy, rotation);
    if (Math.hypot(px - rp.x, py - rp.y) < s) return 'rotate';
  }

  const corners = {
    nw: { x: obj.x, y: obj.y },
    ne: { x: obj.x + obj.w, y: obj.y },
    sw: { x: obj.x, y: obj.y + obj.h },
    se: { x: obj.x + obj.w, y: obj.y + obj.h },
    n: { x: obj.x + obj.w / 2, y: obj.y },
    s: { x: obj.x + obj.w / 2, y: obj.y + obj.h },
    w: { x: obj.x, y: obj.y + obj.h / 2 },
    e: { x: obj.x + obj.w, y: obj.y + obj.h / 2 }
  };
  for (const [tag, pt] of Object.entries(corners)) {
    const p = rotatePoint(pt.x, pt.y, cx, cy, rotation);
    if (Math.hypot(px - p.x, py - p.y) < s) return tag;
  }
  return null;
}

/* ============================== Pointer interaction ============================== */

function findTopObjectAt(x, y) {
  for (let i = state.objects.length - 1; i >= 0; i--) {
    if (hitTestObject(state.objects[i], x, y)) return state.objects[i];
  }
  return null;
}

function onPointerDown(evt) {
  const { x, y } = screenToImage(evt);

  if (state.tool === 'crop') {
    state.interaction = { mode: 'crop-draw', startX: x, startY: y };
    state.cropRect = { x, y, w: 0, h: 0 };
    return;
  }

  if (state.tool === 'select') {
    const selected = state.objects.find((o) => o.id === state.selectedId);
    if (selected) {
      const handle = getHandleAt(selected, x, y);
      if (handle) {
        state.interaction = {
          mode: handle === 'rotate' ? 'rotate' : 'resize',
          handle,
          startX: x,
          startY: y,
          origObj: JSON.parse(JSON.stringify(selected))
        };
        return;
      }
    }
    const hit = findTopObjectAt(x, y);
    if (hit) {
      selectObject(hit.id);
      state.interaction = {
        mode: 'move',
        startX: x,
        startY: y,
        origObj: JSON.parse(JSON.stringify(hit))
      };
    } else {
      selectObject(null);
    }
    return;
  }

  if (state.tool === 'text') {
    state.interaction = { mode: 'text-place', startX: x, startY: y };
    return;
  }

  if (['rect', 'roundrect', 'circle', 'highlight-rect', 'blur', 'pixelate'].includes(toolToType(state.tool))) {
    state.interaction = { mode: 'draw-box', startX: x, startY: y, previewObject: buildPreviewObject(state.tool, x, y, x, y) };
    return;
  }

  if (state.tool === 'line' || state.tool === 'arrow') {
    state.interaction = { mode: 'draw-line', startX: x, startY: y, previewObject: buildPreviewObject(state.tool, x, y, x, y) };
    return;
  }

  if (state.tool === 'freehand' || state.tool === 'highlight') {
    state.interaction = {
      mode: 'draw-free',
      points: [{ x, y }],
      previewObject: buildFreehandPreview(state.tool, [{ x, y }])
    };
    return;
  }
}

function toolToType(tool) {
  if (tool === 'highlight') return 'highlight-rect';
  return tool;
}

function onPointerMove(evt) {
  if (!state.interaction) {
    updateCursor(evt);
    return;
  }
  const { x, y } = screenToImage(evt);
  const it = state.interaction;

  if (it.mode === 'crop-draw') {
    state.cropRect = normalizeRect(it.startX, it.startY, x, y);
    render();
    return;
  }

  if (it.mode === 'move') {
    const dx = x - it.startX;
    const dy = y - it.startY;
    const obj = state.objects.find((o) => o.id === state.selectedId);
    if (!obj) return;
    applyMove(obj, it.origObj, dx, dy);
    render();
    return;
  }

  if (it.mode === 'resize') {
    const obj = state.objects.find((o) => o.id === state.selectedId);
    if (!obj) return;
    applyResize(obj, it.origObj, it.handle, x, y);
    render();
    return;
  }

  if (it.mode === 'rotate') {
    const obj = state.objects.find((o) => o.id === state.selectedId);
    if (!obj) return;
    const cx = obj.x + obj.w / 2;
    const cy = obj.y + obj.h / 2;
    obj.rotation = Math.atan2(y - cy, x - cx) + Math.PI / 2;
    render();
    return;
  }

  if (it.mode === 'draw-box') {
    it.previewObject = buildPreviewObject(state.tool, it.startX, it.startY, x, y);
    render();
    return;
  }

  if (it.mode === 'draw-line') {
    it.previewObject.x1 = it.startX;
    it.previewObject.y1 = it.startY;
    it.previewObject.x2 = x;
    it.previewObject.y2 = y;
    render();
    return;
  }

  if (it.mode === 'draw-free') {
    it.points.push({ x, y });
    it.previewObject = buildFreehandPreview(state.tool, it.points);
    render();
    return;
  }
}

function onPointerUp(evt) {
  if (!state.interaction) return;
  const it = state.interaction;

  if (it.mode === 'crop-draw') {
    state.interaction = null;
    return;
  }

  if (it.mode === 'move' || it.mode === 'resize' || it.mode === 'rotate') {
    state.interaction = null;
    commitObjects([...state.objects]);
    updateLayersPanel();
    return;
  }

  if (it.mode === 'draw-box' || it.mode === 'draw-line') {
    const obj = it.previewObject;
    const bbox = getBBox(obj);
    if (Math.abs(bbox.w) < 3 && Math.abs(bbox.h) < 3) {
      state.interaction = null;
      render();
      return;
    }
    normalizeBoxObject(obj);
    state.objects.push(obj);
    state.interaction = null;
    commitObjects([...state.objects]);
    track('ANNOTATION_CREATED', { feature: 'editor', action: obj.type });
    selectObject(obj.id);
    setActiveTool('select');
    return;
  }

  if (it.mode === 'draw-free') {
    if (it.points.length < 2) {
      state.interaction = null;
      render();
      return;
    }
    const obj = finalizeFreehand(state.tool, it.points);
    state.objects.push(obj);
    state.interaction = null;
    commitObjects([...state.objects]);
    track('ANNOTATION_CREATED', { feature: 'editor', action: obj.type });
    selectObject(obj.id);
    setActiveTool('select');
    return;
  }

  if (it.mode === 'text-place') {
    const { startX, startY } = it;
    state.interaction = null;
    const obj = {
      id: newObjectId(),
      type: 'text',
      x: startX,
      y: startY,
      w: 220,
      h: 40,
      rotation: 0,
      text: '',
      ...currentTextStyle()
    };
    state.objects.push(obj);
    selectObject(obj.id);
    openTextEditor(obj, true);
    return;
  }
}

function updateCursor(evt) {
  const { x, y } = screenToImage(evt);
  const selected = state.objects.find((o) => o.id === state.selectedId);
  let cursor = state.tool === 'select' ? 'default' : 'crosshair';
  if (state.tool === 'select' && selected) {
    const handle = getHandleAt(selected, x, y);
    if (handle === 'rotate') cursor = 'grab';
    else if (handle) cursor = handleCursor(handle);
    else if (hitTestObject(selected, x, y)) cursor = 'move';
  }
  canvas.style.cursor = cursor;
}

function handleCursor(tag) {
  const map = {
    n: 'ns-resize', s: 'ns-resize',
    e: 'ew-resize', w: 'ew-resize',
    ne: 'nesw-resize', sw: 'nesw-resize',
    nw: 'nwse-resize', se: 'nwse-resize',
    p1: 'crosshair', p2: 'crosshair'
  };
  return map[tag] || 'default';
}

function normalizeRect(x1, y1, x2, y2) {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1)
  };
}

function normalizeBoxObject(obj) {
  if (obj.type === 'line' || obj.type === 'arrow') return;
  if (obj.w < 0) {
    obj.x += obj.w;
    obj.w = Math.abs(obj.w);
  }
  if (obj.h < 0) {
    obj.y += obj.h;
    obj.h = Math.abs(obj.h);
  }
  obj.w = Math.max(obj.w, 4);
  obj.h = Math.max(obj.h, 4);
}

function buildPreviewObject(tool, x1, y1, x2, y2) {
  const id = newObjectId();
  const type = toolToType(tool);
  if (type === 'line' || type === 'arrow') {
    return { id, type, x1, y1, x2, y2, strokeColor: $('#strokeColor').value, strokeWidth: Number($('#strokeWidth').value) };
  }
  const rect = normalizeRect(x1, y1, x2, y2);
  if (type === 'highlight-rect') {
    return { id, type, ...rect, rotation: 0, ...currentHighlightStyle() };
  }
  if (type === 'blur' || type === 'pixelate') {
    return { id, type, ...rect, rotation: 0, intensity: currentRedactIntensity() };
  }
  return { id, type, ...rect, rotation: 0, ...currentShapeStyle() };
}

function buildFreehandPreview(tool, points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const w = Math.max(1, Math.max(...xs) - minX);
  const h = Math.max(1, Math.max(...ys) - minY);
  const normPoints = points.map((p) => ({ nx: (p.x - minX) / w, ny: (p.y - minY) / h }));
  const isHighlight = tool === 'highlight';
  return {
    id: newObjectId(),
    type: isHighlight ? 'highlight-free' : 'freehand',
    x: minX,
    y: minY,
    w,
    h,
    rotation: 0,
    points: normPoints,
    ...(isHighlight ? currentHighlightStyle() : currentShapeStyle())
  };
}

function finalizeFreehand(tool, points) {
  return buildFreehandPreview(tool, points);
}

/* ============================== Move / resize math ============================== */

function applyMove(obj, orig, dx, dy) {
  if (obj.type === 'line' || obj.type === 'arrow') {
    obj.x1 = orig.x1 + dx;
    obj.y1 = orig.y1 + dy;
    obj.x2 = orig.x2 + dx;
    obj.y2 = orig.y2 + dy;
    return;
  }
  obj.x = orig.x + dx;
  obj.y = orig.y + dy;
}

function applyResize(obj, orig, handle, mx, my) {
  if (obj.type === 'line' || obj.type === 'arrow') {
    if (handle === 'p1') {
      obj.x1 = mx;
      obj.y1 = my;
    } else if (handle === 'p2') {
      obj.x2 = mx;
      obj.y2 = my;
    }
    return;
  }

  const cx = orig.x + orig.w / 2;
  const cy = orig.y + orig.h / 2;
  const local = rotatePoint(mx, my, cx, cy, -(orig.rotation || 0));

  let { x, y, w, h } = orig;
  const right = orig.x + orig.w;
  const bottom = orig.y + orig.h;

  if (handle.includes('w')) {
    x = Math.min(local.x, right - 4);
    w = right - x;
  }
  if (handle.includes('e')) {
    w = Math.max(4, local.x - orig.x);
  }
  if (handle.includes('n')) {
    y = Math.min(local.y, bottom - 4);
    h = bottom - y;
  }
  if (handle.includes('s')) {
    h = Math.max(4, local.y - orig.y);
  }

  obj.x = x;
  obj.y = y;
  obj.w = w;
  obj.h = h;
}

/* ============================== Selection & object actions ============================== */

function selectObject(id) {
  state.selectedId = id;
  render();
  updatePropertyPanel();
  updateLayersPanel();
}

function getSelected() {
  return state.objects.find((o) => o.id === state.selectedId) || null;
}

function deleteSelected() {
  if (!state.selectedId) return;
  const next = state.objects.filter((o) => o.id !== state.selectedId);
  state.selectedId = null;
  commitObjects(next);
  updatePropertyPanel();
  updateLayersPanel();
}

function duplicateSelected() {
  const obj = getSelected();
  if (!obj) return;
  const copy = JSON.parse(JSON.stringify(obj));
  copy.id = newObjectId();
  if (copy.type === 'line' || copy.type === 'arrow') {
    copy.x1 += 16; copy.y1 += 16; copy.x2 += 16; copy.y2 += 16;
  } else {
    copy.x += 16;
    copy.y += 16;
  }
  const next = [...state.objects, copy];
  commitObjects(next);
  selectObject(copy.id);
}

function reorderSelected(mode) {
  const idx = state.objects.findIndex((o) => o.id === state.selectedId);
  if (idx === -1) return;
  const next = [...state.objects];
  const [obj] = next.splice(idx, 1);
  if (mode === 'front') next.push(obj);
  else if (mode === 'back') next.unshift(obj);
  else if (mode === 'forward') next.splice(Math.min(next.length, idx + 1), 0, obj);
  else if (mode === 'backward') next.splice(Math.max(0, idx - 1), 0, obj);
  commitObjects(next);
  render();
  updateLayersPanel();
}

/* ============================== Text editing overlay ============================== */

function openTextEditor(obj, isNew) {
  const rect = canvas.getBoundingClientRect();
  const left = rect.left + obj.x * state.zoom;
  const top = rect.top + obj.y * state.zoom;
  textOverlay.style.left = left + 'px';
  textOverlay.style.top = top + 'px';
  textOverlay.style.width = obj.w * state.zoom + 'px';
  textOverlay.style.height = obj.h * state.zoom + 'px';
  textOverlay.style.font = `${obj.italic ? 'italic ' : ''}${obj.bold ? '700 ' : ''}${obj.fontSize * state.zoom}px ${obj.fontFamily}`;
  textOverlay.style.color = obj.color;
  textOverlay.style.textAlign = obj.align;
  textOverlay.value = obj.text || '';
  textOverlay.classList.remove('ed-hidden');
  textOverlay.focus();

  state.interaction = { editingTextId: obj.id };
  render();

  const commit = () => {
    obj.text = textOverlay.value;
    const measured = measureTextHeight(obj);
    obj.h = Math.max(obj.h, measured);
    textOverlay.classList.add('ed-hidden');
    state.interaction = null;
    if (!obj.text.trim() && isNew) {
      const next = state.objects.filter((o) => o.id !== obj.id);
      commitObjects(next);
      selectObject(null);
    } else {
      commitObjects([...state.objects]);
      if (isNew) track('ANNOTATION_CREATED', { feature: 'editor', action: 'text' });
      selectObject(obj.id);
    }
  };

  textOverlay.addEventListener('blur', commit, { once: true });
  textOverlay.onkeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      textOverlay.blur();
    }
  };
}

function measureTextHeight(obj) {
  const lines = Math.max(1, (obj.text || '').split('\n').length);
  return lines * obj.fontSize * 1.25 + 8;
}

/* ============================== Crop ============================== */

function applyCrop() {
  if (!state.cropRect || state.cropRect.w < 4 || state.cropRect.h < 4) {
    showToast('Draw a crop area first.', true);
    return;
  }
  const composite = renderComposite();
  const { x, y, w, h } = state.cropRect;
  const off = document.createElement('canvas');
  off.width = Math.round(w);
  off.height = Math.round(h);
  off.getContext('2d').drawImage(composite, x, y, w, h, 0, 0, w, h);

  bakeNewBaseImage(off).then(() => {
    state.cropRect = null;
    setActiveTool('select');
    showToast('Crop applied.', false);
  });
}

function cancelCrop() {
  state.cropRect = null;
  render();
}

function renderComposite() {
  const off = document.createElement('canvas');
  off.width = canvas.width;
  off.height = canvas.height;
  const offCtx = off.getContext('2d');
  offCtx.drawImage(state.baseImageEl, 0, 0, canvas.width, canvas.height);
  for (const obj of state.objects) drawObjectWithContext(offCtx, obj);
  return off;
}

// Draws a single object against an arbitrary 2D context by temporarily
// swapping the module-level `ctx` binding that every draw* helper above
// reads from. Canvas 2D drawing is synchronous, so it's safe to restore
// `ctx` immediately after each call — nothing else runs in between.
function drawObjectWithContext(targetCtx, obj) {
  const prev = ctx;
  ctx = targetCtx;
  drawObject(obj);
  ctx = prev;
}

async function bakeNewBaseImage(sourceCanvas) {
  const dataUrl = sourceCanvas.toDataURL('image/png');
  const img = await loadImage(dataUrl);
  pushImageVersion(dataUrl, sourceCanvas.width, sourceCanvas.height);
  state.baseImageEl = img;
  state.objects = [];
  state.selectedId = null;
  sizeCanvasToImage();
  fitZoom();
  pushHistory([], true);
  render();
  updateLayersPanel();
  updatePropertyPanel();
}

/* ============================== Rotate / Resize whole image ============================== */

async function rotateImage(deg) {
  const composite = renderComposite();
  const off = document.createElement('canvas');
  const rad = (deg * Math.PI) / 180;
  if (Math.abs(deg) === 90) {
    off.width = composite.height;
    off.height = composite.width;
  } else {
    off.width = composite.width;
    off.height = composite.height;
  }
  const offCtx = off.getContext('2d');
  offCtx.translate(off.width / 2, off.height / 2);
  offCtx.rotate(rad);
  offCtx.drawImage(composite, -composite.width / 2, -composite.height / 2);
  await bakeNewBaseImage(off);
  showToast('Image rotated.', false);
}

function openResizeDialog() {
  $('#resizeWidth').value = canvas.width;
  $('#resizeHeight').value = canvas.height;
  $('#resizeOverlay').classList.remove('ed-hidden');
}

async function applyResizeDialog() {
  const w = Math.max(1, Number($('#resizeWidth').value));
  const h = Math.max(1, Number($('#resizeHeight').value));
  const composite = renderComposite();
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  off.getContext('2d').drawImage(composite, 0, 0, w, h);
  await bakeNewBaseImage(off);
  $('#resizeOverlay').classList.add('ed-hidden');
  showToast('Image resized.', false);
}

/* ============================== Import asset ============================== */

function importAsset(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    const dataUrl = reader.result;
    const img = await loadImage(dataUrl);
    const maxDim = Math.min(320, canvas.width * 0.5, canvas.height * 0.5);
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    const obj = {
      id: newObjectId(),
      type: 'image',
      x: (canvas.width - w) / 2,
      y: (canvas.height - h) / 2,
      w,
      h,
      rotation: 0,
      src: dataUrl
    };
    getCachedImage(dataUrl);
    state.objects.push(obj);
    commitObjects([...state.objects]);
    track('ANNOTATION_CREATED', { feature: 'editor', action: 'image_import' });
    selectObject(obj.id);
    setActiveTool('select');
  };
  reader.readAsDataURL(file);
}

/* ============================== Export / Save / Share ============================== */

function exportBlob(mime = 'image/png', quality) {
  const composite = renderComposite();
  return new Promise((resolve) => composite.toBlob((b) => resolve(b), mime, quality));
}

function fileNameFromTitle(ext) {
  const title = $('#titleInput').value.trim() || 'screenshot';
  const safe = title.replace(/[^a-z0-9-_ ]/gi, '').replace(/\s+/g, '-');
  return `${safe || 'screenshot'}-${timestampForFilename()}.${ext}`;
}

async function onDownload() {
  const blob = await exportBlob('image/png');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileNameFromTitle('png');
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  track('FILE_DOWNLOADED', { feature: 'editor', action: 'screenshot' });
  showToast('Download started ✅');
}

async function onSaveToGallery() {
  const btn = $('#saveBtn');
  btn.disabled = true;
  try {
    const blob = await exportBlob('image/png');
    const thumbnail = await generateImageThumbnail(blob).catch(() => null);
    await CaptureStore.update(state.capture.id, {
      blob,
      thumbnail,
      size: blob.size,
      name: fileNameFromTitle('png'),
      width: canvas.width,
      height: canvas.height
    });
    state.isDirty = false;
    chrome.runtime.sendMessage({ action: 'GALLERY_UPDATED' }).catch(() => {});
    track('SCREENSHOT_EDITED', { feature: 'editor', action: 'save', success: true });
    showToast('Saved to gallery ✅', false);
  } catch (err) {
    console.error(err);
    track('SCREENSHOT_EDITED', { feature: 'editor', action: 'save', success: false, error: err.message });
    showToast(err.message || 'Failed to save.', true);
  } finally {
    btn.disabled = false;
  }
}

async function onCreateShareLink() {
  const btn = $('#shareBtn');
  btn.disabled = true;
  const originalLabel = btn.textContent;
  try {
    btn.textContent = 'Uploading…';
    const blob = await exportBlob('image/png');
    const name = fileNameFromTitle('png');

    const thumbnail = await generateImageThumbnail(blob).catch(() => null);
    await CaptureStore.update(state.capture.id, { blob, thumbnail, size: blob.size, name });
    const capture = await CaptureStore.get(state.capture.id);

    const { shareUrl, destination } = await createShareLink(capture, (loaded, total) => {
      btn.textContent = `Uploading… ${Math.round((loaded / total) * 100)}%`;
    });

    $('#shareModalText').textContent =
      destination === 'drive' ? 'Screenshot uploaded to Google Drive' : 'Screenshot uploaded successfully';
    $('#shareUrlInput').value = shareUrl;
    $('#shareOverlay').classList.remove('ed-hidden');
    chrome.runtime.sendMessage({ action: 'GALLERY_UPDATED' }).catch(() => {});
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Upload failed. Your screenshot is safely stored locally.', true);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

/* ============================== Toast ============================== */

function showToast(message, isError = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `ed-toast ${isError ? 'ed-toast-error' : 'ed-toast-success'}`;
  toast.classList.remove('ed-hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('ed-hidden'), 3000);
}

/* ============================== Tool / panel UI ============================== */

function setActiveTool(tool) {
  state.tool = tool;
  document.querySelectorAll('.ed-tool[data-tool]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
  if (tool !== 'crop') {
    state.cropRect = null;
  }
  updatePropertyPanel();
  render();
}

function updatePropertyPanel() {
  const groups = {
    text: $('#propText'),
    shape: $('#propShape'),
    highlight: $('#propHighlight'),
    redact: $('#propRedact'),
    crop: $('#propCrop')
  };
  Object.values(groups).forEach((g) => g.classList.add('ed-hidden'));
  $('#propEmpty').classList.add('ed-hidden');
  $('#propObjectActions').classList.add('ed-hidden');

  const selected = getSelected();
  const effectiveType = selected ? selected.type : toolToType(state.tool);

  $('#cornerRadiusLabel').classList.toggle('ed-hidden', effectiveType !== 'roundrect');
  $('#cornerRadius').classList.toggle('ed-hidden', effectiveType !== 'roundrect');

  if (effectiveType === 'text') {
    groups.text.classList.remove('ed-hidden');
    if (selected) fillTextPanel(selected);
  } else if (['rect', 'roundrect', 'circle', 'line', 'arrow', 'freehand', 'image'].includes(effectiveType)) {
    if (effectiveType !== 'image') groups.shape.classList.remove('ed-hidden');
    if (selected && effectiveType !== 'image') fillShapePanel(selected);
  } else if (effectiveType === 'highlight-rect' || effectiveType === 'highlight-free' || state.tool === 'highlight') {
    groups.highlight.classList.remove('ed-hidden');
    if (selected) fillHighlightPanel(selected);
  } else if (effectiveType === 'blur' || effectiveType === 'pixelate') {
    groups.redact.classList.remove('ed-hidden');
    if (selected) $('#redactIntensity').value = selected.intensity;
  } else if (state.tool === 'crop') {
    groups.crop.classList.remove('ed-hidden');
  } else if (!selected) {
    $('#propEmpty').classList.remove('ed-hidden');
  }

  if (selected) {
    $('#propObjectActions').classList.remove('ed-hidden');
  }
}

function fillTextPanel(obj) {
  $('#fontFamily').value = obj.fontFamily;
  $('#fontSize').value = obj.fontSize;
  $('#fontBold').classList.toggle('active', !!obj.bold);
  $('#fontItalic').classList.toggle('active', !!obj.italic);
  $('#fontUnderline').classList.toggle('active', !!obj.underline);
  document.querySelectorAll('[data-align]').forEach((b) => b.classList.toggle('active', b.dataset.align === obj.align));
  $('#textColor').value = obj.color;
  $('#textBgColor').value = obj.bgColor;
  $('#textBgOpacity').value = Math.round((obj.bgOpacity || 0) * 100);
}

function fillShapePanel(obj) {
  $('#strokeColor').value = obj.strokeColor || '#ff3b30';
  $('#strokeWidth').value = obj.strokeWidth || 4;
  $('#fillColor').value = obj.fillColor || '#ff3b30';
  $('#fillOpacity').value = Math.round((obj.fillOpacity || 0) * 100);
  $('#cornerRadius').value = obj.cornerRadius || 12;
  $('#shadowToggle').checked = !!obj.shadow;
}

function fillHighlightPanel(obj) {
  $('#highlightColor').value = obj.color;
  $('#highlightOpacity').value = Math.round((obj.opacity || 0.45) * 100);
  $('#highlightSolid').checked = !!obj.solid;
}

function applyLivePropertyChange() {
  const selected = getSelected();
  if (!selected) return;
  if (selected.type === 'text') Object.assign(selected, currentTextStyle());
  else if (['rect', 'roundrect', 'circle', 'line', 'arrow', 'freehand'].includes(selected.type)) {
    Object.assign(selected, currentShapeStyle());
  } else if (selected.type === 'highlight-rect' || selected.type === 'highlight-free') {
    Object.assign(selected, currentHighlightStyle());
  } else if (selected.type === 'blur' || selected.type === 'pixelate') {
    selected.intensity = currentRedactIntensity();
  }
  render();
}

function commitPropertyChange() {
  if (!getSelected()) return;
  commitObjects([...state.objects]);
}

/* ============================== Layers panel ============================== */

const OBJECT_ICONS = {
  text: 'T', rect: '▭', roundrect: '▢', circle: '◯', line: '╱', arrow: '↗',
  freehand: '✎', 'highlight-rect': '▮', 'highlight-free': '▮', blur: '◌', pixelate: '▦', image: '🖼'
};

function updateLayersPanel() {
  const list = $('#layersList');
  const empty = $('#layersEmpty');
  list.innerHTML = '';
  if (!state.objects.length) {
    empty.classList.remove('ed-hidden');
    return;
  }
  empty.classList.add('ed-hidden');
  for (let i = state.objects.length - 1; i >= 0; i--) {
    const obj = state.objects[i];
    const item = document.createElement('div');
    item.className = 'ed-layer-item' + (obj.id === state.selectedId ? ' active' : '');
    item.innerHTML = `<span class="ed-layer-icon">${OBJECT_ICONS[obj.type] || '•'}</span><span class="ed-layer-label"></span>`;
    item.querySelector('.ed-layer-label').textContent = labelFor(obj);
    item.addEventListener('click', () => selectObject(obj.id));
    list.appendChild(item);
  }
}

function labelFor(obj) {
  if (obj.type === 'text') return obj.text ? obj.text.slice(0, 24) : 'Text';
  const names = {
    rect: 'Rectangle', roundrect: 'Rounded Rectangle', circle: 'Circle', line: 'Line', arrow: 'Arrow',
    freehand: 'Drawing', 'highlight-rect': 'Highlight', 'highlight-free': 'Highlight', blur: 'Blur', pixelate: 'Pixelate', image: 'Image'
  };
  return names[obj.type] || obj.type;
}

/* ============================== Event bindings ============================== */

function bindEvents() {
  canvas.addEventListener('mousedown', onPointerDown);
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mouseup', onPointerUp);

  document.querySelectorAll('.ed-tool[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => setActiveTool(btn.dataset.tool));
  });

  $('#importBtn').addEventListener('click', () => $('#importInput').click());
  $('#importInput').addEventListener('change', (e) => {
    if (e.target.files[0]) importAsset(e.target.files[0]);
    e.target.value = '';
  });

  $('#undoBtn').addEventListener('click', undo);
  $('#redoBtn').addEventListener('click', redo);
  $('#zoomInBtn').addEventListener('click', () => zoomBy(1.2));
  $('#zoomOutBtn').addEventListener('click', () => zoomBy(1 / 1.2));
  $('#zoomFitBtn').addEventListener('click', fitZoom);

  $('#closeBtn').addEventListener('click', () => {
    window.close();
  });

  $('#downloadBtn').addEventListener('click', onDownload);
  $('#saveBtn').addEventListener('click', onSaveToGallery);
  $('#shareBtn').addEventListener('click', onCreateShareLink);

  $('#applyCropBtn').addEventListener('click', applyCrop);
  $('#cancelCropBtn').addEventListener('click', cancelCrop);

  $('#rotateLeftBtn').addEventListener('click', () => rotateImage(-90));
  $('#rotateRightBtn').addEventListener('click', () => rotateImage(90));
  $('#resizeBtn').addEventListener('click', openResizeDialog);
  $('#resizeApplyBtn').addEventListener('click', applyResizeDialog);
  $('#resizeCancelBtn').addEventListener('click', () => $('#resizeOverlay').classList.add('ed-hidden'));

  let aspectRatio = 1;
  $('#resizeWidth').addEventListener('focus', () => {
    aspectRatio = canvas.width / canvas.height;
  });
  $('#resizeWidth').addEventListener('input', () => {
    if ($('#resizeLockAspect').checked) {
      $('#resizeHeight').value = Math.round(Number($('#resizeWidth').value) / aspectRatio);
    }
  });
  $('#resizeHeight').addEventListener('input', () => {
    if ($('#resizeLockAspect').checked) {
      $('#resizeWidth').value = Math.round(Number($('#resizeHeight').value) * aspectRatio);
    }
  });

  $('#dupBtn').addEventListener('click', duplicateSelected);
  $('#delBtn').addEventListener('click', deleteSelected);
  $('#bringFrontBtn').addEventListener('click', () => reorderSelected('front'));
  $('#sendBackBtn').addEventListener('click', () => reorderSelected('back'));
  $('#bringFwdBtn').addEventListener('click', () => reorderSelected('forward'));
  $('#sendBwdBtn').addEventListener('click', () => reorderSelected('backward'));

  document.querySelectorAll('.ed-panel-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.ed-panel-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      $('#panelProperties').classList.toggle('ed-hidden', tab.dataset.panel !== 'properties');
      $('#panelLayers').classList.toggle('ed-hidden', tab.dataset.panel !== 'layers');
    });
  });

  ['fontBold', 'fontItalic', 'fontUnderline'].forEach((id) => {
    $('#' + id).addEventListener('click', () => {
      $('#' + id).classList.toggle('active');
      applyLivePropertyChange();
      commitPropertyChange();
    });
  });
  document.querySelectorAll('[data-align]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-align]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      applyLivePropertyChange();
      commitPropertyChange();
    });
  });

  const liveInputs = [
    'fontFamily', 'fontSize', 'textColor', 'textBgColor', 'textBgOpacity',
    'strokeColor', 'strokeWidth', 'fillColor', 'fillOpacity', 'cornerRadius', 'shadowToggle',
    'highlightColor', 'highlightOpacity', 'highlightSolid', 'redactIntensity'
  ];
  for (const id of liveInputs) {
    const el = $('#' + id);
    el.addEventListener('input', applyLivePropertyChange);
    el.addEventListener('change', commitPropertyChange);
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', () => render());

  $('#shareCloseBtn').addEventListener('click', () => $('#shareOverlay').classList.add('ed-hidden'));
  $('#copyShareUrlBtn').addEventListener('click', async () => {
    await copyTextToClipboard($('#shareUrlInput').value);
    showToast('Link copied ✅');
  });
  $('#openShareUrlBtn').addEventListener('click', () => window.open($('#shareUrlInput').value, '_blank'));

  window.addEventListener('beforeunload', (e) => {
    if (state.isDirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

const TOOL_SHORTCUTS = {
  v: 'select', t: 'text', a: 'arrow', l: 'line', r: 'rect', c: 'circle', p: 'freehand', h: 'highlight', x: 'crop'
};

function onKeyDown(e) {
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
    e.preventDefault();
    redo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    duplicateSelected();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selectedId) {
      e.preventDefault();
      deleteSelected();
    }
    return;
  }
  if (e.key === 'Escape') {
    selectObject(null);
    if (state.tool === 'crop') cancelCrop();
    return;
  }
  const shortcutTool = TOOL_SHORTCUTS[e.key.toLowerCase()];
  if (shortcutTool) setActiveTool(shortcutTool);
}

init();
