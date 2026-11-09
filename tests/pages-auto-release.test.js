'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const workflow=fs.readFileSync('.github/workflows/manual-pages-release.yml','utf8');

test('prelaunch Pages release waits for a successful main push regression',()=>{
 assert.match(workflow,/^  workflow_run:\s*$/m);
 assert.match(workflow,/workflows: \["System regression tests"\]/);
 assert.match(workflow,/types: \[completed\]/);
 assert.match(workflow,/branches: \[main\]/);
 assert.match(workflow,/workflow_run\.conclusion == 'success'/);
 assert.match(workflow,/workflow_run\.event == 'push'/);
 assert.match(workflow,/workflow_run\.head_branch == 'main'/);
 assert.match(workflow,/workflow_run\.head_repository\.full_name == github\.repository/);
 assert.doesNotMatch(workflow,/^  workflow_dispatch:/m);
});

test('Pages deploys the exact tested latest main commit and only frontend files',()=>{
 assert.match(workflow,/ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
 assert.match(workflow,/test "\$\(git rev-parse HEAD\)" = "\$TESTED_SHA"/);
 assert.equal((workflow.match(/git ls-remote origin refs\/heads\/main/g)||[]).length,2);
 assert.match(workflow,/test "\$CURRENT_MAIN" = "\$TESTED_SHA"/);
 assert.match(workflow,/cp index\.html app\.js styles\.css manifest\.webmanifest transaction-rollout-config\.js site\//);
 assert.match(workflow,/cp -R assets modules site\//);
 assert.match(workflow,/actions\/upload-pages-artifact@v3/);
 assert.match(workflow,/actions\/deploy-pages@v4/);
 assert.doesNotMatch(workflow,/^\s*(?:run|uses):.*(?:firebase-tools|firebase deploy|firebase hosting)/im);
});
