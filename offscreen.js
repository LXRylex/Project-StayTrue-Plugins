const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function safeName(s){
  return String(s || "").replace(/[\\/:*?"<>|]/g, "_").slice(0, 180);
}

function extFromUrl(url){
  try{
    const u = new URL(url);
    const m = u.pathname.match(/\.([a-z0-9]{2,6})$/i);
    return m ? "." + m[1].toLowerCase() : "";
  }catch{
    return "";
  }
}

function inferExt(contentType){
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("png")) return ".png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return ".jpg";
  if (ct.includes("webp")) return ".webp";
  if (ct.includes("gif")) return ".gif";
  if (ct.includes("mp4")) return ".mp4";
  return "";
}

async function fetchAsBlob(url){
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  const blob = await res.blob();
  return { blob, contentType: ct };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "ZIP_BUILD") return;

  try{ sendResponse({ ok: true }); }catch{}

  (async () => {
    const runId = msg.runId || "";
    const zipName = safeName(msg.zipName || "pinterest-media.zip");
    const folder = safeName(msg.folder || "pinterest-media");
    const items = Array.isArray(msg.items) ? msg.items : [];

    const zip = new JSZip();
    const root = zip.folder(folder);

    let added = 0;
    let failed = 0;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const url = it?.url;
      const kind = it?.kind === "vid" ? "video" : "image";
      if (!url) continue;

      try{
        const { blob, contentType } = await fetchAsBlob(url);
        const ext = extFromUrl(url) || inferExt(contentType) || (kind === "video" ? ".mp4" : ".jpg");
        const name = `${kind}_${String(i + 1).padStart(6, "0")}${ext}`;
        root.file(name, blob);
        added++;
      }catch{
        failed++;
      }

      if ((i + 1) % 30 === 0) {
        chrome.runtime.sendMessage({
          type: "ZIP_PROGRESS",
          runId,
          done: i + 1,
          total: items.length,
          added,
          failed
        }).catch(() => {});
        await sleep(0);
      }
    }

    chrome.runtime.sendMessage({
      type: "ZIP_PROGRESS",
      runId,
      done: items.length,
      total: items.length,
      added,
      failed,
      stage: "zipping"
    }).catch(() => {});

    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });

    const blobUrl = URL.createObjectURL(blob);

    chrome.runtime.sendMessage({
      type: "ZIP_READY",
      runId,
      blobUrl,
      filename: zipName.toLowerCase().endsWith(".zip") ? zipName : (zipName + ".zip"),
      added,
      failed
    }).catch(() => {});

    setTimeout(() => {
      try{ URL.revokeObjectURL(blobUrl); }catch{}
    }, 120_000);
  })();

  return true;
});