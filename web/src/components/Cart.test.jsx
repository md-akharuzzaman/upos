import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import Cart from './Cart.jsx';

const coffee = { id: 'c', name: 'Coffee', priceCents: 245, taxRateBp: 1300, stock: 3 };
const muffin = { id: 'm', name: 'Muffin', priceCents: 295, taxRateBp: 0, stock: 9 };

describe('<Cart>', () => {
  it('shows an empty state and disables Charge', () => {
    render(<Cart lines={[]} currency="CAD" onQty={vi.fn()} onRemove={vi.fn()} onClear={vi.fn()} onCheckout={vi.fn()} />);
    expect(screen.getByText(/tap a product/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /charge/i })).toBeDisabled();
  });

  it('shows subtotal, tax and total and lets the cashier change quantities', async () => {
    const onQty = vi.fn();
    const onRemove = vi.fn();
    const onCheckout = vi.fn();
    render(
      <Cart
        lines={[{ product: coffee, qty: 2 }, { product: muffin, qty: 1 }]}
        currency="CAD"
        onQty={onQty}
        onRemove={onRemove}
        onClear={vi.fn()}
        onCheckout={onCheckout}
      />,
    );
    expect(screen.getByTestId('cart-total')).toHaveTextContent('$8.49');
    await userEvent.click(screen.getByRole('button', { name: 'Increase Coffee' }));
    expect(onQty).toHaveBeenCalledWith('c', 3);
    await userEvent.click(screen.getByRole('button', { name: 'Decrease Muffin' }));
    expect(onRemove).toHaveBeenCalledWith('m');
    await userEvent.click(screen.getByRole('button', { name: /charge \$8\.49/i }));
    expect(onCheckout).toHaveBeenCalled();
  });

  it('does not allow more than the stock on hand', () => {
    render(<Cart lines={[{ product: coffee, qty: 3 }]} currency="CAD" onQty={vi.fn()} onRemove={vi.fn()} onClear={vi.fn()} onCheckout={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Increase Coffee' })).toBeDisabled();
  });
});
