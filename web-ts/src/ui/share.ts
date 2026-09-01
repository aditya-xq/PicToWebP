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
  /** Which engine produced the stats — the card copy adapts. */
  edition?: 'browser' | 'python';
}

const W = 1200;
const H = 630;

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

function renderCanvas(stats: ShareStats): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  // Card background + border + accent top strip.
  ctx.fillStyle = '#0a0d14';
  drawRoundRect(ctx, 0, 0, W, H, 28);
  ctx.fill();
  ctx.strokeStyle = 'rgba(99, 102, 241, 0.35)';
  ctx.lineWidth = 2;
  drawRoundRect(ctx, 1, 1, W - 2, H - 2, 28);
  ctx.stroke();
  const strip = ctx.createLinearGradient(0, 0, W, 0);
  strip.addColorStop(0, '#6366f1');
  strip.addColorStop(0.55, '#8b5cf6');
  strip.addColorStop(1, '#d946ef');
  ctx.fillStyle = strip;
  drawRoundRect(ctx, 28, 0, W - 56, 6, 3);
  ctx.fill();

  // Brand mark.
  const mark = ctx.createLinearGradient(56, 56, 120, 120);
  mark.addColorStop(0, '#818cf8');
  mark.addColorStop(1, '#d946ef');
  ctx.fillStyle = mark;
  drawRoundRect(ctx, 56, 52, 64, 64, 18);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 36px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('P', 88, 86);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = '#f8fafc';
  ctx.font = '800 40px system-ui, sans-serif';
  ctx.fillText('PicToWebP', 140, 88);
  ctx.fillStyle = '#8391a8';
  ctx.font = '600 20px system-ui, sans-serif';
  ctx.fillText(
    stats.edition === 'python'
      ? 'Converted locally on this machine — nothing uploaded'
      : 'Converted 100% in the browser — nothing uploaded',
    140,
    118,
  );

  // Hero stat: space saved.
  ctx.fillStyle = '#8391a8';
  ctx.font = '700 18px system-ui, sans-serif';
  ctx.fillText('S P A C E   S A V E D', 56, 196);
  ctx.fillStyle = '#4ade80';
  ctx.font = '800 96px system-ui, sans-serif';
  ctx.fillText(stats.saved, 56, 288);
  ctx.fillStyle = '#a7f3d0';
  ctx.font = '700 30px system-ui, sans-serif';
  ctx.fillText(`${stats.percent} smaller`, 56, 332);

  // Secondary stats, right-aligned column.
  const secondary: { label: string; value: string }[] = [
    { label: 'FILES CONVERTED', value: stats.files },
    { label: 'TIME', value: `${stats.elapsed} @ Q${stats.quality}` },
  ];
  secondary.forEach((s, i) => {
    const y = 190 + i * 78;
    ctx.fillStyle = '#8391a8';
    ctx.font = '700 16px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(s.label, W - 56, y);
    ctx.fillStyle = '#f1f5f9';
    ctx.font = '800 38px system-ui, sans-serif';
    ctx.fillText(s.value, W - 56, y + 44);
  });
  ctx.textAlign = 'left';

  // Proportional size comparison bars.
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
  const barX = 56;
  const barMaxWidth = W - 112;
  const rows: { label: string; fraction: number; fill: string | CanvasGradient }[] = [
    {
      label: `Original · ${stats.original}`,
      fraction: originalBytes / barMax,
      fill: 'rgba(148, 163, 184, 0.35)',
    },
    {
      label: `WebP · ${stats.webp}`,
      fraction: webpBytes / barMax,
      fill: strip,
    },
  ];
  rows.forEach((row, i) => {
    const y = 396 + i * 76;
    ctx.fillStyle = '#8391a8';
    ctx.font = '600 18px system-ui, sans-serif';
    ctx.fillText(row.label, barX, y - 10);
    ctx.fillStyle = 'rgba(148, 163, 184, 0.12)';
    drawRoundRect(ctx, barX, y, barMaxWidth, 30, 10);
    ctx.fill();
    ctx.fillStyle = row.fill;
    drawRoundRect(ctx, barX, y, Math.max(barMaxWidth * row.fraction, 30), 30, 10);
    ctx.fill();
  });

  // Footer.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(56, H - 74);
  ctx.lineTo(W - 56, H - 74);
  ctx.stroke();
  ctx.fillStyle = '#64748b';
  ctx.font = '600 18px system-ui, sans-serif';
  ctx.fillText('Runs offline · No uploads · EXIF & GPS stripped', 56, H - 36);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#a5b4fc';
  ctx.fillText('aditya-xq.github.io/PicToWebP', W - 56, H - 36);
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

/**
 * Share the stats card: Web Share API where available (mobile share sheets),
 * falling back to a PNG download. The image itself contains no user data —
 * only aggregate sizes/counts.
 */
export async function shareStats(stats: ShareStats): Promise<void> {
  const btn = document.getElementById('share-btn');
  if (btn instanceof HTMLButtonElement) btn.disabled = true;
  try {
    const canvas = renderCanvas(stats);
    const blob = await canvasToBlob(canvas);
    const file = new File([blob], 'pictowebp-stats.png', { type: 'image/png' });
    if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          title: 'PicToWebP',
          text: `Saved ${stats.saved} (${stats.percent} smaller) converting to WebP — locally, nothing uploaded.`,
        });
        showToast('Stats shared', 'success');
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // Fall through to download.
      }
    }
    triggerDownload(blob, 'pictowebp-stats.png');
    showToast('Stats image downloaded', 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Failed to generate image', 'error');
  } finally {
    if (btn instanceof HTMLButtonElement) btn.disabled = false;
  }
}
