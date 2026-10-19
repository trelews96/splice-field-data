// Gets finished records off the phone.
//
// "email" (default): the phone's mail app opens a pre-addressed email with the record compressed
// into its body - the crew just taps Send, and Mail queues it until there's signal. Photos can't ride
// in a pre-addressed email, so they go separately through the share sheet in batches under ~10 MB.
// "post" / "form": background no-cors POSTs (only work where Google accepts them without a login).
//
// Nothing here can see whether delivery succeeded. The receiver de-duplicates by uuid, so resending
// is always safe, and in the email route it replies to the crew to confirm.
import { CONFIG } from "./config.js";
import { db } from "./db.js";

export const canAutoSend = () => CONFIG.transport === "post" || CONFIG.transport === "form";
export const usesEmail = () => CONFIG.transport === "email";

export function cleanRecord(rec) {
  const out = {};
  for (const [k, v] of Object.entries(rec)) if (!k.startsWith("_")) out[k] = v;
  return out;
}

export const workOrder = (rec) => String(rec.header.job_id || "").replace(/\s+/g, "").toUpperCase();
const recordId = (rec) => rec.header.splice_id || rec.header.node || "record";
const safeName = (s) => String(s).replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "X";

// ------------------------------------------------------------------ email route: data

// Keep in sync with DATA_START / DATA_END in apps-script/Code.gs.
export const DATA_START = "----- SPLICE DATA v1 (do not edit) -----";
export const DATA_END = "----- END SPLICE DATA -----";
const MAX_DATA_CHARS = 16000;   // per email - keeps mailto links far inside what mail apps accept

// Synchronous on purpose: the mail app must open in the same tap, or iPhones may block it.
function encodeData(messages) {
  let bytes = new TextEncoder().encode(JSON.stringify(messages));
  if (self.fflate) bytes = self.fflate.gzipSync(bytes, { level: 9 });
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).match(/.{1,76}/g).join("\n");
}

function summaryLine(rec) {
  const wo = workOrder(rec) || "no work order";
  if (rec.type === "splice") {
    const fibers = rec.splices.reduce((n, s) => n + (Number(s.count) || 1), 0);
    const photos = rec.photos?.length ? ` · ${rec.photos.length} photo${rec.photos.length === 1 ? "" : "s"} (sent separately)` : "";
    return `Splice ${recordId(rec)} · WO ${wo} · ${rec.cables.length} cables · ${fibers} fibers${photos}`;
  }
  return `Tap report ${recordId(rec)} · WO ${wo} · ${rec.taps.length} taps`;
}

// Records -> one or more ready-to-open emails, each holding as many records as fit.
export function dataEmails(records) {
  if (!CONFIG.inboxEmail) throw new Error("The inbox email address isn't set in config.js");
  const encoded = records.map((r) => ({ rec: r, size: encodeData([message(r)]).length }));
  const groups = [];
  for (const item of encoded) {
    const g = groups.at(-1);
    if (g && g.size + item.size <= MAX_DATA_CHARS) { g.items.push(item.rec); g.size += item.size; }
    else groups.push({ items: [item.rec], size: item.size });
  }
  return groups.map(({ items }) => {
    const wos = [...new Set(items.map(workOrder).filter(Boolean))];
    const subject = items.length === 1
      ? `[SPLICE] WO ${workOrder(items[0]) || "?"} · ${recordId(items[0])}`
      : `[SPLICE] ${items.length} records · WO ${wos.join(", ") || "?"}`;
    const body = [
      ...items.map(summaryLine), "",
      "Just tap Send - nothing to change. You'll get a reply once it's filed.", "",
      DATA_START, encodeData(items.map(message)), DATA_END, "",
    ].join("\r\n");
    return { records: items, url: `mailto:${CONFIG.inboxEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` };
  });
}

const message = (rec) => ({ kind: "record", token: CONFIG.token, record: cleanRecord(rec) });

export function openMail(url) {
  // window.__openMail is a seam for the automated browser test; phones always navigate.
  (window.__openMail || ((u) => { window.location.href = u; }))(url);
}

// ------------------------------------------------------------------ email route: photos

const PHOTO_BATCH_BYTES = 10 * 1024 * 1024;   // stays under the 20-25 MB send limits after encoding
const PHOTO_BATCH_COUNT = 25;

// The receiver reads the 8-character photo id at the end of the name to file it with its record.
export const photoFileName = (rec, seq, photoId) =>
  `SPLICE_${safeName(workOrder(rec) || "NO-WO")}_${safeName(recordId(rec))}_${String(seq).padStart(2, "0")}_${photoId.slice(0, 8)}.jpg`;

export const unsentPhotoCount = (records) => records
  .filter((r) => r._status !== "draft" && r.photos?.length)
  .reduce((n, r) => n + r.photos.filter((p) => !(r._sent_photos || []).includes(p.id)).length, 0);

// Built ahead of the tap: the share sheet needs to open in the same tap on iPhones.
export async function preparePhotoBatches(records) {
  const items = [];
  for (const rec of records) {
    if (rec._status === "draft" || !rec.photos?.length) continue;
    const sent = new Set(rec._sent_photos || []);
    const blobs = new Map((await db.photosFor(rec.uuid)).map((p) => [p.id, p.blob]));
    rec.photos.forEach((p, i) => {
      if (sent.has(p.id) || !blobs.has(p.id)) return;
      const blob = blobs.get(p.id);
      items.push({ uuid: rec.uuid, photoId: p.id, file: new File([blob], photoFileName(rec, i + 1, p.id), { type: "image/jpeg" }) });
    });
  }
  const batches = [];
  for (const item of items) {
    const b = batches.at(-1);
    if (b && b.bytes + item.file.size <= PHOTO_BATCH_BYTES && b.items.length < PHOTO_BATCH_COUNT) {
      b.items.push(item); b.bytes += item.file.size;
    } else batches.push({ items: [item], bytes: item.file.size });
  }
  return batches;
}

// Returns true when the share went through (or files were downloaded), false if the crew cancelled.
export async function sharePhotoBatch(batch, part, of) {
  const files = batch.items.map((i) => i.file);
  const title = `[SPLICE PHOTOS] ${files.length} photo${files.length === 1 ? "" : "s"}${of > 1 ? ` (part ${part} of ${of})` : ""}`;
  if (navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files, title, text: `Send to ${CONFIG.inboxEmail}` });
    } catch (e) {
      if (e.name === "AbortError") return false;
      throw e;
    }
    return true;
  }
  for (const f of files) downloadFile(f);   // desktop / old browsers
  return true;
}

// ------------------------------------------------------------------ backup file / post / form routes

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

async function photoMessage(photo, rec) {
  const seq = rec.photos.findIndex((p) => p.id === photo.id) + 1;
  return {
    id: photo.id, record_uuid: rec.uuid, name: photoFileName(rec, seq || 1, photo.id),
    mime: photo.blob.type || "image/jpeg", data_base64: await blobToBase64(photo.blob),
  };
}

async function postNoCors(url, body, contentType = "text/plain;charset=utf-8") {
  await fetch(url, { method: "POST", mode: "no-cors", headers: { "Content-Type": contentType }, body });
}

async function sendViaPost(rec) {
  if (!CONFIG.appsScriptUrl) throw new Error("Apps Script URL isn't set in config.js");
  await postNoCors(CONFIG.appsScriptUrl, JSON.stringify(message(rec)));
  const sentPhotos = new Set(rec._sent_photos || []);
  for (const photo of await db.photosFor(rec.uuid)) {
    if (sentPhotos.has(photo.id)) continue;
    await postNoCors(CONFIG.appsScriptUrl, JSON.stringify({ kind: "photo", token: CONFIG.token, photo: await photoMessage(photo, rec) }));
    sentPhotos.add(photo.id);
  }
  return [...sentPhotos];
}

async function sendViaForm(rec) {
  if (!CONFIG.formResponseUrl) throw new Error("Google Form URL isn't set in config.js");
  const body = new URLSearchParams({ [CONFIG.formEntryId]: JSON.stringify(message(rec)) });
  await postNoCors(CONFIG.formResponseUrl, body.toString(), "application/x-www-form-urlencoded");
  return rec._sent_photos || [];
}

// Everything about one record, photos included, as a single file (the "Save backup file" button).
export async function bundleFile(rec) {
  const photos = await Promise.all((await db.photosFor(rec.uuid)).map((p) => photoMessage(p, rec)));
  const bundle = { kind: "bundle", token: CONFIG.token, record: cleanRecord(rec), photos };
  return new File([JSON.stringify(bundle)], `${safeName(recordId(rec))}_${rec.uuid.slice(0, 8)}.splice.json`, { type: "application/json" });
}

export function downloadFile(file) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// post / form routes: returns the updated record; throws if the phone couldn't reach the network.
export async function sendRecord(rec) {
  const sentPhotos = CONFIG.transport === "form" ? await sendViaForm(rec) : await sendViaPost(rec);
  return { ...rec, _status: "sent", _sent_at: new Date().toISOString(), _sent_photos: sentPhotos };
}
