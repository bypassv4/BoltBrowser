const tabsContainer = document.getElementById("tabs");
const viewport = document.getElementById("viewport");
const newTabButton = document.getElementById("new-tab");
const urlForm = document.getElementById("url-form");
const urlInput = document.getElementById("url-input");
const backButton = document.getElementById("back");
const forwardButton = document.getElementById("forward");
const reloadButton = document.getElementById("reload");
const statusText = document.getElementById("status-text");
const statusIndicator = document.getElementById("status-indicator");

let tabCounter = 0;
const tabs = new Map();
let activeTabId = null;
let zoomLevel = 1;

let scramjetController = null;
let bareConnection = null;
const SEARCH_TEMPLATE = "https://www.google.com/search?q=%s";

const proxyReady = setupProxy().catch((err) => {
  console.error("Failed to initialize proxy", err);
  setStatus("Proxy failed to start.", "idle");
});

const START_PAGE = `
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    :root {
      --blue: #1f4dd6;
      --ink: #0f172a;
      --muted: #516077;
      --yellow: #f6c23e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: linear-gradient(135deg, #f5f8ff, #dbe8ff);
      display: grid;
      place-items: center;
      font-family: "Sora", "Segoe UI", system-ui, sans-serif;
      color: var(--ink);
    }
    .card {
      background: #fff;
      padding: 28px 30px;
      border-radius: 14px;
      max-width: 760px;
      box-shadow: 0 16px 36px rgba(12, 28, 63, 0.12);
      border: 1px solid #d7e5ff;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      border-radius: 999px;
      background: var(--blue-50);
      color: var(--blue);
      border: 1px solid #d7e5ff;
      font-weight: 700;
      font-size: 13px;
    }
    h1 { margin: 14px 0 6px; font-size: 26px; }
    p { margin: 0 0 12px; color: var(--muted); line-height: 1.6; }
    ul { padding-left: 18px; color: var(--ink); line-height: 1.6; margin: 0; }
    li strong { color: var(--blue); }
  </style>
</head>
<body>
  <div class="card">
    <div class="chip">BoltProxy mini start page</div>
    <h1>Open a tab and start browsing</h1>
    <p>Drop in any link. Everything loads inside this window through the proxy (handy for Discord QR and captchas).</p>
    <ul>
      <li><strong>Tabs up top</strong>: click + to create, A- to close.</li>
      <li><strong>Address bar</strong>: paste full URLs or just a domain.</li>
      <li><strong>Stay inside</strong>: navigation stays in the embedded frame.</li>
    </ul>
  </div>
</body>
</html>
`;

async function setupProxy() {
  setStatus("Initializing proxy...", "loading");
  const { ScramjetController } = $scramjetLoadController();
  scramjetController = new ScramjetController({
    files: {
      wasm: "/scram/scramjet.wasm.wasm",
      all: "/scram/scramjet.all.js",
      sync: "/scram/scramjet.sync.js"
    }
  });
  scramjetController.init();

  await registerSW();
  bareConnection = new BareMux.BareMuxConnection("/baremux/worker.js");
  await ensureTransport();
  setStatus("Proxy ready.", "live");
}

async function ensureTransport() {
  if (!bareConnection) return;
  const current = await bareConnection.getTransport();
  if (current === "/epoxy/index.mjs") return;

  const wispUrl =
    (location.protocol === "https:" ? "wss" : "ws") +
    "://" +
    location.host +
    "/wisp/";
  await bareConnection.setTransport("/epoxy/index.mjs", [{ wisp: wispUrl }]);
}

function ensureProtocol(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed;
  return "https://" + trimmed;
}

function normalizeInput(rawInput) {
  const trimmed = (rawInput || "").trim();
  if (!trimmed) return "";
  if (typeof search === "function") {
    return search(trimmed, SEARCH_TEMPLATE);
  }
  return ensureProtocol(trimmed);
}

function decodeUrl(url) {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

function displayUrlFromFrame(rawUrl) {
  if (!rawUrl) return "";
  try {
    const parsed = new URL(rawUrl, window.location.origin);
    const marker = "/scramjet/";
    const idx = parsed.href.indexOf(marker);
    if (idx !== -1) {
      const targetPart = parsed.href.slice(idx + marker.length);
      if (targetPart) return decodeUrl(targetPart);
    }
    return parsed.href;
  } catch {
    return decodeUrl(rawUrl);
  }
}

function applyZoom(tab) {
  if (!tab || !tab.iframe) return;
  const scale = zoomLevel;
  const widthPercent = (1 / scale) * 100;
  tab.iframe.style.transform = `scale(${scale})`;
  tab.iframe.style.transformOrigin = "0 0";
  tab.iframe.style.width = widthPercent + "%";
  tab.iframe.style.height = widthPercent + "%";
}

function setZoom(next) {
  zoomLevel = Math.min(3, Math.max(0.5, next));
  tabs.forEach((tab) => applyZoom(tab));
}

function setStatus(text, mode = "idle") {
  if (!statusText || !statusIndicator) return;
  statusText.textContent = text;
  statusIndicator.classList.remove("active", "live");
  if (mode === "loading") statusIndicator.classList.add("active");
  if (mode === "live") statusIndicator.classList.add("live");
}

function updateTabLabel(tab, url) {
  const labelEl = tab.element.querySelector(".tab__title");
  let nextLabel = "New Tab";
  if (url) {
    try {
      nextLabel = new URL(url).hostname;
    } catch {
      nextLabel = url;
    }
  }
  labelEl.textContent = nextLabel || "Tab";
}

function getFrameUrl(tab) {
  try {
    return tab.iframe.contentWindow?.location?.href || tab.iframe.src;
  } catch {
    return tab.iframe.src;
  }
}

function setStartPage(tab) {
  tab.targetUrl = null;
  tab.iframe.removeAttribute("src");
  tab.iframe.srcdoc = START_PAGE;
  updateTabLabel(tab, "");
  applyZoom(tab);
}

function wireIframe(tab) {
  tab.iframe.addEventListener("load", () => {
    const current = getFrameUrl(tab) || tab.targetUrl;
    const displayUrl = displayUrlFromFrame(current);
    tab.element.classList.remove("loading");
    setStatus("Loaded", "live");
    updateTabLabel(tab, displayUrl);
    tab.targetUrl = displayUrl || tab.targetUrl;
    if (tab.id === activeTabId && displayUrl) {
      urlInput.value = displayUrl;
    }
  });
}

function createProxiedFrame() {
  if (scramjetController) {
    return scramjetController.createFrame();
  }

  const fallbackFrame = document.createElement("iframe");
  return {
    frame: fallbackFrame,
    go: (url) => {
      fallbackFrame.src = ensureProtocol(url);
      return Promise.resolve();
    }
  };
}

async function createTab(initialUrl) {
  await proxyReady;
  const id = `tab-${++tabCounter}`;
  const tabEl = document.createElement("button");
  tabEl.type = "button";
  tabEl.className = "tab";
  tabEl.innerHTML = `
    <span class="tab__title">New Tab</span>
    <span class="tab__close" aria-label="Close tab">A-</span>
  `;

  const frame = createProxiedFrame();
  const iframe = frame.frame;
  iframe.className = "page-frame";
  iframe.setAttribute("title", "Tab content");
  iframe.setAttribute(
    "allow",
    [
      "geolocation",
      "microphone",
      "camera",
      "clipboard-read",
      "clipboard-write",
      "autoplay",
      "payment",
      "display-capture"
    ].join("; ")
  );

  const tab = { id, element: tabEl, frame, iframe, targetUrl: null };
  tabs.set(id, tab);

  tabEl.addEventListener("click", () => setActiveTab(id));
  tabEl.querySelector(".tab__close").addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(id);
  });

  viewport.appendChild(iframe);
  tabsContainer.appendChild(tabEl);
  wireIframe(tab);
  setActiveTab(id);
  setStartPage(tab);

  if (initialUrl) {
    navigateTo(id, initialUrl);
  }

  return id;
}

function setActiveTab(id) {
  if (!tabs.has(id)) return;
  activeTabId = id;

  tabs.forEach((tab) => {
    const isActive = tab.id === id;
    tab.element.classList.toggle("active", isActive);
    tab.iframe.classList.toggle("active", isActive);
  });

  const tab = tabs.get(id);
  const display = tab?.targetUrl ? displayUrlFromFrame(tab.targetUrl) : "";
  urlInput.value = display || "";
  setStatus(display ? "Focused on active tab." : "Ready to browse.", display ? "live" : "idle");
  applyZoom(tab);

  backButton.disabled = false;
  forwardButton.disabled = false;
  reloadButton.disabled = false;
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  const wasActive = activeTabId === id;

  tab.element.remove();
  tab.iframe.remove();
  tabs.delete(id);

  if (!tabs.size) {
    createTab();
    return;
  }

  if (wasActive) {
    const lastId = Array.from(tabs.keys()).pop();
    if (lastId) setActiveTab(lastId);
  }
}

async function navigateTo(tabId, rawInput) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const target = normalizeInput(rawInput);
  if (!target) return;

  await ensureTransport();
  tab.targetUrl = target;
  tab.element.classList.add("loading");
  tab.iframe.removeAttribute("srcdoc");
  setStatus("Loading...", "loading");

  try {
    await tab.frame.go(target);
  } catch (err) {
    console.warn("Navigation failed", err);
    setStatus("Navigation failed.", "idle");
    tab.element.classList.remove("loading");
    return;
  }

  if (tab.id === activeTabId) {
    urlInput.value = decodeUrl(target);
  }
  applyZoom(tab);
  updateTabLabel(tab, decodeUrl(target));
}

async function handleNavSubmit(event) {
  event.preventDefault();
  const value = urlInput.value.trim();
  if (!value) return;
  if (!activeTabId) {
    await createTab(value);
    return;
  }
  await navigateTo(activeTabId, value);
}

function tryAction(fn) {
  try {
    fn();
  } catch (err) {
    console.warn("Navigation action failed", err);
  }
}

function registerNavButtons() {
  backButton.addEventListener("click", () => {
    const tab = tabs.get(activeTabId);
    if (!tab) return;
    setStatus("Going back...", "loading");
    tryAction(() => tab.iframe.contentWindow?.history.back());
  });

  forwardButton.addEventListener("click", () => {
    const tab = tabs.get(activeTabId);
    if (!tab) return;
    setStatus("Going forward...", "loading");
    tryAction(() => tab.iframe.contentWindow?.history.forward());
  });

  reloadButton.addEventListener("click", () => {
    const tab = tabs.get(activeTabId);
    if (!tab) return;
    setStatus("Reloading tab...", "loading");
    if (tab.targetUrl) {
      tab.element.classList.add("loading");
      tab.iframe.removeAttribute("srcdoc");
      tryAction(() => tab.frame.go(tab.targetUrl));
    } else {
      tryAction(() => tab.iframe.contentWindow?.location.reload());
    }
  });
}

function handleZoomShortcut(event) {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (["=", "+", "Add"].includes(event.key)) {
    event.preventDefault();
    setZoom(zoomLevel + 0.1);
  } else if (["-", "_", "Subtract"].includes(event.key)) {
    event.preventDefault();
    setZoom(zoomLevel - 0.1);
  } else if (event.key === "0") {
    event.preventDefault();
    setZoom(1);
  }
}

function handleWheelZoom(event) {
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    const delta = event.deltaY < 0 ? 0.1 : -0.1;
    setZoom(zoomLevel + delta);
  }
}

urlForm.addEventListener("submit", handleNavSubmit);
newTabButton.addEventListener("click", () => createTab());
registerNavButtons();
window.addEventListener("keydown", handleZoomShortcut, { passive: false });
window.addEventListener("wheel", handleWheelZoom, { passive: false });

createTab();
