import { useState, useEffect } from 'react';
import { Outlet, Navigate } from 'react-router-dom';

export default function RequireSetup() {
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    fetch('/api/setup/status', { credentials: 'same-origin' })
      .then((res) => res.json())
      .then((data) => {
        setStatus(data.complete ? 'complete' : 'incomplete');
      })
      .catch(() => {
        setStatus('incomplete');
      });
  }, []);

  if (status === 'loading') return null;
  if (status === 'incomplete') return <Navigate to="/setup" replace />;
  return <Outlet />;
}
