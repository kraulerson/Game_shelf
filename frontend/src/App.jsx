import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import RequireAuth from './components/RequireAuth';
import RequireSetup from './components/RequireSetup';
import Nav from './components/Nav';
import Login from './pages/Login';
import Setup from './pages/Setup';
import Library from './pages/Library';
import GameDetail from './pages/GameDetail';
import Settings from './pages/Settings';
import XboxApproval from './pages/XboxApproval';

function AuthenticatedLayout() {
  return (
    <>
      <Nav />
      <Outlet />
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />

        <Route element={<RequireAuth />}>
          <Route path="/setup" element={<Setup />} />

          <Route element={<AuthenticatedLayout />}>
            <Route path="/settings" element={<Settings />} />
            <Route path="/settings/xbox/approve" element={<XboxApproval />} />

            <Route element={<RequireSetup />}>
              <Route path="/library" element={<Library />} />
              <Route path="/library/game/:id" element={<GameDetail />} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/library" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
