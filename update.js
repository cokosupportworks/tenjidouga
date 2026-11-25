'use strict';

const checkButton = document.getElementById('check-update');
const updateStatus = document.getElementById('update-status');

function waitForWorker(worker, ...states) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      worker.removeEventListener('statechange', check);
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (states.includes(worker.state)) finish();
      if (worker.state === 'redundant') finish(new Error('更新の準備に失敗しました。'));
    };
    const timeout = setTimeout(() => finish(new Error('更新の準備に時間がかかっています。')), 60000);
    worker.addEventListener('statechange', check);
    check();
  });
}

if ('serviceWorker' in navigator) {
  checkButton.disabled = false;
  checkButton.addEventListener('click', async () => {
    checkButton.disabled = true;
    updateStatus.textContent = '公開されているアプリを確認しています。';
    try {
      const registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
      await registration.update();
      const worker = registration.installing || registration.waiting;
      if (worker) {
        await waitForWorker(worker, 'installed', 'activating', 'activated');
        if (worker.state === 'installed') worker.postMessage('activate-exhibit-player-update');
        await waitForWorker(worker, 'activated');
        updateStatus.textContent = '更新しました。「アプリを開く」を押してください。開いたままの操作画面や上映画面は閉じて、開き直してください。';
      } else if (registration.active) {
        updateStatus.textContent = '公開されている最新版が利用できます。「アプリを開く」を押してください。';
      } else {
        throw new Error('更新の準備に失敗しました。');
      }
    } catch {
      updateStatus.textContent = '更新を確認できませんでした。インターネット接続を確認し、もう一度押してください。';
    } finally {
      checkButton.disabled = false;
    }
  });
} else {
  updateStatus.textContent = 'このブラウザでは更新を実行できません。アプリを開いているブラウザでこのページを開いてください。';
}
