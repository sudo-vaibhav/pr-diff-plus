(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const status = document.getElementById('status');

  async function load() {
    const got = await api.storage.local.get(['settings']);
    const s = got.settings ?? { autoCollapse: true, syncReviewed: true };
    document.getElementById('autoCollapse').checked = s.autoCollapse;
    document.getElementById('syncReviewed').checked = s.syncReviewed;
  }

  async function save() {
    const settings = {
      autoCollapse: document.getElementById('autoCollapse').checked,
      syncReviewed: document.getElementById('syncReviewed').checked
    };
    await api.storage.local.set({ settings });
    status.textContent = 'Saved. Reload PR page to apply.';
    setTimeout(() => (status.textContent = ''), 2000);
  }

  document.getElementById('autoCollapse').addEventListener('change', save);
  document.getElementById('syncReviewed').addEventListener('change', save);

  document.getElementById('clearReviewed').addEventListener('click', async () => {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    const url = tabs[0]?.url || '';
    const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!m) {
      status.textContent = 'Not on a GitHub PR.';
      return;
    }
    const key = `reviewed:${m[1]}/${m[2]}#${m[3]}`;
    await api.storage.local.remove(key);
    status.textContent = `Cleared ${key}`;
  });

  load();
})();
