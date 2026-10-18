/* Frozen PRS exporter captured before the reference-layout change.
 * Sanitized template data lives in PRS-before.xlsx. Keep this independent from
 * the live PRS renderer so preservation tests can detect content regressions.
 * Only its PRS entrypoint is exercised; unused society branches are retained
 * verbatim inside shared original functions to avoid rewriting the baseline.
 */
(function(root){
 'use strict';
 const mappings={PRS:{sheet:'PRS',headerRow:13,columns:['Seq','Title','','Role','Interested Parties','','CAE Number','Share %','Society','Usage','Duration','Work Number'],version:'1.0-reference-template',requirements:{usage:true,duration:true,shares:true}}};
 const layouts={PRS:{sheetPath:'xl/worksheets/sheet1.xml',dataStart:14,dataCapacity:10,dataEnd:24,maxColumn:12,footerStart:25,footerEnd:25,footerMerge:'A25:D25',styleRows:{first:14,body:15,title:17,last:23},rowMerges:[['B','C'],['E','F']]}};
 const layoutFor=society=>layouts[society];
 const colName=index=>{let name='';for(let value=index+1;value;value=Math.floor((value-1)/26))name=String.fromCharCode(65+(value-1)%26)+name;return name;};
 const escapeXml=value=>String(value??'').replace(/_x[0-9a-f]{4}_/gi,match=>'_x005F_'+match.slice(1)).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g,character=>'_x'+character.charCodeAt(0).toString(16).toUpperCase().padStart(4,'0')+'_').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
 const partiesFor=work=>Array.isArray(work?.parties)?work.parties:[];
 function context(project,episode,cues,works,society,artists=[]){
  if(!root.CueSocieties)throw new Error('Society membership rules are unavailable. Refresh the application.');
  const scoped=root.CueSocieties.scope(cues,works,society,artists);cues=scoped.cues;works=scoped.works;
  if(!cues.length)throw new Error('No cues with confirmed '+society+' rights holders. Update artist society memberships before exporting.');
  const ep=project.type==='Movie'?null:(project.episodes||[]).find(item=>Number(item.number)===Number(episode));
  const production=CueDomain.productionFor(project,episode)||{};
  const effective={...project,duration:ep?.duration??project.duration,airdate:ep?.airdate??project.airdate};
  const linked=works.filter(work=>cues.some(cue=>cue.workId===work.id));
  const normalized=cues.map(cue=>{const work=linked.find(item=>item.id===cue.workId),storedUsage=CueDomain.usageFor(cue,society),usage=CueDomain.usageCodes[society]?.includes(storedUsage)?storedUsage:CueDomain.usageFromTitle(work?.title||'',society);return {...cue,usage};});
  return {project:effective,ep,production,cues:normalized,works:linked,time:CueDomain.time,total:CueDomain.time(normalized.reduce((sum,cue)=>sum+(Number(cue.duration)||0),0))};
 }
 function rowsFor(society,ctx){
  const rows=[];
  for(const [index,cue] of ctx.cues.entries()){
   const work=ctx.works.find(item=>item.id===cue.workId)||{title:'',artist:'',isrc:'',societies:{},parties:[]};
   const parties=partiesFor(work);
   if(society==='IPRS'){
    parties.forEach((party,partyIndex)=>rows.push([
     partyIndex?'':work.title,partyIndex?'':cue.usage,partyIndex?'':Number(cue.usageCount)||1,
     partyIndex?'':work.societies?.IPRS||'',partyIndex?'':work.isrc||'',partyIndex?'':ctx.time(cue.duration),
     partyRole(party.role),party.name||'',party.society||'',shareText(party.share),party.ipi||'',
     partyIndex?'':work.artist||'',partyIndex?'':work.research?.url||''
    ]));
    rows.push([]);
   }else if(society==='PRS'){
    parties.forEach((party,partyIndex)=>rows.push([
     partyIndex?'':index+1,partyIndex?'':work.title,'',party.role||'',party.name||'','',party.ipi||'',
     party.share===''||party.share==null||!Number.isFinite(Number(party.share))?'':Number(party.share)/100,
     party.society||'',partyIndex?'':cue.usage,partyIndex?'':ctx.time(cue.duration),partyIndex?'':work.societies?.PRS||''
    ]));
   }else{
    rows.push([index+1,work.title,cue.usage,(Number(cue.duration)||0)/86400,
     parties.filter(isAscapWriter).map(ascapPartyText).filter(Boolean).join('\n'),
     ascapPublishers(work,parties).map(ascapPartyText).filter(Boolean).join('\n'),
     work.societies?.ASCAP||''
    ]);
   }
  }
  return rows;
 }
 function productionUpdates(society,ctx,episode){
  const {project,ep,production,works,total}=ctx,updates=new Map(),put=(cell,value,type='string')=>updates.set(cell,{value,type});
  if(society==='IPRS'){
   iprsMetadata(ctx,episode).forEach(([leftLabel,leftValue,rightLabel,rightValue],index)=>{const row=index+3;put('A'+row,leftLabel);put('B'+row,leftValue);put('G'+row,rightLabel);put('H'+row,rightValue);});
  }else if(society==='PRS'){
   put('C6',project.title);put('G6',production.company);put('J6',project.country||'');put('L6',project.duration);put('C7',ep?.title||project.title);put('G7',project.productionNo);put('J7',project.year);put('L7',total);put('C8',episode??'');put('G8',production.director);put('J8',project.airdate);put('C9',project.filmItemNo||'');put('G9',production.cast);put('J9',project.type==='Movie'?'Movie':'Episode');put('C10',project.altTitle||'');put('G10',project.channel);
  }else{
   put('A1',`${project.title}${project.language?' ('+project.language+' '+project.type+')':''} Cue Sheet`);put('A3','Film Title: '+project.title);put('E3','Company Name: '+(project.ascap?.companyName||production.company||''));put('A4','Episode Title/Number: '+(ep?`${ep.title||''} / ${episode}`:'Movie'));put('E4','Address: '+(project.ascap?.address||''));put('A5','Estimated Airdate: '+(project.airdate||''));put('E5','Phone: '+(project.ascap?.phone||''));put('A6','Program Length: '+(project.duration||''));put('E6','Contact: '+(project.ascap?.contact||production.producer||''));put('A7','Program Type: '+project.type);put('E7','Network Station: '+(project.ascap?.network||project.channel||''));
  }
  return updates;
 }
 function styleAttribute(attributes){const match=String(attributes||'').match(/\bs="([^"]+)"/);return match?` s="${match[1]}"`:'';}
 function cellMarkup(address,entry,attributes=''){
  const style=styleAttribute(attributes),value=entry?.value;
  if(value===''||value==null)return `<c r="${address}"${style}/>`;
  if(entry.type==='number'&&Number.isFinite(Number(value)))return `<c r="${address}"${style}><v>${Number(value)}</v></c>`;
  return `<c r="${address}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
 }
 function rowXml(xml,row){return xml.match(new RegExp(`<row\\b(?=[^>]*\\br="${row}")[^>]*?(?:\\s*\\/>|>[\\s\\S]*?<\\/row>)`))?.[0]||'';}
 function rowBlueprint(xml,row,maxColumn){
  const source=rowXml(xml,row),opening=source.match(/^<row\b([^>]*)/)?.[1]||'',attributes=opening.replace(/\s+r="[^"]*"/,'').replace(/\/$/,'');
  const styles=[];
  for(let column=0;column<maxColumn;column++){
   const address=colName(column)+row,cell=source.match(new RegExp(`<c\\b([^>]*\\br="${address}"[^>]*)`));
   styles.push(cell?.[1]||'');
  }
  return {attributes,styles};
 }
 function generatedRowMarkup(row,values,blueprint,maxColumn){
  const cells=[];
  for(let column=0;column<maxColumn;column++){
   const value=values[column]??'',entry={value,type:typeof value==='number'?'number':'string'};
   cells.push(cellMarkup(colName(column)+row,entry,blueprint.styles[column]||''));
  }
  return `<row r="${row}"${blueprint.attributes}>${cells.join('')}</row>`;
 }
 function addGeneratedMerges(xml,layout,rowCount){
  if(!layout.rowMerges?.length||!rowCount)return xml;
  const existing=new Set([...xml.matchAll(/<mergeCell ref="([^"]+)"\/>/g)].map(match=>match[1])),missing=[];
  for(let offset=0;offset<rowCount;offset++)for(const [from,to] of layout.rowMerges){const row=layout.dataStart+offset,ref=`${from}${row}:${to}${row}`;if(!existing.has(ref)){existing.add(ref);missing.push(`<mergeCell ref="${ref}"/>`);}}
  if(!missing.length)return xml;
  if(/<mergeCells\b/.test(xml))return xml.replace(/<mergeCells\b([^>]*)\bcount="(\d+)"([^>]*)>/,(whole,before,count,after)=>`<mergeCells${before}count="${Number(count)+missing.length}"${after}>`).replace('</mergeCells>',missing.join('')+'</mergeCells>');
  return xml.replace('</worksheet>',`<mergeCells count="${missing.length}">${missing.join('')}</mergeCells></worksheet>`);
 }
  function shiftFooter(xml,layout,shift){
  if(!shift)return xml;
  const saved=[];
  for(let row=layout.footerStart;row<=layout.footerEnd;row++){
   const pattern=new RegExp(`<row\\b(?=[^>]*\\br="${row}")[^>]*?(?:\\s*\\/>|>[\\s\\S]*?<\\/row>)`),match=xml.match(pattern);
   if(match){saved.push({row,xml:match[0]});xml=xml.replace(pattern,'');}
  }
  const targetStart=layout.footerStart+shift,targetEnd=layout.footerEnd+shift;
  for(let row=targetStart;row<=targetEnd;row++)xml=xml.replace(new RegExp(`<row\\b(?=[^>]*\\br="${row}")[^>]*?(?:\\s*\\/>|>[\\s\\S]*?<\\/row>)`),'');
  const moved=saved.map(item=>item.xml.replace(new RegExp(`(<row\\b[^>]*\\br=")${item.row}("[^>]*>)`),`$1${item.row+shift}$2`).replace(new RegExp(`r="([A-Z]+)${item.row}"`,'g'),`r="$1${item.row+shift}"`)).join('');
  const rows=[...xml.matchAll(/<row\b(?=[^>]*\br="(\d+)")[^>]*>/g)],next=rows.find(match=>Number(match[1])>targetEnd),insertAt=next?.index??xml.indexOf('</sheetData>');
  xml=xml.slice(0,insertAt)+moved+xml.slice(insertAt);
  const [left,right]=layout.footerMerge.split(':').map(address=>{const match=address.match(/^([A-Z]+)(\d+)$/);return match?match[1]+(Number(match[2])+shift):address;});
  return xml.replace(`ref="${layout.footerMerge}"`,`ref="${left}:${right}"`);
 }
  function transformSheet(xml,society,rows,updates,layout=layouts[society]){
  const shift=Math.max(0,rows.length-layout.dataCapacity),footerStart=layout.footerStart+shift,seen=new Set(),styleRows=layout.styleRows;
  const blueprints={first:rowBlueprint(xml,styleRows.first,layout.maxColumn),body:rowBlueprint(xml,styleRows.body,layout.maxColumn),title:rowBlueprint(xml,styleRows.title||styleRows.body,layout.maxColumn),last:rowBlueprint(xml,styleRows.last,layout.maxColumn)};
  xml=shiftFooter(xml,layout,shift);
  const cellPattern=/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  xml=xml.replace(cellPattern,(whole,attributes)=>{
   const address=attributes.match(/\br="([A-Z]+\d+)"/)?.[1];if(!address)return whole;
   const match=address.match(/^([A-Z]+)(\d+)$/),row=Number(match?.[2]),column=match?match[1].split('').reduce((value,char)=>value*26+char.charCodeAt(0)-64,0):0;
   if(updates.has(address)){seen.add(address);return cellMarkup(address,updates.get(address),attributes);}
   if(row>=layout.dataStart&&row<footerStart&&column>=1&&column<=layout.maxColumn)return cellMarkup(address,null,attributes);
   return whole;
  });
  const generated=[];
  rows.forEach((values,index)=>{
   const targetRow=layout.dataStart+index,existing=rowXml(xml,targetRow);if(existing)xml=xml.replace(existing,'');
   let kind=index===0?'first':society==='PRS'&&values[1]?'title':'body';
   if(rows.length>=layout.dataCapacity&&index===rows.length-1)kind='last';
   generated.push(generatedRowMarkup(targetRow,values,blueprints[kind],layout.maxColumn));
  });
  if(generated.length){
   const lastRow=layout.dataStart+rows.length-1,following=[...xml.matchAll(/<row\b(?=[^>]*\br="(\d+)")[^>]*>/g)].find(match=>Number(match[1])>lastRow),insertAt=following?.index??xml.indexOf('</sheetData>');
   xml=xml.slice(0,insertAt)+generated.join('')+xml.slice(insertAt);
  }
  xml=addGeneratedMerges(xml,layout,rows.length);
  const missing=[...updates.keys()].filter(address=>!seen.has(address));
  for(const address of missing){
   const coordinate=address.match(/^([A-Z]+)(\d+)$/),column=coordinate[1],row=Number(coordinate[2]),entry=updates.get(address);
   const styleSource=[...xml.matchAll(new RegExp(`<c\\b([^>]*\\br="${column}\\d+"[^>]*)`,'g'))].map(match=>match[1]).find(attributes=>{const sourceRow=Number(attributes.match(/\\br="[A-Z]+(\\d+)"/)?.[1]);return sourceRow>=layout.dataStart&&sourceRow<layout.footerStart;})||'';
   const markup=cellMarkup(address,entry,styleSource),rowPattern=new RegExp(`<row\\b(?=[^>]*\\br="${row}")[^>]*?(?:\\s*\\/>|>[\\s\\S]*?<\\/row>)`),rowMatch=xml.match(rowPattern);
   if(rowMatch){
    let rowXml=rowMatch[0],inserted=false;
    if(/\/>$/.test(rowXml)){rowXml=rowXml.replace(/\/>$/,`>${markup}</row>`);inserted=true;}
    rowXml=rowXml.replace(/<c\b[^>]*\br="([A-Z]+)\d+"[^>]*(?:\/>|>[\s\S]*?<\/c>)/g,(cell,existingColumn)=>{if(!inserted&&existingColumn.localeCompare(column,undefined,{numeric:true})>0){inserted=true;return markup+cell;}return cell;});
    if(!inserted)rowXml=rowXml.replace('</row>',markup+'</row>');
    xml=xml.replace(rowPattern,rowXml);
   }else{
    const rowXml=`<row r="${row}">${markup}</row>`,following=[...xml.matchAll(/<row\b(?=[^>]*\br="(\d+)")[^>]*>/g)].find(match=>Number(match[1])>row),insertAt=following?.index??xml.indexOf('</sheetData>');
    xml=xml.slice(0,insertAt)+rowXml+xml.slice(insertAt);
   }
  }
  return xml;
 }
 function templateBase64(society){
  if(root.CueExportTemplateData?.[society])return root.CueExportTemplateData[society];
  if(typeof require==='function'&&typeof __dirname!=='undefined'){
   const fs=require('node:fs'),path=require('node:path');return fs.readFileSync(path.join(__dirname,'../../public',society+'-verification.xlsx')).toString('base64');
  }
  throw new Error(`${society} reference workbook is unavailable.`);
 }
 function decodeBase64(value){
  if(typeof Buffer!=='undefined')return Uint8Array.from(Buffer.from(value,'base64'));
  const binary=atob(value),bytes=new Uint8Array(binary.length);for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);return bytes;
 }
 function zipLibrary(){if(root.JSZip)return root.JSZip;if(typeof require==='function'&&typeof __dirname!=='undefined')return require('../../public/vendor/jszip.min.js');throw new Error('Excel template engine is unavailable.');}
 async function buildFormatted(society,project,episode,cues,works,artists=[]){
  if(!mappings[society])throw new Error('Unsupported society format: '+society);
  const ctx=context(project,episode,cues,works,society,artists),rows=rowsFor(society,ctx),updates=productionUpdates(society,ctx,episode),Zip=zipLibrary(),zip=await Zip.loadAsync(decodeBase64(templateBase64(society))),layout=layoutFor(society,project),source=zip.file(layout.sheetPath);
  if(!source)throw new Error(`${society} reference worksheet is missing.`);
  let xml=await source.async('string');if(society==='IPRS'&&project.type==='Movie')xml=iprsMovieTemplate(xml);
  xml=transformSheet(xml,society,rows,updates,layout);
  if(society==='IPRS'){
   const formatted=formatIprsSongGroups(xml,await zip.file('xl/styles.xml').async('string'),rows,layout);
   xml=formatted.xml;zip.file('xl/styles.xml',formatted.styles);
  }
  zip.file(layout.sheetPath,xml);
  return zip.generateAsync({type:'uint8array',compression:'DEFLATE',compressionOptions:{level:6}});
 }

 root.CuePrsBefore={buildFormatted};
})(window);
