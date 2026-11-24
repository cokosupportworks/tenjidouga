import { readVideos, addVideo, removeVideo, updateVideo, readPreference, writePreference } from './storage.js';

const $ = id => document.getElementById(id);
const player = $('player');
const preview = $('preview-video');
const settings = $('settings-dialog');
const rail = $('rail');
const railTrack = $('rail-track');
const defaults = { top: 4, width: 90, height: 100, x: 50, rail: 22, thumb: 150, railMode: 'even' };
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
let layout = { ...defaults, gaps: {} };
let currentId;
let editorId;
let objectId;
let activeTab = 'library';
let importBusy = false;
let noticeTimer;
let audioContext;
let mainGain;
let previewGain;
let editorGeneration = 0;
let pendingEditorPosition = null;
let auditioning = false;
let ready = false;

const current = () => videos.find(video => video.id === currentId);
const edited = () => videos.find(video => video.id === editorId);
const selectedObject = () => decorations.find(object => object.id === objectId);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

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

function setupGain(media) {
  const source = audioContext.createMediaElementSource(media);
  const gain = audioContext.createGain();
  source.connect(gain);
  gain.connect(audioContext.destination);
  return gain;
}

function enableAudio() {
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) return;
  try {
    audioContext ||= new Audio();
    mainGain ||= setupGain(player);
    previewGain ||= setupGain(preview);
    if (audioContext.state !== 'running') audioContext.resume().catch(() => {});
  } catch {
    // Where Web Audio is unavailable, use the media element's native controls.
  }
}

function applyVolume(media, gain, value) {
  const volume = clamp(value / 100, 0, 1);
  media.muted = !volume;
  media.volume = gain ? 1 : volume;
  if (gain) gain.gain.value = volume;
}

function renderRailSpacing(track) {
  track.dataset.mode = layout.railMode;
  Array.from(track.children).forEach((tile, index) => {
    const gap = index === 0 ? 0 : (layout.gaps[tile.dataset.id] ?? defaultGap);
    tile.style.setProperty('--tile-gap', gap + 'px');
  });
}

function renderRail() {
  const scroll = rail.scrollLeft;
  railTrack.replaceChildren();
  for (const video of videos) {
    const title = video.caption || video.name;
    const tile = button(title, () => selectVideo(video), 'tile', '');
    tile.title = title;
    tile.dataset.id = video.id;
    tile.setAttribute('aria-current', String(video.id === currentId));
    const thumb = video.thumbnail ? element('img', 'thumb') : element('span', 'thumb', '▷');
    if (video.thumbnail) {
      thumb.src = urlFor(video.thumbnail);
      thumb.alt = '';
    }
    tile.append(thumb, element('span', 'caption', title));
    railTrack.append(tile);
  }
  renderRailSpacing(railTrack);
  rail.scrollLeft = scroll;
  if (activeTab === 'layout') {
    renderRailSettings();
    renderMock('layout');
  }
}

function updatePlayer() {
  const hasVideo = Boolean(current());
  const duration = Number.isFinite(player.duration) ? player.duration : 0;
  const position = player.currentTime || 0;
  const isPlaying = hasVideo && !player.paused && !player.ended;
  $('empty').hidden = hasVideo;
  $('empty-title').textContent = videos.length ? '動画を選択' : '動画がありません';
  $('empty-text').textContent = videos.length ? '下のサムネイルをタップして再生' : '設定から動画を追加してください';
  $('elapsed').textContent = time(position);
  $('duration').textContent = time(duration);
  $('timeline').max = duration || 1;
  $('timeline').value = position;
  $('timeline').disabled = !duration;
  $('back').disabled = !duration;
  $('forward').disabled = !duration;
  $('toggle').disabled = !hasVideo;
  const playLabel = isPlaying ? '一時停止' : '再生';
  $('toggle').setAttribute('aria-label', playLabel);
  $('toggle').title = playLabel;
  $('toggle').firstElementChild.classList.toggle('pause', isPlaying);
  for (const tile of rail.querySelectorAll('.tile')) {
    tile.setAttribute('aria-current', String(tile.dataset.id === currentId));
  }
}

function playMain() {
  const video = current();
  if (!video) return;
  enableAudio();
  applyVolume(player, mainGain, video.volume);
  player.play().catch(error => {
    if (currentId === video.id && error.name !== 'AbortError') notify('再生できませんでした。再生ボタンでもう一度お試しください。');
  });
}

function selectVideo(video) {
  if (currentId === video.id) {
    if (player.ended) player.currentTime = 0;
    if (player.paused) playMain();
    return;
  }
  const previous = current();
  stopAudition();
  player.pause();
  currentId = video.id;
  player.src = urlFor(video.file);
  if (previous && previous.id !== editorId) releaseUrl(previous.file);
  playMain();
  updatePlayer();
}

function seekMain(position) {
  if (Number.isFinite(player.duration)) player.currentTime = clamp(position, 0, player.duration);
}

for (const event of ['play', 'pause', 'ended', 'timeupdate', 'durationchange', 'emptied']) {
  player.addEventListener(event, updatePlayer);
}
$('toggle').onclick = () => player.paused ? playMain() : player.pause();
$('back').onclick = () => seekMain(player.currentTime - 10);
$('forward').onclick = () => seekMain(player.currentTime + 10);
$('timeline').oninput = event => seekMain(Number(event.target.value));

function setTab(tab) {
  if (tab !== 'library') stopAudition();
  activeTab = tab;
  for (const node of settings.querySelectorAll('[data-tab]')) {
    const selected = node.dataset.tab === tab;
    node.setAttribute('aria-pressed', String(selected));
    $(node.dataset.tab).hidden = !selected;
  }
  if (tab === 'layout') renderRailSettings();
  if (tab === 'layout' || tab === 'objects') renderMock(tab);
}

$('settings').onclick = () => {
  if (!settings.open) settings.showModal();
  setTab(activeTab);
};
$('close-settings').onclick = () => settings.close();
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

async function deleteVideo(video) {
  if (!confirm('「' + (video.caption || video.name) + '」の登録を解除しますか？')) return;
  try {
    await removeVideo(video.id);
    if (editorId === video.id) closeEditor();
    if (currentId === video.id) {
      player.pause();
      currentId = undefined;
      player.removeAttribute('src');
      player.load();
    }
    videos = videos.filter(item => item.id !== video.id);
    if (Object.hasOwn(layout.gaps, video.id)) {
      delete layout.gaps[video.id];
      await storePreference('layout', layout);
    }
    releaseUrl(video.file);
    releaseUrl(video.thumbnail);
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

async function inspectVideo(file) {
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
  $('capture').disabled = preview.readyState < 2 || preview.seeking || pendingEditorPosition !== null || auditioning;
}

function editVideo(video) {
  closeEditor();
  editorId = video.id;
  pendingEditorPosition = video.frame || null;
  $('edit-title').textContent = video.name;
  $('caption').value = video.caption;
  $('volume').value = video.volume;
  $('volume-value').value = video.volume + '%';
  $('video-editor').hidden = false;
  preview.src = urlFor(video.file);
  syncFrame();
  renderLibrary();
  $('video-editor').scrollIntoView({ block: 'nearest' });
}

function closeEditor() {
  const previous = edited();
  editorGeneration += 1;
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

$('frame-seek').oninput = event => seekPreview(Number(event.target.value));
$('frame-prev').onclick = () => seekPreview((pendingEditorPosition ?? preview.currentTime) - 0.04);
$('frame-next').onclick = () => seekPreview((pendingEditorPosition ?? preview.currentTime) + 0.04);
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

$('volume').oninput = event => {
  const volume = Number(event.target.value);
  $('volume-value').value = volume + '%';
  applyVolume(preview, previewGain, volume);
  if (editorId === currentId) applyVolume(player, mainGain, volume);
  if (edited()) edited().volume = volume;
};
$('volume').onchange = event => updateEdited({ volume: Number(event.target.value) });

function stopAudition() {
  if (!auditioning) return;
  auditioning = false;
  preview.pause();
  $('audition').textContent = '音量を試聴';
  syncFrame();
}

$('audition').onclick = () => {
  if (auditioning) {
    stopAudition();
    return;
  }
  const video = edited();
  if (!video) return;
  player.pause();
  enableAudio();
  applyVolume(preview, previewGain, video.volume);
  if (preview.ended) preview.currentTime = 0;
  auditioning = true;
  $('audition').textContent = '試聴を停止';
  syncFrame();
  preview.play().catch(error => {
    stopAudition();
    if (error.name !== 'AbortError') message($('edit-state'), '試聴を開始できませんでした。');
  });
};

function applyLayout(node) {
  const properties = {
    '--top': layout.top + '%',
    '--video-width': layout.width + '%',
    '--video-size': layout.height / 100,
    '--video-x': clamp(layout.x, layout.width / 2, 100 - layout.width / 2) + '%',
    '--rail': layout.rail + '%',
    '--thumb': layout.thumb + 'px',
  };
  for (const [property, value] of Object.entries(properties)) node.style.setProperty(property, value);
}

function renderLayout() {
  applyLayout($('screen'));
  renderRailSpacing(railTrack);
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

function renderLayoutFields() {
  const fields = layoutSpecs.map(([key, label, min, max, unit]) => rangeField(label, min, max, unit, layout[key], value => {
    layout[key] = value;
    renderLayout();
  }, () => storePreference('layout', layout)));
  $('layout-fields').replaceChildren(...fields);
}

function renderRailSettings() {
  const custom = layout.railMode === 'custom';
  $('rail-mode').value = layout.railMode;
  $('rail-custom').hidden = !custom;
  if (!custom) return;

  const gaps = $('rail-gaps');
  gaps.replaceChildren();
  $('rail-gap-help').textContent = videos.length < 2
    ? '動画を2本以上登録すると、間隔を調整できます。'
    : '各サムネイルと、その一つ前のサムネイルとの間隔を指定します。';
  videos.slice(1).forEach((video, index) => {
    const title = video.caption || video.name;
    const field = element('label', 'rail-gap');
    const name = element('span', '', (index + 2) + '番目の前 · ' + title);
    name.title = name.textContent;
    const value = element('span', 'rail-gap-value');
    const input = element('input');
    Object.assign(input, {
      type: 'number', inputMode: 'numeric', min: 0, max: maxGap, step: 1,
      value: layout.gaps[video.id] ?? defaultGap,
    });
    input.setAttribute('aria-label', name.textContent + ' の間隔（px）');
    input.oninput = () => {
      if (!Number.isFinite(input.valueAsNumber)) return;
      layout.gaps[video.id] = clamp(Math.round(input.valueAsNumber), 0, maxGap);
      renderLayout();
    };
    input.onchange = () => {
      input.value = layout.gaps[video.id] ?? defaultGap;
      storePreference('layout', layout);
    };
    value.append(input, element('span', '', 'px'));
    field.append(name, value);
    gaps.append(field);
  });
}

$('rail-mode').onchange = event => {
  layout.railMode = event.target.value;
  renderRailSettings();
  renderLayout();
  storePreference('layout', layout);
};

$('reset-layout').onclick = () => {
  layout = { ...defaults, gaps: {} };
  renderLayoutFields();
  renderRailSettings();
  renderLayout();
  storePreference('layout', layout);
};

function placeObject(node, object) {
  node.style.left = object.x + '%';
  node.style.top = object.y + '%';
  node.style.color = object.color;
  node.style.setProperty('--object-size', object.size + (object.type === 'text' ? 'cqw' : '%'));
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
  const mock = $(tab === 'layout' ? 'layout-preview' : 'object-preview');
  const frame = element('div', 'frame', '動画枠');
  const scroll = mock.querySelector('.mock-rail')?.scrollLeft || 0;
  const strip = element('div', 'mock-rail');
  const track = element('div', 'rail-track');
  strip.append(track);
  for (const video of videos) {
    const tile = element(video.thumbnail ? 'img' : 'span', 'mock-tile');
    tile.dataset.id = video.id;
    if (video.thumbnail) {
      tile.src = urlFor(video.thumbnail);
      tile.alt = '';
    }
    track.append(tile);
  }
  renderRailSpacing(track);
  const overlay = element('div', 'decorations');
  for (const object of decorations.filter(object => object.visible)) {
    const node = objectNode(object);
    if (tab === 'objects') attachDrag(node, object, mock);
    overlay.append(node);
  }
  const { clientWidth, clientHeight } = $('screen');
  mock.style.setProperty('--mock-ratio', clientWidth + ' / ' + clientHeight);
  applyLayout(mock);
  mock.replaceChildren(frame, strip, overlay);
  const scale = mock.clientWidth / clientWidth;
  const inset = parseFloat(getComputedStyle(rail).paddingLeft) || 0;
  mock.style.setProperty('--mock-inset', inset * scale + 'px');
  track.style.setProperty('--rail-scale', scale);
  strip.scrollLeft = scroll;
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
  for (const [key, label, min, max, unit] of specs) {
    fields.append(rangeField(label, min, max, unit, object[key], value => update(key, value), save));
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
    const [entries, savedLayout, savedObjects, order] = await Promise.all([
      readVideos(), readPreference('layout'), readPreference('decorations'), readPreference('order'),
    ]);
    const positions = new Map((order || []).map((id, index) => [id, index]));
    videos = entries.sort((a, b) => {
      const orderDifference = (positions.get(a.id) ?? entries.length) - (positions.get(b.id) ?? entries.length);
      return orderDifference || (a.addedAt ?? 0) - (b.addedAt ?? 0);
    });
    layout = { ...defaults, ...savedLayout, gaps: savedLayout?.gaps ?? {} };
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
  renderLayoutFields();
  renderLayout();
  renderObjects();
  updatePlayer();
  prepareOffline();
}
window.addEventListener('resize', () => {
  if (activeTab === 'layout' || activeTab === 'objects') renderMock(activeTab);
});
start();
