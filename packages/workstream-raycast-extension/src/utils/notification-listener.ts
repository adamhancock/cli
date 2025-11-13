import { showToast, Toast } from '@raycast/api';
import Redis from 'ioredis';
import { REDIS_CHANNELS } from './redis-client';

interface NotificationMessage {
  type: 'claude_started' | 'claude_waiting' | 'claude_finished' | 'pr_check_failed' | 'pr_check_success' | 'pr_merge_blocked' | 'notification';
  title: string;
  message: string;
  style: 'success' | 'failure' | 'info';
  timestamp: number;
  projectPath?: string;
  projectName: string;
}

let subscriber: Redis | null = null;

/**
 * Map notification style to Raycast Toast style
 */
function getToastStyle(style: NotificationMessage['style']): Toast.Style {
  switch (style) {
    case 'success':
      return Toast.Style.Success;
    case 'failure':
      return Toast.Style.Failure;
    case 'info':
    default:
      return Toast.Style.Animated;
  }
}

/**
 * Handle incoming notification message
 */
async function handleNotification(message: string) {
  try {
    const notification = JSON.parse(message) as NotificationMessage;

    await showToast({
      style: getToastStyle(notification.style),
      title: notification.title,
      message: notification.message,
    });
  } catch (error) {
    console.error('[Notification Listener] Failed to handle notification:', error);
  }
}

/**
 * Start listening for notifications from Redis
 */
export function startNotificationListener() {
  if (subscriber) {
    console.log('[Notification Listener] Already running');
    return;
  }

  try {
    subscriber = new Redis({
      host: 'localhost',
      port: 6379,
      lazyConnect: false,
      retryStrategy: (times) => {
        if (times > 3) {
          return null;
        }
        return Math.min(times * 50, 500);
      },
    });

    subscriber.on('error', (err) => {
      console.error('[Notification Listener] Redis error:', err.message);
    });

    subscriber.on('connect', () => {
      console.log('[Notification Listener] Connected to Redis');
    });

    subscriber.on('message', (channel, message) => {
      if (channel === REDIS_CHANNELS.NOTIFICATIONS) {
        handleNotification(message);
      }
    });

    subscriber.subscribe(REDIS_CHANNELS.NOTIFICATIONS, (err) => {
      if (err) {
        console.error('[Notification Listener] Failed to subscribe:', err);
      } else {
        console.log('[Notification Listener] Subscribed to notifications channel');
      }
    });
  } catch (error) {
    console.error('[Notification Listener] Failed to start:', error);
    subscriber = null;
  }
}

/**
 * Stop listening for notifications
 */
export async function stopNotificationListener() {
  if (subscriber) {
    try {
      await subscriber.unsubscribe(REDIS_CHANNELS.NOTIFICATIONS);
      await subscriber.quit();
      console.log('[Notification Listener] Stopped');
    } catch (error) {
      console.error('[Notification Listener] Failed to stop:', error);
    } finally {
      subscriber = null;
    }
  }
}
