"use client";

// app/admin/settings/AdminSettingsClient.tsx
// Admin settings page — hotel configuration, staff management, integrations, etc.
// Placeholder: can be expanded with hotel name, contact info, email settings,
// notification preferences, system configuration, etc.

import { useRouter } from "next/navigation";

export default function AdminSettingsClient() {
  const router = useRouter();

  return (
    <div className="flex-1 flex flex-col">
      {/* Header */}
      <div className="h-20 border-b border-slate-200 px-8 flex items-center justify-between bg-white">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Admin Settings</h1>
          <p className="text-sm text-slate-500 mt-0.5">Hotel configuration and system settings</p>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto bg-slate-50 p-8">
        <div className="max-w-4xl mx-auto">
          
          {/* Welcome card */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 mb-6">
            <h2 className="text-lg font-semibold text-slate-900 mb-2">Welcome to Admin Settings</h2>
            <p className="text-slate-600">
              This is the admin control center for Hotel Albatross. Configure hotel settings, manage staff, 
              and adjust system preferences from here.
            </p>
          </div>

          {/* Settings sections (placeholder grid) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            
            {/* Hotel Information */}
            <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center text-blue-600">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
                    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                    <polyline points="9 22 9 12 15 12 15 22" />
                  </svg>
                </div>
                <h3 className="font-semibold text-slate-900">Hotel Information</h3>
              </div>
              <p className="text-sm text-slate-600 mb-4">Name, address, contact details, and branding</p>
              <button className="text-sm font-medium text-blue-600 hover:text-blue-700">Configure →</button>
            </div>

            {/* Staff Management */}
            <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-lg bg-amber-100 flex items-center justify-center text-amber-600">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                </div>
                <h3 className="font-semibold text-slate-900">Staff & Roles</h3>
              </div>
              <p className="text-sm text-slate-600 mb-4">Manage team members, roles, and permissions</p>
              <button className="text-sm font-medium text-blue-600 hover:text-blue-700">Configure →</button>
            </div>

            {/* Room Management */}
            <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-lg bg-green-100 flex items-center justify-center text-green-600">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
                    <path d="M2 20V9a2 2 0 012-2h16a2 2 0 012 2v11" />
                    <path d="M2 20h20" />
                    <path d="M12 7V4" />
                    <path d="M9 20v-5h6v5" />
                  </svg>
                </div>
                <h3 className="font-semibold text-slate-900">Room Categories</h3>
              </div>
              <p className="text-sm text-slate-600 mb-4">Add or edit room types and pricing</p>
              <button className="text-sm font-medium text-blue-600 hover:text-blue-700">Configure →</button>
            </div>

            {/* Email & Notifications */}
            <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-lg bg-purple-100 flex items-center justify-center text-purple-600">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
                    <rect x="2" y="4" width="20" height="16" rx="2" />
                    <path d="m22 7-10 5L2 7" />
                  </svg>
                </div>
                <h3 className="font-semibold text-slate-900">Email & Notifications</h3>
              </div>
              <p className="text-sm text-slate-600 mb-4">Configure email settings and alerts</p>
              <button className="text-sm font-medium text-blue-600 hover:text-blue-700">Configure →</button>
            </div>

            {/* System Backup */}
            <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-lg bg-red-100 flex items-center justify-center text-red-600">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </div>
                <h3 className="font-semibold text-slate-900">System Backup</h3>
              </div>
              <p className="text-sm text-slate-600 mb-4">Backup and restore hotel data</p>
              <button className="text-sm font-medium text-blue-600 hover:text-blue-700">Configure →</button>
            </div>

            {/* Audit Log */}
            <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center text-slate-600">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z" />
                  </svg>
                </div>
                <h3 className="font-semibold text-slate-900">Audit Log</h3>
              </div>
              <p className="text-sm text-slate-600 mb-4">View system activity and changes</p>
              <button className="text-sm font-medium text-blue-600 hover:text-blue-700">View →</button>
            </div>
          </div>

          {/* Tip section */}
          <div className="mt-8 bg-amber-50 border border-amber-200 rounded-lg p-4">
            <p className="text-sm text-amber-900">
              💡 <strong>Tip:</strong> Changes made here affect the entire system. Ensure you have proper backups before making critical changes.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
