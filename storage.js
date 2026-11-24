const appPath = new URL('./', import.meta.url).pathname;
const database = new Promise((resolve, reject) => {
  const request = indexedDB.open('exhibit-video-player:' + appPath, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('videos', { keyPath: 'id' });
    request.result.createObjectStore('preferences');
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function transaction(store, mode, action) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = action(tx.objectStore(store));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error || request.error || new Error('保存できませんでした'));
  });
}

export const readVideos = () => transaction('videos', 'readonly', store => store.getAll());
export const addVideo = video => transaction('videos', 'readwrite', store => store.add(video));
export const removeVideo = id => transaction('videos', 'readwrite', store => store.delete(id));

export async function updateVideo(id, changes) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('videos', 'readwrite');
    const store = tx.objectStore('videos');
    const request = store.get(id);
    request.onsuccess = () => {
      if (request.result) store.put({ ...request.result, ...changes });
    };
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error('保存できませんでした'));
  });
}

export const readPreference = key => transaction('preferences', 'readonly', store => store.get(key));
export const writePreference = (key, value) => transaction('preferences', 'readwrite', store => store.put(value, key));
