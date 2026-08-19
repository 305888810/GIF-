importScripts("vendor/gifuct-js.js");

self.onmessage = (event) => {
  const { id, type, buffer } = event.data || {};
  if (type !== "decode" || !buffer) return;
  try {
    const gif = gifuct.parseGIF(buffer);
    const sourceFrames = gifuct.decompressFrames(gif, true);
    const width = gif.lsd.width;
    const height = gif.lsd.height;
    const canvas = new Uint8ClampedArray(width * height * 4);
    const frames = [];
    const durations = [];

    for (const frame of sourceFrames) {
      const restore = frame.disposalType === 3 ? canvas.slice() : null;
      compositePatch(canvas, width, height, frame.patch, frame.dims);
      const snapshot = canvas.slice();
      frames.push(snapshot.buffer);
      durations.push(Math.max(20, frame.delay || 100));
      if (frame.disposalType === 2) clearRect(canvas, width, height, frame.dims);
      if (frame.disposalType === 3 && restore) canvas.set(restore);
    }

    self.postMessage({ id, ok: true, width, height, frames, durations }, frames);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) });
  }
};

function compositePatch(canvas, canvasWidth, canvasHeight, patch, dims) {
  for (let y = 0; y < dims.height; y++) {
    const targetY = dims.top + y;
    if (targetY < 0 || targetY >= canvasHeight) continue;
    for (let x = 0; x < dims.width; x++) {
      const targetX = dims.left + x;
      if (targetX < 0 || targetX >= canvasWidth) continue;
      const source = (y * dims.width + x) * 4;
      const alpha = patch[source + 3];
      if (!alpha) continue;
      const target = (targetY * canvasWidth + targetX) * 4;
      if (alpha === 255) {
        canvas[target] = patch[source];
        canvas[target + 1] = patch[source + 1];
        canvas[target + 2] = patch[source + 2];
        canvas[target + 3] = 255;
        continue;
      }
      const ratio = alpha / 255;
      const inverse = 1 - ratio;
      canvas[target] = Math.round(patch[source] * ratio + canvas[target] * inverse);
      canvas[target + 1] = Math.round(patch[source + 1] * ratio + canvas[target + 1] * inverse);
      canvas[target + 2] = Math.round(patch[source + 2] * ratio + canvas[target + 2] * inverse);
      canvas[target + 3] = Math.round(alpha + canvas[target + 3] * inverse);
    }
  }
}

function clearRect(canvas, canvasWidth, canvasHeight, dims) {
  const left = Math.max(0, dims.left);
  const top = Math.max(0, dims.top);
  const right = Math.min(canvasWidth, dims.left + dims.width);
  const bottom = Math.min(canvasHeight, dims.top + dims.height);
  for (let y = top; y < bottom; y++) {
    canvas.fill(0, (y * canvasWidth + left) * 4, (y * canvasWidth + right) * 4);
  }
}
