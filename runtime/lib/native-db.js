'use strict';
var fs=require('fs'),path=require('path'),u=require('./util');
var template=require('../native-template.json');
var columns=Object.keys(template);
var edits=['user_fav_chan_gr','fav_chan_gr_a','fav_chan_gr_b','fav_chan_gr_c','fav_chan_gr_d','fav_chan_gr_e','fav_chan_gr_f','fav_chan_gr_g','fav_chan_gr_h','favoriteIdxA','favoriteIdxB','favoriteIdxC','favoriteIdxD','favoriteIdxE','favoriteIdxF','favoriteIdxG','favoriteIdxH','skipped_flag','locked_flag','chan_gr_list'];
function* statements(catalog,preserve) {
  yield 'BEGIN IMMEDIATE;';yield 'CREATE TEMP TABLE xtream_import AS SELECT * FROM ip WHERE 0;';
  for(var i=0;i<catalog.channels.length;i++){
    var c=catalog.channels[i];
    var r=Object.assign({},template,{dvc_chan_id:c.nativeId,chan_no:String(c.number),maj_no:c.number,chan_no_int:c.number,chan_code:c.code,org_code:c.code,chan_std_name:c.name,channelNameSortKey:c.name,signal_chan_id:c.nativeId,online_chan_id:c.nativeId+'_'+c.code,ip_chan_service_url:'http://127.0.0.1:17651/streams/'+c.id+'.m3u8',chanGenreCode:String(c.genreCode),chanGenre:c.categoryName,reserved_1:'XTREAM',channelMajMinNo:('00000'+c.number).slice(-5)+'-65535'});
    yield 'INSERT INTO xtream_import('+columns.join(',')+') VALUES('+columns.map(function(k){return u.sql(r[k]);}).join(',')+');';
  }
  // Keep changes made through LG's own channel editor and favourite lists.
  yield 'CREATE INDEX xtream_import_id ON xtream_import(dvc_chan_id);';
  if(preserve!==false)yield 'UPDATE xtream_import SET '+edits.map(function(k){return k+'=(SELECT ip.'+k+' FROM ip WHERE ip.dvc_chan_id=xtream_import.dvc_chan_id LIMIT 1)';}).join(',')+' WHERE EXISTS(SELECT 1 FROM ip WHERE ip.dvc_chan_id=xtream_import.dvc_chan_id);';
  yield "DELETE FROM ip WHERE substr(chan_code,1,7)='xtream_';";
  yield 'INSERT INTO ip('+columns.join(',')+') SELECT '+columns.join(',')+' FROM xtream_import;';
  yield "DELETE FROM pbs_genre_base WHERE genre_type='S' AND reserved_1='XTREAM';";
  for(var j=0;j<catalog.categories.length;j++){var category=catalog.categories[j];yield 'INSERT OR REPLACE INTO pbs_genre_base(genre_code,genre_type,version,genre_name,use_flag,reserved_1,genreFavoritePoint) VALUES('+u.sql(String(category.genreCode))+",'S','xtream-1',"+u.sql(category.name)+",'1','XTREAM',0);";}
  yield 'COMMIT;';
}
function script(catalog,preserve){return Array.from(statements(catalog,preserve)).join('\n');}
function apply(catalog,db,preserve){return u.sqlite(db,statements(catalog,preserve));}
exports.apply=apply;exports.script=script;
