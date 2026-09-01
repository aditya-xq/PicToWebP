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
}

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

/** Render the stats card as a PNG and download it. */
export function shareStats(lastStats: ShareStats): void {
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 320;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.fillStyle = '#0a0d14';
  drawRoundRect(ctx, 0, 0, 600, 320, 16);
  ctx.fill();
  ctx.strokeStyle = 'rgba(99,102,241,0.3)';
  ctx.lineWidth = 2;
  drawRoundRect(ctx, 1, 1, 598, 318, 16);
  ctx.stroke();

  const grad = ctx.createLinearGradient(0, 0, 600, 0);
  grad.addColorStop(0, 'rgba(99,102,241,0.8)');
  grad.addColorStop(1, 'rgba(139,92,246,0.6)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 600, 4);

  ctx.fillStyle = '#f1f5f9';
  ctx.font = 'bold 22px Inter, system-ui, sans-serif';
  ctx.fillText('PicToWebP', 30, 50);
  ctx.fillStyle = '#6b7280';
  ctx.font = '12px Inter, system-ui, sans-serif';
  ctx.fillText('Bulk image to WebP conversion (in your browser)', 30, 72);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.beginPath();
  ctx.moveTo(30, 90);
  ctx.lineTo(570, 90);
  ctx.stroke();

  const stats = [
    { label: 'SAVED', value: lastStats.saved, sub: `${lastStats.percent} smaller`, color: '#4ade80' },
    { label: 'FILES', value: lastStats.files, sub: 'converted', color: '#818cf8' },
    { label: 'TIME', value: lastStats.elapsed, sub: `@ Q${lastStats.quality}`, color: '#e2e8f0' },
  ];
  stats.forEach((s, i) => {
    const x = 30 + i * 190;
    ctx.fillStyle = '#9ca3af';
    ctx.font = '600 10px Inter, system-ui, sans-serif';
    ctx.fillText(s.label, x, 125);
    ctx.fillStyle = s.color;
    ctx.font = 'bold 28px Inter, system-ui, sans-serif';
    ctx.fillText(s.value, x, 162);
    ctx.fillStyle = '#6b7280';
    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.fillText(s.sub, x, 182);
  });

  ctx.beginPath();
  ctx.moveTo(30, 205);
  ctx.lineTo(570, 205);
  ctx.stroke();
  ctx.fillStyle = '#1a2030';
  drawRoundRect(ctx, 30, 225, 540, 16, 4);
  ctx.fill();
  ctx.fillStyle = '#9ca3af';
  ctx.font = '10px Inter, system-ui, sans-serif';
  ctx.fillText(`Original: ${lastStats.original}`, 30, 260);

  const barGrad = ctx.createLinearGradient(30, 0, 570, 0);
  barGrad.addColorStop(0, '#6366f1');
  barGrad.addColorStop(1, '#818cf8');
  ctx.fillStyle = barGrad;
  drawRoundRect(ctx, 30, 275, 540, 16, 4);
  ctx.fill();
  ctx.fillText(`WebP: ${lastStats.webp}`, 30, 310);

  canvas.toBlob((blob) => {
    if (!blob) {
      showToast('Failed to generate image', 'error');
      return;
    }
    triggerDownload(blob, 'pictowebp-stats.png');
    showToast('Stats image downloaded', 'success');
  }, 'image/png');
}