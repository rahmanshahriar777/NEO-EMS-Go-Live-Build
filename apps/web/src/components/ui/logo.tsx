'use client';

import React from 'react';
import Image from 'next/image';

export interface LogoProps {
  variant?: 'full' | 'mark' | 'horizontal';
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'custom';
  className?: string;
  inverted?: boolean;
  priority?: boolean;
}

export const Logo: React.FC<LogoProps> = ({
  variant = 'full',
  size = 'md',
  className = '',
  inverted = false,
  priority = false,
}) => {
  // Dimension mappings keeping exact 960x364 (2.637:1) aspect ratio
  const sizeStyles = {
    sm: {
      full: 'h-7 w-auto',
      mark: 'w-7 h-7',
      horizontal: 'h-6 w-auto',
    },
    md: {
      full: 'h-9 w-auto',
      mark: 'w-9 h-9',
      horizontal: 'h-8 w-auto',
    },
    lg: {
      full: 'h-12 w-auto',
      mark: 'w-12 h-12',
      horizontal: 'h-10 w-auto',
    },
    xl: {
      full: 'h-16 w-auto',
      mark: 'w-16 h-16',
      horizontal: 'h-14 w-auto',
    },
    custom: {
      full: '',
      mark: '',
      horizontal: '',
    },
  };

  if (variant === 'mark') {
    return (
      <div
        className={`relative overflow-hidden rounded-xl bg-white shadow-sm flex items-center justify-center p-1 border border-slate-200/80 ${
          sizeStyles[size]?.mark || 'w-10 h-10'
        } ${className}`}
        title="Neoteric Digital"
      >
        <div className="relative w-full h-full overflow-hidden rounded-lg">
          <img
            src="/logo.png"
            alt="Neoteric Digital Icon"
            className="w-[260%] max-w-none h-full object-cover object-left"
            loading={priority ? 'eager' : 'lazy'}
          />
        </div>
      </div>
    );
  }

  // Full company logo
  return (
    <div
      className={`inline-flex items-center select-none ${
        inverted ? 'bg-white/95 rounded-xl px-2.5 py-1 shadow-sm border border-slate-200/50' : ''
      } ${className}`}
    >
      <img
        src="/logo.png"
        alt="Neoteric Digital"
        className={`object-contain ${sizeStyles[size]?.full || 'h-9 w-auto'} transition-all duration-200`}
        style={{ aspectRatio: '960 / 364' }}
        loading={priority ? 'eager' : 'lazy'}
      />
    </div>
  );
};
