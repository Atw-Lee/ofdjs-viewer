/** OFD abbreviated paths: S/M start, L line, Q quadratic, B cubic, A arc, C close. */
type PathSink = Pick<CanvasRenderingContext2D, 'moveTo' | 'lineTo' | 'quadraticCurveTo' | 'bezierCurveTo' | 'closePath' | 'ellipse'> & { beginPath?: () => void };
export function drawPath(ctx: PathSink, data: string): void {
  const tokens = data.match(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) ?? [];
  let i = 0, x = 0, y = 0, sx = 0, sy = 0;
  const n = () => { const v = Number(tokens[i++]); if (!Number.isFinite(v)) throw new Error('Invalid OFD path operand'); return v; };
  ctx.beginPath?.();
  while (i < tokens.length) {
    const command = tokens[i++];
    switch (command) {
      case 'S': case 'M': x = n(); y = n(); sx = x; sy = y; ctx.moveTo(x, y); break;
      case 'L': x = n(); y = n(); ctx.lineTo(x, y); break;
      case 'Q': { const a = n(), b = n(); x = n(); y = n(); ctx.quadraticCurveTo(a, b, x, y); break; }
      case 'B': { const a = n(), b = n(), c = n(), d = n(); x = n(); y = n(); ctx.bezierCurveTo(a, b, c, d, x, y); break; }
      case 'A': { const rx = n(), ry = n(), angle = n(), large = n(), sweep = n(), nx = n(), ny = n(); arc(ctx, x, y, rx, ry, angle, !!large, !!sweep, nx, ny); x = nx; y = ny; break; }
      case 'C': ctx.closePath(); x = sx; y = sy; break;
      default: throw new Error(`Unsupported OFD path command: ${command}`);
    }
  }
}
function arc(ctx: PathSink, x1: number, y1: number, rx: number, ry: number, angle: number, large: boolean, sweep: boolean, x2: number, y2: number) {
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (x1 === x2 && y1 === y2) return;
  if (!rx || !ry) { ctx.lineTo(x2, y2); return; }
  const phi = angle * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const xp = cos * (x1 - x2) / 2 + sin * (y1 - y2) / 2, yp = -sin * (x1 - x2) / 2 + cos * (y1 - y2) / 2;
  const lambda = xp * xp / (rx * rx) + yp * yp / (ry * ry);
  if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp) / (rx * rx * yp * yp + ry * ry * xp * xp)));
  const cxp = k * rx * yp / ry, cyp = -k * ry * xp / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const start = Math.atan2((yp - cyp) / ry, (xp - cxp) / rx);
  let delta = Math.atan2((-yp - cyp) / ry, (-xp - cxp) / rx) - start;
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  ctx.ellipse(cx, cy, rx, ry, phi, start, start + delta, !sweep);
}
