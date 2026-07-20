const COLOR_MAPS = {
  viridis: [[0, 68, 1, 84], [0.25, 59, 82, 139], [0.5, 33, 145, 140], [0.75, 94, 201, 98], [1, 253, 231, 37]],
  magma: [[0, 0, 0, 4], [0.25, 80, 18, 123], [0.5, 182, 54, 121], [0.75, 251, 136, 97], [1, 252, 253, 191]],
  inferno: [[0, 0, 0, 4], [0.25, 120, 28, 109], [0.5, 182, 54, 121], [0.75, 239, 114, 0], [1, 252, 255, 164]],
  plasma: [[0, 13, 8, 135], [0.25, 126, 3, 168], [0.5, 204, 71, 120], [0.75, 248, 149, 64], [1, 240, 249, 33]],
  jet: [[0, 0, 0, 131], [0.125, 0, 60, 255], [0.375, 0, 255, 255], [0.625, 255, 255, 0], [0.875, 255, 0, 0], [1, 128, 0, 0]],
  rdylgn: [[0, 165, 0, 38], [0.5, 255, 255, 191], [1, 0, 104, 55]],
};

function interpolateColor(cmap, t) {
  if (t <= cmap[0][0]) return [cmap[0][1], cmap[0][2], cmap[0][3]];
  if (t >= cmap[cmap.length - 1][0]) return [cmap[cmap.length - 1][1], cmap[cmap.length - 1][2], cmap[cmap.length - 1][3]];
  for (let j = 0; j < cmap.length - 1; j++) {
    if (t >= cmap[j][0] && t <= cmap[j + 1][0]) {
      const lo = cmap[j], hi = cmap[j + 1];
      const r = hi[0] - lo[0] || 1;
      const f = (t - lo[0]) / r;
      return [lo[1] + (hi[1] - lo[1]) * f, lo[2] + (hi[2] - lo[2]) * f, lo[3] + (hi[3] - lo[3]) * f];
    }
  }
  return [cmap[0][1], cmap[0][2], cmap[0][3]];
}

function parseCustomColors(str) {
  if (!str) return null;
  const hexPattern = /#[0-9a-f]{6}/gi;
  const matches = str.match(hexPattern);
  if (!matches || matches.length < 2) return null;
  const cmap = [];
  matches.forEach((hex, i) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    cmap.push([i / (matches.length - 1 || 1), r, g, b]);
  });
  return cmap;
}

module.exports = { COLOR_MAPS, interpolateColor, parseCustomColors };
