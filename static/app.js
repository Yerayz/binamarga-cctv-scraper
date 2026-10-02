"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  roads: [], cameras: [], road: null, camera: null, recordings: [],
  hls: null, ffmpeg: false, roadRequest: 0, cameraRequest: 0,
};

const icon = (name) => `<svg class="icon"><use href="#i-${name}"></use></svg>`;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { cache: "no-store", ...options });
  } catch (error) {
    throw new Error("Cannot reach the local app. Check that the server is running.");
  }
  const payload = await response.json();
  if (response.status === 401) { location.reload(); throw new Error("Please sign in"); }
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function showNotice(message, type = "error") {
  const notice = $("notice");
  notice.textContent = message;
  notice.className = `notice ${type}`;
  notice.hidden = false;
}

function clearNotice() { $("notice").hidden = true; }

function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("sidebarScrim").classList.remove("visible");
}

function renderRoads() {
  const search = $("roadSearch").value.trim().toLowerCase();
  const visible = state.roads.filter((road) => road.name.toLowerCase().includes(search));
  $("roadList").innerHTML = visible.length ? visible.map((road) => `
    <button type="button" class="road-item ${road.id === state.road?.id ? "active" : ""}" data-road="${escapeHtml(road.id)}" aria-current="${road.id === state.road?.id ? "page" : "false"}">
      <span class="road-item-mark"></span><span class="road-item-name">${escapeHtml(road.name)}</span>
      <span class="road-item-count">${road.listed}</span>${icon("chevron")}
    </button>`).join("") : `<div class="sidebar-loading">No matching roads</div>`;
  $("roadList").querySelectorAll("[data-road]").forEach((button) => {
    button.addEventListener("click", () => selectRoad(button.dataset.road));
  });
  $("roadTotal").textContent = state.roads.length;
  $("roadCount").textContent = state.roads.length;
}

function cameraCard(camera, index) {
  const selected = state.camera?.id === camera.id;
  return `<button type="button" class="camera-card ${selected ? "selected" : ""}" data-camera="${escapeHtml(camera.id)}" aria-pressed="${selected}">
    <span class="camera-card-head"><span class="camera-number">CAM ${String(index + 1).padStart(3, "0")}</span><span class="camera-signal"><span></span> STREAM</span></span>
    <span class="camera-preview"><span class="camera-grid-lines"></span><span class="camera-icon-wrap">${icon("camera")}</span><span class="camera-play">${icon("play")}</span></span>
    <span class="camera-card-foot"><span class="camera-card-name">${escapeHtml(camera.name)}</span><span class="camera-card-sub">${selected ? "NOW VIEWING" : "CLICK TO VIEW"} ${icon("chevron")}</span></span>
  </button>`;
}

function renderCameras() {
  const search = $("cameraSearch").value.trim().toLowerCase();
  const visible = state.cameras.map((camera, index) => ({ camera, index }))
    .filter(({ camera }) => camera.name.toLowerCase().includes(search));
  $("cameraCount").textContent = state.cameras.length;
  $("cameraTitleCount").textContent = state.cameras.length;
  $("cameraGrid").innerHTML = visible.length ? visible.map(({ camera, index }) => cameraCard(camera, index)).join("")
    : `<div class="empty-state">${state.cameras.length ? "No cameras match your search." : "No playable cameras are listed for this road. Try another road."}</div>`;
  $("cameraGrid").querySelectorAll("[data-camera]").forEach((button) => {
    button.addEventListener("click", () => selectCamera(button.dataset.camera));
  });
}

function updateRecordButton() {
  $("recordButton").disabled = !state.camera || !state.ffmpeg;
}

function destroyPlayer() {
  const video = $("video");
  video.pause();
  if (state.hls) { state.hls.destroy(); state.hls = null; }
  video.removeAttribute("src");
  video.load();
  video.style.display = "none";
}

function playerStatus(text, error = false) {
  $("playerState").textContent = text;
  $("player").classList.toggle("player-error", error);
}

function playerMessage(title, detail) {
  $("playerPlaceholder").innerHTML = `<div class="placeholder-reticle">${icon("camera")}</div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>`;
  $("playerPlaceholder").hidden = false;
  $("video").style.display = "none";
}

function selectCamera(id) {
  const camera = state.cameras.find((item) => item.id === id);
  if (!camera) return;
  destroyPlayer();
  state.camera = camera;
  $("selectedName").textContent = camera.name;
  $("selectedRoad").textContent = state.road.name;
  $("playerOverlayName").textContent = camera.name.toUpperCase();
  $("playerPlaceholder").hidden = true;
  $("video").style.display = "block";
  playerStatus("CONNECTING TO CAMERA");
  renderCameras();
  updateRecordButton();
  const video = $("video");
  const url = `/api/roads/${encodeURIComponent(state.road.id)}/cameras/${encodeURIComponent(camera.id)}/stream`;
  const play = () => video.play().catch(() => { /* user can press play */ });
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = url;
    video.load();
    play();
  } else if (window.Hls?.isSupported()) {
    const hls = new window.Hls({ enableWorker: true, liveSyncDurationCount: 3 });
    state.hls = hls;
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, play);
    hls.on(window.Hls.Events.ERROR, (_event, data) => {
      if (state.hls !== hls || !data.fatal) return;
      playerStatus("STREAM UNAVAILABLE", true);
      playerMessage("Feed unavailable", "This camera may be offline. Try another camera or the original page.");
      hls.destroy();
      state.hls = null;
    });
  } else {
    playerStatus("PLAYER NOT AVAILABLE", true);
    playerMessage("HLS playback unavailable", "Check your internet connection to load the video player, or open the original page.");
  }
  closeSidebar();
}

async function selectRoad(id, refresh = false) {
  const road = state.roads.find((item) => item.id === id);
  if (!road) return;
  const request = ++state.cameraRequest;
  state.road = road;
  state.camera = null;
  state.cameras = [];
  destroyPlayer();
  playerStatus("NO CAMERA SELECTED");
  $("selectedName").textContent = "Loading cameras...";
  $("selectedRoad").textContent = road.name;
  $("playerOverlayName").textContent = "CAMERA FEED / STANDBY";
  playerMessage("Loading cameras", "Reading live camera listings from Bina Marga.");
  $("breadcrumb").textContent = road.name.toUpperCase();
  $("roadLabel").textContent = road.name.toUpperCase();
  $("roadSource").href = `https://binamarga.pu.go.id/contents/cctv_tol?id_ruas=${encodeURIComponent(road.id)}`;
  $("cameraGrid").innerHTML = '<div class="empty-state">Loading cameras on this road...</div>';
  $("cameraCount").textContent = "—";
  $("cameraTitleCount").textContent = "—";
  updateRecordButton();
  renderRoads();
  closeSidebar();
  try {
    const payload = await api(`/api/roads/${encodeURIComponent(id)}/cameras${refresh ? "?refresh=1" : ""}`);
    if (request !== state.cameraRequest) return;
    state.cameras = payload.cameras;
    $("updatedAt").textContent = new Date(payload.fetchedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta", hour12: false }) + " WIB";
    $("roadNote").textContent = `${payload.cameras.length} CAMERA${payload.cameras.length === 1 ? "" : "S"} FOUND`;
    $("selectedName").textContent = "No camera selected";
    $("selectedRoad").textContent = "Choose a camera below to start watching.";
    playerMessage("Select a camera to begin", "Choose a camera below to load its live stream.");
    renderCameras();
    clearNotice();
  } catch (error) {
    if (request !== state.cameraRequest) return;
    $("selectedName").textContent = "Cameras unavailable";
    $("cameraGrid").innerHTML = '<div class="empty-state">Could not load cameras. Use Refresh feeds to try again.</div>';
    playerMessage("Could not load cameras", "Try refreshing or select another road.");
    showNotice(error.message);
  }
}

async function loadRoads(refresh = false) {
  const request = ++state.roadRequest;
  $("refreshButton").disabled = true;
  $("refreshButton").classList.add("spinning");
  try {
    const payload = await api(`/api/roads${refresh ? "?refresh=1" : ""}`);
    if (request !== state.roadRequest) return;
    state.roads = payload.roads;
    renderRoads();
    const preferred = state.road?.id || state.roads.find((road) => road.id === "jakarta-bogor-ciawi")?.id || state.roads[0]?.id;
    if (preferred) await selectRoad(preferred, refresh);
  } catch (error) {
    showNotice(error.message);
    if (!state.roads.length) $("roadList").innerHTML = '<div class="sidebar-loading">Could not load roads. Try refreshing.</div>';
  } finally {
    if (request === state.roadRequest) {
      $("refreshButton").disabled = false;
      $("refreshButton").classList.remove("spinning");
    }
  }
}

function bytesLabel(bytes) {
  if (!bytes) return "—";
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function elapsedLabel(item) {
  if (!item.startedAt) return "Waiting to start";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(item.startedAt)) / 1000));
  const completed = item.status === "recording" ? Math.min(seconds, item.duration) : 0;
  return `${Math.floor(completed / 60)}:${String(completed % 60).padStart(2, "0")} / ${Math.floor(item.duration / 60)}:${String(item.duration % 60).padStart(2, "0")}`;
}

function renderRecordings() {
  const active = state.recordings.filter((item) => item.status === "queued" || item.status === "recording").length;
   $("recordCount").textContent = state.activeCount ?? active;
  $("recordingTitleCount").textContent = state.recordings.length;
  $("recordingsList").innerHTML = state.recordings.length ? state.recordings.map((item) => {
    const status = item.status === "completed" ? "READY TO DOWNLOAD" : item.status === "failed" ? "RECORDING FAILED" : item.status === "queued" ? "QUEUED" : "RECORDING IN PROGRESS";
    const fraction = item.status === "recording" && item.startedAt ? Math.min(95, Math.max(3, (Date.now() - Date.parse(item.startedAt)) / (item.duration * 10))) : 0;
    return `<div class="recording-row"><div class="recording-row-icon ${escapeHtml(item.status)}">${icon(item.status === "completed" ? "check" : item.status === "failed" ? "alert" : "clock")}</div>
      <div class="recording-main"><strong>${escapeHtml(item.cameraName)}</strong><span>${escapeHtml(item.roadName)} <span class="row-sep">·</span> ${escapeHtml(new Date(item.createdAt).toLocaleString("en-GB", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }))} WIB</span>${item.error ? `<span class="recording-error">${escapeHtml(item.error)}</span>` : ""}${item.status === "recording" ? `<div class="progress"><span style="width:${fraction}%"></span></div>` : ""}</div>
       <div class="recording-right"><span class="recording-status ${escapeHtml(item.status)}">${status}</span><span class="recording-meta">${item.status === "completed" ? bytesLabel(item.bytes) : item.status === "recording" ? elapsedLabel(item) : `${item.duration}s CLIP`} · ${escapeHtml(item.mode || "manual")}${item.width ? ` · ${item.width}×${item.height} ${escapeHtml(item.codec)}` : ""}</span></div>
       ${item.status === "completed" ? `<a class="download-button" href="/api/recordings/${encodeURIComponent(item.id)}/download" title="Download video">${icon("download")}<span>Download</span></a>` : ""}${!["recording", "queued"].includes(item.status) ? `<button class="button subtle-button" data-delete-record="${escapeHtml(item.id)}">Delete</button>` : ""}</div>`;
  }).join("") : '<div class="empty-state">No recordings yet. Select a camera and start recording to save your first clip.</div>';
}

async function loadRecordings() {
  try {
    const filters = new URLSearchParams({ page: String(window.libraryPage || 1) });
    for (const key of ["search", "mode", "status", "date"]) { const value = document.getElementById(`filter-${key}`)?.value; if (value) filters.set(key, value); }
    const payload = await api(`/api/recordings?${filters}`);
    state.activeCount = payload.active;
    window.libraryPages = payload.pages;
    if (document.getElementById("libraryPageLabel")) document.getElementById("libraryPageLabel").textContent = `Page ${payload.page} / ${payload.pages} · ${payload.total} clips`;
    const previous = new Map(state.recordings.map((item) => [item.id, item.status]));
    state.recordings = payload.recordings;
    for (const item of state.recordings) {
      if (previous.get(item.id) === "recording" && item.status === "failed") showNotice(`Recording failed: ${item.error}`);
      if (["queued", "recording"].includes(previous.get(item.id)) && item.status === "completed") showNotice(`Clip ready: ${item.cameraName}. Download it in the library below.`, "success");
    }
    renderRecordings();
  } catch (error) {
    showNotice(error.message);
  }
}

async function startRecording() {
  if (!state.camera || !state.road || !state.ffmpeg) return;
  const button = $("recordButton");
  button.disabled = true;
  try {
    await api("/api/recordings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roadId: state.road.id, cameraId: state.camera.id, duration: Number($("duration").value) }),
    });
    showNotice("Recording started. Your clip will appear in the library when it is ready.", "success");
    await loadRecordings();
    $("recordingsTitle").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    showNotice(error.message);
  } finally { updateRecordButton(); }
}

function updateClock() {
  $("clock").textContent = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()) + " WIB";
}

$("roadSearch").addEventListener("input", renderRoads);
$("cameraSearch").addEventListener("input", renderCameras);
$("refreshButton").addEventListener("click", () => loadRoads(true));
$("recordButton").addEventListener("click", startRecording);
$("openSidebar").addEventListener("click", () => { $("sidebar").classList.add("open"); $("sidebarScrim").classList.add("visible"); });
$("closeSidebar").addEventListener("click", closeSidebar);
$("sidebarScrim").addEventListener("click", closeSidebar);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSidebar();
  if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    event.preventDefault(); $("roadSearch").focus();
  }
});
$("video").addEventListener("playing", () => { $("playerPlaceholder").hidden = true; playerStatus("LIVE STREAM"); });
$("video").addEventListener("error", () => {
  if (!state.camera) return;
  playerStatus("STREAM UNAVAILABLE", true);
  playerMessage("Feed unavailable", "This camera may be offline. Try another camera or the original page.");
});

updateClock();
setInterval(updateClock, 30_000);
setInterval(loadRecordings, 5_000);
setInterval(() => { if (state.recordings.some((item) => item.status === "recording")) renderRecordings(); }, 1_000);
api("/api/health").then((health) => {
  state.ffmpeg = health.ffmpeg;
   $("ffmpegStatus").textContent = health.ffmpeg ? "● FFmpeg ready · original source quality" : "FFmpeg / FFprobe missing — recording unavailable";
  $("ffmpegStatus").classList.toggle("not-ready", !health.ffmpeg);
  updateRecordButton();
}).catch((error) => { $("ffmpegStatus").textContent = error.message; showNotice(error.message); });
loadRecordings();
loadRoads();
