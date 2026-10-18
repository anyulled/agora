import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

/**
 * Normalizes an OpenAPI path template (e.g. /api/v1/sessions/{id}/slides/{slideId})
 * into a canonical parameter-placeholder pattern (/api/v1/sessions/:param/slides/:param)
 * for comparison against Worker route regexes.
 */
export function normalizeRoutePattern(routePath) {
  return routePath.replace(/\{[^}]+\}/g, ':param');
}

/**
 * Extracts all /api/v1/... route patterns handled in apps/worker/src/index.ts.
 */
export function extractWorkerRoutes(workerSource) {
  const routes = new Set();

  // Match exact path checks: path === '/api/v1/...'
  const exactRegex = /path\s*===\s*'(\/api\/v1\/[^']+)'/g;
  for (const match of workerSource.matchAll(exactRegex)) {
    routes.add(match[1]);
  }

  // Match regex route patterns: path.match(/^\api\/v1\/...\$/)
  const regexRoutePattern = /path\.match\(\s*\/\^(\\\/api\\\/v1\\\/[^$]+)\$\/\s*\)/g;
  for (const match of workerSource.matchAll(regexRoutePattern)) {
    const rawPattern = match[1].replace(/\\\//g, '/').replace(/\(\[\^\/\]\+\)/g, ':param');
    routes.add(rawPattern);
  }

  return Array.from(routes).sort();
}

/**
 * Validates an OpenAPI 3.1.0 specification object and checks coverage against Worker routes.
 */
export function verifyOpenApiSpec(spec, workerSource) {
  const errors = [];

  if (!spec || typeof spec !== 'object') {
    return {
      passed: false,
      pathCount: 0,
      schemaCount: 0,
      errors: ['OpenAPI spec is not an object'],
    };
  }

  if (spec.openapi !== '3.1.0') {
    errors.push(`Expected openapi version '3.1.0', found '${String(spec.openapi)}'`);
  }

  if (!spec.info?.title || !spec.info?.version) {
    errors.push('Missing required info.title or info.version in OpenAPI spec');
  }

  const paths = spec.paths || {};
  const schemas = spec.components?.schemas || {};
  const securitySchemes = spec.components?.securitySchemes || {};

  const pathKeys = Object.keys(paths);
  const schemaKeys = Object.keys(schemas);

  if (pathKeys.length === 0) {
    errors.push('OpenAPI spec contains 0 paths');
  }
  if (schemaKeys.length === 0) {
    errors.push('OpenAPI spec contains 0 component schemas');
  }
  if (Object.keys(securitySchemes).length === 0) {
    errors.push('OpenAPI spec contains 0 securitySchemes');
  }

  // Verify all $ref pointers resolve to defined component schemas
  const serialized = JSON.stringify(spec);
  const refMatches = serialized.matchAll(/"#\/components\/schemas\/([^"]+)"/g);
  for (const match of refMatches) {
    const schemaName = match[1];
    if (!schemas[schemaName]) {
      errors.push(`Unresolved $ref '#/components/schemas/${schemaName}'`);
    }
  }

  // Verify every route in apps/worker/src/index.ts is documented in OpenAPI paths
  if (workerSource) {
    const workerRoutes = extractWorkerRoutes(workerSource);
    const normalizedOpenApiPaths = new Set(pathKeys.map((p) => normalizeRoutePattern(p)));

    for (const workerRoute of workerRoutes) {
      if (!normalizedOpenApiPaths.has(workerRoute)) {
        errors.push(`Undocumented Worker route in OpenAPI spec: ${workerRoute}`);
      }
    }
  }

  return {
    passed: errors.length === 0,
    pathCount: pathKeys.length,
    schemaCount: schemaKeys.length,
    errors,
  };
}

export function verifyWorkspaceOpenApi() {
  const specPath = path.join(rootDir, 'docs/openapi.json');
  const workerPath = path.join(rootDir, 'apps/worker/src/index.ts');

  if (!fs.existsSync(specPath)) {
    return {
      passed: false,
      pathCount: 0,
      schemaCount: 0,
      errors: ['Missing docs/openapi.json'],
    };
  }

  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const workerSource = fs.existsSync(workerPath) ? fs.readFileSync(workerPath, 'utf8') : '';
  return verifyOpenApiSpec(spec, workerSource);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const report = verifyWorkspaceOpenApi();
  if (!report.passed) {
    console.error(
      '❌ [OpenAPI Verification Failed] Invalid or incomplete OpenAPI 3.1.0 specification:',
    );
    for (const err of report.errors) {
      console.error(`   - ${err}`);
    }
    process.exit(1);
  }
  console.log(
    `✅ OpenAPI 3.1.0 validation passed (${report.pathCount} path(s), ${report.schemaCount} schema(s) verified against Worker routes).`,
  );
}
