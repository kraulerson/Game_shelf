import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import RequireAuth from './components/RequireAuth';
import RequireSetup from './components/RequireSetup';
import Login from './pages/Login';
import Library from './pages/Library';
import Settings from './pages/Settings';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />

        {/* Authenticated routes */}
        <Route element={<RequireAuth />}>
          <Route path="/setup" element={<div>Setup placeholder</div>} />
          <Route path="/settings" element={<Settings />} />

          {/* Authenticated + setup complete */}
          <Route element={<RequireSetup />}>
            <Route path="/library" element={<Library />} />
          </Route>
        </Route>

        {/* Default redirect */}
        <Route path="*" element={<Navigate to="/library" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
