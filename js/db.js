// IndexedDB wrapper: records, photos (as Blobs) and settings live on the device until the user clears them.
const DB_NAME = "splice-field";
const VERSION = 1;
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("records", { keyPath: "uuid" });
      db.createObjectStore("photos", { keyPath: "id" }).createIndex("record_uuid", "record_uuid");
      db.createObjectStore("meta");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    t.onerror = () => reject(t.error);
  });
}

export const db = {
  allRecords: () => tx("records", "readonly", (s) => s.getAll()),
  getRecord: (uuid) => tx("records", "readonly", (s) => s.get(uuid)),
  putRecord: (rec) => tx("records", "readwrite", (s) => s.put(rec)),
  async deleteRecord(uuid) {
    const photos = await this.photosFor(uuid);
    await tx("photos", "readwrite", (s) => photos.forEach((p) => s.delete(p.id)));
    return tx("records", "readwrite", (s) => s.delete(uuid));
  },
  photosFor: (uuid) => tx("photos", "readonly", (s) => s.index("record_uuid").getAll(uuid)),
  putPhoto: (photo) => tx("photos", "readwrite", (s) => s.put(photo)),
  deletePhoto: (id) => tx("photos", "readwrite", (s) => s.delete(id)),
  getMeta: (key) => tx("meta", "readonly", (s) => s.get(key)),
  setMeta: (key, value) => tx("meta", "readwrite", (s) => s.put(value, key)),
};

// Ask the browser not to evict our data (matters most on iOS Safari).
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      return await navigator.storage.persist();
    }
    return true;
  } catch {
    return false;
  }
}
