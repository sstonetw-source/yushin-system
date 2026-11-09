// Prepare the one-time, backend-only Firestore Rules release from the exact
// current rules source. Do not deploy this output without the separate
// production Rules and transaction cutover approvals.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = Object.freeze({
  stockTransferRequests: ['create', 'update'],
  stockTransfers: ['create', 'update'],
  inventory: ['create', 'update'],
  warehouseStocks: ['create', 'update'],
  inventoryReservations: ['create', 'update', 'delete'],
  inventoryLots: ['create', 'update', 'delete'],
  inventoryLotCosts: ['create', 'update', 'delete'],
  inventoryMovements: ['create', 'delete'],
  stockOperations: ['create']
});

const PLANNING_ONLY = `request.resource.data.diff(resource.data).affectedKeys().hasOnly([
          'stockPolicy', 'safetyStock', 'updatedAt',
          'listArchived', 'listArchiveChangedAt',
          'listArchiveChangedByUid', 'listArchiveAuditId'
        ])`;

function replaceAllowedMethod(block, collection, method) {
  const prefix = `      allow ${method}: if `;
  const start = block.indexOf(prefix);
  if (start < 0 || block.indexOf(prefix, start + prefix.length) !== -1) {
    throw new Error(`Expected one exact ${collection}.${method} rule`);
  }
  const end = block.indexOf(';', start);
  if (end < 0) throw new Error(`Unterminated ${collection}.${method} rule`);
  const oldCondition = block.slice(start + prefix.length, end);
  if (!oldCondition.trim()) throw new Error(`Empty ${collection}.${method} rule`);
  const condition = collection === 'inventory' && method === 'update'
    ? `${PLANNING_ONLY}\n        && (${oldCondition.trim()})`
    : 'false';
  return block.slice(0, start) + prefix + condition + ';' + block.slice(end + 1);
}

function buildStockCutoverRules(source) {
  if (typeof source !== 'string' || !source.includes("rules_version = '2';")) {
    throw new Error('Missing Firestore Rules v2 source');
  }
  let rules = source;
  for (const [collection, methods] of Object.entries(TARGETS)) {
    const opening = `    match /${collection}/{id} {`;
    const start = rules.indexOf(opening);
    if (start < 0 || rules.indexOf(opening, start + opening.length) !== -1) {
      throw new Error(`Expected one ${collection} match block`);
    }
    const end = rules.indexOf('\n    }', start);
    if (end < 0) throw new Error(`Unterminated ${collection} match block`);
    const boundary = end + '\n    }'.length;
    let block = rules.slice(start, boundary);
    for (const method of methods) block = replaceAllowedMethod(block, collection, method);
    rules = rules.slice(0, start) + block + rules.slice(boundary);
  }
  return '// BACKEND-ONLY STOCK WRITER CUTOVER: requires separate production authorization.\n'
    + '// Generated from firestore.rules; never use as an implicit fallback.\n' + rules;
}

if (require.main === module) {
  const source = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  const transformed = buildStockCutoverRules(source);
  if (process.argv.length === 3 && process.argv[2] === '--stdout') {
    process.stdout.write(transformed);
  } else if (process.argv.length === 3 && process.argv[2] === '--check') {
    process.stdout.write(`Validated backend-only stock cutover: ${Object.keys(TARGETS).length} collections.\n`);
  } else {
    process.stderr.write('Usage: node tools/build-stock-cutover-rules.cjs --check|--stdout\n');
    process.exitCode = 2;
  }
}

module.exports = { buildStockCutoverRules, TARGETS };
