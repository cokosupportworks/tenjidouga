const fullscreen = document.getElementById('fullscreen');
const enlargeWindow = document.getElementById('enlarge-window');
const isWindows = /Windows/i.test(navigator.userAgent);
const isIPad = /iPad/i.test(navigator.userAgent) ||
  (/Mac/i.test(navigator.platform) && navigator.maxTouchPoints > 1);
const fullscreenLabel = isWindows ? '外部画面で全画面' : '全画面';
let hideControlsTimer;
let originalWindow;

fullscreen.textContent = fullscreenLabel;
enlargeWindow.hidden = !isWindows;

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
