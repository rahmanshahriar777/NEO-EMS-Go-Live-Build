# ADR-0002 — Payroll: single compute home, Decimal/minor-unit money, currency precision

Date: 2026-10-05 · Status: accepted (consolidation pending — owner: worker 3)

## Context

Payroll math currently exists in two mirrors: the API's payroll service
(run orchestration + per-employee computation) and the worker's
`payroll-math.ts` (pure functions, deliberately dependency-free), each with a
comment warning they must be kept in sync manually. `CurrencyUtil` hardcoded
100 minor units, wrong for JPY/KRW (0) and KWD/BHD (3). The assessment
mandates Decimal end-to-end and a currency precision setting.

## Decision

1. **One compute home**: `packages/shared/src/payroll/` is the designated
   location. `types.ts` pins the compute contract (`PayrollComputeInput` →
   `ComputedPayslip`); `currency.ts` owns ISO-4217 minor-unit precision.
   Worker 3 moves `computePayslip` here; API and worker import it; the
   mirrors are deleted. Until then, changes apply to both and must satisfy
   the contract types.
2. **Money as integer minor units internally**, converted at the edges with
   currency-aware precision (`toMinorUnits`/`fromMinorUnits`). Prisma Decimal
   fields map to minor-unit integers in code — never floats in arithmetic.
3. **Canonical formula** (current behaviour, pinned by tests):
   `gross = base + Σ earnings`, `net = max(0, gross − deductions)`.
   KNOWN BUG (Phase 2): `PERCENTAGE_OF_GROSS` is computed off base salary,
   not gross. Fixing it changes the contract deliberately — it is NOT a
   silent fix; payslip outputs change and parallel-run reconciliation must
   cover two cycles.
4. **Precision map**: `CURRENCY_MINOR_UNITS`; unknown currencies default to
   2 (documented assumption). `PAYROLL_CURRENCY` selects the run currency.

## Consequences

- The worker's "zero infrastructure" unit tests keep working: the shared
  module stays dependency-free (no Prisma, no Nest).
- Rounding policy (half-up via Math.round at minor-unit conversion) is now
  explicit and shared — previously implicit in two places.

## Alternatives considered

- decimal.js in shared: heavier; integer minor units are sufficient and
  faster for payroll volumes. Revisit if multi-currency FX conversion lands.
