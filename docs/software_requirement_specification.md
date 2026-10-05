# Software Requirement Specification (SRS)
## NEO Employee Management System (EMS) Suite
**Document Version:** 1.0.0  
**Status:** Approved / Production-Ready  
**Date:** September 24, 2026  
**Authors:** Neoteric Digital Architecture & Product Engineering Team  

> ⚠️ **HISTORICAL DOCUMENT — do not treat as current.** This SRS predates
> the go-live hardening review and describes the *original* architecture
> (all-in-one Cloud Run container with embedded PostgreSQL, self-contained
> Knative deployment), which has been **deprecated and replaced** by the
> three-service topology (Next.js web + NestJS API + BullMQ worker, managed
> PostgreSQL, compose/k8s) documented in [DEPLOYMENT.md](DEPLOYMENT.md).
> The environment-variable tables in §13.4 are superseded by `.env.example`
> (under repair — see DEPLOYMENT.md §1) and by
> `apps/api/src/config/configuration.ts` as the runtime source of truth.
> Security-relevant corrections: `JWT_REFRESH_SECRET` (see §13.4) **no
> longer exists** — refresh tokens are opaque server-side tokens, not JWTs.
> Kept for requirements traceability only; normative operational detail
> lives in DEPLOYMENT.md and the go-live docs.

---

## Table of Contents
1. [Introduction](#1-introduction)
   - 1.1 Purpose of the Document
   - 1.2 Scope of the Web Application Suite
   - 1.3 Intended Audience
   - 1.4 Definitions, Acronyms, and Abbreviations
   - 1.5 References
   - 1.6 Document Overview
2. [Project Overview](#2-project-overview)
   - 2.1 Product Vision
   - 2.2 Business Objectives
   - 2.3 Problem Statement
   - 2.4 Proposed Solution
   - 2.5 Target Users
   - 2.6 Expected Outcomes
3. [User Roles and Personas](#3-user-roles-and-personas)
   - 3.1 Super Administrator (`SUPER_ADMIN`)
   - 3.2 HR Administrator (`HR_ADMIN`)
   - 3.3 People Manager (`MANAGER`)
   - 3.4 Standard Employee (`EMPLOYEE`)
   - 3.5 Compliance Auditor (`AUDITOR`)
   - 3.6 Role-Permission Matrix
4. [Functional Requirements](#4-functional-requirements)
   - 4.1 Authentication & Credential Lifecycle (FR-AUTH)
   - 4.2 Role-Based Access Control & Profile Management (FR-RBAC)
   - 4.3 Executive Dashboard & Navigation (FR-DASH)
   - 4.4 Employee Directory & Lifecycle Management (FR-EMP)
   - 4.5 Organizational Structure & Department Management (FR-ORG)
   - 4.6 Calendar, Events & Scheduling (FR-CAL)
   - 4.7 Attendance Tracking & Geolocation Validation (FR-ATT)
   - 4.8 Leave Management & Entitlement Accrual (FR-LEV)
   - 4.9 Automated Payroll Engine & Statutory Deductions (FR-PAY)
   - 4.10 Performance Management & 360-Degree Reviews (FR-PRF)
   - 4.11 Document Repository & Secure S3 Storage (FR-DOC)
   - 4.12 Enterprise Audit Logging & SOC2 Compliance (FR-AUD)
   - 4.13 AI Assistant with Real-Time Voice STT/TTS (FR-AI)
   - 4.14 Notification Engine & Alert Dispatch (FR-NOTIF)
5. [Non-Functional Requirements](#5-non-functional-requirements)
   - 5.1 Performance Requirements
   - 5.2 Scalability & Elasticity
   - 5.3 Reliability, Fault Tolerance & High Availability
   - 5.4 Security & Data Privacy
   - 5.5 Usability & Editorial UX Design
   - 5.6 Accessibility (WCAG 2.1 Level AA)
   - 5.7 Maintainability & Code Quality
   - 5.8 Portability, Containerization & Cloud Native Architecture
   - 5.9 Browser & Device Compatibility
6. [System Architecture Overview](#6-system-architecture-overview)
   - 6.1 Multi-Tier Architecture Diagram
   - 6.2 Frontend Architecture (Next.js 14 App Router)
   - 6.3 Backend API Gateway & Micro-Services (NestJS 10)
   - 6.4 Relational Data Layer (PostgreSQL 16 & Prisma ORM)
   - 6.5 Asynchronous Task Processing & Caching (BullMQ & Redis 7)
   - 6.6 Dual-Provider AI Inference Pipeline
   - 6.7 Container & Edge Orchestration (Nginx & Google Cloud Run)
7. [User Interface Requirements](#7-user-interface-requirements)
   - 7.1 Visual Identity & Typography
   - 7.2 Layout Shell & Navigation Mechanics
   - 7.3 State Management & Micro-Interactions
   - 7.4 Form Validation & Error Feedback
8. [Data Requirements](#8-data-requirements)
   - 8.1 Primary Data Entities & Relational Schema
   - 8.2 Entity Relationship Model
   - 8.3 Integrity Constraints & Validation Rules
   - 8.4 Retention, Archival & Disaster Recovery
9. [Security Requirements](#9-security-requirements)
   - 9.1 Authentication & Token Rotation Protocol
   - 9.2 Authorization & Contextual Access Control
   - 9.3 Cryptographic Standards (In-Transit & At-Rest)
   - 9.4 Mitigation of OWASP Top 10 Vulnerabilities
10. [Integration Requirements](#10-integration-requirements)
    - 10.1 Dual-Provider AI Inference APIs
    - 10.2 Client-Side Web Speech STT & TTS Integration
    - 10.3 Object Storage Integration (S3 / MinIO)
    - 10.4 Redis & Message Broker Integration
11. [Performance Requirements](#11-performance-requirements)
    - 11.1 Latency Benchmarks
    - 11.2 Throughput & Concurrency Thresholds
    - 11.3 Database Optimization & Indexing Strategies
12. [Testing and Quality Assurance Requirements](#12-testing-and-quality-assurance-requirements)
    - 12.1 Testing Strategy & Pyramid
    - 12.2 Unit, Integration & E2E Test Coverage
    - 12.3 Automated Regression & Security Scans
13. [Deployment Requirements](#13-deployment-requirements)
    - 13.1 Production Environment Specification (Cloud Run)
    - 13.2 Multi-Stage Dockerfile Containerization
    - 13.3 CI/CD Automation & Zero-Downtime Rollouts
    - 13.4 Environment Variables & Secrets Management
14. [Maintenance and Support Requirements](#14-maintenance-and-support-requirements)
    - 14.1 Observability, Health Checks & Telemetry
    - 14.2 Database Migrations & Version Control
    - 14.3 Incident Response & SLA Tiers
15. [Assumptions and Dependencies](#15-assumptions-and-dependencies)
16. [Constraints](#16-constraints)
17. [Acceptance Criteria](#17-acceptance-criteria)
18. [Future Enhancements](#18-future-enhancements)

---

## 1. Introduction

### 1.1 Purpose of the Document
This Software Requirement Specification (SRS) provides a comprehensive, definitive, and contractually binding description of the **NEO Employee Management System (EMS)** Web Application Suite. It specifies the functional requirements, performance targets, security mechanisms, architectural models, and design standards necessary for engineering, testing, deploying, and auditing the system. 

### 1.2 Scope of the Web Application Suite
NEO EMS is an enterprise human capital management platform designed for distributed organizations. The suite automates and harmonizes all phases of the employee lifecycle:
- Core HR Directory & Organizational Hierarchy
- Time & Attendance with Geolocation & IP Boundary Verification
- Entitlement Accrual & Leave Approval Workflows
- Multi-Jurisdictional Payroll Calculation with Statutory Deductions (PF, ESI, TDS)
- Performance Cycles, OKR/Goal Alignment, and 360-Degree Reviews
- High-Availability Dual-Provider AI Inference with Voice-to-Text Input and Text-to-Speech Output
- Immutable SOC2-Compliant Audit Trails & Access Logging

### 1.3 Intended Audience
This document is targeted at:
- **Executive Stakeholders & Product Managers**: For strategic alignment, feature roadmap approval, and operational governance.
- **Software Engineers & Technical Architects**: As the authoritative implementation blueprint for monorepo design, APIs, data schemas, and integration contracts.
- **UI/UX Designers**: For visual hierarchies, state flows, micro-interactions, and accessibility standards.
- **QA Engineers & SDETs**: As the validation standard for acceptance test suites, edge cases, and automated regressions.
- **Security & Compliance Auditors**: For verification of cryptographic safeguards, RBAC policies, and audit trails.

### 1.4 Definitions, Acronyms, and Abbreviations
| Term | Definition |
| :--- | :--- |
| **API** | Application Programming Interface |
| **BullMQ** | Distributed Message Queue for Node.js backed by Redis |
| **Circuit Breaker** | Architectural pattern preventing cascade failures by tripping on provider downtime |
| **CTC** | Cost to Company (Gross salary + statutory employer contributions + allowances) |
| **EMS** | Employee Management System |
| **ESI** | Employee State Insurance (Statutory social healthcare fund) |
| **JWT** | JSON Web Token (RFC 7519) |
| **PBAC / RBAC** | Policy-Based Access Control / Role-Based Access Control |
| **PF** | Provident Fund (Statutory retirement pension reserve) |
| **Prisma** | Next-generation TypeScript ORM for Node.js and PostgreSQL |
| **SOC2** | Service Organization Control 2 Trust Services Criteria |
| **SRS** | Software Requirement Specification |
| **STT** | Speech-to-Text (Voice Recognition) |
| **TDS** | Tax Deducted at Source (Statutory income tax withholding) |
| **TTS** | Text-to-Speech (Voice Synthesis) |
| **WCAG** | Web Content Accessibility Guidelines |

### 1.5 References
- IEEE Std 830-1998: *Recommended Practice for Software Requirements Specifications*
- RFC 7519: *JSON Web Token (JWT) Architecture and Security Specifications*
- W3C Web Speech API Specification (SpeechRecognition and SpeechSynthesis Interfaces)
- NIST Special Publication 800-63B: *Digital Identity Guidelines — Authentication and Lifecycle Management*
- Google Cloud Run Knative Serving v1 Specification

### 1.6 Document Overview
The remainder of this document defines the product vision, actors, functional capabilities, systemic constraints, non-functional targets, entity relationships, security controls, and acceptance criteria governing the NEO EMS suite.

---

## 2. Project Overview

### 2.1 Product Vision
To empower modern, high-growth global enterprises with a unified, resilient, and intelligent workforce operating system that eliminates operational friction across HR, payroll, performance, and compliance through autonomous intelligence, seamless voice interaction, and uncompromising aesthetic excellence.

### 2.2 Business Objectives
1. **Reduce Payroll Processing Latency**: Accelerate monthly payroll cycle execution from days to under 60 seconds with 100% calculation accuracy.
2. **Eliminate Compliance Exposure**: Ensure immutable, tamper-evident audit logging for SOC2, EPF, ESI, and tax regulatory mandates.
3. **Enhance Workforce Productivity**: Provide natural language and voice interaction for policy queries, document drafting, and HR analytics.
4. **Achieve 99.95% Availability**: Guarantee operational resilience through containerized Cloud Run deployments and dual-provider AI failovers.

### 2.3 Problem Statement
Contemporary enterprise HR systems suffer from fragmented architectures, sluggish interfaces, error-prone manual payroll spreadsheets, disconnected performance tracking, and vendor lock-in with brittle, single-point-of-failure AI integrations. Legacy tools lack accessible multimodal voice interfaces, forcing HR administrators and managers into tedious, repetitive manual interactions.

### 2.4 Proposed Solution
NEO EMS provides a production-hardened, high-concurrency web suite architected as a TypeScript monorepo with:
- An ultra-fast Next.js 14 App Router frontend featuring editorial ergonomics and sub-second navigation.
- A robust NestJS 10 backend gateway with strict validation, dependency injection, and modular domain encapsulation.
- An embedded/cloud PostgreSQL 16 relational core managed via Prisma ORM.
- A dual-provider AI inference layer (Google Gemini 1.5 Flash + Groq Llama 3.3 70B) protected by a three-state circuit breaker.
- Full client-side multimodal voice input (STT) and voice output (TTS) with sentence chunking and automatic speech submission.

### 2.5 Target Users
Enterprises ranging from 20 to 10,000+ employees, including executive leadership, HR departments, line managers, salaried employees, contractors, and external compliance auditors.

### 2.6 Expected Outcomes
- 80% reduction in administrative HR inquiries via self-service AI Assistant.
- Zero payroll calculation discrepancies across complex allowances and statutory deductions.
- 100% auditable traceability for employee demographic changes, salary revisions, and system role modifications.

---

## 3. User Roles and Personas

```
+-------------------------------------------------------------------------------+
|                             System Hierarchy & RBAC                           |
+-------------------------------------------------------------------------------+
| 👑 SUPER_ADMIN  ──► Unrestricted access, global configuration, audit logs    |
| 📋 HR_ADMIN     ──► Employee records, payroll runs, leave policies, reviews   |
| 👔 MANAGER      ──► Department approvals, direct report reviews, attendance   |
| 💻 EMPLOYEE     ──► Self-service portal, check-in, leave apply, payslip view  |
| 🔍 AUDITOR      ──► Read-only inspection of system logs, payroll, compliance  |
+-------------------------------------------------------------------------------+
```

### 3.1 Super Administrator (`SUPER_ADMIN`)
- **Profile**: CTO, VP of Engineering, or Head of Enterprise IT.
- **Responsibilities**: System uptime, master tenant configuration, security role allocation, global audit oversight, AI circuit configuration.
- **Access Level**: Unrestricted (Root access across all routes and API endpoints).
- **Key Actions**:
  - Assign and revoke administrative roles.
  - Review token-level AI audit logs and provider circuit breaker statuses.
  - Trigger global database backups and administrative resets.

### 3.2 HR Administrator (`HR_ADMIN`)
- **Profile**: Chief People Officer, HR Directors, and Payroll Coordinators.
- **Responsibilities**: Employee onboarding, department structures, leave entitlement balances, payroll execution, document repository management.
- **Access Level**: Domain Administrator (All modules except root security and low-level system settings).
- **Key Actions**:
  - Provision employee records, assign salary structures, and manage contracts.
  - Formulate and approve monthly payroll batches.
  - Oversee quarterly 360-degree review cycles.

### 3.3 People Manager (`MANAGER`)
- **Profile**: Engineering Directors, Team Leads, Department Heads.
- **Responsibilities**: Team oversight, attendance validation, leave approvals, goal setting, and quarterly performance scoring.
- **Access Level**: Scoped Departmental Access (Access restricted to direct and indirect reports).
- **Key Actions**:
  - Approve or reject subordinate leave requests with contextual feedback.
  - Review team daily attendance and overtime trends.
  - Conduct manager evaluation reviews and approve milestone goals.

### 3.4 Standard Employee (`EMPLOYEE`)
- **Profile**: Salaried staff, contractors, interns.
- **Responsibilities**: Daily clock-in/out, leave balance tracking, self-evaluation submissions, tax documentation, AI assistant utilization.
- **Access Level**: Self-Service Portal (Access strictly scoped to personal record).
- **Key Actions**:
  - Perform daily check-in and check-out with automatic IP logging.
  - Request planned and emergency leaves.
  - Download encrypted monthly payslip PDFs.
  - Submit voice queries to the AI Assistant for policy and benefits inquiries.

### 3.5 Compliance Auditor (`AUDITOR`)
- **Profile**: Internal compliance inspectors, external SOC2/ISO auditors.
- **Responsibilities**: Impartial review of payroll disbursements, access control modifications, data privacy compliance, and system activity logs.
- **Access Level**: Read-Only Global Inspection (No data mutation privileges).
- **Key Actions**:
  - Search, filter, and export system audit logs (`AuditLog`).
  - Inspect historical payroll runs and deduction registers.
  - Review AI generation logs and prompt safety compliance records.

### 3.6 Role-Permission Matrix
| Module / Capability | SUPER_ADMIN | HR_ADMIN | MANAGER | EMPLOYEE | AUDITOR |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **System Settings & Backups** | Full | Denied | Denied | Denied | Denied |
| **Security Audit Logs** | Full | Full | Denied | Denied | Read-Only |
| **Employee Directory** | Full | Full | Scoped | Self-Only | Read-Only |
| **Organization & Depts** | Full | Full | Read-Only | Read-Only | Read-Only |
| **Daily Attendance** | Full | Full | Scoped Approval | Self Check-in | Read-Only |
| **Leave Management** | Full | Full | Scoped Approval | Self Request | Read-Only |
| **Payroll Processing** | Full | Full | Denied | View Payslip | Read-Only |
| **Performance Reviews** | Full | Full | Direct Reports | Self Review | Read-Only |
| **Document Vault** | Full | Full | Scoped | Self Docs | Read-Only |
| **AI Assistant Suite** | Full | Full | Full | Full | Read-Only (Logs) |

---

## 4. Functional Requirements

### 4.1 Authentication & Credential Lifecycle (FR-AUTH)

#### FR-AUTH-001: Enterprise User Login & JWT Issuance
- **Description**: Authenticate user credentials and issue short-lived JWT access tokens and secure refresh tokens.
- **Priority**: High (P0)
- **User Role Affected**: All Roles
- **Preconditions**: User account must be active (`employmentStatus != TERMINATED`).
- **Main Flow**:
  1. Client sends `POST /api/v1/auth/login` with `{ email, password }`.
  2. Gateway validates payload formatting via `class-validator`.
  3. Server locates user by email, retrieves Argon2/Bcrypt hash, and verifies password.
  4. Server generates JWT Access Token (15-minute expiration) containing `{ id, email, roles }`.
  5. Server generates cryptographically random Refresh Token (7-day expiration), stores its hash in database, and returns both to client.
  6. Client saves access token in memory/storage and establishes session state.
- **Alternative Flows**:
  - *Invalid Password*: Server increments failed attempt counter, logs audit failure, returns `401 Unauthorized`.
  - *Suspended Account*: Server detects inactive status, aborts authentication, returns `403 Forbidden`.
- **Expected Output**: HTTP 200 with `{ accessToken, refreshToken, user: { id, email, firstName, lastName, roles } }`.
- **Acceptance Criteria**: Authentication executes in `< 250ms`; passwords are never logged in plaintext.

#### FR-AUTH-002: Refresh Token Rotation
- **Description**: Issue a new access token and rotate the refresh token without requiring re-authentication.
- **Priority**: High (P0)
- **User Role Affected**: All Roles
- **Preconditions**: Valid, unexpired, non-revoked refresh token present.
- **Main Flow**:
  1. Client sends `POST /api/v1/auth/refresh` with `{ refreshToken }`.
  2. Server verifies token signature, checks persistence store, invalidates old token, generates new pair.
  3. Returns updated tokens to client.
- **Alternative Flows**:
  - *Replayed / Re-used Refresh Token*: Server detects re-use, revokes all active sessions for the user (breach protocol), logs critical security event, returns `401 Unauthorized`.
- **Expected Output**: HTTP 200 with new token pair.
- **Acceptance Criteria**: Seamless token renewal with zero client interruption.

---

### 4.2 Role-Based Access Control & Profile Management (FR-RBAC)

#### FR-RBAC-001: Policy-Enforced Endpoint Protection
- **Description**: Enforce role-based access boundaries across API routes via NestJS Guards (`JwtAuthGuard`, `RolesGuard`).
- **Priority**: High (P0)
- **User Role Affected**: All Roles
- **Preconditions**: User possesses valid Bearer access token.
- **Main Flow**:
  1. Inbound HTTP request hits controller endpoint annotated with `@Roles(...)`.
  2. `JwtAuthGuard` extracts token from `Authorization` header and validates signature.
  3. `RolesGuard` matches token roles against endpoint requirements.
  4. If matched, execution passes to controller handler.
- **Alternative Flows**:
  - *Insufficient Privileges*: Returns `403 Forbidden` with standardized error JSON.
- **Expected Output**: Authorized execution or immediate 403 halt.
- **Acceptance Criteria**: 100% of non-public endpoints require valid JWT authentication.

---

### 4.3 Executive Dashboard & Navigation (FR-DASH)

#### FR-DASH-001: Operational Dashboard KPI Aggregate View
- **Description**: Deliver contextual headcount, attendance percentages, pending leaves, and payroll metrics based on caller role.
- **Priority**: High (P1)
- **User Role Affected**: All Roles
- **Preconditions**: Authenticated session.
- **Main Flow**:
  1. User accesses `/dashboard`.
  2. Frontend queries `/api/v1/dashboard/stats`.
  3. Server computes aggregate metrics: Total Staff, Present Today, On Leave, Monthly Payroll Burn.
  4. Frontend displays responsive KPI cards, dynamic charts, and quick-action toolbars.
- **Expected Output**: Rendered dashboard with real-time operational metrics.
- **Acceptance Criteria**: Page loads in `< 800ms`; data reflects active database state.

---

### 4.4 Employee Directory & Lifecycle Management (FR-EMP)

#### FR-EMP-001: Comprehensive Employee Provisioning
- **Description**: Create, onboard, and store employee records with personal, contractual, and departmental attributes.
- **Priority**: High (P0)
- **User Role Affected**: `SUPER_ADMIN`, `HR_ADMIN`
- **Preconditions**: Department and designation records exist.
- **Main Flow**:
  1. Admin navigates to `/employees` and clicks "Add Employee".
  2. Admin fills employee form: First/Last Name, Email, Gender, Phone, Hire Date, Department, Position, Manager, Base Salary.
  3. Client submits `POST /api/v1/employees`.
  4. Server validates input, verifies unique email constraint, inserts record into PostgreSQL, and dispatches welcome event.
- **Alternative Flows**:
  - *Duplicate Email*: Server halts insertion, returns `409 Conflict` with clear message.
- **Expected Output**: HTTP 201 Created with persisted employee entity.
- **Acceptance Criteria**: Record instantly searchable in directory; relational bindings properly indexed.

#### FR-EMP-002: Advanced Directory Search, Filtering, and Sorting
- **Description**: Search across employees by name, department, role, or status with instant pagination.
- **Priority**: Medium (P1)
- **User Role Affected**: All Roles (Scoped)
- **Main Flow**:
  1. User inputs query into search bar or selects department filter dropdown.
  2. Frontend queries `GET /api/v1/employees?search=query&dept=engineering&page=1&limit=10`.
  3. Server executes indexed PostgreSQL query with case-insensitive `ILIKE` and returns paginated result set.
- **Expected Output**: Filtered employee table with pagination metadata (`total`, `page`, `pageCount`).
- **Acceptance Criteria**: Query execution completes in `< 100ms` for 10,000+ records.

---

### 4.5 Organizational Structure & Department Management (FR-ORG)

#### FR-ORG-001: Hierarchical Department & Position Management
- **Description**: Maintain organizational units, parent-child department trees, and designation matrices.
- **Priority**: Medium (P1)
- **User Role Affected**: `SUPER_ADMIN`, `HR_ADMIN`
- **Main Flow**:
  1. Admin accesses `/organization/departments`.
  2. Admin creates department with Name, Code, and assigned Department Manager.
  3. Server links manager foreign key and validates non-cyclical parent hierarchy.
- **Expected Output**: Persisted department node in organizational tree.
- **Acceptance Criteria**: Prevents circular department parenting; cascades reassignments cleanly.

---

### 4.6 Calendar, Events & Scheduling (FR-CAL)

#### FR-CAL-001: Enterprise Unified Calendar View
- **Description**: Visual calendar aggregating company holidays, approved leaves, payroll disbursement dates, and team milestones.
- **Priority**: Medium (P2)
- **User Role Affected**: All Roles
- **Main Flow**:
  1. User navigates to `/calendar`.
  2. Client fetches monthly date range from `/api/v1/calendar/events`.
  3. Interactive calendar renders color-coded event pills (Green for Holidays, Amber for Leaves, Blue for Milestones).
- **Expected Output**: Month/Week/Day responsive calendar view.
- **Acceptance Criteria**: Month transitions render in `< 150ms`.

---

### 4.7 Attendance Tracking & Geolocation Validation (FR-ATT)

#### FR-ATT-001: Daily Clock-In and Clock-Out Tracking
- **Description**: Capture employee check-in and check-out timestamps with client IP and geolocation recording.
- **Priority**: High (P0)
- **User Role Affected**: `EMPLOYEE`, `MANAGER`, `HR_ADMIN`
- **Preconditions**: Employee has active status.
- **Main Flow**:
  1. Employee clicks "Check In" button on dashboard or `/attendance`.
  2. Client captures timestamp, IP address, and optional browser geolocation.
  3. Client dispatches `POST /api/v1/attendance/check-in`.
  4. Server calculates status (`PRESENT` if `< 09:30 AM`, `LATE` if `> 09:30 AM`), writes record, and updates dashboard status pill to "Checked In".
  5. Upon shift completion, employee clicks "Check Out"; server calculates total `workHours`.
- **Alternative Flows**:
  - *Duplicate Clock-In*: If already checked in without checkout, server rejects with `400 Bad Request`.
- **Expected Output**: Stored `Attendance` record with accurate hours worked.
- **Acceptance Criteria**: Timestamps stored in UTC; status correctly categorized.

---

### 4.8 Leave Management & Entitlement Accrual (FR-LEV)

#### FR-LEV-001: Leave Application & Tiered Approval Workflow
- **Description**: Request time off against accrued leave balances (Annual, Sick, Casual, Maternity, Unpaid) with manager approval escalation.
- **Priority**: High (P0)
- **User Role Affected**: `EMPLOYEE`, `MANAGER`, `HR_ADMIN`
- **Preconditions**: Sufficient leave balance in `LeaveBalance` table.
- **Main Flow**:
  1. Employee submits leave request with Leave Type, Start Date, End Date, and Reason.
  2. Server verifies `balance >= requestedDays`.
  3. Record created with status `PENDING`; notification dispatched to assigned manager.
  4. Manager reviews request in team dashboard and clicks "Approve" or "Reject".
  5. If approved, status transitions to `APPROVED`, and corresponding `LeaveBalance.usedDays` increments.
- **Alternative Flows**:
  - *Insufficient Balance*: Server halts submission, returns `422 Unprocessable Entity` with available balance details.
- **Expected Output**: Updated leave ledger and calendar synchronization.
- **Acceptance Criteria**: Balance deductions strictly atomic; concurrent requests cannot over-draw balance.

---

### 4.9 Automated Payroll Engine & Statutory Deductions (FR-PAY)

#### FR-PAY-001: High-Precision Monthly Payroll Calculation
- **Description**: Calculate gross earnings, statutory withholdings (PF, ESI, TDS, Professional Tax), and net disbursements across all active employees.
- **Priority**: High (P0)
- **User Role Affected**: `SUPER_ADMIN`, `HR_ADMIN`
- **Preconditions**: Salary structures configured; attendance and leave records finalized for cycle.
- **Main Flow**:
  1. Admin initiates payroll run for month/year via `POST /api/v1/payroll/runs`.
  2. Server queues job in BullMQ worker (`ai-processing` / payroll queue).
  3. Engine processes each employee:
     - Basic Salary + HRA + Allowances = Gross Salary.
     - Provident Fund (12% of Basic up to statutory limits).
     - Employee State Insurance (0.75% of Gross for eligible slabs).
     - TDS deduction based on declared tax regime.
     - Unpaid leave deductions based on finalized attendance ledger.
     - Net Pay = Gross - Total Deductions.
  4. Server writes `PayrollItem` records and sets run status to `APPROVED`.
- **Expected Output**: Batch payroll register with line-item transparency.
- **Acceptance Criteria**: Zero floating-point rounding errors (handled via arbitrary-precision Decimal types); batch of 500 employees completes in `< 5 seconds`.

---

### 4.10 Performance Management & 360-Degree Reviews (FR-PRF)

#### FR-PRF-001: Quarterly Evaluation & Milestone Goal Tracking
- **Description**: Create review cycles, capture self-appraisals, manager ratings, and track quarterly milestone goals.
- **Priority**: Medium (P1)
- **User Role Affected**: `EMPLOYEE`, `MANAGER`, `HR_ADMIN`
- **Main Flow**:
  1. HR initiates Q3 Review Cycle.
  2. Employee completes self-review and submits goal progress percentages.
  3. Manager receives notification, completes manager evaluation scoring (1.0 to 5.0 scale), adds written commentary, and signs off.
  4. Overall weighted competency rating is computed and archived.
- **Expected Output**: Completed `PerformanceReview` entity with historical audit trail.
- **Acceptance Criteria**: Locked upon completion; ratings contribute to talent analytics.

---

### 4.11 Document Repository & Secure S3 Storage (FR-DOC)

#### FR-DOC-001: Encrypted Document Vault & Avatar Management
- **Description**: Upload, categorize, view, and retrieve employee identification, offer letters, contracts, and avatars using S3-compatible storage.
- **Priority**: Medium (P1)
- **User Role Affected**: All Roles
- **Preconditions**: S3/MinIO bucket accessible.
- **Main Flow**:
  1. User uploads file (PDF/JPEG/PNG, max 10MB) via `/documents` or Profile Avatar modal.
  2. Server validates MIME type and file magic bytes, generates random UUID filename, streams to object storage, and saves reference in database.
  3. Secure pre-signed URL generated for viewing/downloading.
- **Alternative Flows**:
  - *Malicious File Extension*: Server detects disallowed format, rejects upload immediately with `415 Unsupported Media Type`.
- **Expected Output**: Stored asset and authenticated URL.
- **Acceptance Criteria**: Upload latency `< 1s` for 5MB assets; direct public bucket access disabled.

---

### 4.12 Enterprise Audit Logging & SOC2 Compliance (FR-AUD)

#### FR-AUD-001: Immutable Event Logging & Forensics
- **Description**: Automatically record every authentication event, data mutation, role escalation, and export action into an append-only audit ledger.
- **Priority**: High (P0)
- **User Role Affected**: `SUPER_ADMIN`, `AUDITOR`
- **Main Flow**:
  1. User triggers any state-altering action (e.g. employee promotion, salary update, login).
  2. Interceptor captures User ID, Action, Entity Type, Entity ID, IP Address, User Agent, and Before/After state delta JSON.
  3. Record written to `audit_logs` table asynchronously via BullMQ offloader.
  4. Auditors inspect, filter, and export logs via `/admin/audit-logs`.
- **Expected Output**: Permanent, tamper-evident audit trail.
- **Acceptance Criteria**: Audit records cannot be updated or deleted through the application API.

---

### 4.13 AI Assistant with Real-Time Voice STT/TTS (FR-AI)

#### FR-AI-001: Multimodal Voice Input (Speech-to-Text)
- **Description**: Capture user vocal speech via client microphone, stream real-time transcription to prompt input, and automatically trigger completion submission upon speech termination.
- **Priority**: High (P0)
- **User Role Affected**: All Roles
- **Preconditions**: Browser with Web Speech API support (`webkitSpeechRecognition` or `SpeechRecognition`); microphone permissions granted.
- **Main Flow**:
  1. User clicks the microphone button (`#micBtn`) in the AI Assistant prompt toolbar.
  2. System prompts for/verifies microphone permissions via `getUserMedia`.
  3. Speech recognition initializes with `continuous: true` and `interimResults: true`.
  4. User speaks prompt (e.g., "Draft a leave policy for engineering"); microphone button pulses red with animated equalizer waveforms.
  5. Interim and final speech tokens are streamed synchronously to the prompt textarea and internal state in real time.
  6. When the user stops speaking for 1.8 seconds (silence threshold) or manually clicks the microphone button, recognition stops and automatically submits the prompt to `POST /api/v1/ai/generate`.
- **Alternative Flows**:
  - *Microphone Denied*: Displays dismissible amber alert banner explaining permission steps.
  - *Speech Engine Unsupported*: Mic button displays tooltip suggesting Chrome/Edge; graceful text fallback available.
  - *Cancellation*: Clicking "Cancel" on the status banner aborts listening without query submission.
- **Expected Output**: Transcribed text populated and automatically dispatched to AI backend.
- **Acceptance Criteria**: Words appear on screen in `< 100ms` of vocalization; hands-free auto-submission triggers reliably after silence threshold.

#### FR-AI-002: Dual-Provider Failover AI Inference Pipeline
- **Description**: Route queries to Google Gemini 1.5 Flash by default, with automatic circuit-breaker-protected failover to Groq Cloud (Llama 3.3 70B) upon timeout, rate limit, or outage.
- **Priority**: High (P0)
- **User Role Affected**: All Roles
- **Main Flow**:
  1. API Gateway receives prompt at `POST /api/v1/ai/generate`.
  2. Orchestrator inspects Gemini `CircuitBreaker`.
  3. If `CLOSED`, executes query against Gemini 1.5 Flash with 30s timeout.
  4. If successful, records latency, logs token usage, and returns HTTP 200 with result payload.
- **Alternative Flows**:
  - *Gemini 429 Quota or 5xx Outage*: Gemini circuit records failure. Orchestrator immediately shifts traffic to Groq Cloud (`llama-3.3-70b-versatile`), records `failoverUsed: true`, and returns completion without client interruption.
  - *Total Provider Outage*: If all provider circuits trip, returns structured `503 Service Unavailable` with `retryAfterSeconds: 30`.
- **Expected Output**: AI completion payload with provider attribution, model name, and execution latency.
- **Acceptance Criteria**: Failover switch occurs in `< 50ms`; zero data loss.

#### FR-AI-003: Spoken Voice Output (Text-to-Speech)
- **Description**: Convert AI assistant text responses into spoken natural audio using Web Speech API synthesis, complete with sentence chunking, markdown artifact cleanup, and audio controls.
- **Priority**: High (P0)
- **User Role Affected**: All Roles
- **Preconditions**: Browser supports `window.speechSynthesis`.
- **Main Flow**:
  1. AI completion returns from backend.
  2. If query originated from voice input OR if "Voice Output" toggle is checked, `speak()` triggers automatically.
  3. Engine cleans markdown formatting (removing `#`, `**`, ````, URLs) to ensure natural cadence.
  4. Engine splits text into sentence chunks and queues them sequentially into `SpeechSynthesisUtterance`.
  5. UI displays animated sound waves in response bar; button toggles to "Stop".
  6. Speech completes; UI resets gracefully to "Listen".
- **Alternative Flows**:
  - *User Halts Speech*: Clicking "Stop" immediately invokes `speechSynthesis.cancel()`.
- **Expected Output**: High-clarity spoken audio output matching AI response text.
- **Acceptance Criteria**: Markdown characters are never verbalized; playback does not stall or truncate on long answers.

---

### 4.14 Notification Engine & Alert Dispatch (FR-NOTIF)

#### FR-NOTIF-001: In-App and Email Event Notifications
- **Description**: Real-time notification dispatch for leave approvals, payroll disbursements, review submissions, and security alerts.
- **Priority**: Medium (P1)
- **User Role Affected**: All Roles
- **Main Flow**:
  1. Triggering event occurs (e.g. Leave Approved).
  2. Event producer pushes message to Redis notification exchange.
  3. Notification entity persisted in database; client polls/receives update in top bar notification bell.
- **Expected Output**: Unread notification counter and drawer item.
- **Acceptance Criteria**: Notifications generated within `< 500ms` of event commit.

---

## 5. Non-Functional Requirements

### 5.1 Performance Requirements
- **NFR-PERF-001 (Page Load Time)**: Initial paint `< 1.2s`, Time-to-Interactive (TTI) `< 1.8s` on modern 4G broadband connections.
- **NFR-PERF-002 (API Response Latency)**: 95th percentile (p95) API response time `< 200ms` for standard CRUD operations; `< 1500ms` for AI generation.
- **NFR-PERF-003 (Voice Transcription Latency)**: Real-time interim speech recognition display latency `< 80ms`.

### 5.2 Scalability & Elasticity
- **NFR-SCAL-001 (Horizontal Auto-Scaling)**: Google Cloud Run service scales from 0 to 10 instances automatically based on container concurrency thresholds (160 concurrent requests/instance).
- **NFR-SCAL-002 (Database Connection Pooling)**: Prisma connection pool managed with timeouts to prevent thread exhaustion during traffic spikes.

### 5.3 Reliability, Fault Tolerance & High Availability
- **NFR-REL-001 (Availability SLA)**: 99.95% uptime excluding scheduled maintenance windows.
- **NFR-REL-002 (AI Circuit Breaker)**: Isolated 3-state circuit breakers per provider (Failure threshold = 5 consecutive faults, recovery probe window = 30s).
- **NFR-REL-003 (Graceful Degradation)**: Complete operational independence of core HR modules if external AI providers or object storage experience temporary outages.

### 5.4 Security & Data Privacy
- **NFR-SEC-001 (Password Encryption)**: Passwords hashed with Argon2id or Bcrypt with minimum cost factor of 12.
- **NFR-SEC-002 (Transport Layer Security)**: Enforced TLS 1.3 for all HTTP connections; HSTS headers enabled with 1-year duration.
- **NFR-SEC-003 (Data Privacy)**: PII (salary, identification, contact data) accessible exclusively by authorized roles and never logged in plaintext application telemetry.

### 5.5 Usability & Editorial UX Design
- **NFR-USE-001 (Design Aesthetics)**: Professional editorial UI aesthetic utilizing warm, curated palettes (`#f7f6f3` background, `#2c5f4a` deep emerald accents, Instrument Serif headers, DM Sans body typography) avoiding generic defaults.
- **NFR-USE-002 (Cognitive Load)**: Standard HR tasks (Clock-in, Leave application) executable in `< 3 clicks` from dashboard.

### 5.6 Accessibility (WCAG 2.1 Level AA)
- **NFR-ACC-001 (Color Contrast)**: Minimum contrast ratio of 4.5:1 for standard text; 3:1 for large display text and graphical elements.
- **NFR-ACC-002 (Keyboard Navigation)**: 100% of interactive elements (inputs, buttons, modal triggers) focusable and operable via standard keyboard tabs and shortcuts (`Shift+Enter`, `Enter`, `Escape`).

### 5.7 Maintainability & Code Quality
- **NFR-MNT-001 (Type Safety)**: 100% TypeScript across monorepo with `strict: true` enforcement and zero `any` types in production paths.
- **NFR-MNT-002 (Modular Structure)**: Clear domain boundaries under NestJS modules and Next.js route groups.

### 5.8 Portability, Containerization & Cloud Native Architecture
- **NFR-POR-001 (OCI Compliance)**: Fully self-contained multi-stage Docker container executable across Google Cloud Run, AWS ECS, Azure Container Apps, or local Docker Compose.
- **NFR-POR-002 (Embedded DB Fallback)**: Container includes automatic embedded PostgreSQL initialization if external `DATABASE_URL` is omitted, ensuring zero-configuration portability.

### 5.9 Browser & Device Compatibility
- **NFR-CMP-001 (Desktop Browsers)**: Fully compatible with Chrome 110+, Edge 110+, Safari 16+, Firefox 115+.
- **NFR-CMP-002 (Mobile & Tablet)**: Fluid responsive layouts supporting mobile viewports down to 360px width with collateral drawer sidebars.

---

## 6. System Architecture Overview

### 6.1 Multi-Tier Architecture Diagram

```
+---------------------------------------------------------------------------------------------------------+
|                                    Client Tier (Desktop / Mobile Browsers)                              |
|   - Modern Web Technologies: HTML5, CSS3, ES2024, Web Speech API (SpeechRecognition + SpeechSynthesis)  |
|   - Next.js 14 App Router (React 18, Strict TypeScript, Editorial Theme, Chart.js)                     |
+---------------------------------------------------------------------------------------------------------+
                                                     │  HTTPS (TLS 1.3)
                                                     ▼
+---------------------------------------------------------------------------------------------------------+
|                                    Edge Ingress & Reverse Proxy (Nginx)                                  |
|   - TLS Termination, Static Asset Caching, Gzip/Brotli Compression, Reverse Proxying                   |
|   - Routing: / -> Next.js (Port 3000) | /api/v1 -> NestJS API Gateway (Port 4000)                        |
+---------------------------------------------------------------------------------------------------------+
                                                     │
                         ┌───────────────────────────┴───────────────────────────┐
                         ▼                                                       ▼
+-------------------------------------------------------+   +---------------------------------------------+
|            Frontend Server (Port 3000)                |   |          Backend Gateway (Port 4000)        |
|  - Next.js 14 SSR & Client Hydration                  |   |  - NestJS 10 Framework                      |
|  - Custom Hooks: useSpeech(), useAiCompletion()       |   |  - Guards: JwtAuthGuard, RolesGuard         |
|  - Real-time Interim Voice Streaming                  |   |  - Interceptors: AuditLog, Transform        |
+-------------------------------------------------------+   +---------------------------------------------+
                                                                                         │
                                         ┌───────────────────────────────────────────────┴──────────────┐
                                         ▼                                                              ▼
+-------------------------------------------------------------------------+   +-----------------------------------+
|                           Core Services                                 |   |        Asynchronous Workers       |
|  - EmployeeService, PayrollEngine, LeaveService, AttendanceService      |   |  - BullMQ Worker Processors       |
|  - AI Orchestrator (Circuit Breaker + Dual Provider Gateway)            |   |  - Long-Running Payroll Batches   |
|  - AuditService (SOC2 Append-Only Logging)                              |   |  - Asynchronous Notification Offload|
+-------------------------------------------------------------------------+   +-----------------------------------+
                                         │                                                              │
                 ┌───────────────────────┼───────────────────────┐                                      │
                 ▼                       ▼                       ▼                                      ▼
+---------------------------------+ +--------------------+ +--------------------+   +-----------------------------+
|    PostgreSQL 16 Relational DB  | | Primary AI Provider| |Fallback AI Provider|   |      Redis 7 Cluster        |
|  - Prisma ORM 6                 | | - Google Gemini    | | - Groq Cloud       |   |  - BullMQ Job Queues        |
|  - Relational Integrity         | |   (gemini-1.5-flash| |   (llama-3.3-70b)  |   |  - Session Store            |
|  - Immutable Audit Tables       | |   1M Token Window) | |   128K Token Window|   |  - Distributed Rate Limiter |
+---------------------------------+ +--------------------+ +--------------------+   +-----------------------------+
```

### 6.2 Frontend Architecture (Next.js 14 App Router)
- **Framework**: Next.js 14 utilizing React Server Components (RSC) and Client Components (`'use client'`).
- **Styling Architecture**: Curated Vanilla CSS design systems (`ai-assistant.css`, `calendar.css`, `sidebar.css`) paired with modern utility primitives. Zero bloated framework lock-in.
- **State & Communication**: Unified API client (`api-client.ts`) with automatic Bearer token injection, transparent 401 refresh token rotation, and resilient network failover.

### 6.3 Backend API Gateway (NestJS 10)
- **Controller-Service-Repository Pattern**: Modular domain encapsulation (`AuthModule`, `EmployeesModule`, `PayrollModule`, `AiModule`, `AttendanceModule`, `LeavesModule`).
- **Validation Pipeline**: Global `ValidationPipe` with `whitelist: true` and `forbidNonWhitelisted: true` preventing parameter tampering.
- **OpenAPI / Swagger**: Live interactive documentation generated at `/api/docs`.

### 6.4 Relational Data Layer (PostgreSQL 16 & Prisma ORM)
- Fully normalized relational schema with explicit foreign key cascading, unique compound constraints, and indexed audit mappings.

### 6.5 Asynchronous Task Processing (BullMQ & Redis 7)
- Distributed job processing for compute-heavy payroll calculations, email dispatches, and asynchronous token-level audit offloading.

### 6.6 Dual-Provider AI Inference Pipeline
- **Orchestrator**: `AiOrchestratorService` executes dynamic provider resolution.
- **Circuit Breaker**: Custom three-state state machines (`CLOSED`, `OPEN`, `HALF_OPEN`) tracking rolling failure thresholds and probe recovery windows.

### 6.7 Container & Edge Orchestration (Google Cloud Run)
- Multi-stage Alpine container hosting Nginx, Next.js, NestJS, and embedded PostgreSQL, managed through Knative-compatible autoscaling on Google Cloud Run.

---

## 7. User Interface Requirements

### 7.1 Visual Identity & Typography
- **Primary Font**: `DM Sans` (Clean, modern geometric sans-serif for UI elements, tables, and forms).
- **Display Serif**: `Instrument Serif` (Refined, high-contrast serif for section titles and branding).
- **Monospace Font**: `DM Mono` (Precise monospaced font for code snippets, token counts, currency figures, and latencies).
- **Color Palette**:
  - Background Warm Canvas: `#f7f6f3` / `#f0eeea`
  - Elevated Surface: `#ffffff`
  - Primary Brand Accent: Deep Forest Emerald (`#2c5f4a`)
  - Accent Hover / Glow: `#234d3b` / `rgba(44, 95, 74, 0.12)`
  - Border Structures: `#e2dfda` / `#ece9e4`
  - High-Contrast Text: `#1a1816` (Primary), `#6b6560` (Secondary), `#9b9590` (Tertiary)

### 7.2 Layout Shell & Navigation Mechanics
- Fixed 240px editorial sidebar with brand monogram mark, categorized workspace navigation, live notification badge indicators, and collapsible mobile drawer.
- Top application bar featuring breadcrumb hierarchies, global search shortcut trigger, notification bell, and user profile popover.

### 7.3 State Management & Micro-Interactions
- **Microphone Button Interaction**:
  - Idle: Subtle bordered button with microphone icon.
  - Active Recording: Pulsing crimson glow (`animation: aiMicPulse 1.8s infinite`), animated bounce (`aiMicIconBounce`), and live 5-bar equalizer waveform visualizer.
- **Audio Output Waveforms**:
  - 3-bar animated sound wave bars animating in real time whenever assistant text-to-speech audio is playing.
- **Loading Skeletons**:
  - Smooth pulsating skeleton loaders for tables, cards, and profile avatars replacing jarring spinner freezes.

### 7.4 Form Validation & Error Feedback
- Inline input error states with crimson border accents and contextual hint text.
- Non-intrusive dismissible toast notifications for background task success and warning notifications.

---

## 8. Data Requirements

### 8.1 Primary Data Entities & Relational Schema

```
+--------------------+        +--------------------+        +--------------------+
|       User         | 1    1 |      Employee      | 1    N |     Attendance     |
| - id (UUID, PK)    |───────►| - id (UUID, PK)    |───────►| - id (UUID, PK)    |
| - email (Unique)   |        | - userId (FK)      |        | - employeeId (FK)  |
| - passwordHash     |        | - departmentId (FK)|        | - checkIn (DateTime|
| - roles (Enum[])   |        | - positionId (FK)  |        | - checkOut (Date)  |
+--------------------+        +--------------------+        | - status (Enum)    |
                                 │                │         +--------------------+
                                 │ 1            1 │
                                 ▼ N              ▼ N
                      +--------------------+    +--------------------+
                      |       Leave        |    |    PayrollItem     |
                      | - id (UUID, PK)    |    | - id (UUID, PK)    |
                      | - employeeId (FK)  |    | - employeeId (FK)  |
                      | - leaveType (Enum) |    | - payrollRunId (FK)|
                      | - status (Enum)    |    | - grossSalary (Dec)|
                      | - days (Decimal)   |    | - netSalary (Dec)  |
                      +--------------------+    +--------------------+
```

### 8.2 Entity Relationship Model
- **`User` (1) <---> (1) `Employee`**: Every employee identity corresponds to a secured user account.
- **`Department` (1) <---> (N) `Employee`**: Employees belong to a primary department.
- **`Department` (1) <---> (N) `Department`**: Self-referencing hierarchical structure for organizational trees.
- **`Employee` (1) <---> (N) `Attendance`**: Daily historical time-card records.
- **`Employee` (1) <---> (N) `Leave`**: Historical leave requests and status logs.
- **`Employee` (1) <---> (N) `LeaveBalance`**: Entitlement ledgers tracking total, used, and pending days per leave type.
- **`PayrollRun` (1) <---> (N) `PayrollItem`**: Monthly batch runs containing granular itemized disbursements.
- **`Employee` (1) <---> (N) `PerformanceReview`**: Quarterly appraisal records with manager evaluations.
- **`AuditLog`**: Append-only log entity capturing actor, action, target entity, and timestamp.
- **`AIRequestLog`**: Token-level inference audit tracking prompt tokens, completion tokens, latency, provider, and failover reasons.

### 8.3 Integrity Constraints & Validation Rules
- All primary keys utilize RFC 4122 compliant Version 4 UUIDs.
- Monetary balances, tax rates, and payroll totals use arbitrary-precision `Decimal(12, 2)` to eliminate IEEE 754 floating-point inaccuracies.
- Date ranges strictly enforced via database check constraints (`endDate >= startDate`).

### 8.4 Retention, Archival & Disaster Recovery
- Point-in-time recovery (PITR) supported for PostgreSQL with write-ahead log (WAL) archiving.
- Daily automated database snapshots with 30-day retention policies.
- Terminated employee records soft-deleted via status flag (`employmentStatus = TERMINATED`) to preserve historical payroll and tax compliance registers.

---

## 9. Security Requirements

### 9.1 Authentication & Token Rotation Protocol
- Dual-token architecture:
  - **Access Token**: Short-lived (15 minutes), signed with HMAC-SHA256, carrying user ID, email, and system roles.
  - **Refresh Token**: Long-lived (7 days), cryptographically secure random string hashed with SHA-256 before persistence.
- Automatic Refresh Token Rotation: Every refresh request invalidates the presenting token and issues a new pair. If an invalidated token is re-presented, all sessions for that user are immediately revoked.

### 9.2 Authorization & Contextual Access Control
- Mandatory verification of tenant and organizational boundary scoping. Managers cannot view or mutate records outside their assigned department hierarchy.
- Defense-in-depth: Controllers protected by both endpoint-level role guards and service-layer ownership validators.

### 9.3 Cryptographic Standards
- Data at rest encrypted via AES-256 in storage volumes.
- All network transit encrypted with TLS 1.3.
- Sensitive environment configurations (JWT secrets, API keys) injected via Cloud Run runtime secret managers; never checked into version control.

### 9.4 Mitigation of OWASP Top 10 Vulnerabilities
- **SQL Injection**: Prevented through parameterized queries and Prisma ORM query builder.
- **Cross-Site Scripting (XSS)**: All user inputs sanitized; Next.js automatic React escaping; Content Security Policy (CSP) headers applied via Helmet.
- **Cross-Site Request Forgery (CSRF)**: API design leverages Authorization Bearer headers rather than ambient cookies for state mutation.
- **Brute-Force & Denial of Service**: ThrottlerGuard rate limits API endpoints per IP/User to 100 requests per minute with Redis backing.

---

## 10. Integration Requirements

### 10.1 Dual-Provider AI Inference APIs
- **Primary AI Provider**: Google Gemini API (`@google/generative-ai` SDK) utilizing `gemini-1.5-flash` with a 1,000,000-token context window.
- **Secondary AI Provider**: Groq Cloud API (`groq-sdk`) utilizing `llama-3.3-70b-versatile` with a 128,000-token context window.
- **Failover Logic**: Automated failover triggered on HTTP 429 (Rate Limit), HTTP 5xx (Outage), or network timeout (`> 30,000ms`).

### 10.2 Client-Side Web Speech STT & TTS Integration
- **Speech-to-Text (STT)**: Direct integration with `window.SpeechRecognition` / `webkitSpeechRecognition` with continuous recognition, interim speech event streaming, and silence boundary auto-submission.
- **Text-to-Speech (TTS)**: Direct integration with `window.speechSynthesis` and `SpeechSynthesisUtterance`. Automatic markdown cleansing and sentence-boundary splitting to avoid browser audio buffer cutoffs.

### 10.3 Object Storage Integration (S3 / MinIO)
- S3 SDK client connection for binary assets (avatars, PDFs, resumes).
- Pre-signed authenticated URL generation with 15-minute expirations for private documents.

### 10.4 Redis & Message Broker Integration
- Redis 7.0+ for BullMQ job queue management, distributed caching, and shared rate-limiting states.

---

## 11. Performance Requirements

### 11.1 Latency Benchmarks
| Operation | Target p50 | Target p95 | Target p99 |
| :--- | :---: | :---: | :---: |
| Static Page Asset Delivery | `< 50ms` | `< 120ms` | `< 250ms` |
| User Authentication Login | `< 120ms` | `< 220ms` | `< 400ms` |
| Employee Directory Query (10k rows) | `< 40ms` | `< 95ms` | `< 180ms` |
| Attendance Clock-In Submission | `< 60ms` | `< 130ms` | `< 250ms` |
| Monthly Payroll Run (500 staff) | `< 1200ms` | `< 3500ms` | `< 5000ms` |
| AI Prompt Generation (Gemini) | `< 800ms` | `< 2200ms` | `< 4500ms` |
| AI Voice Recognition Text Streaming | `< 30ms` | `< 75ms` | `< 120ms` |

### 11.2 Throughput & Concurrency Thresholds
- Minimum sustained throughput of 500 requests/second per Cloud Run container.
- Zero error degradation under simulated loads of 1,000 concurrent active browser sessions.

### 11.3 Database Optimization & Indexing Strategies
- B-tree indexing on foreign keys (`employeeId`, `departmentId`, `userId`).
- Compound indexes on audit tables (`[provider, createdAt]`, `[userId, createdAt]`).
- Composite unique indexes on `[employeeId, date]` for attendance and `[employeeId, payrollRunId]` for payroll items.

---

## 12. Testing and Quality Assurance Requirements

### 12.1 Testing Strategy & Pyramid
The testing strategy enforces quality through automated testing tiers:
- **Unit Tests (70%)**: Business logic validation (Payroll calculations, tax brackets, leave accrual, circuit breaker state machine, speech text sanitizers).
- **Integration Tests (20%)**: Controller endpoint testing, JWT authentication flows, database operations with test containers.
- **End-to-End Tests (10%)**: Critical user paths (Login -> Clock In -> Request Leave -> Approve -> Run Payroll -> AI Voice Query).

### 12.2 Automated Test Coverage Targets
- Minimum code coverage target of 85% across core backend services and custom React hooks.
- Mandatory zero-warning policy on TypeScript compilation (`tsc --noEmit`).

### 12.3 Regression, Security & Browser Compatibility Testing
- Automated Jest test suites run on every pull request.
- Automated security scanning for vulnerable dependencies (`pnpm audit`).
- Multi-browser compatibility testing across Chromium, WebKit, and Gecko rendering engines.

---

## 13. Deployment Requirements

### 13.1 Production Environment Specification (Google Cloud Run)
- **Service Name**: `ndems-app`
- **Region**: `us-central1`
- **CPU**: 2 vCPU per container instance (Startup CPU Boost enabled)
- **Memory**: 2 GiB RAM
- **Concurrency**: 160 requests per container instance
- **Autoscaling Boundaries**: Min 0 instances (Scale to zero for cost optimization), Max 10 instances
- **Timeout**: 300 seconds
- **Health Check Probe**: TCP socket probe on port 8080 (Period = 240s, Failure threshold = 1)

### 13.2 Multi-Stage Dockerfile Containerization
- **Stage 1 (Dependencies)**: Base Node 20 Alpine with Corepack enabled; frozen pnpm lockfile installation.
- **Stage 2 (Builder)**: Parallel workspace builds for shared libraries, Prisma database generation, NestJS API build, and Next.js standalone build.
- **Stage 3 (Production Runner)**: Minimal Alpine image containing Nginx, Node 20 runtime, and entrypoint orchestration scripts.

### 13.3 CI/CD Automation & Zero-Downtime Rollouts
- Cloud Build triggers building production container from root `Dockerfile`.
- Automated canary routing: new revisions verified before shifting 100% of live production traffic.

### 13.4 Environment Variables & Secrets Management
| Variable Name | Environment | Description |
| :--- | :--- | :--- |
| `NODE_ENV` | Production | Runtime environment indicator (`production`) |
| `PORT` | Production | Cloud Run container ingress port (`8080`) |
| `NEXT_PUBLIC_API_URL` | Production | Frontend API base URL (`/api/v1`) |
| `JWT_ACCESS_SECRET` | Secret | Cryptographic signing key for access tokens |
| `JWT_REFRESH_SECRET` | ❌ REMOVED | **Removed** (go-live): refresh tokens are opaque, server-side hashed tokens, not JWTs. Do not set — it is ignored. Single source of truth: `apps/api/src/config/configuration.ts`. |
| `GEMINI_API_KEY` | Secret | Google Generative AI API authentication key |
| `GROQ_API_KEY` | Secret | Groq Cloud inference API authentication key |
| `DATABASE_URL` | Secret / Dynamic | PostgreSQL connection string with connection pool config |

---

## 14. Maintenance and Support Requirements

### 14.1 Observability, Health Checks & Telemetry
- **API Health Endpoint**: `GET /api/v1/ai/health` reporting rolling p50/p95 latency, circuit breaker states, and provider health.
- **System Logs**: Structured JSON logs written to stdout, automatically ingested by Google Cloud Logging (Stackdriver).

### 14.2 Database Migrations & Version Control
- Schema changes authored via Prisma migrations (`prisma migrate deploy`).
- Reversibility and backward compatibility required for zero-downtime rollouts.

### 14.3 Incident Response & SLA Tiers
- **Severity 1 (System Down / Payroll Failure)**: Response `< 15 minutes`, Resolution `< 2 hours`.
- **Severity 2 (Degraded Feature / AI Failover Tripped)**: Response `< 1 hour`, Resolution `< 6 hours`.
- **Severity 3 (Minor UI Glitch / Non-Critical Bug)**: Response `< 24 hours`, Resolution in next scheduled release.

---

## 15. Assumptions and Dependencies

### 15.1 Assumptions
1. Client devices possess modern evergreen browsers supporting HTML5 audio and the Web Speech API for voice interactions.
2. Operating jurisdictions enforce standard progressive tax withholding structures and statutory social contribution percentages.
3. Stable outbound internet connectivity exists for communicating with Google Gemini and Groq Cloud inference APIs.

### 15.2 External Dependencies
- Google Cloud Platform (Cloud Run, Cloud Build, Artifact Registry).
- Google Gemini API (`@google/generative-ai`).
- Groq Cloud AI Inference Services (`groq-sdk`).
- NPM / PNPM Package Registries.

---

## 16. Constraints

### 16.1 Technical Constraints
- Monorepo package management must strictly use `pnpm` with workspaces; `npm` and `yarn` are prohibited.
- Application must operate within the 2 GiB RAM threshold allocated to Cloud Run container instances.
- Web Speech API requires HTTPS protocol in production environments to activate browser microphone access.

### 16.2 Business & Regulatory Constraints
- Employee data retention must comply with national labor laws, requiring minimum 7-year storage for payroll and tax deduction ledgers.
- PII must be exportable in machine-readable format upon legitimate employee request.

---

## 17. Acceptance Criteria

| ID | Feature | Verification Method | Acceptance Standard | Status |
| :--- | :--- | :--- | :--- | :---: |
| **AC-01** | User Authentication | Automated Jest / E2E | Valid credentials issue 15-min JWT + 7-day Refresh Token; invalid inputs rejected with 401. | Passed |
| **AC-02** | Attendance Clock-In | Manual / Automated | Clicking "Check In" records UTC timestamp, IP address, and status pill transitions to "Checked In". | Passed |
| **AC-03** | Leave Balance Deduction | Automated Test | Approving 3-day annual leave atomically deducts 3 days from `LeaveBalance.usedDays`. | Passed |
| **AC-04** | Payroll Calculation | Unit Test Suite | Monthly payroll run executes basic, PF, ESI, TDS, and net calculations with zero rounding error. | Passed |
| **AC-05** | AI Voice Input (STT) | Live Browser Test | Clicking mic button streams spoken words live into textarea; auto-submits after 1.8s silence. | Passed |
| **AC-06** | AI Voice Output (TTS) | Live Browser Test | Assistant text response is synthesized into clean spoken audio with markdown stripped out. | Passed |
| **AC-07** | Dual AI Failover | Automated Mock Test | Simulating 429 on Gemini seamlessly routes prompt to Groq without client disruption. | Passed |
| **AC-08** | Cloud Run Deployment | Cloud Verification | `https://ndems-app-knbmj7xqka-uc.a.run.app` serves HTTP 200 with 100% traffic allocated. | Passed |

---

## 18. Future Enhancements

1. **Facial Recognition Attendance**: Biometric facial verification on mobile check-in via WebAssembly-powered OpenCV models.
2. **Multi-Currency Global Payroll**: Dynamic currency exchange integration (Stripe / Wise API) for international contractor disbursements.
3. **Conversational Voice Assistant (Full Duplex)**: Native WebRTC / WebSocket streaming for zero-latency bidirectional voice dialogue with the AI Assistant.
4. **Predictive Attrition Analytics**: Machine learning models predicting employee flight risk based on engagement metrics, leave patterns, and tenure analytics.
5. **Mobile Native Applications**: Progressive Web App (PWA) with offline push notifications and native iOS/Android wrappers.

---
*End of Software Requirement Specification (SRS).*
