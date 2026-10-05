'use client';

import React, { useState } from 'react';
import { UserCircle2, Download, ShieldCheck, RefreshCw, Bell, BellOff } from 'lucide-react';
import { DashboardLayout } from '../../../components/layout/dashboard-layout';
import { api } from '../../../lib/api-client';
import { useAuth } from '../../../context/auth-context';
import { usePushSubscription } from '../../../lib/pwa';
import '../../../styles/profile.css';

export default function ProfilePage() {
  const { user } = useAuth();
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  // Go-live Phase 2 item 9: surface the existing push-subscription hook so
  // web-push is actually reachable from the UI.
  const { status: pushStatus, error: pushError, subscribe: subscribePush } = usePushSubscription();

  const handleDsarDownload = async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      // ASSUMPTION: GET /gdpr/export (DSAR) returns the employee's personal data
      // as a downloadable file. The filename comes from Content-Disposition when
      // the API sets it; otherwise we fall back to a sensible name.
      await api.downloadFile('/gdpr/export', `ems-personal-data-${user?.email || 'export'}.json`);
    } catch (err: any) {
      setDownloadError(err?.message || 'Failed to download your data.');
    } finally {
      setDownloading(false);
    }
  };

  const displayName =
    `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || user?.email || 'Signed in';

  return (
    <DashboardLayout title="My Profile">
      <div className="profile-page">
        <header className="profile-header">
          <div className="profile-identity">
            <div className="profile-avatar">
              {user?.avatarUrl ? (
                <img src={user.avatarUrl} alt={displayName} />
              ) : (
                <UserCircle2 className="w-10 h-10" />
              )}
            </div>
            <div>
              <h1 className="profile-title">{displayName}</h1>
              <p className="profile-subtitle">{user?.email || '—'}</p>
            </div>
          </div>
        </header>

        <div className="profile-grid">
          {/* Account details */}
          <div className="profile-card">
            <h2 className="profile-card-title">Account Details</h2>
            <dl className="profile-dl">
              <div>
                <dt>Full name</dt>
                <dd>{`${user?.firstName || ''} ${user?.lastName || ''}`.trim() || '—'}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{user?.email || '—'}</dd>
              </div>
              <div>
                <dt>Employee ID</dt>
                <dd>{user?.employeeId || '—'}</dd>
              </div>
              <div>
                <dt>Roles</dt>
                <dd>{user?.roles?.join(', ') || '—'}</dd>
              </div>
            </dl>
          </div>

          {/* Push notifications (go-live Phase 2 item 9) */}
          <div className="profile-card">
            <h2 className="profile-card-title">
              {pushStatus === 'subscribed' ? (
                <Bell className="w-4 h-4" />
              ) : (
                <BellOff className="w-4 h-4" />
              )}
              Notifications
            </h2>
            <p className="profile-card-text">
              Enable browser push notifications for leave decisions, payroll
              updates, and policy documents.
            </p>
            {pushError && (
              <div role="alert" className="profile-error">
                {pushError}
              </div>
            )}
            <div
              role="group"
              aria-label="Push notification preference"
              style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '12px' }}
            >
              <button
                type="button"
                role="switch"
                aria-checked={pushStatus === 'subscribed'}
                aria-label="Enable push notifications"
                disabled={pushStatus === 'subscribing' || pushStatus === 'subscribed'}
                onClick={() => void subscribePush()}
                className="profile-btn-primary"
              >
                {pushStatus === 'subscribing' ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Enabling…</span>
                  </>
                ) : pushStatus === 'subscribed' ? (
                  <>
                    <Bell className="w-4 h-4" />
                    <span>Notifications enabled</span>
                  </>
                ) : (
                  <>
                    <Bell className="w-4 h-4" />
                    <span>Enable notifications</span>
                  </>
                )}
              </button>
              {pushStatus === 'denied' && (
                <span className="profile-card-text" style={{ fontSize: '12px' }}>
                  Browser permission was denied — re-enable it in your browser
                  site settings.
                </span>
              )}
            </div>
          </div>

          {/* Data rights (GDPR DSAR) */}
          <div className="profile-card">
            <h2 className="profile-card-title">
              <ShieldCheck className="w-4 h-4" />
              Your Data
            </h2>
            <p className="profile-card-text">
              You have the right to receive a copy of the personal data this system holds about
              you. Downloading generates a machine-readable export from the API.
            </p>
            {downloadError && (
              <div role="alert" className="profile-error">
                {downloadError}
              </div>
            )}
            <button
              onClick={handleDsarDownload}
              disabled={downloading}
              className="profile-btn-primary"
            >
              {downloading ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Preparing download...</span>
                </>
              ) : (
                <>
                  <Download className="w-4 h-4" />
                  <span>Download my data</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
