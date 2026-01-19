// Daemon WebSocket server port (same as Chrome extension connects to)
const DAEMON_PORT = 9995;

/**
 * Navigate to a URL via the Chrome extension
 * The daemon emits a socket.io event to the Chrome extension which navigates the tab
 */
export async function navigateViaChromeExtension(
  url: string,
): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${DAEMON_PORT}/api/navigate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Legacy exports for backwards compatibility
export async function isPWAInstalled(): Promise<boolean> {
  // We don't need to check PWA installation anymore
  // Just try to navigate via Chrome extension
  return true;
}

export async function launchPWAWithUrl(url: string): Promise<boolean> {
  return navigateViaChromeExtension(url);
}
