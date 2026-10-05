'use client';

import React from 'react';
import { Logo } from './logo';

export interface LoadingScreenProps {
  message?: string;
  fullScreen?: boolean;
}

export const LoadingScreen: React.FC<LoadingScreenProps> = ({
  message = 'Loading workspace...',
  fullScreen = true,
}) => {
  return (
    <div
      className={`flex flex-col items-center justify-center bg-white ${
        fullScreen ? 'fixed inset-0 z-50' : 'w-full py-16'
      }`}
    >
      <div className="flex flex-col items-center space-y-5 max-w-sm px-6 text-center animate-fade-in">
        {/* Company Logo with subtle pulse */}
        <div className="p-3 rounded-2xl bg-slate-50 border border-slate-100 shadow-sm relative">
          <Logo size="lg" priority />
          <div className="absolute -inset-1 rounded-2xl bg-gradient-to-r from-primary-500/20 to-cyan-500/20 -z-10 blur-sm animate-pulse" />
        </div>

        {/* Loading status */}
        <div className="space-y-2 w-full">
          <div className="h-1.5 w-48 mx-auto bg-slate-100 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-primary-600 to-cyan-500 rounded-full animate-progress" />
          </div>
          <p className="text-xs font-medium text-slate-500">{message}</p>
        </div>
      </div>
    </div>
  );
};
