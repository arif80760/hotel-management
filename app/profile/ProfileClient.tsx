"use client";

// app/profile/ProfileClient.tsx
// Staff Self Profile page — SIMPLIFIED VERSION with better loading states

import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";

export default function ProfileClient() {
  const { user, profile } = useAuth();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Simulate a brief loading time to let auth context settle
    const timer = setTimeout(() => {
      setLoading(false);
    }, 500);
    return () => clearTimeout(timer);
  }, []);

  // Still loading
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-slate-50">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-amber-500 mb-4"></div>
          <p className="text-slate-600">Loading your profile...</p>
        </div>
      </div>
    );
  }

  // Not logged in
  if (!user) {
    return (
      <div className="flex-1 flex items-center justify-center bg-slate-50 p-6">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 max-w-md text-center">
          <h2 className="text-lg font-semibold text-slate-900 mb-2">Not logged in</h2>
          <p className="text-slate-600">Please log in to view your profile.</p>
        </div>
      </div>
    );
  }

  // Not linked to employee record
  if (!profile) {
    return (
      <div className="flex-1 flex items-center justify-center bg-slate-50 p-6">
        <div className="bg-amber-50 border border-amber-200 rounded-xl shadow-sm p-8 max-w-md">
          <div className="flex items-start gap-4">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-6 h-6 text-amber-600 flex-shrink-0 mt-1">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <div>
              <h2 className="text-lg font-semibold text-amber-900 mb-2">Profile not linked yet</h2>
              <p className="text-amber-800 text-sm">
                Your login account hasn&apos;t been linked to an employee record. Please ask an admin to add or link your account in the{" "}
                <span className="font-medium">Employee Management</span> section.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Profile loaded — show the form
  return (
    <div className="flex-1 flex flex-col overflow-hidden">

      {/* Header */}
      <div className="h-20 border-b border-slate-200 px-8 flex items-center justify-between bg-white flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">My Profile</h1>
          <p className="text-sm text-slate-500 mt-0.5">View your employee information and personal details</p>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto bg-slate-50 p-8">
        <div className="max-w-2xl mx-auto space-y-6">

          {/* Basic Info Card */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">Employee Information</h2>
            <div className="grid grid-cols-2 gap-6">
              <div>
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Full Name</p>
                <p className="text-sm text-slate-900 font-medium">{profile.full_name}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Role</p>
                <p className="text-sm text-slate-900 font-medium capitalize">{profile.role}</p>
              </div>
            </div>
          </div>

          {/* Personal Details Card */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">Personal Details</h2>
            <p className="text-sm text-slate-600">
              Your profile page is under construction. More features coming soon.
            </p>
          </div>

          {/* Info Banner */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <p className="text-sm text-blue-900">
              ℹ️ To edit your personal information, please contact your administrator.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
