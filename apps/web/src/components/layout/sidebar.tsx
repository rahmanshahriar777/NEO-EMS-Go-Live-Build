'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Users,
  Building2,
  Clock,
  Calendar,
  CalendarDays,
  Banknote,
  TrendingUp,
  Sparkles,
  ShieldCheck,
  LogOut,
  UserCircle2,
  ClipboardList,
  FileText,
  KeyRound,
  MonitorSmartphone,
  UserCog
} from 'lucide-react';
import { useAuth } from '../../context/auth-context';
import { SystemRole } from '@ems/shared';
import { AvatarModal } from '../profile/avatar-modal';
import '../../styles/sidebar.css';

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
  isLive?: boolean;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

export const Sidebar: React.FC = () => {
  const pathname = usePathname();
  const { user, logout, hasRole } = useAuth();
  const [isAvatarModalOpen, setIsAvatarModalOpen] = useState(false);

  const navSections: NavSection[] = [
    {
      title: 'Overview',
      items: [
        { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
        { label: 'My Profile', href: '/profile', icon: UserCircle2 }
      ]
    },
    {
      title: 'People & Org',
      // NOTE: sidebar badges were removed — hardcoded values ("4", "4.85 ★",
      // "SOC2", "LIVE") are fabricated metrics, not live data. Badges return
      // only if computed from real API responses.
      items: [
        { label: 'Employees', href: '/employees', icon: Users },
        { label: 'Departments', href: '/organization/departments', icon: Building2 },
        { label: 'Calendar', href: '/calendar', icon: Calendar },
        { label: 'Attendance', href: '/attendance', icon: Clock },
        { label: 'Leaves', href: '/leaves', icon: CalendarDays },
        { label: 'Payroll', href: '/payroll', icon: Banknote },
        { label: 'Performance', href: '/performance', icon: TrendingUp },
        { label: 'Documents', href: '/documents', icon: FileText },
      ]
    }
  ];

  // Account security (everyone)
  navSections.push({
    title: 'Security',
    items: [
      { label: 'Two-Factor Auth', href: '/security/mfa', icon: KeyRound },
      { label: 'Active Sessions', href: '/security/sessions', icon: MonitorSmartphone },
    ],
  });

  // User & role administration
  if (hasRole(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)) {
    navSections.push({
      title: 'Administration',
      items: [
        { label: 'Users', href: '/admin/users', icon: UserCog },
        { label: 'Roles & Permissions', href: '/admin/roles', icon: ShieldCheck },
      ],
    });
  }

  // Rostering for managers and HR admins only
  if (hasRole(SystemRole.MANAGER, SystemRole.HR_ADMIN, SystemRole.SUPER_ADMIN)) {
    navSections[1].items.push({ label: 'Rostering', href: '/rostering', icon: ClipboardList });
  }

  // Compliance section for authorized roles
  if (hasRole(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN, SystemRole.AUDITOR)) {
    navSections.push({
      title: 'Compliance & Audit',
      items: [
        { label: 'Audit Trail', href: '/admin/audit-logs', icon: ShieldCheck }
      ]
    });
  }

  // AI Suite section
  navSections.push({
    title: 'Intelligence',
    items: [
      { label: 'AI Assistant', href: '/ai-assistant', icon: Sparkles }
    ]
  });

  const isItemActive = (href: string) => {
    if (href === '/dashboard') {
      return pathname === '/dashboard';
    }
    if (href === '/admin/audit-logs') {
      return pathname.includes('audit-logs');
    }
    return pathname === href || pathname.startsWith(href);
  };

  const userInitials = user?.firstName
    ? `${user.firstName.charAt(0)}${user.lastName ? user.lastName.charAt(0) : ''}`
    : '—';

  return (
    <aside className="sidebar-editorial">
      {/* Brand Header */}
      <Link href="/dashboard" className="sidebar-brand">
        <div className="sidebar-brand-left">
          <div className="sidebar-brand-mark">N</div>
          <div>
            <div className="sidebar-brand-title">Neoteric</div>
            <div className="sidebar-brand-sub">
              <span className="sidebar-brand-label">Digital</span>
              <span className="sidebar-brand-dot"></span>
              <span className="sidebar-brand-type">EMS</span>
            </div>
          </div>
        </div>

        <span className="sidebar-system-badge">
          v1.0
        </span>
      </Link>

      {/* Navigation Scroll Area */}
      <nav className="sidebar-nav-container">
        {navSections.map((section) => (
          <div key={section.title} className="sidebar-section">
            <div className="sidebar-section-label">{section.title}</div>
            {section.items.map((item) => {
              const active = isItemActive(item.href);
              const Icon = item.icon;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`sidebar-link ${active ? 'active' : ''}`}
                >
                  <Icon className="sidebar-icon" />
                  <span>{item.label}</span>

                  {item.badge && (
                    <span className={`sidebar-badge ${item.isLive ? 'live' : ''}`}>
                      {item.isLive && <span className="sidebar-badge-dot" />}
                      <span>{item.badge}</span>
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* User Footer Profile */}
      <div className="sidebar-footer">
        <div className="sidebar-user-card">
          <button
            type="button"
            onClick={() => setIsAvatarModalOpen(true)}
            title="Click to change your profile picture"
            className="sidebar-user-info-btn"
          >
            <div className="sidebar-avatar">
              {user?.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt="Avatar"
                />
              ) : (
                <span>{userInitials}</span>
              )}
            </div>

            <div className="sidebar-user-details">
              <div className="sidebar-user-name">
                {user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email || 'Signed in' : '—'}
              </div>
              <div className="sidebar-user-role">
                <span>{user?.roles?.[0] || '—'}</span>
              </div>
            </div>
          </button>

          <button
            onClick={() => logout()}
            title="Sign Out"
            className="sidebar-logout-btn"
          >
            <LogOut size={15} />
          </button>
        </div>
      </div>

      <AvatarModal
        isOpen={isAvatarModalOpen}
        onClose={() => setIsAvatarModalOpen(false)}
      />
    </aside>
  );
};
