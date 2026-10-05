import React, { useRef, useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { useFocusTrap } from '../use-focus-trap';

function TestModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, { isActive: isOpen, onEscape: onClose });

  if (!isOpen) return null;

  return (
    <div ref={modalRef} role="dialog" aria-modal="true" data-testid="modal">
      <h2>Modal Title</h2>
      <button data-testid="first-btn">First</button>
      <input data-testid="middle-input" placeholder="Middle input" />
      <button data-testid="last-btn" onClick={onClose}>
        Last
      </button>
    </div>
  );
}

function TestHost() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button data-testid="open-btn" onClick={() => setOpen(true)}>
        Open Modal
      </button>
      <TestModal isOpen={open} onClose={() => setOpen(false)} />
    </div>
  );
}

describe('useFocusTrap', () => {
  it('focuses the first focusable element when opened', async () => {
    render(<TestHost />);
    const openBtn = screen.getByTestId('open-btn');
    fireEvent.click(openBtn);

    await vi.waitFor(() => {
      expect(screen.getByTestId('first-btn')).toHaveFocus();
    });
  });

  it('traps Tab key from last element back to first', async () => {
    render(<TestHost />);
    fireEvent.click(screen.getByTestId('open-btn'));

    const lastBtn = screen.getByTestId('last-btn');
    const firstBtn = screen.getByTestId('first-btn');

    lastBtn.focus();
    expect(lastBtn).toHaveFocus();

    fireEvent.keyDown(lastBtn, { key: 'Tab' });
    expect(firstBtn).toHaveFocus();
  });

  it('traps Shift+Tab key from first element back to last', async () => {
    render(<TestHost />);
    fireEvent.click(screen.getByTestId('open-btn'));

    const firstBtn = screen.getByTestId('first-btn');
    const lastBtn = screen.getByTestId('last-btn');

    firstBtn.focus();
    expect(firstBtn).toHaveFocus();

    fireEvent.keyDown(firstBtn, { key: 'Tab', shiftKey: true });
    expect(lastBtn).toHaveFocus();
  });

  it('dispatches onClose when Escape key is pressed', async () => {
    const handleClose = vi.fn();
    render(<TestModal isOpen={true} onClose={handleClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(handleClose).toHaveBeenCalledTimes(1);
  });
});
