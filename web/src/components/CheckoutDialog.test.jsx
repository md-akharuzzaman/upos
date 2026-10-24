import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import CheckoutDialog from './CheckoutDialog.jsx';

const ALL = { paymentMethods: ['cash', 'debit', 'credit', 'etransfer', 'stripe'], etransferEmail: 'pay@demo.test' };

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

  it('offers only the methods the store accepts (cash, debit, credit by default)', () => {
    const { unmount } = render(<CheckoutDialog totalCents={849} currency="CAD" onCancel={vi.fn()} onComplete={vi.fn()} />);
    expect(screen.getAllByRole('radio').map((b) => b.textContent)).toEqual(['Cash', 'Debit', 'Credit']);
    unmount();
    render(<CheckoutDialog totalCents={849} currency="CAD" profile={{ paymentMethods: ['debit', 'stripe'] }} onCancel={vi.fn()} onComplete={vi.fn()} />);
    expect(screen.getAllByRole('radio').map((b) => b.textContent)).toEqual(['Debit', 'Stripe']);
    expect(screen.getByRole('radio', { name: 'Debit' })).toHaveAttribute('aria-checked', 'true');
  });

  it('debit: needs a terminal approval code, never a card number', async () => {
    const onComplete = vi.fn();
    render(<CheckoutDialog totalCents={849} currency="CAD" onCancel={vi.fn()} onComplete={onComplete} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Debit' }));
    const btn = screen.getByRole('button', { name: /complete sale/i });
    await userEvent.type(screen.getByLabelText(/approval code/i), '4111 1111');
    expect(btn).toBeDisabled();
    await userEvent.clear(screen.getByLabelText(/approval code/i));
    await userEvent.type(screen.getByLabelText(/approval code/i), 'AUTH-7731');
    await userEvent.click(btn);
    expect(onComplete).toHaveBeenCalledWith({ method: 'debit', reference: 'AUTH-7731' });
  });

  it('credit: records the card brand when chosen', async () => {
    const onComplete = vi.fn();
    render(<CheckoutDialog totalCents={849} currency="CAD" onCancel={vi.fn()} onComplete={onComplete} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Credit' }));
    await userEvent.selectOptions(screen.getByLabelText(/card brand/i), 'visa');
    await userEvent.type(screen.getByLabelText(/approval code/i), 'CR-123');
    await userEvent.click(screen.getByRole('button', { name: /complete sale/i }));
    expect(onComplete).toHaveBeenCalledWith({ method: 'credit', reference: 'CR-123', brand: 'visa' });
  });

  it('e-Transfer: tells the customer where to send it, then takes the reference number', async () => {
    const onComplete = vi.fn();
    render(<CheckoutDialog totalCents={849} currency="CAD" profile={ALL} onCancel={vi.fn()} onComplete={onComplete} />);
    await userEvent.click(screen.getByRole('radio', { name: 'e-Transfer' }));
    expect(screen.getByTestId('etransfer-instructions')).toHaveTextContent('send $8.49 by Interac e-Transfer to pay@demo.test');
    await userEvent.type(screen.getByLabelText(/reference number/i), 'abc');
    expect(screen.getByRole('button', { name: /complete sale/i })).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/reference number/i), 'D3F9X');
    await userEvent.click(screen.getByRole('button', { name: /complete sale/i }));
    expect(onComplete).toHaveBeenCalledWith({ method: 'etransfer', reference: 'abcD3F9X' });
  });

  it('Stripe: takes the payment id from the Stripe dashboard', async () => {
    const onComplete = vi.fn();
    render(<CheckoutDialog totalCents={849} currency="CAD" profile={ALL} onCancel={vi.fn()} onComplete={onComplete} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Stripe' }));
    await userEvent.type(screen.getByLabelText(/stripe payment id/i), 'cus_12345678');
    expect(screen.getByRole('button', { name: /complete sale/i })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText(/stripe payment id/i));
    await userEvent.type(screen.getByLabelText(/stripe payment id/i), 'pi_3Q0abcDEF123');
    await userEvent.click(screen.getByRole('button', { name: /complete sale/i }));
    expect(onComplete).toHaveBeenCalledWith({ method: 'stripe', reference: 'pi_3Q0abcDEF123' });
  });

  it('shows server errors', () => {
    render(<CheckoutDialog totalCents={100} currency="CAD" onCancel={vi.fn()} onComplete={vi.fn()} error="not enough stock for COF-001" />);
    expect(screen.getByRole('alert')).toHaveTextContent('not enough stock');
  });
});
