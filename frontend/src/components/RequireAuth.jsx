import { useState, useEffect } from 'react';
import { Outlet, Navigate } from 'react-router-dom';

export default function RequireAuth() {
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then((res) => {
        setStatus(res.ok ? 'authenticated' : 'unauthenticated');
      })
      .catch(() => {
        setStatus('unauthenticated');
      });
  }, []);

  if (status === 'loading') return null;
  if (status === 'unauthenticated') return <Navigate to="/login" replace />;
  return <Outlet />;
}
