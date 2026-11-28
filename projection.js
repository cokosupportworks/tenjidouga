const fullscreen = document.getElementById('fullscreen');
const enlargeWindow = document.getElementById('enlarge-window');
const externalStatus = document.getElementById('external-fullscreen-status');
const isDesktop = location.protocol === 'exhibit:';
const isWindows = /Windows/i.test(navigator.userAgent);
const isIPad = /iPad/i.test(navigator.userAgent) ||
  (/Mac/i.test(navigator.platform) && navigator.maxTouchPoints > 1);
const fullscreenLabel = isWindows ? '外部画面で全画面' : '全画面';
let hideControlsTimer;
let originalWindow;

fullscreen.textContent = fullscreenLabel;
fullscreen.hidden = isDesktop;
enlargeWindow.hidden = isDesktop || !isWindows;
if (isDesktop) {
  document.getElementById('desktop-projection-bar').hidden = false;
  document.getElementById('close-desktop-projection').onclick = () => window.close();
}

enlargeWindow.addEventListener('click', () => {
  if (originalWindow) {
    const { left, top, width, height } = originalWindow;
    window.resizeTo(width, height);
    window.moveTo(left, top);
    originalWindow = undefined;
    enlargeWindow.textContent = '拡大表示';
    return;
  }

  originalWindow = {
    left: window.screenX, top: window.screenY,
    width: window.outerWidth, height: window.outerHeight,
  };
  const { availLeft, availTop, availWidth, availHeight } = window.screen;
  if (Number.isFinite(availLeft) && Number.isFinite(availTop)) {
    window.moveTo(availLeft, availTop);
  }
  window.resizeTo(availWidth, availHeight);
  enlargeWindow.textContent = '元の大きさに戻す';
});

if (isIPad && !document.fullscreenEnabled) {
  document.addEventListener('playing', () => { fullscreen.hidden = true; }, { capture: true, once: true });
}

function hideFullscreenControls() {
  document.body.classList.remove('show-fullscreen-controls');
  clearTimeout(hideControlsTimer);
}

function showExternalStatus(text) {
  externalStatus.textContent = text;
  externalStatus.hidden = !text;
  return text;
}

function sameScreen(first, second) {
  return first.left === second.left && first.top === second.top;
}

function waitForScreen(details, destination) {
  if (sameScreen(details.currentScreen, destination)) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timeout);
      details.removeEventListener('currentscreenchange', check);
      resolve(sameScreen(details.currentScreen, destination));
    };
    const check = () => {
      if (sameScreen(details.currentScreen, destination)) finish();
    };
    const timeout = setTimeout(finish, 1200);
    details.addEventListener('currentscreenchange', check);
    check();
  });
}

async function projectOnExternalScreen() {
  if (fullscreen.disabled) return '';
  if (typeof window.getScreenDetails !== 'function' || typeof window.opener?.getScreenDetails !== 'function') {
    return showExternalStatus('外部画面を確認できません。Microsoft Edgeの操作画面から上映画面を開いてください。');
  }
  fullscreen.disabled = true;
  showExternalStatus('外部画面を確認しています。');
  let originalPosition;
  try {
    const details = await window.getScreenDetails();
    const { currentScreen: home } = await window.opener.getScreenDetails();
    const choices = details.screens.filter(screen => !screen.isInternal && !sameScreen(screen, home));
    const destination = choices.find(screen => sameScreen(screen, details.currentScreen)) || choices[0];
    if (!destination) {
      return showExternalStatus('外部画面が見つかりません。Windowsのディスプレイ設定で「拡張」を選んでください。');
    }

    const width = window.outerWidth, height = window.outerHeight;
    const info = {
      home: { availLeft: home.availLeft, availTop: home.availTop, availWidth: home.availWidth, availHeight: home.availHeight },
      width, height,
    };
    if (!sameScreen(details.currentScreen, destination)) {
      originalPosition = { left: window.screenX, top: window.screenY, width, height };
      const w = Math.min(width, destination.availWidth);
      const h = Math.min(height, destination.availHeight);
      const left = destination.availLeft + Math.round((destination.availWidth - w) / 2);
      const top = destination.availTop + Math.round((destination.availHeight - h) / 2);
      window.moveTo(left, top);
      window.resizeTo(w, h);
      window.moveTo(left, top);
      await waitForScreen(details, destination);
    }
    if (!sameScreen(details.currentScreen, destination)) {
      return showExternalStatus('外部画面への移動を確認できません。上映ウィンドウをテレビ側へドラッグしてから押してください。');
    }

    try {
      await document.body.requestFullscreen({ screen: destination, navigationUI: 'hide' });
    } catch {
      return showExternalStatus('全画面にできませんでした。上映画面の右下にある「外部画面で全画面」をもう一度押してください。');
    }
    if (!sameScreen(details.currentScreen, destination)) {
      await document.exitFullscreen();
      return showExternalStatus('外部画面での表示を確認できなかったため、全画面を解除しました。');
    }
    originalPosition = undefined;
    window.opener.postMessage({ type: 'exhibit-projection-external-confirmed', info }, location.origin);
    return showExternalStatus('');
  } catch (error) {
    return showExternalStatus(error.name === 'NotAllowedError'
      ? 'Edgeのサイト設定で「ウィンドウ管理」を許可してください。'
      : 'ディスプレイを確認できません。接続とWindowsの「拡張」設定を確認してください。');
  } finally {
    if (originalPosition && !document.fullscreenElement) {
      window.resizeTo(originalPosition.width, originalPosition.height);
      window.moveTo(originalPosition.left, originalPosition.top);
      window.focus();
    }
    fullscreen.disabled = false;
  }
}

if (isWindows) window.exhibitProjectOnExternalScreen = projectOnExternalScreen;

document.addEventListener('fullscreenchange', () => {
  hideFullscreenControls();
  fullscreen.blur();
  fullscreen.textContent = document.fullscreenElement ? '全画面を終了' : fullscreenLabel;
});

document.body.addEventListener('click', event => {
  if (!document.fullscreenElement || fullscreen.contains(event.target)) return;
  document.body.classList.add('show-fullscreen-controls');
  clearTimeout(hideControlsTimer);
  hideControlsTimer = setTimeout(hideFullscreenControls, 5000);
});

fullscreen.addEventListener('click', async () => {
  if (document.fullscreenElement) {
    try {
      await document.exitFullscreen();
    } catch {
      fullscreen.textContent = '全画面を終了（再試行）';
    }
    return;
  }
  if (isWindows) {
    await projectOnExternalScreen();
    return;
  }
  try {
    const destination = window.exhibitFullscreenDestination;
    if (destination) {
      await document.body.requestFullscreen({ screen: destination, navigationUI: 'hide' });
      window.exhibitFullscreenDestination = undefined;
      window.opener?.postMessage('exhibit-projection-external-fullscreen', location.origin);
    } else {
      await document.body.requestFullscreen();
    }
  } catch {
    fullscreen.textContent = isIPad ? 'iPadOSのウインドウコントロールで全画面にする' : fullscreenLabel;
  }
});

window.addEventListener('pagehide', () => {
  window.opener?.postMessage('exhibit-projection-closing', location.origin);
});
window.opener?.postMessage('exhibit-projection-ready', location.origin);
