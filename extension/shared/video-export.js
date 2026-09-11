// extension/shared/video-export.js
// Client-side video editing: trim, speed, effects (brightness/contrast/
// saturation/grayscale/sepia/blur), and resolution changes -- all via a
// "re-render" pipeline (play the source video through a canvas, capture
// that canvas + its audio via MediaRecorder) since there is no
// server-side video processing in this project and no bundled
// ffmpeg/WASM codec library. This is the standard technique for
// client-side browser video editing without one.
//
// Important design choices, and why:
// - Uses setInterval (not requestAnimationFrame) to drive the frame
//   draw loop during export. rAF is throttled or fully paused when the
//   tab isn't the active/visible one, which would silently corrupt or
//   hang an export if the user switched tabs mid-export -- setInterval
//   keeps running regardless.
// - Creates its OWN temporary <video> element per export call, rather
//   than reusing a shared preview element. AudioContext.
//   createMediaElementSource() can only be called ONCE per media
//   element (a second call throws) -- a fresh element per export
//   sidesteps that entirely and keeps export fully independent of
//   whatever the live preview UI is doing.
import { pickSupportedVideoMimeType } from './utils.js';

/**
 * @param {Blob} sourceBlob - the original recording
 * @param {object} opts
 * @param {number} opts.trimStart - seconds
 * @param {number} opts.trimEnd - seconds
 * @param {number} opts.speed - playback rate multiplier (e.g. 0.5, 1, 2)
 * @param {object} opts.effects - { brightness, contrast, saturation (all 0-2, 1=neutral), grayscale (0-1), sepia (0-1), blur (px) }
 * @param {number} opts.targetWidth
 * @param {number} opts.targetHeight
 * @param {(fraction: number) => void} [opts.onProgress] - 0..1
 * @returns {Promise<Blob>}
 */
export async function exportEditedVideo(sourceBlob, opts) {
  const { trimStart, trimEnd, speed, effects, targetWidth, targetHeight, onProgress } = opts;
  if (trimEnd <= trimStart) throw new Error('Trim end must be after trim start.');
  if (targetWidth <= 0 || targetHeight <= 0) throw new Error('Invalid target resolution.');

  const sourceUrl = URL.createObjectURL(sourceBlob);
  const video = document.createElement('video');
  video.muted = false;
  video.volume = 1;
  video.playsInline = true;
  video.src = sourceUrl;
  video.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
  document.body.appendChild(video);

  const cleanup = () => {
    video.pause();
    video.remove();
    URL.revokeObjectURL(sourceUrl);
  };

  try {
    await new Promise((resolve, reject) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      video.addEventListener('error', () => reject(new Error('Could not load the source video.')), { once: true });
    });

    const clampedTrimEnd = Math.min(trimEnd, video.duration || trimEnd);

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    // desynchronized:true is a standard hint that lets the browser skip
    // some of its normal display-compositor synchronization for this
    // context, which can reduce per-draw latency for a canvas whose
    // output (here) is never actually shown on screen.
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    // Set once, not per-frame: the requested effects are fixed for the
    // whole export, so re-parsing and re-applying the same CSS filter
    // string on every single frame (the previous code did this inside
    // the draw loop) was pure repeated overhead for a value that never
    // changes during an export.
    ctx.filter = buildCssFilterString(effects);

    // Audio routing: tap the video element's real audio via Web Audio
    // and feed it into a MediaStreamDestination, which becomes the
    // audio track on the exported stream. Not connected to
    // audioCtx.destination (speakers) -- export doesn't need to be
    // audible, and leaving it disconnected avoids double/echoed audio
    // if the user can also hear the source tab.
    //
    // Skipped entirely when the source has no audio: audioTracks is a
    // long-stable, non-experimental HTMLMediaElement API in Chrome, so
    // this is checked directly rather than guessed -- but if it's ever
    // unavailable/inconclusive for some reason, this defaults to
    // ASSUMING audio is present and building the full pipeline anyway,
    // since silently dropping real audio would be a correctness
    // regression far worse than the modest overhead this attempts to
    // avoid for a genuinely silent recording.
    const hasAudio = video.audioTracks ? video.audioTracks.length > 0 : true;
    let audioCtx = null;
    let audioTracksForExport = [];
    if (hasAudio) {
      audioCtx = new AudioContext();
      await audioCtx.resume().catch(() => {});
      const mediaSource = audioCtx.createMediaElementSource(video);
      const destination = audioCtx.createMediaStreamDestination();
      mediaSource.connect(destination);
      audioTracksForExport = destination.stream.getAudioTracks();
    }

    const videoStream = canvas.captureStream(30);
    const combinedStream = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...audioTracksForExport
    ]);

    const mimeType = pickSupportedVideoMimeType();
    const recorder = new MediaRecorder(combinedStream, { mimeType });
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    const resultBlob = await new Promise((resolve, reject) => {
      recorder.onerror = (e) => reject(e.error || new Error('Export recording failed.'));
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }));

      video.currentTime = trimStart;
      video.playbackRate = speed;

      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        recorder.start();
        video.play().catch((err) => reject(err));

        const totalSpan = clampedTrimEnd - trimStart;
        const intervalMs = 1000 / 30;
        const intervalId = setInterval(() => {
          if (video.currentTime >= clampedTrimEnd || video.ended || video.paused) {
            clearInterval(intervalId);
            if (recorder.state !== 'inactive') recorder.stop();
            return;
          }
          ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
          if (onProgress) onProgress(Math.min(1, (video.currentTime - trimStart) / totalSpan));
        }, intervalMs);
      };
      video.addEventListener('seeked', onSeeked);
    });

    if (audioCtx) audioCtx.close().catch(() => {});
    return resultBlob;
  } finally {
    cleanup();
  }
}

export function buildCssFilterString(effects) {
  if (!effects) return 'none';
  const parts = [];
  if (typeof effects.brightness === 'number' && effects.brightness !== 1) {
    parts.push(`brightness(${effects.brightness})`);
  }
  if (typeof effects.contrast === 'number' && effects.contrast !== 1) {
    parts.push(`contrast(${effects.contrast})`);
  }
  if (typeof effects.saturation === 'number' && effects.saturation !== 1) {
    parts.push(`saturate(${effects.saturation})`);
  }
  if (typeof effects.grayscale === 'number' && effects.grayscale > 0) {
    parts.push(`grayscale(${effects.grayscale})`);
  }
  if (typeof effects.sepia === 'number' && effects.sepia > 0) {
    parts.push(`sepia(${effects.sepia})`);
  }
  if (typeof effects.blur === 'number' && effects.blur > 0) {
    parts.push(`blur(${effects.blur}px)`);
  }
  return parts.length ? parts.join(' ') : 'none';
}

export const RESOLUTION_PRESETS = [
  { label: 'Original', scale: 1 },
  { label: '1080p', maxHeight: 1080 },
  { label: '720p', maxHeight: 720 },
  { label: '480p', maxHeight: 480 }
];

export function resolveTargetDimensions(sourceWidth, sourceHeight, preset) {
  if (preset.scale === 1) return { width: sourceWidth, height: sourceHeight };
  if (sourceHeight <= preset.maxHeight) return { width: sourceWidth, height: sourceHeight };
  const scale = preset.maxHeight / sourceHeight;
  return {
    width: Math.round(sourceWidth * scale / 2) * 2, // even dimensions -- some encoders reject odd ones
    height: Math.round(sourceHeight * scale / 2) * 2
  };
}
