'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { Bell, CheckCheck, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api-client';

interface Notification {
  id: string;
  title: string;
  message: string;
  isRead: boolean;
  linkUrl?: string;
  createdAt: string;
}

/**
 * Notification bell (Phase 2 item 2): dropdown, unread count, mark-all-read.
 *
 * API: GET /notifications, PATCH /notifications/:id/read.
 * Mark-all-read issues one PATCH per unread item (the API has no bulk
 * endpoint yet — reported as a mismatch) so the unread count is always the
 * server's truth, never a locally-forced zero.
 */
export const NotificationBell: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<Notification[] | { items: Notification[] }>('/notifications');
      setNotifications(Array.isArray(res) ? res : res?.items || []);
    } catch (err: any) {
      setError(err?.message || 'Could not load notifications.');
      setNotifications([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Unread count on mount (cheap, silent — failures just hide the dot).
    api
      .get<Notification[] | { items: Notification[] }>('/notifications')
      .then((res) => setNotifications(Array.isArray(res) ? res : res?.items || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (open) fetchNotifications();
  }, [open, fetchNotifications]);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEscape);
    };
  }, []);

  const unreadCount = notifications.filter((n) => !n.isRead).length;

  const markOneRead = async (id: string) => {
    try {
      await api.patch(`/notifications/${id}/read`, {});
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
    } catch {
      // Keep the item unread on failure — the count must stay truthful.
    }
  };

  const markAllRead = async () => {
    const unread = notifications.filter((n) => !n.isRead);
    if (unread.length === 0) return;
    setMarkingAll(true);
    setError(null);
    try {
      // No bulk endpoint on the API yet: settle each PATCH individually and
      // only flip the ones the server confirmed.
      const results = await Promise.allSettled(
        unread.map((n) => api.patch(`/notifications/${n.id}/read`, {})),
      );
      const confirmed = new Set(
        unread.filter((_, i) => results[i].status === 'fulfilled').map((n) => n.id),
      );
      setNotifications((prev) =>
        prev.map((n) => (confirmed.has(n.id) ? { ...n, isRead: true } : n)),
      );
      const failed = unread.length - confirmed.size;
      if (failed > 0) {
        setError(`${failed} notification${failed === 1 ? '' : 's'} could not be marked as read.`);
      }
    } finally {
      setMarkingAll(false);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        title="Notifications"
        aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="p-2 rounded-xl text-[#6b6560] hover:text-[#1a1816] hover:bg-[#faf9f7] border border-transparent hover:border-[#e2dfda] transition relative"
      >
        <Bell className="w-4 h-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-[#2c7a4e] text-white text-[10px] font-bold flex items-center justify-center">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-12 w-[360px] max-w-[90vw] bg-white border border-[#e2dfda] rounded-2xl shadow-xl z-50 overflow-hidden"
          role="dialog"
          aria-label="Notifications"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-[#f0eeea]">
            <span className="text-sm font-bold text-[#1a1816]">Notifications</span>
            <button
              onClick={markAllRead}
              disabled={markingAll || unreadCount === 0}
              className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#2c5f4a] hover:text-[#24493a] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {markingAll ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <CheckCheck className="w-3.5 h-3.5" />
              )}
              {markingAll ? 'Marking…' : 'Mark all read'}
            </button>
          </div>

          <div className="max-h-[380px] overflow-y-auto">
            {loading && (
              <div className="px-4 py-10 text-center text-xs text-slate-500">
                <RefreshCw className="w-4 h-4 animate-spin mx-auto mb-2" />
                Loading notifications…
              </div>
            )}
            {error && !loading && (
              <div className="px-4 py-6 text-center text-xs text-rose-600" role="alert">
                {error}
              </div>
            )}
            {!loading && !error && notifications.length === 0 && (
              <div className="px-4 py-10 text-center text-xs text-slate-400">
                No notifications yet.
              </div>
            )}
            {!loading &&
              notifications.map((n) => (
                <div
                  key={n.id}
                  className={`px-4 py-3 border-b border-[#f5f4f2] last:border-0 transition ${
                    n.isRead ? 'bg-white' : 'bg-[#f6f8f7]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-[13px] font-semibold text-[#1a1816] leading-snug">
                      {n.title}
                    </p>
                    {!n.isRead && (
                      <button
                        onClick={() => markOneRead(n.id)}
                        className="text-[10px] font-semibold text-[#2c5f4a] hover:underline shrink-0 mt-0.5"
                        title="Mark as read"
                      >
                        Mark read
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{n.message}</p>
                  <div className="flex items-center justify-between mt-1.5">
                    <span className="text-[10px] text-slate-400 font-mono">
                      {new Date(n.createdAt).toLocaleString()}
                    </span>
                    {n.linkUrl && (
                      <Link
                        href={n.linkUrl}
                        onClick={() => {
                          setOpen(false);
                          if (!n.isRead) markOneRead(n.id);
                        }}
                        className="text-[11px] font-semibold text-[#2c5f4a] hover:underline"
                      >
                        Open →
                      </Link>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
