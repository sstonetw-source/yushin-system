'use strict';

// One-time maintenance CLI. This file is never imported by Cloud Functions.
const fs = require('node:fs');
const path = require('node:path');
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
  const options = { execute: false, skipBackup: false, writesFrozen: false, database: '(default)' };
  for (const arg of argv) {
    if (arg.startsWith('--project=')) options.project = arg.slice('--project='.length);
    else if (arg.startsWith('--database=')) options.database = arg.slice('--database='.length);
    else if (arg.startsWith('--journal=')) options.journal = arg.slice('--journal='.length);
    else if (arg.startsWith('--confirm=')) options.confirm = arg.slice('--confirm='.length);
    else if (arg === '--execute') options.execute = true;
    else if (arg === '--skip-backup') options.skipBackup = true;
    else if (arg === '--writes-frozen') options.writesFrozen = true;
    else throw new Error('Unknown argument: ' + arg);
  }
  if (!ALLOWED_PROJECTS.has(options.project)) throw new Error('Explicit approved --project is required');
  if (options.database !== '(default)') throw new Error('Only Firestore (default) is supported');
  if (options.journal && (!path.isAbsolute(options.journal) || !options.journal.endsWith('.json') ||
      !path.basename(options.journal).includes(options.project))) {
    throw new Error('Journal must be an absolute .json path including the project ID');
  }
  if (options.execute) {
    if (!options.journal || !options.skipBackup || !options.writesFrozen ||
        options.confirm !== 'DELETE-OLD-OPERATIONS:' + options.project) {
      throw new Error('Execute requires --journal, --skip-backup, --writes-frozen and exact --confirm=DELETE-OLD-OPERATIONS:' + options.project);
    }
  }
  return options;
}


function readJournal(filename, project) {
  if (!filename || !fs.existsSync(filename)) return null;
  const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (data?.project !== project || data?.database !== '(default)' ||
      !Array.isArray(data.completedDeletes) || !data.preserveRootDocumentCounts ||
      !['IN_PROGRESS','FAILED','VERIFIED'].includes(data.status))
    throw new Error('Journal content or project/database mismatch; do not run a reset');
  return data;
}
function saveJournal(filename, journal) {
  const pending = filename + '.pending';
  // Fail before changing Firestore if local progress cannot be made durable.
  fs.writeFileSync(pending, JSON.stringify({...journal,updatedAt:new Date().toISOString()},null,2),{mode:0o600});
  fs.renameSync(pending, filename);
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
  const preserveCounts = {};
  for (const name of classification.preserving) {
    const result = await db.collection(name).count().get();
    preserveCounts[name] = result.data().count;
  }
  const stock = {};
  for (const name of ZERO_STOCK_COLLECTIONS) stock[name] = await scanStock(db, name);
  return { classification, deleteRootDocumentCounts: deleteCounts, preserveRootDocumentCounts: preserveCounts, stock };
}

async function deleteOperationalCollections(db, names, onCompleted = async () => {}) {
  const sorted = names.filter(name => name !== 'auditLogs');
  if (names.includes('auditLogs')) sorted.push('auditLogs');
  for (const name of sorted) {
    process.stdout.write('Deleting collection and subcollections: ' + name + '\n');
    await db.recursiveDelete(db.collection(name));
    await onCompleted(name);
  }
}

async function zeroStock(db, name, onProgress = async () => {}) {
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
    await onProgress(updated);
  });
  return updated;
}

async function verify(db, expectedPreserveCounts) {
  const roots = (await db.listCollections()).map(ref => ref.id);
  const cls = classifyRootCollections(roots);
  if (cls.unknown.length || cls.deleting.length) throw new Error('Delete roots remain or unknown root appeared: ' + JSON.stringify(cls));
  for (const [name, expectedCount] of Object.entries(expectedPreserveCounts)) {
    if (!roots.includes(name)) throw new Error('Preserved root disappeared: ' + name);
    const currentCount = (await db.collection(name).count().get()).data().count;
    if (currentCount !== expectedCount) throw new Error('Preserved root document count changed: ' + name);
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
  const previous = readJournal(args.journal, args.project);
  process.stdout.write(JSON.stringify({ mode: args.execute ? 'EXECUTE' : 'DRY_RUN',
    project: args.project, database: args.database, preflight,
    previousRun: previous ? {status:previous.status,stage:previous.stage,
      completedDeletes:previous.completedDeletes,stockProgress:previous.stockProgress} : null
  },null,2)+'\n');
  if (!args.execute) {
    process.stdout.write('Dry-run only: no documents changed. Nested document counts are not included.\n');
    return;
  }
  if (previous?.status === 'VERIFIED')
    throw new Error('This one-time reset is already verified; do not execute it again');
  // A local exclusive lock prevents concurrent CLI resets using the same journal.
  const lockFile = args.journal + '.lock';
  const lock = fs.openSync(lockFile, 'wx', 0o600);
  try {
  const journal = previous || {
    project: args.project, database: args.database,
    status: 'IN_PROGRESS', stage: 'PREFLIGHT',
    startedAt: new Date().toISOString(),
    preserveRootDocumentCounts: preflight.preserveRootDocumentCounts,
    initialDeleteCounts: preflight.deleteRootDocumentCounts,
    completedDeletes: [], stockProgress: {}
  };
  if (previous) journal.status = 'IN_PROGRESS';
  saveJournal(args.journal, journal);
  // External maintenance controls MUST keep every writer frozen throughout this process.
  try {
    await deleteOperationalCollections(db, preflight.classification.deleting, async name => {
      if (!journal.completedDeletes.includes(name)) journal.completedDeletes.push(name);
      journal.stage = 'DELETED:' + name;
      saveJournal(args.journal, journal);
    });
    for (const name of ZERO_STOCK_COLLECTIONS) {
      await zeroStock(db, name, async count => {
        journal.stockProgress[name] = count;
        journal.stage = 'ZEROING:' + name;
        saveJournal(args.journal, journal);
      });
      journal.stage = 'ZEROED:' + name;
      saveJournal(args.journal, journal);
    }
    const result = await verify(db, journal.preserveRootDocumentCounts);
    journal.status = 'VERIFIED';
    journal.stage = 'VERIFIED';
    journal.verification = result;
    saveJournal(args.journal, journal);
    process.stdout.write(JSON.stringify({status:'VERIFIED',project:args.project,
      database:args.database,journal:args.journal,result},null,2)+'\n');
  } catch (error) {
    journal.status = 'FAILED';
    journal.failure = String(error.message || error).slice(0,1000);
    try { saveJournal(args.journal, journal); }
    catch (journalError) { process.stderr.write('Journal write failed: '+journalError.message+'\n'); }
    throw error;
  }
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockFile);
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write('Reset incomplete; keep all writers frozen. Safe to rerun after investigation. ' + error.stack + '\n');
    process.exitCode = 1;
  });
}

module.exports = { readArguments, readJournal, saveJournal };
