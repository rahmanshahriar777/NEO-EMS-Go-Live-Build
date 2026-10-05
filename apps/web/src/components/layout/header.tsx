'use client';

import React, { useState, useEffect } from 'react';
import { Clock, Camera } from 'lucide-react';
import { useAuth } from '../../context/auth-context';
import { api } from '../../lib/api-client';
import { formatAppTime, timezoneLabel } from '../../lib/date-utils';
import { AvatarModal } from '../profile/avatar-modal';
import { NotificationBell } from '../notifications/notification-bell';

export const Header: React.FC<{ title?: string }> = ({ title }) => {
  const { user } = useAuth();
  const [clocking, setClocking] = useState(false);
  const [clockMessage, setClockMessage] = useState<string | null>(null);
  const [localTime, setLocalTime] = useState<string>('');
  const [isAvatarModalOpen, setIsAvatarModalOpen] = useState(false);

  useEffect(() => {
    const updateTime = () => setLocalTime(formatAppTime(new Date()));
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleQuickClockIn = async () => {
    setClocking(true);
    try {
      await api.post('/attendance/clock-in', { notes: 'Quick clock in from header' });
      setClockMessage('Clocked in!');
      setTimeout(() => setClockMessage(null), 3000);
    } catch (err: any) {
      setClockMessage(err.message || 'Already clocked in');
      setTimeout(() => setClockMessage(null), 3000);
    } finally {
      setClocking(false);
    }
  };

  return (
    <>
      <header className="h-16 border-b border-[#e2dfda] px-6 flex items-center justify-between bg-white/95 backdrop-blur-md shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold text-[#1a1816]">{title || 'Overview'}</h1>
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-[#e8f0ec] border border-[#d4e3da] text-[#2c5f4a] text-[11px] font-medium font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-[#2c7a4e] animate-pulse" />
            Live Platform
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Live clock in the configured timezone (env: NEXT_PUBLIC_TIMEZONE) */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-[#faf9f7] border border-[#e2dfda] text-xs font-mono text-[#1a1816] shadow-xs">
            <Clock className="w-3.5 h-3.5 text-[#2c5f4a] animate-spin-slow" />
            <span className="font-bold">{localTime || '--:--:--'}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#e8f0ec] text-[#2c5f4a] font-mono font-semibold">
              {timezoneLabel()}
            </span>
          </div>

          {/* Quick Clock in action */}
          {user?.employeeId && (
            <button
              onClick={handleQuickClockIn}
              disabled={clocking}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-[#e8f0ec] hover:bg-[#d4e3da] text-[#2c5f4a] border border-[#d4e3da] text-xs font-medium transition shadow-xs"
            >
              <Clock className="w-3.5 h-3.5 text-[#2c5f4a]" />
              <span>{clockMessage || (clocking ? 'Clocking...' : 'Quick Clock In')}</span>
            </button>
          )}

          {/* Notification Bell (Phase 2 item 2) */}
          <NotificationBell />

          {/* Active Role Pill */}
          <div className="px-2.5 py-1 rounded-lg bg-[#faf9f7] border border-[#e2dfda] text-[#6b6560] text-xs font-mono font-medium">
            {user?.roles?.[0] || 'EMPLOYEE'}
          </div>

          {/* Employee Avatar & Photo Settings Button */}
          <button
            type="button"
            onClick={() => setIsAvatarModalOpen(true)}
            title="Change your profile picture"
            className="group relative flex items-center gap-2 pl-1 pr-2.5 py-1 rounded-full bg-[#faf9f7] hover:bg-[#e8f0ec] border border-[#e2dfda] hover:border-[#2c5f4a] transition shadow-2xs"
          >
            {user?.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt="Your Avatar"
                className="w-7 h-7 rounded-full object-cover border border-[#e2dfda] group-hover:border-[#2c5f4a] shadow-xs"
              />
            ) : (
              <div className="w-7 h-7 rounded-full bg-[#e8f0ec] text-[#2c5f4a] border border-[#d4e3da] flex items-center justify-center text-xs font-bold font-mono shadow-xs">
                {user?.firstName?.[0] || 'U'}
              </div>
            )}
            <span className="text-xs font-semibold text-[#1a1816] group-hover:text-[#2c5f4a]">
              {user?.firstName || 'Profile'}
            </span>
            <span className="w-4 h-4 rounded-full bg-[#f0eeea] group-hover:bg-[#2c5f4a] text-[#6b6560] group-hover:text-white flex items-center justify-center transition">
              <Camera className="w-2.5 h-2.5" />
            </span>
          </button>
        </div>
      </header>

      {/* Avatar Settings Modal */}
      <AvatarModal
        isOpen={isAvatarModalOpen}
        onClose={() => setIsAvatarModalOpen(false)}
      />
    </>
  );
};
