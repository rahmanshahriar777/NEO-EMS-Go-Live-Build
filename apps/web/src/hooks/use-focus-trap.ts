'use client';

import { useEffect, useRef, RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled]):not([aria-hidden="true"])',
  'textarea:not([disabled]):not([aria-hidden="true"])',
  'input:not([disabled]):not([aria-hidden="true"]):not([type="hidden"])',
  'select:not([disabled]):not([aria-hidden="true"])',
  '[tabindex]:not([tabindex="-1"]):not([aria-hidden="true"])',
].join(', ');

export interface UseFocusTrapOptions {
  isActive?: boolean;
  onEscape?: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Traps keyboard focus within a modal dialog (WCAG 2.1 AA requirement).
 *
 * 1. Focuses the first focusable element (or initialFocusRef) when activated.
 * 2. Traps Tab and Shift+Tab within the container.
 * 3. Dispatches onEscape when the Escape key is pressed.
 * 4. Restores focus to the triggering element when the modal is closed.
 */
export function useFocusTrap<T extends HTMLElement = HTMLElement>(
  containerRef: RefObject<T | null>,
  options: UseFocusTrapOptions = {},
) {
  const { isActive = true, onEscape, initialFocusRef } = options;
  const previousActiveElement = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isActive) return;

    // Remember the element that had focus before the modal opened
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      previousActiveElement.current = document.activeElement;
    }

    const container = containerRef.current;
    if (!container) return;

    // Focus the initial element or the first focusable child
    const focusTimer = setTimeout(() => {
      if (!containerRef.current) return;
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus();
      } else {
        const focusable = containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
        if (focusable.length > 0) {
          focusable[0].focus();
        } else {
          containerRef.current.focus();
        }
      }
    }, 20);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onEscape) {
        e.preventDefault();
        e.stopPropagation();
        onEscape();
        return;
      }

      if (e.key !== 'Tab') return;

      const currentContainer = containerRef.current;
      if (!currentContainer) return;

      const focusableElements = Array.from(
        currentContainer.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => {
        if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
        }
        return true;
      });

      if (focusableElements.length === 0) {
        e.preventDefault();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeEl = document.activeElement;

      if (e.shiftKey) {
        if (activeEl === firstElement || !currentContainer.contains(activeEl)) {
          e.preventDefault();
          lastElement.focus();
        }
      } else {
        if (activeEl === lastElement || !currentContainer.contains(activeEl)) {
          e.preventDefault();
          firstElement.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      // Restore focus to original element
      if (previousActiveElement.current && typeof previousActiveElement.current.focus === 'function') {
        previousActiveElement.current.focus();
      }
    };
  }, [isActive, containerRef, initialFocusRef, onEscape]);
}
