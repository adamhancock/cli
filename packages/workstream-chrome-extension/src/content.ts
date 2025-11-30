// Content script - runs in the context of web pages
// Can access localStorage and send data to background script

function getLocalStorageData(): Record<string, string> {
  const data: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key) {
      const value = localStorage.getItem(key);
      if (value !== null) {
        data[key] = value;
      }
    }
  }
  return data;
}

function syncLocalStorage(): void {
  const data = getLocalStorageData();
  const origin = window.location.origin;

  chrome.runtime.sendMessage({
    type: 'LOCALSTORAGE_UPDATE',
    origin,
    data,
    timestamp: Date.now(),
  });
}

// Sync on page load
syncLocalStorage();

// Listen for storage events (changes from other tabs/windows)
window.addEventListener('storage', () => {
  syncLocalStorage();
});

// Also sync periodically to catch programmatic changes
setInterval(syncLocalStorage, 5000);

// Listen for requests from background to sync
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'SYNC_LOCALSTORAGE') {
    syncLocalStorage();
    sendResponse({ success: true });
  }
});
