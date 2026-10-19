'use strict';
// Logical app removal only. Never delete files from LG's firmware partitions.
var fs=require('fs'),path=require('path');
var file='/var/preferences/com.webos.applicationManager/deletedSystemAppList.json';
var directory='/var/lib/xtream-webos-debloat',backup=directory+'/deleted-system-apps-before.json';
var ids=['amazon.alexa.view','amazon.alexapr','com.webos.app.sportsteamsettings','com.webos.app.lgchannels'];
function merge(value){
  if(!value||!Array.isArray(value.deletedList))throw new Error('Unsupported deletedSystemAppList format.');
  var result=Object.assign({},value);result.deletedList=value.deletedList.slice();
  ids.forEach(function(id){if(result.deletedList.indexOf(id)<0)result.deletedList.push(id);});return result;
}
function write(target,content){fs.writeFileSync(target+'.new',content,{mode:384});fs.renameSync(target+'.new',target);fs.chmodSync(target,384);}
exports.merge=merge;
if(require.main===module){
  try{
    var command=process.argv[2]||'--plan';
    if(['--plan','--apply','--restore'].indexOf(command)<0)throw new Error('Usage: node builtin-apps.js --plan|--apply|--restore');
    if(command==='--plan')console.log('Logical removal preset (requires reboot):\n'+ids.join('\n'));
    else{
      if(process.getuid()!==0)throw new Error('Root is required.');
      if(command==='--restore'){
        // Restore only our added IDs; retain later changes to other applications.
        var old=JSON.parse(fs.readFileSync(backup,'utf8')),current=JSON.parse(fs.readFileSync(file,'utf8'));
        if(!Array.isArray(old.deletedList)||!Array.isArray(current.deletedList))throw new Error('Unsupported list format.');
        current.deletedList=current.deletedList.filter(function(id){return ids.indexOf(id)<0||old.deletedList.indexOf(id)>=0;});
        write(file,JSON.stringify(current));
      }else{
        var original=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'{"deletedList":[]}';
        var result=merge(JSON.parse(original));
        if(!fs.existsSync(directory))fs.mkdirSync(directory,448);
        if(!fs.existsSync(backup))write(backup,original);
        write(file,JSON.stringify(result));
      }
      console.log('Saved. Reboot when ready; firmware app directories remain intact.');
    }
  }catch(e){console.error(e.message);process.exitCode=1;}
}
