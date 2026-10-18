# Standard Operating Procedure: jscpd & DRY Refactoring

## Overview
Agora enforces a strict **< 10%** code duplication threshold across all packages, apps, harness infrastructure, and backend services. The `jscpd` tool is integrated into the mechanical verification pipeline (`harness/verify-duplication.mjs`) and configured via [`.jscpd.json`](../.jscpd.json).

## Running Duplication Checks
Execute the duplication verification script directly:
```bash
node harness/verify-duplication.mjs
```
Or run `jscpd` via pnpm:
```bash
npx jscpd --reporters ai --summary packages apps harness infrastructure
```

## Clone Kinds & Understanding Reports
`jscpd` categorizes clones into several kinds:
- **`exact`**: Identical blocks of code duplicated across files or within the same file.
- **`(renamed)`**: Identical code structure with variable or identifier renaming.
- **`[~N gap]`**: Duplication with minor gaps or interspersed statements.
- **`[~N ast]`**: Abstract Syntax Tree level structural duplication.

## Triage Checklist
1. **Identify Hotspots**: Review the summary report for any files exceeding the `10%` threshold or total duplication exceeding `10%`.
2. **Inspect Clone Pairs**: Examine the source blocks indicated by `jscpd`.
3. **Determine Scope**:
   - Intra-file duplication: Extract private helper functions or loops.
   - Cross-file duplication: Move shared logic into `packages/domain`, `packages/application`, or a shared utility module.

## DRY Extraction Strategies
- **Extract Shared Helper Function**: Move repeated procedural logic into a standalone utility function with clear parameters.
- **Parameterize Common Handler Logic**: Generalize duplicate route/command handlers by passing configuration objects or handlers.
- **Extract Module / Constant**: Consolidate shared validation schemas, constants, or domain types into centralized modules.
