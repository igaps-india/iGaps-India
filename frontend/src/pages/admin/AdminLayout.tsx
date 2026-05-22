import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import AdminLoginPage from './AdminLoginPage';

export default function AdminLayout() {
  const [token, setToken] = useState<string>(
    localStorage.getItem('igaps_admin_token') ?? ''
  );

  if (!token) {
    return <AdminLoginPage onLogin={setToken} />;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Admin nav */}
      <nav className="bg-white border-b border-gray-100 px-6 h-14 flex items-center justify-between">
        <span className="font-bold text-indigo-700">iGaps Admin</span>
        <button
          onClick={() => {
            localStorage.removeItem('igaps_admin_token');
            setToken('');
          }}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          Sign out
        </button>
      </nav>
      <Outlet />
    </div>
  );
}
