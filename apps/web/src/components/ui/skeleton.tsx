'use client';

import React from 'react';

/**
 * Skeleton shimmer primitives (go-live hardening, Phase 3 item 7).
 *
 * Replaces the most prominent full-page spinners (dashboard KPIs, employees
 * directory, leaves, documents) with content-shaped shimmer placeholders so
 * layout does not jump when data arrives. All blocks are `aria-hidden` — the
 * loading state itself is announced once via the `aria-live` region on the
 * surrounding page, so screen readers are not spammed per shimmer block.
 */

interface SkeletonProps {
  className?: string;
  style?: React.CSSProperties;
  /** Accessible label for the single announced loading region (rarely needed). */
  label?: string;
}

export function Skeleton({ className = '', style, label }: SkeletonProps) {
  return (
    <span
      className={`ems-skeleton ${className}`}
      style={style}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      data-testid="skeleton"
    />
  );
}

/** One shimmer line, e.g. a table cell or a card title. */
export function SkeletonText({
  width = '100%',
  className = '',
}: {
  width?: string | number;
  className?: string;
}) {
  return (
    <Skeleton
      className={`ems-skeleton-text ${className}`}
      style={{ width: typeof width === 'number' ? `${width}px` : width }}
    />
  );
}

/** Shimmer approximation of a KPI / stat card. */
export function SkeletonStatCard() {
  return (
    <div className="ems-skeleton-card" aria-hidden="true" data-testid="skeleton-stat-card">
      <SkeletonText width="45%" />
      <Skeleton className="ems-skeleton-value" />
      <SkeletonText width="70%" />
    </div>
  );
}

/**
 * Shimmer table: header row + `rows` body rows of `columns` cells.
 * Used by employees, leaves, and documents while their queries are pending.
 */
export function SkeletonTable({
  rows = 6,
  columns = 5,
  labelledBy,
}: {
  rows?: number;
  columns?: number;
  labelledBy?: string;
}) {
  return (
    <div
      className="ems-skeleton-table"
      role="presentation"
      aria-hidden="true"
      aria-labelledby={labelledBy}
      data-testid="skeleton-table"
    >
      <div className="ems-skeleton-table-head">
        {Array.from({ length: columns }).map((_, c) => (
          <SkeletonText key={c} width={`${55 + ((c * 37) % 35)}%`} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="ems-skeleton-table-row">
          {Array.from({ length: columns }).map((_, c) => (
            <SkeletonText key={c} width={`${60 + ((r * 13 + c * 29) % 35)}%`} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Shimmer grid of cards (employees directory card view). */
export function SkeletonCardGrid({ cards = 6 }: { cards?: number }) {
  return (
    <div className="ems-skeleton-card-grid" aria-hidden="true" data-testid="skeleton-card-grid">
      {Array.from({ length: cards }).map((_, i) => (
        <div key={i} className="ems-skeleton-card ems-skeleton-card-tall">
          <div className="ems-skeleton-card-head">
            <Skeleton className="ems-skeleton-avatar" />
            <SkeletonText width="30%" />
          </div>
          <SkeletonText width="60%" />
          <SkeletonText width="40%" />
          <SkeletonText width="80%" />
        </div>
      ))}
    </div>
  );
}
