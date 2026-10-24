import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Login from './Login.jsx';

const reply = (status, body) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('<Login>', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('signs in and hands the session to the app', async () => {
    const fetch = vi.fn(() => reply(200, { token: 't', user: { role: 'cashier' }, store: { name: 'Shop' } }));
    vi.stubGlobal('fetch', fetch);
    const onSignedIn = vi.fn();
    render(<Login onSignedIn={onSignedIn} environment="test" />);
    expect(screen.getByText(/TEST environment/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/store code/i), 'demo');
    await userEvent.type(screen.getByLabelText(/e-mail/i), 'cal@demo.test');
    await userEvent.type(screen.getByLabelText(/password/i), 'Password123');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(fetch).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ store: 'demo', email: 'cal@demo.test', password: 'Password123' });
    expect(onSignedIn).toHaveBeenCalledWith(expect.objectContaining({ token: 't' }));
  });

  it('shows the API error on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(() => reply(401, { error: 'store code, e-mail or password is incorrect' })));
    render(<Login onSignedIn={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/store code/i), 'demo');
    await userEvent.type(screen.getByLabelText(/e-mail/i), 'x@demo.test');
    await userEvent.type(screen.getByLabelText(/password/i), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/incorrect/);
  });

  it('create-store mode asks for store and manager names', async () => {
    render(<Login onSignedIn={vi.fn()} />);
    await userEvent.click(screen.getByRole('tab', { name: /create a store/i }));
    expect(screen.getByLabelText(/store name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/your name/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create store' })).toBeInTheDocument();
  });
});
