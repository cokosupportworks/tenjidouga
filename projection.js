const fullscreen = document.getElementById('fullscreen');

fullscreen.addEventListener('click', async () => {
  try {
    await document.body.requestFullscreen();
  } catch {
    fullscreen.textContent = 'ブラウザの全画面表示を使用';
  }
});

window.addEventListener('pagehide', () => {
  window.opener?.postMessage('exhibit-projection-closing', location.origin);
});
window.opener?.postMessage('exhibit-projection-ready', location.origin);
