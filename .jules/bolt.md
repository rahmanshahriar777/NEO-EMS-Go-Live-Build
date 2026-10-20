## 2024-03-01 - React.memo / useMemo Performance Pattern
**Learning:** The Sidebar component recalculates the navSections array (which includes multiple hasRole calls and array mutations) on every render, even though the user roles rarely change. This can cause unnecessary re-renders or performance drops, especially if used widely in a layout component.
**Action:** Wrapping expensive or static layout calculations in useMemo based on user roles will prevent unnecessary work on every path change or avatar modal state change.
