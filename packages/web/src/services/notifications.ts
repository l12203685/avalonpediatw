/**
 * Browser Notification Service
 * Sends native browser notifications when it's the player's turn to act.
 * Falls back silently if the Notification API is not available or permission is denied.
 */

export async function requestNotificationPermission(): Promise<void> {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

export function sendTurnNotification(title: string, body: string): void {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return; // only notify when tab is hidden

  try {
    const n = new Notification(title, {
      body,
      icon: '/favicon.ico',
      tag: 'avalon-turn', // replaces previous notification
    });
    // Auto-close after 5 seconds
    setTimeout(() => n.close(), 5000);
  } catch {
    // Silently fail — notifications are non-critical
  }
}
