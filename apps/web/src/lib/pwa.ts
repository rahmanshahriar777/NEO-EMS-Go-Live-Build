'use client';

import { useState } from 'react';
import { api } from '../lib/api-client';

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(new ArrayBuffer(rawData.length));
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export type PushStatus = 'unsupported' | 'idle' | 'subscribing' | 'subscribed' | 'denied' | 'failed';

/**
 * Registers the offline service worker and subscribes to web-push.
 *
 * Push subscription is POSTed to `/notifications/push-subscriptions`
 * (Phase 3 item 7). If the backend endpoint does not exist yet, the failure is
 * reported to the caller — the subscription is never silently dropped or
 * faked as successful.
 */
export async function subscribeToPush(vapidPublicKey: string): Promise<PushStatus> {
  if (
    typeof window === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !vapidPublicKey
  ) {
    return 'unsupported';
  }
  try {
    if (Notification.permission === 'denied') return 'denied';
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return 'denied';
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ||
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      }));
    // Hand the subscription to the notifications backend. The server owns
    // delivery; the client only holds the endpoint.
    await api.post('/notifications/push-subscriptions', subscription.toJSON());
    return 'subscribed';
  } catch {
    return 'failed';
  }
}

export function usePushSubscription() {
  const [status, setStatus] = useState<PushStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const subscribe = async () => {
    setStatus('subscribing');
    setError(null);
    try {
      // The VAPID public key is published by the API (not a secret).
      const res = await api.get<{ vapidPublicKey?: string }>('/notifications/vapid-public-key');
      const key = res?.vapidPublicKey || process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '';
      const result = await subscribeToPush(key);
      setStatus(result);
      if (result === 'failed') {
        setError(
          'Could not register push notifications. The backend endpoint may not be available yet.',
        );
      } else if (result === 'unsupported') {
        setError('This browser does not support web-push notifications.');
      }
    } catch (err: any) {
      setStatus('failed');
      setError(err?.message || 'Push subscription failed.');
    }
  };

  return { status, error, subscribe };
}

/**
 * Location-checked clock-in helper (Phase 3 item 7).
 *
 * The client checks the device position against the site coordinates and only
 * sends the punch when inside the radius. The API re-validates server-side —
 * client-side gating is UX only, never the trust boundary.
 */
export interface SiteCheck {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  siteName?: string;
}

export function distanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export async function getDevicePosition(): Promise<GeolocationPosition> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    throw new Error('Geolocation is not supported on this device.');
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 60000,
    });
  });
}

/**
 * Returns the position only if it falls within the site radius; otherwise
 * throws with a human-readable message. Callers pass the coords so the server
 * can re-validate (the API stores the raw coordinates on the punch).
 */
export async function checkedPosition(site: SiteCheck): Promise<GeolocationPosition> {
  const pos = await getDevicePosition();
  const d = distanceMeters(pos.coords.latitude, pos.coords.longitude, site.latitude, site.longitude);
  if (d > site.radiusMeters) {
    throw new Error(
      `You are ${Math.round(d)}m from ${site.siteName || 'the site'} (allowed radius: ${site.radiusMeters}m). Clock-in is restricted to the site location.`,
    );
  }
  return pos;
}

export function formatCoords(pos: GeolocationPosition): string {
  return `${pos.coords.latitude.toFixed(6)},${pos.coords.longitude.toFixed(6)}`;
}
