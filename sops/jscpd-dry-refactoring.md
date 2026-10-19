# Standard Operating Procedure: jscpd & DRY Refactoring

## Overview
Agora enforces a **3% maximum total duplication threshold** to match SonarCloud's new-code duplication quality gate, plus a **10% per-file guard** across packages, apps, harness infrastructure, and backend services. The `jscpd` tool is integrated into the mechanical verification pipeline (`harness/verify-duplication.mjs`) and configured via [`.jscpd.json`](../.jscpd.json). SonarCloud measures changed code while this local detector measures the configured local source set, so the scope differs even though the total threshold is aligned.

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
1. **Identify Hotspots**: Review the summary report for total duplication exceeding `3%` or any file exceeding the `10%` per-file guard.
2. **Inspect Clone Pairs**: Examine the source blocks indicated by `jscpd`.
3. **Determine Scope**:
   - Intra-file duplication: Extract private helper functions or loops.
   - Cross-file duplication: Move shared logic into `packages/domain`, `packages/application`, or a shared utility module.

## DRY Extraction Strategies
- **Extract Shared Helper Function**: Move repeated procedural logic into a standalone utility function with clear parameters.
- **Parameterize Common Handler Logic**: Generalize duplicate route/command handlers by passing configuration objects or handlers.
- **Extract Module / Constant**: Consolidate shared validation schemas, constants, or domain types into centralized modules.
