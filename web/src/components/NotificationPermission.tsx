import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import {
  browserNotificationPermissionError,
  enableNotificationsForCurrentDevice,
  getBrowserPermissionPromptMessage,
  getNotificationSupportState,
  prepareBrowserPushInfrastructure,
  requestBrowserNotificationPermission,
} from '../lib/device-notifications';

type NotificationPermissionState = 'loading' | 'unsupported' | 'enabled' | 'blocked' | 'prompt';

type NotificationPermissionProps = {
  publicKey: string;
};

export default function NotificationPermission({ publicKey }: NotificationPermissionProps) {
  const [state, setState] = useState<NotificationPermissionState>('loading');
  const [message, setMessage] = useState<string>('');
  const [isEnabling, setIsEnabling] = useState(false);

  useEffect(() => {
    const initialize = async () => {
      if (Capacitor.isNativePlatform()) {
        setState('unsupported');
        return;
      }

      try {
        const supportState = await getNotificationSupportState(publicKey);

        if (!supportState.supported) {
          setState('unsupported');
          setMessage(supportState.message);
          return;
        }

        if (supportState.buttonDisabled) {
          setState(Notification.permission === 'denied' ? 'blocked' : 'enabled');
          setMessage(supportState.message);
          return;
        }

        setState('prompt');
        setMessage(supportState.message);
      } catch (error) {
        console.error('[NotificationPermission] initialization failed', error);
        setState('unsupported');
        setMessage('Failed to check notification support.');
      }
    };

    initialize();
    void prepareBrowserPushInfrastructure();
  }, []);

  const handleEnable = async () => {
    const permissionPromise = requestBrowserNotificationPermission();
    setIsEnabling(true);
    if (Notification.permission === 'default') {
      setMessage(getBrowserPermissionPromptMessage());
    }

    try {
      const permission = await permissionPromise;
      const permissionError = browserNotificationPermissionError(permission);
      if (permissionError) {
        throw permissionError;
      }

      setMessage('Registering this device for notifications...');
      const result = await enableNotificationsForCurrentDevice(publicKey, permission);
      setState('enabled');
      setMessage(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[NotificationPermission] failed to enable', error);
      setMessage(message);
      setState(Notification.permission === 'denied' ? 'blocked' : 'prompt');
    } finally {
      setIsEnabling(false);
    }
  };

  if (state === 'loading') {
    return null;
  }

  if (state === 'unsupported') {
    return null;
  }

  if (state === 'enabled') {
    return (
      <div className="notification-permission-enabled">
        <p className="success-message">✓ {message}</p>
      </div>
    );
  }

  if (state === 'blocked') {
    return (
      <div className="notification-permission-prompt">
        <p className="notification-message">{message}</p>
      </div>
    );
  }

  return (
    <div className="notification-permission-prompt">
      <p className="notification-message">{message}</p>
      <button
        type="button"
        className="notification-button"
        onClick={handleEnable}
        disabled={isEnabling}
        aria-label="Enable notifications"
      >
        {isEnabling ? 'Enabling...' : 'Enable notifications'}
      </button>
    </div>
  );
}

const styles = `
  .notification-permission-prompt {
    padding: 1rem;
    background-color: #f0f8f5;
    border: 1px solid #c7e9e5;
    border-radius: 8px;
    margin-bottom: 1rem;
  }

  .notification-permission-enabled {
    padding: 1rem;
    background-color: #e8f5e9;
    border: 1px solid #a5d6a7;
    border-radius: 8px;
    margin-bottom: 1rem;
  }

  .notification-message {
    margin: 0 0 0.75rem 0;
    font-size: 0.95rem;
    color: #1b5e20;
  }

  .success-message {
    margin: 0;
    font-size: 0.95rem;
    color: #2e7d32;
  }

  .notification-button {
    padding: 0.5rem 1rem;
    background-color: #1976d2;
    color: white;
    border: none;
    border-radius: 4px;
    font-size: 0.95rem;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .notification-button:hover:not(:disabled) {
    background-color: #1565c0;
  }

  .notification-button:disabled {
    background-color: #90caf9;
    cursor: not-allowed;
  }
`;
