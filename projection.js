const fullscreen = document.getElementById('fullscreen');
const isIPad = /iPad/i.test(navigator.userAgent) ||
  (/Mac/i.test(navigator.platform) && navigator.maxTouchPoints > 1);

if (isIPad) {
  document.addEventListener('playing', () => { fullscreen.hidden = true; }, { capture: true, once: true });
}

fullscreen.addEventListener('click', async () => {
  try {
    const destination = window.exhibitFullscreenDestination;
    if (destination) {
      await document.body.requestFullscreen({ screen: destination, navigationUI: 'hide' });
      window.exhibitFullscreenDestination = undefined;
      fullscreen.textContent = '全画面';
      window.opener?.postMessage('exhibit-projection-external-fullscreen', location.origin);
    } else {
      await document.body.requestFullscreen();
    }
  } catch {
    fullscreen.textContent = isIPad ? 'iPadOSのウインドウコントロールで全画面にする' : 'ブラウザの全画面表示を使用';
  }
});

window.addEventListener('pagehide', () => {
  window.opener?.postMessage('exhibit-projection-closing', location.origin);
});
window.opener?.postMessage('exhibit-projection-ready', location.origin);
