import { List, ActionPanel, Action, Icon, Color, showToast, Toast, closeMainWindow } from '@raycast/api';
import { useState, useEffect, useRef } from 'react';
import { exec } from 'child_process';
import { promisify } from 'util';
import Redis from 'ioredis';

const execAsync = promisify(exec);

interface ChromeTab {
  index: number;
  title: string;
  url: string;
  favicon?: string;
}

interface ChromeWindow {
  id: number;
  tabs: ChromeTab[];
  lastUpdated: number;
}

export default function Command() {
  const [windows, setWindows] = useState<ChromeWindow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchText, setSearchText] = useState('');
  const redisRef = useRef<Redis | null>(null);

  // Load Chrome windows from Redis
  useEffect(() => {
    loadChromeWindows();

    // Subscribe to Chrome updates
    const subscriber = new Redis({
      host: 'localhost',
      port: 6379,
    });

    subscriber.subscribe('workstream:chrome:updates', (err) => {
      if (err) {
        console.error('Failed to subscribe to Chrome updates:', err);
        return;
      }
      console.log('Subscribed to Chrome updates');
    });

    subscriber.on('message', async (channel, message) => {
      if (channel === 'workstream:chrome:updates') {
        console.log('Received Chrome update');
        await loadChromeWindows();
      }
    });

    redisRef.current = subscriber;

    return () => {
      subscriber.quit();
    };
  }, []);

  async function loadChromeWindows() {
    try {
      const redis = new Redis({
        host: 'localhost',
        port: 6379,
      });

      const data = await redis.get('workstream:chrome:windows');
      await redis.quit();

      if (data) {
        const chromeWindows = JSON.parse(data) as ChromeWindow[];
        // Sort windows by ID, then sort tabs by index within each window
        const sortedWindows = chromeWindows
          .sort((a, b) => a.id - b.id)
          .map((w) => ({
            ...w,
            tabs: [...w.tabs].sort((a, b) => a.index - b.index),
          }));
        setWindows(sortedWindows);
      } else {
        setWindows([]);
      }
    } catch (error) {
      console.error('Failed to load Chrome windows:', error);
      setWindows([]);
    } finally {
      setIsLoading(false);
    }
  }

  async function switchToTab(windowId: number, tabIndex: number) {
    try {
      const script = `
        tell application "Google Chrome"
          activate
          set _wnd to first window where id is ${windowId}
          set index of _wnd to 1
          set active tab index of _wnd to ${tabIndex + 1}
        end tell
      `;

      await execAsync(`osascript -e '${script}'`);
      await closeMainWindow();
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to switch to tab',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async function closeTab(windowId: number, tabIndex: number) {
    try {
      const script = `
        tell application "Google Chrome"
          set _wnd to first window where id is ${windowId}
          close tab ${tabIndex + 1} of _wnd
        end tell
      `;

      await execAsync(`osascript -e '${script}'`);

      await showToast({
        style: Toast.Style.Success,
        title: 'Tab closed',
      });

      // Refresh the list after closing
      await loadChromeWindows();
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to close tab',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  function getUrlWithoutScheme(url: string): string {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname + urlObj.pathname + urlObj.search + urlObj.hash;
    } catch {
      return url;
    }
  }

  function getHostname(url: string): string {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch {
      return '';
    }
  }

  function matchesSearch(tab: ChromeTab, query: string): boolean {
    if (!query) return true;

    const lowerQuery = query.toLowerCase();
    const titleMatch = tab.title.toLowerCase().includes(lowerQuery);
    const urlMatch = tab.url.toLowerCase().includes(lowerQuery);

    return titleMatch || urlMatch;
  }

  const filteredWindows = windows
    .map((window) => ({
      ...window,
      tabs: window.tabs.filter((tab) => matchesSearch(tab, searchText)),
    }))
    .filter((window) => window.tabs.length > 0);

  const totalTabs = windows.reduce((sum, w) => sum + w.tabs.length, 0);
  const filteredTabs = filteredWindows.reduce((sum, w) => sum + w.tabs.length, 0);

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search Chrome tabs by title or URL..."
      onSearchTextChange={setSearchText}
      throttle
    >
      {filteredWindows.length === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.Globe}
          title={searchText ? 'No matching tabs' : 'No Chrome windows detected'}
          description={
            searchText
              ? 'Try a different search term'
              : 'Open Google Chrome to see windows and tabs here'
          }
        />
      ) : (
        filteredWindows.map((window) => (
          <List.Section
            key={window.id}
            title={`Window ${window.id} • ${window.tabs.length} tab${window.tabs.length !== 1 ? 's' : ''}`}
          >
            {window.tabs.map((tab) => (
              <List.Item
                key={`${window.id}-${tab.index}`}
                icon={Icon.Globe}
                title={tab.title || 'Untitled'}
                subtitle={getUrlWithoutScheme(tab.url)}
                accessories={[
                  {
                    text: getHostname(tab.url),
                    tooltip: tab.url,
                  },
                ]}
                actions={
                  <ActionPanel>
                    <Action
                      title="Switch to Tab"
                      onAction={() => switchToTab(window.id, tab.index)}
                      icon={Icon.Window}
                    />
                    <Action
                      title="Close Tab"
                      onAction={() => closeTab(window.id, tab.index)}
                      icon={Icon.XMarkCircle}
                      style={Action.Style.Destructive}
                      shortcut={{ modifiers: ['cmd'], key: 'w' }}
                    />
                    <Action.OpenInBrowser
                      title="Open in New Tab"
                      url={tab.url}
                      icon={Icon.Plus}
                      shortcut={{ modifiers: ['cmd'], key: 'o' }}
                    />
                    <Action.CopyToClipboard
                      title="Copy URL"
                      content={tab.url}
                      shortcut={{ modifiers: ['cmd'], key: 'c' }}
                    />
                    <Action
                      title="Refresh"
                      onAction={() => loadChromeWindows()}
                      icon={Icon.ArrowClockwise}
                      shortcut={{ modifiers: ['cmd'], key: 'r' }}
                    />
                  </ActionPanel>
                }
              />
            ))}
          </List.Section>
        ))
      )}
    </List>
  );
}
