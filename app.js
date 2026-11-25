'use strict';
const { readVideos, addVideo, removeVideo, updateVideo, readPreference, writePreference } = window.exhibitStorage;
const { parseTimecode, formatTimecode, playbackTiles, sequenceId, sequenceDuration, sequencePosition, sequenceSeek } = window.exhibitClips;

const $ = id => document.getElementById(id);
const inlinePlayer = $('player');
let output = inlinePlayer;
let player = inlinePlayer;
let standby;
let preloadedCut;
let sequenceActive = false;
let playIntent = 0;
let changingCut = false;
const playbackEvents = ['play', 'playing', 'pause', 'ended', 'timeupdate', 'durationchange', 'emptied', 'seeking', 'seeked', 'ratechange'];
const preview = $('preview-video');
const settings = $('settings-dialog');
const rail = $('rail');
const railTrack = $('rail-track');
const isIPad = /iPad/i.test(navigator.userAgent) ||
  (/Mac/i.test(navigator.platform) && navigator.maxTouchPoints > 1);
const isIPhone = /iPhone|iPod/i.test(navigator.userAgent);
const isWindows = /Windows/i.test(navigator.userAgent);
const canPlaceProjection = () => !isIPhone && location.protocol !== 'file:' &&
  typeof window.getScreenDetails === 'function';
const defaults = {
  top: 4, width: 90, height: 100, x: 50, rail: 22, thumb: 150, railMode: 'even',
  controlsVisible: true, controlsPosition: 'bottom', gearVisible: true,
};
const pcDefaults = {
  arrangement: 'grid', columns: 0, gridGap: 10, rail: 28, thumb: 150, railMode: 'even',
  controlsVisible: true, controlsPosition: 'top', gearVisible: true,
};
const pcRailSpecs = [
  ['rail', 'サムネイル帯の高さ', 14, 100, '%'],
  ['thumb', 'サムネイルの幅', 70, 440, ' px'],
];
const pcGridSpecs = [['gridGap', 'グリッドの間隔', 0, 48, ' px']];
const defaultGap = 9;
const maxGap = 1000;
const layoutSpecs = [
  ['top', '上部の余白', 0, 20, '%'],
  ['width', '動画枠の幅', 32, 100, '%'],
  ['height', '動画枠の高さ', 30, 100, '%'],
  ['x', '動画枠の横位置', 0, 100, '%'],
  ['rail', 'サムネイル帯の高さ', 14, 37, '%'],
  ['thumb', 'サムネイルの幅', 70, 260, ' px'],
];
const typeLabels = { text: 'テキスト', rect: '四角', circle: '円', image: 'イラスト画像' };
const objectSpecs = [['x', '横位置', 0, 100, '%'], ['y', '縦位置', 0, 100, '%']];
const urls = new Map();
let videos = [];
let decorations = [];
let layout = loadLayout();
let layoutTarget = 'single';
let currentId;
let currentClipId;
let clipEndTimer;
let tileOrder = [];
let clipDraft;
let clipSavePending = false;
let editorId;
let objectId;
let activeTab = 'library';
let importBusy = false;
let noticeTimer;
let audioContext;
const mediaGains = new WeakMap();
let editorGeneration = 0;
let pendingEditorPosition = null;
let auditioning = false;
let previewStopAt = null;
let previewIntent = 0;
let previewEndTimer;
let previewFrameRate = 30;
let settingsPosition;
let dialogDrag;
let ready = false;
let projectionWindow;
let projectionTimer;
let projectionDeadline;
let projectionConnection;
let resolveProjectionConnection;
let projectionKeepSettings = false;
let externalProjection;
let pendingExternalProjection;
let projectionDisplayBusy = false;
let playbackPosition = 0;

const current = () => videos.find(video => video.id === currentId);
const activeClip = () => current()?.clips?.find(clip => clip.id === currentClipId);
const tiles = () => playbackTiles(videos, tileOrder);
const activeTileId = () => sequenceActive && current() ? sequenceId(current()) : (currentClipId ?? currentId);
const transportPosition = () => sequenceActive ? sequencePosition(current()?.clips || [], activeClip(), player.currentTime) : player.currentTime;
const edited = () => videos.find(video => video.id === editorId);
const selectedObject = () => decorations.find(object => object.id === objectId);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function loadLayout(saved = {}) {
  const { projection, projectionLayout, ...single } = saved;
  return {
    ...defaults, ...single, gaps: { ...single.gaps },
    projection: {
      ...pcDefaults,
      arrangement: projectionLayout ?? pcDefaults.arrangement,
      thumb: single.thumb ?? pcDefaults.thumb,
      railMode: single.railMode ?? pcDefaults.railMode,
      ...projection,
      gaps: { ...(projection?.gaps ?? single.gaps) },
    },
  };
}

function screenLayout(projected) {
  return projected ? layout.projection : layout;
}

function editingLayout() {
  return screenLayout(layoutTarget === 'pc');
}

function gridDimensions(count, requestedColumns) {
  const automatic = Math.min(6, Math.ceil(Math.sqrt(count)));
  const columns = Math.max(1, Math.min(count, requestedColumns || automatic));
  return { columns, rows: Math.max(1, Math.ceil(count / columns)) };
}

function urlFor(blob) {
  if (!blob) return '';
  if (!urls.has(blob)) urls.set(blob, URL.createObjectURL(blob));
  return urls.get(blob);
}

function releaseUrl(blob) {
  if (!urls.has(blob)) return;
  URL.revokeObjectURL(urls.get(blob));
  urls.delete(blob);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, onClick, className = 'secondary', shortLabel = label) {
  const node = element('button', className, shortLabel);
  node.type = 'button';
  if (shortLabel !== label) {
    node.setAttribute('aria-label', label);
    node.title = label;
  }
  node.addEventListener('click', onClick);
  return node;
}

function time(value, precise = false) {
  const safe = Math.max(0, Number.isFinite(value) ? value : 0);
  const minutes = Math.floor(safe / 60);
  const seconds = String(Math.floor(safe) % 60).padStart(2, '0');
  const fraction = precise ? '.' + String(Math.floor((safe % 1) * 100 + 0.000001)).padStart(2, '0') : '';
  return minutes + ':' + seconds + fraction;
}

function message(node, text) {
  node.textContent = text;
  node.hidden = !text;
}

function notify(text) {
  message($('notice'), text);
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => message($('notice'), ''), 5000);
}

function saveError() {
  notify('設定を保存できませんでした。端末の空き容量をご確認ください。');
  if (settings.open) message($('import-state'), '設定を保存できませんでした。');
}

function storePreference(key, value) {
  return writePreference(key, value).catch(saveError);
}

function applyVolume(media, value) {
  const volume = clamp(value / 100, 0, 1);
  media.muted = !volume;
  let gain = mediaGains.get(media);
  try {
    media.volume = gain ? 1 : volume;
    // Use the media element's own audio whenever the browser allows volume changes.
    if (!gain && volume > 0 && Math.abs(media.volume - volume) > 0.001 && media.ownerDocument === document) {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (Audio) {
        audioContext ||= new Audio();
        const source = audioContext.createMediaElementSource(media);
        gain = audioContext.createGain();
        source.connect(gain);
        gain.connect(audioContext.destination);
        mediaGains.set(media, gain);
      }
    }
    if (gain) {
      gain.gain.value = volume;
      if (audioContext.state !== 'running') audioContext.resume().catch(() => {});
    }
  } catch {
    // The system output volume remains available if the browser declines software volume.
  }
}

function renderRailSpacing(track, config) {
  track.dataset.mode = config.railMode;
  Array.from(track.children).forEach((tile, index) => {
    const gap = index === 0 ? 0 : (config.gaps[tile.dataset.id] ?? defaultGap);
    tile.style.setProperty('--tile-gap', gap + 'px');
  });
}

function renderRail() {
  const scroll = rail.scrollLeft;
  railTrack.replaceChildren();
  for (const entry of tiles()) {
    const tile = button(entry.title, () => selectEntry(entry), 'tile', '');
    tile.title = entry.title;
    tile.dataset.id = entry.id;
    tile.setAttribute('aria-current', String(entry.id === activeTileId()));
    const thumb = entry.thumbnail ? element('img', 'thumb') : element('span', 'thumb', '▷');
    if (entry.thumbnail) {
      thumb.src = urlFor(entry.thumbnail);
      thumb.alt = '';
    }
    const caption = element('span', 'caption', entry.title);
    if (entry.align) caption.style.textAlign = entry.align;
    tile.append(thumb, caption);
    railTrack.append(tile);
  }
  renderTileOrder();
  renderProjection();
  rail.scrollLeft = scroll;
  if (activeTab === 'layout') {
    renderRailSettings();
    renderMock('layout');
  }
}

function nextCut() {
  if (!sequenceActive) return undefined;
  const clips = current()?.clips || [];
  const index = clips.findIndex(clip => clip.id === currentClipId);
  return index >= 0 ? clips[index + 1] : undefined;
}

function wirePlayback(media, listen) {
  for (const event of [...playbackEvents, 'loadedmetadata']) {
    if (listen) media.addEventListener(event, updatePlayer);
    else media.removeEventListener(event, updatePlayer);
  }
}

function discardPreload() {
  preloadedCut = undefined;
  if (!standby) return;
  standby.pause();
  standby.removeAttribute('src');
  standby.load();
}

async function positionMedia(media, position, valid) {
  if (media.readyState < 1) await mediaEvent(media, 'loadedmetadata', 5000);
  if (!valid()) return false;
  if (!media.seeking && Math.abs(media.currentTime - position) < 0.002) return true;
  const seek = mediaEvent(media, 'seeked', 5000);
  if (Math.abs(media.currentTime - position) >= 0.002) media.currentTime = position;
  await seek;
  return valid();
}

function prepareNextCut() {
  const next = nextCut();
  const clip = activeClip();
  const video = current();
  if (!next || !video || Math.abs(next.start - clip.end) < 0.002) {
    if (preloadedCut) discardPreload();
    return;
  }
  if (preloadedCut?.id === next.id && preloadedCut.start === next.start) return;
  if (!standby) {
    standby = output.ownerDocument.createElement('video');
    standby.className = 'standby-video';
    standby.playsInline = true;
    standby.preload = 'auto';
    standby.setAttribute('disablepictureinpicture', '');
    standby.setAttribute('aria-hidden', 'true');
    standby.dataset.inactiveStream = '';
    output.after(standby);
  }
  const media = standby;
  const cut = { id: next.id, start: next.start, ready: false };
  preloadedCut = cut;
  const url = urlFor(video.file);
  if (media.getAttribute('src') !== url) {
    media.src = url;
    media.load();
  }
  positionMedia(media, next.start, () => preloadedCut === cut).then(ready => {
    if (preloadedCut === cut) cut.ready = ready;
  }).catch(() => {});
}

function stopActive() {
  playIntent += 1;
  if (changingCut) standby?.pause();
  changingCut = false;
  player.pause();
}

async function advanceCut(next) {
  const previous = player;
  const token = ++playIntent;
  changingCut = true;
  previous.pause();
  const prepared = preloadedCut?.id === next.id && preloadedCut.start === next.start && preloadedCut.ready ? standby : null;
  if (prepared) {
    try {
      applyVolume(prepared, current().volume);
      await prepared.play();
      if (token !== playIntent) {
        if (prepared !== player) prepared.pause();
        return;
      }
      wirePlayback(previous, false);
      previous.dataset.inactiveStream = '';
      delete prepared.dataset.inactiveStream;
      player = prepared;
      standby = previous;
      preloadedCut = undefined;
      wirePlayback(player, true);
      currentClipId = next.id;
      changingCut = false;
      prepareNextCut();
      updatePlayer();
      return;
    } catch {
      if (prepared !== player) prepared.pause();
    }
  }
  if (token !== playIntent) return;
  currentClipId = next.id;
  await startAt(next.start, true);
}

function clipBoundary() {
  clearTimeout(clipEndTimer);
  const clip = activeClip();
  if (!clip || changingCut || (player.paused && !player.ended) || player.seeking || !Number.isFinite(player.duration)) return;
  const end = Math.min(clip.end, player.duration);
  const remaining = end - player.currentTime;
  if (remaining <= 0) {
    const next = nextCut();
    if (next && Math.abs(next.start - end) < 0.002 && player.currentTime < next.end) {
      currentClipId = next.id;
      prepareNextCut();
    } else if (next) {
      advanceCut(next);
    } else {
      player.pause();
      if (player.currentTime > end) player.currentTime = end;
    }
    return;
  }
  if (remaining <= 1) {
    clipEndTimer = setTimeout(updatePlayer, Math.max(20, remaining * 1000 / Math.max(0.01, player.playbackRate)));
  }
}

function clearPlayback() {
  clearTimeout(clipEndTimer);
  stopActive();
  discardPreload();
  currentId = currentClipId = undefined;
  sequenceActive = false;
  playbackPosition = 0;
  player.removeAttribute('src');
  player.load();
}

function updatePlayer() {
  clipBoundary();
  const hasVideo = Boolean(current());
  const duration = Number.isFinite(player.duration) ? player.duration : 0;
  const position = player.currentTime || 0;
  if (duration) playbackPosition = position;
  const isPlaying = hasVideo && (changingCut || (!player.paused && !player.ended));
  $('empty').hidden = hasVideo;
  const hasTiles = railTrack.children.length > 0;
  $('empty-title').textContent = hasTiles ? '動画を選択' : '表示するサムネイルがありません';
  $('empty-text').textContent = hasTiles ? 'サムネイルをタップして再生' : '設定からサムネイルを追加してください';
  const clip = activeClip();
  const displayPosition = transportPosition();
  $('elapsed').textContent = clip ? formatTimecode(Math.round(displayPosition * 10) / 10) : time(position);
  const start = sequenceActive ? 0 : (clip?.start ?? 0);
  const end = sequenceActive ? sequenceDuration(current()?.clips || []) : (duration ? Math.min(clip?.end ?? duration, duration) : 0);
  $('duration').textContent = clip ? formatTimecode(end) : time(end);
  $('timeline').min = start;
  $('timeline').max = end || start + 1;
  $('timeline').value = clamp(displayPosition, start, end || start + 1);
  $('timeline').disabled = !end;
  $('back').disabled = !end;
  $('forward').disabled = !end;
  $('toggle').disabled = !hasVideo;
  const playLabel = isPlaying ? '一時停止' : '再生';
  $('toggle').setAttribute('aria-label', playLabel);
  $('toggle').title = playLabel;
  $('toggle').firstElementChild.classList.toggle('pause', isPlaying);
  for (const tile of rail.querySelectorAll('.tile')) {
    tile.setAttribute('aria-current', String(tile.dataset.id === activeTileId()));
  }
}

function playMain() {
  const video = current();
  if (!video) return;
  const target = player;
  const clip = activeClip();
  if (clip && (target.currentTime < clip.start - 0.002 || target.currentTime >= clip.end)) {
    if (sequenceActive && target.currentTime >= clip.end) currentClipId = (nextCut() ?? video.clips[0]).id;
    startAt(activeClip().start, true);
    return;
  }
  applyVolume(target, video.volume);
  const intent = playIntent;
  target.play().then(() => {
    if (player === target && playIntent === intent && !target.paused) prepareNextCut();
  }).catch(error => {
    if (player !== target || playIntent !== intent || error.name === 'AbortError') return;
    if (error.name === 'NotAllowedError') {
      notify('開始位置を準備しました。もう一度サムネイルか再生ボタンを押してください。');
    } else {
      notify('再生できませんでした。もう一度サムネイルを選んでください。');
    }
  });
}

async function startAt(position, resume) {
  const target = player;
  const token = ++playIntent;
  changingCut = resume;
  target.pause();
  try {
    if (target.readyState < 1 || target.seeking || Math.abs(target.currentTime - position) >= 0.002) {
      if (!await positionMedia(target, position, () => playIntent === token && player === target)) return;
    }
    if (playIntent !== token) return;
    changingCut = false;
    if (resume) playMain();
    updatePlayer();
  } catch {
    if (playIntent !== token) return;
    changingCut = false;
    updatePlayer();
    notify('開始位置を読み込めませんでした。もう一度サムネイルを選んでください。');
  }
}

function selectEntry({ video, clip, id, sequence }) {
  const previous = current();
  if (!clip && activeTileId() === id) {
    if (player.ended) player.currentTime = 0;
    if (player.paused) playMain();
    return;
  }
  stopAudition();
  stopActive();
  discardPreload();
  currentId = video.id;
  currentClipId = clip?.id;
  sequenceActive = Boolean(sequence);
  playbackPosition = clip?.start ?? 0;
  if (previous !== video) {
    player.src = urlFor(video.file);
    player.load();
    if (previous && previous.id !== editorId) releaseUrl(previous.file);
  }
  if (clip && (clip.start > 0 || player.currentTime > 0.002 || player.seeking)) {
    startAt(clip.start, true);
  } else {
    if (previous === video && player.currentTime !== 0) player.currentTime = 0;
    playMain();
  }
  updatePlayer();
}

function seekMain(position) {
  if (!Number.isFinite(player.duration)) return;
  const clip = activeClip();
  if (!clip) {
    player.currentTime = clamp(position, 0, player.duration);
    return;
  }
  const end = sequenceActive ? sequenceDuration(current().clips) : Math.min(clip.end, player.duration);
  const target = clamp(position, sequenceActive ? 0 : clip.start, end);
  const located = sequenceActive ? sequenceSeek(current().clips, target) : { clip, time: target };
  const resume = target < end && (!player.paused || changingCut);
  currentClipId = located.clip.id;
  discardPreload();
  startAt(located.time, resume);
}

wirePlayback(inlinePlayer, true);
$('toggle').onclick = () => {
  if (changingCut || !player.paused) {
    stopActive();
    updatePlayer();
  } else playMain();
};
$('back').onclick = () => seekMain(transportPosition() - 10);
$('forward').onclick = () => seekMain(transportPosition() + 10);
$('timeline').oninput = event => seekMain(Number(event.target.value));

function setTab(tab, target = output === inlinePlayer ? 'single' : 'pc') {
  if (tab === 'layout' && activeTab !== 'layout') layoutTarget = target;
  if (tab !== 'library') stopAudition();
  activeTab = tab;
  for (const node of settings.querySelectorAll('[data-tab]')) {
    const selected = node.dataset.tab === tab;
    node.setAttribute('aria-pressed', String(selected));
    $(node.dataset.tab).hidden = !selected;
  }
  if (tab === 'layout') renderLayoutSettings();
  if (tab === 'projection') renderProjection();
  if (tab === 'layout' || tab === 'objects') renderMock(tab);
}

function constrainSettings(left, top) {
  const width = settings.offsetWidth;
  const handleHeight = $('settings-handle').offsetHeight;
  const visibleWidth = Math.min(width, 88);
  const visibleHeight = Math.min(handleHeight, 32);
  return {
    left: clamp(left, visibleWidth - width, window.innerWidth - visibleWidth),
    top: clamp(top, visibleHeight - handleHeight, window.innerHeight - visibleHeight),
  };
}

function setSettingsPosition(left, top) {
  settingsPosition = constrainSettings(left, top);
  settings.dataset.positioned = '';
  settings.style.left = settingsPosition.left + 'px';
  settings.style.top = settingsPosition.top + 'px';
}

const settingsHandle = $('settings-handle');
settingsHandle.addEventListener('pointerdown', event => {
  if (event.button !== 0 || event.target.closest('button')) return;
  const { left, top } = settings.getBoundingClientRect();
  dialogDrag = { id: event.pointerId, x: event.clientX - left, y: event.clientY - top };
  settingsHandle.setPointerCapture(event.pointerId);
});
settingsHandle.addEventListener('pointermove', event => {
  if (dialogDrag?.id !== event.pointerId) return;
  setSettingsPosition(event.clientX - dialogDrag.x, event.clientY - dialogDrag.y);
});
settingsHandle.addEventListener('lostpointercapture', () => { dialogDrag = undefined; });

settings.addEventListener('exhibit-settings-open', () => {
  if (settingsPosition) setSettingsPosition(settingsPosition.left, settingsPosition.top);
  const target = output === inlinePlayer ? 'single' : 'pc';
  if (activeTab === 'layout') layoutTarget = target;
  setTab(activeTab, target);
});

$('open-pc-layout').onclick = () => setTab('layout', 'pc');
document.addEventListener('keydown', event => {
  if (output === inlinePlayer || settings.open || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key.toLowerCase() !== 's' || event.target.closest('input, textarea, select, [contenteditable]')) return;
  event.preventDefault();
  $('settings').click();
});
$('add-videos').onclick = () => $('video-picker').click();
settings.addEventListener('close', stopAudition);
for (const tab of settings.querySelectorAll('[data-tab]')) tab.onclick = () => setTab(tab.dataset.tab);

function renderLibrary() {
  const list = $('library-list');
  list.replaceChildren();
  if (!videos.length) list.append(element('p', 'message', '登録済みの動画はありません'));
  videos.forEach((video, index) => {
    const row = element('div', 'list-row');
    row.classList.toggle('active', video.id === editorId);
    const open = button((video.caption || video.name) + 'を編集', () => editVideo(video), 'list-main', '');
    if (video.thumbnail) {
      const thumb = element('img');
      thumb.src = urlFor(video.thumbnail);
      thumb.alt = '';
      open.append(thumb);
    }
    open.append(element('span', '', video.caption || video.name));
    const up = button('前へ移動', () => moveVideo(index, -1), 'secondary', '↑');
    const down = button('後ろへ移動', () => moveVideo(index, 1), 'secondary', '↓');
    up.disabled = index === 0;
    down.disabled = index === videos.length - 1;
    row.append(open, up, down, button('登録解除', () => deleteVideo(video)));
    list.append(row);
  });
}

async function moveVideo(index, offset) {
  const next = index + offset;
  if (!videos[next]) return;
  [videos[index], videos[next]] = [videos[next], videos[index]];
  renderLibrary();
  renderRail();
  await persistOrder();
}

function persistOrder() {
  return storePreference('order', videos.map(video => video.id));
}

function renderTileOrder() {
  const list = $('tile-order-list');
  list.replaceChildren();
  $('tile-order-panel').hidden = !tileOrder.length && !videos.some(video => video.clips?.length);
  if ($('tile-order-panel').hidden) return;
  const entries = tiles();
  entries.forEach((entry, index) => {
    const row = element('div', 'list-row');
    const title = element('span', 'tile-order-name', entry.title);
    const up = button(entry.title + 'を前へ移動', () => moveTile(index, -1), 'secondary', '↑');
    const down = button(entry.title + 'を後ろへ移動', () => moveTile(index, 1), 'secondary', '↓');
    up.disabled = index === 0;
    down.disabled = index === entries.length - 1;
    row.append(title, up, down);
    list.append(row);
  });
}

function moveTile(index, offset) {
  const order = tiles().map(entry => entry.id);
  const next = index + offset;
  if (!order[next]) return;
  [order[index], order[next]] = [order[next], order[index]];
  tileOrder = order;
  storePreference('tileOrder', tileOrder);
  renderRail();
}

$('reset-tile-order').onclick = () => {
  tileOrder = [];
  storePreference('tileOrder', tileOrder);
  renderRail();
};

function forgetTiles(ids) {
  const order = tileOrder.filter(id => !ids.includes(id));
  if (order.length !== tileOrder.length) {
    tileOrder = order;
    storePreference('tileOrder', tileOrder);
  }
  const configured = [layout.gaps, layout.projection.gaps];
  const stale = ids.filter(id => configured.some(gaps => Object.hasOwn(gaps, id)));
  if (!stale.length) return;
  for (const gaps of configured) for (const id of stale) delete gaps[id];
  storePreference('layout', layout);
}

async function deleteVideo(video) {
  if (!confirm('「' + (video.caption || video.name) + '」の登録を解除しますか？')) return;
  try {
    await removeVideo(video.id);
    if (editorId === video.id) closeEditor();
    if (currentId === video.id) clearPlayback();
    videos = videos.filter(item => item.id !== video.id);
    forgetTiles([video.id, sequenceId(video), ...(video.clips || []).map(clip => clip.id)]);
    releaseUrl(video.file);
    releaseUrl(video.thumbnail);
    for (const clip of video.clips || []) releaseUrl(clip.thumbnail);
    renderLibrary();
    renderRail();
    updatePlayer();
    await persistOrder();
  } catch {
    message($('import-state'), '登録を解除できませんでした。');
  }
}

function mediaEvent(media, event, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('動画の読み込みに時間がかかっています')), timeout);
    const onReady = () => done();
    const onError = () => done(new Error('この動画形式を再生できません'));
    function done(error) {
      clearTimeout(timer);
      media.removeEventListener(event, onReady);
      media.removeEventListener('error', onError);
      if (error) reject(error);
      else resolve();
    }
    media.addEventListener(event, onReady, { once: true });
    media.addEventListener('error', onError, { once: true });
  });
}

function snapshot(media) {
  return new Promise((resolve, reject) => {
    if (!media.videoWidth || !media.videoHeight || media.readyState < 2) {
      reject(new Error('動画のフレームを読み込めませんでした'));
      return;
    }
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 480 / Math.max(media.videoWidth, media.videoHeight));
    canvas.width = Math.max(1, Math.round(media.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(media.videoHeight * scale));
    canvas.getContext('2d').drawImage(media, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('画像を作成できませんでした')), 'image/jpeg', 0.84);
  });
}

async function inspectVideo(file, frameAt = 0) {
  const media = document.createElement('video');
  media.playsInline = true;
  media.muted = true;
  media.preload = 'auto';
  const localUrl = URL.createObjectURL(file);
  try {
    const metadata = mediaEvent(media, 'loadedmetadata');
    media.src = localUrl;
    await metadata;
    if (!media.videoWidth || !Number.isFinite(media.duration)) throw new Error('この動画形式を再生できません');
    if (frameAt > 0) {
      const seek = mediaEvent(media, 'seeked', 2400);
      media.currentTime = frameAt;
      await seek;
    }
    if (media.readyState < 2) {
      try { await mediaEvent(media, 'loadeddata', 1400); }
      catch {
        // Some devices defer frame decoding until the video is opened in the editor.
      }
    }
    const thumbnail = media.readyState >= 2 ? await snapshot(media).catch(() => null) : null;
    return { duration: media.duration, thumbnail };
  } finally {
    media.removeAttribute('src');
    media.load();
    URL.revokeObjectURL(localUrl);
  }
}

$('video-picker').onchange = async event => {
  const files = Array.from(event.target.files);
  event.target.value = '';
  if (!files.length || importBusy || !ready) return;
  importBusy = true;
  $('add-videos').disabled = true;
  navigator.storage?.persist?.().catch(() => {});
  let saved = 0;
  const failures = [];
  for (const [index, file] of files.entries()) {
    message($('import-state'), '取り込み中 ' + (index + 1) + ' / ' + files.length + ' · ' + file.name);
    try {
      const media = await inspectVideo(file);
      const video = { id: crypto.randomUUID(), file, name: file.name, caption: '', volume: 100, frame: 0, addedAt: Date.now(), ...media };
      await addVideo(video);
      videos.push(video);
      saved += 1;
      renderLibrary();
      renderRail();
      updatePlayer();
    } catch (error) {
      const detail = error.name === 'QuotaExceededError' ? '端末の保存容量が不足しています' : error.message;
      failures.push(file.name + '（' + detail + '）');
    }
  }
  if (saved) await persistOrder();
  message($('import-state'), [saved ? saved + '件を端末に保存しました。' : '', ...failures].filter(Boolean).join(' '));
  importBusy = false;
  $('add-videos').disabled = false;
};

function syncFrame() {
  const duration = Number.isFinite(preview.duration) ? preview.duration : (edited()?.duration || 0);
  const position = pendingEditorPosition ?? preview.currentTime;
  $('frame-seek').max = duration || 1;
  $('frame-seek').value = position;
  $('frame-time').textContent = time(position, true);
  $('frame-duration').textContent = time(duration);
  $('clip-map-position').style.left = (duration > 0 ? clamp(position / duration * 100, 0, 100) : 0) + '%';
  updatePreviewBoundary();
  const unavailable = preview.readyState < 2 || preview.seeking || pendingEditorPosition !== null || auditioning;
  $('capture').disabled = unavailable;
  $('clip-thumbnail').disabled = unavailable;
}

function editVideo(video) {
  closeEditor();
  editorId = video.id;
  pendingEditorPosition = video.frame || null;
  $('edit-title').textContent = video.name;
  $('caption').value = video.caption;
  $('caption-align').value = video.captionAlign || 'left';
  $('volume').value = video.volume;
  $('volume-value').value = video.volume + '%';
  previewFrameRate = video.previewFps ?? 30;
  $('video-editor').hidden = false;
  renderClips();
  preview.src = urlFor(video.file);
  syncFrame();
  renderLibrary();
  $('video-editor').scrollIntoView({ block: 'nearest' });
}

function closeEditor() {
  const previous = edited();
  editorGeneration += 1;
  closeClipEditor();
  stopAudition();
  preview.removeAttribute('src');
  preview.load();
  if (previous && previous.id !== currentId) releaseUrl(previous.file);
  editorId = undefined;
  pendingEditorPosition = null;
  $('video-editor').hidden = true;
  message($('edit-state'), '');
}

$('close-editor').onclick = () => {
  closeEditor();
  renderLibrary();
};

function seekPreview(value) {
  stopAudition();
  if (Number.isFinite(preview.duration)) {
    pendingEditorPosition = null;
    preview.currentTime = clamp(value, 0, preview.duration);
  } else {
    pendingEditorPosition = value;
  }
  syncFrame();
}
preview.addEventListener('loadedmetadata', () => {
  if (pendingEditorPosition !== null) seekPreview(pendingEditorPosition);
  syncFrame();
});
for (const event of ['loadeddata', 'seeking', 'seeked', 'timeupdate']) preview.addEventListener(event, syncFrame);
preview.addEventListener('ended', stopAudition);
preview.addEventListener('playing', syncFrame);

$('frame-seek').oninput = event => seekPreview(Number(event.target.value));
function stepPreview(direction) {
  const fps = previewFrameRate;
  const position = pendingEditorPosition ?? preview.currentTime;
  const frame = Math.floor(position * fps + 0.01);
  seekPreview((frame + direction) / fps);
}

$('frame-prev').onclick = () => stepPreview(-1);
$('frame-next').onclick = () => stepPreview(1);
$('preview-back').onclick = () => seekPreview((pendingEditorPosition ?? preview.currentTime) - 5);
$('preview-forward').onclick = () => seekPreview((pendingEditorPosition ?? preview.currentTime) + 5);
$('capture').onclick = async () => {
  const video = edited();
  if (!video) return;
  const timecode = preview.currentTime;
  const generation = editorGeneration;
  try {
    const thumbnail = await snapshot(preview);
    if (generation !== editorGeneration) return;
    await updateVideo(video.id, { thumbnail, frame: timecode });
    releaseUrl(video.thumbnail);
    Object.assign(video, { thumbnail, frame: timecode });
    renderLibrary();
    renderRail();
    if (generation === editorGeneration) message($('edit-state'), time(timecode, true) + ' のフレームを保存しました。');
  } catch (error) {
    if (generation === editorGeneration) message($('edit-state'), error.message);
  }
};

function clipRangeLabel(clip) {
  return formatTimecode(clip.start) + '–' + formatTimecode(clip.end);
}

function readDraftRange() {
  const duration = edited()?.duration ?? 0;
  const start = parseTimecode($('clip-start').value);
  const inputEnd = parseTimecode($('clip-end').value);
  const end = Math.min(inputEnd, duration);
  if (!Number.isFinite(start) || !Number.isFinite(inputEnd) || start >= end || inputEnd > duration + 0.00051) return null;
  return { start, end };
}

function renderClipMap() {
  const video = edited();
  const ranges = $('clip-map-ranges');
  ranges.replaceChildren();
  if (!video || !(video.duration > 0)) return;

  function place(node, range, index) {
    node.style.left = range.start / video.duration * 100 + '%';
    node.style.width = (range.end - range.start) / video.duration * 100 + '%';
    node.style.setProperty('--clip-hue', (158 + index * 73) % 360);
    ranges.append(node);
  }

  (video.clips || []).forEach((clip, index) => {
    const label = (clip.caption ? clip.caption + ' · ' : '') + clipRangeLabel(clip);
    place(button(label, () => seekPreview(clip.start), 'clip-map-range', ''), clip, index);
  });
  const draft = clipDraft && readDraftRange();
  if (draft) place(element('span', 'clip-map-range clip-map-draft'), draft, 0);
}

$('clip-map').onclick = event => {
  if (event.target.closest('button') || !edited()) return;
  const bounds = $('clip-map').getBoundingClientRect();
  seekPreview(clamp((event.clientX - bounds.left) / bounds.width, 0, 1) * edited().duration);
};

function renderClips() {
  const video = edited();
  if (!video) return;
  const clips = video.clips || [];
  $('show-full-video').checked = video.showFull !== false;
  $('clip-sequence-settings').hidden = !clips.length;
  $('clip-mode').value = video.clipMode ?? 'separate';
  $('sequence-caption-row').hidden = $('clip-mode').value === 'separate';
  $('sequence-caption').value = video.sequenceCaption ?? '';
  const list = $('clips-list');
  list.replaceChildren();
  clips.forEach((clip, index) => {
    const range = clipRangeLabel(clip);
    const title = clip.caption ? clip.caption + ' · ' + range : range;
    const row = element('div', 'list-row');
    const edit = button(title + 'を編集', () => openClipEditor(clip), 'list-main', '');
    edit.append(element('span', '', title));
    const up = button(title + 'を前へ移動', () => moveClip(video, index, -1), 'secondary', '↑');
    const down = button(title + 'を後ろへ移動', () => moveClip(video, index, 1), 'secondary', '↓');
    up.disabled = index === 0;
    down.disabled = index === clips.length - 1;
    row.append(edit, up, down, button('削除', () => deleteClip(video, clip)));
    list.append(row);
  });
  renderClipMap();
}

async function moveClip(video, index, offset) {
  if (clipSavePending) return;
  const clips = [...video.clips];
  const next = index + offset;
  if (!clips[next]) return;
  [clips[index], clips[next]] = [clips[next], clips[index]];
  clipSavePending = true;
  try {
    await updateVideo(video.id, { clips });
    video.clips = clips;
    if (current() === video && sequenceActive) clearPlayback();
    renderClips();
    renderRail();
    updatePlayer();
  } catch {
    saveError();
  } finally {
    clipSavePending = false;
  }
}

$('clip-mode').onchange = event => {
  const video = edited();
  const clipMode = event.target.value;
  if (!video) return;
  updateEdited({ clipMode });
  if (current() === video && currentClipId && ((sequenceActive && clipMode === 'separate') || (!sequenceActive && clipMode === 'combined'))) {
    clearPlayback();
  }
  renderClips();
  renderRail();
  updatePlayer();
};
$('sequence-caption').onchange = event => {
  updateEdited({ sequenceCaption: event.target.value.trim() });
  renderRail();
};

function closeClipEditor() {
  clipDraft = undefined;
  $('clip-editor').hidden = true;
  message($('clip-status'), '');
  renderClipMap();
}

function openClipEditor(clip) {
  const video = edited();
  if (!video) return;
  clipDraft = { ...clip };
  $('clip-start').value = formatTimecode(clip?.start ?? 0);
  $('clip-end').value = formatTimecode(clip?.end ?? Math.min(video.duration, 60));
  $('clip-caption').value = clip?.caption ?? '';
  $('clip-editor').hidden = false;
  $('save-clip').disabled = clipSavePending;
  message($('clip-status'), '');
  renderClipMap();
  if (clip) seekPreview(clip.start);
  $('clip-editor').scrollIntoView({ block: 'nearest' });
}

$('add-clip').onclick = () => openClipEditor();
$('cancel-clip').onclick = closeClipEditor;
for (const field of ['clip-start', 'clip-end']) {
  $(field).oninput = renderClipMap;
  $(field + '-now').onclick = () => {
    $(field).value = formatTimecode(pendingEditorPosition ?? preview.currentTime);
    renderClipMap();
  };
}
$('preview-clip').onclick = () => {
  const range = readDraftRange();
  if (range) playPreview(range);
  else message($('clip-status'), '開始と終了を指定してから試聴してください。');
};

$('clip-thumbnail').onclick = async () => {
  const draft = clipDraft;
  if (!draft) return;
  try {
    const thumbnail = await snapshot(preview);
    if (clipDraft !== draft) return;
    draft.thumbnail = thumbnail;
    draft.customThumbnail = true;
    message($('clip-status'), 'この画像は区間を保存すると適用されます。');
  } catch (error) {
    if (clipDraft === draft) message($('clip-status'), error.message);
  }
};

$('clip-thumbnail-auto').onclick = () => {
  if (!clipDraft) return;
  clipDraft.thumbnail = undefined;
  clipDraft.customThumbnail = false;
  message($('clip-status'), '区間を保存すると、開始時刻の画像を使用します。');
};

$('show-full-video').onchange = async event => {
  const video = edited();
  if (!video) return;
  const showFull = event.target.checked;
  event.target.disabled = true;
  try {
    await updateVideo(video.id, { showFull });
    video.showFull = showFull;
    if (!showFull && activeTileId() === video.id) clearPlayback();
    renderRail();
    updatePlayer();
  } catch {
    if (video === edited()) event.target.checked = video.showFull !== false;
    saveError();
  } finally {
    event.target.disabled = false;
  }
};

$('save-clip').onclick = async () => {
  const video = edited();
  const draft = clipDraft;
  if (!video || !draft || clipSavePending) return;
  const range = readDraftRange();
  if (!range) {
    message($('clip-status'), '開始と終了を動画の長さ（' + formatTimecode(video.duration) + '）の範囲内で入力してください。終了は開始より後に設定します。');
    return;
  }
  const { start, end } = range;
  const caption = $('clip-caption').value.trim();
  clipSavePending = true;
  $('save-clip').disabled = true;
  message($('clip-status'), '区間を保存しています。');
  try {
    let thumbnail = draft.thumbnail;
    if (!draft.customThumbnail && (!thumbnail || draft.start !== start)) {
      const frame = await inspectVideo(video.file, start).catch(() => null);
      thumbnail = frame?.thumbnail || undefined;
    }
    if (clipDraft !== draft || !videos.includes(video)) return;
    const clip = { id: draft.id ?? crypto.randomUUID(), start, end, caption, thumbnail, customThumbnail: Boolean(draft.customThumbnail) };
    const existing = video.clips || [];
    const prior = existing.find(item => item.id === draft.id);
    const clips = prior ? existing.map(item => item.id === clip.id ? clip : item) : [...existing, clip];
    await updateVideo(video.id, { clips });
    video.clips = clips;
    if (prior?.thumbnail !== thumbnail) releaseUrl(prior?.thumbnail);
    if (current() === video && sequenceActive) discardPreload();
    if (currentClipId === clip.id && (player.currentTime < start || player.currentTime >= end)) {
      startAt(start, false);
    }
    renderRail();
    updatePlayer();
    if (clipDraft === draft) {
      closeClipEditor();
      renderClips();
      message($('edit-state'), '再生区間を保存しました。');
    }
  } catch {
    if (clipDraft === draft) message($('clip-status'), '区間を保存できませんでした。');
  } finally {
    clipSavePending = false;
    $('save-clip').disabled = false;
  }
};

async function deleteClip(video, clip) {
  if (clipSavePending || !confirm('この再生区間を削除しますか？')) return;
  clipSavePending = true;
  $('save-clip').disabled = true;
  try {
    const clips = video.clips.filter(item => item.id !== clip.id);
    await updateVideo(video.id, { clips });
    video.clips = clips;
    if (current() === video && (currentClipId === clip.id || sequenceActive)) clearPlayback();
    if (clipDraft?.id === clip.id) closeClipEditor();
    releaseUrl(clip.thumbnail);
    forgetTiles(clips.length ? [clip.id] : [clip.id, sequenceId(video)]);
    renderRail();
    renderClips();
    updatePlayer();
  } catch {
    message($('edit-state'), '区間を削除できませんでした。');
  } finally {
    clipSavePending = false;
    $('save-clip').disabled = false;
  }
}

function updateEdited(changes) {
  const video = edited();
  if (!video) return;
  Object.assign(video, changes);
  updateVideo(video.id, changes).catch(saveError);
}

$('caption').onchange = event => {
  updateEdited({ caption: event.target.value.trim() });
  renderRail();
  renderLibrary();
};

$('caption-align').onchange = event => {
  updateEdited({ captionAlign: event.target.value });
  renderRail();
};

$('volume').oninput = event => {
  const volume = Number(event.target.value);
  $('volume-value').value = volume + '%';
  applyVolume(preview, volume);
  if (editorId === currentId) applyVolume(player, volume);
  if (edited()) edited().volume = volume;
};
$('volume').onchange = event => updateEdited({ volume: Number(event.target.value) });

function updatePreviewBoundary() {
  clearTimeout(previewEndTimer);
  if (!auditioning || previewStopAt === null || preview.paused || preview.seeking) return;
  const remaining = previewStopAt - preview.currentTime;
  if (remaining <= 0) {
    const end = previewStopAt;
    stopAudition();
    if (preview.currentTime > end) preview.currentTime = end;
  } else if (remaining <= 1) {
    previewEndTimer = setTimeout(syncFrame, Math.max(20, remaining * 1000));
  }
}

function setPreviewPlaying(playing) {
  const control = $('audition');
  control.textContent = playing ? 'Ⅱ' : '▶︎';
  control.setAttribute('aria-label', playing ? 'プレビューを一時停止' : 'プレビューを再生');
}

function sampleFrameRate(token) {
  if (!preview.requestVideoFrameCallback) return;
  const rates = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120];
  let first;
  let samples = 0;
  function measure(_now, frame) {
    if (token !== previewIntent || preview.paused) return;
    first ||= frame;
    samples += 1;
    const elapsed = frame.mediaTime - first.mediaTime;
    if (elapsed >= 0.25 && frame.presentedFrames > first.presentedFrames) {
      const estimate = (frame.presentedFrames - first.presentedFrames) / elapsed;
      const nearest = rates.reduce((best, rate) => Math.abs(rate - estimate) < Math.abs(best - estimate) ? rate : best);
      if (estimate >= 10 && estimate <= 150) previewFrameRate = Math.abs(nearest - estimate) < 1 ? nearest : estimate;
    }
    if (samples < 30) preview.requestVideoFrameCallback(measure);
  }
  preview.requestVideoFrameCallback(measure);
}

function stopAudition() {
  previewIntent += 1;
  previewStopAt = null;
  clearTimeout(previewEndTimer);
  if (!auditioning) return;
  auditioning = false;
  preview.pause();
  setPreviewPlaying(false);
  syncFrame();
}

async function playPreview(range) {
  const video = edited();
  if (!video) return;
  stopAudition();
  stopActive();
  const token = ++previewIntent;
  auditioning = true;
  previewStopAt = range?.end ?? null;
  setPreviewPlaying(true);
  syncFrame();
  try {
    const position = range?.start ?? (preview.ended ? 0 : preview.currentTime);
    if (preview.readyState < 1 || preview.seeking || Math.abs(preview.currentTime - position) >= 0.002) {
      if (!await positionMedia(preview, position, () => token === previewIntent)) return;
    }
    applyVolume(preview, video.volume);
    await preview.play();
    if (token === previewIntent) {
      sampleFrameRate(token);
      syncFrame();
    }
  } catch (error) {
    if (token !== previewIntent) return;
    stopAudition();
    if (error.name !== 'AbortError') {
      const target = range ? $('clip-status') : $('edit-state');
      message(target, 'もう一度再生ボタンを押してください。');
    }
  }
}

$('audition').onclick = () => auditioning ? stopAudition() : playPreview();

function renderProjection() {
  const active = output !== inlinePlayer;
  const config = screenLayout(active);
  applyLayout($('screen'), active);
  renderRailSpacing(railTrack, config);
  $('transport').hidden = $('main-seek').hidden = !config.controlsVisible;
  $('settings').hidden = !config.gearVisible;
  $('playback-bar').hidden = !config.controlsVisible && !config.gearVisible;
  $('projection-toggle').hidden = isIPhone;
  $('projection-toggle').textContent = projectionWindow ? '上映画面を閉じる' : '上映画面を開く';
  $('open-pc-layout').hidden = isIPhone;
  $('projection-guide-ipad').hidden = !isIPad;
  $('projection-guide-phone').hidden = !isIPhone;
  const desktopGuide = $('projection-guide-desktop');
  desktopGuide.hidden = isIPad || isIPhone;
  desktopGuide.textContent = isWindows
    ? 'Windowsで画面を「拡張」にします。自動配置する場合は、ブラウザから画面の管理を求められたら許可してください。手動の場合は、上映ウィンドウを外部画面へ移して「全画面」を押します。'
    : 'システムのディスプレイ設定で画面を拡張し、上映ウィンドウを外部画面へ移して「全画面」を押します。';
  const displayButton = $('projection-display');
  displayButton.hidden = !isIPad && !canPlaceProjection();
  displayButton.disabled = projectionDisplayBusy;
  displayButton.textContent = externalProjection
    ? '上映画面をこの画面に戻す'
    : '上映画面を別のディスプレイに全画面表示する';
}

function switchPlaybackTarget(video, position) {
  if (output === video) return;
  stopAudition();
  stopActive();
  wirePlayback(player, false);
  discardPreload();
  if (standby && standby !== output) standby.remove();
  if (player !== output) player.remove();
  standby = undefined;
  delete output.dataset.inactiveStream;
  output.removeAttribute('src');
  output.load();
  output = player = video;
  wirePlayback(player, true);
  const selected = current();
  if (selected) {
    player.src = urlFor(selected.file);
    player.load();
    startAt(position, false);
    applyVolume(player, selected.volume);
  }
  rail.scrollLeft = 0;
  rail.scrollTop = 0;
  renderProjection();
  updatePlayer();
}

function stopProjection(status = '') {
  const popup = projectionWindow;
  projectionWindow = undefined;
  externalProjection = pendingExternalProjection = undefined;
  resolveProjectionConnection?.(false);
  resolveProjectionConnection = undefined;
  projectionConnection = undefined;
  clearInterval(projectionTimer);
  if (output !== inlinePlayer) switchPlaybackTarget(inlinePlayer, playbackPosition);
  if (popup && !popup.closed) popup.close();
  renderProjection();
  message($('projection-status'), status);
}

function openProjection(keepSettings = false) {
  if (projectionWindow) return projectionConnection;
  if (isIPad && (navigator.standalone || window.matchMedia('(display-mode: standalone)').matches)) {
    message($('projection-status'), 'iPadの2画面上映はSafariでアプリのURLを開き、操作画面と上映画面を別々のSafariウインドウにしてください。');
    return Promise.resolve(false);
  }
  if (location.protocol === 'file:') {
    message($('projection-status'), '2画面上映には、GitHub PagesなどのHTTPS版をブラウザで開いてください。');
    return Promise.resolve(false);
  }
  const popup = isIPad
    ? window.open('./projection.html', '_blank')
    : window.open('./projection.html', '_blank', 'popup,width=960,height=540');
  if (!popup) {
    message($('projection-status'), 'ブラウザのポップアップを許可してから、もう一度開いてください。');
    return Promise.resolve(false);
  }
  projectionWindow = popup;
  projectionKeepSettings = keepSettings;
  projectionConnection = new Promise(resolve => { resolveProjectionConnection = resolve; });
  projectionDeadline = performance.now() + 12000;
  projectionTimer = setInterval(() => {
    if (popup.closed) stopProjection();
    else if (output === inlinePlayer && performance.now() > projectionDeadline) {
      stopProjection(isIPad
        ? '上映画面と接続できませんでした。Safariで操作画面を開き、アプリの「上映画面を開く」から開き直してください。'
        : '上映画面を読み込めませんでした。オンラインでアプリを開き直してください。');
    }
  }, 400);
  renderProjection();
  message($('projection-status'), '上映画面を開いています。');
  return projectionConnection;
}

$('projection-toggle').onclick = () => {
  if (projectionWindow) stopProjection();
  else openProjection();
};

window.addEventListener('message', event => {
  if (event.origin !== location.origin || !projectionWindow || event.source !== projectionWindow) return;
  if (event.data === 'exhibit-projection-ready') {
    const media = projectionWindow.document.getElementById('projection-video');
    if (!media) return;
    switchPlaybackTarget(media, player.currentTime || 0);
    if (!projectionKeepSettings) settings.close();
    if (!projectionKeepSettings) message($('projection-status'), '上映画面に接続しています。');
    resolveProjectionConnection?.(true);
    resolveProjectionConnection = undefined;
  } else if (event.data === 'exhibit-projection-external-fullscreen' && pendingExternalProjection) {
    externalProjection = pendingExternalProjection;
    pendingExternalProjection = undefined;
    renderProjection();
    message($('projection-status'), '別のディスプレイで全画面表示しています。');
  } else if (event.data === 'exhibit-projection-closing') {
    stopProjection();
  }
});

function placeProjectionWindow(popup, display, width, height) {
  const w = Math.min(width, display.availWidth);
  const h = Math.min(height, display.availHeight);
  const left = display.availLeft + Math.round((display.availWidth - w) / 2);
  const top = display.availTop + Math.round((display.availHeight - h) / 2);
  popup.moveTo(left, top);
  popup.resizeTo(w, h);
  popup.moveTo(left, top);
}

$('projection-display').onclick = async () => {
  if (projectionDisplayBusy) return;
  if (isIPad && !canPlaceProjection()) {
    if (await openProjection(true)) {
      projectionWindow?.focus();
      message($('projection-status'), '上映画面を開きました。Safariの別ウインドウに分け、iPadOSの「ディスプレイに移動」を選んでください。移動先でウインドウを全画面にします。');
    }
    return;
  }
  if (!canPlaceProjection()) {
    message($('projection-status'), 'この環境では、上映ウインドウを手動で外部画面へ移動してください。');
    return;
  }
  projectionDisplayBusy = true;
  renderProjection();
  try {
    if (externalProjection) {
      const popup = projectionWindow;
      const { home, width, height } = externalProjection;
      if (popup.document.fullscreenElement) await popup.document.exitFullscreen();
      if (popup !== projectionWindow) return;
      placeProjectionWindow(popup, home, width, height);
      externalProjection = undefined;
      message($('projection-status'), '上映画面を操作画面と同じディスプレイに戻しました。');
      return;
    }

    // Open while the tap is still active. Permissions and the separate page may take longer.
    const connection = openProjection(true);
    const popup = projectionWindow;
    if (!popup) return;
    const details = await window.getScreenDetails();
    const home = details.currentScreen;
    const external = details.screens.filter(screen => screen !== home &&
      (screen.left !== home.left || screen.top !== home.top));
    const destination = external.find(screen => !screen.isInternal) ?? external[0];
    if (!destination) {
      message($('projection-status'), '別のディスプレイが見つかりません。システムのディスプレイ設定で画面を拡張してください。');
      return;
    }
    if (!await connection || popup !== projectionWindow) return;
    if (popup.document.fullscreenElement) await popup.document.exitFullscreen();
    if (popup !== projectionWindow) return;
    pendingExternalProjection = undefined;
    popup.exhibitFullscreenDestination = undefined;
    const originalSize = { home, width: popup.outerWidth || 960, height: popup.outerHeight || 540 };
    placeProjectionWindow(popup, destination, destination.availWidth, destination.availHeight);
    externalProjection = originalSize;
    try {
      await popup.document.body.requestFullscreen({ screen: destination, navigationUI: 'hide' });
      if (popup === projectionWindow) message($('projection-status'), '別のディスプレイで全画面表示しています。');
    } catch {
      if (popup === projectionWindow) {
        placeProjectionWindow(popup, home, originalSize.width, originalSize.height);
        externalProjection = undefined;
        pendingExternalProjection = originalSize;
        popup.exhibitFullscreenDestination = destination;
        popup.document.getElementById('fullscreen').textContent = 'テレビに全画面表示';
        popup.focus();
        message($('projection-status'), 'ブラウザが全画面操作を求めています。タブレット側の上映ウィンドウで「テレビに全画面表示」を押してください。');
      }
    }
  } catch (error) {
    if (!externalProjection) {
      message($('projection-status'), error.name === 'NotAllowedError'
        ? 'ブラウザのサイト設定で「ウィンドウ管理」を許可してから、もう一度押してください。'
        : '上映画面を移動できませんでした。ディスプレイの接続をご確認ください。');
    } else {
      message($('projection-status'), '上映画面を移動できませんでした。もう一度お試しください。');
    }
  } finally {
    projectionDisplayBusy = false;
    renderProjection();
  }
};

window.addEventListener('pagehide', () => {
  projectionWindow?.close();
});

function applyLayout(node, projected) {
  const config = screenLayout(projected);
  const grid = projected && config.arrangement === 'grid';
  const { columns, rows } = gridDimensions(railTrack.children.length, config.columns);
  node.classList.toggle('projection-active', projected);
  node.classList.toggle('projection-grid', grid);
  node.classList.toggle('controls-hidden', !config.controlsVisible);
  node.dataset.controlsPosition = config.controlsPosition;
  const properties = {
    '--top': layout.top + '%',
    '--video-width': layout.width + '%',
    '--video-size': layout.height / 100,
    '--video-x': clamp(layout.x, layout.width / 2, 100 - layout.width / 2) + '%',
    '--rail': config.rail + '%',
    '--thumb': config.thumb + 'px',
    '--grid-columns': columns,
    '--grid-rows': rows,
    '--grid-gap': (config.gridGap ?? pcDefaults.gridGap) + 'px',
  };
  for (const [property, value] of Object.entries(properties)) node.style.setProperty(property, value);
}

function renderLayout() {
  renderProjection();
  if (activeTab === 'layout') renderMock('layout');
  if (activeTab === 'objects') renderMock('objects');
}

function rangeField(label, min, max, unit, value, onInput, onChange) {
  const field = element('label');
  const line = element('span', '', label);
  const output = element('output', '', value + unit);
  line.append(output);
  const input = element('input');
  Object.assign(input, { type: 'range', min, max, value });
  input.setAttribute('aria-label', label);
  input.oninput = () => {
    output.value = input.value + unit;
    onInput(Number(input.value));
  };
  input.onchange = onChange;
  field.append(line, input);
  return field;
}

function renderLayoutSettings() {
  const pc = layoutTarget === 'pc';
  const config = editingLayout();
  const grid = pc && config.arrangement === 'grid';
  $('layout-target').value = layoutTarget;
  $('pc-thumbnail-settings').hidden = !pc;
  $('projection-layout').value = layout.projection.arrangement;
  $('projection-columns').value = layout.projection.columns;
  $('projection-columns-row').hidden = !grid;
  $('rail-settings').hidden = grid;
  $('controls-visible').checked = config.controlsVisible;
  $('controls-position').value = config.controlsPosition;
  $('pc-gear-row').hidden = !pc;
  $('pc-gear-visible').checked = layout.projection.gearVisible;

  const specs = pc ? (grid ? pcGridSpecs : pcRailSpecs) : layoutSpecs;
  const fields = specs.map(([key, label, min, max, unit]) => rangeField(label, min, max, unit, config[key], value => {
    config[key] = value;
    renderLayout();
  }, () => storePreference('layout', layout)));
  $('layout-fields').replaceChildren(...fields);
  renderRailSettings();
}

function renderRailSettings() {
  const config = editingLayout();
  const custom = config.railMode === 'custom';
  $('rail-mode').value = config.railMode;
  $('rail-custom').hidden = !custom;
  if (!custom) return;

  const gaps = $('rail-gaps');
  gaps.replaceChildren();
  const entries = tiles();
  $('rail-gap-help').textContent = entries.length < 2
    ? '動画を2本以上登録すると、間隔を調整できます。'
    : '各サムネイルと、その一つ前のサムネイルとの間隔を指定します。';
  entries.slice(1).forEach(({ id, title }, index) => {
    const field = element('label', 'rail-gap');
    const name = element('span', '', (index + 2) + '番目の前 · ' + title);
    name.title = name.textContent;
    const value = element('span', 'rail-gap-value');
    const input = element('input');
    Object.assign(input, {
      type: 'number', inputMode: 'numeric', min: 0, max: maxGap, step: 1,
      value: config.gaps[id] ?? defaultGap,
    });
    input.setAttribute('aria-label', name.textContent + ' の間隔（px）');
    input.oninput = () => {
      if (!Number.isFinite(input.valueAsNumber)) return;
      config.gaps[id] = clamp(Math.round(input.valueAsNumber), 0, maxGap);
      renderLayout();
    };
    input.onchange = () => {
      input.value = config.gaps[id] ?? defaultGap;
      storePreference('layout', layout);
    };
    value.append(input, element('span', '', 'px'));
    field.append(name, value);
    gaps.append(field);
  });
}

function saveLayoutChange() {
  renderLayout();
  storePreference('layout', layout);
}

$('layout-target').onchange = event => {
  layoutTarget = event.target.value;
  renderLayoutSettings();
  renderMock('layout');
};

$('projection-layout').onchange = event => {
  layout.projection.arrangement = event.target.value;
  rail.scrollTop = rail.scrollLeft = 0;
  renderLayoutSettings();
  saveLayoutChange();
};

$('projection-columns').onchange = event => {
  layout.projection.columns = Number(event.target.value);
  rail.scrollTop = 0;
  saveLayoutChange();
};

$('controls-visible').onchange = event => {
  editingLayout().controlsVisible = event.target.checked;
  saveLayoutChange();
};

$('controls-position').onchange = event => {
  editingLayout().controlsPosition = event.target.value;
  saveLayoutChange();
};

$('pc-gear-visible').onchange = event => {
  layout.projection.gearVisible = event.target.checked;
  saveLayoutChange();
};

$('rail-mode').onchange = event => {
  editingLayout().railMode = event.target.value;
  renderRailSettings();
  saveLayoutChange();
};

$('reset-layout').onclick = () => {
  if (layoutTarget === 'pc') layout.projection = { ...pcDefaults, gaps: {} };
  else layout = { ...defaults, gaps: {}, projection: layout.projection };
  renderLayoutSettings();
  saveLayoutChange();
};

function placeObject(node, object) {
  node.style.left = object.x + '%';
  node.style.top = object.y + '%';
  node.style.color = object.color;
  node.style.setProperty('--object-size', object.size + (object.type === 'text' ? 'cqw' : '%'));
  if (object.type === 'text' && object.width !== undefined) {
    node.style.width = object.width + '%';
    node.style.maxWidth = '100%';
  }
}

function objectNode(object) {
  const isImage = object.type === 'image';
  const node = element(isImage ? 'img' : 'div', 'decoration ' + object.type, object.type === 'text' ? object.text : undefined);
  if (isImage) {
    node.src = urlFor(object.file);
    node.alt = '';
    node.draggable = false;
  }
  placeObject(node, object);
  return node;
}

function renderDecorations() {
  $('decorations').replaceChildren(...decorations.filter(object => object.visible).map(objectNode));
}

function renderMock(tab) {
  const isLayout = tab === 'layout';
  const projected = isLayout ? layoutTarget === 'pc' : output !== inlinePlayer;
  const config = screenLayout(projected);
  const mock = $(isLayout ? 'layout-preview' : 'object-preview');
  const frame = element('div', 'frame', '動画枠');
  const previous = mock.querySelector('.mock-rail');
  const scroll = { left: previous?.scrollLeft || 0, top: previous?.scrollTop || 0 };
  const strip = element('div', 'mock-rail');
  const track = element('div', 'rail-track');
  strip.append(track);
  for (const entry of tiles()) {
    const tile = element('div', 'tile mock-tile');
    tile.dataset.id = entry.id;
    const thumb = entry.thumbnail ? element('img', 'thumb') : element('span', 'thumb', '▷');
    if (entry.thumbnail) {
      thumb.src = urlFor(entry.thumbnail);
      thumb.alt = '';
    }
    const caption = element('span', 'caption', entry.title);
    if (entry.align) caption.style.textAlign = entry.align;
    tile.append(thumb, caption);
    track.append(tile);
  }
  renderRailSpacing(track, config);
  const controls = element('div', 'controls mock-controls');
  if (config.controlsVisible) {
    controls.append(element('span', '', '↶　▶　↷'), element('span', 'mock-seek'));
  }
  if (config.gearVisible) controls.append(element('span', 'gear', '⚙'));
  const overlay = element('div', 'decorations');
  for (const object of decorations.filter(object => object.visible)) {
    const node = objectNode(object);
    if (!isLayout) attachDrag(node, object, mock);
    overlay.append(node);
  }
  const { clientWidth, clientHeight } = $('screen');
  mock.style.setProperty('--mock-ratio', clientWidth + ' / ' + clientHeight);
  applyLayout(mock, projected);
  mock.replaceChildren(frame, strip, controls, overlay);
  const scale = mock.clientWidth / Math.max(1, clientWidth);
  const inset = parseFloat(getComputedStyle(rail).paddingLeft) || 0;
  mock.style.setProperty('--mock-inset', inset * scale + 'px');
  mock.style.setProperty('--grid-gap', (config.gridGap ?? pcDefaults.gridGap) * scale + 'px');
  track.style.setProperty('--rail-scale', scale);
  strip.scrollTo(scroll.left, scroll.top);
}

function attachDrag(node, object, mock) {
  node.classList.toggle('selected', object.id === objectId);
  node.onpointerdown = event => {
    if (event.button !== 0) return;
    event.preventDefault();
    objectId = object.id;
    for (const item of mock.querySelectorAll('.decoration')) item.classList.toggle('selected', item === node);
    renderObjectList();
    renderObjectFields();
    const bounds = mock.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY, objectX: object.x, objectY: object.y };
    node.setPointerCapture(event.pointerId);
    node.onpointermove = move => {
      object.x = clamp(Math.round(start.objectX + (move.clientX - start.x) * 100 / bounds.width), 0, 100);
      object.y = clamp(Math.round(start.objectY + (move.clientY - start.y) * 100 / bounds.height), 0, 100);
      placeObject(node, object);
      renderDecorations();
    };
    node.onlostpointercapture = () => {
      node.onpointermove = null;
      storePreference('decorations', decorations);
      renderObjectFields();
    };
  };
}

function renderObjectList() {
  const list = $('object-list');
  list.replaceChildren();
  if (!decorations.length) list.append(element('p', 'message', '表示要素はありません'));
  decorations.forEach((object, index) => {
    const row = element('div', 'list-row');
    row.classList.toggle('active', object.id === objectId);
    const title = object.type === 'image' ? object.file.name : (object.text || typeLabels[object.type]);
    const select = button(title, () => {
      objectId = object.id;
      renderObjects();
    }, 'list-main', '');
    select.append(element('span', '', title));
    const visibility = button(object.visible ? '非表示にする' : '表示する', () => {
      object.visible = !object.visible;
      persistObjects();
    }, 'secondary', object.visible ? '表示中' : '非表示');
    const backward = button('背面へ移動', () => reorderObject(index, -1), 'secondary', '↓');
    const forward = button('前面へ移動', () => reorderObject(index, 1), 'secondary', '↑');
    backward.disabled = index === 0;
    forward.disabled = index === decorations.length - 1;
    row.append(select, visibility, backward, forward, button('削除', () => {
      if (!confirm('この表示要素を削除しますか？')) return;
      decorations = decorations.filter(item => item !== object);
      if (object.id === objectId) objectId = undefined;
      releaseUrl(object.file);
      persistObjects();
    }));
    list.append(row);
  });
}

function reorderObject(index, offset) {
  const next = index + offset;
  if (!decorations[next]) return;
  [decorations[index], decorations[next]] = [decorations[next], decorations[index]];
  persistObjects();
}

function objectNumberField(label, min, max, unit, value, onInput, onChange) {
  const field = element('div', 'fields');
  field.append(element('span', '', label));
  const slider = element('input');
  Object.assign(slider, { type: 'range', min, max, step: 1, value });
  slider.setAttribute('aria-label', label + 'のスライダー');
  const number = element('input');
  Object.assign(number, { type: 'number', min, max, step: 1, value });
  number.setAttribute('aria-label', label + 'の数値');
  let currentValue = value;
  const update = proposed => {
    currentValue = clamp(Math.round(proposed), min, max);
    slider.value = number.value = currentValue;
    onInput(currentValue);
  };
  slider.oninput = () => update(Number(slider.value));
  slider.onchange = onChange;
  number.oninput = () => {
    const proposed = number.valueAsNumber;
    if (!Number.isFinite(proposed) || proposed < min || proposed > max) return;
    currentValue = Math.round(proposed);
    slider.value = currentValue;
    onInput(currentValue);
    onChange();
  };
  number.onchange = () => {
    update(Number.isFinite(number.valueAsNumber) ? number.valueAsNumber : currentValue);
    onChange();
  };
  const adjust = delta => {
    update(currentValue + delta);
    onChange();
  };
  const row = element('div', 'object-adjustment');
  row.append(button(label + 'を減らす', () => adjust(-1), 'secondary', '−'),
    number, element('span', '', unit.trim()), button(label + 'を増やす', () => adjust(1), 'secondary', '＋'));
  field.append(slider, row);
  return field;
}

function renderObjectFields() {
  const fields = $('object-fields');
  const object = selectedObject();
  fields.hidden = !object;
  fields.replaceChildren();
  if (!object) return;
  const isText = object.type === 'text';
  const save = () => {
    storePreference('decorations', decorations);
    renderObjectList();
  };
  const update = (key, value) => {
    object[key] = value;
    renderDecorations();
    renderMock('objects');
  };
  if (isText) {
    const field = element('label', '', 'テキスト');
    const input = element('input');
    Object.assign(input, { type: 'text', maxLength: 240, value: object.text });
    input.oninput = () => update('text', input.value);
    input.onchange = save;
    field.append(input);
    fields.append(field);
  }
  if (object.type !== 'image') {
    const field = element('label', '', '色');
    const input = element('input');
    Object.assign(input, { type: 'color', value: object.color });
    input.oninput = () => update('color', input.value);
    input.onchange = save;
    field.append(input);
    fields.append(field);
  }
  const specs = [...objectSpecs, ['size', 'サイズ', 1, isText ? 20 : 100, '%']];
  if (isText) specs.push(['width', 'テキストボックスの幅', 5, 100, '%']);
  for (const [key, label, min, max, unit] of specs) {
    fields.append(objectNumberField(label, min, max, unit, object[key] ?? 85, value => update(key, value), save));
  }
}

function renderObjects() {
  renderDecorations();
  renderMock('objects');
  renderObjectList();
  renderObjectFields();
}

function persistObjects() {
  renderObjects();
  storePreference('decorations', decorations);
}

function addObject(type, file) {
  const object = {
    id: crypto.randomUUID(), type, file, x: 50, y: 25, size: type === 'text' ? 4 : 17,
    text: type === 'text' ? 'テキスト' : '', color: '#ffffff', visible: true,
  };
  objectId = object.id;
  decorations.push(object);
  persistObjects();
}

$('add-object').onclick = () => {
  const type = $('object-type').value;
  if (type === 'image') $('image-picker').click();
  else addObject(type);
};
$('image-picker').onchange = async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  const image = new Image();
  const url = URL.createObjectURL(file);
  image.src = url;
  try {
    await image.decode();
    addObject('image', file);
  } catch {
    alert('この画像形式は表示できません。PNGまたはJPEGでお試しください。');
  } finally {
    URL.revokeObjectURL(url);
  }
};

async function prepareOffline() {
  if (location.protocol === 'file:') {
    $('offline-state').textContent = 'ローカルファイルとして開いています';
    return;
  }
  if (!('serviceWorker' in navigator)) {
    $('offline-state').textContent = 'この環境ではオフライン起動を利用できません';
    return;
  }
  try {
    const registration = await navigator.serviceWorker.register('./sw.js');
    const show = () => {
      $('offline-state').textContent = 'オフラインで起動できます';
    };
    if (registration.active) show();
    else {
      registration.installing?.addEventListener('statechange', event => {
        if (event.target.state === 'redundant' && !registration.active) {
          $('offline-state').textContent = 'オフラインの準備に失敗しました。オンラインで開き直してください';
        }
      });
      navigator.serviceWorker.ready.then(show);
    }
  } catch {
    $('offline-state').textContent = 'オフラインの準備に失敗しました。オンラインで開き直してください';
  }
}

async function start() {
  $('add-videos').disabled = true;
  $('add-object').disabled = true;
  try {
    const [entries, savedLayout, savedObjects, order, savedTileOrder] = await Promise.all([
      readVideos(), readPreference('layout'), readPreference('decorations'), readPreference('order'), readPreference('tileOrder'),
    ]);
    const positions = new Map((order || []).map((id, index) => [id, index]));
    videos = entries.sort((a, b) => {
      const orderDifference = (positions.get(a.id) ?? entries.length) - (positions.get(b.id) ?? entries.length);
      return orderDifference || (a.addedAt ?? 0) - (b.addedAt ?? 0);
    });
    layout = loadLayout(savedLayout);
    tileOrder = savedTileOrder || [];
    decorations = savedObjects || [];
    ready = true;
    $('add-videos').disabled = false;
    $('add-object').disabled = false;
  } catch {
    message($('import-state'), '端末の保存領域を開けませんでした。通常のブラウズ環境で開き直してください。');
    notify('端末の保存領域を開けませんでした。');
  }
  renderRail();
  renderLibrary();
  renderLayoutSettings();
  renderLayout();
  renderObjects();
  updatePlayer();
  prepareOffline();
}
window.addEventListener('resize', () => {
  if (settings.open && settingsPosition) setSettingsPosition(settingsPosition.left, settingsPosition.top);
  if (activeTab === 'layout' || activeTab === 'objects') renderMock(activeTab);
});
document.documentElement.dataset.appLoaded = 'true';
$('app-bootstrap-status').hidden = true;
start();
