// Gets finished records off the phone. Responses from Google can't be read (no-cors), so a
// resolved request only means "handed to the network". The receiver de-duplicates by uuid,
// which makes resending always safe.
import { CONFIG } from "./config.js";
import { db } from "./db.js";

export const canAutoSend = () => CONFIG.transport === "post" || CONFIG.transport === "form";

export function cleanRecord(rec) {
  const out = {};
  for (const [k, v] of Object.entries(rec)) if (!k.startsWith("_")) out[k] = v;
  return out;
}

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

// Label lets the receiver file photos by work order and splice/node instead of by uuid alone.
const recordLabel = (rec) => [rec.header.job_id, rec.header.splice_id || rec.header.node].filter(Boolean).join("_");

async function photoMessage(photo, rec) {
  const caption = rec.photos?.find((p) => p.id === photo.id)?.caption ?? photo.caption ?? "";
  return {
    id: photo.id, record_uuid: photo.record_uuid, record_label: recordLabel(rec), caption,
    work_order: String(rec.header.job_id || "").replace(/\s+/g, "").toUpperCase(),
    taken_at: photo.taken_at, mime: photo.blob.type || "image/jpeg",
    data_base64: await blobToBase64(photo.blob),
  };
}

async function postNoCors(url, body, contentType = "text/plain;charset=utf-8") {
  await fetch(url, { method: "POST", mode: "no-cors", headers: { "Content-Type": contentType }, body });
}

async function sendViaPost(rec) {
  if (!CONFIG.appsScriptUrl) throw new Error("Apps Script URL isn't set in config.js");
  await postNoCors(CONFIG.appsScriptUrl, JSON.stringify({ kind: "record", token: CONFIG.token, record: cleanRecord(rec) }));
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
  const body = new URLSearchParams({
    [CONFIG.formEntryId]: JSON.stringify({ kind: "record", token: CONFIG.token, record: cleanRecord(rec) }),
  });
  await postNoCors(CONFIG.formResponseUrl, body.toString(), "application/x-www-form-urlencoded");
  return rec._sent_photos || [];
}

export async function bundleFile(rec) {
  const photos = await Promise.all((await db.photosFor(rec.uuid)).map((p) => photoMessage(p, rec)));
  const bundle = { kind: "bundle", token: CONFIG.token, record: cleanRecord(rec), photos };
  const id = (rec.header.splice_id || rec.header.node || "record").replace(/[^\w.-]+/g, "_");
  return new File([JSON.stringify(bundle)], `${id}_${rec.uuid.slice(0, 8)}.splice.json`, { type: "application/json" });
}

// Must run inside a tap handler: the share sheet needs a user gesture.
export async function shareRecords(records) {
  const files = await Promise.all(records.map(bundleFile));
  const text = `Splice field data (${records.length} record${records.length === 1 ? "" : "s"})` +
    (CONFIG.inboxEmail ? ` - send to ${CONFIG.inboxEmail}` : "");
  if (navigator.canShare?.({ files })) {
    await navigator.share({ files, title: text, text });
    return true;
  }
  // Desktop / old browsers: download instead.
  for (const f of files) downloadFile(f);
  return true;
}

export function downloadFile(file) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// Returns the updated record; throws if the phone couldn't reach the network.
export async function sendRecord(rec) {
  const sentPhotos = CONFIG.transport === "form" ? await sendViaForm(rec) : await sendViaPost(rec);
  return { ...rec, _status: "sent", _sent_at: new Date().toISOString(), _sent_photos: sentPhotos };
}
