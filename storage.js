'use strict';
window.exhibitStorage = (() => {
  const appPath = new URL('./', location.href).pathname;
  const defaultSet = { id: 'default', name: '最初のセット' };
  const preferenceKeys = ['layout', 'decorations', 'order', 'tileOrder'];
  const database = new Promise((resolve, reject) => {
    const request = indexedDB.open('exhibit-video-player:' + appPath, 2);
    request.onupgradeneeded = event => {
      const db = request.result;
      if (event.oldVersion === 0) {
        db.createObjectStore('videos', { keyPath: 'id' });
        db.createObjectStore('preferences');
      }
      const sets = db.createObjectStore('sets', { keyPath: 'id' });
      sets.createIndex('name', 'name', { unique: true });
      sets.add(defaultSet);
      db.createObjectStore('setVideos', { keyPath: ['setId', 'id'] }).createIndex('setId', 'setId');
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('別のタブやウィンドウで開いている展示動画プレイヤーをすべて閉じ、この画面を開き直してください。'));
  });

  async function transaction(stores, mode, action) {
    const db = await database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const result = action(tx);
      tx.oncomplete = () => resolve(result());
      tx.onabort = () => reject(tx.error || new Error('保存できませんでした'));
    });
  }

  function one(store, mode, action) {
    return transaction(store, mode, tx => {
      const request = action(tx.objectStore(store));
      return () => request.result;
    });
  }

  const readSets = () => one('sets', 'readonly', store => store.getAll());
  const readActiveSet = () => one('preferences', 'readonly', store => store.get('activeSet'));

  function setActiveSet(id, newSet) {
    return transaction(['sets', 'preferences'], 'readwrite', tx => {
      if (newSet) tx.objectStore('sets').add(newSet);
      tx.objectStore('preferences').put(id, 'activeSet');
      return () => undefined;
    });
  }

  function renameSet(id, name) {
    return one('sets', 'readwrite', store => store.put({ id, name }));
  }

  function openSet(setId) {
    const legacy = setId === defaultSet.id;
    const videoStore = legacy ? 'videos' : 'setVideos';
    const preferenceKey = key => legacy ? key : [setId, key];
    const videoKey = id => legacy ? id : [setId, id];

    function read() {
      return transaction([videoStore, 'preferences'], 'readonly', tx => {
        const store = tx.objectStore(videoStore);
        const videos = legacy ? store.getAll() : store.index('setId').getAll(setId);
        const preferences = tx.objectStore('preferences');
        const requests = preferenceKeys.map(key => [key, preferences.get(preferenceKey(key))]);
        return () => ({
          videos: videos.result,
          ...Object.fromEntries(requests.map(([key, request]) => [key, request.result])),
        });
      });
    }

    function updateVideo(id, changes) {
      return transaction(videoStore, 'readwrite', tx => {
        const store = tx.objectStore(videoStore);
        const request = store.get(videoKey(id));
        request.onsuccess = () => {
          if (request.result) store.put({ ...request.result, ...changes });
        };
        return () => undefined;
      });
    }

    return {
      read, updateVideo,
      addVideo: video => one(videoStore, 'readwrite', store => store.add(legacy ? video : { ...video, setId })),
      removeVideo: id => one(videoStore, 'readwrite', store => store.delete(videoKey(id))),
      writePreference: (key, value) => one('preferences', 'readwrite', store => store.put(value, preferenceKey(key))),
    };
  }

  return { defaultSet, openSet, readSets, readActiveSet, setActiveSet, renameSet };
})();
