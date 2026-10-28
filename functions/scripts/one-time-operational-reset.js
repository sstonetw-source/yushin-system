'use strict';

// One-time maintenance CLI. This file is never imported by Cloud Functions.
const { applicationDefault, initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldPath } = require('firebase-admin/firestore');
const {
  DELETE_COLLECTIONS, ZERO_STOCK_COLLECTIONS, STOCK_FIELDS,
  classifyRootCollections, stockResetPatch
} = require('../operational-reset-policy');

const ALLOWED_PROJECTS = new Set(['yu-shing-company', 'preview-20135']);
const PAGE_SIZE = 250;
const RESET_MARKER = 'one-time-admin-operational-reset';

function readArguments(argv) {
  const options = { execute: false, skipBackup: false, writesFrozen: false };
  for (const arg of argv) {
    if (arg.startsWith('--project=')) options.project = arg.slice('--project='.length);
    else if (arg.startsWith('--confirm=')) options.confirm = arg.slice('--confirm='.length);
    else if (arg === '--execute') options.execute = true;
    else if (arg === '--skip-backup') options.skipBackup = true;
    else if (arg === '--writes-frozen') options.writesFrozen = true;
    else throw new Error('Unknown argument: ' + arg);
  }
  if (!ALLOWED_PROJECTS.has(options.project)) throw new Error('Explicit approved --project is required');
  if (options.execute) {
    if (!options.skipBackup || !options.writesFrozen ||
        options.confirm !== 'DELETE-OLD-OPERATIONS:' + options.project) {
      throw new Error('Execute requires --skip-backup, --writes-frozen and exact --confirm=DELETE-OLD-OPERATIONS:' + options.project);
    }
  }
  return options;
}

async function eachStockPage(db, name, visit) {
  let last = null;
  while (true) {
    let query = db.collection(name).orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (last) query = query.startAfter(last);
    const snapshot = await query.get();
    if (snapshot.empty) break;
    await visit(snapshot.docs);
    last = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < PAGE_SIZE) break;
  }
}

async function scanStock(db, name) {
  const info = { documents: 0, nonzeroDocuments: 0, documentsWithLots: 0 };
  await eachStockPage(db, name, async docs => {
    for (const doc of docs) {
      const data = doc.data();
      try { stockResetPatch(data, RESET_MARKER, 'preflight'); }
      catch (error) { throw new Error(doc.ref.path + ': ' + error.message); }
      info.documents++;
      if (STOCK_FIELDS.some(key => typeof data[key] === 'number' && data[key] !== 0)) info.nonzeroDocuments++;
      if (Array.isArray(data.lots) && data.lots.length) info.documentsWithLots++;
    }
  });
  return info;
}

async function inspect(db) {
  const roots = await db.listCollections();
  const classification = classifyRootCollections(roots.map(ref => ref.id));
  if (classification.unknown.length) {
    throw new Error('Unknown root collections: ' + classification.unknown.join(', ') + '. Update allowlists before proceeding.');
  }
  const deleteCounts = {};
  for (const name of classification.deleting) {
    const result = await db.collection(name).count().get();
    // Only root documents are counted. recursiveDelete also removes subcollections.
    deleteCounts[name] = result.data().count;
  }
  const stock = {};
  for (const name of ZERO_STOCK_COLLECTIONS) stock[name] = await scanStock(db, name);
  return { classification, deleteRootDocumentCounts: deleteCounts, stock };
}

async function deleteOperationalCollections(db, names) {
  const sorted = names.filter(name => name !== 'auditLogs');
  if (names.includes('auditLogs')) sorted.push('auditLogs');
  for (const name of sorted) {
    process.stdout.write('Deleting collection and subcollections: ' + name + '\n');
    await db.recursiveDelete(db.collection(name));
  }
}

async function zeroStock(db, name) {
  let updated = 0;
  await eachStockPage(db, name, async docs => {
    const batch = db.batch();
    const updatedAt = new Date().toISOString();
    for (const doc of docs) {
      batch.set(doc.ref, stockResetPatch(doc.data(), RESET_MARKER, updatedAt), { merge: true });
    }
    await batch.commit();
    updated += docs.length;
    process.stdout.write('Reset ' + name + ': ' + updated + ' documents\n');
  });
  return updated;
}

async function verify(db, expectedPreserve) {
  const roots = (await db.listCollections()).map(ref => ref.id);
  const cls = classifyRootCollections(roots);
  if (cls.unknown.length || cls.deleting.length) throw new Error('Delete roots remain or unknown root appeared: ' + JSON.stringify(cls));
  for (const name of expectedPreserve) {
    if (!roots.includes(name)) throw new Error('Preserved root disappeared: ' + name);
  }
  const inventory = {};
  for (const name of ZERO_STOCK_COLLECTIONS) {
    const summary = await scanStock(db, name);
    if (summary.nonzeroDocuments || summary.documentsWithLots) throw new Error('Stock not fully zeroed: ' + name);
    inventory[name] = summary;
  }
  return { remainingRoots: roots.sort(), inventory };
}

async function main() {
  const args = readArguments(process.argv.slice(2));
  const config = process.env.FIRESTORE_EMULATOR_HOST
    ? { projectId: args.project }
    : { projectId: args.project, credential: applicationDefault() };
  initializeApp(config);
  const db = getFirestore();
  const preflight = await inspect(db);
  process.stdout.write(JSON.stringify({ mode: args.execute ? 'EXECUTE' : 'DRY_RUN', project: args.project, preflight }, null, 2) + '\n');
  if (!args.execute) {
    process.stdout.write('Dry-run only: no documents changed. Nested document counts are not included.\n');
    return;
  }
  // Requires user to have disabled all app/worker writes before execution.
  await deleteOperationalCollections(db, preflight.classification.deleting);
  for (const name of ZERO_STOCK_COLLECTIONS) await zeroStock(db, name);
  const result = await verify(db, preflight.classification.preserving);
  process.stdout.write(JSON.stringify({ status: 'VERIFIED', project: args.project, result }, null, 2) + '\n');
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write('Reset incomplete; keep all writers frozen. Safe to rerun after investigation. ' + error.stack + '\n');
    process.exitCode = 1;
  });
}

module.exports = { readArguments };
