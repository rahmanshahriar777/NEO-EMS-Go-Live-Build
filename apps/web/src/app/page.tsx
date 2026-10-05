'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  Sparkles,
  Clock,
  Banknote,
  ShieldCheck,
  ArrowRight,
  CheckCircle2,
  Lock,
  TrendingUp,
  Building2,
  Layers,
  Fingerprint,
  ChevronRight
} from 'lucide-react';
import { useAuth } from '../context/auth-context';
import { formatAppTime, timezoneLabel } from '../lib/date-utils';
import '../styles/landing.css';

export default function HomePage() {
  const { user } = useAuth();
  const [localTime, setLocalTime] = useState<string>(timezoneLabel());

  useEffect(() => {
    const updateTime = () => {
      setLocalTime(`${formatAppTime()} • ${timezoneLabel()}`);
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  const scrollToSection = (id: string) => {
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <div className="landing-editorial-root">
      {/* Navigation Header */}
      <header className="landing-nav">
        <Link href="/" className="landing-nav-brand">
          <div className="landing-brand-mark">N</div>
          <div>
            <div className="landing-brand-title">Neoteric Digital</div>
            <div className="landing-brand-sub">
              <span>Workforce Operating System</span>
              <span className="landing-brand-badge">EMS v1.0</span>
            </div>
          </div>
        </Link>

        <div className="landing-nav-links">
          <a href="#capabilities" className="landing-nav-link" onClick={(e) => { e.preventDefault(); scrollToSection('capabilities'); }}>
            Capabilities
          </a>
          <a href="#architecture" className="landing-nav-link" onClick={(e) => { e.preventDefault(); scrollToSection('architecture'); }}>
            Architecture
          </a>
          <Link href="/ai-assistant" className="landing-nav-link" style={{ color: 'var(--landing-accent)', fontWeight: 600 }}>
            AI Assistant
          </Link>
        </div>

        <div className="landing-nav-actions">
          <div className="landing-status-pill">
            <span className="landing-status-dot"></span>
            <span>{localTime}</span>
          </div>

          {user ? (
            <Link href="/dashboard" className="landing-btn-primary">
              <span>Go to Dashboard</span>
              <ArrowRight size={14} />
            </Link>
          ) : (
            <Link href="/login" className="landing-btn-secondary">
              <Lock size={13} style={{ color: 'var(--landing-accent)' }} />
              <span>Sign In</span>
            </Link>
          )}
        </div>
      </header>

      {/* Hero Section */}
      <section className="landing-hero">
        <div className="landing-hero-tag">
          <Sparkles size={13} />
          <span>Enterprise Workforce Operating System &bull; Neoteric Digital</span>
        </div>

        <h1 className="landing-hero-title">
          Intelligent Workforce Operations, <br />
          <em>Orchestrated with Elegance.</em>
        </h1>

        <p className="landing-hero-subtitle">
          A unified, production-grade enterprise platform engineered for high-performance organizations.
          Harmonizing organizational hierarchies, precision payroll, shift attendance, and compliance-grade AI intelligence.
        </p>

        <div className="landing-hero-ctas">
          <Link href="/login" className="landing-btn-hero-primary">
            <span>Sign In to Your Workspace</span>
            <ChevronRight size={16} />
          </Link>

          <Link href="/ai-assistant" className="landing-btn-hero-secondary">
            <Sparkles size={16} style={{ color: 'var(--landing-accent)' }} />
            <span>Open Executive AI Suite</span>
          </Link>
        </div>

        {/* Telemetry Trust Bar */}
        <div className="landing-trust-bar">
          <div className="landing-trust-item">
            <Layers size={16} />
            <span>6 Modular Systems</span>
          </div>
          <div className="landing-trust-item">
            <Fingerprint size={16} />
            <span>Tamper-Evident Audit Trail</span>
          </div>
          <div className="landing-trust-item">
            <Banknote size={16} />
            <span>Decimal-Safe Payroll</span>
          </div>
          <div className="landing-trust-item">
            <ShieldCheck size={16} />
            <span>Role-Based Access Control</span>
          </div>
        </div>
      </section>

      {/* Capabilities Grid */}
      <section className="landing-section" id="capabilities">
        <div className="landing-section-header">
          <span className="landing-section-tag">Core Enterprise Engine</span>
          <h2 className="landing-section-title">Engineered for Modern Enterprise Scale</h2>
          <p className="landing-section-desc">
            Every module built with strict architectural guardrails, transaction safety, and clean aesthetics.
          </p>
        </div>

        <div className="landing-caps-grid">
          {/* Card 1: Directory */}
          <div className="landing-cap-card">
            <div className="landing-cap-icon">
              <Building2 size={20} />
            </div>
            <h3 className="landing-cap-title">Organizational Hierarchy & Directory</h3>
            <p className="landing-cap-desc">
              Multi-tier department structures, manager-employee reporting lines, headcount distribution, and real-time organizational charts.
            </p>
            <div className="landing-cap-meta">
              <CheckCircle2 size={13} />
              <span>Multi-Level Department Trees</span>
            </div>
          </div>

          {/* Card 2: Attendance & Leave */}
          <div className="landing-cap-card">
            <div className="landing-cap-icon">
              <Clock size={20} />
            </div>
            <h3 className="landing-cap-title">Daily Attendance & Leave Management</h3>
            <p className="landing-cap-desc">
              Clock-in/out tracking with IP verification, automatic shift duration tallying, and transaction-safe paid time off request lifecycles.
            </p>
            <div className="landing-cap-meta">
              <CheckCircle2 size={13} />
              <span>Automated Overtime & Shift Calculations</span>
            </div>
          </div>

          {/* Card 3: Payroll */}
          <div className="landing-cap-card">
            <div className="landing-cap-icon">
              <Banknote size={20} />
            </div>
            <h3 className="landing-cap-title">Decimal-Safe Compensation & Payroll</h3>
            <p className="landing-cap-desc">
              Accurate base salary and allowance disbursements with zero floating-point drift, tax withholdings, and downloadable itemized payslips.
            </p>
            <div className="landing-cap-meta">
              <CheckCircle2 size={13} />
              <span>Maker / Checker Approval Flow</span>
            </div>
          </div>

          {/* Card 4: Performance */}
          <div className="landing-cap-card">
            <div className="landing-cap-icon">
              <TrendingUp size={20} />
            </div>
            <h3 className="landing-cap-title">Performance Appraisals & Goals</h3>
            <p className="landing-cap-desc">
              360-degree review cycles, self and manager rating calibrations, OKR milestone completion trackers, and qualitative feedback capture.
            </p>
            <div className="landing-cap-meta">
              <CheckCircle2 size={13} />
              <span>Quarterly OKRs & Calibrated Ratings</span>
            </div>
          </div>

          {/* Card 5: Audit Trail */}
          <div className="landing-cap-card">
            <div className="landing-cap-icon">
              <ShieldCheck size={20} />
            </div>
            <h3 className="landing-cap-title">Forensic Audit Trail & Ledger</h3>
            <p className="landing-cap-desc">
              Immutable write-once log recording state mutations, role escalations, and payroll executions with tamper-evident checksums.
            </p>
            <div className="landing-cap-meta">
              <CheckCircle2 size={13} />
              <span>Compliance-Ready Record Keeping</span>
            </div>
          </div>

          {/* Card 6: AI Assistant */}
          <div className="landing-cap-card">
            <div className="landing-cap-icon">
              <Sparkles size={20} />
            </div>
            <h3 className="landing-cap-title">Executive AI Intelligence</h3>
            <p className="landing-cap-desc">
              Query organizational headcounts, synthesize compensation variances, draft review feedback, and summarize workforce shifts via conversational LLM.
            </p>
            <div className="landing-cap-meta">
              <CheckCircle2 size={13} />
              <span>Natural Language Workforce Analytics</span>
            </div>
          </div>
        </div>

        {/* Stack & Compliance Banner */}
        <div className="landing-banner" id="architecture">
          <div className="landing-banner-content">
            <span style={{
              fontFamily: 'var(--landing-font-mono)',
              fontSize: '11px',
              color: 'var(--landing-accent)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              fontWeight: 600
            }}>
              Production Architecture
            </span>
            <h3 style={{ marginTop: '4px' }}>Built on Next.js 15, NestJS, and PostgreSQL</h3>
            <p>
              Engineered with Turborepo monorepo architecture, Prisma ORM, cookie-based session security, Docker containerization, and strict TypeScript types across web, backend, and shared libraries.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <Link href="/dashboard" className="landing-btn-primary">
              <span>Enter Application</span>
              <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="landing-footer-inner">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div className="landing-brand-mark" style={{ width: '28px', height: '28px', fontSize: '15px' }}>N</div>
            <span className="landing-footer-copy">
              &copy; {new Date().getFullYear()} Neoteric Digital. All rights reserved.
            </span>
          </div>

          <div className="landing-footer-meta">
            NEO EMS &bull; {timezoneLabel()} &bull; Enterprise Monorepo v1.0
          </div>
        </div>
      </footer>
    </div>
  );
}
