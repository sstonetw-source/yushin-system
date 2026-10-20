#!/usr/bin/env node
'use strict';
// Both browser and server consume modules/* as the only editable Core.
// Generated functions/shared copies are required because Firebase uploads
// only functions/ on deployment. Never edit the generated copies directly.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),check=process.argv.includes('--check');
for(const filename of ['inventory-core.js','reservation-core.js','fulfillment-core.js','warehouse-logistics.js','workflow-core.js','procurement-demand-core.js','receiving-core.js','supplier-core.js']){
  const source=fs.readFileSync(path.join(root,'modules',filename));
  const destination=path.join(root,'functions','shared',filename);
  if(check){
    if(!fs.existsSync(destination)||!source.equals(fs.readFileSync(destination))){
      console.error('Functions Core out of sync:',filename);
      process.exitCode=1;
    }
  }else{
    fs.mkdirSync(path.dirname(destination),{recursive:true});
    fs.writeFileSync(destination,source);
    console.log('Generated functions/shared/'+filename);
  }
}
