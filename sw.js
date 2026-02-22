const runningTabs = new Set();
const pending = new Map();  
const tabConfig = new Map(); 
const keyForTab = (id) => `mg:${id}`;

function uniq(arr){
  const s = new Set();
  const out = [];
  for(const x of arr || []){
    if(!x) continue;
    const k = String(x);
    if(s.has(k)) continue;
    s.add(k);
    out.push(k);
  }
  return out;
}
function mergeResults(a,b){
  return {
    images: uniq([...(a.images||[]), ...(b.images||[])]),
    videos: uniq([...(a.videos||[]), ...(b.videos||[])])
  };
}

function downloadsDownload(opts){
  return new Promise((resolve, reject) => {
    chrome.downloads.download(opts, (downloadId) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message || "downloads.download failed"));
      if (!downloadId) return reject(new Error("downloads.download returned no id"));
      resolve(downloadId);
    });
  });
}

async function flush(tabId){
  const p = pending.get(tabId);
  if(!p) return;

  const images = Array.from(p.images);
  const videos = Array.from(p.videos);

  p.images.clear();
  p.videos.clear();
  if(p.timer) clearTimeout(p.timer);
  p.timer = null;

  const k = keyForTab(tabId);
  const data = await chrome.storage.local.get({ [k]: { images: [], videos: [] } });
  const merged = mergeResults(data[k], { images, videos });
  await chrome.storage.local.set({ [k]: merged });

  chrome.runtime.sendMessage({ type: "AUTO_SCROLL_BATCH", tabId, images, videos }).catch(()=>{});
}

function queue(tabId, images, videos){
  let p = pending.get(tabId);
  if(!p){
    p = { images: new Set(), videos: new Set(), timer: null };
    pending.set(tabId, p);
  }
  for(const u of images || []) p.images.add(u);
  for(const u of videos || []) p.videos.add(u);

  if(!p.timer){
    p.timer = setTimeout(() => flush(tabId), 900);
  }
}

async function injectAutoScroller(tabId, opts){
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (opts) => {
      if (window.__MG_AUTO_RUNNING) {
        window.__MG_AUTO_ENABLED = true;
        return;
      }

      window.__MG_AUTO_ENABLED = true;
      window.__MG_AUTO_RUNNING = true;

      window.__MG_SEEN_IMG = window.__MG_SEEN_IMG || new Set();
      window.__MG_SEEN_VID = window.__MG_SEEN_VID || new Set();

      const abs = (u) => { try { return new URL(u, location.href).toString(); } catch { return null; } };

      const pickBestFromSrcset = (srcset) => {
        if (!srcset) return null;
        const parts = srcset.split(",").map(s => s.trim()).filter(Boolean);
        const candidates = [];
        for (const p of parts) {
          const m = p.match(/^(\S+)\s+(\d+)(x|w)$/i);
          if (!m) continue;
          candidates.push({ url: m[1], n: Number(m[2]) });
        }
        if (!candidates.length) {
          const first = parts[0]?.split(/\s+/)[0];
          return first ? abs(first) : null;
        }
        const originals = candidates.find(c => c.url.includes("/originals/"));
        if (originals) return abs(originals.url);
        candidates.sort((a,b)=> b.n - a.n);
        return abs(candidates[0].url);
      };

      const grabNew = () => {
        const newImages = [];
        const newVideos = [];

        const pinCards = document.querySelectorAll('[data-test-id="pin"]');
        pinCards.forEach(card => {
          const img = card.querySelector("img");
          if (img) {
            const best = pickBestFromSrcset(img.getAttribute("srcset")) || abs(img.currentSrc || img.src);
            if (best && !window.__MG_SEEN_IMG.has(best)) {
              window.__MG_SEEN_IMG.add(best);
              newImages.push(best);
            }
          }
          const vid = card.querySelector("video");
          if (vid) {
            const v = abs(vid.currentSrc || vid.src);
            if (v && !window.__MG_SEEN_VID.has(v)) {
              window.__MG_SEEN_VID.add(v);
              newVideos.push(v);
            }
          }
        });

        return { images: newImages, videos: newVideos };
      };

      const sleep = (ms) => new Promise(r => setTimeout(r, ms));

      (async () => {
        const stepPx     = Math.max(400, Number(opts.stepPx) || 2600);
        const intervalMs = Math.max(40,  Number(opts.intervalMs) || 90);
        const scanEvery  = Math.max(200, Number(opts.scanEveryMs) || 700);
        const stallMs    = Math.max(500, Number(opts.stallMs) || 2000);

        let lastScan = 0;
        let lastNewAt = Date.now();

        try { window.scrollTo(0, 0); } catch {}

        while (window.__MG_AUTO_ENABLED) {
          const now = Date.now();

          if (now - lastScan >= scanEvery) {
            lastScan = now;

            const r = grabNew();
            if ((r.images.length + r.videos.length) > 0) {
              lastNewAt = Date.now();
              chrome.runtime.sendMessage({ type: "AUTO_SCROLL_BATCH", images: r.images, videos: r.videos }).catch(()=>{});
            }

            if (Date.now() - lastNewAt > stallMs) {
              window.__MG_AUTO_ENABLED = false;
              chrome.runtime.sendMessage({ type: "AUTO_STALL" }).catch(()=>{});
              break;
            }
          }

          window.scrollBy(0, stepPx);
          if ((Math.random() * 100) < 10) window.scrollTo(0, document.body.scrollHeight);
          await sleep(intervalMs);
        }

        window.__MG_AUTO_RUNNING = false;
      })();
    },
    args: [opts]
  });
}

async function stopAutoScroller(tabId){
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => { window.__MG_AUTO_ENABLED = false; }
  }).catch(()=>{});
}

// ---------- Offscreen ZIP ----------
async function ensureOffscreen(){
  try{
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Create ZIP blob URL using DOM APIs, then download from SW."
    });
  }catch{
  }
}

async function autoZipTab(tabId){
  await stopAutoScroller(tabId);
  await flush(tabId);

  const k = keyForTab(tabId);
  const data = await chrome.storage.local.get({ [k]: { images: [], videos: [] } });

  const saved = data[k] || { images: [], videos: [] };
  const cfg = tabConfig.get(tabId) || {};

  const zipName = (cfg.zipName || "pinterest-media.zip");
  const folder  = (cfg.folder  || "pinterest-media");

  const items = [
    ...(saved.images || []).map(u => ({ url: u, kind: "img" })),
    ...(saved.videos || []).map(u => ({ url: u, kind: "vid" }))
  ];

  if(!items.length) return;

  const runId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  chrome.runtime.sendMessage({ type: "AUTO_ZIP_STARTED", tabId, runId }).catch(()=>{});

  await ensureOffscreen();
  chrome.runtime.sendMessage({ type: "ZIP_BUILD", runId, zipName, folder, items });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  runningTabs.delete(tabId);
  pending.delete(tabId);
  tabConfig.delete(tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {

    if (msg?.type === "ZIP_READY") {
      const { runId, blobUrl, filename, added, failed } = msg;

      try{
        const downloadId = await downloadsDownload({
          url: blobUrl,
          filename: filename || "pinterest-media.zip",
          saveAs: true,
          conflictAction: "uniquify"
        });

        chrome.runtime.sendMessage({ type: "ZIP_DONE", runId, added, failed, downloadId }).catch(()=>{});
      }catch(e){
        chrome.runtime.sendMessage({ type: "ZIP_ERROR", runId, error: String(e?.message || e) }).catch(()=>{});
      }
      return;
    }

    if (msg?.type === "AUTO_SCROLL_BATCH") {
      const tabId = sender?.tab?.id;
      if(!tabId) return;
      queue(tabId, msg.images || [], msg.videos || []);
      return;
    }

    if (msg?.type === "AUTO_STALL") {
      const tabId = sender?.tab?.id;
      if(!tabId) return;
      if(!runningTabs.has(tabId)) return;
      runningTabs.delete(tabId);
      await autoZipTab(tabId);
      return;
    }

    if (msg?.type === "AUTO_START") {
      const tabId = Number(msg.tabId);
      runningTabs.add(tabId);
      tabConfig.set(tabId, { zipName: msg.zipName, folder: msg.folder });

      await injectAutoScroller(tabId, {
        stepPx: msg.stepPx,
        intervalMs: msg.intervalMs,
        scanEveryMs: msg.scanEveryMs,
        stallMs: msg.stallMs
      });

      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "AUTO_STOP") {
      const tabId = Number(msg.tabId);
      runningTabs.delete(tabId);
      await stopAutoScroller(tabId);
      await flush(tabId);
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "CLEAR_SAVED") {
      const tabId = Number(msg.tabId);

      runningTabs.delete(tabId);
      await stopAutoScroller(tabId);

      pending.delete(tabId);
      tabConfig.delete(tabId);

      const k = keyForTab(tabId);
      await chrome.storage.local.remove(k);

      sendResponse({ ok: true });
      return;
    }
  })().catch((e) => {
    console.error(e);
    try{ sendResponse({ ok:false, error:String(e?.message||e) }); }catch{}
  });

  return true;
});