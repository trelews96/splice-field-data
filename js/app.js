import { CONFIG } from "./config.js";
import { db, requestPersistence } from "./db.js";
import { COLORS, SWATCH, shortCode, tubeAndFiber, tubeCount } from "./fiber.js";
import { canAutoSend, bundleFile, downloadFile, sendRecord, shareRecords } from "./transport.js";

// ------------------------------------------------------------------ small helpers
const app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const uuid = () => crypto.randomUUID?.() ?? "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
});
const localDate = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const localTime = () => new Date().toTimeString().slice(0, 5);
const num = (v) => (v === "" || v == null || isNaN(Number(v)) ? null : Number(v));

const FIBER_COUNTS = [6, 12, 24, 36, 48, 72, 96, 144, 216, 288, 360, 432];
const SPLICE_STATUSES = ["spliced", "express", "open", "spare", "future", "dead"];
const DEVICE_TYPES = ["splitter", "CWDM mux", "DWDM mux", "other"];

let state = { rec: null, tab: "header", form: null, openTap: null, settings: {} };

function toast(msg, ms = 2500) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), ms);
}

function getGPS() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("GPS not available on this device"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({
        lat: +p.coords.latitude.toFixed(7), lon: +p.coords.longitude.toFixed(7),
        accuracy_m: Math.round(p.coords.accuracy), captured_at: new Date().toISOString(),
      }),
      (e) => reject(new Error(e.code === 1 ? "Location permission denied" : "Couldn't get a GPS fix - try again in the open")),
      { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 },
    );
  });
}

async function resizePhoto(file, maxSide = 1600) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Couldn't read that image"));
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.75));
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ------------------------------------------------------------------ records

function newSplice() {
  const s = state.settings;
  return {
    schema: "splice/1", type: "splice", uuid: uuid(), app_version: CONFIG.appVersion,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), _status: "draft",
    header: {
      job_id: s.job_id || "", date: localDate(), splice_id: "", enclosure: "", map_number: "", trays: null,
      location: "", gps: null, time_in: localTime(), time_out: "", tech: s.crew || "", auditor: s.auditor || "",
      contractor: s.contractor || "", notes: "",
    },
    cables: [
      { key: "C1", role: "input", span_id: "", cable_number: 1, fiber_count: 144, fibers_per_tube: 12 },
      { key: "C2", role: "output", span_id: "", cable_number: 2, fiber_count: 144, fibers_per_tube: 12 },
    ],
    devices: [], splices: [], photos: [],
  };
}

function newTapReport() {
  const s = state.settings;
  return {
    schema: "tap_report/1", type: "tap_report", uuid: uuid(), app_version: CONFIG.appVersion,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), _status: "draft",
    header: {
      job_id: s.job_id || "", date: localDate(), prism_id: "", node: "", node_location: "",
      contractor: s.contractor || "", splicer: s.crew || "", optical_source: "Node",
      launch_power_dbm: null, wavelength_nm: 1577,
    },
    taps: [],
  };
}

const recordTitle = (r) => r.type === "splice"
  ? (r.header.splice_id || "New splice")
  : (r.header.node ? `Node ${r.header.node}` : "New tap report");

const STATUS_LABEL = { draft: "Draft", queued: "Ready to send", sent: "Sent (unconfirmed)" };

let saveTimer, dirty = false;
function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}
// Save only if something was typed since the last save (navigation must not mark a sent record as changed).
async function flushSave() {
  if (dirty) await saveNow();
}
async function saveNow() {
  clearTimeout(saveTimer);
  dirty = false;
  const rec = state.rec;
  if (!rec) return;
  rec.updated_at = new Date().toISOString();
  if (rec._status === "sent") rec._status = "queued";   // edited after sending: send again
  await db.putRecord(rec);
  updateStatusChip();
}

function updateStatusChip() {
  const chip = document.querySelector("[data-status-chip]");
  if (chip && state.rec) { chip.textContent = STATUS_LABEL[state.rec._status]; chip.className = `chip ${state.rec._status}`; }
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    o[k] ??= /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[k];
  }
  o[keys.at(-1)] = value;
}
const getPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);

// ------------------------------------------------------------------ sending

let sending = false;
async function sendQueued({ quiet = false } = {}) {
  if (sending || !canAutoSend()) return;
  if (!navigator.onLine) { if (!quiet) toast("No signal - records stay on this phone and send when you're back online."); return; }
  sending = true;
  let sent = 0, failed = 0;
  try {
    for (const rec of (await db.allRecords()).filter((r) => r._status === "queued")) {
      try {
        const result = await sendRecord(rec);
        // Apply to the copy on screen if it's open, so a later auto-save doesn't undo the "sent" status.
        const current = state.rec?.uuid === rec.uuid ? state.rec : await db.getRecord(rec.uuid);
        if (!current) continue;
        current._sent_photos = result._sent_photos;
        if (current.updated_at === rec.updated_at) {   // not edited while the send was in flight
          current._status = "sent";
          current._sent_at = result._sent_at;
        }
        await db.putRecord(current);
        if (current === state.rec) updateStatusChip();
        sent++;
      } catch (e) {
        failed++;
        console.warn("send failed", e);
      }
    }
  } finally {
    sending = false;
  }
  if (sent || failed || !quiet) toast(failed ? `Sent ${sent}, ${failed} will retry later` : sent ? `Sent ${sent} record(s)` : "Nothing waiting to send");
  if (!state.rec) renderHome();
}

window.addEventListener("online", () => sendQueued({ quiet: true }));

// ------------------------------------------------------------------ views: home

async function renderHome() {
  state.rec = null;
  const records = (await db.allRecords()).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const waiting = records.filter((r) => r._status === "queued").length;
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  app.innerHTML = `
    <header class="bar">
      <h1>Splice Field Data</h1>
      <span class="net ${navigator.onLine ? "on" : "off"}">${navigator.onLine ? "Online" : "Offline"}</span>
      <a class="icon-btn" href="#/settings" aria-label="Settings">⚙</a>
    </header>
    <main class="page">
      ${standalone ? "" : `<div class="notice">Install this app so it works with no signal: open the browser's Share/menu and choose <b>Add to Home Screen</b>, then open it from there.</div>`}
      ${state.settings.crew ? "" : `<div class="notice warn">Set your name and company in <a href="#/settings">Settings</a> once - it fills in every form.</div>`}
      <div class="new-row">
        <button class="primary big" data-action="new-splice">+ Splice enclosure</button>
        <button class="primary big" data-action="new-tap">+ Tap report</button>
      </div>
      <h2>On this phone (${records.length})</h2>
      ${records.length ? "" : `<p class="muted">Nothing yet. Records you start stay on this phone until they're sent.</p>`}
      <ul class="cards">
        ${records.map((r) => `
          <li class="card record" data-action="open" data-uuid="${r.uuid}">
            <div class="rec-main">
              <span class="type">${r.type === "splice" ? "Splice" : "Taps"}</span>
              <b>${esc(recordTitle(r))}</b>
              <span class="muted">${esc(r.header.job_id ? `WO ${normalizeWorkOrder(r.header.job_id)}` : "⚠ no work order #")} · ${esc(r.header.date)}${r.type === "tap_report" ? ` · ${r.taps.length} taps` : ` · ${r.splices.length} entries`}</span>
            </div>
            <span class="chip ${r._status}">${STATUS_LABEL[r._status]}</span>
          </li>`).join("")}
      </ul>
      <div class="actions">
        ${canAutoSend()
          ? `<button data-action="send-all" ${waiting ? "" : "disabled"}>Send ${waiting} waiting</button>`
          : `<button data-action="share-all" ${waiting ? "" : "disabled"}>Share ${waiting} finished${CONFIG.inboxEmail ? ` to ${esc(CONFIG.inboxEmail)}` : ""}</button>`}
        <button data-action="backup" ${records.length ? "" : "disabled"}>Save backup file</button>
      </div>
    </main>`;
}

// ------------------------------------------------------------------ views: editor

function field(label, path, { type = "text", rec = state.rec, options, attrs = "", rerender = false, hint = "" } = {}) {
  const value = getPath(rec, path);
  const common = `data-bind="${path}" data-type="${type}" ${rerender ? "data-rerender" : ""} ${attrs}`;
  let input;
  if (options) {
    input = `<select ${common}>${options.map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return `<option value="${esc(v)}" ${String(v) === String(value ?? "") ? "selected" : ""}>${esc(l)}</option>`;
    }).join("")}</select>`;
  } else if (type === "textarea") {
    input = `<textarea ${common} rows="3">${esc(value)}</textarea>`;
  } else {
    const inputType = type === "number" ? "text" : type;
    const mode = type === "number" ? `inputmode="decimal"` : "";
    input = `<input type="${inputType}" ${mode} value="${esc(value)}" ${common}>`;
  }
  return `<label class="field"><span>${esc(label)}</span>${input}${hint ? `<small class="muted">${hint}</small>` : ""}</label>`;
}

function gpsBlock(path, gps) {
  return `
    <div class="gps">
      <div>
        <span class="label">GPS</span>
        ${gps?.lat != null
          ? `<b>${gps.lat.toFixed(6)}, ${gps.lon.toFixed(6)}</b> <span class="muted">±${gps.accuracy_m ?? "?"} m</span>`
          : `<span class="muted">Not captured</span>`}
      </div>
      <button data-action="gps" data-path="${path}">${gps?.lat != null ? "Recapture" : "Capture GPS"}</button>
    </div>`;
}

function renderEditor() {
  const rec = state.rec;
  const tabs = rec.type === "splice"
    ? [["header", "Header"], ["cables", `Cables (${rec.cables.length + rec.devices.length})`], ["splices", `Splices (${rec.splices.length})`], ["photos", `Photos (${rec.photos.length})`]]
    : [["header", "Header"], ["taps", `Taps (${rec.taps.length})`]];
  if (!tabs.some(([t]) => t === state.tab)) state.tab = "header";
  const body = {
    header: rec.type === "splice" ? spliceHeader : tapHeader,
    cables: cablesTab, splices: splicesTab, photos: photosTab, taps: tapsTab,
  }[state.tab](rec);
  app.innerHTML = `
    <header class="bar">
      <a class="icon-btn" href="#/" aria-label="Back">‹</a>
      <h1>${esc(recordTitle(rec))}</h1>
      <span class="chip ${rec._status}" data-status-chip>${STATUS_LABEL[rec._status]}</span>
    </header>
    <nav class="tabs">${tabs.map(([t, l]) => `<button class="${t === state.tab ? "active" : ""}" data-action="tab" data-tab="${t}">${l}</button>`).join("")}</nav>
    <main class="page">${body}</main>
    <footer class="footer">
      <button class="danger" data-action="delete-record">Delete</button>
      <button class="primary" data-action="finish">${rec._status === "draft" ? "Finish & send" : "Send again"}</button>
    </footer>`;
  if (state.tab === "photos") loadThumbnails();
}

function spliceHeader(rec) {
  return `
    <section class="card">
      ${field("Work order / CRQ #", "header.job_id", { hint: "Every crew on this work order uses the same number - it builds one workbook per work order" })}
      ${field("Splice ID", "header.splice_id", { attrs: `placeholder="e.g. CK-S-0224"` })}
      <div class="grid2">
        ${field("Date", "header.date", { type: "date" })}
        ${field("No. of trays", "header.trays", { type: "number" })}
        ${field("Time in", "header.time_in", { type: "time" })}
        ${field("Time out", "header.time_out", { type: "time" })}
      </div>
      ${field("Enclosure", "header.enclosure", { attrs: `placeholder="Make / model"` })}
      ${field("Map number", "header.map_number")}
      ${field("Location / address", "header.location")}
      ${gpsBlock("header.gps", rec.header.gps)}
    </section>
    <section class="card">
      <div class="grid2">
        ${field("Splicer / tech", "header.tech")}
        ${field("Auditor", "header.auditor")}
      </div>
      ${field("Contractor company", "header.contractor")}
      ${field("Notes and/or concerns", "header.notes", { type: "textarea" })}
    </section>`;
}

function tapHeader(rec) {
  return `
    <section class="card">
      ${field("Work order / CRQ #", "header.job_id", { hint: "Every crew on this work order uses the same number - it builds one workbook per work order" })}
      <div class="grid2">
        ${field("Node number", "header.node")}
        ${field("PRISM ID", "header.prism_id")}
      </div>
      ${field("Node location / optical launch site", "header.node_location")}
      ${field("Date", "header.date", { type: "date" })}
      <div class="grid2">
        ${field("Optical source at launch", "header.optical_source", { options: ["Node", "Light Source"] })}
        ${field("Wavelength (nm)", "header.wavelength_nm", { type: "number" })}
      </div>
      ${field("Optical power at launch (dBm)", "header.launch_power_dbm", { type: "number", hint: "Used to calculate link loss for every tap" })}
    </section>
    <section class="card">
      ${field("Contractor company", "header.contractor")}
      ${field("Splicer name", "header.splicer")}
    </section>`;
}

// ---- cables & devices

function cablesTab(rec) {
  const cableCard = (c, i) => `
    <section class="card">
      <div class="card-head">
        <b>${c.key} · ${c.role === "input" ? "Input" : "Output"} cable</b>
        <button class="link danger" data-action="remove-cable" data-index="${i}">Remove</button>
      </div>
      <div class="grid2">
        ${field("Fiber name (Span ID)", `cables.${i}.span_id`, { rerender: false })}
        ${field("Role", `cables.${i}.role`, { options: [["input", "Input"], ["output", "Output"]], rerender: true })}
        ${field("Fiber count", `cables.${i}.fiber_count`, { type: "number", options: FIBER_COUNTS, rerender: true })}
        ${field("Fibers per tube", `cables.${i}.fibers_per_tube`, { type: "number", options: [12, 6, 24], rerender: true })}
        ${field("Cable #", `cables.${i}.cable_number`, { type: "number" })}
        ${field("Enclosure port", `cables.${i}.enclosure_port`)}
        ${field("Tracer color", `cables.${i}.tracer_color`)}
        ${field("Manufacturer", `cables.${i}.manufacturer`)}
        ${field("Mfg date", `cables.${i}.mfg_date`, { type: "month" })}
        ${field("Footage / tic mark", `cables.${i}.footage`)}
        ${field("Tech installed #", `cables.${i}.tech_number`)}
        ${field("Date installed", `cables.${i}.date_installed`, { type: "date" })}
      </div>
      ${field("Goes to enclosure #", `cables.${i}.goes_to`)}
    </section>`;
  const deviceCard = (d, i) => `
    <section class="card">
      <div class="card-head">
        <b>${d.key} · ${esc(d.label || d.type)}</b>
        <button class="link danger" data-action="remove-device" data-index="${i}">Remove</button>
      </div>
      <div class="grid2">
        ${field("Type", `devices.${i}.type`, { options: DEVICE_TYPES })}
        ${field("Label", `devices.${i}.label`, { attrs: `placeholder="e.g. 1X4 Splitter"` })}
        ${field("Ratio / channels", `devices.${i}.ratio`, { attrs: `placeholder="1X4, 8CH..."` })}
        ${field("Tray", `devices.${i}.tray`, { type: "number" })}
        ${field("Part #", `devices.${i}.part_number`)}
        ${field("Serial #", `devices.${i}.serial`)}
      </div>
      ${field("Port names (comma separated)", `devices.${i}.ports_text`, { hint: "e.g. IN, OUT 1, OUT 2, OUT 3, OUT 4 - or 1470, 1490, 1510..." })}
      ${field("Notes", `devices.${i}.notes`)}
    </section>`;
  return `
    ${rec.cables.map(cableCard).join("")}
    ${rec.devices.map(deviceCard).join("")}
    <div class="actions">
      <button data-action="add-cable" ${rec.cables.length + rec.devices.length >= 8 ? "disabled" : ""}>+ Add cable</button>
      <button data-action="add-device" ${rec.cables.length + rec.devices.length >= 8 ? "disabled" : ""}>+ Add splitter / mux</button>
    </div>
    <p class="muted">The workbook has room for 8 cables + devices per enclosure.</p>`;
}

// ---- splices

const endpointsOf = (rec) => [
  ...rec.cables.map((c) => ({ key: c.key, kind: "cable", label: `${c.key} ${c.span_id || ""}`.trim(), size: num(c.fiber_count) || 0, fpt: num(c.fibers_per_tube) || 12 })),
  ...rec.devices.map((d) => ({ key: d.key, kind: "device", label: `${d.key} ${d.label || d.type}`, size: d.ports?.length || 0, ports: d.ports || [] })),
];

function describeEnd(ep, start, count) {
  if (!ep) return "";
  if (ep.kind === "device") {
    const names = Array.from({ length: count }, (_, i) => ep.ports[start - 1 + i] ?? String(start + i));
    return `${ep.key} ${names.length > 2 ? `${names[0]} … ${names.at(-1)}` : names.join(", ")}`;
  }
  const end = start + count - 1;
  return `${ep.key} #${start}${count > 1 ? `–${end}` : ""} (${shortCode(start, ep.fpt)}${count > 1 ? ` … ${shortCode(end, ep.fpt)}` : ""})`;
}

function swatch(ep, n) {
  if (!ep || ep.kind !== "cable" || !n) return "";
  const [tube, fiber] = tubeAndFiber(n, ep.fpt).map((c) => c.split(" ")[0]);
  return `<span class="sw" style="background:${SWATCH[tube]}" title="tube ${tube}"></span><span class="sw" style="background:${SWATCH[fiber]}" title="fiber ${fiber}"></span>`;
}

function defaultForm(rec) {
  const eps = endpointsOf(rec);
  const last = rec.splices.at(-1);
  if (last) {
    // Continue where the last entry left off - straight-through runs become one tap per tube.
    return {
      tray: last.tray, aRef: last.a?.ref, aStart: (last.a?.start || 1) + (last.count || 1),
      bRef: last.b?.ref || "", bStart: last.b ? last.b.start + (last.count || 1) : 1,
      count: last.count || 12, status: "spliced", service: "", note: "", date: "", editing: null,
    };
  }
  return { tray: 1, aRef: eps[0]?.key, aStart: 1, bRef: eps[1]?.key || "", bStart: 1, count: 12,
    status: "spliced", service: "", note: "", date: "", editing: null };
}

function spliceWarnings(rec, f, ignoreIndex) {
  const eps = Object.fromEntries(endpointsOf(rec).map((e) => [e.key, e]));
  const warn = [];
  const count = num(f.count) || 1;
  for (const [ref, start] of [[f.aRef, num(f.aStart)], [f.bRef, num(f.bStart)]]) {
    const ep = eps[ref];
    if (!ep || !start) continue;
    if (ep.size && start + count - 1 > ep.size) warn.push(`${ref} only has ${ep.size} ${ep.kind === "cable" ? "fibers" : "ports"}`);
    const used = rec.splices.flatMap((s, i) => i === ignoreIndex ? [] : [s.a, s.b].filter((x) => x?.ref === ref)
      .map((x) => [x.start, x.start + (s.count || 1) - 1]));
    if (used.some(([lo, hi]) => start <= hi && start + count - 1 >= lo)) warn.push(`${ref} #${start}${count > 1 ? `–${start + count - 1}` : ""} overlaps an entry you already made`);
  }
  if (f.status === "spliced" && !f.bRef) warn.push(`Pick where it's spliced to, or change status`);
  if (f.aRef && f.aRef === f.bRef) warn.push("From and To are the same cable");
  return warn;
}

function tubeSelect(ep, which, start) {
  if (!ep || ep.kind !== "cable") return "";
  const tubes = tubeCount(ep.size, ep.fpt);
  const current = Math.floor(((num(start) || 1) - 1) / ep.fpt) + 1;
  return `<label class="field"><span>Tube</span><select data-form-tube="${which}">
    ${Array.from({ length: tubes }, (_, i) => `<option value="${i + 1}" ${i + 1 === current ? "selected" : ""}>${i + 1} ${COLORS[i % 12]}${i >= 12 ? " stripe" : ""}</option>`).join("")}
  </select></label>`;
}

function splicesTab(rec) {
  const f = (state.form ??= defaultForm(rec));
  const eps = endpointsOf(rec);
  const byKey = Object.fromEntries(eps.map((e) => [e.key, e]));
  const epOptions = (sel, none) => (none ? `<option value="" ${!sel ? "selected" : ""}>— none —</option>` : "") +
    eps.map((e) => `<option value="${e.key}" ${e.key === sel ? "selected" : ""}>${esc(e.label)}</option>`).join("");
  const count = num(f.count) || 1;
  const warnings = spliceWarnings(rec, f, f.editing);
  const formField = (label, key, type = "text", extra = "") =>
    `<label class="field"><span>${label}</span><input type="text" ${type === "number" ? `inputmode="numeric"` : ""} data-form="${key}" value="${esc(f[key])}" ${extra}></label>`;

  const groups = {};
  rec.splices.forEach((s, i) => (groups[s.tray ?? "–"] ??= []).push([s, i]));

  return `
    <section class="card splice-form">
      <div class="card-head"><b>${f.editing != null ? `Edit entry` : "Add splices"}</b>
        ${f.editing != null ? `<button class="link" data-action="cancel-edit">Cancel</button>` : ""}</div>
      <div class="grid3">
        ${formField("Tray", "tray", "number")}
        ${formField("Count", "count", "number")}
        <label class="field"><span>Status</span><select data-form="status">${SPLICE_STATUSES.map((s) => `<option ${s === f.status ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      </div>
      <div class="quick">
        <span class="muted">Count:</span>
        ${[1, 2, 6, 12].map((n) => `<button class="pill ${n === count ? "on" : ""}" data-action="quick-count" data-n="${n}">${n === 12 ? "12 (tube)" : n}</button>`).join("")}
      </div>
      <div class="end">
        <div class="end-title">From <span data-live="swA">${swatch(byKey[f.aRef], num(f.aStart))}</span></div>
        <div class="grid3">
          <label class="field"><span>Cable / device</span><select data-form="aRef">${epOptions(f.aRef)}</select></label>
          ${tubeSelect(byKey[f.aRef], "a", f.aStart)}
          ${formField(byKey[f.aRef]?.kind === "device" ? "Port #" : "Start fiber #", "aStart", "number")}
        </div>
      </div>
      <div class="end">
        <div class="end-title">To <span data-live="swB">${swatch(byKey[f.bRef], num(f.bStart))}</span></div>
        <div class="grid3">
          <label class="field"><span>Cable / device</span><select data-form="bRef">${epOptions(f.bRef, true)}</select></label>
          ${tubeSelect(byKey[f.bRef], "b", f.bStart)}
          ${f.bRef ? formField(byKey[f.bRef]?.kind === "device" ? "Port #" : "Start fiber #", "bStart", "number") : ""}
        </div>
      </div>
      <div class="grid2">
        ${formField("Service / label", "service", "text", `placeholder="GEPON, AD02-1 FWD, spare..."`)}
        ${formField("Note", "note")}
      </div>
      <div class="preview" data-live="preview">${livePreview(f, byKey)}</div>
      <div data-live="warnings">${warnings.map((w) => `<div class="warning">⚠ ${esc(w)}</div>`).join("")}</div>
      <button class="primary wide" data-action="save-splice" data-live="save">${saveLabel(f)}</button>
    </section>
    ${Object.entries(groups).map(([tray, list]) => `
      <h3>Tray ${esc(tray)}</h3>
      <ul class="cards compact">
        ${list.map(([s, i]) => `
          <li class="card entry ${f.editing === i ? "editing" : ""}">
            <div>
              ${swatch(byKey[s.a?.ref], s.a?.start)}
              <b>${esc(describeEnd(byKey[s.a?.ref], s.a?.start, s.count || 1))}</b>
              ${s.b ? ` → ${esc(describeEnd(byKey[s.b.ref], s.b.start, s.count || 1))}` : ""}
              <div class="muted">${esc([s.status !== "spliced" ? s.status.toUpperCase() : "", s.service, s.note].filter(Boolean).join(" · "))}</div>
            </div>
            <div class="entry-actions">
              <button class="link" data-action="edit-splice" data-index="${i}">Edit</button>
              <button class="link danger" data-action="delete-splice" data-index="${i}">✕</button>
            </div>
          </li>`).join("")}
      </ul>`).join("")}
    ${rec.splices.length ? usageSummary(rec, eps) : `<p class="muted">Enter splices as ranges: e.g. tray 1, C1 fibers 1–12 → C2 fibers 1–12 is a single entry. Colors fill in automatically.</p>`}`;
}

const livePreview = (f, byKey) => {
  const count = num(f.count) || 1;
  return esc(describeEnd(byKey[f.aRef], num(f.aStart) || 1, count)) +
    (f.bRef ? ` → ${esc(describeEnd(byKey[f.bRef], num(f.bStart) || 1, count))}` : ` · ${esc(f.status)}`);
};
const saveLabel = (f) => {
  const count = num(f.count) || 1;
  return f.editing != null ? "Save changes" : `Add ${count} fiber${count === 1 ? "" : "s"}`;
};

// Update the parts of the splice form that depend on typed numbers, without redrawing the inputs.
function refreshSpliceForm() {
  const f = state.form, rec = state.rec;
  const byKey = Object.fromEntries(endpointsOf(rec).map((e) => [e.key, e]));
  const set = (k, html) => { const el = app.querySelector(`[data-live="${k}"]`); if (el) el.innerHTML = html; };
  set("swA", swatch(byKey[f.aRef], num(f.aStart)));
  set("swB", swatch(byKey[f.bRef], num(f.bStart)));
  set("preview", livePreview(f, byKey));
  set("warnings", spliceWarnings(rec, f, f.editing).map((w) => `<div class="warning">⚠ ${esc(w)}</div>`).join(""));
  set("save", saveLabel(f));
  app.querySelectorAll('[data-action="quick-count"]').forEach((b) => b.classList.toggle("on", Number(b.dataset.n) === (num(f.count) || 1)));
}

function usageSummary(rec, eps) {
  const used = {};
  for (const s of rec.splices) for (const x of [s.a, s.b]) if (x) used[x.ref] = (used[x.ref] || 0) + (s.count || 1);
  return `<p class="muted">Recorded: ${eps.filter((e) => e.kind === "cable").map((e) => `${e.key} ${used[e.key] || 0}/${e.size}`).join(" · ")}</p>`;
}

// ---- photos

function photosTab(rec) {
  return `
    <section class="card">
      <label class="primary wide file-btn">📷 Take / add photo
        <input type="file" accept="image/*" capture="environment" data-action-change="add-photo" multiple hidden>
      </label>
      <p class="muted">Before/after, each tray, enclosure tag. Photos are shrunk to save data.</p>
    </section>
    <ul class="photos">
      ${rec.photos.map((p, i) => `
        <li class="card photo">
          <img data-photo-id="${p.id}" alt="">
          <input type="text" placeholder="Caption (e.g. Tray 1 after)" value="${esc(p.caption)}" data-bind="photos.${i}.caption">
          <button class="link danger" data-action="delete-photo" data-index="${i}">Remove</button>
        </li>`).join("")}
    </ul>`;
}

async function loadThumbnails() {
  const photos = await db.photosFor(state.rec.uuid);
  for (const p of photos) {
    const img = app.querySelector(`img[data-photo-id="${p.id}"]`);
    if (img) img.src = URL.createObjectURL(p.blob);
  }
}

// ---- taps

function tapsTab(rec) {
  const launch = num(rec.header.launch_power_dbm);
  const card = (t, i) => {
    const open = state.openTap === i;
    const readings = t.readings_dbm || [];
    const summary = readings.filter((v) => v != null).map((v) => launch != null ? (launch - v).toFixed(2) : "?").join(" / ");
    if (!open) {
      return `<li class="card tap" data-action="open-tap" data-index="${i}">
        <div><b>${esc(t.name || `Tap ${i + 1}`)}</b> <span class="muted">${esc(t.type)} · ${t.ports}-port · ${esc(t.feed || "no feed")}</span>
        <div class="muted">${readings.filter((v) => v != null).length}/${t.ports} ports read${summary ? ` · loss ${summary} dB` : ""}${t.gps ? " · 📍" : ""}</div></div>
        <span>›</span></li>`;
    }
    const [tubeC, fiberC] = (t.feed_parts || ["", ""]);
    return `<li class="card tap open">
      <div class="card-head"><b>Tap ${i + 1}</b>
        <span><button class="link" data-action="close-tap">Done</button> <button class="link danger" data-action="delete-tap" data-index="${i}">Delete</button></span></div>
      ${field("Tap name / number", `taps.${i}.name`, { attrs: `placeholder="e.g. WISAA01E0026"` })}
      <div class="grid2">
        ${field("Type", `taps.${i}.type`, { options: ["OTE", "MST"] })}
        ${field("Ports", `taps.${i}.ports`, { type: "number", options: [2, 4, 8], rerender: true })}
      </div>
      <div class="field"><span>Buffer & fiber spliced to port 1</span>
        <div class="grid2">
          <select data-feed="${i}" data-part="0"><option value="">Tube…</option>${COLORS.map((c) => `<option ${c === tubeC ? "selected" : ""}>${c}</option>`).join("")}</select>
          <select data-feed="${i}" data-part="1"><option value="">Fiber…</option>${COLORS.map((c) => `<option ${c === fiberC ? "selected" : ""}>${c}</option>`).join("")}</select>
        </div>
      </div>
      ${field("…or type it (splitter port etc.)", `taps.${i}.feed`, { attrs: `placeholder="AQ-SL or 32 Splitter - Port 28"` })}
      <div class="readings">
        ${Array.from({ length: t.ports }, (_, p) => {
          const v = readings[p];
          return `<label class="field reading"><span>Port ${p + 1} (dBm)</span>
            <input type="text" inputmode="decimal" value="${esc(v)}" data-bind="taps.${i}.readings_dbm.${p}" data-type="number" data-loss="${i}.${p}" placeholder="-21.5">
            <small class="muted" data-loss-out="${i}.${p}">${v != null && launch != null ? `loss ${(launch - v).toFixed(2)} dB` : ""}</small></label>`;
        }).join("")}
      </div>
      ${launch == null ? `<div class="warning">Enter launch power on the Header tab to see link loss.</div>` : ""}
      ${gpsBlock(`taps.${i}.gps`, t.gps)}
    </li>`;
  };
  return `
    <ul class="cards">${rec.taps.map(card).join("")}</ul>
    <button class="primary wide" data-action="add-tap" ${rec.taps.length >= 173 ? "disabled" : ""}>+ Add tap</button>
    <p class="muted">GPS is captured when you add each tap - add it while standing at the tap.</p>`;
}

// ------------------------------------------------------------------ settings

function renderSettings() {
  state.rec = null;
  const s = state.settings;
  const input = (label, key, hint = "") => `<label class="field"><span>${label}</span><input type="text" data-setting="${key}" value="${esc(s[key])}">${hint ? `<small class="muted">${hint}</small>` : ""}</label>`;
  app.innerHTML = `
    <header class="bar"><a class="icon-btn" href="#/" aria-label="Back">‹</a><h1>Settings</h1></header>
    <main class="page">
      <section class="card">
        ${input("Your name", "crew")}
        ${input("Company", "contractor")}
        ${input("Auditor", "auditor")}
        ${input("Current work order / CRQ #", "job_id", "Pre-fills new records - change it when you move to a different work order")}
      </section>
      <section class="card">
        <p><b>Sending:</b> ${esc({ post: "automatic (web)", form: "automatic (form)", share: "share to email" }[CONFIG.transport])}</p>
        <p><b>Storage:</b> <span id="persist">checking…</span></p>
        <p class="muted">App version ${esc(CONFIG.appVersion)}</p>
        <button data-action="purge-sent">Remove sent records from this phone</button>
      </section>
    </main>`;
  navigator.storage?.persisted?.().then((p) => {
    document.getElementById("persist").textContent = p ? "protected from automatic cleanup" : "may be cleared if unused - open the app from the home screen";
  }).catch(() => {});
}

// ------------------------------------------------------------------ events

app.addEventListener("input", (e) => {
  const t = e.target;
  if (t.dataset.setting) {
    state.settings[t.dataset.setting] = t.value;
    db.setMeta("settings", state.settings);
    return;
  }
  if (t.dataset.form) {
    state.form[t.dataset.form] = t.value;
    if (t.tagName === "SELECT") renderEditor(); else refreshSpliceForm();
    return;
  }
  if (!t.dataset.bind || !state.rec) return;
  let v = t.value;
  if (t.dataset.type === "number") v = num(v);
  setPath(state.rec, t.dataset.bind, v);
  const dev = t.dataset.bind.match(/^devices\.(\d+)\.ports_text$/);
  if (dev) state.rec.devices[+dev[1]].ports = t.value.split(",").map((s) => s.trim()).filter(Boolean);
  if (t.dataset.loss) {
    const out = app.querySelector(`[data-loss-out="${t.dataset.loss}"]`);
    const launch = num(state.rec.header.launch_power_dbm);
    if (out) out.textContent = v != null && launch != null ? `loss ${(launch - v).toFixed(2)} dB` : "";
  }
  scheduleSave();
});

// Same normalization as the generator, so every crew's records group under one work order.
const normalizeWorkOrder = (v) => String(v || "").replace(/\s+/g, "").toUpperCase();

app.addEventListener("change", async (e) => {
  const t = e.target;
  if (t.dataset.bind === "header.job_id" || t.dataset.setting === "job_id") {
    t.value = normalizeWorkOrder(t.value);
    if (t.dataset.setting) { state.settings.job_id = t.value; db.setMeta("settings", state.settings); }
    else { state.rec.header.job_id = t.value; scheduleSave(); }
    return;
  }
  if (t.dataset.formTube) {
    const which = t.dataset.formTube;
    const ep = endpointsOf(state.rec).find((x) => x.key === state.form[`${which}Ref`]);
    state.form[`${which}Start`] = (Number(t.value) - 1) * (ep?.fpt || 12) + 1;
    renderEditor();
    return;
  }
  if (t.dataset.form) return;   // text fields update live via refreshSpliceForm(); selects redraw on input
  if (t.dataset.feed) {
    const tap = state.rec.taps[+t.dataset.feed];
    tap.feed_parts ??= ["", ""];
    tap.feed_parts[+t.dataset.part] = t.value;
    const [tube, fiber] = tap.feed_parts;
    if (tube && fiber) tap.feed = shortCode(COLORS.indexOf(tube) * 12 + COLORS.indexOf(fiber) + 1);
    scheduleSave();
    renderEditor();
    return;
  }
  if (t.dataset.actionChange === "add-photo") {
    for (const file of t.files) {
      try {
        const blob = await resizePhoto(file);
        const photo = { id: uuid(), record_uuid: state.rec.uuid, blob, caption: "", taken_at: new Date().toISOString() };
        await db.putPhoto(photo);
        state.rec.photos.push({ id: photo.id, caption: "", taken_at: photo.taken_at });
      } catch (err) {
        toast(err.message);
      }
    }
    await saveNow();
    renderEditor();
    return;
  }
  if (t.hasAttribute("data-rerender") && t.tagName === "SELECT") { await saveNow(); renderEditor(); }
});

app.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || el.disabled) return;
  const rec = state.rec;
  const idx = Number(el.dataset.index);
  switch (el.dataset.action) {
    case "new-splice":
    case "new-tap": {
      const r = el.dataset.action === "new-splice" ? newSplice() : newTapReport();
      await db.putRecord(r);
      location.hash = `#/${r.type === "splice" ? "splice" : "tap"}/${r.uuid}`;
      if (r.type === "splice") getGPS().then(async (gps) => {
        if (state.rec?.uuid === r.uuid && !state.rec.header.gps) { state.rec.header.gps = gps; await saveNow(); if (state.tab === "header") renderEditor(); }
      }).catch(() => {});
      break;
    }
    case "open": {
      const r = await db.getRecord(el.dataset.uuid);
      location.hash = `#/${r.type === "splice" ? "splice" : "tap"}/${r.uuid}`;
      break;
    }
    case "tab":
      await flushSave();
      state.tab = el.dataset.tab;
      renderEditor();
      window.scrollTo(0, 0);
      break;
    case "gps": {
      el.disabled = true;
      el.textContent = "Getting fix…";
      try {
        setPath(rec, el.dataset.path, await getGPS());
        await saveNow();
      } catch (err) {
        toast(err.message, 4000);
      }
      renderEditor();
      break;
    }
    case "add-cable": {
      const n = Math.max(0, ...rec.cables.map((c) => Number(c.key.slice(1)))) + 1;
      rec.cables.push({ key: `C${n}`, role: "output", span_id: "", cable_number: rec.cables.length + 1, fiber_count: 12, fibers_per_tube: 12 });
      await saveNow(); renderEditor();
      break;
    }
    case "add-device": {
      const n = Math.max(0, ...rec.devices.map((d) => Number(d.key.slice(1)))) + 1;
      rec.devices.push({ key: `D${n}`, type: "splitter", label: "1X4 Splitter", ratio: "1X4",
        ports_text: "IN, OUT 1, OUT 2, OUT 3, OUT 4", ports: ["IN", "OUT 1", "OUT 2", "OUT 3", "OUT 4"] });
      await saveNow(); renderEditor();
      break;
    }
    case "remove-cable":
    case "remove-device": {
      const list = el.dataset.action === "remove-cable" ? rec.cables : rec.devices;
      const key = list[idx].key;
      const inUse = rec.splices.filter((s) => s.a?.ref === key || s.b?.ref === key).length;
      if (!confirm(inUse ? `${key} is used in ${inUse} splice entries, which will also be removed. Continue?` : `Remove ${key}?`)) break;
      list.splice(idx, 1);
      rec.splices = rec.splices.filter((s) => s.a?.ref !== key && s.b?.ref !== key);
      state.form = null;
      await saveNow(); renderEditor();
      break;
    }
    case "quick-count":
      state.form.count = Number(el.dataset.n);
      renderEditor();
      break;
    case "save-splice": {
      const f = state.form;
      const count = num(f.count) || 1;
      if (!f.aRef || !num(f.aStart)) { toast("Pick the From cable and start fiber"); break; }
      const entry = { tray: num(f.tray) ?? f.tray, a: { ref: f.aRef, start: num(f.aStart) }, count, status: f.status };
      if (f.bRef) entry.b = { ref: f.bRef, start: num(f.bStart) || 1 };
      if (f.service) entry.service = f.service.trim();
      if (f.note) entry.note = f.note.trim();
      if (f.date) entry.date = f.date;
      if (f.editing != null) rec.splices[f.editing] = entry; else rec.splices.push(entry);
      state.form = f.editing != null ? null : defaultForm(rec);
      await saveNow(); renderEditor();
      toast(`Saved ${count} fiber${count === 1 ? "" : "s"}`, 1200);
      break;
    }
    case "edit-splice": {
      const s = rec.splices[idx];
      state.form = { tray: s.tray, aRef: s.a?.ref, aStart: s.a?.start, bRef: s.b?.ref || "", bStart: s.b?.start || 1,
        count: s.count, status: s.status, service: s.service || "", note: s.note || "", date: s.date || "", editing: idx };
      renderEditor(); window.scrollTo(0, 0);
      break;
    }
    case "cancel-edit":
      state.form = null; renderEditor();
      break;
    case "delete-splice":
      if (!confirm("Delete this entry?")) break;
      rec.splices.splice(idx, 1);
      state.form = null;
      await saveNow(); renderEditor();
      break;
    case "delete-photo":
      if (!confirm("Remove this photo?")) break;
      await db.deletePhoto(rec.photos[idx].id);
      rec.photos.splice(idx, 1);
      await saveNow(); renderEditor();
      break;
    case "add-tap": {
      const prev = rec.taps.at(-1);
      const nextName = prev?.name?.replace(/(\d+)(?!.*\d)/, (m) => String(Number(m) + 1).padStart(m.length, "0")) || "";
      rec.taps.push({ name: nextName, type: prev?.type || "OTE", ports: prev?.ports || 4, feed: "", readings_dbm: [], gps: null });
      state.openTap = rec.taps.length - 1;
      await saveNow(); renderEditor();
      const i = state.openTap;
      getGPS().then(async (gps) => {
        if (state.rec === rec && rec.taps[i] && !rec.taps[i].gps) { rec.taps[i].gps = gps; await saveNow(); renderEditor(); }
      }).catch((err) => toast(err.message, 4000));
      app.querySelector(".tap.open")?.scrollIntoView({ block: "start" });
      break;
    }
    case "open-tap":
      state.openTap = idx; renderEditor();
      app.querySelector(".tap.open")?.scrollIntoView({ block: "start" });
      break;
    case "close-tap":
      state.openTap = null; await flushSave(); renderEditor();
      break;
    case "delete-tap":
      if (!confirm("Delete this tap?")) break;
      rec.taps.splice(idx, 1); state.openTap = null;
      await saveNow(); renderEditor();
      break;
    case "finish": {
      const missing = rec.type === "splice"
        ? [!rec.header.job_id && "Work order #", !rec.header.splice_id && "Splice ID", !rec.header.gps && "GPS", !rec.splices.length && "splices"].filter(Boolean)
        : [!rec.header.job_id && "Work order #", !rec.header.node && "Node number", rec.header.launch_power_dbm == null && "launch power", !rec.taps.length && "taps"].filter(Boolean);
      if (missing.length && !confirm(`Missing: ${missing.join(", ")}. Finish anyway?`)) break;
      if (rec.type === "splice" && !rec.header.time_out) rec.header.time_out = localTime();
      rec._status = "queued";
      await saveNow();
      if (canAutoSend()) { await sendQueued(); renderEditor(); }
      else if (await shareRecords([rec]).catch(() => false)) {
        rec._status = "sent"; rec._sent_at = new Date().toISOString();
        await db.putRecord(rec); renderEditor();
      }
      break;
    }
    case "delete-record":
      if (!confirm(rec._status === "sent" ? "Delete this record from the phone?" : "This record hasn't been sent. Delete it anyway?")) break;
      await db.deleteRecord(rec.uuid);
      location.hash = "#/";
      break;
    case "send-all":
      await sendQueued();
      break;
    case "share-all": {
      const queued = (await db.allRecords()).filter((r) => r._status === "queued");
      if (await shareRecords(queued).catch(() => false)) {
        for (const r of queued) await db.putRecord({ ...r, _status: "sent", _sent_at: new Date().toISOString() });
        renderHome();
      }
      break;
    }
    case "backup": {
      const files = await Promise.all((await db.allRecords()).map(bundleFile));
      const all = new File([JSON.stringify(await Promise.all(files.map((f) => f.text().then(JSON.parse))))],
        `splice-backup-${localDate()}.json`, { type: "application/json" });
      if (navigator.canShare?.({ files: [all] })) await navigator.share({ files: [all] }).catch(() => {});
      else downloadFile(all);
      break;
    }
    case "purge-sent": {
      const sent = (await db.allRecords()).filter((r) => r._status === "sent");
      if (!sent.length) { toast("No sent records to remove"); break; }
      if (!confirm(`Remove ${sent.length} sent record(s)? Only do this once the office confirms they arrived.`)) break;
      for (const r of sent) await db.deleteRecord(r.uuid);
      toast(`Removed ${sent.length}`);
      break;
    }
  }
});

// ------------------------------------------------------------------ routing & startup

async function route() {
  await flushSave();
  const [, view, id] = location.hash.split("/");
  if ((view === "splice" || view === "tap") && id) {
    const rec = await db.getRecord(id);
    if (!rec) { location.hash = "#/"; return; }
    if (state.rec?.uuid !== rec.uuid) { state.tab = "header"; state.form = null; state.openTap = null; }
    state.rec = rec;
    renderEditor();
  } else if (view === "settings") {
    renderSettings();
  } else {
    renderHome();
  }
}

window.addEventListener("hashchange", route);
window.addEventListener("offline", () => !state.rec && renderHome());
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flushSave());

(async () => {
  state.settings = (await db.getMeta("settings")) || {};
  await route();
  requestPersistence();
  sendQueued({ quiet: true });
})();
