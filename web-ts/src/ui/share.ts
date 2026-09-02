import { triggerDownload } from './dom';
import { showToast } from './toasts';

/** The statistics snapshot rendered onto the share image. */
export interface ShareStats {
  saved: string;
  percent: string;
  files: string;
  elapsed: string;
  quality: number;
  original: string;
  webp: string;
  /** Which engine produced the stats , the card copy adapts. */
  edition?: 'browser' | 'python';
}

// 16:9 (1200×675) , the sweet spot that renders uncropped on X/Twitter and
// near-uncropped in Open Graph cards, with room for legible type in feeds.
const W = 1200;
const H = 675;
const MARGIN = 64;

const INK = '#f7f0e6';
const MUTED = '#a89579';
const SAVED = '#a6bb6b';
const SAVED_SOFT = '#cfe0a8';
const BRAND = '#eeb056';
const BRAND_SOFT = '#f3c77e';
const CARD = 'rgba(216, 180, 134, 0.09)';

function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/**
 * Render the stats card onto a canvas. Exported so tooling (e.g. the static
 * og-image asset) reuses the exact design the app shows.
 */
export function renderShareCanvas(stats: ShareStats): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.textBaseline = 'alphabetic';

  // Deep warm canvas + amber frame + accent top strip.
  ctx.fillStyle = '#0d0a08';
  drawRoundRect(ctx, 0, 0, W, H, 32);
  ctx.fill();
  ctx.strokeStyle = 'rgba(240, 182, 90, 0.4)';
  ctx.lineWidth = 2;
  drawRoundRect(ctx, 1, 1, W - 2, H - 2, 32);
  ctx.stroke();
  const strip = ctx.createLinearGradient(0, 0, W, 0);
  strip.addColorStop(0, '#f0b65a');
  strip.addColorStop(0.55, '#eaa94f');
  strip.addColorStop(1, '#e0794d');
  ctx.fillStyle = strip;
  drawRoundRect(ctx, MARGIN, 0, W - MARGIN * 2, 8, 4);
  ctx.fill();

  // Brand mark + title.
  const mark = ctx.createLinearGradient(MARGIN, MARGIN, MARGIN + 76, MARGIN + 76);
  mark.addColorStop(0, '#f0b65a');
  mark.addColorStop(1, '#e0794d');
  ctx.fillStyle = mark;
  drawRoundRect(ctx, MARGIN, MARGIN, 76, 76, 20);
  ctx.fill();
  ctx.fillStyle = '#241a09';
  ctx.font = 'italic 700 46px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('P', MARGIN + 38, MARGIN + 40);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = INK;
  ctx.font = '700 44px Georgia, serif';
  ctx.fillText('PicToWebP', MARGIN + 100, MARGIN + 40);
  ctx.fillStyle = MUTED;
  ctx.font = '600 21px system-ui, sans-serif';
  ctx.fillText(
    stats.edition === 'python'
      ? '100% on your machine. No uploads, no accounts.'
      : '100% in your browser. No uploads, no accounts.',
    MARGIN + 100,
    MARGIN + 72,
  );

  // Edition badge, top-right.
  const badge =
    stats.edition === 'python' ? 'LOCAL SERVER' : 'BROWSER EDITION';
  ctx.font = '700 19px system-ui, sans-serif';
  const badgeW = ctx.measureText(badge).width + 44;
  drawRoundRect(ctx, W - MARGIN - badgeW, MARGIN + 8, badgeW, 44, 22);
  ctx.fill();
  ctx.strokeStyle = 'rgba(240, 182, 90, 0.5)';
  ctx.lineWidth = 1.5;
  drawRoundRect(ctx, W - MARGIN - badgeW, MARGIN + 8, badgeW, 44, 22);
  ctx.stroke();
  ctx.fillStyle = BRAND_SOFT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(badge, W - MARGIN - badgeW / 2, MARGIN + 31);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // Hero stat: the percent IS the marketing number , relative savings land
  // harder than absolute bytes , with a soft glow for depth.
  const glow = ctx.createRadialGradient(320, 290, 40, 320, 290, 360);
  glow.addColorStop(0, 'rgba(166, 187, 107, 0.13)');
  glow.addColorStop(1, 'rgba(166, 187, 107, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(MARGIN - 60, 150, 760, 300);

  ctx.fillStyle = MUTED;
  ctx.font = '700 21px system-ui, sans-serif';
  ctx.fillText('S P A C E   S A V E D', MARGIN, 204);
  ctx.fillStyle = SAVED;
  ctx.font = '800 150px system-ui, sans-serif';
  ctx.fillText(`${stats.percent}%`, MARGIN - 6, 336);
  const percentWidth = ctx.measureText(`${stats.percent}%`).width;
  ctx.fillStyle = INK;
  ctx.font = '700 46px system-ui, sans-serif';
  ctx.fillText('smaller', MARGIN - 6 + percentWidth + 26, 336);

  // One-line value summary: saved bytes, image count, speed.
  const count = Number.parseInt(stats.files, 10) || 0;
  ctx.fillStyle = BRAND;
  ctx.font = '700 28px system-ui, sans-serif';
  ctx.fillText(
    `${stats.saved} saved · ${count} image${count === 1 ? '' : 's'} · ${stats.elapsed}`,
    MARGIN,
    390,
  );

  // Proportional size comparison bars , the visual proof.
  const parseBytes = (text: string): number => {
    const value = Number.parseFloat(text);
    if (Number.isNaN(value)) return 0;
    if (text.includes('GB')) return value * 1024 ** 3;
    if (text.includes('MB')) return value * 1024 ** 2;
    if (text.includes('KB')) return value * 1024;
    return value;
  };
  const originalBytes = parseBytes(stats.original);
  const webpBytes = parseBytes(stats.webp);
  const barMax = Math.max(originalBytes, webpBytes, 1);
  const barMaxWidth = W - MARGIN * 2;
  const rows: { label: string; fraction: number; fill: string | CanvasGradient }[] = [
    {
      label: `Original · ${stats.original}`,
      fraction: originalBytes / barMax,
      fill: 'rgba(216, 180, 134, 0.4)',
    },
    {
      label: `WebP · ${stats.webp}`,
      fraction: webpBytes / barMax,
      fill: strip,
    },
  ];
  rows.forEach((row, i) => {
    const labelY = 462 + i * 84;
    const barY = labelY + 14;
    ctx.fillStyle = MUTED;
    ctx.font = '700 22px system-ui, sans-serif';
    ctx.fillText(row.label, MARGIN, labelY);
    ctx.fillStyle = 'rgba(216, 180, 134, 0.1)';
    drawRoundRect(ctx, MARGIN, barY, barMaxWidth, 34, 12);
    ctx.fill();
    ctx.fillStyle = row.fill;
    drawRoundRect(ctx, MARGIN, barY, Math.max(barMaxWidth * row.fraction, 36), 34, 12);
    ctx.fill();
  });

  // CTA footer: what to do next, and where.
  ctx.strokeStyle = 'rgba(216, 180, 134, 0.16)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(MARGIN, H - 57);
  ctx.lineTo(W - MARGIN, H - 57);
  ctx.stroke();
  ctx.fillStyle = BRAND;
  ctx.font = '800 26px system-ui, sans-serif';
  ctx.fillText('Convert yours, free & private →', MARGIN, H - 21);
  ctx.textAlign = 'right';
  ctx.fillStyle = BRAND_SOFT;
  ctx.font = '700 22px system-ui, sans-serif';
  ctx.fillText('aditya-xq.github.io/PicToWebP', W - MARGIN, H - 21);
  ctx.textAlign = 'left';

  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Failed to generate image'))),
      'image/png',
    );
  });
}

/** Phones (and iPads masquerading as Macs) , the only reliable Web Share targets. */
function isMobileShareTarget(): boolean {
  return (
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  );
}

/** Copy an image blob to the clipboard so it can be pasted into any app. */
async function copyImageToClipboard(blob: Blob): Promise<boolean> {
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false;
    // Safari requires a live promise for the clipboard item value.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': Promise.resolve(blob) })]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deliver the stats card:
 * - mobile: Web Share API → OS share sheet (with a real image preview);
 * - desktop: copy the PNG to the clipboard , the share-sheet preview for
 *   files is unreliable there (often renders blank), while pasting the image
 *   straight into a post/DM always works;
 * - fallback everywhere: PNG download.
 */
export async function shareStats(stats: ShareStats, buttonId = 'share-btn'): Promise<void> {
  const btn = document.getElementById(buttonId);
  if (btn instanceof HTMLButtonElement) btn.disabled = true;
  try {
    const canvas = renderShareCanvas(stats);
    const blob = await canvasToBlob(canvas);
    const shareText = `Saved ${stats.saved} (${stats.percent}% smaller) converting to WebP. Locally, nothing uploaded.`;
    if (isMobileShareTarget() && typeof navigator.canShare === 'function') {
      const file = new File([blob], 'pictowebp-stats.png', { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: 'PicToWebP', text: shareText });
          showToast('Stats shared', 'success');
          return;
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          // Fall through to clipboard/download.
        }
      }
    }
    if (await copyImageToClipboard(blob)) {
      showToast('Stats image copied. Paste it anywhere', 'success');
      return;
    }
    triggerDownload(blob, 'pictowebp-stats.png');
    showToast('Stats image downloaded', 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Failed to generate image', 'error');
  } finally {
    if (btn instanceof HTMLButtonElement) btn.disabled = false;
  }
}
