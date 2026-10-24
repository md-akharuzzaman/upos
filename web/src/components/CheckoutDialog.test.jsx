import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import CheckoutDialog from './CheckoutDialog.jsx';

describe('<CheckoutDialog>', () => {
  it('cash: shows change and sends tendered cents', async () => {
    const onComplete = vi.fn();
    render(<CheckoutDialog totalCents={849} currency="CAD" onCancel={vi.fn()} onComplete={onComplete} />);
    const btn = screen.getByRole('button', { name: /complete sale/i });
    expect(btn).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/cash received/i), '5');
    expect(screen.getByText(/short by \$3\.49/i)).toBeInTheDocument();
    expect(btn).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '$10.00' }));
    expect(screen.getByText(/change due \$1\.51/i)).toBeInTheDocument();
    await userEvent.click(btn);
    expect(onComplete).toHaveBeenCalledWith({ method: 'cash', tenderedCents: 1000 });
  });

  it('card: needs a terminal approval code, never a card number', async () => {
    const onComplete = vi.fn();
    render(<CheckoutDialog totalCents={849} currency="CAD" onCancel={vi.fn()} onComplete={onComplete} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Card' }));
    const btn = screen.getByRole('button', { name: /complete sale/i });
    await userEvent.type(screen.getByLabelText(/approval code/i), '4111 1111');
    expect(btn).toBeDisabled();
    await userEvent.clear(screen.getByLabelText(/approval code/i));
    await userEvent.type(screen.getByLabelText(/approval code/i), 'AUTH-7731');
    await userEvent.click(btn);
    expect(onComplete).toHaveBeenCalledWith({ method: 'card', reference: 'AUTH-7731' });
  });

  it('shows server errors', () => {
    render(<CheckoutDialog totalCents={100} currency="CAD" onCancel={vi.fn()} onComplete={vi.fn()} error="not enough stock for COF-001" />);
    expect(screen.getByRole('alert')).toHaveTextContent('not enough stock');
  });
});
