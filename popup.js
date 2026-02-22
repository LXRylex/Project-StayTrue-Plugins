const $ = (q) => document.querySelector(q);

const imgCount = $("#imgCount");
const vidCount = $("#vidCount");
const totalCount = $("#totalCount");
const statusEl = $("#status");

const btnDownload = $("#btnDownload");
const btnClear = $("#btnClear");

let activeTabId = null;
let lastRunId = null;

function setStatus(t){ statusEl.textContent = t; }

function keyForTab(tabId){ return `mg:${tabId}`; }

async function getActiveTab(){
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function renderCounts(imagesLen, videosLen){
  imgCount.textContent = String(imagesLen || 0);
  vidCount.textContent = String(videosLen || 0);
  totalCount.textContent = String((imagesLen || 0) + (videosLen || 0));
}

async function loadSaved(){
  if(!activeTabId) return;
  const k = keyForTab(activeTabId);
  const data = await chrome.storage.local.get({ [k]: { images: [], videos: [] } });
  const saved = data[k] || { images: [], videos: [] };
  renderCounts((saved.images || []).length, (saved.videos || []).length);
}

async function clearInPageSeenSets(){
  if(!activeTabId) return;
  await chrome.scripting.executeScript({
    target: { tabId: activeTabId },
    func: () => {
      try{
        if (window.__MG_SEEN_IMG) window.__MG_SEEN_IMG.clear();
        if (window.__MG_SEEN_VID) window.__MG_SEEN_VID.clear();
      }catch{}
    }
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg) => {
  // live batches
  if (msg?.type === "AUTO_SCROLL_BATCH" && msg.tabId === activeTabId) {
    loadSaved().catch(()=>{});
  }

  if (msg?.type === "AUTO_ZIP_STARTED" && msg.tabId === activeTabId) {
    lastRunId = msg.runId;
    setStatus("No new items for 2s. Packaging ZIP...");
  }

  if (msg?.type === "ZIP_PROGRESS" && msg.runId === lastRunId) {
    const done = msg.done ?? 0;
    const total = msg.total ?? 0;
    const added = msg.added ?? 0;
    const failed = msg.failed ?? 0;

    if (msg.stage === "zipping") {
      setStatus(`Zipping… added ${added}, failed ${failed}`);
    } else {
      setStatus(`Fetching… ${done}/${total} | added ${added} | failed ${failed}`);
    }
  }

  if (msg?.type === "ZIP_DONE" && msg.runId === lastRunId) {
    setStatus(`ZIP ready. Save dialog should appear. Added ${msg.added}, failed ${msg.failed}`);
    btnDownload.disabled = false;
    btnClear.disabled = false;
  }

  if (msg?.type === "ZIP_ERROR" && msg.runId === lastRunId) {
    setStatus(`ZIP download failed: ${msg.error}`);
    btnDownload.disabled = false;
    btnClear.disabled = false;
  }
});

document.addEventListener("DOMContentLoaded", async () => {
  const tab = await getActiveTab();
  activeTabId = tab?.id ?? null;

  if (!activeTabId) {
    setStatus("No active tab found.");
    btnDownload.disabled = true;
    btnClear.disabled = true;
    return;
  }

  await loadSaved();
  setStatus("Ready.");
});

btnDownload.addEventListener("click", async () => {
  if(!activeTabId) return;

  btnDownload.disabled = true;
  btnClear.disabled = true;

  setStatus("Starting auto-scroll…");

  chrome.runtime.sendMessage({
    type: "AUTO_START",
    tabId: activeTabId,
    zipName: "pinterest-media.zip",
    folder: "pinterest-media",

    stepPx: 3200,
    intervalMs: 60,
    scanEveryMs: 600,
    stallMs: 5000
  }, (res) => {
    const err = chrome.runtime.lastError;
    if (err) {
      setStatus(`Start failed: ${err.message}`);
      btnDownload.disabled = false;
      btnClear.disabled = false;
      return;
    }
    if (!res?.ok) {
      setStatus("Start failed.");
      btnDownload.disabled = false;
      btnClear.disabled = false;
      return;
    }
    setStatus("Scanning… keep the Pinterest tab open.");
  });
});

btnClear.addEventListener("click", async () => {
  if(!activeTabId) return;

  btnDownload.disabled = true;
  btnClear.disabled = true;

  setStatus("Clearing saved…");

  chrome.runtime.sendMessage({ type: "CLEAR_SAVED", tabId: activeTabId }, async () => {
    const err = chrome.runtime.lastError;
    if (err) setStatus(`Clear failed: ${err.message}`);
    else setStatus("Cleared.");

    await clearInPageSeenSets();
    await loadSaved();

    btnDownload.disabled = false;
    btnClear.disabled = false;
  });
});