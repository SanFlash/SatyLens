// extension/shared/clipboard.js
// Clipboard helpers. Image clipboard writes require a secure context and
// the Clipboard API's ClipboardItem — supported in the popup/gallery
// document context, NOT reliably inside the background service worker.

export async function copyImageBlobToClipboard(blob) {
  if (!navigator.clipboard || !window.ClipboardItem) {
    throw new Error(
      'Clipboard image copy is not supported in this context. Use Download instead.'
    );
  }
  // Clipboard API only reliably supports image/png for ClipboardItem in Chrome.
  const pngBlob = blob.type === 'image/png' ? blob : await toPng(blob);
  const item = new ClipboardItem({ [pngBlob.type]: pngBlob });
  await navigator.clipboard.write([item]);
}

async function toPng(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG conversion failed'))), 'image/png');
  });
}

export async function copyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Fallback for contexts without navigator.clipboard
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}
