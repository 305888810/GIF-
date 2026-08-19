(function () {
  "use strict";

  const ANIMATED_IMAGE_RE = /(?:\.(?:gif|webp)(?:[?#].*)?$|[/?](?:gif|webp)(?:[/?#]|$)|(?:format|fm|type)=(?:gif|webp)|image\/(?:gif|webp))/i;
  const IS_HUABAN = /(^|\.)huaban\.com$/i.test(location.hostname);
  const RAW_CACHE_LIMIT = 50 * 1024 * 1024;
  const DECODED_CACHE_LIMIT = 150 * 1024 * 1024;
  const attached = new WeakSet();
  const resourceCache = new Map();
  let activeViewer = null;
  let huabanViewer = null;
  let huabanScanTimer = null;
  let currentPinId = null;
  let preloadHandle = null;
  let gifWorker = null;
  let gifWorkerRequestId = 0;
  const gifWorkerRequests = new Map();

  function isAnimatedCandidate(img) {
    if (!(img instanceof HTMLImageElement)) return false;
    const source = img.currentSrc || img.src || "";
    return ANIMATED_IMAGE_RE.test(source) || /^data:image\/(?:gif|webp)/i.test(source) || /image\/(?:gif|webp)/i.test(document.contentType);
  }

  function scan(root = document) {
    if (IS_HUABAN) {
      scheduleHuabanScan();
      return;
    }
    const images = root instanceof HTMLImageElement ? [root] : [...(root.querySelectorAll?.("img") || [])];
    images.forEach((img) => {
      if (attached.has(img)) return;
      if (isAnimatedCandidate(img)) attachViewer(img);
      else {
        img.addEventListener("mouseenter", () => {
          if (img.dataset.gifProbeDone) return;
          img.dataset.gifProbeDone = "1";
          chrome.runtime.sendMessage({ type: "probe-image", url: img.currentSrc || img.src }, (result) => {
            if (!chrome.runtime.lastError && result?.ok) attachViewer(img);
          });
        }, { once: true });
      }
    });
  }

  function scheduleHuabanScan() {
    if (huabanScanTimer) return;
    huabanScanTimer = requestAnimationFrame(() => {
      huabanScanTimer = null;
      const pinId = getPinId();
      if (currentPinId && currentPinId !== pinId) {
        huabanViewer?.destroy();
        huabanViewer = null;
        clearPinCache(currentPinId);
      }
      currentPinId = pinId;
      const modalUrl = new URL(location.href).searchParams.get("modalImg");
      if (!pinId || !modalUrl) {
        huabanViewer?.destroy();
        huabanViewer = null;
        if (pinId) schedulePinPreload(pinId);
        return;
      }
      if (huabanViewer && sameImageResource(huabanViewer.sourceUrl, modalUrl)) return;
      if (huabanViewer) {
        huabanViewer.destroy();
        huabanViewer = null;
      }
      const candidates = [...document.querySelectorAll("img")].filter((img) => sameImageResource(img.currentSrc || img.src, modalUrl));
      candidates.sort((left, right) => visibleArea(right) - visibleArea(left));
      const cachedEntry = getCacheEntry(pinId, modalUrl);
      const mainImage = cachedEntry.decoded || cachedEntry.decodePromise
        ? candidates[0]
        : candidates.find((img) => img.complete && img.naturalWidth > 0 && visibleArea(img) > 10000);
      if (mainImage && !mainImage.dataset.gifProbePending) {
        if (cachedEntry.decoded || cachedEntry.decodePromise) {
          huabanViewer = attachViewer(mainImage, { huaban: true, pinId });
          return;
        }
        mainImage.dataset.gifProbePending = "1";
        chrome.runtime.sendMessage({ type: "probe-image", url: mainImage.currentSrc || mainImage.src }, (result) => {
          delete mainImage.dataset.gifProbePending;
          if (chrome.runtime.lastError || !result?.ok || huabanViewer) return;
          const currentModal = new URL(location.href).searchParams.get("modalImg");
          if (currentModal && sameImageResource(mainImage.currentSrc || mainImage.src, currentModal)) huabanViewer = attachViewer(mainImage, { huaban: true, pinId });
        });
      }
    });
  }

  function getPinId(pathname = location.pathname) {
    return pathname.match(/^\/pins\/(\d+)(?:\/|$)/)?.[1] || null;
  }

  function canonicalImageKey(url) {
    try {
      const parsed = new URL(url, location.href);
      return `${parsed.hostname}${decodeURIComponent(parsed.pathname).replace(/_fw\d+$/i, "_fw")}`;
    } catch { return url; }
  }

  function getCacheEntry(pinId, url) {
    const key = `${pinId}:${canonicalImageKey(url)}`;
    let entry = resourceCache.get(key);
    if (!entry) {
      entry = { key, pinId, sourceUrl: url, blob: null, decoded: null, blobPromise: null, decodePromise: null, decodedBytes: 0, inUse: 0, lastUsed: Date.now(), cancelled: false };
      resourceCache.set(key, entry);
    }
    entry.lastUsed = Date.now();
    return entry;
  }

  function schedulePinPreload(pinId) {
    if (preloadHandle) return;
    const run = () => {
      preloadHandle = null;
      if (getPinId() !== pinId || new URL(location.href).searchParams.has("modalImg")) return;
      const url = findHuabanPreloadUrl(pinId);
      if (url) preloadResource(pinId, url);
    };
    if (typeof requestIdleCallback === "function") preloadHandle = requestIdleCallback(run, { timeout: 1200 });
    else preloadHandle = setTimeout(run, 500);
  }

  function findHuabanPreloadUrl(pinId) {
    const linked = [...document.querySelectorAll('a[href*="modalImg="]')].map((link) => {
      try {
        const linkUrl = new URL(link.href, location.href);
        return { url: linkUrl.searchParams.get("modalImg"), pinId: getPinId(linkUrl.pathname), area: visibleArea(link.querySelector("img") || link) };
      } catch { return null; }
    }).filter((item) => item?.url && item.pinId === pinId).sort((left, right) => right.area - left.area);
    if (linked[0]) return linked[0].url;
    const images = [...document.querySelectorAll("img")].filter((img) => /hbimg/i.test(img.currentSrc || img.src));
    images.sort((left, right) => visibleArea(right) - visibleArea(left));
    return images.find((img) => img.complete && visibleArea(img) > 10000)?.currentSrc || images[0]?.src || null;
  }

  function preloadResource(pinId, url) {
    const entry = getCacheEntry(pinId, url);
    if (entry.decoded || entry.decodePromise) return;
    probeImage(url).then((isAnimated) => {
      if (isAnimated && getPinId() === pinId) getDecodedEntry(entry).catch((error) => console.debug("GIF preload skipped:", error));
    });
  }

  function probeImage(url) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "probe-image", url }, (result) => resolve(!chrome.runtime.lastError && Boolean(result?.ok)));
    });
  }

  function sameImageResource(candidate, expected) {
    try {
      const candidateUrl = new URL(candidate, location.href);
      const expectedUrl = new URL(expected, location.href);
      return candidateUrl.hostname === expectedUrl.hostname && decodeURIComponent(candidateUrl.pathname) === decodeURIComponent(expectedUrl.pathname);
    } catch { return false; }
  }

  function visibleArea(img) {
    const rect = img.getBoundingClientRect();
    return Math.max(0, rect.width) * Math.max(0, rect.height);
  }

  function getDecodedEntry(entry) {
    entry.lastUsed = Date.now();
    if (entry.decoded) return Promise.resolve(entry.decoded);
    if (!entry.blobPromise) {
      entry.blobPromise = loadImageBlob(entry.sourceUrl).then((blob) => {
        entry.blob = blob;
        entry.lastUsed = Date.now();
        enforceCacheLimits();
        return blob;
      }).catch((error) => {
        entry.blobPromise = null;
        throw error;
      });
    }
    if (!entry.decodePromise) {
      entry.decodePromise = entry.blobPromise.then((blob) => decodeBlob(blob)).then((decoded) => {
        if (entry.cancelled) {
          disposeDecoded(decoded);
          throw new Error("预加载已取消");
        }
        entry.decoded = decoded;
        entry.decodedBytes = estimateDecodedBytes(decoded);
        entry.lastUsed = Date.now();
        enforceCacheLimits();
        return decoded;
      }).catch((error) => {
        entry.decodePromise = null;
        throw error;
      });
    }
    return entry.decodePromise;
  }

  function estimateDecodedBytes(decoded) {
    return decoded.frames.reduce((total, frame) => {
      if (frame instanceof ImageData) return total + frame.data.byteLength;
      return total + (frame.displayWidth || decoded.width) * (frame.displayHeight || decoded.height) * 4;
    }, 0);
  }

  function enforceCacheLimits() {
    const entries = [...resourceCache.values()].sort((left, right) => left.lastUsed - right.lastUsed);
    let rawBytes = entries.reduce((total, entry) => total + (entry.blob?.size || 0), 0);
    let rawCount = entries.filter((entry) => entry.blob).length;
    for (const entry of entries) {
      if (rawBytes <= RAW_CACHE_LIMIT && rawCount <= 3) break;
      if (!entry.blob || entry.inUse) continue;
      rawBytes -= entry.blob.size;
      rawCount--;
      entry.blob = null;
      entry.blobPromise = null;
    }
    let decodedBytes = entries.reduce((total, entry) => total + entry.decodedBytes, 0);
    let decodedCount = entries.filter((entry) => entry.decoded).length;
    for (const entry of entries) {
      if (decodedBytes <= DECODED_CACHE_LIMIT && decodedCount <= 1) break;
      if (!entry.decoded || entry.inUse) continue;
      decodedBytes -= entry.decodedBytes;
      decodedCount--;
      disposeDecoded(entry.decoded);
      entry.decoded = null;
      entry.decodedBytes = 0;
      entry.decodePromise = null;
    }
  }

  function disposeDecoded(decoded) {
    decoded?.frames?.forEach((frame) => frame?.close?.());
  }

  function clearPinCache(pinId) {
    for (const [key, entry] of resourceCache) {
      if (entry.pinId !== pinId) continue;
      entry.cancelled = true;
      if (!entry.inUse) disposeDecoded(entry.decoded);
      resourceCache.delete(key);
    }
    stopIdleGifWorker();
  }

  function attachViewer(img, options = {}) {
    if (attached.has(img) || !img.parentNode) return null;
    attached.add(img);
    img.dataset.gifViewerAttached = "1";
    const originalDisplay = img.style.display;
    const initialWidth = img.getBoundingClientRect().width || img.naturalWidth;
    let resizeObserver = null;
    const wrapper = document.createElement("div");
    wrapper.className = `gif-inline-viewer${options.huaban ? " is-huaban" : ""}`;
    wrapper.hidden = true;
    if (initialWidth) wrapper.style.width = `${initialWidth}px`;
    const canvas = document.createElement("canvas");
    canvas.className = "gif-inline-canvas";
    canvas.setAttribute("aria-label", "GIF / WebP 逐帧预览");
    const controls = document.createElement("div");
    controls.className = "gif-inline-controls";
    controls.innerHTML = `
      <button data-action="first" title="第一帧">|&lt;</button>
      <button data-action="prev" title="上一帧">&lt;</button>
      <button class="play" data-action="play" title="播放 / 暂停">▶</button>
      <button data-action="next" title="下一帧">&gt;</button>
      <button data-action="last" title="最后一帧">&gt;|</button>
      <span class="gif-inline-label">读取中…</span>
      <input class="gif-timeline" type="range" min="0" max="1" value="0" step="1" aria-label="播放进度" title="播放进度" disabled>
      <label class="gif-loop"><input type="checkbox" checked>循环</label>
      <label class="gif-speed">速度 <select><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="1.5">1.5×</option><option value="2">2×</option><option value="4">4×</option></select></label>`;
    img.before(wrapper);
    wrapper.append(canvas, controls);
    const state = { frames: [], durations: [], frame: 0, playing: false, loop: true, timer: null, speed: 1, width: img.naturalWidth, height: img.naturalHeight, sourceUrl: img.currentSrc || img.src, local: (img.currentSrc || img.src).startsWith("file:"), destroyed: false, cacheEntry: null };
    if (options.huaban && options.pinId) {
      state.cacheEntry = getCacheEntry(options.pinId, state.sourceUrl);
      state.cacheEntry.inUse++;
    }
    const label = controls.querySelector(".gif-inline-label");
    const play = controls.querySelector("[data-action=play]");
    const timeline = controls.querySelector(".gif-timeline");
    const context = canvas.getContext("2d");

    function render(index) {
      if (!state.frames.length) return;
      state.frame = (index + state.frames.length) % state.frames.length;
      const frame = state.frames[state.frame];
      canvas.width = state.width; canvas.height = state.height;
      if (frame instanceof ImageData) context.putImageData(frame, 0, 0);
      else context.drawImage(frame, 0, 0);
      label.textContent = `${state.kind} · 帧 ${state.frame + 1} / ${state.frames.length}`;
      timeline.value = state.frameTimes?.[state.frame] || 0;
    }
    function setPlaying(playing) {
      state.playing = playing;
      play.textContent = playing ? "Ⅱ" : "▶";
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      if (playing) scheduleNext();
    }
    function toggle() { setPlaying(!state.playing); }
    function scheduleNext() {
      if (!state.playing) return;
      let delay = state.durations[state.frame] || 100;
      if (state.local && state.loop && state.frame === state.frames.length - 1) delay = state.durations[0] || 100;
      state.timer = setTimeout(() => {
        if (!state.playing) return;
        if (state.frame === state.frames.length - 1 && !state.loop) {
          setPlaying(false);
          return;
        }
        render(state.frame + 1);
        scheduleNext();
      }, Math.max(16, delay / state.speed));
    }
    function stepFrame(delta) {
      setPlaying(false);
      render(state.frame + delta);
    }
    function bindHoldStep(button, delta) {
      let holdTimer = null;
      let repeatTimer = null;
      const stop = () => {
        if (holdTimer) clearTimeout(holdTimer);
        if (repeatTimer) clearInterval(repeatTimer);
        holdTimer = null;
        repeatTimer = null;
      };
      button.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        activeViewer = state;
        button.setPointerCapture?.(event.pointerId);
        stepFrame(delta);
        holdTimer = setTimeout(() => {
          repeatTimer = setInterval(() => stepFrame(delta), 75);
        }, 350);
      });
      button.addEventListener("pointerup", stop);
      button.addEventListener("pointercancel", stop);
      button.addEventListener("lostpointercapture", stop);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        if (event.detail === 0) stepFrame(delta);
      });
      return stop;
    }
    controls.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => {
      activeViewer = state;
      const action = button.dataset.action;
      if (action === "play") toggle();
      if (action === "first") render(0);
      if (action === "last") render(state.frames.length - 1);
    }));
    const stopPreviousRepeat = bindHoldStep(controls.querySelector("[data-action=prev]"), -1);
    const stopNextRepeat = bindHoldStep(controls.querySelector("[data-action=next]"), 1);
    controls.querySelector("select").addEventListener("change", (event) => { state.speed = Number(event.target.value); });
    controls.querySelector(".gif-loop input").addEventListener("change", (event) => { state.loop = event.target.checked; });
    timeline.addEventListener("input", (event) => {
      setPlaying(false);
      const time = Number(event.target.value);
      let frameIndex = 0;
      while (frameIndex + 1 < state.frameTimes.length && state.frameTimes[frameIndex + 1] <= time) frameIndex++;
      render(frameIndex);
    });
    state.render = render;
    state.toggle = toggle;
    state.pause = () => setPlaying(false);
    state.releaseCache = () => {
      if (!state.cacheEntry) return;
      state.cacheEntry.inUse = Math.max(0, state.cacheEntry.inUse - 1);
      state.cacheEntry.lastUsed = Date.now();
      state.cacheEntry = null;
      enforceCacheLimits();
    };
    state.destroy = () => {
      if (state.destroyed) return;
      state.destroyed = true;
      setPlaying(false);
      stopPreviousRepeat();
      stopNextRepeat();
      resizeObserver?.disconnect();
      wrapper.remove();
      img.style.display = originalDisplay;
      state.releaseCache();
      delete img.dataset.gifViewerAttached;
      attached.delete(img);
      if (activeViewer === state) activeViewer = null;
    };
    canvas.addEventListener("mouseenter", () => { activeViewer = state; });
    controls.addEventListener("mouseenter", () => { activeViewer = state; });
    if (!activeViewer) activeViewer = state;
    if (options.huaban && typeof ResizeObserver === "function" && wrapper.parentElement) {
      const updateWidth = () => {
        if (state.destroyed) return;
        const parentWidth = wrapper.parentElement?.clientWidth || state.width || initialWidth;
        const preferred = wrapper.hidden ? (img.getBoundingClientRect().width || initialWidth || state.width) : (state.width || initialWidth);
        if (preferred) wrapper.style.width = `${Math.min(preferred, parentWidth || preferred)}px`;
      };
      resizeObserver = new ResizeObserver(updateWidth);
      resizeObserver.observe(wrapper.parentElement);
      updateWidth();
      state.updateWidth = updateWidth;
    }
    const decoding = state.cacheEntry ? getDecodedEntry(state.cacheEntry) : decodeSource(state.sourceUrl, img.naturalWidth, img.naturalHeight);
    decoding.then((decoded) => {
      if (state.destroyed) return;
      state.frames = decoded.frames;
      state.durations = decoded.durations;
      state.width = decoded.width;
      state.height = decoded.height;
      state.kind = decoded.kind;
      canvas.width = state.width; canvas.height = state.height;
      let elapsed = 0;
      state.frameTimes = state.durations.map((duration) => {
        const start = elapsed;
        elapsed += duration || 100;
        return start;
      });
      state.totalDuration = elapsed;
      timeline.max = Math.max(1, elapsed - 1);
      timeline.disabled = state.frames.length < 2;
      controls.classList.add("is-ready");
      img.style.display = "none";
      wrapper.hidden = false;
      state.updateWidth?.();
      render(0);
      if (state.frames.length > 1) setPlaying(true);
    }).catch((error) => {
      if (state.destroyed) return;
      label.textContent = `无法拆分 (${error.message || "未知错误"})`;
      controls.classList.add("is-error");
      canvas.hidden = true;
      wrapper.hidden = false;
      state.releaseCache();
      console.warn("GIF Frame Viewer:", error);
    });
    return state;
  }

  async function decodeSource(url, fallbackWidth = 0, fallbackHeight = 0) {
    const blob = await loadImageBlob(url);
    return decodeBlob(blob, fallbackWidth, fallbackHeight);
  }

  async function decodeBlob(blob, fallbackWidth = 0, fallbackHeight = 0) {
    const type = /webp/i.test(blob.type) ? "image/webp" : /gif/i.test(blob.type) ? "image/gif" : "";
    if (!type) throw new Error("未知图片类型");
    const state = { frames: [], durations: [], width: fallbackWidth, height: fallbackHeight };
    state.kind = type === "image/webp" ? "WebP" : "GIF";
    if (type === "image/gif" && globalThis.gifuct) {
      try {
        return await decodeGifInWorker(blob);
      } catch (workerError) {
        console.warn("GIF worker failed", workerError);
        try {
          await decodeGifFallback(blob, state);
          return state;
        } catch (error) { console.warn("GIF fallback failed", error); }
      }
    }
    if (typeof ImageDecoder === "undefined") throw new Error("当前 Edge 未提供 ImageDecoder");
    const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type });
    const track = await decoder.tracks.ready;
    for (let i = 0; i < track.selectedTrack.frameCount; i++) {
      const result = await decoder.decode({ frameIndex: i });
      state.frames.push(result.image);
      state.durations.push(result.image.duration ? result.image.duration / 1000 : 100);
      if (!state.width) state.width = result.image.displayWidth;
      if (!state.height) state.height = result.image.displayHeight;
    }
    return state;
  }

  function getGifWorker() {
    if (gifWorker) return gifWorker;
    gifWorker = new Worker(chrome.runtime.getURL("gif-worker.js"));
    gifWorker.addEventListener("message", (event) => {
      const request = gifWorkerRequests.get(event.data?.id);
      if (!request) return;
      gifWorkerRequests.delete(event.data.id);
      if (!event.data.ok) {
        request.reject(new Error(event.data.error || "GIF Worker 解码失败"));
        return;
      }
      request.resolve({
        kind: "GIF",
        width: event.data.width,
        height: event.data.height,
        durations: event.data.durations,
        frames: event.data.frames.map((buffer) => new ImageData(new Uint8ClampedArray(buffer), event.data.width, event.data.height))
      });
      stopIdleGifWorker();
    });
    gifWorker.addEventListener("error", (event) => {
      const error = new Error(event.message || "GIF Worker 无法启动");
      for (const request of gifWorkerRequests.values()) request.reject(error);
      gifWorkerRequests.clear();
      gifWorker?.terminate();
      gifWorker = null;
    });
    return gifWorker;
  }

  async function decodeGifInWorker(blob) {
    const buffer = await blob.arrayBuffer();
    const id = ++gifWorkerRequestId;
    return new Promise((resolve, reject) => {
      gifWorkerRequests.set(id, { resolve, reject });
      try {
        getGifWorker().postMessage({ id, type: "decode", buffer }, [buffer]);
      } catch (error) {
        gifWorkerRequests.delete(id);
        reject(error);
      }
    });
  }

  function stopIdleGifWorker() {
    if (resourceCache.size || gifWorkerRequests.size || !gifWorker) return;
    gifWorker.terminate();
    gifWorker = null;
  }

  async function decodeGifFallback(blob, state) {
    const bytes = await blob.arrayBuffer();
    const gif = gifuct.parseGIF(bytes);
    const frames = gifuct.decompressFrames(gif, true);
    state.width = gif.lsd.width; state.height = gif.lsd.height;
    const scratch = document.createElement("canvas");
    scratch.width = state.width; scratch.height = state.height;
    const ctx = scratch.getContext("2d");
    const patchCanvas = document.createElement("canvas");
    const patchContext = patchCanvas.getContext("2d");
    frames.forEach((frame) => {
      const restore = frame.disposalType === 3 ? ctx.getImageData(0, 0, state.width, state.height) : null;
      patchCanvas.width = frame.dims.width;
      patchCanvas.height = frame.dims.height;
      patchContext.putImageData(new ImageData(frame.patch, frame.dims.width, frame.dims.height), 0, 0);
      ctx.drawImage(patchCanvas, frame.dims.left, frame.dims.top);
      state.frames.push(ctx.getImageData(0, 0, state.width, state.height));
      state.durations.push(Math.max(20, frame.delay || 100));
      if (frame.disposalType === 2) ctx.clearRect(frame.dims.left, frame.dims.top, frame.dims.width, frame.dims.height);
      if (frame.disposalType === 3 && restore) ctx.putImageData(restore, 0, 0);
    });
    if (!state.frames.length) throw new Error("GIF 没有可显示的帧");
  }

  function loadImageBlob(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "read-image", url }, (result) => {
        if (!chrome.runtime.lastError && result?.ok) {
          if (result.encoding !== "base64" || typeof result.data !== "string") {
            reject(new Error("后台返回了无效的图片数据"));
            return;
          }
          const binary = atob(result.data);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
          resolve(new Blob([bytes], { type: result.contentType || "image/gif" }));
          return;
        }
        // file:// 页面在部分 Edge 版本中只能由页面自身读取，作为后台读取的回退。
        fetch(url).then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.blob();
        }).then(resolve).catch(() => reject(new Error(result?.error || "读取图片失败")));
      });
    });
  }

  document.addEventListener("keydown", (event) => {
    if (!activeViewer?.frames.length) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
    if (event.code === "Space") {
      event.preventDefault();
      activeViewer.toggle();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      activeViewer.pause();
      activeViewer.render(activeViewer.frame + (event.key === "ArrowLeft" ? -1 : 1));
    }
  });

  scan();
  window.addEventListener("popstate", scan);
  window.addEventListener("hashchange", scan);
  if (IS_HUABAN && globalThis.navigation) globalThis.navigation.addEventListener("currententrychange", scheduleHuabanScan);
  if (IS_HUABAN && !globalThis.navigation) {
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      scheduleHuabanScan();
    }, 1500);
  }
  new MutationObserver((records) => {
    if (IS_HUABAN) {
      scheduleHuabanScan();
      return;
    }
    records.forEach((record) => record.addedNodes.forEach((node) => { if (node.nodeType === 1) scan(node); }));
  }).observe(document.documentElement, IS_HUABAN
    ? { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srcset"] }
    : { childList: true, subtree: true });
})();
