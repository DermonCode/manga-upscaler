console.log('[MangaUpscaler Offscreen] loaded');

let session = null;
let loadedScale = null;

async function getSession(scale) {
  if (session && loadedScale === scale) return session;
  session = null;
  console.log('[MangaUpscaler Offscreen] loading model', scale + 'x...');
  const libBase = chrome.runtime.getURL('lib/');
  ort.env.wasm.wasmPaths = libBase;
  ort.env.wasm.numThreads = 1;
  const modelUrl = chrome.runtime.getURL(`models/up${scale}x-denoise3x.onnx`);
  const buf = await fetch(modelUrl).then((r) => r.arrayBuffer());
  session = await ort.InferenceSession.create(buf, {
    executionProviders: ['webgpu', 'wasm'],
  });
  loadedScale = scale;
  console.log('[MangaUpscaler Offscreen] model loaded, provider:', session.handler.executionProviders);
  return session;
}

function toTensor(data, w, h) {
  const n = w * h;
  const f32 = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    f32[i]         = data[i * 4]     / 255;
    f32[n + i]     = data[i * 4 + 1] / 255;
    f32[2 * n + i] = data[i * 4 + 2] / 255;
  }
  return new ort.Tensor('float32', f32, [1, 3, h, w]);
}

function tensorToImageData(data, w, h) {
  const n = w * h;
  const px = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    px[i * 4]     = Math.round(Math.min(1, Math.max(0, data[i]))         * 255);
    px[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, data[n + i]))     * 255);
    px[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, data[2 * n + i])) * 255);
    px[i * 4 + 3] = 255;
  }
  return new ImageData(px, w, h);
}

async function upscale(url, scale) {
  const sess = await getSession(scale);
  const SCALE = parseInt(scale);
  const TILE = 256;
  const PAD = 16;

  console.log('[MangaUpscaler Offscreen] fetching image:', url.slice(0, 60));
  const blob = await fetch(url).then((r) => r.blob());
  const blobUrl = URL.createObjectURL(blob);

  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('image load failed: ' + url));
    el.src = blobUrl;
  });

  const W = img.naturalWidth;
  const H = img.naturalHeight;
  console.log('[MangaUpscaler Offscreen] image size:', W, 'x', H);

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = W;
  srcCanvas.height = H;
  srcCanvas.getContext('2d').drawImage(img, 0, 0);
  URL.revokeObjectURL(blobUrl);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = W * SCALE;
  outCanvas.height = H * SCALE;
  const outCtx = outCanvas.getContext('2d');

  let tileCount = 0;
  const totalTiles = Math.ceil(H / TILE) * Math.ceil(W / TILE);

  for (let ty = 0; ty < H; ty += TILE) {
    for (let tx = 0; tx < W; tx += TILE) {
      const x0 = Math.max(0, tx - PAD);
      const y0 = Math.max(0, ty - PAD);
      const x1 = Math.min(W, tx + TILE + PAD);
      const y1 = Math.min(H, ty + TILE + PAD);
      const tw = x1 - x0;
      const th = y1 - y0;

      const FIXED = TILE + 2 * PAD;
      const tileCanvas2 = document.createElement('canvas');
      tileCanvas2.width = FIXED;
      tileCanvas2.height = FIXED;
      tileCanvas2.getContext('2d').drawImage(srcCanvas, x0, y0, tw, th, 0, 0, tw, th);
      const tileData = tileCanvas2.getContext('2d').getImageData(0, 0, FIXED, FIXED);
      const inputTensor = toTensor(tileData.data, FIXED, FIXED);

      const feeds = {};
      feeds[sess.inputNames[0]] = inputTensor;
      const results = await sess.run(feeds);
      const outTensor = results[sess.outputNames[0]];

      const [, , outTH, outTW] = outTensor.dims;
      const outImageData = tensorToImageData(outTensor.data, outTW, outTH);

      const tmpCanvas = document.createElement('canvas');
      tmpCanvas.width = outTW;
      tmpCanvas.height = outTH;
      tmpCanvas.getContext('2d').putImageData(outImageData, 0, 0);

      const cropX = (tx - x0) * SCALE;
      const cropY = (ty - y0) * SCALE;
      const copyW = Math.min(TILE, W - tx) * SCALE;
      const copyH = Math.min(TILE, H - ty) * SCALE;

      outCtx.drawImage(tmpCanvas, cropX, cropY, copyW, copyH, tx * SCALE, ty * SCALE, copyW, copyH);

      inputTensor.dispose();
      outTensor.dispose();

      tileCount++;
      console.log(`[MangaUpscaler Offscreen] tile ${tileCount}/${totalTiles}`);
    }
  }

  return outCanvas.toDataURL('image/webp', 0.92);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'process') return;
  console.log('[MangaUpscaler Offscreen] process request:', msg.url.slice(0, 60));
  upscale(msg.url, msg.scale)
    .then((result) => {
      chrome.runtime.sendMessage({
        type: 'processed',
        tabId: msg.tabId,
        requestId: msg.requestId,
        result,
      });
    })
    .catch((e) => {
      console.error('[MangaUpscaler Offscreen] error:', e);
      chrome.runtime.sendMessage({
        type: 'processed',
        tabId: msg.tabId,
        requestId: msg.requestId,
        error: e.message,
      });
    });
});