import type { ExtensionConfig } from '../types';

// Elements
const statusEl = document.getElementById('status')!;
const statusTextEl = document.getElementById('status-text')!;
const enabledEl = document.getElementById('enabled') as HTMLInputElement;
const domainsEl = document.getElementById('domains') as HTMLTextAreaElement;
const daemonUrlEl = document.getElementById('daemon-url') as HTMLInputElement;
const authTokenEl = document.getElementById('auth-token') as HTMLInputElement;
const saveBtn = document.getElementById('save')!;
const syncBtn = document.getElementById('sync')!;
const bufferedCountEl = document.getElementById('buffered-count')!;

// Load current config and status
async function loadState(): Promise<void> {
  // Get config
  const config = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' }) as ExtensionConfig;
  enabledEl.checked = config.enabled;
  domainsEl.value = config.trackedDomains.join('\n');
  daemonUrlEl.value = config.daemonWsUrl;
  authTokenEl.value = config.authToken || '';

  // Get status
  updateStatus();
}

// Update connection status
async function updateStatus(): Promise<void> {
  const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' }) as {
    connected: boolean;
    enabled: boolean;
    bufferedRequests: number;
  };

  if (status.connected) {
    statusEl.className = 'status connected';
    statusTextEl.textContent = 'Connected';
  } else {
    statusEl.className = 'status disconnected';
    statusTextEl.textContent = status.enabled ? 'Connecting...' : 'Disabled';
  }

  bufferedCountEl.textContent = status.bufferedRequests.toString();
}

// Save config
async function saveConfig(): Promise<void> {
  const config: Partial<ExtensionConfig> = {
    enabled: enabledEl.checked,
    trackedDomains: domainsEl.value
      .split('\n')
      .map((d) => d.trim())
      .filter((d) => d.length > 0),
    daemonWsUrl: daemonUrlEl.value.trim() || 'ws://localhost:58234',
    authToken: authTokenEl.value.trim(),
  };

  await chrome.runtime.sendMessage({ type: 'SET_CONFIG', config });

  // Update status after a short delay to allow connection
  setTimeout(updateStatus, 500);
}

// Sync now
async function syncNow(): Promise<void> {
  syncBtn.textContent = 'Syncing...';
  syncBtn.setAttribute('disabled', 'true');

  await chrome.runtime.sendMessage({ type: 'SYNC_NOW' });

  syncBtn.textContent = 'Sync Now';
  syncBtn.removeAttribute('disabled');
  updateStatus();
}

// Event listeners
saveBtn.addEventListener('click', saveConfig);
syncBtn.addEventListener('click', syncNow);
enabledEl.addEventListener('change', saveConfig);

// Poll status every 2 seconds
setInterval(updateStatus, 2000);

// Initial load
loadState();
