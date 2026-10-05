'use client';

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { Bell, CheckCheck, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api-client';
import {
  useNotificationsQuery,
  useUnreadCountQuery,
  notificationKeys,
} from '../../lib/queries';

interface Notification {
  id: string;
  title: string;
  message: string;
  isRead: boolean;
  linkUrl?: string;
  createdAt: string;
}

/**
 * Notification bell: dropdown, unread count, bulk mark-all-read.
 *
 * Uses dedicated bulk & count endpoints:
 * - GET /notifications/unread-count for badge count
 * - GET /notifications for items on open
 * - POST /notifications/mark-all-read for bulk mark-all-read
 * - PATCH /notifications/:id/read for single item
 */
export const NotificationBell: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const queryClient = useQueryClient();
  const { data: countData } = useUnreadCountQuery();
  const {
    data: notifData,
    isPending: loading,
    error: notifError,
  } = useNotificationsQuery(open);

  const notifications: Notification[] = notifData
    ? Array.isArray(notifData)
      ? notifData
      : notifData?.items || []
    : [];

  const unreadCount = notifData
    ? notifications.filter((n) => !n.isRead).length
    : (countData?.unreadCount ?? 0);

  const error = notifError
    ? (notifError as Error).message || 'Could not load notifications.'
    : actionError;

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

  const markOneRead = async (id: string) => {
    try {
      await api.patch(`/notifications/${id}/read`, {});
      await queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    } catch {
      // Keep the item unread on failure — the count must stay truthful.
    }
  };

  const markAllRead = async () => {
    if (unreadCount === 0) return;
    setMarkingAll(true);
    setActionError(null);
    try {
      // Use the API's bulk mark-all-read endpoint
      await api.post('/notifications/mark-all-read', {});
      await queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    } catch (err: any) {
      setActionError(err?.message || 'Could not mark notifications as read.');
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
