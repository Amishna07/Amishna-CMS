/* domain.js */

(function (root) {
  'use strict';
  const fields = {title:'Work title',start:'IN time',end:'OUT time',duration:'Duration',usage:'Usage',episode:'Episode',workId:'Work ID',isrc:'ISRC',societyId:'Society Work ID',composer:'Composer',source:'Source / ownership',notes:'Notes'};
  const aliases = {title:['trackname','musictitle','worktitle','cuetitle','songtitle','title','songtitletrackname'],start:['intime','starttime','in','start'],end:['outtime','endtime','out','end'],duration:['duration','timing','durationhhmmss'],usage:['usage','cuetype','use','characteristics'],episode:['episode','episodeno','episodenumber'],workId:['workid','internalworkid'],isrc:['isrc'],societyId:['societyworkid','iprsid','prsid','ascapid'],composer:['composer','composers'],source:['source','ownership','sourcetype'],notes:['notes','remarks']};
  const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu,'');
  function autoMap(headers) {return headers.map(h=>Object.keys(aliases).find(key=>aliases[key].includes(normalize(h)))||'');}
  function detectHeader(rows) {let best=0,score=0;rows.slice(0,40).forEach((r,i)=>{const m=autoMap(r);const n=m.filter(Boolean).length+(m.includes('title')?3:0);if(n>score){score=n;best=i;}});return best;}
  function seconds(value) {
    if(value === '' || value == null) return null;
    if(typeof value === 'number') return Number.isFinite(value)&&value>=0?Math.round(value*86400):NaN;
    const text=String(value).trim(),match=text.match(/^(\d+):([0-5]\d)(?::([0-5]\d))?$/);
    if(match)return match[3] === undefined?Number(match[1])*60+Number(match[2]):Number(match[1])*3600+Number(match[2])*60+Number(match[3]);
    const human=text.match(/^(?:(\d+)\s*h(?:ours?)?\s*)?(?:(\d+)\s*m(?:in(?:ute)?s?)?\s*)?(?:(\d+)\s*s(?:ec(?:ond)?s?)?\s*)?$/i);
    if(!human||!human.slice(1).some(value=>value!==undefined))return NaN;
    return Number(human[1]||0)*3600+Number(human[2]||0)*60+Number(human[3]||0);
  }
  const time = n => n==null||!Number.isFinite(n)?'—':[Math.floor(n/3600),Math.floor(n%3600/60),Math.floor(n%60)].map(x=>String(x).padStart(2,'0')).join(':');
  function musicUsagePercent(cue,project){
    const stored=cue?.usagePercent;
    if(stored!==''&&stored!==null&&stored!==undefined)return Number.isFinite(Number(stored))?{value:Number(stored),source:'stored'}:{value:null,source:'invalid'};
    const episode=project?.type==='Movie'?null:project?.episodes?.find(item=>Number(item.number)===Number(cue?.episode));
    const programSeconds=seconds(episode?.duration||project?.duration);
    if(!Number.isFinite(cue?.duration)||cue.duration<0||!Number.isFinite(programSeconds)||programSeconds<=0)return {value:null,source:'unavailable'};
    return {value:cue.duration/programSeconds*100,source:'calculated'};
  }
  function fixedWorkfile(rows) {
    if(!Array.isArray(rows)||rows.length<3)return null;
    let headerIndex=-1,hasHeader=false;
    for(let index=1;index<Math.min(rows.length,12);index++){
      const cueRow=(rows[index]||[]).slice(0,4),mapping=autoMap(cueRow),suppliedDuration=seconds(cueRow[2]);
      const isHeader=mapping.length>=4&&mapping[0]==='start'&&mapping[1]==='end'&&mapping[2]==='duration'&&mapping[3]==='title';
      const isCue=Number.isFinite(seconds(cueRow[0]))&&Number.isFinite(seconds(cueRow[1]))&&(suppliedDuration===null||Number.isFinite(suppliedDuration))&&String(cueRow[3]??'').trim()!=='';
      if(isHeader||isCue){headerIndex=index;hasHeader=isHeader;break;}
    }
    if(headerIndex<0)return null;
    const top=rows[0]||[],episodeMatch=String(top[4]??'').trim().match(/\d+/),episodeNumber=episodeMatch?Number(episodeMatch[0]):null;
    return {format:'fixed-workfile-v1',headerIndex,dataStartIndex:hasHeader?headerIndex+1:headerIndex,hasHeader,totalDuration:top[0]??'',totalDurationSeconds:seconds(top[0]),date:top[1]??'',serialName:String(top[2]??'').trim(),episodeNumber:Number.isInteger(episodeNumber)&&episodeNumber>0?episodeNumber:null};
  }
  function validateFixedWorkfile(workfile,timing={}) {
    if(!workfile)return [];
    const errors=[];
    if(!Number.isFinite(workfile.totalDurationSeconds)||workfile.totalDurationSeconds<=0)errors.push('A1 must contain a valid positive total duration');
    const dateText=String(workfile.dateDisplay??workfile.date??'').trim(),parsedDate=new Date(dateText);
    if(!dateText||!Number.isFinite(parsedDate.getTime())||parsedDate.getFullYear()<1900||parsedDate.getFullYear()>2100)errors.push('B1 must contain a real content date');
    if(!workfile.serialName||/^(?:episode|serial|movie|project)\s*name$/i.test(workfile.serialName.trim()))errors.push('C1 must contain the actual serial or movie name');
    if(!Number.isInteger(workfile.episodeNumber)||workfile.episodeNumber<1)errors.push('E1 must contain a positive episode or work number');
    if(Number.isFinite(workfile.totalDurationSeconds)&&Number.isFinite(timing.end)&&timing.end>workfile.totalDurationSeconds)errors.push('OUT time exceeds the total duration in A1');
    return errors;
  }
  function combineImportedOccurrences(workspace) {
    if(!Array.isArray(workspace?.cues))return false;
    const groups=new Map();
    for(const cue of workspace.cues){
      if(!(cue.importedFromWorkfile||cue.importSourceKey||cue.occurrences?.length)||!cue.projectId||!cue.workId)continue;
      const key=JSON.stringify([cue.projectId,cue.episode??null,cue.workId]);
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push(cue);
    }
    const removed=new Set();let changed=false;
    for(const group of groups.values()){
      if(group.length<2||new Set(group.map(cue=>cue.usage||'')).size>1)continue;
      const keeper=group[0],occurrences=group.flatMap(cue=>Array.isArray(cue.occurrences)&&cue.occurrences.length?cue.occurrences:[{start:cue.start??null,end:cue.end??null,duration:cue.duration,rowNumber:null,importSourceKey:cue.importSourceKey,importFingerprint:cue.importFingerprint,notes:cue.notes||'',importWarnings:cue.importWarnings||[],importedValues:cue.importedValues||{}}]);
      keeper.occurrences=occurrences;keeper.duration=occurrences.reduce((sum,use)=>sum+(Number(use.duration)||0),0);keeper.usageCount=occurrences.length;keeper.start=null;keeper.end=null;keeper.importedFromWorkfile=true;
      keeper.importWarnings=[...new Set(group.flatMap(cue=>cue.importWarnings||[]))];keeper.mergedCueIds=[...new Set(group.flatMap(cue=>[cue.id,...(cue.mergedCueIds||[])]))];
      for(const cue of group.slice(1))removed.add(cue.id);
      changed=true;
    }
    if(changed)workspace.cues=workspace.cues.filter(cue=>!removed.has(cue.id));
    return changed;
  }
  function validateOccurrenceRows(rows,programDuration=null) {
    const errors=[],normalized=[],seenTimes=new Set();
    if(!Array.isArray(rows)||!rows.length)return {errors:['Keep at least one entry'],occurrences:[],duration:0,title:''};
    const title=String(rows[0].title||'').trim();
    if(!title)errors.push('Entry 1 needs a track name');
    rows.forEach((row,index)=>{
      const name=String(row.title||'').trim(),start=seconds(row.startText),end=seconds(row.endText),label='Entry '+(index+1);
      if(!name)errors.push(label+' needs a track name');
      if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start){errors.push(label+' needs valid IN and OUT times, with OUT after IN');return;}
      if(Number.isFinite(programDuration)&&programDuration>0&&end>programDuration)errors.push(label+' OUT time exceeds the episode duration');
      const timingKey=normalize(name)+'|'+start+'|'+end;if(seenTimes.has(timingKey))errors.push(label+' duplicates another entry’s IN and OUT times');seenTimes.add(timingKey);
      normalized.push({...row,title:name,start,end,duration:end-start});
    });
    return {errors,occurrences:normalized,duration:normalized.reduce((sum,row)=>sum+row.duration,0),title};
  }
  function candidates(row,works) {
    const exact=works.filter(w=>(row.workId&&normalize(w.id)===normalize(row.workId))||(row.isrc&&normalize(w.isrc)===normalize(row.isrc))||(row.societyId&&Object.values(w.societies||{}).some(id=>normalize(id)===normalize(row.societyId))));
    if(exact.length)return {items:exact,confident:exact.length===1};
    const byTitle=works.filter(w=>[w.title,...(w.alternateTitles||[])].some(t=>normalize(t)===normalize(row.title)));
    const confirmed=byTitle.filter(w=>row.composer&&w.parties.some(p=>p.role==='Composer'&&normalize(p.name)===normalize(row.composer)));
    return {items:confirmed.length?confirmed:byTitle,confident:confirmed.length===1&&!row.workId&&!row.isrc&&!row.societyId};
  }
  function validateRow(row) {
    const errors=[],warnings=[];
    if(!String(row.title||'').trim())errors.push('Work title is required');
    const start=seconds(row.start),end=seconds(row.end),supplied=seconds(row.duration);
    let duration=null;
    if(start===null&&end===null){if(supplied===null||!Number.isFinite(supplied)||supplied<=0)errors.push('Valid IN / OUT times or a positive duration are required');else{duration=supplied;warnings.push('Duration only: IN / OUT times need review');}}
    else if(start===null||end===null||!Number.isFinite(start)||!Number.isFinite(end))errors.push('IN and OUT must both be valid HH:MM:SS times');
    else if(end<=start)errors.push('OUT time must be after IN time');
    else{duration=end-start;if(supplied!==null&&(!Number.isFinite(supplied)||Math.abs(supplied-duration)>1))errors.push('Supplied duration differs from IN / OUT');}
    const usages=['BI','BV','FI','FV','OI','OV','CI','CV','MT','ET','VI','VV','T','B','V'];
    if(!row.usage)warnings.push('Usage is missing; society export will be blocked');
    else if(!usages.includes(String(row.usage).toUpperCase()))errors.push('Unrecognized usage code');
    return {errors,warnings,start,end,duration};
  }
  function validateExport(cues,works,society,project) {
    const issues=[];
    if(!cues.length)issues.push({message:'This content has no cues',level:'error'});
    cues.forEach(c=>{
      const w=works.find(w=>w.id===c.workId),add=message=>issues.push({message,workId:w?.id,cueId:c.id,level:'error'});
      if(!w){add('Cue has no linked Work');return;}
      if(!String(w.title||'').trim())add('Cue / song name is required');
      const usage=usageSetForCue(c,w.title,w)[society];
      if(!usage)add(w.title+': Music usage is required');
      else if(!usageCodes[society].includes(usage))add(w.title+': Music usage “'+usage+'” needs a valid '+society+' mapping');
      if(!Number.isFinite(Number(c.duration))||Number(c.duration)<=0)add(w.title+': music duration is required');
      const parties=Array.isArray(w.parties)?w.parties:[];
      if(!parties.length)add(w.title+': add at least one contributor with ownership shares');
      else{
        if(parties.some(p=>!String(p.name||'').trim()||p.share==null||String(p.share).trim()===''||!Number.isFinite(Number(p.share))||Number(p.share)<0||Number(p.share)>100))add(w.title+': every contributor needs a name and share between 0 and 100%');
        const total=parties.reduce((sum,p)=>sum+(Number.isFinite(Number(p.share))?Number(p.share):0),0);
        if(Math.abs(total-100)>.01)add(w.title+': contributor shares total '+Number(total.toFixed(2))+'%; they must total exactly 100%');
      }
    });return issues;
  }
  const exportRequirements={
    IPRS:{usage:true,duration:true,shares:true},
    PRS:{usage:true,duration:true,shares:true},
    ASCAP:{usage:true,duration:true,shares:true}
  };
  const usageCodes={IPRS:['BI','BV','FI','FV','OI','OV','CI','CV'],PRS:['B','V','F','T'],ASCAP:['MT','ET','VI','VV','BI','BV','T']};
  function titleUsageKind(title){
    const words=String(title??'').normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
    if(words.includes('background')||words.includes('bg'))return 'background';
    if(words.some((word,index)=>word==='opening'&&words[index+1]==='title'))return 'opening-title';
    return 'default';
  }
  function usageFromTitle(title,society){
    const kind=titleUsageKind(title),codes={
      IPRS:{background:'BI','opening-title':'OI',default:'FV'},
      PRS:{background:'B','opening-title':'F',default:'F'},
      ASCAP:{background:'BI','opening-title':'MT',default:'VI'}
    };
    return codes[society]?.[kind]||'';
  }
  const usageSetForTitle=title=>Object.fromEntries(['IPRS','PRS','ASCAP'].map(society=>[society,usageFromTitle(title,society)]));
  const equivalentUsage={
    IPRS:{B:'BI',V:'FV',F:'FI',T:'OI',MT:'OI',ET:'CI',VI:'FI',VV:'FV'},
    PRS:{BI:'B',BV:'B',VI:'V',VV:'V',FI:'F',FV:'F',OI:'T',OV:'T',CI:'T',CV:'T',MT:'T',ET:'T',T:'T'},
    ASCAP:{FI:'VI',FV:'VV',OI:'MT',OV:'MT',CI:'ET',CV:'ET',B:'BI',V:'VI',F:'VI'}
  };
  function usageFor(c,society,title){
    const saved=c.societyUsage?.[society];
    if(saved!==''&&saved!=null)return saved;
    for(const code of [c.usage,...Object.entries(c.societyUsage||{}).filter(([source,value])=>usageCodes[source]?.includes(value)).map(([,value])=>value)]){
      if(usageCodes[society]?.includes(code))return code;
      if(equivalentUsage[society]?.[code])return equivalentUsage[society][code];
    }
    return arguments.length>=3?usageFromTitle(title,society):'';
  }
  const usageSetForCue=(cue,title,work)=>Object.fromEntries(['IPRS','PRS','ASCAP'].map(society=>[society,usageFor({...cue,societyUsage:{...cue.societyUsage,...Object.fromEntries(Object.entries(work?.societyUsage||{}).filter(([,value])=>value!==''&&value!=null))}},society,title)]));
  const usageSetForWork=work=>usageSetForCue(work,work.title);
  function applyTitleUsage(workspace){
    if(!workspace||!Array.isArray(workspace.works))return false;
    const liveCues=workspace.cues||[],liveCueSet=new Set(liveCues),cuesByWork=new Map();
    for(const cue of liveCues){if(!cuesByWork.has(cue.workId))cuesByWork.set(cue.workId,[]);cuesByWork.get(cue.workId).push(cue);}
    const works=new Map(workspace.works.map(work=>[work.id,work])),cues=[...liveCues,...(workspace.deletedCues||[]).map(record=>record?.cue).filter(Boolean)];
    let changed=false;
    for(const work of workspace.works){
      const next={...work.societyUsage};
      for(const society of ['IPRS','PRS','ASCAP']){
        if(next[society]!==''&&next[society]!=null)continue;
        const values=[...new Set((cuesByWork.get(work.id)||[]).map(cue=>usageFor(cue,society,work.title)).filter(code=>usageCodes[society].includes(code)))];
        if(values.length===1){next[society]=values[0];changed=true;}
      }
      if(Object.keys(next).length)work.societyUsage=next;
    }
    for(const cue of cues){
      const work=works.get(cue.workId);if(!work)continue;
      const next={...cue.societyUsage};let cueChanged=false;
      if(liveCueSet.has(cue)){
        for(const society of ['IPRS','PRS','ASCAP']){
          const saved=work.societyUsage?.[society];
          if(saved!==''&&saved!=null&&next[society]!==saved){next[society]=saved;cueChanged=true;}
        }
        if(next.IPRS!==''&&next.IPRS!=null&&cue.usage!==next.IPRS){cue.usage=next.IPRS;cueChanged=true;}
      }
      for(const society of ['IPRS','PRS','ASCAP'])if(next[society]===''||next[society]==null){next[society]=usageSetForCue(cue,work.title,work)[society];cueChanged=true;}
      if(cue.usage===''||cue.usage==null){cue.usage=next.IPRS;cueChanged=true;}
      if(cueChanged){cue.societyUsage=next;changed=true;}
    }
    return changed;
  }
  function validatePeriods(periods){const errors=[];for(let i=0;i<periods.length;i++){const p=periods[i];if(!Number.isInteger(p.from)||!Number.isInteger(p.to)||p.from<1||p.to<p.from)errors.push('Production ranges need positive episode numbers with From ≤ To');for(let j=0;j<i;j++)if(p.from<=periods[j].to&&p.to>=periods[j].from)errors.push('Production periods must not overlap');}return [...new Set(errors)];}
  function productionFor(project,episode){if(project.type==='Movie')return project.periods[0]||null;const matches=project.periods.filter(p=>episode>=p.from&&episode<=p.to);return matches.length===1?matches[0]:null;}
  const api={fields,normalize,autoMap,detectHeader,seconds,time,musicUsagePercent,fixedWorkfile,validateFixedWorkfile,combineImportedOccurrences,validateOccurrenceRows,candidates,validateRow,validateExport,exportRequirements,usageCodes,titleUsageKind,usageFromTitle,usageSetForTitle,usageSetForCue,usageSetForWork,usageFor,applyTitleUsage,validatePeriods,productionFor};
  root.CueDomain=api;if(typeof module!=='undefined')module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:window);

/* file-safety.js — shared bounds before untrusted workbook parsing. */
(function(root){
  'use strict';
  const limits={bytes:10*1024*1024,expanded:64*1024*1024,entry:24*1024*1024,entries:2048,sheets:250,sourceSheets:2000,sourceExpanded:128*1024*1024,sourceEntries:16384,rows:10002,columns:100,cells:1000000};
  const fail=message=>{throw new Error(message);};
  function csvRows(text){
    let delimiter=',',quoted=false,counts={',':0,';':0,'\t':0};
    for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"')i++;else quoted=!quoted;}else if(!quoted){if(c==='\r'||c==='\n')break;if(Object.hasOwn(counts,c))counts[c]++;}}
    delimiter=Object.keys(counts).sort((a,b)=>counts[b]-counts[a])[0];
    const rows=[];let row=[],value='',inQuote=false,closed=false;
    function cell(){if(row.length>=limits.columns)fail('Import at most 100 columns at a time.');row.push(value);value='';closed=false;}
    function line(){cell();if(rows.length>=limits.rows)fail('Import at most 10,000 data rows at a time.');rows.push(row);row=[];}
    for(let i=0;i<text.length;i++){
      const c=text[i];
      if(inQuote){if(c==='"'){if(text[i+1]==='"'){value+='"';i++;}else{inQuote=false;closed=true;}}else value+=c;}
      else if(c===delimiter)cell();
      else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;line();}
      else if(c==='"'&&!value&&!closed)inQuote=true;
      else if(closed||c==='"')fail('Malformed CSV quoting. Save the file as CSV again and retry.');
      else value+=c;
      if(value.length>32767)fail('A spreadsheet cell exceeds 32,767 characters.');
    }
    if(inQuote)fail('The CSV contains an unfinished quoted cell.');
    if(value||row.length||closed)line();
    return rows;
  }
  function validateWorkbook(workbook,library){
    if(!workbook.SheetNames?.length)fail('No worksheet found.');
    if(workbook.SheetNames.length>limits.sheets)fail('Import at most 250 worksheets at a time.');
    let cells=0;
    for(const name of workbook.SheetNames){
      const sheet=workbook.Sheets[name];if(!sheet)fail('A worksheet is missing.');
      const ref=sheet['!fullref']||sheet['!ref'];if(!ref)continue;
      if(!/^[A-Z]+\d+(?::[A-Z]+\d+)?$/.test(ref))fail('A worksheet has an invalid cell range.');
      const range=library.utils.decode_range(ref);
      if(range.e.r>=limits.rows)fail('Import at most 10,000 data rows at a time.');
      if(range.e.c>=limits.columns)fail('Import at most 100 columns at a time.');
      // Excel templates often style hundreds of empty rows. Keep the declared
      // range bounds above, then preview only through the last populated cell.
      let lastRow=0,lastColumn=0,hasValues=false;
      for(const address of Object.keys(sheet)){
        if(!/^[A-Z]+[1-9]\d*$/.test(address))continue;
        const cell=sheet[address];
        if(!cell||cell.v===undefined&&cell.f===undefined)continue;
        const position=library.utils.decode_cell(address);
        if(position.r>=limits.rows)fail('Import at most 10,000 data rows at a time.');
        if(position.c>=limits.columns)fail('Import at most 100 columns at a time.');
        lastRow=Math.max(lastRow,position.r);lastColumn=Math.max(lastColumn,position.c);hasValues=true;
      }
      cells+=(lastRow+1)*(lastColumn+1);if(cells>limits.cells)fail('This workbook is too large to preview safely. Split it into smaller files.');
      sheet['!ref']=hasValues?'A1:'+library.utils.encode_cell({r:lastRow,c:lastColumn}):'A1';
    }
    return workbook;
  }
  async function inspectZip(bytes,{source=false}={}){
    if(!root.JSZip)fail('Workbook validation is unavailable. Refresh and retry.');
    const zip=await root.JSZip.loadAsync(bytes),files=Object.values(zip.files).filter(file=>!file.dir);
    const entryLimit=source?limits.sourceEntries:limits.entries,expandedLimit=source?limits.sourceExpanded:limits.expanded;
    if(files.length>entryLimit)fail('The workbook contains too many archive entries.');
    if(!zip.file('[Content_Types].xml')||!zip.file('xl/workbook.xml'))fail('Choose a valid Excel XLSX workbook.');
    let declared=0,expanded=0;
    for(const file of files){
      const name=file.unsafeOriginalName||file.name;
      if(/(^|[\\/])\.\.([\\/]|$)|^[\\/]|^[A-Za-z]:/.test(name))fail('The workbook contains an unsafe archive path.');
      const size=file._data?.uncompressedSize;
      if(!Number.isSafeInteger(size)||size<0||size>limits.entry||(declared+=size)>expandedLimit)fail('The workbook expands beyond the safe import size.');
    }
    // Count real output as well as ZIP metadata; pause immediately on a forged size.
    for(const file of files)await new Promise((resolve,reject)=>{
      let count=0,ended=false;const stream=file.internalStream('uint8array');
      stream.on('data',chunk=>{count+=chunk.length;expanded+=chunk.length;if(count>limits.entry||expanded>expandedLimit){ended=true;stream.pause();reject(new Error('The workbook expands beyond the safe import size.'));}})
        .on('error',error=>{if(!ended){ended=true;reject(error);}}).on('end',()=>{if(!ended)resolve();}).resume();
    });
  }
  function checkFile(file,extensions){
    const extension=String(file?.name||'').split('.').pop().toLowerCase();
    if(!extensions.includes(extension))fail('Choose a '+extensions.map(value=>'.'+value).join(' or ')+' file.');
    if(!Number.isFinite(file.size)||file.size<=0||file.size>limits.bytes)fail('Choose a non-empty workbook of 10 MB or less.');
    const mime=String(file.type||'').split(';')[0].toLowerCase();
    if(mime&&!['application/octet-stream','application/zip','application/x-zip-compressed','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-excel','application/csv','text/csv','text/plain','text/tab-separated-values'].includes(mime))fail('The file type does not match a supported spreadsheet.');
    return extension;
  }
  async function inspect(file){
    const extension=checkFile(file,['xlsx','xls','csv']);
    if(extension==='csv')return {sheetNames:['Sheet1'],size:file.size};
    const bytes=new Uint8Array(await file.arrayBuffer());
    if(extension==='xlsx'){
      if(bytes[0]!==80||bytes[1]!==75||bytes[2]!==3||bytes[3]!==4)fail('The file is not an XLSX workbook.');
      await inspectZip(bytes,{source:true});
    }else if(![208,207,17,224,161,177,26,225].every((byte,index)=>bytes[index]===byte))fail('The file is not an Excel XLS workbook.');
    let workbook;try{workbook=root.XLSX.read(bytes,{type:'array',bookSheets:true,bookVBA:false,cellFormula:false,cellHTML:false});}catch{fail('The workbook is unreadable, corrupted or encrypted.');}
    const names=workbook.SheetNames;
    if(!Array.isArray(names)||!names.length||names.length>limits.sourceSheets||new Set(names).size!==names.length)fail('Choose a workbook with 1 to 2,000 uniquely named worksheets.');
    return {sheetNames:names,size:file.size};
  }
  async function read(file,{extensions=['xlsx','xls','csv'],sheetNames=null,...options}={}){
    const extension=checkFile(file,extensions);
    if(sheetNames!==null&&(!Array.isArray(sheetNames)||!sheetNames.length||sheetNames.length>limits.sheets||new Set(sheetNames).size!==sheetNames.length))fail('Select 1 to 250 worksheets before preview.');
    const bytes=new Uint8Array(await file.arrayBuffer());if(!bytes.length||bytes.length>limits.bytes)fail('Choose a non-empty workbook of 10 MB or less.');
    let workbook;
    if(extension==='csv'){
      const encoding=bytes[0]===255&&bytes[1]===254?'utf-16le':bytes[0]===254&&bytes[1]===255?'utf-16be':'utf-8';
      let text;try{text=new TextDecoder(encoding,{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');}catch{fail('The CSV is not valid UTF-8 or UTF-16 text. Save it as CSV UTF-8 and retry.');}
      if(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text))fail('The CSV contains binary data.');
      const rows=csvRows(text);workbook=root.XLSX.utils.book_new();root.XLSX.utils.book_append_sheet(workbook,root.XLSX.utils.aoa_to_sheet(rows),'Sheet1');
    }else{
      if(extension==='xlsx'){if(bytes[0]!==80||bytes[1]!==75||bytes[2]!==3||bytes[3]!==4)fail('The file is not an XLSX workbook.');await inspectZip(bytes,{source:sheetNames!==null});}
      else if(![208,207,17,224,161,177,26,225].every((byte,index)=>bytes[index]===byte))fail('The file is not an Excel XLS workbook.');
      try{workbook=root.XLSX.read(bytes,{...options,type:'array',sheetRows:limits.rows,cellHTML:false,cellFormula:false,bookVBA:false,...(sheetNames?{sheets:sheetNames}:{})});}catch{fail('The workbook is unreadable, corrupted or encrypted.');}
    }
    if(sheetNames){
      if(sheetNames.some(name=>!workbook.SheetNames.includes(name)||!workbook.Sheets[name]))fail('The selected worksheets changed. Choose the file again.');
      workbook.SheetNames=[...sheetNames];workbook.Sheets=Object.fromEntries(sheetNames.map(name=>[name,workbook.Sheets[name]]));
    }
    return validateWorkbook(workbook,root.XLSX);
  }
  root.CueFileSafety={limits,inspect,read,csvRows,validateWorkbook};
})(globalThis);

/* data.js */
/* A new installation starts with a completely empty workspace. */
window.CueSeed = () => ({
  version: 1,
  works: [],
  artists: [],
  projects: [],
  cues: [],
  clients: [],
  imports: [],
  exports: [],
  profiles: [],
  members: [],
  repositories: [],
  deletedCues: [],
  activity: []
});

/* supplied society workbook templates */
window.CueExportTemplateData={"IPRS":"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","PRS":"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","ASCAP":"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"};
/* exports.js */
/* Society mappings and workbook generation based on the supplied reference files.
   Browser downloads patch the original XLSX package directly, preserving its styling. */
(function(root){
 'use strict';
 const mappings={
  IPRS:{sheet:'Cue Sheet',headerRow:15,columns:['SONG TITLE / TRACK NAME','CHARACTERISTICS','NO. OF USAGE','Internal No/Song Code','ISRC','DURATION (HH:MM:SS)','ROLE(C / A / E)','NAMES OF COMPOSER / AUTHOR / PUBLISHER','SOCIETY','SHARE','IPI NO.','SINGER','VALIDATION LINK (IF SONG CODE IS NOT AVAILABLE)'],version:'1.1-movie-series-template',requirements:{usage:true,duration:true,shares:true}},
  PRS:{sheet:'PRS',headerRow:18,columns:['Seq','Title','','Role','Interested Parties','','CAE Number','Share %','Society','Usage','Duration','Work Number'],version:'1.1-reference-layout',requirements:{usage:true,duration:true,shares:true}},
  ASCAP:{sheet:'ASCAP',headerRow:9,columns:['Cue #','Cue Title','Use*','Timing','Composer(s) Affiliation / %','Publisher(s) Affiliation / %','Work ID (ASCAP)'],version:'1.1-reference-template-200-percent',requirements:{usage:true,duration:true,shares:true}}
 };
 const layouts={
  IPRS:{sheetPath:'xl/worksheets/sheet1.xml',dataStart:16,dataCapacity:15,dataEnd:30,maxColumn:13,footerStart:31,footerEnd:36,footerMerge:'A36:F36',styleRows:{first:16,body:17,last:29}},
  PRS:{sheetPath:'xl/worksheets/sheet1.xml',dataStart:19,dataCapacity:11,dataEnd:30,maxColumn:12,footerStart:31,footerEnd:31,footerMerge:'A31:D31',styleRows:{first:19,body:22,last:23,single:29}},
  ASCAP:{sheetPath:'xl/worksheets/sheet1.xml',dataStart:10,dataCapacity:5,dataEnd:15,maxColumn:7,footerStart:16,footerEnd:20,footerMerge:'A20:F20',styleRows:{first:10,body:11,last:14}}
 };
 const iprsMovieMapping={...mappings.IPRS,headerRow:12,columns:mappings.IPRS.columns.map((label,index)=>index===1?'Code':label)};
 const iprsMovieLayout={...layouts.IPRS,dataStart:13,dataEnd:27,footerStart:28,footerEnd:33,footerMerge:'A33:F33',styleRows:{first:13,body:14,last:26}};
 const mappingFor=(society,project)=>society==='IPRS'&&project?.type==='Movie'?iprsMovieMapping:mappings[society];
 const layoutFor=(society,project)=>society==='IPRS'&&project?.type==='Movie'?iprsMovieLayout:layouts[society];
 const colName=index=>{let name='';for(let value=index+1;value;value=Math.floor((value-1)/26))name=String.fromCharCode(65+(value-1)%26)+name;return name;};
 const escapeXml=value=>String(value??'').replace(/_x[0-9a-f]{4}_/gi,match=>'_x005F_'+match.slice(1)).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g,character=>'_x'+character.charCodeAt(0).toString(16).toUpperCase().padStart(4,'0')+'_').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
 const exportRole=role=>({Lyricist:'Author','Lyricist / Author':'Author','Composer / Lyricist':'Composer / Author','Composer + Lyricist / Author':'Composer / Author'})[role]||role||'';
 const partyRole=role=>({Composer:'C',Author:'A','Composer / Author':'CA',Publisher:'E'})[exportRole(role)]||exportRole(role);
 const shareText=value=>value===''||value==null||!Number.isFinite(Number(value))?'':String(Number(value))+'%';
 const ascapShareText=value=>value===''||value==null||!Number.isFinite(Number(value))?'':String(Number((Number(value)*2).toFixed(6)))+'%';
 const ascapRole=party=>String(party?.role||'').normalize('NFKC').trim().toLowerCase().replace(/[^a-z]/g,'');
 const isAscapPublisher=party=>{const role=ascapRole(party);return role.includes('publisher')||role.includes('publishing')||role.includes('label');};
 const isAscapWriter=party=>{const role=ascapRole(party);return !isAscapPublisher(party)&&['composer','author','lyricist','writer'].some(value=>role.includes(value));};
 const exportAffiliation=(party,society)=>root.CueSocieties.isNonMember(party)?(society==='IPRS'?'NS':'Non Member'):party.society||root.CueSocieties.memberships(party).join('/');
 const ascapPartyText=party=>{const affiliation=exportAffiliation(party,'ASCAP')||root.CueSocieties.memberships(party).join('/');return `${party.name||''}${affiliation?' ('+affiliation+')':''}${ascapShareText(party.share)?' '+ascapShareText(party.share):''}`.trim();};
 function ascapPublishers(work,parties){
  const publishers=parties.filter(isAscapPublisher),label=String(work?.label||'').trim();
  if(!work?._exportSociety&&label&&!publishers.some(party=>String(party.name||'').trim().toLocaleLowerCase()===label.toLocaleLowerCase()))publishers.push({name:label,role:'Label',society:'',share:null});
  return publishers;
 }
 const partiesFor=work=>Array.isArray(work?.parties)?work.parties:[];
 function context(project,episode,cues,works,society,artists=[],options={}){
  if(!root.CueSocieties)throw new Error('Society membership rules are unavailable. Refresh the application.');
  const workIds=new Set(works.map(work=>work.id));
  if(cues.some(cue=>!workIds.has(cue.workId)))throw new Error('Cue has no linked Work. Restore the song before exporting.');
  const scoped=root.CueSocieties.scope(cues,works,society,artists,options);cues=scoped.cues;works=scoped.works;
  if(!cues.length)throw new Error(society==='ASCAP'&&options.membershipPolicy==='recorded-affiliations-v1'?'No cues are available for this ASCAP-format export.':'No cues with confirmed '+society+' rights holders. Update artist society memberships before exporting.');
  const ep=project.type==='Movie'?null:(project.episodes||[]).find(item=>Number(item.number)===Number(episode));
  const production=CueDomain.productionFor(project,episode)||{};
  const effective={...project,duration:ep?.duration??project.duration,airdate:ep?.airdate??project.airdate};
  const linked=works.filter(work=>cues.some(cue=>cue.workId===work.id));
  const normalized=cues.map(cue=>{
   const work=linked.find(item=>item.id===cue.workId),usage=CueDomain.usageSetForCue(cue,work.title,work)[society];
   if(!CueDomain.usageCodes[society]?.includes(usage))throw new Error(work.title+': Music usage '+usage+' needs a valid '+society+' mapping');
   return {...cue,usage};
  });
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
     partyRole(party.role),party.name||'',exportAffiliation(party,society),shareText(party.share),party.ipi||'',
     partyIndex?'':work.artist||'',partyIndex?'':work.research?.url||''
    ]));
    rows.push([]);
   }else if(society==='PRS'){
    parties.forEach((party,partyIndex)=>rows.push([
     partyIndex?'':index+1,partyIndex?'':work.title,'',exportRole(party.role),party.name||'','',party.ipi||'',
     party.share===''||party.share==null||!Number.isFinite(Number(party.share))?'':Number(party.share)/100,
     exportAffiliation(party,society),partyIndex?'':cue.usage,partyIndex?'':ctx.time(cue.duration),partyIndex?'':work.societies?.PRS||''
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
  if(ctx.project.exportRange)episode=ctx.project.exportRange.from+'-'+ctx.project.exportRange.to;
  const {project,ep,production,works,total}=ctx,updates=new Map(),put=(cell,value,type='string')=>updates.set(cell,{value,type});
  if(society==='IPRS'){
   iprsMetadata(ctx,episode).forEach(([leftLabel,leftValue,rightLabel,rightValue],index)=>{const row=index+3;put('A'+row,leftLabel);put('B'+row,leftValue);put('G'+row,rightLabel);put('H'+row,rightValue);});
  }else if(society==='PRS'){
   put('C7',project.title);put('G7',production.company);put('J7',project.country||'');put('L7',project.duration);put('C9',ep?.title||project.title);put('G9',project.productionNo);put('J9',project.year);put('L9',total);put('C11',episode??'');put('G11',production.director);put('J11',project.airdate);put('C13',project.filmItemNo||'');put('G13',production.cast);put('J13',project.type==='Movie'?'Movie':'Episode');put('C15',project.altTitle||'');put('G15',project.channel);
  }else{
   put('A1',`${project.title}${project.language?' ('+project.language+' '+project.type+')':''}`);put('A3','Film Title: '+project.title);put('E3','Company Name: '+(project.ascap?.companyName||production.company||''));put('A4','Episode Title/Number: '+(ep?`${ep.title||''} / ${episode}`:'Movie'));put('E4','Address: '+(project.ascap?.address||''));put('A5','Estimated Airdate: '+(project.airdate||''));put('E5','Phone: '+(project.ascap?.phone||''));put('A6','Program Length: '+(project.duration||''));put('E6','Contact: '+(project.ascap?.contact||production.producer||''));put('A7','Program Type: '+project.type);put('E7','Network Station: '+(project.ascap?.network||project.channel||''));
  }
  return updates;
 }
 function iprsMetadata(ctx,episode){
  if(ctx.project.exportRange)episode=ctx.project.exportRange.from+'-'+ctx.project.exportRange.to;
  const {project,ep,production,works,total}=ctx;
  const composer=String(project.bgComposer||'').trim()||[...new Set(works.flatMap(work=>partiesFor(work).filter(party=>party.role==='Composer').map(party=>party.name).filter(Boolean)))].join(', ');
  if(project.type==='Movie')return [
   ['TITLE',project.title,'DIRECTOR',production.director],
   ['GENRE / CATEGORY',project.genre,'BANNER / PRODUCTION COMPANY',production.company],
   ['LANGUAGE',project.language,'PRINCIPAL ACTORS / ACTRESS',production.cast],
   ['PRODUCTION NUMBER (FROM CENSOR CERTIFICATE)',project.productionNo,'TOTAL MOVIE DURATION',project.duration],
   ['DATE OF FIRST PERFORMED',project.airdate,'TOTAL MUSICAL DURATION',total],
   ['PRODUCTION YEAR',project.year,'BACKGROUND MUSIC COMPOSER',composer],
   ['PRODUCER',production.producer,'Submitted By (Name of C/A/E)',project.submittedBy||'Amishna Music']
  ];
  return [
   ['SERIAL TITLE',project.title,'CHANNEL NAME',project.channel],
   ['SERIAL TYPE [EG: DOCUMENTRY, SOAPS, WEB SERIES]',project.serialType||'Web Series','DIRECTOR',production.director],
   ['GENRE / CATEGORY',project.genre,'BANNER / PRODUCTION COMPANY',production.company],
   ['LANGUAGE',project.language,'PRINCIPAL ACTORS / ACTRESS',production.cast],
   ['PRODUCTION NUMBER',project.productionNo,'TOTAL EPISODE DURATION',project.duration],
   ['DATE OF EPISODE 1ST PERFORMED / AIRED',project.airdate,'TOTAL MUSICAL DURATION',total],
   ['PRODUCTION YEAR',project.year,'BACKGROUND MUSIC COMPOSER',composer],
   ['PRODUCER',production.producer,'Submitted By (Name of C/A/E)',project.submittedBy||'Amishna Music'],
   ['EPISODE NO.',episode??'','EPISODE TITLE',ep?.title||project.title],
   ['TOTAL NO. OF EPISODE',project.totalEpisodes,'SEASON NO',project.season]
  ];
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
 function formatIprsSongGroups(xml,styleXml,rows,layout){
  // Derive groups from contributors, never titles. Keep one visible gap
  // before Codes; remove the unused template rows below the final song.
  const attribute=(tag,name,value)=>{const pattern=new RegExp(`\\s${name}="[^"]*"`),replacement=` ${name}="${value}"`;return pattern.test(tag)?tag.replace(pattern,replacement):tag.replace(/(\/?>)$/,replacement+'$1');};
  const section=(name,item)=>{
   const match=styleXml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`));
   if(!match)throw new Error('IPRS workbook styles are missing: '+name);
   const entries=[...match[1].matchAll(new RegExp(`<${item}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${item}>)`,'g'))].map(value=>value[0]);
   return {name,match,entries,originalCount:entries.length,index:new Map(entries.map((value,index)=>[value,index]))};
  };
  const borders=section('borders','border'),xfs=section('cellXfs','xf'),variants=new Map();
  const append=(collection,value)=>{if(!collection.index.has(value)){collection.index.set(value,collection.entries.length);collection.entries.push(value);}return collection.index.get(value);};
  const edge=(border,name,weight)=>{
   const replacement=weight?`<${name} style="${weight}"><color rgb="FF000000"/></${name}>`:`<${name}/>`;
   const pattern=new RegExp(`<${name}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${name}>)`);
   if(pattern.test(border))return border.replace(pattern,replacement);
   if(/^<border\b[^>]*\/>$/.test(border))border=border.replace(/\/>$/,'></border>');
   return border.replace(new RegExp(`(?=<(?:${name==='top'?'bottom|':''}diagonal|vertical|horizontal)\\b|<\\/border>)`),replacement);
  };
  const styleFor=(originalId,first,last,validation)=>{
   const key=[originalId,first,last,validation].join(':');if(variants.has(key))return variants.get(key);
   const original=xfs.entries[originalId];if(!original)throw new Error('Invalid IPRS cell style.');
   const borderId=Number(original.match(/\bborderId="(\d+)"/)?.[1]||0),originalBorder=borders.entries[borderId];
   if(!originalBorder)throw new Error('Invalid IPRS border style.');
   const border=edge(edge(originalBorder,'top',first?'medium':validation?'':'thin'),'bottom',last?'medium':validation?'':'thin');
   const replacement=original.replace(/^<xf\b[^>]*>/,tag=>attribute(attribute(tag,'borderId',append(borders,border)),'applyBorder','1'));
   const result=append(xfs,replacement);variants.set(key,result);return result;
  };
  xml=xml.replace(/<row\b(?=[^>]*\br="(\d+)")[^>]*?(?:\s*\/>|>[\s\S]*?<\/row>)/g,(whole,number)=>{
   const index=Number(number)-layout.dataStart;
   const footerStart=layout.footerStart+Math.max(0,rows.length-layout.dataCapacity);
   if(index<0||Number(number)>=footerStart)return whole;
   const unused=index>=rows.length,spacer=unused||!rows[index].length;
   if(spacer&&index!==rows.length-1){
    // Never collapse a row containing a value, formula or inline string.
    if(/<(?:v|f|is)\b/.test(whole))return whole;
    whole=whole.replace(/^<row\b[^>]*>/,tag=>attribute(attribute(attribute(tag,'ht','0'),'customHeight','1'),'hidden','1'));
   }
   if(unused)return whole;
   // Hidden cells can still supply the shared edge in spreadsheet viewers.
   const first=spacer||index===0||!rows[index-1].length,last=spacer||index===rows.length-1||!rows[index+1].length;
   return whole.replace(/<c\b[^>]*>/g,tag=>{
    const column=tag.match(/\br="([A-Z]+)\d+"/)?.[1];if(!column||!/^([A-M])$/.test(column))return tag;
    const id=Number(tag.match(/\bs="(\d+)"/)?.[1]||0);return attribute(tag,'s',styleFor(id,first,last,column==='M'));
   });
  });
  for(const collection of [borders,xfs]){
   if(collection.entries.length===collection.originalCount)continue;
   const opening=collection.match[0].match(/^<[^>]*>/)[0];
   styleXml=styleXml.replace(collection.match[0],attribute(opening,'count',collection.entries.length)+collection.match[1]+collection.entries.slice(collection.originalCount).join('')+`</${collection.name}>`);
  }
  return {xml,styles:styleXml};
 }
 function trimIprsTable(xml,rows,layout){
  const footerStart=layout.footerStart+Math.max(0,rows.length-layout.dataCapacity);
  const gapRow=layout.dataStart+rows.length-1,removeStart=gapRow+1,removed=footerStart-removeStart;
  xml=xml.replace(/<row\b(?=[^>]*\br="(\d+)")[^>]*?(?:\s*\/>|>[\s\S]*?<\/row>)/g,(whole,number)=>Number(number)>=removeStart&&Number(number)<footerStart?'':whole);
  // Shift footer cells, merges, worksheet dimensions and other range refs.
  if(removed>0)xml=xml.replace(/\b(r|ref|sqref)="([^"]*)"/g,(whole,name,value)=>{
   const shifted=name==='r'&&/^\d+$/.test(value)?String(Number(value)>=footerStart?Number(value)-removed:Number(value)):value.replace(/(\$?[A-Z]+\$?)(\d+)/g,(address,column,row)=>column+(Number(row)>=footerStart?Number(row)-removed:Number(row)));
   return `${name}="${shifted}"`;
  });
  // A plain, unmerged row separates the track grid from the Codes legend.
  return xml.replace(new RegExp(`<row\\b(?=[^>]*\\br="${gapRow}")[^>]*?(?:\\s*\\/>|>[\\s\\S]*?<\\/row>)`),`<row r="${gapRow}" ht="15.75" customHeight="1"/>`);
 }
 function iprsMovieTemplate(xml){
  // The movie reference has seven production rows, followed by its work table.
  // Reuse the supplied workbook's fonts, borders and contributor rows.
  const headingStyle=styleAttribute(rowBlueprint(xml,1,1).styles[0]),bottomStyles=rowBlueprint(xml,12,11).styles,lastMetadata=rowXml(xml,9);
  xml=xml.replace(lastMetadata,lastMetadata.replace(/<c\b([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g,(whole,attributes)=>{
   const column=attributes.match(/\br="([A-K])9"/)?.[1];return column?whole.replace(/\bs="[^"]*"/,styleAttribute(bottomStyles[column.charCodeAt(0)-65]).trim()):whole;
  }));
  const shiftAddress=address=>address.replace(/([A-Z]+)(\d+)/g,(whole,column,row)=>column+(Number(row)>=13?Number(row)-3:Number(row)));
  xml=xml.replace(/<row\b(?=[^>]*\br="(\d+)")[^>]*?(?:\s*\/>|>[\s\S]*?<\/row>)/g,(whole,row)=>{
   const number=Number(row);if(number>=10&&number<=12)return '';
   if(number<13)return whole;
   return whole.replace(/\br="([A-Z]*)(\d+)"/g,(_,column,value)=>`r="${column}${Number(value)-3}"`);
  });
  xml=xml.replace(/<mergeCells\b[^>]*>([\s\S]*?)<\/mergeCells>/,(whole,body)=>{
   const refs=[...body.matchAll(/<mergeCell ref="([^"]+)"\/>/g)].map(match=>match[1]).filter(ref=>!ref.split(':').some(address=>{const row=Number(address.match(/\d+$/)?.[0]);return row>=10&&row<=12;})).map(shiftAddress).map(ref=>ref==='A11:F11'?'A11:E11':ref==='G11:M11'?'F11:K11':ref);
   return `<mergeCells count="${refs.length}">${refs.map(ref=>`<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`;
  });
  xml=xml.replace(/(<dimension\b[^>]*\bref=")([^"]+)(")/,(_,before,ref,after)=>before+shiftAddress(ref)+after);
  // Movie and series downloads share the final reference's column sizing.
  const heading='<r><rPr><b/><sz val="36"/><rFont val="Arial Narrow"/></rPr><t>The Indian Performing Right Society Limited</t></r>'+
   '<r><rPr><b/><sz val="11"/><rFont val="Arial Narrow"/></rPr><t xml:space="preserve">\nRegd. Office : 208, Golden Chambers, 2nd Floor, New Andheri Link Road, Andheri (W), Mumbai - 400 053.\nTel: IPRS Call Center Number: 8097539960 &amp; Office No. (091 22) 2673 3748 / 49 / 50 / 6616. Email : documentation@iprs.org, support.documentation@iprs.org. Visit us at : www.iprs.org\nCIN : U92140MH1969GAP014359</t></r>';
  xml=xml.replace(/<c\b[^>]*\br="A1"[^>]*>[\s\S]*?<\/c>/,`<c r="A1"${headingStyle} t="inlineStr"><is>${heading}</is></c>`);
  const edits=new Map([['A2','MOVIE CUE SHEET'],['B12','Code'],['F11','COMPOSER / AUTHOR / PUBLISHER / SINGER DETAILS'],['G11',''],['A33','']]);
  xml=xml.replace(/<c\b([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g,(whole,attributes)=>{const address=attributes.match(/\br="([A-Z]+\d+)"/)?.[1];if(address==='E11'||address==='K11')return cellMarkup(address,null,'s="47"');if(address==='L11'||address==='M11')return cellMarkup(address,null,'s="40"');if(!edits.has(address))return whole;return cellMarkup(address,{value:edits.get(address),type:'string'},address==='F11'?'s="48"':address==='G11'?'s="46"':attributes);});
  // Keep the movie labels legible at the reference's column widths.
  for(const [row,height] of [[1,93.75],[2,33.75],[6,33.75],[11,22],[12,44.4]])xml=xml.replace(new RegExp(`<row\\b(?=[^>]*\\br="${row}")([^>]*)>`),(whole,attributes)=>`<row${attributes.replace(/\s+(?:ht|customHeight)="[^"]*"/g,'')} ht="${height}" customHeight="1">`);
  return xml;
 }
 function transformPrsSheet(xml,rows,updates,layout){
  const blueprints=Object.fromEntries(Object.entries(layout.styleRows).map(([kind,row])=>[kind,rowBlueprint(xml,row,layout.maxColumn)]));
  const footerRow=layout.dataStart+rows.length+1,footer=rowXml(xml,layout.footerStart);
  const cellPattern=/<c\b([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g;
  const inTable=attributes=>/\br="([A-Z]+)\d+"/.exec(attributes)?.[1]?.match(/^[A-L]$/);
  const savedRows=new Map();
  for(const match of xml.matchAll(/<row\b(?=[^>]*\br="(\d+)")[^>]*?(?:\s*\/>|>[\s\S]*?<\/row>)/g)){
   const row=Number(match[1]);let markup=match[0];
   if(row>=layout.dataStart&&row<=layout.footerEnd)markup=markup.replace(cellPattern,(cell,attributes)=>inTable(attributes)?'':cell);
   markup=markup.replace(cellPattern,(cell,attributes)=>{const address=attributes.match(/\br="([A-Z]+\d+)"/)?.[1];return updates.has(address)?cellMarkup(address,updates.get(address),attributes):cell;});
   savedRows.set(row,markup);
  }
  const placeRow=(row,markup)=>{
   const existing=savedRows.get(row)||'',extra=[];
   existing.replace(cellPattern,(cell,attributes)=>{
    if(!inTable(attributes))extra.push(cell);
    else if(/<(?:v|f|is)\b/.test(cell))throw new Error('The PRS template contains additional data in row '+row+'.');
    return cell;
   });
   if(extra.length){
    if(/\/>$/.test(markup))markup=markup.replace(/\/>$/,'></row>');
    markup=markup.replace('</row>',extra.join('')+'</row>');
   }
   savedRows.set(row,markup);
  };
  const merges=[...xml.matchAll(/<mergeCell\b[^>]*\bref="([^"]+)"\s*\/>/g)].map(match=>match[1]).filter(ref=>{
   const [,column,number]=ref.match(/^([A-Z]+)(\d+)/),row=Number(number);
   return !/^[A-L]$/.test(column)||row<layout.dataStart||row>layout.footerEnd;
  });
  // Sequence values identify cue boundaries even when adjacent songs have identical titles.
  for(let start=0;start<rows.length;){
   let end=start+1;while(end<rows.length&&rows[end][0]==='')end++;
   const first=layout.dataStart+start,last=layout.dataStart+end-1;
   merges.push(`B${first}:C${last}`);
   if(last>first)for(const column of ['A','J','K','L'])merges.push(`${column}${first}:${column}${last}`);
   for(let index=start;index<end;index++){
    const row=layout.dataStart+index,kind=end-start===1?'single':index===start?'first':index===end-1?'last':'body';
    placeRow(row,generatedRowMarkup(row,rows[index],blueprints[kind],layout.maxColumn));
    merges.push(`E${row}:F${row}`);
   }
   start=end;
  }
  placeRow(footerRow-1,`<row r="${footerRow-1}"/>`);
  const footerCells=footer.replace(cellPattern,(cell,attributes)=>inTable(attributes)?cell:'');
  placeRow(footerRow,footerCells.replace(/\br="([A-Z]*)(\d+)"/g,(whole,column,row)=>Number(row)===layout.footerStart?`r="${column}${footerRow}"`:whole));
  merges.push(`A${footerRow}:D${footerRow}`);
  xml=xml.replace(/<sheetData\b[^>]*>[\s\S]*?<\/sheetData>/,`<sheetData>${[...savedRows].sort((a,b)=>a[0]-b[0]).map(([,markup])=>markup).join('')}</sheetData>`);
  xml=xml.replace(/<mergeCells\b[^>]*>[\s\S]*?<\/mergeCells>/,`<mergeCells count="${merges.length}">${merges.map(ref=>`<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`);
  return xml.replace(/<dimension ref="([A-Z]+\d+):([A-Z]+)(\d+)"\s*\/>/,(whole,first,column,last)=>`<dimension ref="${first}:${column}${Math.max(Number(last),footerRow)}"/>`);
 }
 async function formattedSheet(zip,sourceXml,society,project,episode,cues,works,artists,options){
  const ctx=context(project,episode,cues,works,society,artists,options),rows=rowsFor(society,ctx),updates=productionUpdates(society,ctx,episode),layout=layoutFor(society,project);
  let xml=sourceXml;if(society==='IPRS'&&project.type==='Movie')xml=iprsMovieTemplate(xml);
  xml=society==='PRS'?transformPrsSheet(xml,rows,updates,layout):transformSheet(xml,society,rows,updates,layout);
  if(society==='IPRS'){
   const formatted=formatIprsSongGroups(xml,await zip.file('xl/styles.xml').async('string'),rows,layout);
   xml=trimIprsTable(formatted.xml,rows,layout);zip.file('xl/styles.xml',formatted.styles);
  }
  let ascapFooterEnd;
  if(society==='ASCAP'){
   const footerStart=layout.footerStart+Math.max(0,rows.length-layout.dataCapacity);
   const gapRow=layout.dataStart+rows.length;
   const occupied=[...xml.matchAll(/<row\b(?=[^>]*\br="(\d+)")[^>]*?(?:\s*\/>|>[\s\S]*?<\/row>)/g)].some(match=>Number(match[1])>=gapRow&&Number(match[1])<footerStart&&/<(?:v|f|is)\b/.test(match[0]));
   const removed=occupied?0:Math.max(0,footerStart-gapRow-1);
   ascapFooterEnd=footerStart+layout.footerEnd-layout.footerStart-removed;
   if(removed>0){
    xml=xml.replace(/<row\b(?=[^>]*\br="(\d+)")[^>]*?(?:\s*\/>|>[\s\S]*?<\/row>)/g,(whole,number)=>Number(number)>gapRow&&Number(number)<footerStart?'':whole);
    xml=xml.replace(/\b(r|ref|sqref)="([^"]*)"/g,(whole,name,value)=>{
     const shifted=name==='r'&&/^\d+$/.test(value)?String(Number(value)>=footerStart?Number(value)-removed:Number(value)):value.replace(/(\$?[A-Z]+\$?)(\d+)/g,(address,column,row)=>column+(Number(row)>=footerStart?Number(row)-removed:Number(row)));
     return `${name}="${shifted}"`;
    });
   }
   if(!occupied)xml=xml.replace(new RegExp(`<row\\b(?=[^>]*\\br="${gapRow}")[^>]*?(?:\\s*\\/>|>[\\s\\S]*?<\\/row>)`),`<row r="${gapRow}"/>`);
  }
  if(society==='PRS'||society==='ASCAP'){
   // Trim template-only trailing rows; retain any existing notes or formulas.
   const footerEnd=society==='PRS'?layout.dataStart+rows.length+1:ascapFooterEnd;
   xml=xml.replace(/<row\b(?=[^>]*\br="(\d+)")[^>]*?(?:\s*\/>|>[\s\S]*?<\/row>)/g,(whole,number)=>Number(number)>footerEnd&&!/<(?:v|f|is)\b/.test(whole)?'':whole);
   let lastRow=footerEnd,lastColumn=layout.maxColumn;
   for(const match of xml.matchAll(/<row\b[^>]*\br="(\d+)"/g))lastRow=Math.max(lastRow,Number(match[1]));
   for(const match of xml.matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"/g))lastColumn=Math.max(lastColumn,[...match[1]].reduce((value,char)=>value*26+char.charCodeAt(0)-64,0));
   for(const match of xml.matchAll(/<mergeCell\b[^>]*\bref="[A-Z]+\d+:([A-Z]+)(\d+)"/g)){lastRow=Math.max(lastRow,Number(match[2]));lastColumn=Math.max(lastColumn,[...match[1]].reduce((value,char)=>value*26+char.charCodeAt(0)-64,0));}
   xml=xml.replace(/(<dimension\b[^>]*\bref=")[^"]+(")/,`$1A1:${colName(lastColumn-1)}${lastRow}$2`);
  }
  return xml;
 }
 async function buildFormatted(society,project,episode,cues,works,artists=[],options={}){
  if(!mappings[society])throw new Error('Unsupported society format: '+society);
  const zip=await zipLibrary().loadAsync(decodeBase64(templateBase64(society))),path=layoutFor(society,project).sheetPath,source=zip.file(path);
  if(!source)throw new Error(`${society} reference worksheet is missing.`);
  zip.file(path,await formattedSheet(zip,await source.async('string'),society,project,episode,cues,works,artists,options));
  return zip.generateAsync({type:'uint8array',compression:'DEFLATE',compressionOptions:{level:6}});
 }
 async function buildEpisodesFormatted(society,outputs,artists=[],options={}){
  if(!mappings[society])throw new Error('Unsupported society format: '+society);
  if(!outputs.length)throw new Error('Choose at least one episode to export.');
  const episodes=outputs.map(output=>Number(output.episode));
  if(episodes.some(number=>!Number.isSafeInteger(number)||number<1)||new Set(episodes).size!==episodes.length)throw new Error('Each worksheet needs a different positive episode number.');
  const zip=await zipLibrary().loadAsync(decodeBase64(templateBase64(society))),source=zip.file(layouts[society].sheetPath);
  if(!source)throw new Error(`${society} reference worksheet is missing.`);
  const sourceXml=await source.async('string'),names=[],sheets=[],relationships=[];
  let rels=await zip.file('xl/_rels/workbook.xml.rels').async('string');
  rels=rels.replace(/<Relationship\b(?=[^>]*\bType="[^"]*\/worksheet")[^>]*\/>/g,'');
  const usedIds=new Set([...rels.matchAll(/\bId="([^"]+)"/g)].map(match=>match[1]));
  for(const [index,output] of outputs.entries()){
   const name='Episode_'+String(output.episode).padStart(2,'0'),path=`xl/worksheets/sheet${index+1}.xml`;
   let id='rIdEpisode'+(index+1);while(usedIds.has(id))id+='x';usedIds.add(id);
   // Render every episode from the original sheet. Shared strings and styles
   // remain in the template package; IPRS appends styles without renumbering.
   let xml=await formattedSheet(zip,sourceXml,society,output.project,output.episode,output.cues,output.works,artists,options);
   xml=xml.replace(/(<sheetView\b[^>]*\btabSelected=")[^"]*(")/g,(_,before,after)=>before+(index===0?'1':'0')+after);
   zip.file(path,xml);names.push(name);
   sheets.push(`<sheet name="${escapeXml(name)}" sheetId="${index+1}" r:id="${id}"/>`);
   relationships.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index+1}.xml"/>`);
  }
  let workbook=await zip.file('xl/workbook.xml').async('string');
  workbook=workbook.replace(/<sheets\b[^>]*>[\s\S]*?<\/sheets>/,'<sheets>'+sheets.join('')+'</sheets>');
  zip.file('xl/workbook.xml',workbook);
  zip.file('xl/_rels/workbook.xml.rels',rels.replace('</Relationships>',relationships.join('')+'</Relationships>'));
  let types=await zip.file('[Content_Types].xml').async('string');
  types=types.replace(/<Override\b(?=[^>]*\bPartName="\/xl\/worksheets\/sheet\d+\.xml")[^>]*\/>/g,'');
  zip.file('[Content_Types].xml',types.replace('</Types>',names.map((_,index)=>`<Override PartName="/xl/worksheets/sheet${index+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')+'</Types>'));
  const app=zip.file('docProps/app.xml');
  if(app){
   let xml=await app.async('string');
   xml=xml.replace(/(<HeadingPairs\b[^>]*>[\s\S]*?<vt:i4>)\d+(<\/vt:i4>)/,(_,before,after)=>before+names.length+after);
   xml=xml.replace(/<TitlesOfParts\b[^>]*>[\s\S]*?<\/TitlesOfParts>/,`<TitlesOfParts><vt:vector size="${names.length}" baseType="lpstr">${names.map(name=>'<vt:lpstr>'+escapeXml(name)+'</vt:lpstr>').join('')}</vt:vector></TitlesOfParts>`);
   zip.file('docProps/app.xml',xml);
  }
  return zip.generateAsync({type:'uint8array',compression:'DEFLATE',compressionOptions:{level:6}});
 }

 /* Synchronous structural workbook retained for mapping checks and internal tooling. */
 function build(society,project,episode,cues,works,artists=[],options={}){
  const spec=mappingFor(society,project),ctx=context(project,episode,cues,works,society,artists,options),rows=Array.from({length:spec.headerRow-1},()=>[]),data=rowsFor(society,ctx);
  if(society==='IPRS'){
   const movie=ctx.project.type==='Movie';rows[0]=['The Indian Performing Right Society Limited'];rows[1]=[movie?'MOVIE CUE SHEET':'TV/WEB SERIES CUE SHEET'];
   iprsMetadata(ctx,episode).forEach((row,index)=>{rows[index+2]=[row[0],row[1],'','','','',row[2],row[3]];});rows[spec.headerRow-2]=movie?['WORK DETAILS','','','','','COMPOSER / AUTHOR / PUBLISHER / SINGER DETAILS']:['WORK DETAILS','','','','','','COMPOSER / AUTHOR / PUBLISHER / SINGER DETAILS'];
  }else if(society==='PRS'){
   rows[0]=['LICENSOR APPROVED MUSIC CUE SHEET'];rows[1]=['Important Note'];rows[2]=['DRAFT FOR INTERNAL REVIEW — NOT APPROVED FOR SOCIETY SUBMISSION'];rows[4]=['Production Details'];rows[6]=['Film/Series/Item Title','',ctx.project.title,'','','Production Co.',ctx.production.company,'','Country of Origin',ctx.project.country||'','Film Duration',ctx.project.duration];rows[8]=['Episode Title','',ctx.ep?.title||ctx.project.title,'','','Production No.',ctx.project.productionNo,'','Production Year',ctx.project.year,'Music Duration',ctx.total];rows[10]=['Episode No.','',episode??'','','','Director',ctx.production.director,'','First Tx Date',ctx.project.airdate];rows[12]=['Film/Item No.','',ctx.project.filmItemNo||'','','','Principal Actors',ctx.production.cast,'','Type of AV',ctx.project.type==='Movie'?'Movie':'Episode'];rows[14]=['Alternative Title(s)','',ctx.project.altTitle||'','','','Channel',ctx.project.channel];rows[15]=['Music Details'];
  }else{
   rows[0]=[`${ctx.project.title}${ctx.project.language?' ('+ctx.project.language+' '+ctx.project.type+')':''}`];rows[2]=['Film Title: '+ctx.project.title,'','','','Company Name: '+(ctx.project.ascap?.companyName||ctx.production.company||'')];rows[3]=['Episode Title/Number: '+(ctx.ep?ctx.ep.title+' / '+episode:'Movie'),'','','','Address: '+(ctx.project.ascap?.address||'')];rows[4]=['Estimated Airdate: '+(ctx.project.airdate||''),'','','','Phone: '+(ctx.project.ascap?.phone||'')];rows[5]=['Program Length: '+(ctx.project.duration||''),'','','','Contact: '+(ctx.project.ascap?.contact||ctx.production.producer||'')];rows[6]=['Program Type: '+ctx.project.type,'','','','Network Station: '+(ctx.project.ascap?.network||ctx.project.channel||'')];
  }
  rows.push(spec.columns,...data);
  const sheet=XLSX.utils.aoa_to_sheet(rows);sheet['!cols']=spec.columns.map((_,index)=>({wch:index===0?30:index===1?35:22}));if(society==='ASCAP')data.forEach((_,index)=>{const cell=sheet['D'+(spec.headerRow+1+index)];if(cell)cell.z='[h]:mm:ss';});
  const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,sheet,spec.sheet);return workbook;
 }
 root.CueExports={mappings,layouts,mappingFor,layoutFor,build,buildFormatted,buildEpisodesFormatted};
})(globalThis);

/* iprs.js */

(function(root){
 'use strict';
 function parse(workbook){const records=[],warnings=[];for(const name of workbook.SheetNames){const ws=workbook.Sheets[name],rows=XLSX.utils.sheet_to_json(ws,{header:1,raw:true,defval:'',blankrows:true}),norm=CueDomain.normalize;
  const cell=(r,c)=>{const merged=(ws['!merges']||[]).find(m=>r>=m.s.r&&r<=m.e.r&&c>=m.s.c&&c<=m.e.c);return ws[XLSX.utils.encode_cell(merged?merged.s:{r,c})];};
  const value=(r,c)=>cell(r,c)?.v??'';
  let episode='',episodeTitle='',current=null,map=null,headerRow=-1;
  for(let r=0;r<rows.length;r++){
   const row=rows[r],texts=row.map(v=>norm(v)),titleCol=texts.findIndex(t=>['songtitletrackname','trackname','songtitle','musictitle'].includes(t)),roleCol=texts.findIndex(t=>t.startsWith('role'));
   if(titleCol>=0&&roleCol>=0){map={title:titleCol,role:roleCol,party:texts.findIndex(t=>t.includes('namesofcomposer')||t==='contributorname'||t==='interestedparties'),share:texts.findIndex(t=>t==='share'||t==='sharepercent'),society:texts.findIndex(t=>t==='society'),ipi:texts.findIndex(t=>t.startsWith('ipino')||t==='ipi'||t==='caenumber'),duration:texts.findIndex(t=>t.startsWith('duration')),isrc:texts.indexOf('isrc'),code:texts.findIndex(t=>t.includes('songcode')||t==='iprsid'),usage:texts.findIndex(t=>t==='characteristics'||t==='usage'),singer:texts.indexOf('singer'),episode:texts.findIndex(t=>t==='episodeno'||t==='episodenumber'),episodeTitle:texts.findIndex(t=>t==='episodetitle'||t==='episodename'),count:texts.findIndex(t=>t==='noofusage'),link:texts.findIndex(t=>t.startsWith('validationlink'))};headerRow=r;current=null;continue;}
   const epLabel=texts.findIndex(t=>t==='episodeno'||t==='episodenumber');if(epLabel>=0){episode=String(value(r,epLabel+1)).trim();const titleLabel=texts.findIndex(t=>t==='episodetitle');if(titleLabel>=0)episodeTitle=String(value(r,titleLabel+1));current=null;continue;}
   if(!map||r<=headerRow)continue;
   if(texts.some(t=>t==='codes'||t.startsWith('notecuesheets')||t.startsWith('draftforinternal'))){map=null;current=null;continue;}
   const get=k=>map[k]>=0?value(r,map[k]):'';
   if(map.episode>=0&&String(get('episode')).trim())episode=String(get('episode')).trim();
   if(map.episodeTitle>=0&&String(get('episodeTitle')).trim())episodeTitle=String(get('episodeTitle')).trim();
   const rawTitle=String(row[map.title]||'').trim(),partyName=String(get('party')).trim(),role=String(get('role')).trim();
   if(rawTitle){current={title:rawTitle,episode,episodeTitle,duration:CueDomain.seconds(get('duration')),isrc:String(get('isrc')).trim(),code:String(get('code')).trim(),usage:String(get('usage')).trim(),artist:String(get('singer')).trim(),link:String(get('link')).trim(),parties:[],sheet:name,row:r+1,count:Number(get('count')||1)};records.push(current);}
   if(current&&(partyName||role)){const shareCell=map.share>=0?cell(r,map.share):null,raw=shareCell?.v;let share=null;if(typeof raw==='number')share=shareCell.z?.includes('%')?raw*100:raw;else if(raw!==''&&raw!=null){const text=String(raw).replace(/%$/,'').trim();share=/^\d+(\.\d+)?$/.test(text)?Number(text):NaN;}current.parties.push({name:partyName,role:({C:'Composer',A:'Lyricist',CA:'Composer / Lyricist',E:'Publisher',AR:'Arranger'})[role]||(/^author$/i.test(role)?'Lyricist':role),society:String(get('society')).trim(),share,ipi:String(get('ipi')).trim()});}
  }
 }
 if(!records.length)throw Error('No IPRS track table was found. Use the supplied IPRS layout or a flat table with track, role, and contributor headers.');
 for(const r of records){if(r.parties.some(p=>!p.name||!p.role||p.share===null||!Number.isFinite(p.share)||p.share<0||p.share>100))warnings.push(r.title+': incomplete contributor information');if(r.count>1)warnings.push(r.title+': aggregated usage count '+r.count+' requires individual cue review');}
 return {records,warnings};}
 root.CueIprs={parse};if(typeof module!=='undefined')module.exports=root.CueIprs;
})(globalThis);

/* export-filenames.js */

(function(root){
  'use strict';
  function part(value,fallback,maxBytes=160){
    const clean=String(value??'').normalize('NFC').replace(/[^\p{L}\p{M}\p{N}_-]+/gu,'_').replace(/_+/g,'_').replace(/^[_-]+|[_-]+$/g,'');
    let result='',bytes=0;
    for(const character of clean){const size=new TextEncoder().encode(character).length;if(bytes+size>maxBytes)break;result+=character;bytes+=size;}
    return result.replace(/[_-]+$/g,'')||fallback;
  }
  root.CueExportFilename=function(project,episode,society,{extension='xlsx',endEpisode=project?.exportRange?.to,separator='underscore'}={}){
    const parts=[part(project?.title,'Production')],zip=extension==='zip',episodePart=value=>{const text=part(value,'unknown',24);return /^\d+$/.test(text)?text.padStart(2,'0'):text;};
    if(/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(parts[0]))parts[0]='Production_'+parts[0];
    if(project?.type!=='Movie'&&episode!=null){
      const start=episodePart(episode),end=endEpisode==null?null:episodePart(endEpisode);
      parts.push(end===null||start===end?'Episode_'+start:'Episodes_'+start+'-'+end);
    }
    if(!zip)parts.push(part(society,'Export',16));
    return (separator==='hyphen'?parts.map(value=>value.replace(/_/g,'-')).join('-'):parts.join('_'))+'.'+(zip?'zip':'xlsx');
  };
})(globalThis);

/* amishna.prototype.js */

/* Project and episode workspace guided by the supplied Amishna CMS V3 prototype.
   Permanent music metadata remains normalized in Works; cue details remain local. */
window.createAmishnaUI = function (api) {
  'use strict';
  const {esc:e,icon,options,toast}=api, D=CueDomain;
  const $=s=>document.querySelector(s), data=()=>api.state();
  let projectId=null,episodeNumber=null,cueId=null,episodeQuery='',episodePage=1,cueQuery='',cueReviewFilter='',draft=null,dirty=false,episodeDirty=false;
  let search='',statusFilter='',typeFilter='',editorFilter='',houseFilter='',channelFilter='',yearFilter='',pageNumber=1;
  let from=null,to=null,rangeIssues=null,reviewSociety='IPRS',rangeBusy=false,iprsReview=null;
  let pendingCueSwitch=null,titleSaveAnnounce=true,selectedEpisodeNumbers=new Set();
  const uid=p=>p+'-'+crypto.randomUUID().slice(0,8), now=()=>new Date().toISOString();
  const button=(label,action,ico='',cls='')=>`<button type="button" class="btn ${cls}" data-am="${action}">${ico?icon(ico):''}${label}</button>`;
  const status=text=>`<span class="am-status ${text==='Complete'||text==='Ready for Review'?'ready':text==='Needs review'?'review':''}"><i></i>${e(text)}</span>`;
  const field=(label,name,value='',type='text',attrs='')=>`<div class="field"><label for="am-${name}">${label}</label><input class="input" id="am-${name}" name="${name}" type="${type}" value="${e(value)}" ${attrs}></div>`;
  const select=(label,name,items,value,attrs='')=>`<div class="field"><label for="am-${name}">${label}</label><select class="input" id="am-${name}" name="${name}" ${attrs}>${options(items,value)}</select></div>`;
  const current=()=>data().projects.find(p=>p.id===projectId);
  const epOf=p=>p?.type==='Movie'?null:p?.episodes.find(ep=>Number(ep.number)===Number(episodeNumber));
  let builderCache=null;
  function builderIndex(){
    const state=data(),revision=api.revision?.();
    if(builderCache&&builderCache.state===state&&builderCache.revision===revision&&builderCache.cues===state.cues&&builderCache.works===state.works&&builderCache.cueCount===state.cues.length&&builderCache.workCount===state.works.length)return builderCache;
    const projects=new Map(),worksById=new Map(state.works.map(work=>[work.id,work]));
    for(const cue of state.cues){let project=projects.get(cue.projectId);if(!project){project={cues:[],episodes:new Map()};projects.set(cue.projectId,project);}project.cues.push(cue);const number=Number(cue.episode);if(!project.episodes.has(number))project.episodes.set(number,[]);project.episodes.get(number).push(cue);}
    return builderCache={state,revision,cues:state.cues,works:state.works,cueCount:state.cues.length,workCount:state.works.length,projects,worksById};
  }
  const cuesOf=(p=current(),number=episodeNumber)=>{const project=builderIndex().projects.get(p?.id);return p?.type==='Movie'?project?.cues||[]:project?.episodes.get(Number(number))||[];};
  const workOf=c=>builderIndex().worksById.get(c?.workId);
  const members=()=>data().members||[];
  function initialize(){const s=data();if(!s.members)s.members=[{id:'MEM-001',name:'Priya Nair',email:'priya@example.com',role:'Editor',active:true}];s.projects.forEach((p,i)=>{p.status??='In Progress';p.assignedEditorId??=i===0?'MEM-001':'';p.updatedAt??=now();p.episodes.forEach(ep=>{ep.duration??=p.duration;ep.airdate??=p.airdate;});});}
  function commit(message,change){const before=structuredClone(data());builderCache=null;try{change(data());builderCache=null;data().activity.unshift({text:message,date:now()});if(!api.save()){api.replaceState(before);return false;}return true;}catch(err){builderCache=null;api.replaceState(before);toast(err.message||'Changes could not be saved.');return false;}}
  function title(){return `<a class="am-brand" href="#" data-am="home"><span class="am-mark">${icon('music')}</span><span>Amishna<span class="brand-sub">MUSIC CMS</span></span></a>`;}
  function mount(page){
    document.body.classList.toggle('am-builder',page==='builder');
    document.body.classList.remove('export-open');

  }
  const summary=(label,value,ico,sub)=>`<div class="am-stat"><div><span>${label}</span><strong>${value}</strong><small>${sub}</small></div><div class="am-stat-icon">${icon(ico)}</div></div>`;
  function dashboard(){initialize();const s=data(),all=s.projects,unique=key=>[...new Set(all.map(p=>key(p)).filter(Boolean))].sort(),totalEpisodes=all.reduce((n,p)=>n+p.episodes.length,0);
    const filtered=all.filter(p=>{const member=members().find(m=>m.id===p.assignedEditorId),house=p.periods[0]?.company||'';return (!search||[p.title,member?.name,house].join(' ').toLowerCase().includes(search.toLowerCase()))&&(!statusFilter||p.status===statusFilter)&&(!typeFilter||p.type===typeFilter)&&(!editorFilter||p.assignedEditorId===editorFilter)&&(!houseFilter||house===houseFilter)&&(!channelFilter||p.channel===channelFilter)&&(!yearFilter||String(p.year)===yearFilter);});
    const pages=Math.max(1,Math.ceil(filtered.length/8));pageNumber=Math.min(pageNumber,pages);const rows=filtered.slice((pageNumber-1)*8,pageNumber*8);
    const filterSelect=(name,label,items,value)=>select(label,name,[{value:'',label:'All '+label.toLowerCase()},...items],value);
    return `<div class="am-page-head"><div class="eyebrow">YOUR PRODUCTION DESK</div><div class="am-heading-row"><div><h1>Projects</h1><p>Pick up a production where you left off, or start a new one.</p></div>${button('New project','new-project','plus','primary')}</div></div><div class="am-stats">${summary('Total projects',all.length,'folder','Movies & series')}${summary('Episodes',totalEpisodes,'film','Across your productions')}${summary('Music cues',s.cues.length,'music',s.works.length+' master Works')}${summary('Ready for review',all.filter(p=>p.status==='Ready for Review').length,'check','Awaiting society validation')}</div><form id="am-filters" class="am-filters am-form"><div class="am-search-field">${field('Search','search',search,'search','placeholder="Search project, editor, or studio…"')}</div>${filterSelect('status','Status',['Draft','In Progress','Ready for Review'],statusFilter)}${filterSelect('editor','Editor',members().filter(m=>m.active).map(m=>({value:m.id,label:m.name})),editorFilter)}${filterSelect('type','Type',['Movie','Series'],typeFilter)}${filterSelect('house','Production house',unique(p=>p.periods[0]?.company),houseFilter)}${filterSelect('channel','Channel',unique(p=>p.channel),channelFilter)}${filterSelect('year','Year',unique(p=>String(p.year)),yearFilter)}<div class="am-filter-actions">${button('Clear','clear-filters')}<button class="btn primary" type="submit">Apply</button></div></form><div class="am-dashboard-grid"><section class="panel am-project-list"><div class="panel-head"><h2>All productions <span class="am-count">${filtered.length}</span></h2><span class="subtitle">Your projects, in one place</span></div><div class="table-wrap"><table><thead><tr><th>PROJECT</th><th>PRODUCTION</th><th>EDITOR</th><th>CONTENT</th><th>STATUS</th><th></th></tr></thead><tbody>${rows.map(p=>{const member=members().find(m=>m.id===p.assignedEditorId);return `<tr><td><div class="am-project-cell"><div class="am-poster ${e(p.color)}">${e(p.title.split(' ').slice(0,2).map(s=>s[0]).join(''))}</div><div><button class="link-button" data-am-project="${e(p.id)}">${e(p.title)}</button><div class="cell-meta">${e(p.type)} · ${e(p.language)} · ${p.year}</div></div></div></td><td>${e(p.periods[0]?.company||'Not provided')}<div class="cell-meta">${e(p.channel||'—')}</div></td><td><span class="am-member-dot">${e(member?.name[0]||'—')}</span>${e(member?.name||'Unassigned')}</td><td>${p.type==='Series'?p.episodes.length+' episodes':'Feature film'}<div class="cell-meta">${s.cues.filter(c=>c.projectId===p.id).length} cues</div></td><td>${status(p.status)}</td><td><button class="btn small" data-am-project="${e(p.id)}">Open ${icon('arrow')}</button></td></tr>`;}).join('')||'<tr><td colspan="6"><div class="empty">No projects match these filters.</div></td></tr>'}</tbody></table></div><div class="am-pagination"><span>${filtered.length?((pageNumber-1)*8+1):0}–${Math.min(pageNumber*8,filtered.length)} of ${filtered.length} projects</span><div>${button('Previous','previous-page')}<span>${pageNumber} / ${pages}</span>${button('Next','next-page')}</div></div></section><aside class="am-dashboard-aside"><section class="panel"><div class="panel-head"><h2>Recent activity</h2>${icon('clock')}</div><div class="am-activities">${(s.activity.length?s.activity.slice(0,5):[{text:'Workspace ready. Open a sample production to explore your cue sheets.',date:now()}]).map(a=>`<div><i></i><p>${e(a.text)}<small>${new Date(a.date).toLocaleDateString('en-IN',{day:'numeric',month:'short'})}</small></p></div>`).join('')}</div></section><section class="panel"><div class="panel-head"><h2>Project distribution</h2></div><div class="am-distribution">${['Series','Movie'].map(type=>`<div><span>${type==='Series'?'Series':'Movies'}</span><strong>${all.filter(p=>p.type===type).length}</strong><div class="progress-track"><span style="width:${all.filter(p=>p.type===type).length/Math.max(all.length,1)*100}%"></span></div></div>`).join('')}</div></section><section class="panel"><div class="panel-head"><h2>Quick actions</h2></div><div class="am-quick">${button('New project','new-project','plus')}${button('Manage team','members','users')}${button('Open Song Database','works','music')}${button('Import history','imports','upload')}</div></section></aside></div>`;
  }
  function openProject(id){if(!flush())return;projectId=id;const p=current();if(!p)return;episodeQuery=cueQuery=cueReviewFilter='';episodePage=1;selectedEpisodeNumbers.clear();episodeNumber=p.episodes[0]?.number??null;cueId=cuesOf()[0]?.id??null;loadDraft();from=episodeNumber;to=episodeNumber;rangeIssues=null;api.go('builder');}
  function loadDraft(){const c=data().cues.find(c=>c.id===cueId),work=c?workOf(c):null;draft=c?{cue:structuredClone(c),work:structuredClone(work),occurrenceRows:c.occurrences?.length>1?c.occurrences.map(use=>({...structuredClone(use),title:use.title||work?.title||'',startText:use.start==null?'':D.time(use.start),endText:use.end==null?'':D.time(use.end)})):null}:null;dirty=false;}
  function latestDeletedCue(){const p=current();return (data().deletedCues||[]).findLast(item=>item.cue.projectId===p?.id&&(p.type==='Movie'||Number(item.cue.episode)===Number(episodeNumber)));}
  function duplicateCue(){
    if(!draft||!flush())return;
    const source=data().cues.find(c=>c.id===cueId);
    if(!source)return;
    const copy={...structuredClone(source),id:uid('CUE'),duplicatedFrom:source.id};
    const title=workOf(source)?.title||'Untitled cue';
    if(!commit('Duplicated cue · '+title+' · '+current().title,s=>{
      s.cues.splice(s.cues.findIndex(c=>c.id===source.id)+1,0,copy);
      current().updatedAt=now();
    }))return;
    cueId=copy.id;cueQuery=cueReviewFilter='';loadDraft();rangeIssues=null;
    api.render();toast('Cue duplicated. Timing, usage and notes copied.');
  }
  function deleteCue(){
    if(!draft)return;
    if(episodeDirty&&!persistEpisode(Object.fromEntries(new FormData($('#am-episode-form'))),false))return;
    const source=data().cues.find(c=>c.id===cueId);
    if(!source)return;
    modal('Delete cue?',`<div class="cr-delete-confirm"><p>Remove <strong>${e(workOf(source)?.title||'this cue')}</strong> from ${current().type==='Movie'?'this movie':'episode '+e(episodeNumber)}?</p><p class="subtitle">The song record and its other cues will remain. You can restore this cue with Undo.</p>${dirty?'<p class="cr-delete-unsaved">Unsaved changes to the selected cue and song details will be discarded.</p>':''}</div><div class="panel-actions">${button('Cancel','close-modal')}<button type="button" class="btn danger cr-delete-cue" data-am="confirm-delete-cue" data-cue-id="${e(source.id)}">${icon('trash')}Delete cue</button></div>`);
  }
  function confirmDeleteCue(id){
    const source=data().cues.find(c=>c.id===id);
    if(!source||source.projectId!==projectId||source.id!==cueId)return;
    const position=cuesOf().findIndex(c=>c.id===id),title=workOf(source)?.title||'Untitled cue';
    if(!commit('Deleted cue · '+title+' · '+current().title,s=>{
      const index=s.cues.findIndex(c=>c.id===id);
      s.deletedCues??=[];
      s.deletedCues.push({id:uid('DEL'),cue:structuredClone(s.cues[index]),index,deletedAt:now()});
      s.cues.splice(index,1);current().updatedAt=now();
    }))return;
    const remaining=cuesOf();cueId=remaining[Math.min(position,remaining.length-1)]?.id||null;
    cueQuery=cueReviewFilter='';loadDraft();rangeIssues=null;api.close();api.render();toast('Cue deleted. Use Undo to restore it.');
  }
  function undoDeleteCue(){
    if(!flush())return;
    const removed=latestDeletedCue();if(!removed)return;
    if(data().cues.some(c=>c.id===removed.cue.id)){toast('This cue has already been restored.');return;}
    if(!data().works.some(w=>w.id===removed.cue.workId)){toast('Restore the linked song record before restoring this cue.');return;}
    const title=workOf(removed.cue)?.title||'Untitled cue';
    if(!commit('Restored cue · '+title+' · '+current().title,s=>{
      s.cues.splice(Math.min(removed.index,s.cues.length),0,structuredClone(removed.cue));
      s.deletedCues=s.deletedCues.filter(item=>item.id!==removed.id);current().updatedAt=now();
    }))return;
    cueId=removed.cue.id;cueQuery=cueReviewFilter='';loadDraft();rangeIssues=null;api.render();toast('Cue restored.');
  }
  function readyCue(c){const w=workOf(c);return !!w&&['IPRS','PRS','ASCAP'].every(s=>D.validateExport([c],[w],s,data().projects.find(p=>p.id===c.projectId)||{type:'Series'}).length===0);}
  function builder(){
    const p=current();
    if(!p)return '<div class="empty"><h1>Choose a production</h1><p>Open a project to manage its cues.</p><button class="btn primary" data-nav="projects">Browse projects</button> '+button('New project','new-project','plus')+'</div>';
    if(!dirty)loadDraft();
    if(cueId&&!cuesOf().some(c=>c.id===cueId)){cueId=cuesOf()[0]?.id||null;loadDraft();}
    const ep=epOf(p),rows=cuesOf(),eps=[...p.episodes].sort((a,b)=>a.number-b.number).filter(ep=>[ep.number,ep.title].join(' ').toLowerCase().includes(episodeQuery.toLowerCase()));
    const musicDuration=D.time(rows.reduce((sum,c)=>sum+c.duration,0)),needsReview=rows.filter(c=>!readyCue(c)).length;
    const visibleRows=rows.filter(c=>(!cueQuery||[workOf(c)?.title,c.id].join(' ').toLowerCase().includes(cueQuery.toLowerCase()))&&(!cueReviewFilter||!readyCue(c)));
    const deleted=latestDeletedCue();
    const activeTitle=p.type==='Movie'?p.title:(ep?.title||(episodeNumber==null?p.title:'Episode '+episodeNumber));
    const episodeField=(label,name,value='',type='text',attrs='')=>field(label,name,value,type,attrs).replaceAll('am-'+name,'am-episode-'+name);
    const episodePages=Math.max(1,Math.ceil(eps.length/50));episodePage=Math.min(episodePage,episodePages);
    const cards=p.type==='Movie'?[{number:'movie',title:p.title}]:eps.slice((episodePage-1)*50,episodePage*50);
    selectedEpisodeNumbers=new Set([...selectedEpisodeNumbers].filter(number=>p.episodes.some(item=>Number(item.number)===Number(number))));
    const allVisibleEpisodesSelected=p.type==='Series'&&cards.length>0&&cards.every(item=>selectedEpisodeNumbers.has(Number(item.number)));
    const episodeTabs=cards.map(item=>{const active=p.type==='Movie'||Number(item.number)===Number(episodeNumber),itemCues=cuesOf(p,item.number);return `<div class="cr-episode-tab ${p.type==='Series'?'selectable':''} ${active?'active':''}">${p.type==='Series'?`<label class="cr-episode-select-control"><input type="checkbox" data-am-episode-check="${item.number}" aria-label="Select episode ${item.number}" ${selectedEpisodeNumbers.has(Number(item.number))?'checked':''}></label>`:''}<button type="button" class="cr-episode-select" data-am-episode="${item.number}" ${active?'aria-current="true"':''}><span class="cr-episode-kicker">${p.type==='Movie'?'Feature film':'Episode '+item.number}${active?'<span class="cr-episode-current">Selected</span>':''}</span><strong>${e(item.title||'Untitled episode')}</strong><small>${itemCues.length} cues <span aria-hidden="true">&middot;</span> ${D.time(itemCues.reduce((sum,c)=>sum+c.duration,0))} music</small></button><button type="button" class="cr-episode-download" data-am-episode-download="${item.number}" title="Download ${p.type==='Movie'?'movie':'episode '+item.number}" aria-label="Download ${p.type==='Movie'?'movie':'episode '+item.number}">${icon('download')}</button></div>`;}).join('');
    return `<div class="cr-builder cr-builder-v2 cr-builder-modern">
      <section class="cr-context-head">
        <div class="cr-context-main">
          <div class="cr-workspace-breadcrumb"><button data-nav="projects">Projects</button><span>/</span><span>${e(p.title)}</span></div>
          <div class="cr-context-title-row"><h1>${e(activeTitle)}</h1><span class="cr-context-badge">${p.type==='Movie'?'Movie':`Season ${p.season||1}${episodeNumber==null?'':` &middot; Episode ${episodeNumber}`}`}</span>${status(p.status||'In Progress')}</div>
        </div>
        <div class="cr-context-right">
          <div class="cr-context-metrics"><div><span>Program</span><strong>${e((ep?.duration??p.duration)||'Not set')}</strong></div><div><span>Music</span><strong>${musicDuration}</strong></div><div><span>Air date</span><strong>${e((ep?.airdate??p.airdate)||'Not set')}</strong></div></div>
          <div class="cr-context-actions">${button('Production','production','settings','small')}<details class="cr-edit-episode"><summary class="btn">${icon('settings')} Edit ${p.type==='Movie'?'movie':'episode'}</summary><div class="cr-episode-edit-pop">
            <form id="am-episode-form" class="am-form"><div class="am-episode-fields">
              ${p.type==='Series'?episodeField('Episode number','number',ep?.number||'','number','required min="1" step="1"'):''}
              ${episodeField(p.type==='Movie'?'Movie title':'Episode name','title',ep?.title??p.title)}
              ${episodeField('Air date','airdate',ep?.airdate??p.airdate)}
              ${episodeField('Program duration','duration',ep?.duration??p.duration,'text','placeholder="HH:MM:SS"')}
              ${episodeField('Music duration','musicDuration',musicDuration,'text','readonly')}
            </div><div class="am-inline-save"><button class="btn primary small" type="submit">Save details</button></div></form>
          </div></details>${button('Upload workfile','import','upload','small')}${button('Export / Download','export-scroll','download','primary small')}</div>
        </div>
      </section>
      <section class="cr-episode-tabs" aria-label="${p.type==='Movie'?'Movie':'Episodes'}">
        <div class="cr-episode-toolbar"><h2>${p.type==='Movie'?'Content':'Episodes'} <span class="cr-count">${p.type==='Movie'?1:p.episodes.length}</span></h2><div class="cr-episode-tools">${p.type==='Series'?`<label class="cr-episode-check-all"><input type="checkbox" id="am-episode-check-all" ${allVisibleEpisodesSelected?'checked':''}> Select visible</label><span class="cr-episode-selected-count">${selectedEpisodeNumbers.size} selected</span>${button('Delete selected','bulk-delete-episodes','trash','small danger')}<label class="cr-tab-search">${icon('search')}<input id="am-episode-search" type="search" aria-label="Find an episode" placeholder="Find episode" value="${e(episodeQuery)}"></label>${button('Add episode','add-episode','plus','small')}`:''}</div></div>
        <div class="cr-tabs-scroll" data-project-id="${e(p.id)}">${episodeTabs||`<div class="cr-episode-empty">${p.episodes.length?`No episodes match &ldquo;${e(episodeQuery)}&rdquo;. ${button('Clear search','clear-episode-search','','small')}`:`No episodes yet. ${button('Add episode','add-episode','plus','small')}`}</div>`}</div>
        ${p.type==='Series'&&episodePages>1?`<div class="am-pagination"><span>${eps.length?((episodePage-1)*50+1):0}–${Math.min(episodePage*50,eps.length)} of ${eps.length} episodes</span><div>${button('Previous','episode-page-prev','','small')}<span>${episodePage} / ${episodePages}</span>${button('Next','episode-page-next','','small')}</div></div>`:''}
      </section>
      <div class="cr-workspace">
        <section class="cr-cues" id="cr-cue-list" aria-label="Music cues">
          <div class="cr-cues-head"><h2>Music cues <span class="cr-count">${rows.length}</span></h2>${button('Add cue','link-work','plus','primary cr-add-cue-button')}</div>
          <div class="cr-cue-search"><label class="cr-tab-search">${icon('search')}<input id="am-cue-search" type="search" aria-label="Find a song or cue ID" placeholder="Find song or cue ID" value="${e(cueQuery)}"></label><label class="cr-review-toggle"><input type="checkbox" id="am-cue-review" ${cueReviewFilter?'checked':''}> Needs review <span>${needsReview}</span></label></div>
          <div class="cr-cue-tools"><button class="cr-tool-link" data-am="preview">${icon('search')} Preview</button><button class="cr-tool-link" data-am-export="IPRS">${icon('check')} Validate</button></div>
          ${deleted?`<div class="cr-cue-undo" role="status"><span>Deleted: <strong>${e(workOf(deleted.cue)?.title||'Cue')}</strong></span>${button('Undo','undo-delete-cue','','small')}</div>`:''}
          <div class="cr-cue-table"><table><thead><tr><th scope="col">#</th><th scope="col">Song / Cue</th></tr></thead><tbody>${visibleRows.map(c=>{const w=workOf(c);return `<tr class="cr-cue-row ${c.id===cueId?'selected':''}" data-am-cue="${e(c.id)}" tabindex="0" role="button" aria-pressed="${c.id===cueId}" aria-label="Select ${e(w?.title||'cue')}"><td>${String(rows.indexOf(c)+1).padStart(2,'0')}</td><td><strong>${e(w?.title||'Unresolved Work')}</strong>${c.occurrences?.length>1?`<small class="cr-cue-sub">${c.occurrences.length} plays · ${e(D.time(c.duration))}</small>`:''}</td></tr>`;}).join('')||`<tr><td colspan="2"><div class="empty"><strong>${rows.length?'No matching cues':'No cues yet'}</strong><p>${rows.length?'Try another song or clear your filters.':'Add a cue or upload a workfile.'}</p>${rows.length?button('Clear filters','clear-cue-filters','','small'):button('Add cue','link-work','plus','small')}</div></td></tr>`}</tbody></table></div>
          <div class="cr-cue-footer"><span>${visibleRows.length} of ${rows.length} cues</span><span>${musicDuration} total</span></div>
        </section>
        <div class="cr-resizer" id="cr-resizer" role="separator" aria-orientation="vertical" aria-label="Resize music cues and selected cue" aria-controls="cr-cue-list am-right" aria-valuemin="18" aria-valuemax="42" aria-valuenow="22" aria-valuetext="22 percent music cues, 78 percent selected cue" title="Drag to resize; Arrow keys adjust; Home / End set limits" tabindex="0"></div>
        <section class="cr-editor" id="am-right" aria-label="Selected cue">${trackPanel()}</section>
      </div>
      ${rangePanel(p)}
    </div>`;
  }
  function trackPanel(){
    if(!draft)return `<section class="cr-track-panel cr-master-panel"><div class="cr-track-head"><div><div class="eyebrow">SELECTED CUE</div><h2>Track details</h2></div></div><div class="empty">Select a cue to see its timing, Work metadata and contributors.</div></section>`;
    const c=draft.cue,w=draft.work,cumulative=Array.isArray(draft.occurrenceRows);
    const rawStart=draft.raw?.start??(c.start==null?'':D.time(c.start)),rawEnd=draft.raw?.end??(c.end==null?'':D.time(c.end)),durationOnly=!rawStart&&!rawEnd;
    if(!w)return '<div class="empty">This cue needs a linked Work.</div>';
    const share=w.parties.reduce((s,p)=>s+(Number(p.share)||0),0),automaticUsage=D.usageSetForCue(c,w.title,w),usageKind=D.titleUsageKind(w.title);
    const p=current(),ep=epOf(p),programDuration=(ep?.duration||p.duration||'');
    const treatment=c.usage?.startsWith('O')?'Opening':c.usage?.startsWith('C')?'Closing':c.usage==='MT'?'Main title':c.usage==='ET'?'End title':'Not specified';
    return `<form id="am-track-form" class="am-form cr-track-form" novalidate><section class="cr-track-panel cr-master-panel">
      <div class="cr-track-head cr-master-head">
        <div class="cr-master-heading"><div class="eyebrow">SELECTED CUE <span>${e(c.id)}</span></div><h2>${e(w.title)}</h2><div class="cr-master-meta"><span>${e(({BI:'Background instrumental',BV:'Background vocal',FI:'Feature instrumental',FV:'Feature vocal',OI:'Opening theme',OV:'Opening vocal',CI:'Closing theme',CV:'Closing vocal',MT:'Main title',ET:'End title',VI:'Visual instrumental',VV:'Visual vocal',T:'Theme',B:'Background',V:'Visual'})[c.usage]||'Usage not specified')}</span><i></i><span>${e(D.time(cumulative?occurrencePreviewDuration(draft.occurrenceRows):c.duration))}</span></div></div>
        <div class="cr-track-state"><span class="cr-saved" id="am-save-state" role="status">${dirty?'Unsaved changes':'Saved'}</span><button class="btn small" type="button" data-work="${e(w.id)}">${icon('settings')} Work details</button>${button('Duplicate','duplicate-cue','copy','small')}${button('Delete','delete-cue','trash','small danger cr-delete-cue')}<button class="btn primary" type="submit" data-am="save-track">${icon('check')} Save</button></div>
      </div>
      <div class="cr-master-body cr-unified-body">
        <section class="cr-master-section cr-cue-details-section">
          <div class="cr-section-heading"><h3>Cue details</h3><span class="cr-work-id">${e(w.id)}</span></div>
          <div class="cr-cue-details-grid ${cumulative?'cr-cumulative-grid':''}">
            <div class="cr-detail-title">${field(cumulative?'Combined cue':'Cue / Song Name','title',w.title,'text',cumulative?'readonly':'required')}</div>
            <div class="field cr-detail-count"><label for="am-usageCount">Number of usages</label><input class="input" id="am-usageCount" name="usageCount" type="number" min="1" step="1" value="${cumulative?draft.occurrenceRows.length:Number(c.usageCount)||1}" ${cumulative?'readonly':''}></div>
            <div class="cr-detail-artist">${field('Singer / recording artist','artist',w.artist)}</div>
            ${cumulative?'':`<div class="cr-static cr-detail-method"><label>Timing method</label><strong id="am-timing-method">${durationOnly?'Duration only':'IN / OUT timecodes'}</strong></div>
            <div class="cr-detail-start">${field('Music IN','start',rawStart,'text','placeholder="HH:MM:SS"')}</div>
            <div class="cr-detail-end">${field('Music OUT','end',rawEnd,'text','placeholder="HH:MM:SS"')}</div>`}
            <div class="field cr-duration"><label for="am-cue-duration">Music duration</label><input class="input" id="am-cue-duration" name="duration" value="${e(cumulative?D.time(occurrencePreviewDuration(draft.occurrenceRows)):draft.raw?.duration??D.time(c.duration))}" ${cumulative||!durationOnly?'readonly':''} placeholder="HH:MM:SS"></div>
            <div class="field cr-detail-program"><label for="am-program-duration">Episode duration</label><input class="input" id="am-program-duration" value="${e(programDuration)}" readonly></div>
            <div class="field cr-detail-usage"><label for="am-usage">Music usage</label><input class="input" id="am-usage" name="usage" value="${e(automaticUsage.IPRS)}" readonly aria-describedby="am-usage-rule"></div>
            <div class="cr-detail-source">${select('Source','source',['Original','Third-party','Library','Unknown'],c.source)}</div>
            <div class="cr-detail-theme">${select('Theme treatment','themeTreatment',['Not specified','Opening','Closing','Main title','End title'],c.themeTreatment||treatment)}</div>
          </div>
          <label class="cr-check" id="am-timing-review" ${durationOnly&&!cumulative?'':'hidden'}><input type="checkbox" name="timingReviewed" ${c.timingReviewed?'checked':''}> Duration-only timing reviewed against the workfile</label>
          ${cumulative?occurrenceEditor():''}
          <div class="cr-detail-groups">
            <div class="cr-detail-group">
              <h4>Recording identifiers</h4>
              <div class="cr-form-grid cr-identifier-grid">${field('ISRC','isrc',w.isrc)}${field('ISWC','iswc',w.iswc||'')}${field('Tune Code','tuneCode',w.tuneCode||'')}</div>
            </div>
            <div class="cr-detail-group cr-society-records">
              <h4>Society work IDs & usage codes</h4>
              <div class="cr-society-record-grid">
                <div class="cr-society-record"><strong>IPRS</strong>${field('Work ID','idIPRS',w.societies.IPRS)}${field('Music usage code','usageIPRS',automaticUsage.IPRS,'text','readonly')}</div>
                <div class="cr-society-record"><strong>PRS</strong>${field('Work ID','idPRS',w.societies.PRS)}${field('Music usage code','usagePRS',automaticUsage.PRS,'text','readonly')}</div>
                <div class="cr-society-record"><strong>ASCAP</strong>${field('Work ID','idASCAP',w.societies.ASCAP)}${field('Music usage code','usageASCAP',automaticUsage.ASCAP,'text','readonly')}</div>
              </div>
              <p class="cr-add-help" id="am-usage-rule">Music usage codes are saved with this song and reused when it is added to other cues or projects.</p>
            </div>
          </div>
        </section>
        <section class="cr-master-section cr-contributors-section">
          <div class="cr-section-heading cr-contrib-head"><div><h3>Contributors & rights</h3></div>${button('Add contributor','add-contributor','plus','small')}</div>
          <div id="am-parties" class="cr-parties">${w.parties.map((party,i)=>partyRow(party,i)).join('')||'<div class="empty">Add the verified rights holders for this Work.</div>'}</div>
          <div id="am-share-total" class="cr-ownership-total am-share ${Math.abs(share-100)>.01?'invalid':''}">Ownership total: ${share}%${Math.abs(share-100)<=.01?' ✓':''}</div>
        </section>
        <section class="cr-master-section cr-notes-section">
          <div class="cr-section-heading"><h3>Cue notes</h3></div>
          <div class="field cr-cue-notes"><textarea class="input" id="am-notes" name="notes" rows="4" aria-label="Cue notes" placeholder="Add a note…">${e(c.notes||'')}</textarea></div>
        </section>
      </div>
    </section></form>`;
  }
  function occurrencePreviewDuration(rows){return rows.reduce((sum,row)=>{const start=D.seconds(row.startText),end=D.seconds(row.endText);return sum+(Number.isFinite(start)&&Number.isFinite(end)&&end>start?end-start:0);},0);}
  function occurrenceEditor(){
    const rows=draft.occurrenceRows||[],duration=occurrencePreviewDuration(rows);
    return `<section class="cr-occurrence-editor" aria-label="Original workfile entries"><div class="cr-occurrence-head"><div><h4>Original workfile entries</h4><p>Edit each play below. Matching names stay combined; different names become separate cues with rights to review.</p></div>${button('Add entry','add-occurrence','plus','small')}</div><div class="cr-occurrence-rows">${rows.map((row,index)=>{const start=D.seconds(row.startText),end=D.seconds(row.endText),valid=Number.isFinite(start)&&Number.isFinite(end)&&end>start;return `<div class="cr-occurrence-row" data-am-occurrence="${index}"><span class="cr-occurrence-number">${index+1}</span><label class="cr-occurrence-name"><span>Entry ${index+1}${row.rowNumber?' · Workbook row '+row.rowNumber:''} · Track name</span><input class="input" name="occurrenceTitle" value="${e(row.title||'')}" aria-label="Entry ${index+1} track name" required></label><label class="cr-occurrence-in"><span>Music IN</span><input class="input" name="occurrenceStart" value="${e(row.startText||'')}" aria-label="Entry ${index+1} Music IN" placeholder="HH:MM:SS" required></label><label class="cr-occurrence-out"><span>Music OUT</span><input class="input" name="occurrenceEnd" value="${e(row.endText||'')}" aria-label="Entry ${index+1} Music OUT" placeholder="HH:MM:SS" required></label><label class="cr-occurrence-duration"><span>Duration</span><input class="input" value="${valid?e(D.time(end-start)):'Check times'}" aria-label="Entry ${index+1} duration" readonly></label><button class="btn small ghost cr-occurrence-remove" type="button" data-am="remove-occurrence" data-index="${index}" ${rows.length===1?'disabled':''}>Remove</button>${row.importWarnings?.length?`<small class="cr-occurrence-warning">Import note: ${e(row.importWarnings.join(' · '))}</small>`:''}</div>`;}).join('')}</div><div class="cr-occurrence-total"><div><strong>Combined music duration</strong><small>Sum of ${rows.length} ${rows.length===1?'entry':'entries'} in this episode</small></div><strong id="am-occurrence-total">${e(D.time(duration))}</strong></div></section>`;
  }
  function refreshOccurrenceEditor(){dirty=true;$('#am-right').innerHTML=trackPanel();mount('builder');$('#am-save-state').textContent='Unsaved changes';}
  function addOccurrence(){if(!draft?.occurrenceRows)return;collect();draft.occurrenceRows.push({title:draft.occurrenceRows[0]?.title||draft.work.title,startText:'',endText:'',notes:'',importWarnings:[],importedValues:{}});refreshOccurrenceEditor();$('#am-right [data-am-occurrence]:last-child [name="occurrenceStart"]')?.focus();}
  function removeOccurrence(index){if(!draft?.occurrenceRows||draft.occurrenceRows.length<=1)return;collect();if(!Number.isInteger(index)||index<0||index>=draft.occurrenceRows.length)return;draft.occurrenceRows.splice(index,1);refreshOccurrenceEditor();}
  function refreshOccurrenceTotals(){
    const rows=[...document.querySelectorAll('#am-track-form [data-am-occurrence]')];let total=0;
    rows.forEach(row=>{const start=D.seconds(row.querySelector('[name="occurrenceStart"]').value),end=D.seconds(row.querySelector('[name="occurrenceEnd"]').value),valid=Number.isFinite(start)&&Number.isFinite(end)&&end>start;row.querySelector('.cr-occurrence-duration .input').value=valid?D.time(end-start):'Check times';if(valid)total+=end-start;});
    const formatted=D.time(total),summary=$('#am-occurrence-total'),duration=$('#am-cue-duration'),count=$('#am-usageCount');if(summary)summary.textContent=formatted;if(duration)duration.value=formatted;if(count)count.value=rows.length;
    const header=$('#am-track-form .cr-master-meta span:last-child');if(header)header.textContent=formatted;
  }
  function partyRow(p,i){return `<div class="am-party cr-party" data-am-party="${i}"><div class="cr-party-top"><strong>Contributor ${i+1}</strong><button type="button" class="btn small cr-remove-party" data-am-remove-party="${i}">${icon('close')} Remove</button></div><div class="cr-party-grid"><div class="field cr-party-name"><label>Name</label><input class="input" data-key="name" aria-label="Contributor name" value="${e(p.name)}"></div><div class="field cr-party-role"><label>Role</label><select class="input" data-key="role" aria-label="Contributor role">${options(['Composer',{value:'Lyricist',label:'Lyricist / Author'},{value:'Composer / Lyricist',label:'Composer + Lyricist / Author'},'Publisher','Label','Arranger','Adaptor'],p.role)}</select></div><div class="field"><label>IPI</label><input class="input" data-key="ipi" aria-label="Contributor IPI" value="${e(p.ipi)}"></div><div class="field"><label>Society</label><input class="input" data-key="society" aria-label="Contributor society" value="${e(p.society)}"></div><div class="field"><label>Ownership %</label><input class="input" data-key="share" aria-label="Contributor share" type="number" min="0" max="100" step="0.01" value="${p.share??''}"></div></div></div>`;}
  function collect(){
    const form=$('#am-track-form');if(!form||!draft)return;
    const f=new FormData(form),w=draft.work,c=draft.cue;
    w.title=String(f.get('title')||'').trim();
    const artist=String(f.get('artist')||'').trim();if(artist!==w.artist)delete w.artistIds;w.artist=artist;
    w.isrc=String(f.get('isrc')||'').trim();w.iswc=String(f.get('iswc')||'').trim();w.tuneCode=String(f.get('tuneCode')||'').trim();w.status='Complete';w.research={...w.research};
    c.source=f.get('source');c.societyUsage={...c.societyUsage,...D.usageSetForCue(c,w.title,w)};w.societyUsage={...c.societyUsage};if(!c.usage)c.usage=c.societyUsage.IPRS;
    if(draft.occurrenceRows){
      draft.occurrenceRows=[...form.querySelectorAll('[data-am-occurrence]')].map((row,index)=>({...draft.occurrenceRows[index],title:row.querySelector('[name="occurrenceTitle"]').value,startText:row.querySelector('[name="occurrenceStart"]').value,endText:row.querySelector('[name="occurrenceEnd"]').value}));
      c.usageCount=draft.occurrenceRows.length;
    }else c.usageCount=Math.max(1,Number(f.get('usageCount'))||1);
    c.themeTreatment=f.get('themeTreatment')||'Not specified';c.notes=String(f.get('notes')||'');
    for(const s of ['IPRS','PRS','ASCAP'])w.societies[s]=String(f.get('id'+s)||'').trim();
    draft.raw={title:w.title,start:f.get('start'),end:f.get('end'),duration:f.get('duration'),usage:c.usage};c.timingReviewed=f.has('timingReviewed');
    w.parties=[...form.querySelectorAll('[data-am-party]')].map(row=>{const get=k=>row.querySelector(`[data-key="${k}"]`).value.trim();return {...w.parties[Number(row.dataset.amParty)],name:get('name'),role:get('role'),society:get('society'),ipi:get('ipi'),share:get('share')===''?null:Number(get('share'))};});
  }
  function updateAutomaticUsage(title){const set=D.usageSetForCue(draft?.cue||{},title,draft?.work),kind=D.titleUsageKind(title);for(const [id,value] of Object.entries({usage:set.IPRS,usageIPRS:set.IPRS,usagePRS:set.PRS,usageASCAP:set.ASCAP})){const input=$('#am-'+id);if(input)input.value=value;}const help=$('#am-usage-rule');if(help)help.textContent='Music usage codes are saved with this song and reused when it is added to other cues or projects.';}
  function flush(){if(episodeDirty&&!persistEpisode(Object.fromEntries(new FormData($('#am-episode-form'))),false))return false;if(!dirty)return true;return saveTrack(false);}
  function persistEpisode(f,add){const p=current(),n=Number(f.number),duration=D.seconds(f.duration);if(p.type==='Movie'&&!f.title.trim()){toast('A movie title is required.');return false;}if(p.type==='Series'&&(!Number.isInteger(n)||n<1)){toast('Episode numbers must be positive whole numbers.');return false;}if(p.type==='Series'&&p.episodes.some(ep=>ep.number===n&&(add||ep.number!==episodeNumber))){toast('That episode number already exists in this production.');return false;}if(f.duration&&(!Number.isFinite(duration)||duration<=0)){toast('Program duration must be a valid positive HH:MM:SS time.');return false;}const ok=commit('Saved '+(p.type==='Movie'?'movie details':'episode '+n)+' · '+p.title,s=>{if(p.type==='Movie'){p.title=f.title;p.airdate=f.airdate;p.duration=f.duration;}else if(add)p.episodes.push({number:n,title:f.title,airdate:f.airdate,duration:f.duration,createdAt:now(),updatedAt:now()});else{const old=episodeNumber;Object.assign(epOf(p),{number:n,title:f.title,airdate:f.airdate,duration:f.duration,updatedAt:now()});s.cues.filter(c=>c.projectId===p.id&&c.episode===old).forEach(c=>c.episode=n);}p.updatedAt=now();});if(ok){episodeNumber=p.type==='Movie'?null:n;episodeDirty=false;if(draft&&!add)draft.cue.episode=episodeNumber;}return ok;}
  function identifierConflict(work,ignoreId){return data().works.some(other=>other.id!==ignoreId&&((work.isrc&&D.normalize(work.isrc)===D.normalize(other.isrc))||(work.iswc&&D.normalize(work.iswc)===D.normalize(other.iswc))||(work.tuneCode&&D.normalize(work.tuneCode)===D.normalize(other.tuneCode))||Object.keys(work.societies||{}).some(s=>work.societies[s]&&D.normalize(work.societies[s])===D.normalize(other.societies?.[s]))));}
  function titleSaveModal(storedWork){modal('Save as updated data?',`<div class="cr-title-choice"><p>You have changed the Cue/Song Name. This may represent a different work in the database.</p><p class="subtitle"><strong>${e(storedWork.title)}</strong> → <strong>${e(draft.work.title)}</strong></p><div class="cr-title-choice-grid"><button type="button" data-am="title-save-new"><strong>Save as New Record</strong><span>Keep the original song unchanged and link only this cue to a new database record. Identifiers still owned by the original stay with it.</span></button><button type="button" data-am="title-save-update"><strong>Update Existing Record</strong><span>Rename the shared Work. Every cue linked to it will use the updated name.</span></button></div><div class="panel-actions">${button('Cancel','title-save-cancel')}</div></div>`);}
  function finishCueSwitch(saved=false){if(!pendingCueSwitch)return false;const next=pendingCueSwitch;pendingCueSwitch=null;api.close();cueId=next;loadDraft();api.render();if(saved)toast('Changes saved. The next cue is ready.');return true;}
  function cancelTitleChange(){const stored=data().works.find(work=>work.id===draft?.work?.id);if(!stored)return api.close();draft.work.title=stored.title;if(draft.raw)draft.raw.title=stored.title;const input=$('#am-title');if(input)input.value=stored.title;dirty=JSON.stringify(draft.work)!==JSON.stringify(stored)||JSON.stringify(draft.cue)!==JSON.stringify(data().cues.find(cue=>cue.id===draft.cue.id));pendingCueSwitch=null;api.close();const state=$('#am-save-state');if(state)state.textContent=dirty?'Unsaved changes':'All changes saved';toast('The pending name change was discarded.');}
  function requestCueSwitch(id){if(id===cueId)return;if(!dirty&&!episodeDirty){cueId=id;loadDraft();api.render();return;}pendingCueSwitch=id;modal('You have unsaved changes',`<div class="cr-unsaved-choice"><p>Save your changes before opening the next cue?</p><div class="panel-actions">${button('Cancel','cue-switch-cancel')}${button('Discard Changes','cue-switch-discard','','danger')}${button('Save & Continue','cue-switch-save','check','primary')}</div></div>`);}
  function saveSplitOccurrences(prepared,announce){
    const original=data().works.find(work=>work.id===draft.work.id),baseCue=draft.cue;
    if(!original){toast('The linked Work could not be found.');return false;}
    const groups=new Map();
    prepared.occurrences.forEach(use=>{const key=D.normalize(use.title);if(!groups.has(key))groups.set(key,{title:use.title,uses:[]});groups.get(key).uses.push(use);});
    const ordered=[...groups.values()].sort((a,b)=>Number(D.normalize(b.title)===D.normalize(original.title))-Number(D.normalize(a.title)===D.normalize(original.title)));
    const newWorks=[],newCues=[],reserved=new Set();
    for(const [index,group] of ordered.entries()){
      const existing=D.normalize(group.title)===D.normalize(original.title),matches=existing?[]:data().works.filter(saved=>D.normalize(saved.title)===D.normalize(group.title));
      const work=existing?structuredClone(draft.work):matches.length===1?structuredClone(matches[0]):{id:uid('WRK'),title:group.title,alternateTitles:[],type:'Song',language:draft.work.language||'',status:matches.length?'Needs resolution':'Needs review',isrc:'',iswc:'',tuneCode:'',societies:{IPRS:'',PRS:'',ASCAP:''},parties:[],artist:'',source:'Unknown',notes:'',research:{source:'',url:'',notes:''},needsMetadata:true,needsResolution:matches.length>1,possibleMatchIds:matches.map(saved=>saved.id),resolutionReason:matches.length>1?'Track name matches multiple saved songs':'',activity:[{text:'Created for review when combined cue entries were separated',date:now()}]},cue=structuredClone(baseCue);
      work.title=group.title;
      if(!existing&&matches.length!==1){
        newWorks.push(work);
      }
      cue.id=index===0?baseCue.id:uid('CUE');cue.workId=work.id;
      if(!existing){cue.societyUsage=D.usageSetForTitle(group.title);cue.usage=cue.societyUsage.IPRS;}
      cue.occurrences=group.uses.map(({startText,endText,...use})=>use);
      cue.usageCount=cue.occurrences.length;
      cue.duration=cue.occurrences.reduce((sum,use)=>sum+use.duration,0);
      cue.start=cue.occurrences.length===1?cue.occurrences[0].start:null;
      cue.end=cue.occurrences.length===1?cue.occurrences[0].end:null;
      cue.importedFromWorkfile=true;
      const times=cue.occurrences.map(use=>use.start+'|'+use.end);
      if(times.some(time=>reserved.has(work.id+'|'+time))){toast('Two entries for the same song have duplicate IN and OUT times.');return false;}
      times.forEach(time=>reserved.add(work.id+'|'+time));
      if(data().cues.some(other=>other.id!==baseCue.id&&other.projectId===cue.projectId&&other.episode===cue.episode&&other.workId===cue.workId&&cue.occurrences.some(use=>other.start===use.start&&other.end===use.end||other.occurrences?.some(saved=>saved.start===use.start&&saved.end===use.end)))){toast('An entry duplicates another cue occurrence.');return false;}
      newCues.push(cue);
    }
    const retained=ordered.some(group=>D.normalize(group.title)===D.normalize(original.title));
    if(retained&&identifierConflict(draft.work,draft.work.id)){toast('An identifier belongs to another Work. Select that Work or enter unique identifiers.');return false;}
    const ok=commit('Separated '+prepared.occurrences.length+' entries into '+ordered.length+' song cues',state=>{
      if(retained){draft.work.title=original.title;draft.work.activity??=[];draft.work.activity.unshift({text:'Updated from episode workspace',date:now()});state.works[state.works.findIndex(work=>work.id===original.id)]=structuredClone(draft.work);}
      state.works.push(...newWorks.map(work=>structuredClone(work)));
      state.cues[state.cues.findIndex(cue=>cue.id===baseCue.id)]=structuredClone(newCues[0]);
      state.cues.push(...newCues.slice(1).map(cue=>structuredClone(cue)));
      state.projects.find(project=>project.id===projectId).updatedAt=now();
    });
    if(!ok){dirty=true;return false;}
    cueId=newCues[0].id;loadDraft();rangeIssues=null;
    if(finishCueSwitch(true))return true;
    if(announce){api.render();toast(ordered.length+' song cues saved from the original entries.');}
    return true;
  }
  function saveTrack(announce=true,titleMode=''){
    if(episodeDirty&&!persistEpisode(Object.fromEntries(new FormData(document.querySelector('#am-episode-form'))),false))return false;
    if(!draft){if(announce)toast('No track selected.');return true;}
    collect();let {work:w,cue:c}=draft;const cumulative=Array.isArray(draft.occurrenceRows),programSeconds=D.seconds(epOf(current())?.duration||current()?.duration),prepared=cumulative?D.validateOccurrenceRows(draft.occurrenceRows,programSeconds):null;
    if(prepared?.errors.length){toast(prepared.errors.join('. '));return false;}
    if(w.parties.some(p=>!p.name||(p.share!==null&&(!Number.isFinite(p.share)||p.share<0||p.share>100)))){toast('Each contributor needs a name and a share between 0 and 100, or an empty share when unknown.');return false;}
    if(cumulative&&new Set(prepared.occurrences.map(use=>D.normalize(use.title))).size>1)return saveSplitOccurrences(prepared,announce);
    if(cumulative)w.title=prepared.title;
    const storedWork=data().works.find(work=>work.id===w.id);
    if(!w.title){toast('Enter a cue or song name before saving.');return false;}
    if(storedWork&&w.title!==storedWork.title&&!titleMode){titleSaveAnnounce=announce;titleSaveModal(storedWork);return false;}
    const v=cumulative?{errors:[],start:prepared.occurrences.length===1?prepared.occurrences[0].start:null,end:prepared.occurrences.length===1?prepared.occurrences[0].end:null,duration:prepared.duration}:D.validateRow(draft.raw);if(v.errors.length){toast(v.errors.join('. '));return false;}
    if(w.parties.some(p=>!p.name||(p.share!==null&&(!Number.isFinite(p.share)||p.share<0||p.share>100)))){toast('Each contributor needs a name and a share between 0 and 100, or an empty share when unknown.');return false;}
    if(titleMode==='new'&&storedWork){const fresh=structuredClone(w);fresh.id=uid('WRK');for(const field of ['isrc','iswc','tuneCode'])if(fresh[field]&&D.normalize(fresh[field])===D.normalize(storedWork[field]))fresh[field]='';for(const society of Object.keys(fresh.societies||{}))if(fresh.societies[society]&&D.normalize(fresh.societies[society])===D.normalize(storedWork.societies?.[society]))fresh.societies[society]='';fresh.activity=[{text:'Created from cue name change; original Work preserved',date:now()},...(fresh.activity||[])];w=fresh;c.workId=fresh.id;draft.work=fresh;}
    if(identifierConflict(w,titleMode==='new'?'':w.id)){toast('An identifier belongs to another Work. Select that Work or enter unique identifiers.');return false;}
    Object.assign(c,{start:v.start,end:v.end,duration:v.duration});if(cumulative){c.occurrences=prepared.occurrences.map(({startText,endText,...use})=>use);c.usageCount=c.occurrences.length;c.importedFromWorkfile=true;}else if(c.occurrences?.length===1)Object.assign(c.occurrences[0],{start:c.start,end:c.end,duration:c.duration});const storedCue=data().cues.find(saved=>saved.id===c.id),timingChanged=!storedCue||['projectId','episode','workId','start','end'].some(key=>storedCue[key]!==c[key]);
    if(timingChanged&&data().cues.some(other=>other.id!==c.id&&other.projectId===c.projectId&&other.episode===c.episode&&other.workId===c.workId&&other.start===c.start&&other.end===c.end&&c.start!==null)){toast('These times duplicate another cue occurrence.');return false;}
    if(cumulative&&data().cues.some(other=>other.id!==c.id&&other.projectId===c.projectId&&other.episode===c.episode&&other.workId===c.workId&&c.occurrences.some(use=>other.start===use.start&&other.end===use.end||other.occurrences?.some(saved=>saved.start===use.start&&saved.end===use.end)))){toast('An entry duplicates another cue occurrence.');return false;}
    const isNew=titleMode==='new',ok=commit((isNew?'Created new song record · ':'Updated ')+w.title+' · cue timing',s=>{w.activity??=[];if(!isNew)w.activity.unshift({text:'Updated from episode workspace',date:now()});if(isNew)s.works.push(structuredClone(w));else s.works[s.works.findIndex(x=>x.id===w.id)]=structuredClone(w);s.cues[s.cues.findIndex(x=>x.id===c.id)]=structuredClone(c);s.projects.find(project=>project.id===projectId).updatedAt=now();});
    if(!ok){dirty=true;return false;}loadDraft();rangeIssues=null;if(titleMode)api.close();if(finishCueSwitch(true))return true;if(announce||titleMode){api.render();toast(isNew?'New song record saved for this cue. The original record was preserved.':'Saved. Linked cues use the updated master Work.');}return true;
  }
  function rangePanel(p){
    const eps=[...p.episodes].sort((a,b)=>a.number-b.number);if(p.type==='Series'&&!eps.some(ep=>ep.number===Number(from)))from=eps[0]?.number;if(p.type==='Series'&&!eps.some(ep=>ep.number===Number(to)))to=from;
    const opts=eps.map(ep=>({value:ep.number,label:'Episode '+ep.number+(ep.title?' · '+ep.title:'')})),selected=p.type==='Movie'?[{number:null}]:eps.filter(ep=>ep.number>=Number(from)&&ep.number<=Number(to)),selectedCues=selected.flatMap(ep=>cuesOf(p,ep.number)),duration=D.time(selectedCues.reduce((sum,cue)=>sum+(Number(cue.duration)||0),0));
    return `<section class="panel am-export-panel cr-range-export" id="am-export-panel"><div class="cr-range-head"><div><span class="cr-range-kicker">EXCEL EXPORT</span><h2>Export ${p.type==='Movie'?'movie':'episodes'}</h2><p>Choose content and a society. Every file uses the supplied official reference layout.</p></div>${button('Close','close-export','','small')}</div><div class="cr-range-summary"><div><span>Selected</span><strong>${selected.length} ${selected.length===1?'content unit':'episodes'}</strong></div><div><span>Cues</span><strong>${selectedCues.length}</strong></div><div><span>Music duration</span><strong>${duration}</strong></div></div><div class="cr-range-grid"><div class="cr-range-card"><span class="cr-range-step">1</span><div><h3>${p.type==='Movie'?'Movie selected':'Choose episode range'}</h3>${p.type==='Series'?`<div class="am-export-range">${select('From episode','rangeFrom',opts,from)}${select('To episode','rangeTo',opts,to)}</div><p>Each episode becomes one formatted Excel file in a single ZIP.</p>`:`<p>${e(p.title)} will be exported as one formatted Excel file.</p>`}</div></div><div class="cr-range-card"><span class="cr-range-step">2</span><div><h3>Choose society format</h3><div class="am-export-buttons">${['IPRS','PRS','ASCAP'].map(s=>`<button data-am-range="${s}" class="am-export-${s.toLowerCase()} ${reviewSociety===s?'selected':''}" ${rangeBusy?'disabled':''}><strong>${s}</strong><span>Check & prepare</span>${icon('arrow')}</button>`).join('')}</div></div></div></div><div class="cr-range-required"><div><strong>Required before export</strong><span>Music usage · Music duration · Contributor names · Ownership total exactly 100%</span></div><p>Society IDs, IPI/CAE, artist and other metadata may be left blank.</p></div>${rangeIssues?`<div class="am-validation ${rangeIssues.length?'blocked':'ready'}"><div class="cr-validation-head"><strong>${e(reviewSociety)} · ${rangeIssues.length?rangeIssues.length+' item'+(rangeIssues.length===1?'':'s')+' to complete':'Ready to download'}</strong>${!rangeIssues.length?button(rangeBusy?'Preparing ZIP…':'Download '+reviewSociety+' Excel ZIP','download-range','download','primary'):''}</div>${rangeIssues.map(i=>`<div><span>${e(i.message)}</span>${i.cueId?`<button class="btn small" data-am-issue-cue="${e(i.cueId)}">Open cue</button>`:''}</div>`).join('')}</div>`:''}</section>`;
  }
  function selectedEpisodes(){const p=current();return p.type==='Movie'?[{number:null,title:p.title}]:p.episodes.filter(ep=>ep.number>=Number(from)&&ep.number<=Number(to)).sort((a,b)=>a.number-b.number);}
  function validateRange(society){const p=current(),episodes=selectedEpisodes(),issues=[];if(!episodes.length)issues.push({message:'Select a valid episode range.'});for(const ep of episodes){const cues=cuesOf(p,ep.number);issues.push(...D.validateExport(cues,data().works,society,p).map(i=>({...i,message:(ep.number?'Episode '+ep.number+': ':'')+i.message})));}return issues;}
  function downloadRange(){if(!flush())return;api.openExport(current(),from,{episodeNumbers:selectedEpisodes().map(ep=>ep.number)});}
  function openEpisodeDownload(number){if(!flush())return;api.openExport(current(),number);}
  function episodeBulkDeleteModal(){const p=current(),numbers=[...selectedEpisodeNumbers].filter(number=>p.episodes.some(ep=>Number(ep.number)===Number(number)));if(!numbers.length)return toast('Select at least one episode first.');const cues=data().cues.filter(cue=>cue.projectId===p.id&&numbers.includes(Number(cue.episode))).length;modal('Delete selected episodes?',`<div class="cr-episode-delete"><p><strong>${numbers.length} ${numbers.length===1?'episode':'episodes'}</strong> and <strong>${cues} linked ${cues===1?'cue':'cues'}</strong> will be removed from ${e(p.title)}.</p><p class="cr-delete-unsaved">Song records stay in the database. Deleted-cue history for these episodes is also removed; export snapshots stay unchanged.</p><label class="cr-confirm-delete"><input type="checkbox" id="am-confirm-episode-delete"> I understand that these episode records cannot be restored.</label><div class="panel-actions">${button('Cancel','close-modal')}<button type="button" class="btn danger" data-am="confirm-delete-episodes">${icon('trash')}Delete ${numbers.length} ${numbers.length===1?'episode':'episodes'}</button></div></div>`);}
  function deleteSelectedEpisodes(){const confirm=$('#am-confirm-episode-delete');if(!confirm?.checked)return toast('Confirm the episode deletion first.');const p=current(),numbers=[...selectedEpisodeNumbers];if(!commit('Deleted '+numbers.length+' episodes · '+p.title,s=>{p.episodes=p.episodes.filter(ep=>!numbers.includes(Number(ep.number)));s.cues=s.cues.filter(cue=>cue.projectId!==p.id||!numbers.includes(Number(cue.episode)));s.deletedCues=(s.deletedCues||[]).filter(item=>item.cue?.projectId!==p.id||!numbers.includes(Number(item.cue?.episode)));p.updatedAt=now();}))return;selectedEpisodeNumbers.clear();if(numbers.includes(Number(episodeNumber))){episodeNumber=p.episodes[0]?.number??null;cueId=cuesOf()[0]?.id||null;}else if(cueId&&!data().cues.some(cue=>cue.id===cueId))cueId=cuesOf()[0]?.id||null;loadDraft();rangeIssues=null;api.close();api.render();toast(`${numbers.length} ${numbers.length===1?'episode':'episodes'} deleted.`);}
  function modal(title,body){const template=document.createElement('template');template.innerHTML=body;template.content.querySelectorAll('[name][id^="am-"]').forEach(input=>{const old=input.id;input.id='dialog-'+old;template.content.querySelectorAll('label').forEach(label=>{if(label.htmlFor===old)label.htmlFor=input.id;});});api.modal(api.modalHead(title)+`<div class="modal-body">${template.innerHTML}</div>`);}
  function production(){
    if(!flush())return;const p=current(),movie=p.type==='Movie';
    modal(movie?'Movie production details':'Series production details',`<form id="am-production-form" class="am-form"><div class="am-form-section"><h3>${movie?'IPRS movie cue sheet':'IPRS TV/Web Series cue sheet'}</h3><p class="subtitle">These details fill the production header in your export. Total musical duration is calculated from the cues.</p><div class="form-grid">${field('Title','title',p.title,'text','required')}${field('Alternative title','altTitle',p.altTitle)}${select('Client','clientId',data().clients.map(c=>({value:c.id,label:c.name})),p.clientId)}${field('Type','type',p.type,'text','readonly')}${field('Genre / category','genre',p.genre)}${field('Language','language',p.language)}${field('Production year','year',p.year,'number','min="1800" max="2500"')}${field(movie?'Production number (from censor certificate)':'Production number','productionNo',p.productionNo)}${movie?`${field('Date of first performed','airdate',p.airdate)}${field('Total movie duration','duration',p.duration,'text','placeholder="HH:MM:SS"')}${field('Total musical duration','musicDuration',D.time(cuesOf(p,null).reduce((sum,c)=>sum+(Number(c.duration)||0),0)),'text','readonly')}`:`${field('Serial type (documentary, soap, web series)','serialType',p.serialType||'Web Series')}${field('Channel name','channel',p.channel)}${field('Season number','season',p.season||1,'number','min="1"')}${field('Total planned episodes','totalEpisodes',p.totalEpisodes,'number','min="0"')}`}${field('Film / item number','filmItemNo',p.filmItemNo)}${field('Country','country',p.country||'India')}${field('Background music composer','bgComposer',p.bgComposer)}${field('Submitted by (name of C/A/E)','submittedBy',p.submittedBy||'Amishna Music')}${select('Assigned editor','assignedEditorId',[{value:'',label:'Unassigned'},...members().filter(m=>m.active).map(m=>({value:m.id,label:m.name}))],p.assignedEditorId)}${select('Project status','status',['Draft','In Progress','Ready for Review','Complete'],p.status)}</div></div><div class="am-form-section"><h3>${movie?'Movie production credits':'Historical production periods'}</h3>${movie?'':'<p class="subtitle">Each episode uses its own period. Ranges must not overlap; changes to one period do not alter other periods.</p>'}<div id="am-periods">${(movie?[p.periods[0]||{from:1,to:1}]:p.periods).map((period,i)=>periodRow(period,i,movie)).join('')}</div>${movie?'':button('Add production period','add-period','plus','small')}</div><div class="am-form-section"><h3>ASCAP contact block</h3><div class="form-grid">${['companyName','contact','address','phone','network'].map(key=>field(key[0].toUpperCase()+key.slice(1),'ascap_'+key,p.ascap?.[key]||'')).join('')}</div></div><div class="panel-actions">${button('Cancel','close-modal')}<button class="btn primary" type="submit">Save production details</button></div></form>`);
  }
  function periodRow(p,i,movie=false){return `<div class="am-period" data-am-period="${i}">${movie?'':`<div class="am-period-heading">Period ${i+1}</div>`}<div class="form-grid">${movie?`<input type="hidden" name="periodFrom${i}" value="1"><input type="hidden" name="periodTo${i}" value="1">`:`${field('From episode','periodFrom'+i,p.from,'number','min="1" required')}${field('To episode','periodTo'+i,p.to,'number','min="1" required')}`}${field('Director','director'+i,p.director)}${field('Producer','producer'+i,p.producer)}${field('Banner / production company','company'+i,p.company)}${field('Principal actors / actress','cast'+i,p.cast)}</div></div>`;}
  function addEpisode(){if(!flush())return;const p=current(),n=Math.max(0,...p.episodes.map(e=>Number(e.number)))+1;modal('Add episode',`<form id="am-add-episode" class="am-form"><div class="form-grid">${field('Episode number','number',n,'number','required min="1" step="1"')}${field('Episode name','title','','text','placeholder="Enter the actual episode name"')}${field('Air date','airdate','')}${field('Program duration','duration','','text','placeholder="HH:MM:SS"')}</div><p class="subtitle">The name remains empty until provided. Review the production period covering this episode.</p><div class="panel-actions">${button('Cancel','close-modal')}<button class="btn primary" type="submit">Create episode</button></div></form>`);}
  function linkWork(){
    if(!flush())return;
    const p=current();if(!p)return api.go('projects');
    const newEpisode=p.type==='Series'&&!p.episodes.length;
    const nextEpisode=Math.max(0,...p.episodes.map(ep=>Number(ep.number)))+1;
    modal('Add cue',`<form id="am-link-work" class="am-form cr-add-cue-form"><div class="cr-add-scroll">
      <div class="cr-add-top">
        <div class="cr-add-context"><span>Project</span><strong>${e(p.title)}</strong><small>${e(p.type)}</small></div>
        ${p.type==='Series'?`<section class="cr-add-episode"><div class="cr-add-mini-head"><span>Episode</span><small>Where this cue appears</small></div><div class="form-grid">${select('Add to episode','episode',[...p.episodes.map(ep=>({value:ep.number,label:'Episode '+ep.number+(ep.title?' · '+ep.title:'')})),{value:'new',label:'+ Create an episode'}],newEpisode?'new':episodeNumber)}</div><fieldset id="am-new-episode-fields" class="cr-add-fieldset" ${newEpisode?'':'hidden disabled'}><div class="form-grid">${field('New episode number','newEpisodeNumber',nextEpisode,'number','required min="1" step="1"')}${field('New episode name','newEpisodeTitle','')}</div></fieldset></section>`:`<div class="cr-add-movie"><span>Content</span><strong>Feature / movie cue</strong></div>`}
      </div>
      <div class="cr-add-layout">
      <section class="cr-add-section cr-add-song-section"><div class="cr-add-section-head"><span>1</span><div><h3>Find the song</h3><p>Enter what you know. Saved details fill automatically.</p></div></div><div class="cr-song-finder">
        ${field('Find or add a song','songSearch','','search','autocomplete="off" aria-autocomplete="list" aria-controls="am-song-results" placeholder="Song name, singer, ISRC, ISWC, Tune Code, IPRS or ASCAP code"')}
        <input type="hidden" name="workId" value="">
        <div id="am-song-results" class="cr-song-results" role="listbox" aria-label="Matching songs" hidden></div>
        <div id="am-song-resolution" class="cr-song-resolution" aria-live="polite"><span>${icon('search')}</span><div><strong>Start with the song name or any code</strong><p>We will check the database automatically before creating a new song.</p></div></div>
      </div>
      <fieldset id="am-new-song-fields" class="cr-add-fieldset" hidden disabled>
        <div class="cr-new-song-note"><strong>New song</strong><span>No exact database record was found. Add the available identifiers and rights details; the song will be saved directly to the database.</span></div>
        <div class="form-grid">${field('Singer / recording artist','artist','')}${select('Song type','type',['Song','Score','Theme','Instrumental','Library'],'Song')}${field('Language','language',p.language||'')}${field('Record label','label','')}${field('Alternate titles (comma separated)','alternateTitles','')}</div>
        <details class="cr-add-details"><summary>Recording & society IDs</summary><div class="form-grid">${field('ISRC','isrc','')}${field('ISWC','iswc','')}${field('Tune Code','tuneCode','')}${['IPRS','PRS','ASCAP'].map(s=>field(s+' work ID','id'+s,'')).join('')}</div></details>
        <details class="cr-add-details"><summary>Contributors & rights</summary><div id="am-new-contributors"></div>${button('Add contributor','add-new-contributor','plus','small')}</details>
      </fieldset></section>
      <section class="cr-add-section cr-add-timing-section"><div class="cr-add-section-head"><span>2</span><div><h3>Timing & usage</h3><p>Use IN and OUT timecodes, or enter duration only.</p></div></div><div class="form-grid cr-add-timing">${field('Music IN','start','','text','placeholder="HH:MM:SS"')}${field('Music OUT','end','','text','placeholder="HH:MM:SS"')}${field('Music duration','duration','','text','placeholder="HH:MM:SS" aria-describedby="am-add-timing-help"')}${field('Music usage (automatic)','usage',D.usageFromTitle('','IPRS'),'text','readonly')}${select('Source','source',['Original','Third-party','Library','Unknown'],'Unknown')}${field('Cue notes','notes','')}</div><p id="am-add-timing-help" class="cr-add-help">Duration is calculated when both timecodes are valid. Usage codes are classified automatically from the cue title.</p></section>
      </div>
      <div class="cr-add-error" role="alert" id="am-add-cue-error" hidden></div></div><div class="panel-actions"><span class="cr-add-safe">${icon('check')} Database checked before save</span><div>${button('Cancel','close-modal')}<button class="btn primary" type="submit">${icon('plus')}<span id="am-add-cue-label">Add cue</span></button></div></div>
    </form>`);
    document.querySelector('.modal')?.classList.add('cr-add-cue-modal');
    setTimeout(()=>$('#am-link-work [name="songSearch"]')?.focus(),0);
  }
  const songValues=w=>[w.id,w.title,w.artist,w.isrc,w.iswc,w.tuneCode,...(w.alternateTitles||[]),...Object.values(w.societies||{})].filter(Boolean);
  const exactSongMatches=query=>{const key=D.normalize(query);if(!key)return[];const identifier=data().works.filter(w=>[w.id,w.isrc,w.iswc,w.tuneCode,...Object.values(w.societies||{})].some(value=>D.normalize(value)===key));if(identifier.length)return identifier;return data().works.filter(w=>[w.title,...(w.alternateTitles||[])].some(value=>D.normalize(value)===key));};
  function songMatches(query=''){
    const key=D.normalize(query);if(!key)return[];
    return [...data().works].filter(w=>songValues(w).some(value=>D.normalize(value).includes(key))).sort((a,b)=>{const rank=w=>[w.id,w.isrc,w.iswc,w.tuneCode,...Object.values(w.societies||{})].some(value=>D.normalize(value)===key)?0:[w.title,...(w.alternateTitles||[])].some(value=>D.normalize(value)===key)?1:D.normalize(w.title).startsWith(key)?2:3;return rank(a)-rank(b)||String(a.title||'').localeCompare(String(b.title||''));}).slice(0,8);
  }
  function setNewSongFields(enabled){const group=$('#am-new-song-fields');if(!group)return;group.hidden=!enabled;group.disabled=!enabled;}
  function updateAddCueUsage(form,title){if(form?.elements?.usage)form.elements.usage.value=D.usageFromTitle(title,'IPRS');}
  function selectSong(id,automatic=false){
    const form=$('#am-link-work'),w=data().works.find(work=>work.id===id);if(!form||!w)return;
    form.elements.workId.value=w.id;form.elements.songSearch.value=w.title;setNewSongFields(false);
    const ids=[['Work ID',w.id],['ISRC',w.isrc],['ISWC',w.iswc],['Tune Code',w.tuneCode],['IPRS',w.societies?.IPRS],['ASCAP',w.societies?.ASCAP]].filter(([,value])=>value);
    const results=$('#am-song-results');results.hidden=true;results.innerHTML='';
    $('#am-song-resolution').className='cr-song-resolution found';
    $('#am-song-resolution').innerHTML=`<span>${icon('check')}</span><div><small>${automatic?'Automatically matched in database':'Selected from database'}</small><strong>${e(w.title)}</strong><p>${[w.artist,w.type,w.language].filter(Boolean).map(e).join(' · ')||'Saved song record'} · ${w.parties?.length||0} contributor${w.parties?.length===1?'':'s'}</p><div class="cr-song-id-list">${ids.map(([label,value])=>`<span><b>${e(label)}</b>${e(value)}</span>`).join('')}</div></div><button type="button" class="btn small" data-am="clear-song">Change</button>`;
    form.elements.source.value=w.source||'Unknown';updateAddCueUsage(form,w.title);$('#am-add-cue-label').textContent='Add cue';
  }
  function refreshSongFinder(){
    const form=$('#am-link-work');if(!form)return;const query=form.elements.songSearch.value.trim(),results=$('#am-song-results'),resolution=$('#am-song-resolution');
    form.elements.workId.value='';
    if(!query){results.hidden=true;results.innerHTML='';setNewSongFields(false);updateAddCueUsage(form,'');resolution.className='cr-song-resolution';resolution.innerHTML=`<span>${icon('search')}</span><div><strong>Start with the song name or any code</strong><p>We will check the database automatically before creating a new song.</p></div>`;$('#am-add-cue-label').textContent='Add cue';return;}
    const exact=exactSongMatches(query);if(exact.length===1){selectSong(exact[0].id,true);return;}
    const matches=songMatches(query);results.hidden=!matches.length;results.innerHTML=matches.map(w=>`<button type="button" role="option" data-am="choose-song" data-work-id="${e(w.id)}"><span><strong>${e(w.title)}</strong><small>${e([w.artist,w.isrc,w.iswc,w.tuneCode,w.societies?.IPRS,w.societies?.ASCAP].filter(Boolean).join(' · ')||w.id)}</small></span><em>Use saved song</em></button>`).join('');
    setNewSongFields(exact.length===0);updateAddCueUsage(form,query);resolution.className='cr-song-resolution '+(exact.length?'warning':'new');
    resolution.innerHTML=exact.length?`<span>${icon('alert')}</span><div><strong>More than one exact title match</strong><p>Choose the correct saved song below. A duplicate will not be created.</p></div>`:`<span>${icon('plus')}</span><div><small>${matches.length?'Possible matches are listed above':'Database checked'}</small><strong>Ready to add “${e(query)}” as a new song</strong><p>${matches.length?'Choose a saved song if it is the same recording. Otherwise continue with the new song.':'Optional metadata can be added below.'}</p></div>`;
    $('#am-add-cue-label').textContent=exact.length?'Choose a song':'Create song & add cue';
  }
  function matchNewSongIdentifiers(form){
    const supplied=[['isrc','isrc'],['iswc','iswc'],['tuneCode','tuneCode'],['idIPRS','IPRS'],['idPRS','PRS'],['idASCAP','ASCAP']].map(([name,key])=>[key,String(form.elements[name]?.value||'').trim()]).filter(([,value])=>value);if(!supplied.length)return;
    const matches=new Set();for(const [key,value]of supplied)for(const w of data().works){const stored=['IPRS','PRS','ASCAP'].includes(key)?w.societies?.[key]:w[key];if(stored&&D.normalize(stored)===D.normalize(value))matches.add(w.id);}
    if(matches.size===1){selectSong([...matches][0],true);return;}
    if(matches.size>1){const resolution=$('#am-song-resolution');resolution.className='cr-song-resolution warning';resolution.innerHTML=`<span>${icon('alert')}</span><div><strong>The entered codes point to different saved songs</strong><p>Correct the identifiers before adding this cue.</p></div>`;$('#am-add-cue-label').textContent='Review song codes';}
  }
  function addNewContributor(){
    const host=$('#am-new-contributors');if(!host)return;
    const input=(label,key,type='text',attrs='')=>`<label class="field"><span>${label}</span><input class="input" data-new-party-key="${key}" aria-label="New contributor ${label.toLowerCase()}" type="${type}" ${attrs}></label>`;
    host.insertAdjacentHTML('beforeend',`<div class="cr-new-contributor" data-new-party><div class="cr-new-contributor-head"><strong>Contributor</strong>${button('Remove','remove-new-contributor','close','small')}</div><div class="form-grid">${input('Name','name','text','required')}<label class="field"><span>Role</span><select class="input" data-new-party-key="role" aria-label="New contributor role">${options(['Composer',{value:'Lyricist',label:'Lyricist / Author'},{value:'Composer / Lyricist',label:'Composer + Lyricist / Author'},'Publisher','Label','Arranger','Adaptor'],'Composer')}</select></label>${input('IPI','ipi')}${input('Society','society')}${input('Share %','share','number','min="0" max="100" step="0.01"')}</div></div>`);
    host.lastElementChild.querySelector('input').focus();
  }
  function saveNewCue(form,f){
    const fail=message=>{const error=$('#am-add-cue-error');error.textContent=message;error.hidden=false;toast(message);return false;};
    const p=current(),query=String(f.songSearch||'').trim(),exact=exactSongMatches(query);let w=data().works.find(w=>w.id===f.workId),creating=!w;
    if(!w&&exact.length===1){w=exact[0];creating=false;}
    if(!w&&exact.length>1)return fail('More than one saved song has this title. Choose the correct database record.');
    if(!w&&!query)return fail('Enter a song name or identifier.');
    const targetEpisode=p.type==='Movie'?null:Number(f.episode==='new'?f.newEpisodeNumber:f.episode);
    if(p.type==='Series'&&(!Number.isInteger(targetEpisode)||targetEpisode<1))return fail('Choose a valid episode number.');
    if(p.type==='Series'&&f.episode==='new'&&p.episodes.some(ep=>Number(ep.number)===targetEpisode))return fail('That episode number already exists. Choose it from the episode list.');
    if(p.type==='Series'&&f.episode!=='new'&&!p.episodes.some(ep=>Number(ep.number)===targetEpisode))return fail('Choose an existing episode or create a new one.');
    let title=creating?query:w.title;const v=D.validateRow({...f,title,usage:D.usageFromTitle(title,'IPRS')});
    if(v.errors.length)return fail(v.errors.join('. '));
    if(creating){
      const parties=[...form.querySelectorAll('[data-new-party]')].map(row=>{const get=key=>row.querySelector(`[data-new-party-key="${key}"]`).value.trim();return {name:get('name'),role:get('role'),ipi:get('ipi'),society:get('society'),share:get('share')===''?null:Number(get('share'))};});
      if(parties.some(p=>!p.name||(p.share!==null&&(!Number.isFinite(p.share)||p.share<0||p.share>100))))return fail('Each contributor needs a name and a share between 0 and 100, or an empty share.');
      w={id:uid('WRK'),title,alternateTitles:String(f.alternateTitles||'').split(',').map(t=>t.trim()).filter(Boolean),type:f.type,language:String(f.language||'').trim(),status:'Complete',isrc:String(f.isrc||'').trim(),iswc:String(f.iswc||'').trim(),tuneCode:String(f.tuneCode||'').trim(),societies:Object.fromEntries(['IPRS','PRS','ASCAP'].map(s=>[s,String(f['id'+s]||'').trim()])),parties,artist:String(f.artist||'').trim(),label:String(f.label||'').trim(),source:f.source,research:{source:'',url:'',notes:''},activity:[{text:'Song created from Music cues',date:now()}]};
      const conflicts=data().works.filter(other=>(w.isrc&&D.normalize(w.isrc)===D.normalize(other.isrc))||(w.iswc&&D.normalize(w.iswc)===D.normalize(other.iswc))||(w.tuneCode&&D.normalize(w.tuneCode)===D.normalize(other.tuneCode))||Object.keys(w.societies).some(s=>w.societies[s]&&D.normalize(w.societies[s])===D.normalize(other.societies?.[s])));
      if(conflicts.length>1)return fail('The supplied identifiers belong to different saved songs. Correct the codes before adding this cue.');
      if(conflicts.length===1){w=conflicts[0];title=w.title;creating=false;}
    }
    if(v.start!==null&&data().cues.some(c=>c.projectId===p.id&&c.episode===targetEpisode&&c.workId===w.id&&c.start===v.start&&c.end===v.end))return fail('This song already has a cue at those times in this episode. Use Duplicate cue for an intentional copy.');
    const societyUsage=D.usageSetForWork(w),c={id:uid('CUE'),projectId:p.id,episode:targetEpisode,workId:w.id,start:v.start,end:v.end,duration:v.duration,usage:societyUsage.IPRS,societyUsage,source:f.source||w.source||'Unknown',notes:String(f.notes||''),timingReviewed:false,usageCount:1,themeTreatment:'Not specified'};
    if(!commit('Added cue · '+title+' · '+p.title,s=>{if(creating)s.works.push(w);if(p.type==='Series'&&f.episode==='new')p.episodes.push({number:targetEpisode,title:String(f.newEpisodeTitle||'').trim(),airdate:'',duration:'',createdAt:now(),updatedAt:now()});s.cues.push(c);p.updatedAt=now();}))return fail('The cue could not be saved. Your entries are still here; retry after checking device storage.');
    episodeNumber=targetEpisode;cueId=c.id;episodeQuery=cueQuery=cueReviewFilter='';from=to=targetEpisode;loadDraft();rangeIssues=null;api.close();api.render();toast(creating?'Song created and cue added.':'Saved song matched and cue added.');return true;
  }
  function preview(){if(!flush())return;const p=current(),ep=epOf(p),rows=cuesOf(),period=D.productionFor(p,episodeNumber);modal('Cue sheet preview',`<div class="am-printable"><div class="eyebrow">AMISHNA MUSIC · INTERNAL REVIEW</div><h1>${e(p.title)}</h1><p class="subtitle">${p.type==='Series'?'Episode '+episodeNumber+' · '+e(ep?.title||''):p.type} · ${e(period?.director||'No production period')} · Music duration ${D.time(rows.reduce((s,c)=>s+c.duration,0))}</p><div class="table-wrap spacer"><table><thead><tr><th>#</th><th>TRACK</th><th>DURATION</th><th>CONTRIBUTORS</th><th>USAGE</th></tr></thead><tbody>${rows.map((c,i)=>{const w=workOf(c);return `<tr><td>${i+1}</td><td>${e(w?.title)}</td><td>${D.time(c.duration)}</td><td>${w?.parties.map(p=>e(p.name)+' · '+e(p.role)+' · '+(p.share??'—')+'%').join('<br>')||'No contributors recorded'}</td><td>${['IPRS','PRS','ASCAP'].map(s=>s+': '+e(D.usageFor(c,s,w?.title||'' )||'—')).join('<br>')}</td></tr>`;}).join('')}</tbody></table></div></div><div class="panel-actions"><span class="subtitle">Preview does not indicate society export approval.</span>${button('Print preview','print','file')}</div>`);}
  function memberView(){initialize();return `<div class="am-page-head"><div class="am-heading-row"><div><h1>Members</h1><p>Your editors and the projects they are working on.</p></div>${button('Add editor','add-member','plus','primary')}</div></div><div class="notice info">Team records store your editors and their production assignments.</div><div class="card-grid">${members().map(m=>`<section class="project-card"><div class="am-member-header"><div class="am-avatar">${e(m.name.split(' ').map(s=>s[0]).slice(0,2).join(''))}</div><div><h2>${e(m.name)}</h2><p>${e(m.email)}</p></div></div><div class="button-row spacer">${status(m.active?'Editor':'Inactive')}<span class="muted">${data().projects.filter(p=>p.assignedEditorId===m.id).length} assigned projects</span></div><div class="button-row spacer"><button class="btn small" data-am-edit-member="${e(m.id)}">Edit member</button></div></section>`).join('')}</div>`;}
  function memberModal(id){const m=members().find(m=>m.id===id);modal(m?'Edit member':'Add editor',`<form id="am-member-form" class="am-form" data-id="${e(m?.id||'')}"><div class="form-grid">${field('Full name','name',m?.name||'','text','required')}${field('Email','email',m?.email||'','email','required')}${select('Status','active',[{value:'true',label:'Active'},{value:'false',label:'Inactive'}],m?.active??true)}</div><p class="subtitle">Deactivating an editor leaves their project assignments visible for reassignment.</p><div class="panel-actions">${button('Cancel','close-modal')}<button class="btn primary" type="submit">Save editor</button></div></form>`);}
  document.addEventListener('click',event=>{if(event.target.closest('.cr-editor [data-work]')&&!flush()){event.preventDefault();event.stopImmediatePropagation();return;}const el=event.target.closest('[data-am],[data-am-project],[data-am-cue],[data-am-episode],[data-am-episode-download],[data-am-remove-party],[data-am-export],[data-am-range],[data-am-issue-cue],[data-am-edit-member]');if(!el)return;event.preventDefault();event.stopImmediatePropagation();const d=el.dataset;
    if(d.amProject)return openProject(d.amProject);
    if(d.amCue){requestCueSwitch(d.amCue);return;}
    if(d.amEpisode){if(!flush())return;cueQuery=cueReviewFilter='';episodeNumber=d.amEpisode==='movie'?null:Number(d.amEpisode);cueId=cuesOf()[0]?.id||null;loadDraft();rangeIssues=null;api.render();return;}
    if(d.amEpisodeDownload!==undefined){openEpisodeDownload(d.amEpisodeDownload==='movie'?null:Number(d.amEpisodeDownload));return;}
    if(d.amRemoveParty!==undefined){collect();draft.work.parties.splice(Number(d.amRemoveParty),1);dirty=true;$('#am-right').innerHTML=trackPanel();mount('builder');return;}
    if(d.amExport){from=episodeNumber;to=episodeNumber;reviewRange(d.amExport);return;}
    if(d.amRange){reviewRange(d.amRange);return;}
    if(d.amIssueCue){const c=data().cues.find(c=>c.id===d.amIssueCue);if(!flush())return;episodeNumber=c.episode;cueId=c.id;loadDraft();api.render();$('#am-right').scrollIntoView({behavior:'smooth',block:'start'});return;}
    if(d.amEditMember)return memberModal(d.amEditMember);
    const actions={home:()=>{if(flush())api.go('dashboard');},'focus-edit':()=>$('#am-track-form .input')?.focus(),'new-project':()=>api.newProject(),members:()=>api.go('members'),works:()=>api.go('works'),imports:()=>api.go('import'),'clear-filters':()=>{search=statusFilter=typeFilter=houseFilter=channelFilter=yearFilter='';editorFilter='';pageNumber=1;api.render();},'previous-page':()=>{pageNumber=Math.max(1,pageNumber-1);api.render();},'next-page':()=>{pageNumber++;api.render();},'episode-page-prev':()=>{if(flush()){episodePage=Math.max(1,episodePage-1);api.render();}},'episode-page-next':()=>{if(flush()){episodePage++;api.render();}},'clear-episode-search':()=>{if(!flush())return;episodeQuery='';episodePage=1;api.render();},'clear-cue-filters':()=>{if(!flush())return;cueQuery=cueReviewFilter='';api.render();},production,'add-episode':addEpisode,'bulk-delete-episodes':episodeBulkDeleteModal,'confirm-delete-episodes':deleteSelectedEpisodes,'title-save-new':()=>saveTrack(titleSaveAnnounce,'new'),'title-save-update':()=>saveTrack(titleSaveAnnounce,'update'),'title-save-cancel':cancelTitleChange,'cue-switch-save':()=>saveTrack(false),'cue-switch-discard':()=>{dirty=episodeDirty=false;finishCueSwitch(false);},'cue-switch-cancel':()=>{pendingCueSwitch=null;api.close();},'link-work':linkWork,'choose-song':()=>selectSong(d.workId),'clear-song':()=>{const form=$('#am-link-work');form.elements.songSearch.value='';refreshSongFinder();form.elements.songSearch.focus();},'add-new-contributor':addNewContributor,'remove-new-contributor':()=>el.closest('[data-new-party]')?.remove(),preview,'save-track':()=>saveTrack(true),'add-occurrence':addOccurrence,'remove-occurrence':()=>removeOccurrence(Number(d.index)),'duplicate-cue':duplicateCue,'delete-cue':deleteCue,'confirm-delete-cue':()=>confirmDeleteCue(d.cueId),'undo-delete-cue':undoDeleteCue,'add-contributor':()=>{collect();draft.work.parties.push({name:'',role:'Composer',society:'',share:null,ipi:''});dirty=true;$('#am-right').innerHTML=trackPanel();mount('builder');},'close-modal':api.close,'add-period':()=>{const host=$('#am-periods'),i=host.children.length;host.insertAdjacentHTML('beforeend',periodRow({from:'',to:'',director:'',producer:'',company:'',cast:''},i));},'export-scroll':()=>{if(flush())api.openExport(current(),episodeNumber,{allowEpisodeSelection:true});},'close-export':()=>document.body.classList.remove('export-open'),'download-range':downloadRange,print:()=>window.print(),'add-member':()=>memberModal(),import:()=>{if(flush())api.startImport(projectId,episodeNumber);},'iprs-import':()=>{if(flush())openIprsImport();},'apply-iprs':applyIprs};actions[d.am]?.();
  },true);
  function reviewRange(s){if(!flush())return;reviewSociety=s;rangeIssues=validateRange(s);api.render();document.body.classList.add('export-open');$('#am-export-panel').scrollIntoView({behavior:'smooth',block:'start'});}
  document.addEventListener('input',event=>{
    if(event.target.closest('#am-link-work')){
      const form=$('#am-link-work');$('#am-add-cue-error').hidden=true;
      if(event.target.name==='songSearch'){
        refreshSongFinder();
      }
      if(['isrc','iswc','tuneCode','idIPRS','idPRS','idASCAP'].includes(event.target.name))matchNewSongIdentifiers(form);
      if(['start','end'].includes(event.target.name)){
        const start=D.seconds(form.elements.start.value),end=D.seconds(form.elements.end.value),durationOnly=!form.elements.start.value.trim()&&!form.elements.end.value.trim();
        if(Number.isFinite(start)&&Number.isFinite(end)&&end>start)form.elements.duration.value=D.time(end-start);
        form.elements.duration.readOnly=!durationOnly;
      }
    }
    if(event.target.closest('#am-episode-form')){episodeDirty=true;if($('#am-save-state'))$('#am-save-state').textContent='Unsaved changes';}
    if(event.target.closest('#am-track-form')){
      dirty=true;
      if(event.target.closest('[data-am-occurrence]'))refreshOccurrenceTotals();
      if(['start','end'].includes(event.target.name)){
        const form=$('#am-track-form'),start=D.seconds(form.elements.start.value),end=D.seconds(form.elements.end.value),durationOnly=!form.elements.start.value.trim()&&!form.elements.end.value.trim();
        if(Number.isFinite(start)&&Number.isFinite(end)&&end>start)form.elements.duration.value=D.time(end-start);
        form.elements.duration.readOnly=!durationOnly;
        $('#am-timing-method').textContent=durationOnly?'Duration only':'IN / OUT timecodes';
        $('#am-timing-review').hidden=!durationOnly;
      }
      collect();if(event.target.name==='title')updateAutomaticUsage(event.target.value);
      const sum=draft.work.parties.reduce((s,p)=>s+(Number(p.share)||0),0),badge=$('#am-share-total');
      badge.textContent='Ownership total: '+Math.round(sum*100)/100+'%'+(Math.abs(sum-100)<=.01?' \u2713':'');badge.classList.toggle('invalid',Math.abs(sum-100)>.01);
      const indicator=$('#am-save-state');if(indicator)indicator.textContent='Unsaved changes';
    }
    if(['am-episode-search','am-cue-search'].includes(event.target.id)){
      if(!flush())return;
      const id=event.target.id,cursor=event.target.selectionStart;
      if(id==='am-episode-search'){episodeQuery=event.target.value;episodePage=1;}else cueQuery=event.target.value;
      api.render();const input=$('#'+id);input.focus();input.setSelectionRange(cursor,cursor);
    }
  });
  document.addEventListener('change',event=>{
    if(event.target.dataset.amEpisodeCheck!==undefined){const number=Number(event.target.dataset.amEpisodeCheck);event.target.checked?selectedEpisodeNumbers.add(number):selectedEpisodeNumbers.delete(number);api.render();return;}
    if(event.target.id==='am-episode-check-all'){const checked=event.target.checked;document.querySelectorAll('[data-am-episode-check]').forEach(input=>{const number=Number(input.dataset.amEpisodeCheck);checked?selectedEpisodeNumbers.add(number):selectedEpisodeNumbers.delete(number);});api.render();return;}
    if(event.target.closest('#am-link-work')){
      const form=$('#am-link-work');$('#am-add-cue-error').hidden=true;
      if(event.target.name==='episode'){const group=$('#am-new-episode-fields'),creating=event.target.value==='new';group.hidden=!creating;group.disabled=!creating;}
    }
    if(event.target.id==='am-cue-review'){if(!flush()){event.target.checked=!!cueReviewFilter;return;}cueReviewFilter=event.target.checked?'review':'';api.render();}
    if(event.target.name==='rangeFrom'){from=Number(event.target.value);if(Number(to)<from)to=from;rangeIssues=null;api.render();document.body.classList.add('export-open');}
    if(event.target.name==='rangeTo'){to=Number(event.target.value);if(Number(from)>to)from=to;rangeIssues=null;api.render();document.body.classList.add('export-open');}
  });
  document.addEventListener('submit',event=>{const form=event.target;if(!form.classList.contains('am-form'))return;event.preventDefault();event.stopImmediatePropagation();const f=Object.fromEntries(new FormData(form));
    if(form.id==='am-track-form'){saveTrack(true);return;}
    if(form.id==='am-filters'){search=f.search;statusFilter=f.status;typeFilter=f.type;editorFilter=f.editor;houseFilter=f.house;channelFilter=f.channel;yearFilter=f.year;pageNumber=1;api.render();return;}
    if(form.id==='am-member-form'){const name=f.name.trim(),email=f.email.trim().toLowerCase();if(!name||!email)return toast('Name and email are required.');if(members().some(m=>m.id!==form.dataset.id&&m.email.toLowerCase()===email))return toast('That email belongs to another team member.');if(commit('Saved editor · '+name,s=>{const member={id:form.dataset.id||uid('MEM'),name,email,role:'Editor',active:f.active==='true'},i=s.members.findIndex(m=>m.id===member.id);if(i<0)s.members.push(member);else s.members[i]=member;})){api.close();api.render();toast('Editor saved.');}return;}
    if(form.id==='am-production-form'){if(!f.title.trim())return toast('Production title is required.');if(current().type==='Movie'&&f.duration&&(!Number.isFinite(D.seconds(f.duration))||D.seconds(f.duration)<=0))return toast('Movie duration must be a valid positive HH:MM:SS time.');const periods=[...form.querySelectorAll('[data-am-period]')].map((row,i)=>({from:Number(f['periodFrom'+i]),to:Number(f['periodTo'+i]),director:f['director'+i],producer:f['producer'+i],company:f['company'+i],cast:f['cast'+i]})),errors=D.validatePeriods(periods);if(errors.length)return toast(errors.join('. '));if(commit('Updated production details · '+f.title,s=>{const p=current();p.productionHistory??=[];p.productionHistory.unshift({date:now(),periods:structuredClone(p.periods)});for(const key of ['title','altTitle','clientId','language','productionNo','filmItemNo','genre','country','channel','bgComposer','submittedBy','assignedEditorId','status'])if(Object.hasOwn(f,key))p[key]=f[key];p.year=Number(f.year);if(p.type==='Movie'){p.airdate=f.airdate;p.duration=f.duration;}else{p.serialType=f.serialType;p.season=Number(f.season);p.totalEpisodes=Number(f.totalEpisodes);}p.periods=periods;p.ascap=Object.fromEntries(['companyName','contact','address','phone','network'].map(key=>[key,f['ascap_'+key]]));p.updatedAt=now();})){api.close();api.render();toast('Production saved. Previous period values are retained in history.');}return;}
    if(form.id==='am-add-episode'||form.id==='am-episode-form'){if(dirty&&!saveTrack(false))return;if(persistEpisode(f,form.id==='am-add-episode')){cueId=cuesOf()[0]?.id||null;loadDraft();api.close();api.render();toast('Content details saved.');}return;}
    if(form.id==='am-link-work'){saveNewCue(form,f);return;}
  },true);
  document.addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&event.target.matches('[data-am-cue]')){event.preventDefault();event.target.click();}});
  document.addEventListener('click',event=>{if(event.target.closest('[data-action="close-modal"]')&&pendingCueSwitch)pendingCueSwitch=null;},true);

  window.addEventListener('beforeunload',event=>{if(dirty||episodeDirty){event.preventDefault();event.returnValue='';}});
  function openIprsImport(){iprsReview=null;modal('Import IPRS workbook',`<div class="ir-intro"><div><span class="eyebrow">IPRS METADATA</span><h3>Choose one IPRS Excel file</h3><p>Preview the detected songs, match them to your database, then apply only missing metadata.</p></div><div class="ir-steps" aria-label="Import steps"><span class="active"><b>1</b>Choose</span><span><b>2</b>Match</span><span><b>3</b>Apply</span></div></div><label class="ir-drop" for="am-iprs-file"><span class="ir-upload-icon">${icon('upload')}</span><strong>Drop or choose an IPRS workbook</strong><small>XLSX or XLS · maximum 10 MB</small><span class="btn primary">${icon('plus')}Choose IPRS file</span><input type="file" id="am-iprs-file" accept=".xlsx,.xls" aria-label="Choose IPRS workbook"></label><div class="ir-safety">${icon('shield')}Nothing is changed until you review the song matches and press Apply.</div><div id="am-iprs-review" aria-live="polite"></div>`);}
  document.addEventListener('change',async event=>{if(event.target.id!=='am-iprs-file')return;const file=event.target.files[0];if(!file)return;if(file.size>10*1024*1024)return toast('Use an IPRS workbook smaller than 10 MB.');const review=$('#am-iprs-review');review.innerHTML=`<div class="ir-reading">${icon('clock')}Reading ${e(file.name)}…</div>`;try{const wb=await CueFileSafety.read(file,{extensions:['xlsx','xls'],cellNF:true});if(!review.isConnected)return;iprsReview={...CueIprs.parse(wb),filename:file.name};const uniqueTitles=new Set(iprsReview.records.map(record=>D.normalize(record.title))).size;review.innerHTML=`<section class="ir-summary"><div><span class="eyebrow">FILE PREVIEW</span><h3>${e(file.name)}</h3><p>Check where each detected IPRS row will save.</p></div><dl><div><dt>Cue rows</dt><dd>${iprsReview.records.length}</dd></div><div><dt>Songs</dt><dd>${uniqueTitles}</dd></div><div><dt>Warnings</dt><dd>${iprsReview.warnings.length}</dd></div></dl></section><section class="ir-match"><div class="ir-match-head"><div><h3>Match songs to your database</h3><p>Suggested matches are labelled. Unselected rows are skipped.</p></div><span class="am-status ready"><i></i>${iprsReview.records.length} rows</span></div><div class="ir-match-list">${iprsReview.records.map((r,i)=>{const candidates=D.candidates({title:r.title,isrc:r.isrc,societyId:r.code},data().works);return `<article class="ir-row"><span class="ir-row-no">${i+1}</span><div class="ir-song"><strong>${e(r.title)}</strong><span>${e(r.sheet)} · Excel row ${r.row}${r.episode?' · Episode '+e(r.episode):''}</span><div class="ir-tags"><span>IPRS ${e(r.code||'—')}</span><span>${e(r.artist||'Singer not listed')}</span><span>${r.parties.length} contributor${r.parties.length===1?'':'s'}</span><span>${D.time(r.duration)}</span></div></div><label>Save missing metadata to<select class="input" data-am-iprs-match="${i}" aria-label="Target song for IPRS row ${i+1}">${options([{value:'',label:'Skip this row'},...data().works.map(w=>({value:w.id,label:w.title+' · '+w.id+(candidates.items.some(c=>c.id===w.id)?' · Suggested':'')}))],'')}</select></label></article>`;}).join('')}</div>${iprsReview.warnings.length?`<details class="ir-warnings"><summary>${iprsReview.warnings.length} file warning${iprsReview.warnings.length===1?'':'s'}</summary>${iprsReview.warnings.map(message=>`<p>${e(message)}</p>`).join('')}</details>`:''}<div class="ir-actions"><span>Existing values and contributor lists stay unchanged.</span>${button('Apply selected metadata','apply-iprs','check','primary')}</div></section>`;}catch(err){if(!review.isConnected)return;iprsReview=null;review.innerHTML=`<div class="ir-error" role="alert">${icon('alert')}<div><strong>IPRS file could not be read</strong><span>${e(err.message||'Use a valid IPRS workbook and try again.')}</span></div></div>`;toast(err.message||'Unable to read the IPRS workbook.');}});
  function applyIprs(){if(!iprsReview)return;const selected=[...document.querySelectorAll('[data-am-iprs-match]')].filter(el=>el.value).map(el=>({record:iprsReview.records[Number(el.dataset.amIprsMatch)],id:el.value}));if(!selected.length)return toast('Select at least one target Work.');const comparable=record=>JSON.stringify([D.normalize(record.isrc),D.normalize(record.code),(record.parties||[]).map(p=>[D.normalize(p.name),D.normalize(p.role),D.normalize(p.ipi),D.normalize(p.society),p.share])]);const unique=new Map();for(const item of selected){const prev=unique.get(item.id);if(prev&&comparable(prev.record)!==comparable(item.record))return toast('Conflicting metadata targets the same Work. Review those rows separately.');unique.set(item.id,item);}const ok=commit('Imported IPRS metadata · '+unique.size+' selected Works',s=>{for(const {record:r,id}of unique.values()){const w=s.works.find(w=>w.id===id);if(r.isrc&&w.isrc&&D.normalize(r.isrc)!==D.normalize(w.isrc))throw Error(w.title+': ISRC conflicts with the selected record.');if(r.code&&w.societies.IPRS&&D.normalize(r.code)!==D.normalize(w.societies.IPRS))throw Error(w.title+': IPRS identifier conflicts with the selected record.');if(s.works.some(other=>other.id!==id&&((r.isrc&&D.normalize(other.isrc)===D.normalize(r.isrc))||(r.code&&D.normalize(other.societies.IPRS)===D.normalize(r.code)))))throw Error('Imported identifier belongs to another Work. Select the correct master record.');if(r.parties.some(p=>p.share!==null&&(!Number.isFinite(p.share)||p.share<0||p.share>100)))throw Error(r.title+': invalid share values require correction first.');if(!w.isrc)w.isrc=r.isrc;if(!w.societies.IPRS)w.societies.IPRS=r.code;if(!w.artist)w.artist=r.artist;if(!w.parties.length)w.parties=structuredClone(r.parties);w.status='Complete';w.activity??=[];w.activity.unshift({text:'Filled missing metadata from '+iprsReview.filename+'; existing values retained',date:now()});}s.imports.unshift({id:uid('IMP'),filename:iprsReview.filename,sheet:'IPRS metadata',projectId,clientId:current().clientId,count:0,newWorks:0,matched:unique.size,warnings:iprsReview.warnings.length,profile:'IPRS metadata review',user:'Local administrator',date:now()});});if(ok){loadDraft();api.close();api.render();toast('Missing metadata filled for selected Works. Existing values were retained.');}}
  function openCue(id){if(!flush())return;const c=data().cues.find(c=>c.id===id);if(!c)return;episodeQuery=cueQuery=cueReviewFilter='';projectId=c.projectId;episodeNumber=c.episode;cueId=id;loadDraft();api.close();api.go('builder');}
  return {initialize,mount,dashboard,builder,members:memberView,openProject,openCue,addCue:linkWork,hasDraft:()=>dirty||episodeDirty,flush,commit,current,openIprsImport};
};

/* portfolio.js */
window.createPortfolioUX = function(ctx) {
  'use strict';
  const {esc:e,icon,badge,options,date}=ctx;
  let filters={q:'',client:'',status:'',type:'',sort:'updated'};
  const data=()=>ctx.state();
  const ready=w=>w&&Boolean(w.isrc||w.iswc||w.tuneCode||Object.values(w.societies||{}).some(Boolean))&&Boolean((w.parties||[]).length);
  const client=p=>data().clients.find(c=>c.id===p.clientId)?.name||'No client assigned';
  const team=p=>[...new Set([p.assignedEditorId,...(p.teamIds||[])].filter(Boolean))].map(id=>(data().members||[]).find(m=>m.id===id)).filter(Boolean);
  let statsState=null,statsRevision=-1,projectStats=new Map();
  function stats(p){const workspace=data(),revision=ctx.revision?.();if(statsState!==workspace||statsRevision!==revision){statsState=workspace;statsRevision=revision;projectStats=new Map();const readyWorks=new Set(workspace.works.filter(ready).map(work=>work.id));for(const cue of workspace.cues){let record=projectStats.get(cue.projectId);if(!record){record={cues:[],verified:0,progress:0};projectStats.set(cue.projectId,record);}record.cues.push(cue);if(readyWorks.has(cue.workId))record.verified++;}for(const record of projectStats.values())record.progress=Math.round(100*record.verified/record.cues.length);}return projectStats.get(p.id)||{cues:[],verified:0,progress:0};}
  const label=(name,value)=>`<div><dt>${name}</dt><dd>${e(value)}</dd></div>`;
  const heading=(title,tag,actions='')=>`<header class="ux-title"><div><div class="ux-eyebrow">${tag}</div><h1>${title}</h1></div><div class="ux-actions">${actions}</div></header>`;
  const action=(label,name,ico='plus',primary=false)=>`<button class="btn ${primary?'primary':''}" data-action="${name}">${icon(ico)}${label}</button>`;
  const nav=(name,page,ico='arrow')=>`<button class="btn" data-nav="${page}">${icon(ico)}${name}</button>`;
  const stat=(title,n,sub,ico)=>`<article class="ux-stat"><span class="ux-stat-icon">${icon(ico)}</span><span>${title}</span><strong>${n}</strong><small>${sub}</small></article>`;
  const progress=(value,label)=>`<div class="px-progress-label"><span>${label}</span><strong>${value}%</strong></div><div class="ux-progress" role="progressbar" aria-label="${label}" aria-valuenow="${value}" aria-valuemin="0" aria-valuemax="100"><span style="width:${value}%"></span></div>`;
  function recent(p){const rows=data().activity.filter(a=>a.projectId===p.id||a.text?.includes(p.title));return rows[0]||null;}
  function timeline(rows){return rows.length?`<ol class="px-timeline">${rows.map(a=>`<li><span class="px-timeline-dot"></span><div><p>${e(a.text)}</p><time>${e(date(a.date))}</time></div></li>`).join('')}</ol>`:'<div class="ux-empty">No activity recorded yet.</div>';}
  function projectCard(p){const s=stats(p),members=team(p),a=recent(p);return `<article class="ux-card px-project"><div class="px-project-top"><span class="px-project-symbol">${icon(p.type==='Movie'?'film':'folder')}</span>${badge(p.status||'Draft',p.status==='Complete'?'green':p.status==='Ready for Review'?'blue':'gray')}<button class="icon-button" data-px="edit" data-id="${e(p.id)}" aria-label="Edit ${e(p.title)} details">${icon('settings')}</button></div><button class="px-project-title" data-project="${e(p.id)}">${e(p.title)}</button><p class="ux-muted">${e(client(p))}</p><div class="px-project-tags">${badge(p.type,'gray')}${badge([p.language,p.year].filter(Boolean).join(' · '),'gray')}</div><dl class="px-facts">${label('Deadline',p.deadline?date(p.deadline+'T12:00:00'):'Not set')}${label('Content',p.type==='Series'?p.episodes.length+' episodes':'Feature film')}${label('Music cues',s.cues.length)}${label('Production',p.periods?.[0]?.company||'Not set')}</dl><div class="px-progress">${progress(s.progress,'Cues with complete metadata')}<small>${s.verified} of ${s.cues.length} cues</small></div><div class="px-team"><div class="px-avatars">${members.length?members.map(m=>`<span title="${e(m.name)}">${e(m.name.split(/\s+/).slice(0,2).map(n=>n[0]).join(''))}</span>`).join(''):icon('users')}</div><span>${e(members.map(m=>m.name).join(', ')||'No team assigned')}</span></div><div class="px-card-activity">${icon('clock')}<span>${a?e(a.text):'No project activity recorded'}${a?`<small>${e(date(a.date))}</small>`:''}</span></div><footer class="px-card-actions"><button class="btn primary" data-project="${e(p.id)}">Continue editing ${icon('arrow')}</button><button class="btn" data-px="import" data-id="${e(p.id)}">${icon('upload')}Import</button><button class="btn" data-px="export" data-id="${e(p.id)}">${icon('download')}Export</button><button class="btn danger" data-px="delete" data-id="${e(p.id)}">${icon('trash')}Delete</button></footer></article>`;}
  function overview(){const s=data(),complete=s.works.filter(ready).length,incomplete=s.works.filter(w=>!ready(w)),n=s.works.length?Math.round(100*complete/s.works.length):0,projects=[...s.projects].sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||''))),due=s.projects.filter(p=>p.deadline).sort((a,b)=>a.deadline.localeCompare(b.deadline));
    return `<div class="ux-page">${heading('Overview','WORKSPACE / AT A GLANCE',nav('View projects','projects','folder')+action('Import workfile','upload','upload',true))}<div class="ux-stats">${stat('Projects',s.projects.length,`${s.projects.filter(p=>p.type==='Series').length} series · ${s.projects.filter(p=>p.type==='Movie').length} movies`,'folder')}${stat('Music cues',s.cues.length,`${CueDomain.time(s.cues.reduce((sum,c)=>sum+(c.duration||0),0))} total music`,'music')}${stat('Catalog-ready songs',complete,`${s.works.length} songs · ${incomplete.length} need metadata`,'shield')}${stat('Exports',s.exports.length,`${s.imports.length} imported workfiles`,'download')}</div><div class="px-overview-grid"><div class="px-main-stack"><section class="ux-card px-readiness"><div><div class="ux-eyebrow">DATABASE COMPLETENESS</div><h2>Keep every production ready.</h2><p>${incomplete.length?`${incomplete.length} songs need identifiers or rights holders before delivery.`:s.works.length?'Every song contains an identifier and rights-holder data.':'Add your first song or import a song database to begin.'}</p><div class="ux-actions">${nav('Open song database','works','music')}${nav('Validate exports','exports','check')}</div></div><div class="px-ring" style="--progress:${n}%" role="img" aria-label="${n}% of songs are catalog ready"><div><strong>${n}%</strong><span>Catalog ready</span></div></div></section><section class="ux-card"><div class="ux-section-head"><h2>Project progress</h2>${nav('All projects','projects')}</div><div class="px-production-list">${projects.slice(0,5).map(p=>{const st=stats(p);return `<div class="px-production-row"><div><button class="link-button" data-project="${e(p.id)}">${e(p.title)}</button><p class="ux-muted">${e(client(p))} · ${st.cues.length} cues</p></div><div>${progress(st.progress,'Complete metadata')}</div>${badge(p.status||'Draft','gray')}<button class="icon-button" data-project="${e(p.id)}" aria-label="Open ${e(p.title)}">${icon('arrow')}</button></div>`;}).join('')||'<div class="ux-empty">Create a project to get started.</div>'}</div></section><section class="ux-card"><div class="ux-section-head"><h2>Needs metadata</h2>${badge(incomplete.length+' songs','amber')}</div><div class="px-attention-grid">${incomplete.slice(0,4).map(w=>`<button class="px-attention" data-work="${e(w.id)}" data-tab="Overview"><span>${icon('music')}</span><div><strong>${e(w.title)}</strong><small>${e(w.type||'Song')} · Add identifiers or rights holders</small></div>${icon('arrow')}</button>`).join('')||(s.works.length?'<div class="ux-empty">Every song has delivery metadata.</div>':'<div class="ux-empty">Your song library is empty. Add a song or upload your database to get started.</div>')}</div></section></div><aside class="px-side-stack"><section class="ux-card"><div class="ux-section-head"><h2>Quick actions</h2></div><div class="px-quick">${action('New project','new-project','plus')}${action('Add a song','new-work','music')}${nav('Manage team','members','users')}${nav('Browse repositories','repositories','folder')}</div></section><section class="ux-card"><div class="ux-section-head"><h2>Project deadlines</h2>${icon('clock')}</div>${due.length?due.slice(0,4).map(p=>`<button class="px-deadline" data-project="${e(p.id)}"><span><strong>${e(p.title)}</strong><small>${e(client(p))}</small></span><time>${e(date(p.deadline+'T12:00:00'))}</time></button>`).join(''):'<div class="ux-empty">No deadlines set.<br>Set a deadline in project details.</div>'}</section><section class="ux-card"><div class="ux-section-head"><h2>Recent activity</h2></div>${timeline(s.activity.slice(0,6))}</section></aside></div></div>`;
  }
  function projects(){const s=data(),rows=s.projects.filter(p=>(!filters.q||[p.title,client(p),p.periods?.[0]?.company,...team(p).map(m=>m.name)].join(' ').toLowerCase().includes(filters.q.toLowerCase()))&&(!filters.client||p.clientId===filters.client)&&(!filters.type||p.type===filters.type)&&(!filters.status||(p.status||'Draft')===filters.status));rows.sort((a,b)=>filters.sort==='title'?a.title.localeCompare(b.title):filters.sort==='deadline'?(a.deadline||'9999').localeCompare(b.deadline||'9999'):String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));const f=(name,label,items)=>`<label>${label}<select class="input" name="${name}" data-px-filter="${name}">${options(items,filters[name])}</select></label>`;
    return `<div class="ux-page">${heading('Projects','PRODUCTION DESK',nav('Manage team','members','users')+action('New project','new-project','plus',true))}<p class="ux-muted">Your imported workfiles and saved edits are here. Choose Continue editing to resume a project. Save your edits before closing; exporting keeps the project here.</p><div class="ux-stats">${stat('All projects',s.projects.length,`${s.clients.length} clients`,'folder')}${stat('In progress',s.projects.filter(p=>p.status==='In Progress').length,'Active production status','clock')}${stat('Ready for review',s.projects.filter(p=>p.status==='Ready for Review').length,'Awaiting final review','check')}${stat('Music cues',s.cues.length,'Across all productions','music')}</div><form class="ux-toolbar px-filters" data-px-form="filters"><label class="ux-search">Search projects<input class="input" name="q" type="search" placeholder="Project, client, studio or team" value="${e(filters.q)}"></label>${f('client','Client',[{value:'',label:'All clients'},...s.clients.map(c=>({value:c.id,label:c.name}))])}${f('status','Status',[{value:'',label:'All statuses'},...[...new Set(['Draft','In Progress','Ready for Review','Complete',...s.projects.map(p=>p.status).filter(Boolean)])]])}${f('type','Type',[{value:'',label:'All types'},'Series','Movie'])}${f('sort','Sort by',[{value:'updated',label:'Last updated'},{value:'title',label:'Project name'},{value:'deadline',label:'Deadline'}])}<button class="btn primary" type="submit">Apply</button><button class="btn" type="button" data-px="clear">Reset</button></form><div class="ux-section-head px-results"><h2>${rows.length} ${rows.length===1?'project':'projects'}</h2><span class="ux-muted">${rows.reduce((n,p)=>n+stats(p).cues.length,0)} cues in this view</span></div><div class="px-project-grid">${rows.map(projectCard).join('')}</div>${!rows.length?`<div class="ux-card ux-empty"><h2>No projects match</h2><p>Try another search or reset the filters.</p><button class="btn" data-px="clear">Reset filters</button></div>`:''}</div>`;
  }
  function deleteProjectModal(p){
    const count=stats(p).cues.length;
    ctx.modal(ctx.modalHead('Delete project?')+`<div class="modal-body"><form data-px-form="delete" data-id="${e(p.id)}"><p>Delete <strong>${e(p.title)}</strong>, its ${p.episodes?.length||0} episodes and ${count} music cues?</p><p>Song and artist records, import history and exported snapshots will be kept. This cannot be undone.</p><div class="panel-actions"><button class="btn" type="button" data-action="close-modal">Cancel</button><button class="btn danger" type="submit">Delete project</button></div></form></div>`);
  }
  function deleteProject(id){
    const p=data().projects.find(item=>item.id===id);if(!p)return;
    if(ctx.commit('Deleted project · '+p.title,()=>{
      const s=data();s.projects=s.projects.filter(item=>item.id!==id);
      s.cues=s.cues.filter(cue=>cue.projectId!==id);
      s.deletedCues=(s.deletedCues||[]).filter(item=>item.cue?.projectId!==id);
      for(const repository of s.repositories||[])if(repository.projectIds)repository.projectIds=repository.projectIds.filter(projectId=>projectId!==id);
    })){
      if(ctx.exportState().project===id)ctx.setExportState({project:'',episode:null});
      ctx.close(true);ctx.render();ctx.toast('Project deleted. Song records and import/export history kept.');
    }
  }
  function edit(p){ctx.modal(ctx.modalHead('Project details')+`<div class="modal-body"><form data-px-form="details" data-id="${e(p.id)}"><div class="form-grid"><div class="field full"><label for="px-project-title">Project title</label><input class="input" id="px-project-title" name="title" required value="${e(p.title)}"></div><div class="field"><label for="px-project-client">Client</label><select class="input" id="px-project-client" name="clientId">${options([{value:'',label:'No client'},...data().clients.map(c=>({value:c.id,label:c.name}))],p.clientId)}</select></div><div class="field"><label for="px-project-status">Status</label><select class="input" id="px-project-status" name="status">${options([...new Set(['Draft','In Progress','Ready for Review','Complete',p.status].filter(Boolean))],p.status||'Draft')}</select></div><div class="field"><label for="px-project-deadline">Deadline</label><input class="input" id="px-project-deadline" name="deadline" type="date" value="${e(p.deadline||'')}"></div><div class="field"><label for="px-project-editor">Lead editor</label><select class="input" id="px-project-editor" name="assignedEditorId">${options([{value:'',label:'Unassigned'},...(data().members||[]).map(m=>({value:m.id,label:m.name}))],p.assignedEditorId)}</select></div><fieldset class="field full px-team-fields"><legend>Project team</legend>${(data().members||[]).map(m=>`<label><input type="checkbox" name="teamIds" value="${e(m.id)}" ${(p.teamIds||[]).includes(m.id)?'checked':''}>${e(m.name)} <span class="ux-muted">${e(m.role)}</span></label>`).join('')||'<p>No team members recorded.</p>'}</fieldset></div><div class="panel-actions"><button class="btn" type="button" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">Save details</button></div></form></div>`);}
  function click(ev){const el=ev.target.closest('[data-px]');if(!el)return false;const p=data().projects.find(p=>p.id===el.dataset.id);if(el.dataset.px==='edit'&&p)edit(p);if(el.dataset.px==='delete'&&p)deleteProjectModal(p);if(el.dataset.px==='clear'){filters={q:'',client:'',status:'',type:'',sort:'updated'};ctx.render();}if(el.dataset.px==='import'&&p)ctx.startImport(p.id);if(el.dataset.px==='export'&&p)ctx.openExport(p,undefined,{allowEpisodeSelection:true});return true;}
  function submit(ev){const form=ev.target;if(!form.dataset.pxForm)return false;ev.preventDefault();const f=new FormData(form);if(form.dataset.pxForm==='delete'){deleteProject(form.dataset.id);return true;}if(form.dataset.pxForm==='filters'){filters=Object.fromEntries(f);ctx.render();}if(form.dataset.pxForm==='details'){const p=data().projects.find(p=>p.id===form.dataset.id),title=String(f.get('title')).trim();if(!title){ctx.toast('Enter a project title.');return true;}if(ctx.commit('Updated project details · '+title,()=>Object.assign(p,{title,clientId:f.get('clientId'),status:f.get('status'),deadline:f.get('deadline'),assignedEditorId:f.get('assignedEditorId'),teamIds:f.getAll('teamIds'),updatedAt:new Date().toISOString()}))){ctx.close(true);ctx.render();ctx.toast('Project details saved.');}}return true;}
  function change(ev){if(!ev.target.dataset.pxFilter)return false;const form=ev.target.closest('form');filters=Object.fromEntries(new FormData(form));ctx.render();return true;}
  return {overview,projects,click,change,submit,setClient:id=>{filters.client=id;}};
};

/* management.js */
/* Client and repository views. All records stay in the existing workspace. */
window.createManagementUX = function (ctx) {
  'use strict';
  const {esc:e,icon,options,badge,toast}=ctx;
  const data=()=>ctx.state(), now=()=>new Date().toISOString(), uid=p=>p+'-'+crypto.randomUUID().slice(0,8);
  const unique=items=>[...new Set(items.filter(Boolean))];
  const day=value=>value&&Number.isFinite(Date.parse(value))?ctx.date(value):'Not recorded';
  const safeUrl=value=>{try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)?url.href:'';}catch{return '';}};
  const recent=items=>[...items].sort((a,b)=>(Date.parse(b.date)||0)-(Date.parse(a.date)||0));
  const button=(label,action,id='',style='')=>`<button type="button" class="btn ${style}" data-mx="${action}" data-id="${e(id)}">${label}</button>`;
  const chip=text=>`<span class="ux-chip">${e(text)}</span>`;
  const stat=(label,value,ico)=>`<div class="ux-stat mx-stat"><div><span>${e(label)}</span><strong>${e(value)}</strong></div><span class="ux-stat-icon mx-stat-icon">${icon(ico)}</span></div>`;
  const title=(text,actions)=>`<header class="mx-page-head"><h1 class="ux-title">${text}</h1><div class="button-row">${actions||''}</div></header>`;
  const empty=(text,action='')=>`<div class="ux-empty mx-empty">${icon('folder')}<strong>${e(text)}</strong>${action}</div>`;
  const field=(label,name,value='',type='text',attrs='')=>`<div class="field"><label for="mx-${name}">${label}</label><input class="input" id="mx-${name}" name="${name}" type="${type}" value="${e(value)}" ${attrs}></div>`;
  const select=(label,name,items,value,action='')=>`<div class="field"><label for="mx-${name}">${label}</label><select class="input" id="mx-${name}" name="${name}" ${action?`data-mx="${action}"`:''}>${options(items,value)}</select></div>`;
  const area=(label,name,value='')=>`<div class="field full"><label for="mx-${name}">${label}</label><textarea class="input" id="mx-${name}" name="${name}" rows="3">${e(value)}</textarea></div>`;
  const formActions=label=>`<div class="panel-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">${label}</button></div>`;
  const projectsFor=id=>data().projects.filter(p=>p.clientId===id);
  const projectLinks=ids=>data().projects.filter(p=>ids.includes(p.id)).map(p=>`<button class="mx-project-link" type="button" data-project="${e(p.id)}">${icon('folder')}<span>${e(p.title)}</span>${icon('arrow')}</button>`).join('');
  const timeline=items=>items.length?`<div class="mx-timeline">${recent(items).slice(0,8).map(a=>`<div><i></i><p>${e(a.text)}<small>${e(day(a.date))}</small></p></div>`).join('')}</div>`:'<p class="ux-muted mx-note">No activity recorded yet.</p>';
  let clientId='',repoId='system-imports';
  let clientFilters={q:'',status:'All',sort:'name'},repoFilters={q:'',kind:'All',sort:'name'};

  // A failed browser-storage write restores every field, including the activity log.
  function commit(message,change){
    const state=data(),before=structuredClone(state);
    try{
      change(state);
      state.activity??=[];state.activity.unshift({text:message,date:now()});
      if(ctx.save())return true;
    }catch(error){toast(error.message||'The change could not be saved.');}
    Object.keys(state).forEach(key=>delete state[key]);Object.assign(state,before);return false;
  }
  function contactsFor(client){
    if(client.contacts?.length)return client.contacts;
    return client.contact||client.email||client.phone?[{name:client.contact||'',email:client.email||'',phone:client.phone||'',role:'Primary contact'}]:[];
  }
  function filesFor(client){
    const ids=projectsFor(client.id).map(p=>p.id);
    return [
      ...(client.files||[]).map(f=>({...f,kind:'Link',url:safeUrl(f.url),description:f.notes,date:f.createdAt})),
      ...data().imports.filter(f=>f.clientId===client.id||ids.includes(f.projectId)).map(f=>({id:f.id,name:f.filename,kind:'Import record',date:f.date,description:`${f.count??0} imported cues · ${f.sheet||'Sheet not recorded'} · Original file not retained`})),
      ...data().exports.filter(f=>f.clientId===client.id||ids.includes(f.projectId)).map(f=>({id:f.id,name:f.filename||`${f.society||f.format||'Export'} · ${f.projectTitle}`,kind:f.snapshot?'Export snapshot':'Export record',date:f.date,exportId:f.snapshot?f.id:null}))
    ];
  }
  function fileRows(items){return items.length?`<div class="mx-files">${items.map(f=>`<div class="mx-file-row"><span class="mx-file-icon">${icon('file')}</span><div><strong>${e(f.name)}</strong><small>${e(f.kind)}${f.date?' · '+e(day(f.date)):''}</small>${f.description?`<small>${e(f.description)}</small>`:''}</div>${f.exportId?`<button class="btn small" data-regenerate="${e(f.exportId)}" aria-label="Download ${e(f.name)}">${icon('download')} Download</button>`:f.download?`<a class="btn small" href="${e(f.download)}" download>${icon('download')} Download</a>`:f.url?`<a class="btn small" href="${e(safeUrl(f.url))}" target="_blank" rel="noopener noreferrer">Open ${icon('arrow')}</a>`:''}${f.kind==='Import record'&&f.id?`<button type="button" class="btn small danger" data-mx="import-delete" data-id="${e(f.id)}" aria-label="Delete import record for ${e(f.name)}">${icon('trash')} Delete record</button>`:''}</div>`).join('')}</div>`:empty('No files or references yet');}
  function importDeleteModal(id){
    const record=data().imports.find(item=>item.id===id);if(!record)return toast('This import record is no longer available.');
    ctx.modal(ctx.modalHead('Delete import record?')+`<div class="modal-body"><p><strong>${e(record.filename)}</strong><br><span class="subtitle">${e(record.sheet||'Sheet not recorded')} · ${e(day(record.date))}</span></p><p>Only this import history record will be removed. Songs, music cues, projects and linked Google Sheets will stay unchanged. The original workbook was not stored.</p><div class="panel-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button>${button(icon('trash')+' Delete record','confirm-import-delete',id,'danger')}</div></div>`);
  }
  function deleteImportRecord(id){
    const record=data().imports.find(item=>item.id===id);if(!record){ctx.close();ctx.render();return toast('This import record is no longer available.');}
    if(commit('Deleted import history record · '+record.filename,s=>{s.imports=s.imports.filter(item=>item.id!==id);})){ctx.close();ctx.render();toast('Import record deleted. Songs and cues were kept.');}
    else toast('The import record could not be deleted. Your history is unchanged.');
  }

  function clients(){
    const s=data(),q=clientFilters.q.toLowerCase();
    let rows=s.clients.filter(c=>(!q||[c.name,c.contact,c.email,c.phone,c.location,c.notes,...contactsFor(c).map(x=>Object.values(x).join(' ')),...projectsFor(c.id).map(p=>p.title)].join(' ').toLowerCase().includes(q))&&(clientFilters.status==='All'||(c.status||'Not set')===clientFilters.status));
    rows.sort((a,b)=>clientFilters.sort==='projects'?projectsFor(b.id).length-projectsFor(a.id).length||a.name.localeCompare(b.name):clientFilters.sort==='updated'?(Date.parse(b.updatedAt)||0)-(Date.parse(a.updatedAt)||0):a.name.localeCompare(b.name));
    if(!rows.some(c=>c.id===clientId))clientId=rows[0]?.id||'';
    const selected=rows.find(c=>c.id===clientId);
    return `<div class="ux-page mx-page">${title('Clients',button(icon('plus')+' Add client','client-new','','primary'))}
      <div class="ux-stats">${stat('Clients',s.clients.length,'users')}${stat('Linked projects',s.projects.filter(p=>s.clients.some(c=>c.id===p.clientId)).length,'folder')}${stat('Contacts',s.clients.reduce((n,c)=>n+contactsFor(c).length,0),'users')}${stat('Files & records',s.clients.reduce((n,c)=>n+filesFor(c).length,0),'file')}</div>
      <form class="ux-toolbar mx-toolbar" data-mx="client-filter-form"><div class="mx-search">${icon('search')}<input id="mx-client-search" name="q" data-mx="client-search" type="search" value="${e(clientFilters.q)}" placeholder="Search clients, contacts or projects" aria-label="Search clients"></div>${select('Status','clientStatus',['All',...unique(['Active','On hold','Archived',...s.clients.map(c=>c.status||'Not set')])],clientFilters.status,'client-status')}${select('Sort','clientSort',[{value:'name',label:'Name A–Z'},{value:'projects',label:'Most projects'},{value:'updated',label:'Recently updated'}],clientFilters.sort,'client-sort')}<button class="btn" type="submit">Search</button>${button('Reset','client-reset')}</form>
      <div class="mx-results-line"><span>${rows.length} of ${s.clients.length} clients</span></div>
      ${rows.length?`<div class="mx-client-layout"><div class="mx-client-list">${rows.map(c=>{const projects=projectsFor(c.id),cues=s.cues.filter(cue=>projects.some(p=>p.id===cue.projectId)),contacts=contactsFor(c);return `<article class="ux-card mx-client-card ${clientId===c.id?'selected':''}"><div class="mx-card-top"><span class="mx-monogram">${e(c.initials||c.name.slice(0,2).toUpperCase())}</span>${badge(c.status||'Not set',c.status==='Active'?'green':'gray')}</div><h2><button type="button" class="link-button" data-mx="client-select" data-id="${e(c.id)}">${e(c.name)}</button></h2><p class="mx-contact-preview">${e(contacts[0]?.name||'Contact not recorded')}${contacts[0]?.email?`<small>${e(contacts[0].email)}</small>`:''}</p><div class="mx-card-counts"><span><strong>${projects.length}</strong> projects</span><span><strong>${cues.length}</strong> cues</span><span><strong>${filesFor(c).length}</strong> files / records</span></div><div class="mx-card-actions">${button('View details '+icon('arrow'),'client-select',c.id,'small')}${button('Edit','client-edit',c.id,'small ghost')}</div></article>`;}).join('')}</div>${clientDetail(selected)}</div>`:empty('No clients match your filters',button('Clear filters','client-reset'))}
    </div>`;
  }
  function clientDetail(c){
    const projects=projectsFor(c.id),files=filesFor(c),activities=[...(c.activity||[]),...data().imports.filter(i=>i.clientId===c.id||projects.some(p=>p.id===i.projectId)).map(i=>({text:'Imported '+i.filename,date:i.date})),...data().exports.filter(x=>x.clientId===c.id||projects.some(p=>p.id===x.projectId)).map(x=>({text:'Exported '+(x.society||x.format||'file')+' · '+x.projectTitle,date:x.date}))];
    return `<aside class="ux-card mx-client-detail"><div class="mx-section-head"><div><span class="mx-overline">CLIENT PROFILE</span><h2>${e(c.name)}</h2></div>${button('Edit','client-edit',c.id,'small')}</div>${c.notes?`<p class="mx-client-notes">${e(c.notes)}</p>`:''}<dl class="mx-key-values"><div><dt>Status</dt><dd>${e(c.status||'Not set')}</dd></div><div><dt>Location</dt><dd>${e(c.location||'Not recorded')}</dd></div>${c.website?`<div><dt>Website</dt><dd>${safeUrl(c.website)?`<a href="${e(safeUrl(c.website))}" target="_blank" rel="noopener noreferrer">${e(c.website)}</a>`:e(c.website)}</dd></div>`:''}</dl>
      <section class="mx-detail-section"><h3>Contacts <span>${contactsFor(c).length}</span></h3>${contactsFor(c).map(contact=>`<div class="mx-contact"><strong>${e(contact.name||'Unnamed contact')}</strong>${contact.role?`<small>${e(contact.role)}</small>`:''}${contact.email?`<a href="mailto:${e(contact.email)}">${e(contact.email)}</a>`:''}${contact.phone?`<a href="tel:${e(contact.phone.replace(/[^+\d]/g,''))}">${e(contact.phone)}</a>`:''}</div>`).join('')||'<p class="ux-muted">No contacts recorded.</p>'}</section>
      <section class="mx-detail-section"><h3>Projects <span>${projects.length}</span></h3>${projectLinks(projects.map(p=>p.id))||'<p class="ux-muted">No linked projects.</p>'}</section>
      <section class="mx-detail-section"><div class="mx-section-head"><h3>Files & references <span>${files.length}</span></h3>${button('Add link','client-file',c.id,'small ghost')}</div>${fileRows(files)}</section>
      <section class="mx-detail-section"><h3>Recent activity</h3>${timeline(activities)}</section>
    </aside>`;
  }
  function contactRow(contact={},i=0){return `<div class="mx-contact-form" data-mx-contact-row><div class="form-grid">${field('Contact name','contactName'+i,contact.name)}${field('Role','contactRole'+i,contact.role)}${field('Email','contactEmail'+i,contact.email,'email')}${field('Phone','contactPhone'+i,contact.phone,'tel')}</div>${button('Remove contact','contact-remove','','small ghost')}</div>`;}
  function clientModal(id){
    const c=data().clients.find(c=>c.id===id)||{};
    ctx.modal(ctx.modalHead(c.id?'Edit client':'Add client')+`<div class="modal-body mx-modal"><form data-mx="client-form" data-id="${e(c.id||'')}"><div class="form-grid">${field('Client name','name',c.name,'text','required')}${select('Status','status',['Not set','Active','On hold','Archived'],c.status||'Not set')}${field('Location','location',c.location)}${field('Website','website',c.website,'url')}${area('Notes','notes',c.notes)}</div><section class="mx-detail-section"><div class="mx-section-head"><h3>Contacts</h3>${button(icon('plus')+' Add contact','contact-add','','small')}</div><div id="mx-contacts">${(contactsFor(c).length?contactsFor(c):[{}]).map(contactRow).join('')}</div></section>${formActions(c.id?'Save client':'Create client')}</form></div>`);
  }

  function repositoryRecords(){
    const s=data();
    const imports=s.imports.map(i=>({id:i.id,name:i.filename,kind:'Import record',projectId:i.projectId,date:i.date,user:i.user,description:`${i.count??0} cues · ${i.sheet||'Sheet not recorded'} · Original file not retained`}));
    const exports=s.exports.map(x=>({id:x.id,name:x.filename||`${x.society||x.format||'Export'} · ${x.projectTitle} · ${x.episode?'Episode '+x.episode:'Movie'}`,kind:x.snapshot?'Export snapshot':'Export record',date:x.date,projectId:x.projectId,user:x.user,exportId:x.snapshot?x.id:null}));
    const references=['IPRS','PRS','ASCAP'].map(society=>({id:society,name:society+' verification.xlsx',kind:'Reference workbook',download:society+'-verification.xlsx'}));
    const builtins=[
      {id:'system-imports',name:'Imported workfiles',kind:'Imports',description:'Import history and source workbook metadata.',items:imports},
      {id:'system-exports',name:'Export snapshots',kind:'Exports',description:'Saved export data available for regeneration.',items:exports},
      {id:'system-references',name:'Society workbooks',kind:'Reference files',description:'Supplied reference workbooks.',items:references}
    ].map(r=>({...r,status:'System collection',projectIds:unique(r.items.flatMap(i=>i.projectIds||[i.projectId])),contributors:unique(r.items.map(i=>i.user)),updatedAt:recent(r.items)[0]?.date}));
    return [...builtins,...(s.repositories||[]).map(r=>({...r,kind:'Custom',items:(r.references||[]).map(f=>({...f,kind:'Reference link',date:f.createdAt,description:f.notes,url:safeUrl(f.url)})),contributors:unique((r.activity||[]).map(a=>a.user))}))];
  }
  function repositories(){
    const all=repositoryRecords(),f=repoFilters,q=f.q.toLowerCase();
    const rows=all.filter(r=>(f.kind==='All'||r.kind===f.kind)&&[r.name,r.description,r.status,...r.items.map(i=>[i.name,i.description,i.url].join(' ')),...data().projects.filter(p=>(r.projectIds||[]).includes(p.id)).map(p=>p.title)].join(' ').toLowerCase().includes(q));
    rows.sort((a,b)=>f.sort==='updated'?(Date.parse(b.updatedAt)||0)-(Date.parse(a.updatedAt)||0):f.sort==='items'?b.items.length-a.items.length:a.name.localeCompare(b.name));
    if(!rows.some(r=>r.id===repoId))repoId=rows[0]?.id||'';
    const selected=rows.find(r=>r.id===repoId),items=all.flatMap(r=>r.items);
    return `<div class="ux-page mx-page">${title('Repositories',button(icon('plus')+' New repository','repo-new','','primary'))}<div class="ux-stats">${stat('Repositories',all.length,'folder')}${stat('Downloadable files',items.filter(i=>i.download||i.exportId).length,'download')}${stat('Linked references',items.filter(i=>i.url).length,'globe')}${stat('Import records',data().imports.length,'file')}</div>
      <form class="ux-toolbar mx-toolbar" data-mx="repo-filter-form"><div class="mx-search">${icon('search')}<input id="mx-repo-search" name="q" data-mx="repo-search" type="search" value="${e(f.q)}" placeholder="Search repositories, files or projects" aria-label="Search repositories"></div>${select('Type','repoKind',['All','Imports','Exports','Reference files','Custom'],f.kind,'repo-kind')}${select('Sort','repoSort',[{value:'name',label:'Name A–Z'},{value:'updated',label:'Recently updated'},{value:'items',label:'Most items'}],f.sort,'repo-sort')}<button class="btn" type="submit">Search</button>${button('Reset','repo-reset')}</form>
      <div class="mx-results-line"><span>${rows.length} of ${all.length} repositories</span></div>
      ${rows.length?`<div class="mx-repository-layout"><div class="mx-repo-list">${rows.map(r=>`<button type="button" class="ux-card mx-repo-card ${r.id===repoId?'selected':''}" data-mx="repo-select" data-id="${e(r.id)}" aria-pressed="${r.id===repoId}"><span class="mx-repo-icon">${icon('folder')}</span><span class="mx-repo-summary"><strong>${e(r.name)}</strong><small>${e(r.kind)} · ${r.items.length} items</small><small>${(r.projectIds||[]).length} linked projects</small></span>${icon('chevron')}</button>`).join('')}</div>${repositoryDetail(selected)}</div>`:empty('No repositories match your filters',button('Clear filters','repo-reset'))}
    </div>`;
  }
  function repositoryDetail(r){
    const files=r.items.filter(i=>i.download||i.exportId).length,links=r.items.filter(i=>i.url).length;
    return `<section class="ux-card mx-repository-detail"><header class="mx-section-head"><div><span class="mx-overline">${e(r.kind)}</span><h2>${e(r.name)}</h2></div><div class="button-row">${r.kind==='Custom'?button('Edit','repo-edit',r.id,'small')+button(icon('plus')+' Add reference','repo-reference',r.id,'small primary'):r.kind==='Imports'?'<button class="btn small" data-action="upload">'+icon('upload')+' Import workfile</button>':r.kind==='Exports'?'<button class="btn small" data-nav="exports">Prepare export '+icon('arrow')+'</button>':''}</div></header>${r.description?`<p class="mx-repo-description">${e(r.description)}</p>`:''}<div class="mx-repo-metrics"><div><span>Files / snapshots</span><strong>${files}</strong></div><div><span>Linked references</span><strong>${links}</strong></div><div><span>Updated</span><strong>${e(day(r.updatedAt))}</strong></div><div><span>Status</span><strong>${e(r.status||'Active')}</strong></div></div>
      ${r.id==='system-imports'?'<div class="mx-context-note">Source workbook names and import history are retained. Original workbook binaries are not stored.</div>':''}
      <section class="mx-detail-section"><h3>Contents <span>${r.items.length}</span></h3>${fileRows(r.items)}</section>
      <div class="mx-repo-detail-grid"><section class="mx-detail-section"><h3>Linked projects <span>${(r.projectIds||[]).length}</span></h3>${projectLinks(r.projectIds||[])||'<p class="ux-muted">No linked projects.</p>'}</section><section class="mx-detail-section"><h3>Contributors</h3>${r.contributors?.length?`<div class="mx-tags">${r.contributors.map(chip).join('')}</div>`:'<p class="ux-muted">No contributors recorded.</p>'}</section></div>
      <section class="mx-detail-section"><h3>Recent updates</h3>${timeline(r.activity?.length?r.activity:r.items.filter(i=>i.date).map(i=>({text:i.kind+' · '+i.name,date:i.date})))}</section>
    </section>`;
  }
  function repositoryModal(id){
    const r=(data().repositories||[]).find(r=>r.id===id)||{};
    ctx.modal(ctx.modalHead(r.id?'Edit repository':'New repository')+`<div class="modal-body mx-modal"><form data-mx="repo-form" data-id="${e(r.id||'')}"><div class="form-grid">${field('Repository name','name',r.name,'text','required')}${select('Status','status',['Active','Archived'],r.status||'Active')}${area('Description','description',r.description)}</div><section class="mx-detail-section"><h3>Linked projects</h3><div class="mx-project-checkboxes">${data().projects.map(p=>`<label><input type="checkbox" name="projectIds" value="${e(p.id)}" ${(r.projectIds||[]).includes(p.id)?'checked':''}><span>${e(p.title)}</span></label>`).join('')||'<p class="ux-muted">No projects available.</p>'}</div></section>${formActions(r.id?'Save repository':'Create repository')}</form></div>`);
  }
  function referenceModal(kind,id){ctx.modal(ctx.modalHead('Add reference link')+`<div class="modal-body"><form data-mx="reference-form" data-kind="${kind}" data-id="${e(id)}"><div class="form-grid">${field('Reference name','name','','text','required')}${field('URL','url','','url','required placeholder="https://"')}${area('Notes','notes')}</div>${formActions('Add reference')}</form></div>`);}
  function revealDetail(selector){if(window.matchMedia('(max-width: 850px)').matches)document.querySelector(selector)?.scrollIntoView({block:'start',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}

  function click(event){
    const target=event.target.closest('button[data-mx],a[data-mx]');if(!target)return false;
    const {mx:action,id}=target.dataset;
    switch(action){
      case 'client-new':clientModal();break;
      case 'client-edit':clientModal(id);break;
      case 'client-select':clientId=id;if(document.querySelector('.mx-client-layout'))ctx.render();else{clientFilters={q:'',status:'All',sort:'name'};ctx.go('clients');}revealDetail('.mx-client-detail');break;
      case 'client-reset':clientFilters={q:'',status:'All',sort:'name'};ctx.render();break;
      case 'client-file':referenceModal('client',id);break;
      case 'contact-add':{const host=document.querySelector('#mx-contacts');host.insertAdjacentHTML('beforeend',contactRow({},Date.now()));host.lastElementChild.querySelector('input').focus();break;}
      case 'contact-remove':target.closest('[data-mx-contact-row]').remove();break;
      case 'repo-new':repositoryModal();break;
      case 'repo-edit':repositoryModal(id);break;
      case 'repo-select':repoId=id;if(document.querySelector('.mx-repository-layout'))ctx.render();else{repoFilters={q:'',kind:'All',sort:'name'};ctx.go('repositories');}revealDetail('.mx-repository-detail');break;
      case 'repo-reference':referenceModal('repo',id);break;
      case 'repo-reset':repoFilters={q:'',kind:'All',sort:'name'};ctx.render();break;
      case 'import-delete':importDeleteModal(id);break;
      case 'confirm-import-delete':deleteImportRecord(id);break;
      default:return false;
    }
    event.preventDefault();return true;
  }
  function change(event){
    const action=event.target.dataset.mx;
    const fields={'client-status':[clientFilters,'status'],'client-sort':[clientFilters,'sort'],'repo-kind':[repoFilters,'kind'],'repo-sort':[repoFilters,'sort']};
    if(!fields[action])return false;fields[action][0][fields[action][1]]=event.target.value;ctx.render();return true;
  }
  function input(event){
    const filters={'client-search':clientFilters,'repo-search':repoFilters}[event.target.dataset.mx];
    if(!filters)return false;const id=event.target.id,start=event.target.selectionStart;filters.q=event.target.value;ctx.render();const field=document.getElementById(id);field?.focus();if(field&&start!==null)field.setSelectionRange(start,start);return true;
  }
  function submit(event){
    const form=event.target,action=form.dataset.mx;if(!action)return false;
    const values=new FormData(form),get=name=>String(values.get(name)||'').trim(),id=form.dataset.id;
    if(!['client-filter-form','repo-filter-form','client-form','repo-form','reference-form'].includes(action))return false;
    event.preventDefault();
    if(action.endsWith('-filter-form')){const f=action==='client-filter-form'?clientFilters:repoFilters;f.q=get('q');ctx.render();return true;}
    if(action==='client-form'){
      const name=get('name');if(!name){toast('Enter a client name.');return true;}
      if(get('website')&&!safeUrl(get('website'))){toast('Use an HTTP or HTTPS website URL.');return true;}
      const contacts=[...form.querySelectorAll('[data-mx-contact-row]')].map(row=>{const inputs=[...row.querySelectorAll('input')];return {name:inputs[0].value.trim(),role:inputs[1].value.trim(),email:inputs[2].value.trim(),phone:inputs[3].value.trim()};}).filter(c=>Object.values(c).some(Boolean));
      const record={name,status:get('status'),location:get('location'),website:get('website'),notes:get('notes'),contacts,contact:contacts[0]?.name||'',email:contacts[0]?.email||'',phone:contacts[0]?.phone||'',initials:name.split(/\s+/).slice(0,2).map(s=>s[0]).join('').toUpperCase(),updatedAt:now()};
      const createdId=id||uid('CL');
      if(commit((id?'Updated':'Created')+' client · '+name,s=>{let c=s.clients.find(c=>c.id===id);if(!c){c={id:createdId,createdAt:now()};s.clients.push(c);}Object.assign(c,record);c.activity??=[];c.activity.unshift({text:id?'Client profile updated':'Client created',date:now()});})){clientId=createdId;if(!id)clientFilters={q:'',status:'All',sort:'name'};ctx.close();ctx.render();toast(id?'Client updated.':'Client created.');}
    }
    if(action==='repo-form'){
      const name=get('name');if(!name){toast('Enter a repository name.');return true;}
      const record={name,description:get('description'),status:get('status'),projectIds:values.getAll('projectIds').filter(id=>data().projects.some(p=>p.id===id)),updatedAt:now()},createdId=id||uid('REP');
      if(commit((id?'Updated':'Created')+' repository · '+name,s=>{s.repositories??=[];let r=s.repositories.find(r=>r.id===id);if(!r){r={id:createdId,createdAt:now(),references:[],activity:[]};s.repositories.push(r);}Object.assign(r,record);r.activity??=[];r.activity.unshift({text:id?'Repository details updated':'Repository created',date:now()});})){repoId=createdId;repoFilters={q:'',kind:'All',sort:'name'};ctx.close();ctx.render();toast(id?'Repository updated.':'Repository created.');}
    }
    if(action==='reference-form'){
      const name=get('name'),url=safeUrl(get('url'));if(!name||!url){toast('Enter a reference name and a valid HTTP or HTTPS URL.');return true;}
      const owner=form.dataset.kind==='client'?data().clients.find(c=>c.id===id):(data().repositories||[]).find(r=>r.id===id);if(!owner)return true;
      if(commit('Added reference · '+name,()=>{const key=form.dataset.kind==='client'?'files':'references';owner[key]??=[];owner[key].push({id:uid('REF'),name,url,notes:get('notes'),createdAt:now()});owner.updatedAt=now();owner.activity??=[];owner.activity.unshift({text:'Added reference · '+name,date:now()});})){ctx.close();ctx.render();toast('Reference link added.');}
    }
    return true;
  }
  return {clients,repositories,click,change,input,submit,repositoryRecords};
};

/* discovery.js */
/* Workspace discovery and delivery. Views read the same normalized records as the editor. */
window.createDiscoveryUX = function createDiscoveryUX(ctx) {
  'use strict';
  const {esc:e,icon,options,badge}=ctx, D=window.CueDomain;
  const data=()=>ctx.state(), list=(v)=>Array.isArray(v)?v:[];
  const labelDate=v=>v&&!Number.isNaN(Date.parse(v))?ctx.date(v):'Not recorded';
  const join=(values)=>values.filter(v=>v!==undefined&&v!==null&&v!=='').join(' · ');
  const unique=values=>[...new Set(values.filter(Boolean))];
  const projectName=id=>data().projects.find(p=>p.id===id)?.title||'Unlinked project';
  const clientName=id=>data().clients.find(c=>c.id===id)?.name||'No client';
  const workName=id=>data().works.find(w=>w.id===id)?.title||'Unresolved Work';
  const act=(label,attrs,kind='')=>`<button type="button" class="btn ${kind}" ${attrs}>${label}</button>`;
  const field=(label,id,items,value)=>`<label class="dx-field" for="${id}"><span>${label}</span><select class="input" id="${id}" data-dx-filter="${id}">${options(items,value)}</select></label>`;
  const heading=(title,actions='')=>`<header class="dx-heading"><div><div class="dx-eyebrow">WORKSPACE</div><h1>${title}</h1></div><div class="button-row">${actions}</div></header>`;
  const blank=(title,detail='',action='')=>`<div class="ux-empty dx-empty">${icon('search')}<h3>${e(title)}</h3>${detail?`<p>${e(detail)}</p>`:''}${action}</div>`;
  let category='all',searchProject='all',searchStatus='all',searchSort='title';
  const searchPageSize=40;
  let searchPage=1,searchSignature='',recordCache=null;
  let format='xlsx',csvScope='content',previewQuery='',previewUsage='all',previewSource='all',selection=null;
  let historyQuery='',historyProject='all',historySociety='all',historyStatus='all',historySort='newest',busy=false;
  const categories=[['projects','Projects','folder'],['works','Songs / Works','music'],['artists','Artists / Rights holders','users'],['cues','Music cues','list'],['episodes','Episodes','film'],['clients','Clients','users'],['references','References','search'],['repositories','Repositories','folder'],['imports','Imports','upload'],['exports','Exports','download'],['members','Team members','users'],['profiles','Import profiles','settings'],['activity','Activity','clock'],['societies','Society templates','globe']];

  function records() {
    const s=data(),revision=ctx.revision?.();
    if(revision!==undefined&&recordCache?.state===s&&recordCache.revision===revision)return recordCache.rows;
    const rows=[],counts=new Map(),statuses=new Set();
    const byId=items=>new Map(list(items).map(item=>[item.id,item]));
    const projects=byId(s.projects),works=byId(s.works),clients=byId(s.clients),members=byId(s.members);
    const projectName=id=>projects.get(id)?.title||'Unlinked project',clientName=id=>clients.get(id)?.name||'No client',workName=id=>works.get(id)?.title||'Unresolved Work';
    const cuesByProject=new Map(),cuesByWork=new Map(),cuesByEpisode=new Map(),worksByArtist=new Map(),projectsByClient=new Map(),projectsByEditor=new Map();
    const append=(map,key,item)=>{if(!map.has(key))map.set(key,[]);map.get(key).push(item);};
    for(const cue of s.cues){
      append(cuesByProject,cue.projectId,cue);append(cuesByWork,cue.workId,cue);
      if(!cuesByEpisode.has(cue.projectId))cuesByEpisode.set(cue.projectId,new Map());
      append(cuesByEpisode.get(cue.projectId),Number(cue.episode),cue);
    }
    for(const work of s.works)for(const id of unique([...list(work.artistIds),...list(work.parties).map(party=>party.artistId)]))append(worksByArtist,id,work);
    for(const project of s.projects){append(projectsByClient,project.clientId,project);append(projectsByEditor,project.assignedEditorId,project);}
    const add=(kind,raw,title,meta,details,action,projectIds=[],status='',date='')=>{
      const row={key:kind+':'+(raw.id??rows.length),kind,raw,title:title||'Untitled',meta,details,action,projectIds,status,date};
      row.searchText=JSON.stringify([row.title,row.meta,row.details,row.status,row.raw]).toLocaleLowerCase();
      rows.push(row);counts.set(kind,(counts.get(kind)||0)+1);if(status)statuses.add(status);
    };
    s.projects.forEach(p=>add('projects',p,p.title,join([clientName(p.clientId),p.type,p.language,p.year]),[['Status',p.status||'Not recorded'],['Content',p.type==='Series'?list(p.episodes).length+' episodes':'Feature film'],['Music cues',(cuesByProject.get(p.id)||[]).length],['Editor',members.get(p.assignedEditorId)?.name||'Unassigned'],['Deadline',p.deadline?labelDate(p.deadline):'Not recorded'],['Channel',p.channel||'Not recorded']],`data-project="${e(p.id)}"`,[p.id],p.status,p.updatedAt));
    s.works.forEach(w=>{const stored={...w};delete stored.research;delete stored.status;add('works',stored,w.title,join([w.id,w.type,w.language]),[['Artist',w.artist||'Not recorded'],['ISRC',w.isrc||'Not recorded'],['Rights holders',list(w.parties).map(p=>join([p.name,p.role])).join('; ')||'No rights holders recorded'],['Usage',(cuesByWork.get(w.id)||[]).length+' cues'],['Source',w.source||'Not recorded']],`data-work="${e(w.id)}"`,unique((cuesByWork.get(w.id)||[]).map(c=>c.projectId)),'',list(w.activity)[0]?.date);});
    list(s.artists).forEach(artist=>{
      const songs=worksByArtist.get(artist.id)||[];
      add('artists',artist,artist.name,join([artist.ipi?'IPI '+artist.ipi:'',list(artist.roles).join(', ')]),[['IPI / CAE',artist.ipi||'Not recorded'],['Societies',list(artist.societies).join(', ')||'Not recorded'],['Aliases',list(artist.aliases).join(', ')||'None'],['Linked songs',songs.map(work=>work.title).join(', ')||'No linked songs'],['Email',artist.email||'Not recorded']],`data-catalog="artist-open" data-id="${e(artist.id)}"`,unique(songs.flatMap(work=>(cuesByWork.get(work.id)||[]).map(cue=>cue.projectId))),artist.status,artist.updatedAt);
    });
    s.cues.forEach(c=>add('cues',c,workName(c.workId),join([projectName(c.projectId),c.episode==null?'Movie':'Episode '+c.episode,c.id]),[['Timing',join([D.time(c.start)+' → '+D.time(c.end),D.time(c.duration)])],['Usage',c.usage||'Not recorded'],['Source',c.source||'Not recorded'],['Notes',c.notes||'No notes']],`data-edit-cue="${e(c.id)}"`,[c.projectId],'',c.updatedAt));
    s.projects.forEach(p=>list(p.episodes).forEach(ep=>{
      const cues=cuesByEpisode.get(p.id)?.get(Number(ep.number))||[];
      add('episodes',{...ep,id:p.id+':'+ep.number,projectId:p.id},'Episode '+ep.number+' · '+(ep.title||'Untitled'),join([p.title,clientName(p.clientId)]),[['Music cues',cues.length],['Music duration',D.time(cues.reduce((n,c)=>n+(Number(c.duration)||0),0))],['Episode duration',ep.duration||p.duration||'Not recorded'],['Air date',ep.airdate||p.airdate||'Not recorded']],cues.length?`data-edit-cue="${e(cues[0].id)}"`:`data-dx-episode="${e(p.id)}" data-number="${e(ep.number)}"`,[p.id],ep.status||'',ep.updatedAt);
    }));
    s.clients.forEach(c=>{
      const projects=projectsByClient.get(c.id)||[];
      add('clients',c,c.name,join([c.contact,c.email]),[['Status',c.status||'Not recorded'],['Phone',c.phone||'Not recorded'],['Projects',projects.map(p=>p.title).join(', ')||'No projects'],['Contacts',list(c.contacts).map(p=>join([p.name,p.role,p.email])).join('; ')||c.contact||'Not recorded']],`data-mx="client-select" data-id="${e(c.id)}"`,projects.map(p=>p.id),c.status||'',c.updatedAt);
      list(c.files).forEach(file=>add('references',file,file.name||file.url,c.name+' · Client file',[['URL',file.url||'No link'],['Notes',file.notes||'No notes']],`data-mx="client-select" data-id="${e(c.id)}"`,projects.map(p=>p.id),'',file.createdAt));
    });
    const systemRepos=[['system-imports','Imported workfiles',s.imports.length,'imports',s.imports.map(r=>r.projectId)],['system-exports','Export snapshots',s.exports.length,'exports',s.exports.map(r=>r.projectId)],['system-references','Society workbooks',Object.keys(window.CueExports?.mappings||{}).length,'societies',[]]];
    systemRepos.forEach(([id,name,count,content,projectIds])=>add('repositories',{id,name,count,content,projectIds:unique(projectIds)},name,'Workspace collection',[['Contents',count+' records'],['Collection','Built in']],`data-mx="repo-select" data-id="${id}"`,unique(projectIds)));
    list(s.repositories).forEach(r=>{
      add('repositories',r,r.name,r.description||'Repository',[['References',list(r.references).length],['Projects',list(r.projectIds).map(projectName).join(', ')||'No linked projects'],['Updated',labelDate(r.updatedAt)]],`data-mx="repo-select" data-id="${e(r.id)}"`,list(r.projectIds),r.status,r.updatedAt);
      list(r.references).forEach(ref=>add('references',ref,ref.name||ref.url,r.name,[['URL',ref.url||'No link'],['Notes',ref.notes||'No notes']],`data-mx="repo-select" data-id="${e(r.id)}"`,list(r.projectIds),'',ref.createdAt));
    });
    s.imports.forEach(r=>add('imports',r,r.filename||'Import',join([projectName(r.projectId),r.sheet]),[['Cues',r.count??0],['Matched Works',r.matched??0],['New Works',r.newWorks??0],['Warnings',r.warnings??0],['Imported by',r.user||'Not recorded'],['Date',labelDate(r.date)]],`data-dx-detail="imports:${e(r.id)}"`,[r.projectId],'Imported',r.date));
    s.exports.forEach(r=>add('exports',r,r.projectTitle||projectName(r.projectId),join([r.society,r.episodes?.length>1?'Episodes '+r.episodes[0]+'-'+r.episodes.at(-1)+' | '+r.episodes.length+' sheets':r.episode==null?'Movie':'Episode '+r.episode]),[['Cues',r.count],['Format','XLSX'],['Template',r.version||'Not recorded'],['Created',labelDate(r.date)]],r.snapshot?`data-regenerate="${e(r.id)}"`:`data-dx-detail="exports:${e(r.id)}"`,[r.projectId],r.status||'Review draft',r.date));
    list(s.members).forEach(m=>add('members',m,m.name,m.email||'No email',[['Role',m.role||'Not recorded'],['Projects',(projectsByEditor.get(m.id)||[]).map(p=>p.title).join(', ')||'Unassigned']],`data-nav="members"`,(projectsByEditor.get(m.id)||[]).map(p=>p.id),m.active===false?'Inactive':'Active',m.updatedAt));
    list(s.profiles).forEach((p,index)=>add('profiles',{...p,id:p.id||String(index)},p.name,'Import mapping',[['Columns',list(p.headers).join(', ')||'No headers'],['Mapped fields',list(p.mapping).filter(Boolean).join(', ')||'No mapping']],`data-nav="import"`));
    list(s.activity).forEach((a,index)=>add('activity',{...a,id:String(index)},a.text,labelDate(a.date),[],`data-dx-detail="activity:${index}"`,a.projectId?[a.projectId]:s.projects.filter(p=>String(a.text).includes(p.title)).map(p=>p.id),'',a.date));
    Object.entries(window.CueExports?.mappings||{}).forEach(([society,m])=>add('societies',{...m,id:society},society+' workbook',join([m.version,m.sheet]),[['Columns',list(m.columns).filter(Boolean).join(', ')],['Header row',m.headerRow]],`data-society="${e(society)}"`,[],'Review draft'));
    recordCache={state:s,revision,rows,counts,statuses:[...statuses].sort()};
    return rows;
  }
  function search() {
    const all=records(),query=String(ctx.query()||'').trim().toLocaleLowerCase(),terms=query.split(/\s+/).filter(Boolean);
    const signature=JSON.stringify([query,category,searchProject,searchStatus,searchSort]);
    if(searchSignature!==signature){searchPage=1;searchSignature=signature;}
    const {statuses,counts}=recordCache;
    const matches=all.filter(r=>terms.every(term=>r.searchText.includes(term))&&(searchProject==='all'||r.projectIds.includes(searchProject))&&(searchStatus==='all'||r.status===searchStatus));
    const visible=matches.filter(r=>category==='all'||r.kind===category).sort((a,b)=>searchSort==='newest'?(Date.parse(b.date)||0)-(Date.parse(a.date)||0)||a.title.localeCompare(b.title):searchSort==='oldest'?(Date.parse(a.date)||0)-(Date.parse(b.date)||0)||a.title.localeCompare(b.title):searchSort==='title-desc'?b.title.localeCompare(a.title):a.title.localeCompare(b.title));
    const countLabel=terms.length?'matches':'records',matchCounts=new Map();
    for(const row of matches)matchCounts.set(row.kind,(matchCounts.get(row.kind)||0)+1);
    const pageCount=Math.max(1,Math.ceil(visible.length/searchPageSize));
    searchPage=Math.max(1,Math.min(searchPage,pageCount));
    const offset=(searchPage-1)*searchPageSize,pageRows=visible.slice(offset,offset+searchPageSize);
    const pagination=visible.length?`<nav class="dx-pagination" aria-label="Search result pages"><span role="status" aria-live="polite">Showing ${offset+1}–${offset+pageRows.length} of ${visible.length} ${countLabel} · Page ${searchPage} of ${pageCount}</span><div><button type="button" class="btn small" data-dx-search-page="${searchPage-1}" aria-label="Previous page of search results" aria-controls="dx-search-results" ${searchPage===1?'disabled':''}>Previous</button><button type="button" class="btn small" data-dx-search-page="${searchPage+1}" aria-label="Next page of search results" aria-controls="dx-search-results" ${searchPage===pageCount?'disabled':''}>Next</button></div></nav>`:'';
    return `<div class="ux-page dx-page">${heading('Search',act(icon('upload')+' Import workfile','data-action="upload"'))}<section class="dx-search-intro ux-card"><form id="dx-search-form" class="dx-search-form">${icon('search')}<input class="input" type="search" name="q" value="${e(ctx.query())}" aria-label="Search the entire workspace" placeholder="Search songs, projects, people, IDs and references…"><button class="btn primary" type="submit">Search workspace</button></form><div class="dx-search-overview"><strong>${all.length} records</strong><span>${categories.length} content categories</span>${terms.length?`<span>Results for <strong>“${e(ctx.query())}”</strong></span>`:''}</div></section>
      <nav class="dx-category-grid" aria-label="Content categories"><button class="dx-category ${category==='all'?'active':''}" data-dx-category="all" aria-pressed="${category==='all'}"><span>${icon('grid')}All content</span><strong>${matches.length}</strong><small>${all.length} total</small></button>${categories.map(([key,title,ico])=>`<button class="dx-category ${category===key?'active':''}" data-dx-category="${key}" aria-pressed="${category===key}"><span>${icon(ico)}${title}</span><strong>${matchCounts.get(key)||0}</strong><small>${counts.get(key)||0} total</small></button>`).join('')}</nav>
      <section class="dx-results"><div class="ux-toolbar dx-toolbar">${field('Project','dx-search-project',[{value:'all',label:'All projects'},...data().projects.map(p=>({value:p.id,label:p.title}))],searchProject)}${field('Status','dx-search-status',[{value:'all',label:'All statuses'},...statuses],searchStatus)}${field('Sort','dx-search-sort',[{value:'title',label:'Name A–Z'},{value:'title-desc',label:'Name Z–A'},{value:'newest',label:'Newest first'},{value:'oldest',label:'Oldest first'}],searchSort)}${act('Reset filters','data-dx="clear-search"','ghost')}</div><div class="dx-results-head"><h2 id="dx-results-heading" tabindex="-1">${category==='all'?'All content':categories.find(c=>c[0]===category)?.[1]}</h2><span>${visible.length} ${countLabel}</span></div>${visible.length?`<div class="dx-result-grid" id="dx-search-results">${pageRows.map(resultCard).join('')}</div>${pagination}`:blank('No matching records',all.length?'Try another search term or reset your filters.':'Create a project or import a workfile to begin.',act('Reset search','data-dx="clear-search"','primary'))}</section></div>`;
  }

  function resultCard(r) {
    const cat=categories.find(c=>c[0]===r.kind);
    const verb=r.kind==='exports'&&r.raw.snapshot?'Download':r.kind==='imports'||r.kind==='activity'?'Details':'Open';
    return `<article class="ux-card dx-result"><div class="dx-result-top"><span class="dx-type">${icon(cat[2])}${e(cat[1])}</span>${r.status?badge(r.status,['Complete','Society Verified','Active','Imported'].includes(r.status)?'green':'gray'):''}</div><h3><button class="link-button" ${r.action}>${e(r.title)}</button></h3><p class="dx-result-meta">${e(r.meta)}</p>${r.details.length?`<dl class="dx-metadata">${r.details.map(([key,value])=>`<div><dt>${e(key)}</dt><dd>${e(value)}</dd></div>`).join('')}</dl>`:''}<div class="dx-result-actions">${act(verb+' '+icon('arrow'),r.action,'small')}${!r.action.includes('data-dx-detail')?act('Full record',`data-dx-detail="${e(r.key)}"`,'small ghost'):''}</div></article>`;
  }

  function detail(key) {
    const row=records().find(r=>r.key===key);if(!row)return;
    const human=k=>k.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());
    function fields(value) {
      if(value===null||value===undefined||value==='')return '<span class="ux-muted">Not recorded</span>';
      if(Array.isArray(value))return value.length?`<div class="dx-record-list">${value.map(v=>`<div>${fields(v)}</div>`).join('')}</div>`:'<span class="ux-muted">None</span>';
      if(typeof value==='object')return `<dl class="dx-record">${Object.entries(value).map(([k,v])=>`<div><dt>${e(human(k))}</dt><dd>${fields(v)}</dd></div>`).join('')}</dl>`;
      return e(value);
    }
    ctx.modal(ctx.modalHead(row.title)+`<div class="modal-body dx-detail">${fields(row.raw)}</div>`);
  }

  function scopeRows() {
    const s=data(),es=ctx.exportState(),project=s.projects.find(p=>p.id===es.project)||s.projects[0];
    if(!project)return {project:null,cues:[]};
    if(format==='csv'&&csvScope==='workspace')return {project,cues:s.cues};
    if(format==='csv'&&csvScope==='project')return {project,cues:s.cues.filter(c=>c.projectId===project.id)};
    return {project,cues:s.cues.filter(c=>c.projectId===project.id&&(project.type==='Movie'||Number(c.episode)===Number(es.episode)))};
  }
  function previewRows() {
    return scopeRows().cues.filter(c=>join([workName(c.workId),projectName(c.projectId),c.id,c.workId,c.notes,c.episode]).toLocaleLowerCase().includes(previewQuery.toLocaleLowerCase())&&(previewUsage==='all'||c.usage===previewUsage)&&(previewSource==='all'||c.source===previewSource));
  }
  function selectedRows() { return previewRows().filter(c=>selection===null||selection.has(c.id)); }
  const formatInfo={xlsx:['Society Excel export','XLSX','Formatted cue sheet','file'],csv:['Cue data report','CSV','Filtered cue records','list'],json:['Workspace backup','JSON','All workspace data','shield']};

  function societyExportView(s,es,scope,p,issues,readyDraft) {
    const music=scope.cues.reduce((sum,c)=>sum+(Number(c.duration)||0),0),duration=D.time(music),works=unique(scope.cues.map(c=>c.workId)),recent=s.exports.slice(0,5);
    const workIds=new Set(works),linked=s.works.filter(work=>workIds.has(work.id)),members=CueSocieties.summary({works:CueSocieties.freezeWorks(linked,s.artists||[]),cues:scope.cues});
    const total=D.seconds(p?.type==='Movie'?p.duration:p?.episodes?.find(episode=>Number(episode.number)===Number(es.episode))?.duration)||0;
    const stat=(label,value,detail)=>`<div class="sx-stat"><small>${label}</small><strong>${e(value)}</strong><span>${detail}</span></div>`;
    return `<div class="ux-page dx-page sx-page">${heading('Exports')}<div class="sx-intro"><div><span class="dx-eyebrow">AMISHNA MUSIC · DELIVERY</span><p>Prepare society cue sheets from your saved projects. Review the details, choose your formats, and download.</p></div><div class="sx-format-switch" role="group" aria-label="Other export types">${Object.entries(formatInfo).map(([key,[title,ext,,ico]])=>`<button type="button" class="dx-format ${format===key?'active':''}" data-dx-format="${key}" aria-pressed="${format===key}"><span class="dx-format-icon">${icon(ico)}</span><span><strong>${title}</strong><small>${ext}</small></span></button>`).join('')}</div></div>
      ${p?`<section class="ux-card sx-flow"><div class="sx-step"><div class="sx-step-body"><div class="sx-step-title"><div><h2>Choose your project</h2><p>${scope.cues.length} cues · ${works.length} songs · ${duration} music duration</p></div>${badge(p.type==='Movie'?'Movie · IPRS Movie format':'Serial · IPRS TV / Web Series format','gray')}</div><div class="sx-fields">${field('Project','export-project',s.projects.map(x=>({value:x.id,label:x.title+' · '+(x.type==='Movie'?'Movie':'Serial')})),p.id)}${p.type==='Movie'?'<div class="sx-source-note">Movie cue sheet<br><strong>Uses saved production details</strong></div>':field('Episode','export-episode',p.episodes.map(ep=>({value:ep.number,label:'Episode '+String(ep.number).padStart(2,'0')+' · '+ep.title})),es.episode)}</div><div class="sx-download"><button type="button" class="btn primary" data-action="generate-export" ${busy||!p?'disabled':''}>${icon('download')}${busy?'Opening export dialog…':'Preview & download'}</button></div></div></div></section>
        <div class="sx-stats">${stat('Music cues',scope.cues.length,works.length+' songs in this content')}${stat('Music duration',duration,total?'of '+D.time(total)+' running time':'Running time not recorded')}${stat('Music usage',total?(music/total*100).toFixed(2)+'%':'—','Based on saved cue durations')}${stat('Artists',members.totalArtists,members.IPRS.artists+' IPRS · '+members.PRS.artists+' PRS · '+members.ASCAP.artists+' ASCAP')}</div>
        <section class="ux-card sx-preview"><div class="dx-section-head"><div><h2>Cue preview</h2><p>${e(p.title)} · ${p.type==='Movie'?'Movie':'Episode '+e(es.episode)}</p><p>IPRS artists included: ${members.IPRS.artists} · PRS-only artists excluded from IPRS: ${members.prsOnlyArtists}</p></div><span>${scope.cues.length} cues</span></div>${scope.cues.length?`<div class="table-wrap"><table class="dx-table"><thead><tr><th>TRACK</th><th>IN / OUT</th><th>DURATION</th><th>USAGE</th></tr></thead><tbody>${scope.cues.slice(0,8).map(c=>`<tr><td><strong>${e(workName(c.workId))}</strong><span class="dx-cell-sub">${e(c.workId)}</span></td><td class="mono">${c.occurrences?.length>1?c.occurrences.length+' plays':D.time(c.start)+' → '+D.time(c.end)}</td><td class="mono">${D.time(c.duration)}</td><td>${e(c.usage||'Missing')}</td></tr>`).join('')}</tbody></table></div>${scope.cues.length>8?`<p class="sx-more">Showing 8 of ${scope.cues.length} cues. Each Excel file includes the cues eligible for that society.</p>`:''}`:blank('No cues in this content','Import a workfile or add cues before exporting.')}</section>`:blank('No projects to export','Create a project and add cues before preparing an export.',act('Create project','data-action="new-project"','primary'))}
      <section class="ux-card sx-history"><div class="dx-section-head"><div><h2>Recent downloads</h2><p>Saved formatted Excel snapshots</p></div><span>${s.exports.length} total</span></div>${recent.length?`<div class="sx-history-list">${recent.map(record=>`<div><div><strong>${e(record.projectTitle)}</strong><span>${record.episodes?.length>1?'Episodes '+e(record.episodes[0])+'-'+e(record.episodes.at(-1))+' | '+record.episodes.length+' sheets':record.episode==null?'Movie':'Episode '+e(record.episode)} · ${e(record.society)} · ${labelDate(record.date)}</span></div>${record.snapshot?act(icon('download')+' Download again',`data-regenerate="${e(record.id)}"`,'small'):''}</div>`).join('')}</div>`:blank('No downloads yet','Your formatted society workbooks will appear here.')}</section></div>`;
  }

  function exportsView() {
    const s=data(),es=ctx.exportState(),scope=scopeRows(),p=scope.project;
    const issues=p?D.validateExport(scope.cues,s.works,es.society,p):[];
    const blocked=new Set(issues.map(i=>i.cueId).filter(Boolean)),globalIssue=issues.some(i=>!i.cueId),ready=globalIssue?0:Math.max(0,scope.cues.length-blocked.size),pct=scope.cues.length?Math.round(ready/scope.cues.length*100):0;
    const readyDraft=!!p&&!!scope.cues.length&&!issues.length;
    if(format==='xlsx')return societyExportView(s,es,scope,p,issues,readyDraft);
    return `<div class="ux-page dx-page">${heading('Exports',act(icon('folder')+' Repositories','data-nav="repositories"'))}<div class="ux-stats dx-stats"><div class="ux-stat dx-stat"><span>Saved drafts</span><strong>${s.exports.length}</strong></div><div class="ux-stat dx-stat"><span>Society formats</span><strong>${Object.keys(window.CueExports?.mappings||{}).length}</strong></div><div class="ux-stat dx-stat"><span>Music cues</span><strong>${s.cues.length}</strong></div><div class="ux-stat dx-stat"><span>Latest export</span><strong class="dx-date-stat">${s.exports[0]?labelDate(s.exports[0].date):'No exports yet'}</strong></div></div>
      <div class="dx-format-grid" role="group" aria-label="Export format">${Object.entries(formatInfo).map(([key,[title,ext,description,ico]])=>`<button type="button" class="dx-format ${format===key?'active':''}" data-dx-format="${key}" aria-pressed="${format===key}"><span class="dx-format-icon">${icon(ico)}</span><span><strong>${title}</strong><small>${description}</small></span><span class="ux-chip dx-extension">${ext}</span></button>`).join('')}</div>
      ${format==='json'?`<section class="ux-card dx-backup"><span class="dx-backup-icon">${icon('shield')}</span><div><h2>Download a workspace backup</h2><p>${s.projects.length} projects · ${s.works.length} Works · ${s.cues.length} cues · ${s.clients.length} clients</p><p class="ux-muted">Includes repositories, settings, activity and export snapshots.</p></div>${act(icon('download')+' Download JSON backup','data-action="backup"','primary')}</section>`:p?`<div class="dx-export-grid"><section class="ux-card dx-config"><div class="dx-section-head"><h2>${format==='xlsx'?'Prepare a review draft':'Build a cue report'}</h2>${badge(format==='xlsx'?'XLSX':'CSV','gray')}</div><div class="dx-config-fields">${format==='csv'?field('Data selection','dx-csv-scope',[{value:'content',label:'Selected content'},{value:'project',label:'Entire project'},{value:'workspace',label:'Entire workspace'}],csvScope):''}${field('Project','export-project',s.projects.map(x=>({value:x.id,label:x.title+' · '+x.type})),p.id)}${format==='xlsx'||csvScope==='content'?field('Content','export-episode',p.type==='Series'?p.episodes.map(ep=>({value:ep.number,label:'Episode '+ep.number+' · '+ep.title})):[{value:'',label:'Feature film'}],es.episode):''}${format==='xlsx'?field('Society','export-society',['IPRS','PRS','ASCAP'],es.society):''}</div><div class="dx-scope-info"><div><span>Selected content</span><strong>${scope.cues.length} cues</strong></div><div><span>Music duration</span><strong>${D.time(scope.cues.reduce((n,c)=>n+(Number(c.duration)||0),0))}</strong></div><div><span>Unique Works</span><strong>${unique(scope.cues.map(c=>c.workId)).length}</strong></div></div>${format==='xlsx'?`<div class="dx-draft-note">${icon('file')}<div><strong>Internal review draft</strong><span>Template ${e(window.CueExports?.mappings[es.society]?.version||'0.1-draft')}. Verify identifiers and society requirements before submission.</span></div></div><div class="dx-config-actions"><a class="btn" download href="${e(es.society)}-verification.xlsx">${icon('download')}Reference workbook</a>${act('Export an episode range '+icon('arrow'),`data-dx-range="${e(p.id)}"`,'ghost')}</div>`:`<div class="dx-draft-note">${icon('list')}<div><strong>${selectedRows().length} cues selected</strong><span>Report includes timing, usage, source, project, client and Work identifiers.</span></div></div><div class="dx-config-actions">${act(icon('download')+' Download CSV report','data-dx="download-csv"'+(!selectedRows().length?' disabled':''),'primary')}</div>`}</section>
      <section class="ux-card dx-readiness"><div class="dx-section-head"><h2>${format==='xlsx'?'Validation & delivery':'Report contents'}</h2>${format==='xlsx'?badge(busy?'Generating…':readyDraft?'Ready for draft':'Needs attention',readyDraft?'green':'amber'):badge('CSV','gray')}</div>${format==='xlsx'?`<div class="dx-readiness-summary"><strong>${ready}<span> / ${scope.cues.length}</span></strong><span>cues passed validation</span></div><div class="dx-progress" role="progressbar" aria-label="Cues passing society validation" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div><div class="dx-steps"><span class="done">${icon('check')}Selection</span><span class="${readyDraft?'done':''}">${icon(readyDraft?'check':'alert')}Validation</span><span>${icon('download')}Download</span></div>${issues.length?`<div class="dx-issues"><div class="dx-issues-title">${issues.length} blocking ${issues.length===1?'issue':'issues'}</div>${issues.map(i=>`<div class="dx-issue">${icon('alert')}<span>${e(i.message)}</span>${i.cueId?act('Review',`data-edit-cue="${e(i.cueId)}"`,'small'):i.workId?act('Review',`data-work="${e(i.workId)}"`,'small'):''}</div>`).join('')}</div>`:`<div class="dx-validation-ok">${icon('check')}All required checks passed for this draft.</div>`}<div class="dx-download-area"><button type="button" class="btn primary" data-action="generate-export" ${!readyDraft||busy?'disabled':''}>${icon('download')}${busy?'Generating workbook…':'Generate & download draft'}</button><span>${readyDraft?'A snapshot is saved with each generated draft.':'Resolve the blocking issues to generate a workbook.'}</span></div>`:`<div class="dx-report-columns">${['Project & client','Episode / movie','Song & Work ID','ISRC & society IDs','IN / OUT & duration','Usage & source','Cue notes'].map(t=>`<span>${icon('check')}${t}</span>`).join('')}</div><p class="dx-report-total"><strong>${selectedRows().length}</strong> selected of ${scope.cues.length} cues</p>${act('Select all matching cues','data-dx="select-cues"','small')}${act('Clear selection','data-dx="deselect-cues"','small ghost')}`}</section></div>${preview(scope.cues)}`:blank('No projects to export','Create a project and add cues to prepare an export.',act('Create project','data-action="new-project"','primary'))}
      ${history()}</div>`;
  }

  function preview(all) {
    const rows=previewRows(),selected=selectedRows();
    return `<section class="ux-card dx-preview"><div class="dx-section-head"><h2>Content preview <span class="dx-count">${rows.length}</span></h2><span class="ux-muted">${format==='xlsx'?all.length+' cues in workbook':selected.length+' cues selected'}</span></div><div class="dx-preview-toolbar"><form id="dx-preview-search" class="dx-inline-search">${icon('search')}<input class="input" type="search" name="q" value="${e(previewQuery)}" placeholder="Find a song or cue…" aria-label="Filter export content"><button type="submit" class="btn small">Filter</button></form>${field('Usage','dx-preview-usage',[{value:'all',label:'All usages'},...unique(all.map(c=>c.usage)).sort()],previewUsage)}${field('Source','dx-preview-source',[{value:'all',label:'All sources'},...unique(all.map(c=>c.source)).sort()],previewSource)}${act('Reset','data-dx="clear-preview"','small ghost')}</div>${format==='xlsx'&&(previewQuery||previewUsage!=='all'||previewSource!=='all')?`<div class="dx-preview-note">Preview filter active · the workbook contains all ${all.length} cues in the selected content.</div>`:''}${rows.length?`<div class="table-wrap"><table class="dx-table"><thead><tr>${format==='csv'?'<th scope="col">Select</th>':''}<th scope="col">Song / Cue</th><th scope="col">Project / Content</th><th scope="col">Timing</th><th scope="col">Usage</th><th scope="col">Source</th></tr></thead><tbody>${rows.map(c=>`<tr>${format==='csv'?`<td><input type="checkbox" data-dx-select-cue="${e(c.id)}" ${selection===null||selection.has(c.id)?'checked':''} aria-label="Select ${e(workName(c.workId))} ${e(c.id)}"></td>`:''}<td><button class="link-button" data-edit-cue="${e(c.id)}">${e(workName(c.workId))}</button></td><td>${e(projectName(c.projectId))}<span class="dx-cell-sub">${c.episode==null?'Movie':'Episode '+e(c.episode)}</span></td><td><span class="mono">${D.time(c.duration)}</span><span class="dx-cell-sub mono">${c.occurrences?.length>1?c.occurrences.length+' plays':D.time(c.start)+' → '+D.time(c.end)}</span></td><td>${e(c.usage||'Missing')}</td><td>${e(c.source||'Unknown')}</td></tr>`).join('')}</tbody></table></div>`:blank('No cues match this preview',all.length?'Reset the preview filters to see the selected content.':'Add music cues in the project workspace.')}</section>`;
  }

  function history() {
    const all=data().exports;
    const rows=all.filter(r=>join([r.projectTitle,r.id,r.society,r.episode,r.version]).toLocaleLowerCase().includes(historyQuery.toLocaleLowerCase())&&(historyProject==='all'||r.projectId===historyProject)&&(historySociety==='all'||r.society===historySociety)&&(historyStatus==='all'||(r.status||'Review draft')===historyStatus)).sort((a,b)=>historySort==='oldest'?(Date.parse(a.date)||0)-(Date.parse(b.date)||0):historySort==='project'?String(a.projectTitle).localeCompare(String(b.projectTitle)):(Date.parse(b.date)||0)-(Date.parse(a.date)||0));
    return `<section class="ux-card dx-history"><div class="dx-section-head"><h2>Export history <span class="dx-count">${all.length}</span></h2><span class="ux-muted">Snapshots kept for 7 days</span></div><div class="dx-history-toolbar"><form id="dx-history-search" class="dx-inline-search">${icon('search')}<input type="search" class="input" name="q" value="${e(historyQuery)}" aria-label="Search export history" placeholder="Search saved exports…"><button type="submit" class="btn small">Search</button></form>${field('Project','dx-history-project',[{value:'all',label:'All projects'},...unique(all.map(r=>r.projectId)).map(id=>({value:id,label:all.find(r=>r.projectId===id)?.projectTitle||projectName(id)}))],historyProject)}${field('Society','dx-history-society',[{value:'all',label:'All societies'},'IPRS','PRS','ASCAP'],historySociety)}${field('Status','dx-history-status',[{value:'all',label:'All statuses'},...unique(all.map(r=>r.status||'Review draft'))],historyStatus)}${field('Sort','dx-history-sort',[{value:'newest',label:'Newest first'},{value:'oldest',label:'Oldest first'},{value:'project',label:'Project A–Z'}],historySort)}${act('Reset','data-dx="clear-history"','small ghost')}</div>${rows.length?`<div class="table-wrap"><table class="dx-table"><thead><tr><th scope="col">Project / Content</th><th scope="col">Format</th><th scope="col">Cues</th><th scope="col">Created</th><th scope="col">Status</th><th scope="col">Download</th></tr></thead><tbody>${rows.map(r=>`<tr><td><strong>${e(r.projectTitle)}</strong><span class="dx-cell-sub">${r.episodes?.length>1?'Episodes '+e(r.episodes[0])+'-'+e(r.episodes.at(-1))+' | '+r.episodes.length+' sheets':r.episode==null?'Movie':'Episode '+e(r.episode)} · ${e(r.id)}</span></td><td>${e(r.society)} · XLSX<span class="dx-cell-sub">${e(r.version||'')}</span></td><td>${e(r.count)}</td><td>${labelDate(r.date)}</td><td>${badge(r.status||'Review draft','amber')}<span class="dx-cell-sub">${r.snapshot?'Snapshot saved':'Snapshot unavailable'}</span></td><td>${r.snapshot?act(icon('download')+' Download',`data-regenerate="${e(r.id)}"`,'small'):'—'}${act('Details',`data-dx-detail="exports:${e(r.id)}"`,'small ghost')}</td></tr>`).join('')}</tbody></table></div><div class="dx-history-footer">${rows.length} of ${all.length} saved exports</div>`:blank(all.length?'No exports match these filters':'No saved exports yet',all.length?'Reset the history filters to view all drafts.':'Generate a society draft to save its original data snapshot.')}</section>`;
  }

  function downloadCSV() {
    const cues=selectedRows();if(!cues.length){ctx.toast('Select at least one cue for the report.');return;}
    const s=data(),es=ctx.exportState(),headers=['Cue ID','Project','Client','Content','Work ID','Song title','ISRC','IPRS ID','PRS ID','ASCAP ID','IN','OUT','Plays','Occurrence times','Total duration','Usage','Source','Notes'];
    const rows=cues.map(c=>{const p=s.projects.find(p=>p.id===c.projectId),w=s.works.find(w=>w.id===c.workId),multi=c.occurrences?.length>1;return [c.id,p?.title||'',clientName(p?.clientId),c.episode==null?'Movie':'Episode '+c.episode,c.workId,w?.title||'',w?.isrc||'',w?.societies?.IPRS||'',w?.societies?.PRS||'',w?.societies?.ASCAP||'',multi?'Multiple plays':D.time(c.start),multi?'Multiple plays':D.time(c.end),c.occurrences?.length||Number(c.usageCount)||1,c.occurrences?.length?c.occurrences.map(use=>D.time(use.start)+'–'+D.time(use.end)).join('; '):D.time(c.start)+'–'+D.time(c.end),D.time(c.duration),c.usage,c.source,c.notes];});
    const cell=value=>{let text=String(value??'');if(/^[\s]*[=+\-@]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};
    ctx.download('\ufeff'+[headers,...rows].map(row=>row.map(cell).join(',')).join('\r\n'),'Cue_report_'+(csvScope==='workspace'?'workspace':String(es.project).replace(/[^a-z0-9_-]/gi,'_'))+'_'+new Date().toISOString().slice(0,10)+'.csv','text/csv;charset=utf-8');
    ctx.toast(cues.length+' cue records downloaded.');
  }

  function click(event) {
    const el=event.target.closest('button,a');if(!el)return false;const d=el.dataset;
    if(d.dxCategory!==undefined){category=d.dxCategory;ctx.render();return true;}
    if(d.dxSearchPage!==undefined){
      const page=Number(d.dxSearchPage);
      if(!el.disabled&&Number.isInteger(page)&&page>0){
        searchPage=page;ctx.render();
        const heading=document.getElementById('dx-results-heading');
        heading?.focus({preventScroll:true});heading?.scrollIntoView({block:'start',behavior:'auto'});
      }
      return true;
    }
    if(d.dxDetail!==undefined){detail(d.dxDetail);return true;}
    if(d.dxFormat){format=d.dxFormat;selection=null;previewQuery='';previewUsage=previewSource='all';ctx.render();return true;}
    if(d.dxEpisode){ctx.UI().openProject(d.dxEpisode);const target=document.querySelector(`[data-am-episode="${CSS.escape(String(d.number))}"]`);target?.click();return true;}
    if(d.dxRange){ctx.openExport(data().projects.find(p=>p.id===d.dxRange),undefined,{allowEpisodeSelection:true});return true;}
    if(d.action==='generate-export'&&el.closest('.dx-page')){
      if(busy)return true;busy=true;ctx.render();window.setTimeout(async()=>{try{await ctx.generateExport();}catch(err){ctx.toast('Export could not be generated: '+(err.message||'unknown error'));}finally{busy=false;ctx.render();}},30);return true;
    }
    if(!d.dx)return false;
    if(d.dx==='clear-search'){ctx.setQuery('');category=searchProject=searchStatus='all';searchSort='title';searchPage=1;}
    if(d.dx==='clear-preview'){previewQuery='';previewUsage=previewSource='all';selection=null;}
    if(d.dx==='clear-history'){historyQuery='';historyProject=historySociety=historyStatus='all';historySort='newest';}
    if(d.dx==='select-cues')selection=null;
    if(d.dx==='deselect-cues')selection=new Set();
    if(d.dx==='download-csv'){downloadCSV();return true;}
    ctx.render();return true;
  }

  function change(event) {
    const el=event.target,d=el.dataset;
    if(d.societyChoice!==undefined){ctx.setExportState({society:el.value});selection=null;previewQuery='';previewUsage=previewSource='all';ctx.render();return true;}
    if(d.dxSelectCue!==undefined){if(selection===null)selection=new Set(previewRows().map(c=>c.id));if(el.checked)selection.add(d.dxSelectCue);else selection.delete(d.dxSelectCue);ctx.render();return true;}
    if(['export-project','export-episode','export-society'].includes(el.id)){selection=null;previewQuery='';previewUsage=previewSource='all';return false;}
    if(!d.dxFilter)return false;
    const val=el.value;
    if(el.id==='dx-search-project')searchProject=val;
    if(el.id==='dx-search-status')searchStatus=val;
    if(el.id==='dx-search-sort')searchSort=val;
    if(el.id==='dx-csv-scope'){csvScope=val;selection=null;previewQuery='';previewUsage=previewSource='all';}
    if(el.id==='dx-preview-usage'){previewUsage=val;selection=null;}
    if(el.id==='dx-preview-source'){previewSource=val;selection=null;}
    if(el.id==='dx-history-project')historyProject=val;
    if(el.id==='dx-history-society')historySociety=val;
    if(el.id==='dx-history-status')historyStatus=val;
    if(el.id==='dx-history-sort')historySort=val;
    ctx.render();return true;
  }

  function submit(event) {
    const form=event.target;if(!['dx-search-form','dx-preview-search','dx-history-search'].includes(form.id))return false;
    event.preventDefault();const value=String(new FormData(form).get('q')||'').trim();
    if(form.id==='dx-search-form')ctx.setQuery(value);
    if(form.id==='dx-preview-search'){previewQuery=value;selection=null;}
    if(form.id==='dx-history-search')historyQuery=value;
    ctx.render();return true;
  }
  return {search,exports:exportsView,click,change,submit,isBusy:()=>busy};
};

/* cue-resizer.js */
(function () {
  'use strict';
  const storageKey = 'cue-rights.workspace.cue-width.v2';
  let dispose = null;

  window.initModernCueResizer = function () {
    if (dispose) dispose();
    const workspace = document.querySelector('.cr-builder-modern .cr-workspace');
    const handle = document.querySelector('#cr-resizer');
    if (!workspace || !handle) return;

    let preferred = 22, dragging = false, pointerId = null, dragStart = 22;
    let previousCursor = '';
    try {
      const stored = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(stored) && stored >= 10 && stored <= 80) preferred = stored;
    } catch (_) { /* Resizing remains available when storage is disabled. */ }

    const isSplit = () => getComputedStyle(handle).display !== 'none';
    const bounds = () => {
      const width = Math.max(workspace.getBoundingClientRect().width, 1);
      const min = Math.max(18, 230 / width * 100);
      return {min, max:Math.max(min, Math.min(42, (width - 520) / width * 100))};
    };
    const clamp = value => {
      const {min,max} = bounds();
      return Math.max(min, Math.min(max, value));
    };
    const apply = value => {
      if (!isSplit()) { handle.setAttribute('tabindex', '-1'); return; }
      handle.setAttribute('tabindex', '0');
      const {min,max} = bounds(), next = clamp(value);
      workspace.style.setProperty('--cues-panel-width', next.toFixed(2) + '%');
      handle.setAttribute('aria-valuemin', String(Math.round(min)));
      handle.setAttribute('aria-valuemax', String(Math.round(max)));
      handle.setAttribute('aria-valuenow', String(Math.round(next)));
      handle.setAttribute('aria-valuetext', Math.round(next) + ' percent music cues, ' + Math.round(100-next) + ' percent selected cue');
      return next;
    };
    const persist = () => { try { localStorage.setItem(storageKey, preferred.toFixed(2)); } catch (_) {} };
    const finish = event => {
      if (!dragging || (event && event.pointerId != null && event.pointerId !== pointerId)) return;
      dragging = false;
      workspace.classList.remove('is-resizing');
      document.body.style.cursor = previousCursor;
      if (pointerId != null && handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      pointerId = null;
      persist();
    };
    const down = event => {
      if (!isSplit() || event.button !== 0) return;
      event.preventDefault();
      dragging = true;
      dragStart = preferred;
      pointerId = event.pointerId;
      previousCursor = document.body.style.cursor;
      document.body.style.cursor = 'col-resize';
      workspace.classList.add('is-resizing');
      handle.focus({preventScroll:true});
      handle.setPointerCapture(pointerId);
    };
    const move = event => {
      if (!dragging || event.pointerId !== pointerId) return;
      const rect = workspace.getBoundingClientRect();
      preferred = apply((event.clientX - rect.left - 6) / rect.width * 100);
    };
    const key = event => {
      if (!isSplit()) return;
      if (event.key === 'Escape' && dragging) {
        preferred = dragStart; apply(preferred); finish(); event.preventDefault(); return;
      }
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const {min,max} = bounds(), step = event.shiftKey ? 5 : 2;
      preferred = apply(event.key === 'Home' ? min : event.key === 'End' ? max : clamp(preferred) + (event.key === 'ArrowLeft' ? -step : step));
      persist();
    };
    const reset = () => { preferred = 22; apply(preferred); persist(); };
    handle.addEventListener('pointerdown', down);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', finish);
    handle.addEventListener('keydown', key);
    handle.addEventListener('dblclick', reset);
    const observer = new ResizeObserver(() => {
      if (!workspace.isConnected) { observer.disconnect(); finish(); return; }
      apply(preferred);
    });
    observer.observe(workspace);
    apply(preferred);
    dispose = () => {
      finish(); observer.disconnect();
      handle.removeEventListener('pointerdown', down);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      handle.removeEventListener('lostpointercapture', finish);
      handle.removeEventListener('keydown', key);
      handle.removeEventListener('dblclick', reset);
      dispose = null;
    };
  };
})();

/* persistence.js */
/* Local durability first, with revision-checked SQLite synchronization. */
(function (global) {
  'use strict';

  const DEFAULT_KEY = 'cue-rights-local-sqlite-v1';
  const requiredLists = ['works', 'projects', 'cues', 'clients', 'imports', 'exports', 'profiles', 'activity'];
  const MAX_JSON_BYTES = 12 * 1024 * 1024, MAX_LOCAL_JSON_BYTES = 64 * 1024 * 1024, MAX_ONLINE_BYTES = 4 * 1024 * 1024;
  async function prepareRequest(body, {online = false} = {}) {
    const raw = JSON.stringify(body), bytes = new TextEncoder().encode(raw);
    const rejectSize = message => { throw Object.assign(new Error(message), {status: 413}); };
    const limit = online ? MAX_JSON_BYTES : MAX_LOCAL_JSON_BYTES;
    if (bytes.byteLength > limit) rejectSize(`The workspace request exceeds the ${limit / 1024 / 1024} MB saving limit. Download a backup before reducing its size.`);
    let content = raw, headers = {'Content-Type': 'application/json'};
    if (online && bytes.byteLength > 1024 * 1024 && global.CompressionStream) {
      const stream = new Blob([bytes]).stream().pipeThrough(new global.CompressionStream('gzip'));
      const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
      if (compressed.byteLength < bytes.byteLength) {
        content = compressed;
        // A binary body prevents the host's JSON parser from consuming gzip.
        headers = {'Content-Type': 'application/octet-stream', 'X-Workspace-Encoding': 'gzip'};
      }
    }
    const wireBytes = typeof content === 'string' ? bytes.byteLength : content.byteLength;
    if (online && wireBytes > MAX_ONLINE_BYTES) rejectSize(global.CompressionStream
      ? 'The compressed workspace exceeds the online upload limit. Download a backup before reducing its size.'
      : 'This browser cannot compress a large workspace for online saving. Update your browser or download a backup.');
    return {headers, body: content};
  }
  const validWorkspace = value => !!value && value.version === 1 && requiredLists.every(key =>
    Array.isArray(value[key]) && value[key].every(item => item && typeof item === 'object' && !Array.isArray(item)));
  const clone = value => JSON.parse(JSON.stringify(value));
  const CACHE_PREFIX = 'AMISHNA-LZW2:', OLD_CACHE_PREFIX = 'AMISHNA-LZW1:';
  // localStorage has a much smaller quota than the workspace API. Keep the
  // synchronous save contract, but store large device copies in a compact form.
  // The in-memory and downloaded workspace remain ordinary JSON.
  function encodeCache(raw) {
    if (raw.length < 64 * 1024) return raw;
    const bytes = new TextEncoder().encode(raw), dictionary = new Map();
    let nextCode = 257, word = bytes[0], packed = 0, bits = 0, codeCount = 0;
    const chunks = [], units = [];
    const emit = code => {
      packed |= code << bits;
      bits += 16;
      while (bits >= 15) {
        units.push(String.fromCharCode((packed & 32767) + 32));
        packed >>>= 15;
        bits -= 15;
        if (units.length === 8192) { chunks.push(units.join('')); units.length = 0; }
      }
      codeCount++;
    };
    for (let index = 1; index < bytes.length; index++) {
      const byte = bytes[index], pair = word * 256 + byte, found = dictionary.get(pair);
      if (found !== undefined) word = found;
      else {
        emit(word);
        if (nextCode < 65536) dictionary.set(pair, nextCode++);
        else { emit(256); dictionary.clear(); nextCode = 257; }
        word = byte;
      }
    }
    emit(word);
    if (bits) units.push(String.fromCharCode((packed & 32767) + 32));
    chunks.push(units.join(''));
    const compact = CACHE_PREFIX + bytes.length + ':' + codeCount + ':' + chunks.join('');
    return compact.length < raw.length ? compact : raw;
  }
  function decodeCache(stored) {
    const resettable = stored?.startsWith(CACHE_PREFIX);
    const prefix = resettable ? CACHE_PREFIX : stored?.startsWith(OLD_CACHE_PREFIX) ? OLD_CACHE_PREFIX : null;
    if (!prefix) return stored;
    const lengthEnd = stored.indexOf(':', prefix.length), countEnd = stored.indexOf(':', lengthEnd + 1);
    const lengthText = stored.slice(prefix.length, lengthEnd), countText = stored.slice(lengthEnd + 1, countEnd);
    const byteLength = Number(lengthText), codeCount = Number(countText);
    if (lengthEnd < 0 || countEnd < 0 || !/^\d+$/.test(lengthText) || !/^\d+$/.test(countText) ||
      !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_LOCAL_JSON_BYTES ||
      !Number.isSafeInteger(codeCount) || codeCount < 1 || codeCount > byteLength)
      throw new Error('Invalid device workspace cache');
    const output = new Uint8Array(byteLength), prefixes = new Uint16Array(65536), suffixes = new Uint8Array(65536), stack = new Uint8Array(65536);
    let nextCode = resettable ? 257 : 256, previous = -1, offset = 0, seen = 0, packed = 0, bits = 0;
    const expand = code => {
      let depth = 0;
      while (code >= (resettable ? 257 : 256)) {
        if (code >= nextCode || depth === stack.length) throw new Error('Invalid device workspace cache');
        stack[depth++] = suffixes[code];
        code = prefixes[code];
      }
      if (code === 256) throw new Error('Invalid device workspace cache');
      if (offset + depth + 1 > output.length) throw new Error('Invalid device workspace cache');
      const first = code;
      output[offset++] = first;
      while (depth) output[offset++] = stack[--depth];
      return first;
    };
    const accept = code => {
      if (resettable && code === 256) { nextCode = 257; previous = -1; seen++; return; }
      if (previous < 0 && code >= 256 || code > nextCode || code === nextCode && nextCode === 65536)
        throw new Error('Invalid device workspace cache');
      const first = code === nextCode ? expand(previous) : expand(code);
      if (code === nextCode) {
        if (offset >= output.length) throw new Error('Invalid device workspace cache');
        output[offset++] = first;
      }
      if (previous >= 0 && nextCode < 65536) {
        prefixes[nextCode] = previous;
        suffixes[nextCode++] = first;
      }
      previous = code;
      seen++;
    };
    for (let index = countEnd + 1; index < stored.length; index++) {
      const unit = stored.charCodeAt(index) - 32;
      if (unit < 0 || unit > 32767) throw new Error('Invalid device workspace cache');
      packed |= unit << bits;
      bits += 15;
      if (bits >= 16) {
        if (seen >= codeCount) throw new Error('Invalid device workspace cache');
        accept(packed & 65535);
        packed >>>= 16;
        bits -= 16;
      }
    }
    if (seen !== codeCount || offset !== byteLength) throw new Error('Invalid device workspace cache');
    return new TextDecoder('utf-8', {fatal: true}).decode(output);
  }
  const canonical = value => {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return JSON.stringify(value);
  };
  // Keep matching records in place while sending only inserted, removed or
  // edited values. Episode numbers identify records inside a project.
  function changesBetween(before, after) {
    const changes = [];
    const sameItem = (left, right) => {
      if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
        if (typeof left.id === 'string' && typeof right.id === 'string') return left.id === right.id;
        if (Number.isInteger(left.number) && Number.isInteger(right.number)) return left.number === right.number;
      }
      return canonical(left) === canonical(right);
    };
    const walk = (left, right, path) => {
      if (Array.isArray(left) && Array.isArray(right)) {
        let prefix = 0;
        while (prefix < left.length && prefix < right.length && sameItem(left[prefix], right[prefix])) {
          walk(left[prefix], right[prefix], [...path, prefix]);
          prefix++;
        }
        let suffix = 0;
        while (suffix < left.length - prefix && suffix < right.length - prefix &&
          sameItem(left[left.length - 1 - suffix], right[right.length - 1 - suffix])) suffix++;
        const oldEnd = left.length - suffix, newEnd = right.length - suffix;
        if (oldEnd !== prefix || newEnd !== prefix) changes.push({op: 'splice', path, index: prefix,
          deleteCount: oldEnd - prefix, items: right.slice(prefix, newEnd)});
        for (let index = 0; index < suffix; index++) walk(left[oldEnd + index], right[newEnd + index], [...path, newEnd + index]);
      } else if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
        for (const key of Object.keys(left)) if (!Object.hasOwn(right, key)) changes.push({op: 'remove', path: [...path, key]});
        for (const key of Object.keys(right)) {
          if (!Object.hasOwn(left, key)) changes.push({op: 'set', path: [...path, key], value: right[key]});
          else walk(left[key], right[key], [...path, key]);
        }
      } else if (canonical(left) !== canonical(right)) changes.push({op: 'set', path, value: right});
    };
    walk(before, after, []);
    return changes;
  }
  // This detects accidental cache edits; it is not used as a security boundary.
  function fingerprint(value) {
    const text = canonical(value);
    let first = 2166136261, second = 5381;
    for (let i = 0; i < text.length; i++) {
      first = Math.imul(first ^ text.charCodeAt(i), 16777619);
      second = Math.imul(second, 33) ^ text.charCodeAt(i);
    }
    return text.length + ':' + (first >>> 0).toString(16) + ':' + (second >>> 0).toString(16);
  }

  function create(options = {}) {
    const key = options.key || DEFAULT_KEY;
    const metaKey = key + ':sync';
    const backupsKey = key + ':backups';
    const endpoint = options.endpoint || '/api/workspace';
    const fetcher = options.fetch || (global.fetch && global.fetch.bind(global));
    const debounceMs = options.debounceMs ?? 300;
    const retryMs = options.retryMs ?? 5000;
    const pollMs = options.pollMs ?? 15000;
    const fileMode = (options.protocol || global.location?.protocol) === 'file:';
    const onlineMode = !['', 'localhost', '127.0.0.1', '[::1]'].includes(global.location?.hostname || '');
    const timeoutMs = options.timeoutMs ?? (onlineMode ? 15000 : 30000);
    let storage;
    try { storage = options.storage || global.localStorage; } catch (_) { /* Report below. */ }
    let meta = null, currentRaw = null, generation = 0, baseWorkspace = null;
    let loaded = false, destroyed = false, needsReconcile = true, conflict = false;
    let localBlocked = false, recoveryRaw = null, latestBackup = null, externalChange = false;
    let timer = null, retryTimer = null, pollTimer = null, running = null, root = null;
    let checking = false, resolving = false, draft = false, serverReachable = null;
    let status = {kind: 'loading', message: 'Opening your workspace…', pending: false};
    const listeners = new Set();
    const presentedStatus = () => ({...status, draft, serverReachable, databaseMessage: status.message,
      message: draft && status.kind !== 'loading' ? 'Unsaved form changes — save the form to sync. ' + status.message : status.message});
    const notifyStatus = () => listeners.forEach(listener => { try { listener(presentedStatus()); } catch (_) { /* A view must not interrupt saving. */ } });
    const freshMeta = () => ({version: 1, baseRevision: 0, pending: true, syncedFingerprint: null});
    const setStatus = (kind, message, extra = {}) => {
      status = {kind, message, pending: !!meta?.pending, revision: meta?.baseRevision ?? 0, ...extra};
      render();
      notifyStatus();
    };
    const localError = (message = 'Device storage is full or unavailable. Your last change was not saved.') => setStatus('local-error', message);
    const offline = error => {
      const message = fileMode ? 'Saved on this device · Open the local dashboard at http://127.0.0.1:4175 to connect to SQLite. Download this device copy before switching.'
        : 'Saved on this device · ' + (error?.message || 'Cannot reach the server. Check your connection and retry.');
      setStatus('offline', message);
      scheduleRetry();
    };
    const synced = updatedAt => {
      const date = updatedAt ? new Date(updatedAt) : null;
      const time = date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '';
      setStatus('synced', 'Saved to local database' + (time ? ' at ' + time : '') + (meta?.baseRevision ? ' · Revision ' + meta.baseRevision : ''), {updatedAt});
    };
    const showConflict = () => {
      conflict = true;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      setStatus('conflict', externalChange ? 'Another tab changed this workspace. Download this tab’s copy or load the database copy to continue.' : 'This device and the database have different changes. Both copies are preserved.');
    };
    const showUpdate = remote => {
      conflict = true;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      setStatus('update-available', 'The local database has newer changes. Load the database copy when your current form is finished.', {remoteRevision: remote.revision});
    };
    const getState = () => currentRaw ? JSON.parse(currentRaw) : null;

    function writeMeta(next) {
      storage.setItem(metaKey, JSON.stringify(next));
      meta = next;
    }

    // A pending marker always reaches storage before workspace data does. If the
    // data write fails, callers can roll back their in-memory mutation as before.
    function writeLocal(raw, nextMeta) {
      let oldMeta, oldRaw, wroteData = false;
      try {
        oldMeta = storage.getItem(metaKey);
        oldRaw = storage.getItem(key);
        storage.setItem(metaKey, JSON.stringify({...nextMeta, pending: true}));
        storage.setItem(key, encodeCache(raw));
        wroteData = true;
        if (!nextMeta.pending) storage.setItem(metaKey, JSON.stringify(nextMeta));
        currentRaw = raw;
        meta = {...nextMeta};
        return true;
      } catch (error) {
        try {
          if (wroteData) {
            if (oldRaw === null) storage.removeItem(key);
            else storage.setItem(key, oldRaw);
          }
          if (oldMeta === null) storage.removeItem(metaKey);
          else if (oldMeta !== undefined) storage.setItem(metaKey, oldMeta);
        } catch (_) { /* A leftover pending marker is conservative and safe. */ }
        localError(error?.name === 'QuotaExceededError'
          ? 'Browser storage is full. Download a backup, free space, then import a smaller batch.'
          : error?.name === 'SecurityError'
            ? 'Browser storage is blocked. Allow site storage in your browser settings and retry.'
            : 'Device storage is full or unavailable. Your last change was not saved.');
        return false;
      }
    }

    function preserveBackup(raw, source = 'device') {
      try {
        const previous = storage.getItem(backupsKey);
        const backups = previous ? JSON.parse(previous) : [];
        if (!Array.isArray(backups)) throw new Error('Invalid backup list');
        const entry = {createdAt: new Date().toISOString(), source, raw};
        backups.push(entry);
        storage.setItem(backupsKey, JSON.stringify(backups));
        latestBackup = entry;
        return true;
      } catch (_) {
        localError('A recovery copy could not be saved. Download your device copy before freeing browser storage.');
        return false;
      }
    }

    async function request(method, body) {
      if (!fetcher) throw new Error('The database cannot be reached');
      const prepared = body ? await prepareRequest(body, {online: onlineMode}) : null;
      const controller = new AbortController();
      let responded = false;
      let timeout;
      const timedOut = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('The database request timed out'));
        }, timeoutMs);
      });
      try {
        const response = await Promise.race([
          fetcher(endpoint, {
            method, cache: 'no-store', signal: controller.signal,
            headers: {'Accept': 'application/json', ...prepared?.headers},
            ...(prepared ? {body: prepared.body} : {})
          }).then(async response => ({ok: response.ok, status: response.status, payload: await response.json().catch(() => null)})),
          timedOut
        ]);
        responded = true;
        serverReachable = true;
        if (!response.ok) {
          if (response.status === 401 && global.Event) global.dispatchEvent?.(new global.Event('amishna-auth-expired'));
          const error = new Error(response.payload?.error?.message || (response.status === 413 && onlineMode
            ? 'The online upload limit was exceeded. Download a backup before reducing the workspace size.'
            : 'Database request failed (HTTP ' + response.status + ')'));
          error.status = response.status;
          throw error;
        }
        const payload = response.payload;
        if (!payload || !Number.isSafeInteger(payload.revision) || payload.revision < 0) throw new Error('Invalid database response');
        if (method === 'GET' && payload.workspace !== null && !validWorkspace(payload.workspace)) throw new Error('Invalid database workspace');
        return payload;
      } catch (error) {
        if (!responded) serverReachable = false;
        throw error;
      } finally { clearTimeout(timeout); }
    }

    function scheduleRetry() {
      clearTimeout(retryTimer);
      if (!destroyed && !conflict && !localBlocked && !fileMode && retryMs > 0) retryTimer = setTimeout(() => retry(), retryMs);
    }

    function schedule() {
      clearTimeout(timer);
      if (!destroyed && !conflict && !localBlocked) timer = setTimeout(() => sync(), debounceMs);
    }

    // Called before migration or after any uncertain network outcome. An equal
    // database copy also acknowledges a PUT whose response was lost.
    function reconcile(remote, notifyReplace) {
      const local = getState();
      if (remote.workspace === null) {
        if (meta?.baseRevision > 0) { showConflict(); return false; }
        meta = {...(meta || freshMeta()), baseRevision: remote.revision, pending: true};
        if (!writeLocal(currentRaw, meta)) return false;
        conflict = false;
        needsReconcile = false;
        baseWorkspace = null;
        return true;
      }
      const remoteFingerprint = fingerprint(remote.workspace);
      if (canonical(local) === canonical(remote.workspace)) {
        try {
          writeMeta({version: 1, baseRevision: remote.revision, pending: false, syncedFingerprint: remoteFingerprint});
          conflict = false;
          needsReconcile = false;
          baseWorkspace = remote.workspace;
          synced(remote.updatedAt);
          return true;
        } catch (_) { localError(); return false; }
      }
      const clean = meta && !meta.pending && meta.syncedFingerprint === fingerprint(local);
      if (clean) {
        // An open page can contain unsaved form edits outside this workspace.
        // Announce remote updates; only an explicit user action may replace it.
        if (notifyReplace) { showUpdate(remote); return false; }
        const nextMeta = {version: 1, baseRevision: remote.revision, pending: false, syncedFingerprint: remoteFingerprint};
        if (!writeLocal(JSON.stringify(remote.workspace), nextMeta)) return false;
        generation++;
        conflict = false;
        needsReconcile = false;
        baseWorkspace = remote.workspace;
        synced(remote.updatedAt);
        if (notifyReplace) options.onReplace?.(clone(remote.workspace));
        return true;
      }
      if (meta?.pending && meta.baseRevision === remote.revision && meta.syncedFingerprint === remoteFingerprint) {
        conflict = false;
        needsReconcile = false;
        baseWorkspace = remote.workspace;
        return true;
      }
      showConflict();
      return false;
    }

    async function load(seedFactory) {
      if (loaded) return getState();
      let local = null, hadLocal = false;
      try {
        // A requested workspace reset also invalidates device copies and
        // recovery backups once; subsequent work survives normal reloads.
        const resetKey = key + ':reset-id';
        if (options.resetId && storage.getItem(resetKey) !== options.resetId) {
          storage.removeItem(key);
          storage.removeItem(metaKey);
          storage.removeItem(backupsKey);
          storage.setItem(resetKey, options.resetId);
        }
        const raw = storage.getItem(key);
        if (raw !== null) {
          try {
            local = JSON.parse(decodeCache(raw));
            if (!validWorkspace(local)) throw new Error('Invalid workspace');
            hadLocal = true;
          } catch (_) {
            recoveryRaw = raw;
            local = null;
            if (!preserveBackup(raw)) localBlocked = true;
            else recoveryRaw = null;
          }
        }
        const rawMeta = storage.getItem(metaKey);
        if (rawMeta && hadLocal) {
          try {
            const parsed = JSON.parse(rawMeta);
            if (parsed.version === 1 && Number.isInteger(parsed.baseRevision) && parsed.baseRevision >= 0 && typeof parsed.pending === 'boolean') meta = parsed;
          } catch (_) { /* Unrecognized metadata is treated as an unmigrated copy. */ }
        }
        const backups = JSON.parse(storage.getItem(backupsKey) || '[]');
        if (Array.isArray(backups)) latestBackup = backups.at(-1) || null;
      } catch (_) { localBlocked = true; }
      currentRaw = JSON.stringify(local || seedFactory());
      if (meta && !meta.pending && meta.syncedFingerprint !== fingerprint(getState())) meta = {...meta, pending: true};

      try {
        const remote = await request('GET');
        if (destroyed) return getState();
        if (!hadLocal && remote.workspace !== null && !localBlocked) {
          const nextMeta = {version: 1, baseRevision: remote.revision, pending: false, syncedFingerprint: fingerprint(remote.workspace)};
          if (writeLocal(JSON.stringify(remote.workspace), nextMeta)) {
            needsReconcile = false;
            baseWorkspace = remote.workspace;
            synced(remote.updatedAt);
          } else {
            // Opening an existing database remains possible when caching fails;
            // synchronous edits will still fail until device storage is fixed.
            currentRaw = JSON.stringify(remote.workspace);
            localBlocked = true;
          }
        } else if (!localBlocked) {
          if (!meta && remote.workspace === null) meta = freshMeta();
          reconcile(remote, false);
        }
      } catch (error) {
        if (!localBlocked) {
          const pendingMeta = meta || freshMeta();
          if (writeLocal(currentRaw, pendingMeta)) offline(error);
          else localBlocked = true;
        }
      }
      loaded = true;
      schedulePoll();
      if (localBlocked) localError('Device storage is unavailable. Download a backup before closing; changes cannot be saved yet.');
      else if (!conflict && meta?.pending && !needsReconcile) {
        setStatus('pending', 'Saved on this device · Updating database…');
        schedule();
      }
      return getState();
    }

    function save(workspace) {
      if (destroyed || !loaded || localBlocked) { localError(); return false; }
      if (externalChange) { showConflict(); return false; }
      let raw;
      try {
        if (!validWorkspace(workspace)) throw new Error('Invalid workspace');
        raw = JSON.stringify(workspace);
      } catch (_) { localError('This change could not be saved. Download your current data before closing.'); return false; }
      if (!writeLocal(raw, {...(meta || freshMeta()), pending: true})) return false;
      generation++;
      if (conflict) showConflict();
      else {
        if (status.kind !== 'offline') setStatus('pending', 'Saved on this device · Updating database…');
        schedule();
      }
      return true;
    }

    function sync() {
      if (destroyed || !loaded || conflict || localBlocked || resolving) return Promise.resolve(false);
      if (running) return running;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      running = (async () => {
        try {
          if (needsReconcile) {
            const remote = await request('GET');
            if (destroyed || !reconcile(remote, true)) return false;
          }
          while (meta?.pending && !conflict && !destroyed) {
            const raw = currentRaw;
            const sentGeneration = generation;
            const expectedRevision = meta.baseRevision;
            setStatus('syncing', 'Saved on this device · Updating database…');
            const workspace = JSON.parse(raw);
            const changes = baseWorkspace === null ? null : changesBetween(baseWorkspace, workspace);
            if (changes && !changes.length) {
              try { writeMeta({version: 1, baseRevision: expectedRevision, pending: sentGeneration !== generation || currentRaw !== raw,
                syncedFingerprint: fingerprint(workspace)}); }
              catch (_) { localError(); return false; }
              if (!meta.pending) synced();
              continue;
            }
            const result = changes === null
              ? await request('PUT', {workspace, expectedRevision})
              : await request('PATCH', {changes, expectedRevision});
            if (destroyed) return false;
            if (externalChange) { needsReconcile = true; showConflict(); return false; }
            if (result.revision <= expectedRevision) throw new Error('Invalid saved revision');
            const nextMeta = {version: 1, baseRevision: result.revision,
              pending: sentGeneration !== generation || currentRaw !== raw,
              syncedFingerprint: fingerprint(JSON.parse(raw))};
            // A later edit remains pending even when an older request succeeds.
            try { writeMeta(nextMeta); }
            catch (_) { meta = nextMeta; needsReconcile = true; localError('Changes reached the database, but the device sync record could not be saved.'); return false; }
            baseWorkspace = workspace;
            if (!meta.pending) synced(result.updatedAt);
          }
          return true;
        } catch (error) {
          needsReconcile = true;
          if (destroyed) return false;
          if (error.status === 409) showConflict();
          else if (error.status === 400 || error.status === 413 || error.status === 422) {
            setStatus('error', 'Saved on this device · Sync rejected: ' + error.message);
          } else offline(error);
          return false;
        } finally { running = null; }
      })();
      return running;
    }

    function retry() {
      if (destroyed || !loaded) return Promise.resolve(false);
      if (resolving) return Promise.resolve(false);
      if (externalChange) { showConflict(); return Promise.resolve(false); }
      if (localBlocked) {
        // Never overwrite an unrecovered original browser value on retry.
        if (recoveryRaw && !preserveBackup(recoveryRaw)) return Promise.resolve(false);
        localBlocked = false;
        if (!writeLocal(currentRaw, meta || freshMeta())) { localBlocked = true; return Promise.resolve(false); }
      }
      conflict = false;
      needsReconcile = true;
      setStatus('pending', 'Saved on this device · Connecting to database…');
      return sync();
    }

    function schedulePoll() {
      clearTimeout(pollTimer);
      if (!destroyed && pollMs > 0 && !fileMode) {
        pollTimer = setTimeout(async () => { await checkForUpdates(); schedulePoll(); }, pollMs);
      }
    }

    async function checkForUpdates() {
      if (destroyed || !loaded || running || checking || resolving || localBlocked || conflict || meta?.pending) return false;
      checking = true;
      const startGeneration = generation;
      try {
        const remote = await request('GET');
        if (destroyed || generation !== startGeneration || running || resolving || meta?.pending || externalChange) return false;
        if (remote.workspace === null) {
          if (meta?.baseRevision > 0) showConflict();
          return false;
        }
        if (canonical(remote.workspace) !== canonical(getState())) { showUpdate(remote); return false; }
        return reconcile(remote, false);
      } catch (error) { if (!destroyed) offline(error); return false; }
      finally { checking = false; }
    }

    // This is only invoked by the explicit "Save device copy" action. Both
    // originals are archived before a compare-and-swap write can begin.
    async function useDevice() {
      if (running || resolving || destroyed || !loaded || localBlocked || !conflict) return false;
      resolving = true;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      const startGeneration = generation;
      try {
        const remote = await request('GET');
        if (destroyed) return false;
        if (startGeneration !== generation) { showConflict(); return false; }
        if (!preserveBackup(currentRaw)) return false;
        const sharedRaw = storage.getItem(key);
        if (sharedRaw && sharedRaw !== currentRaw && !preserveBackup(sharedRaw, 'other-tab')) return false;
        if (remote.workspace !== null && !preserveBackup(JSON.stringify(remote.workspace), 'database')) return false;
        const nextMeta = {version: 1, baseRevision: remote.revision, pending: true,
          syncedFingerprint: remote.workspace === null ? null : fingerprint(remote.workspace)};
        if (!writeLocal(currentRaw, nextMeta)) return false;
        baseWorkspace = remote.workspace;
        externalChange = false;
        conflict = false;
        needsReconcile = false;
        setStatus('pending', 'Saved on this device · Updating database…');
      } catch (error) {
        setStatus('conflict', 'Device copy preserved. Could not replace the database: ' + error.message);
        return false;
      } finally { resolving = false; }
      return sync();
    }

    async function useDatabase() {
      if (running || resolving || destroyed || !loaded) return false;
      resolving = true;
      const startGeneration = generation;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      try {
        const remote = await request('GET');
        if (destroyed) return false;
        if (startGeneration !== generation) { showConflict(); return false; }
        if (remote.workspace === null) {
          setStatus('conflict', 'The database has no workspace to load. Your device copy is preserved; retry after reconnecting the original database.');
          return false;
        }
        if (!preserveBackup(currentRaw)) return false;
        const sharedRaw = storage.getItem(key);
        if (sharedRaw && sharedRaw !== currentRaw && !preserveBackup(sharedRaw)) return false;
        const nextMeta = {version: 1, baseRevision: remote.revision, pending: false, syncedFingerprint: fingerprint(remote.workspace)};
        if (!writeLocal(JSON.stringify(remote.workspace), nextMeta)) return false;
        baseWorkspace = remote.workspace;
        localBlocked = false;
        externalChange = false;
        conflict = false;
        needsReconcile = false;
        generation++;
        synced(remote.updatedAt);
        options.onReplace?.(clone(remote.workspace));
        return true;
      } catch (_) {
        // Keep the conflict lock: a failed resolution never authorizes a PUT.
        setStatus('conflict', 'The local database is unavailable. Your device copy is preserved; retry when the database is running.');
        return false;
      } finally { resolving = false; }
    }

    function downloadBackup(previous = false) {
      const raw = previous ? latestBackup?.raw : (recoveryRaw || currentRaw);
      if (!raw) return false;
      if (options.download) { options.download(raw, previous); return true; }
      const blob = new Blob([raw], {type: 'application/json'});
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'cue-workspace-' + (previous ? 'recovery-' : 'backup-') + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    }

    function render() {
      if (!root) return;
      const document = root.ownerDocument;
      const bar = document.createElement('div');
      bar.className = 'storage-status storage-status--' + status.kind;
      const text = document.createElement('div');
      text.className = 'storage-status__message';
      text.setAttribute('role', 'status');
      text.setAttribute('aria-live', 'polite');
      text.textContent = presentedStatus().message;
      bar.append(text);
      const actions = document.createElement('div');
      actions.className = 'storage-status__actions';
      const button = (label, action) => {
        const element = document.createElement('button');
        element.type = 'button';
        element.textContent = label;
        element.addEventListener('click', action);
        actions.append(element);
      };
      if (['offline', 'error', 'local-error', 'conflict'].includes(status.kind)) {
        button('Retry', () => retry());
        button('Download device copy', () => downloadBackup());
      }
      if (['synced', 'pending'].includes(status.kind)) button('Sync now', () => meta?.pending ? sync() : checkForUpdates());
      if (['conflict', 'update-available'].includes(status.kind)) button('Load database copy', () => {
        if (!global.confirm || global.confirm('Load the database workspace? Your current device copy will be saved as a recovery backup first. Unsaved form edits will be discarded.')) useDatabase();
      });
      if (status.kind === 'conflict') button('Save device copy', () => {
        if (!global.confirm || global.confirm('Replace the database workspace with this device copy? Both copies will be saved as recovery backups first. Changes made in another tab are included only if they are already in this copy.')) useDevice();
      });
      if (fileMode && status.kind === 'offline') button('Open local dashboard', () => global.open?.('http://127.0.0.1:4175', '_blank', 'noopener'));
      if (latestBackup) button('Download previous copy', () => downloadBackup(true));
      if (actions.childNodes.length) bar.append(actions);
      root.replaceChildren(bar);
    }

    const onOnline = () => { if (loaded && (status.kind === 'offline' || meta?.pending) && !conflict) retry(); };
    const onFocus = () => { if (loaded) checkForUpdates(); };
    const onStorage = event => {
      if (!loaded || event.key !== key) return;
      let changed = event.newValue !== currentRaw;
      if (changed && event.newValue !== null) {
        try { changed = decodeCache(event.newValue) !== currentRaw; } catch (_) { changed = true; }
      }
      if (changed) {
        // Another tab owns the new cache value. Stop this tab before it can push
        // stale data, retaining its own in-memory copy for backup or comparison.
        externalChange = true;
        showConflict();
        needsReconcile = true;
      }
    };
    global.addEventListener?.('online', onOnline);
    global.addEventListener?.('focus', onFocus);
    global.addEventListener?.('storage', onStorage);
    if (options.statusRoot) { root = options.statusRoot; render(); }

    return {
      load, save, retry, sync, checkForUpdates, useDatabase, useDevice, downloadBackup,
      getStatus: presentedStatus,
      setDraft(value) { if (destroyed || draft === !!value) return; draft = !!value; render(); notifyStatus(); },
      mount(element) { root = element; render(); },
      subscribe(listener) { listeners.add(listener); listener(presentedStatus()); return () => listeners.delete(listener); },
      destroy() {
        destroyed = true;
        clearTimeout(timer);
        clearTimeout(retryTimer);
        clearTimeout(pollTimer);
        listeners.clear();
        global.removeEventListener?.('online', onOnline);
        global.removeEventListener?.('focus', onFocus);
        global.removeEventListener?.('storage', onStorage);
      }
    };
  }

  const api = {create, prepareRequest, changesBetween, encodeCache, decodeCache};
  global.CuePersistence = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

/* catalog.js */
/* Song metadata and the shared artist / rights-holder registry. */
(function (root) {
  'use strict';
  const text=value=>value==null?'':String(value), clean=value=>text(value).trim();
  const key=value=>clean(value).normalize('NFKC').replace(/\s+/g,' ').toLocaleLowerCase();
  const list=value=>Array.isArray(value)?value.map(clean).filter(Boolean):[];
  const unique=items=>[...new Set(items.filter(Boolean))];
  const normalizeRole=(value,fallback='')=>{const role=clean(value)||fallback,normalized=key(role).replace(/[^\p{L}\p{N}]/gu,'');if(normalized==='c')return 'Composer';if(['a','author','authorlyricist','lyricistauthor'].includes(normalized))return 'Lyricist';if(['ca','composerauthor','authorcomposer','composerlyricist','lyricistcomposer'].includes(normalized))return 'Composer / Lyricist';if(normalized==='e')return 'Publisher';if(normalized==='ar')return 'Arranger';if(/^\d+(?:\.\d+)?%?$/.test(role))return fallback;return role;};
  const now=()=>new Date().toISOString();
  const hash=value=>{let n=2166136261;for(const c of value){n^=c.charCodeAt(0);n=Math.imul(n,16777619);}return (n>>>0).toString(16).padStart(8,'0');};
  const stamp=''; // Historic records never acquire an invented creation date.

  const commaNameKey=value=>key(value).replace(/\s*,\s*/g,',');
  function performerNames(value,knownNames,maxParts){
    const source=clean(value);if(!source)return [];
    if(!source.includes(','))return [source];
    if(knownNames.has(commaNameKey(source)))return [knownNames.get(commaNameKey(source))];
    const parts=[];let name='',quoted=false,closed=false,protectedName=false;
    const append=()=>{parts.push({name:clean(name),quoted:protectedName});name='';closed=protectedName=false;};
    for(let i=0;i<source.length;i++){
      const c=source[i];
      if(quoted){
        if(c==='"'){if(source[i+1]==='"'){name+='"';i++;}else{quoted=false;closed=true;}}
        else name+=c;
      }else if(c===',')append();
      else if(closed){if(!/\s/.test(c))return [source];}
      else if(c==='"'&&!clean(name)){quoted=protectedName=true;name='';}
      else name+=c;
    }
    // Ambiguous quoting must not create fragments of a person's name.
    if(quoted)return [source];
    append();const names=[];
    for(let i=0;i<parts.length;){
      if(!parts[i].name){i++;continue;}
      let end=i+1,matched=knownNames.get(commaNameKey(parts[i].name))||parts[i].name,candidate=matched;
      if(!parts[i].quoted)for(let j=i+1;j<Math.min(parts.length,i+maxParts)&&!parts[j].quoted;j++){
        candidate+=', '+parts[j].name;
        const registered=knownNames.get(commaNameKey(candidate));
        if(registered){matched=registered;end=j+1;}
      }
      names.push(matched);i=end;
    }
    return names;
  }

  function ensure(state) {
    if(!state||typeof state!=='object')return false;
    let changed=false;
    if(!Array.isArray(state.artists)){state.artists=[];changed=true;}
    const artists=state.artists,works=Array.isArray(state.works)?state.works:[];
    const usedArtistIds=new Set(artists.map(artist=>artist?.id).filter(Boolean));
    const put=(obj,name,value)=>{if(JSON.stringify(obj[name])!==JSON.stringify(value)){obj[name]=value;changed=true;}};
    for(const artist of artists){
      if(!artist||typeof artist!=='object')continue;
      if(!artist.id){let id='ART-'+hash(key(artist.name)+'|'+key(artist.ipi));while(usedArtistIds.has(id))id+='x';put(artist,'id',id);usedArtistIds.add(id);}
      if(typeof artist.ipi!=='string')put(artist,'ipi',text(artist.ipi));
      for(const field of ['roles','societies','aliases'])if(!Array.isArray(artist[field]))put(artist,field,[]);
      put(artist,'societies',root.CueSocieties.parse(artist.societies));
      const normalizedRoles=unique(list(artist.roles).map(role=>normalizeRole(role)).filter(Boolean));if(JSON.stringify(normalizedRoles)!==JSON.stringify(artist.roles))put(artist,'roles',normalizedRoles);
      if(!artist.entityType&&normalizedRoles.includes('Publisher'))put(artist,'entityType','Organization');
      if(!artist.status)put(artist,'status','Active');
    }
    const artistsById=new Map(),artistsByName=new Map(),artistsByIpi=new Map();
    const addIndex=(index,value,artist)=>{if(!value)return;const list=index.get(value)||[];if(!list.includes(artist))list.push(artist);index.set(value,list);};
    const indexArtist=artist=>{artistsById.set(artist.id,artist);addIndex(artistsByIpi,key(artist.ipi),artist);for(const name of [artist.name,...list(artist.aliases)])addIndex(artistsByName,key(name),artist);};
    artists.forEach(indexArtist);
    // Consider the entire workspace before matching a name without an IPI.
    // Two people sharing a name but having different IPIs remain distinct.
    const identities=new Map();
    function note(name,ipi){const n=key(name),i=key(ipi);if(!n||!i)return;if(!identities.has(n))identities.set(n,new Set());identities.get(n).add(i);}
    artists.forEach(a=>note(a.name,a.ipi));
    works.forEach(w=>(w.parties||[]).forEach(p=>note(p.name,p.ipi)));
    function resolve(name,ipi='',role='',society='') {
      name=clean(name);ipi=clean(ipi);if(!name)return null;
      const n=key(name),i=key(ipi),named=artistsByName.get(n)||[];
      let artist;
      if(i){
        const exact=artistsByIpi.get(i)||[];
        artist=exact.find(a=>key(a.name)===n)|| (exact.length===1?exact[0]:undefined);
        if(!artist&&(identities.get(n)?.size||0)<=1){const blank=named.filter(a=>!clean(a.ipi));if(blank.length===1){artist=blank[0];put(artist,'ipi',ipi);addIndex(artistsByIpi,i,artist);}}
      }else{
        const blank=named.filter(a=>!clean(a.ipi));
        if((identities.get(n)?.size||0)>1)artist=blank.length===1?blank[0]:undefined;
        else if(named.length===1)artist=named[0];
        else if(blank.length===1)artist=blank[0];
      }
      if(!artist){
        let id='ART-'+hash(n+'|'+i),suffix=1;
        while(artistsById.has(id))id='ART-'+hash(n+'|'+i)+'-'+suffix++;
        artist={id,name,ipi,roles:[],societies:[],aliases:[],email:'',phone:'',country:'',website:'',notes:'',status:'Active',entityType:role==='Publisher'?'Organization':'',isni:'',createdAt:stamp,updatedAt:stamp};
        artists.push(artist);indexArtist(artist);changed=true;
      }
      if(key(artist.name)!==n&&!list(artist.aliases).some(a=>key(a)===n)){put(artist,'aliases',[...list(artist.aliases),name]);addIndex(artistsByName,n,artist);}
      if(role&&!list(artist.roles).includes(role))put(artist,'roles',[...list(artist.roles),role]);
      if(society)put(artist,'societies',root.CueSocieties.parse([...list(artist.societies),society]));
      return artist;
    }
    // Process identified rights holders first, so a single unambiguous performer
    // name can share that identity without adding a duplicate record.
    for(const work of works)for(const party of work.parties||[]){
      const fallback=String(party.importSlot||'').startsWith('composer')?'Composer':String(party.importSlot||'').startsWith('author')?'Lyricist':party.importSlot==='publisher'?'Publisher':'';
      const normalizedRole=normalizeRole(party.role,fallback);if(normalizedRole&&normalizedRole!==party.role)put(party,'role',normalizedRole);
      let artist=artistsById.get(party.artistId);
      const nameMatches=artist&&(!clean(party.name)||key(artist.name)===key(party.name)||list(artist.aliases).some(a=>key(a)===key(party.name)));
      const ipiMatches=artist&&(!clean(party.ipi)||key(artist.ipi)===key(party.ipi));
      if(!artist||!nameMatches||!ipiMatches)artist=resolve(party.name,party.ipi,party.role,party.society);
      else{
        if(party.role&&!list(artist.roles).includes(party.role))put(artist,'roles',[...list(artist.roles),party.role]);
        if(party.society)put(artist,'societies',root.CueSocieties.parse([...list(artist.societies),party.society]));
      }
      if(artist)put(party,'artistId',artist.id);
      else if(party.artistId){delete party.artistId;changed=true;}
    }
    const knownNames=new Map();let maxNameParts=1;
    for(const artist of artists)for(const name of [artist.name,...list(artist.aliases)])if(clean(name).includes(',')){
      knownNames.set(commaNameKey(name),clean(name));maxNameParts=Math.max(maxNameParts,text(name).split(',').length);
    }
    for(const work of works){
      // An existing array, including an empty array, is an intentional selection.
      if(!Array.isArray(work.artistIds)){
        const ids=unique(performerNames(work.artist,knownNames,maxNameParts).map(name=>resolve(name,'','Performer')?.id));
        put(work,'artistIds',ids);
      }
      for(const id of work.artistIds){const artist=artistsById.get(id);if(artist&&!list(artist.roles).includes('Performer'))put(artist,'roles',[...list(artist.roles),'Performer']);}
    }
    return changed;
  }

  function linkedWorks(state,id){return (state.works||[]).filter(w=>(w.artistIds||[]).includes(id)||(w.parties||[]).some(p=>p.artistId===id));}
  function applyArtist(state,record,id=''){
    ensure(state);
    const previous=state.artists.find(a=>a.id===id),name=clean(record.name),ipi=clean(record.ipi);
    if(!name)throw new Error('Enter an artist name.');
    if(ipi&&state.artists.some(a=>a.id!==id&&key(a.ipi)===key(ipi)))throw new Error('This IPI already belongs to an artist. Edit that record or leave the IPI blank.');
    if(record.website){try{if(!['http:','https:'].includes(new URL(record.website).protocol))throw 0;}catch{throw new Error('Use an HTTP or HTTPS website URL.');}}
    const timestamp=now(),artist=previous||{id:id||'ART-'+crypto.randomUUID().slice(0,12),createdAt:timestamp};
    const old=previous?structuredClone(previous):null;
    Object.assign(artist,record,{name,ipi,roles:unique(list(record.roles)),societies:root.CueSocieties.parse(record.societies),aliases:unique(list(record.aliases)),updatedAt:timestamp});
    if(!previous)state.artists.push(artist);
    if(old)for(const work of state.works||[]){
      if((work.artistIds||[]).includes(artist.id))work.artist=work.artistIds.map(ref=>state.artists.find(a=>a.id===ref)?.name).filter(Boolean).join(', ');
      for(const party of work.parties||[]){
        if(party.artistId!==artist.id)continue;
        if(key(party.name)===key(old.name))party.name=artist.name;
        if(key(party.ipi)===key(old.ipi))party.ipi=artist.ipi;
        party.society=artist.societies.join('/');
      }
    }
    return artist;
  }

  const clone=value=>value===undefined?undefined:structuredClone(value);
  const blank=value=>value===undefined||value===null||value===''||(Array.isArray(value)&&!value.length);
  const mergeLists=(left,right)=>{const seen=new Set();return [...(left||[]),...(right||[])].filter(value=>{const signature=JSON.stringify(value);if(seen.has(signature))return false;seen.add(signature);return true;});};
  function mergeMissing(target,source,skip=new Set()){
    for(const [name,value] of Object.entries(source||{})){
      if(skip.has(name)||blank(value))continue;
      if(blank(target[name]))target[name]=clone(value);
      else if(Array.isArray(target[name])&&Array.isArray(value))target[name]=mergeLists(target[name],value);
      else if(target[name]&&value&&typeof target[name]==='object'&&typeof value==='object'&&!Array.isArray(target[name])&&!Array.isArray(value))mergeMissing(target[name],value);
    }
    return target;
  }
  function dedupeParties(parties){
    const records=[],byKey=new Map();
    for(const party of parties||[]){
      const item=clone(party),identity=clean(item.artistId)?`id:${key(item.artistId)}`:`name:${key(item.name)}|ipi:${key(item.ipi)}`,signature=[identity,key(item.role),key(item.society),item.share??''].join('|');
      if(byKey.has(signature))mergeMissing(byKey.get(signature),item);else{byKey.set(signature,item);records.push(item);}
    }
    return records;
  }
  function mergeSong(state,sourceId,targetId){
    if(sourceId===targetId)throw new Error('Choose a different song to keep.');
    const source=state.works?.find(work=>work.id===sourceId),target=state.works?.find(work=>work.id===targetId);
    if(!source||!target)throw new Error('The selected song is no longer available.');
    const timestamp=now(),cueCount=(state.cues||[]).filter(cue=>cue.workId===sourceId).length;
    const identifierFields=['isrc','iswc','tuneCode'],conflicts=[];
    for(const field of identifierFields)if(clean(target[field])&&clean(source[field])&&key(target[field])!==key(source[field]))conflicts.push({field,kept:text(target[field]),merged:text(source[field])});
    for(const [society,value] of Object.entries(source.societies||{}))if(clean(target.societies?.[society])&&clean(value)&&key(target.societies[society])!==key(value))conflicts.push({field:society,kept:text(target.societies[society]),merged:text(value)});
    mergeMissing(target,source,new Set(['id','title','alternateTitles','artistIds','parties','societies','activity','mergedFrom','mergeConflicts','createdAt','updatedAt']));
    target.alternateTitles=unique([...list(target.alternateTitles),...list(source.alternateTitles),...(key(source.title)!==key(target.title)?[source.title]:[])]);
    target.artistIds=unique([...(target.artistIds||[]),...(source.artistIds||[])]);
    target.artist=target.artistIds.map(id=>state.artists?.find(artist=>artist.id===id)?.name).filter(Boolean).join(', ')||target.artist||source.artist||'';
    target.parties=dedupeParties([...(target.parties||[]),...(source.parties||[])]);
    target.societies={...(source.societies||{}),...(target.societies||{})};
    for(const [society,value] of Object.entries(source.societies||{}))if(!clean(target.societies[society]))target.societies[society]=value;
    target.activity=mergeLists([{text:`Merged song record · ${source.title}`,date:timestamp},...(target.activity||[])],source.activity||[]);
    target.mergedFrom=mergeLists(target.mergedFrom||[],[...(source.mergedFrom||[]),{id:source.id,title:source.title,mergedAt:timestamp}]);
    if(conflicts.length)target.mergeConflicts=mergeLists(target.mergeConflicts||[],conflicts.map(item=>({...item,sourceId:source.id,mergedAt:timestamp})));
    if(source.needsResolution||target.needsResolution){target.status='Complete';delete target.needsResolution;delete target.resolutionReason;delete target.resolutionKey;delete target.possibleMatchIds;}
    target.updatedAt=timestamp;
    for(const cue of state.cues||[])if(cue.workId===sourceId)cue.workId=targetId;
    for(const deleted of state.deletedCues||[])if(deleted.cue?.workId===sourceId)deleted.cue.workId=targetId;
    state.works=state.works.filter(work=>work.id!==sourceId);
    return {target,source,cueCount,conflicts:conflicts.length};
  }
  function deleteSong(state,id){
    const song=state.works?.find(work=>work.id===id);if(!song)throw new Error('The selected song is no longer available.');
    const cueCount=(state.cues||[]).filter(cue=>cue.workId===id).length,deletedCueCount=(state.deletedCues||[]).filter(item=>item.cue?.workId===id).length;
    state.cues=(state.cues||[]).filter(cue=>cue.workId!==id);
    if(Array.isArray(state.deletedCues))state.deletedCues=state.deletedCues.filter(item=>item.cue?.workId!==id);
    state.works=state.works.filter(work=>work.id!==id);
    return {song,cueCount,deletedCueCount};
  }
  function mergeArtist(state,sourceId,targetId){
    ensure(state);if(sourceId===targetId)throw new Error('Choose a different artist to keep.');
    const source=state.artists?.find(artist=>artist.id===sourceId),target=state.artists?.find(artist=>artist.id===targetId);
    if(!source||!target)throw new Error('The selected artist is no longer available.');
    const timestamp=now(),works=new Set(),credits=[],targetIpi=clean(target.ipi),sourceIpi=clean(source.ipi);
    const alternateIpis=unique([...(target.alternateIpis||[]),...(source.alternateIpis||[]),...(targetIpi&&sourceIpi&&key(sourceIpi)!==key(targetIpi)?[source.ipi]:[])]);
    mergeMissing(target,source,new Set(['id','name','ipi','roles','societies','aliases','activity','mergedFrom','alternateIpis','createdAt','updatedAt']));
    if(!targetIpi&&sourceIpi)target.ipi=source.ipi;
    target.roles=unique([...list(target.roles),...list(source.roles)]);target.societies=unique([...list(target.societies),...list(source.societies)]);
    target.aliases=unique([...list(target.aliases),...list(source.aliases),...(key(source.name)!==key(target.name)?[source.name]:[])]);target.alternateIpis=alternateIpis;
    target.activity=mergeLists([{text:`Merged artist profile · ${source.name}`,date:timestamp},...(target.activity||[])],source.activity||[]);
    target.mergedFrom=mergeLists(target.mergedFrom||[],[...(source.mergedFrom||[]),{id:source.id,name:source.name,mergedAt:timestamp}]);target.updatedAt=timestamp;
    for(const work of state.works||[]){
      let changed=false;
      if((work.artistIds||[]).includes(sourceId)){work.artistIds=unique(work.artistIds.map(id=>id===sourceId?targetId:id));changed=true;}
      for(const party of work.parties||[])if(party.artistId===sourceId){party.artistId=targetId;party.name=target.name;if(clean(target.ipi))party.ipi=target.ipi;changed=true;credits.push(work.id);}
      if(changed){work.parties=dedupeParties(work.parties);work.artist=(work.artistIds||[]).map(id=>state.artists.find(artist=>artist.id===id)?.name).filter(Boolean).join(', ');work.updatedAt=timestamp;works.add(work.id);}
    }
    state.artists=state.artists.filter(artist=>artist.id!==sourceId);
    return {target,source,workCount:works.size,creditCount:credits.length};
  }
  function deleteArtist(state,id){
    ensure(state);const artist=state.artists?.find(item=>item.id===id);if(!artist)throw new Error('The selected artist is no longer available.');
    let workCount=0,creditCount=0;const timestamp=now();
    for(const work of state.works||[]){
      const performerLinked=(work.artistIds||[]).includes(id),before=(work.parties||[]).length;
      if(performerLinked)work.artistIds=work.artistIds.filter(artistId=>artistId!==id);
      work.parties=(work.parties||[]).filter(party=>party.artistId!==id);creditCount+=before-work.parties.length;
      if(performerLinked||before!==work.parties.length){workCount++;work.artist=(work.artistIds||[]).map(artistId=>state.artists.find(item=>item.id===artistId)?.name).filter(Boolean).join(', ');work.updatedAt=timestamp;}
    }
    state.artists=state.artists.filter(item=>item.id!==id);
    return {artist,workCount,creditCount};
  }

  function create(ctx){
    const e=ctx.esc,icon=ctx.icon,data=()=>ctx.state(),label=value=>e(clean(value)||'—');
    function catalogInsights(){return window.CueInsights.get(data(),ctx.revision?.());}
    const emptySongFilter=()=>({q:'',view:'All',type:'All',language:'All',source:'All',society:'All',role:'All',quality:'',usage:'All',sort:'title'});
    let songId='',songPage=1,artistId='',songFilter=emptySongFilter(),artistFilter={q:'',role:'All',society:'All',status:'All',sort:'name'},selectedSongIds=new Set(),selectedArtistIds=new Set();
    const button=(title,action,id='',style='')=>`<button type="button" class="btn ${style}" data-catalog="${action}" data-id="${e(id)}">${title}</button>`;
    const title=(value,actions)=>`<header class="cat-page-head"><h1 class="ux-title">${value}</h1><div class="button-row">${actions}</div></header>`;
    const stat=(name,value)=>`<div class="ux-stat cat-stat"><span>${e(name)}</span><strong>${e(value)}</strong></div>`;
    const chip=value=>`<span class="ux-chip">${e(value)}</span>`;
    const empty=(message,action='')=>`<div class="ux-empty">${icon('music')}<strong>${e(message)}</strong>${action}</div>`;
    const date=value=>value&&Number.isFinite(Date.parse(value))?(ctx.date?ctx.date(value):new Date(value).toLocaleDateString()):'—';
    const options=(values,current)=>values.map(value=>{const item=typeof value==='object'?value:{value,label:value};return `<option value="${e(item.value)}" ${item.value===current?'selected':''}>${e(item.label)}</option>`;}).join('');
    const select=(name,keyName,values,value,action)=>`<label class="cat-filter"><span>${e(name)}</span><select class="input" name="${keyName}" data-catalog="${action}">${options(values,value)}</select></label>`;
    const field=(name,inputName,value='',type='text',attributes='')=>`<div class="field"><label for="cat-${inputName}">${e(name)}</label><input class="input" id="cat-${inputName}" name="${inputName}" value="${e(text(value))}" type="${type}" ${attributes}></div>`;
    const textArea=(name,inputName,value='')=>`<div class="field full"><label for="cat-${inputName}">${e(name)}</label><textarea class="input" id="cat-${inputName}" name="${inputName}" rows="3">${e(text(value))}</textarea></div>`;
    const info=(name,value)=>`<div><dt>${e(name)}</dt><dd>${label(value)}</dd></div>`;
    const artistNames=w=>(w.artistIds||[]).map(id=>data().artists.find(a=>a.id===id)?.name).filter(Boolean).join(', ')||w.artist||'';
    const uses=id=>(data().cues||[]).filter(c=>c.workId===id);
    const searchText=record=>JSON.stringify(record).toLocaleLowerCase();
    const safeUrl=value=>{try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.href:'';}catch{return '';}};
    const latest=w=>w.updatedAt||w.activity?.[0]?.date||w.createdAt||'';
    const hasIdentifier=w=>Boolean(clean(w.isrc)||clean(w.iswc)||clean(w.tuneCode)||Object.values(w.societies||{}).some(value=>clean(value)));
    const hasRights=w=>Boolean(w.parties?.length);
    const shareTotal=w=>(w.parties||[]).reduce((sum,p)=>sum+(Number(p.share)||0),0);
    const unevenPercentage=w=>!hasRights(w)||(w.parties||[]).some(p=>p.share===null||p.share===undefined||String(p.share).trim()===''||!Number.isFinite(Number(p.share))||Number(p.share)<0||Number(p.share)>100)||Math.abs(shareTotal(w)-100)>.010000001;
    function focusSearch(id,position){const node=document.getElementById(id);node?.focus();if(node&&position!==null)node.setSelectionRange(position,position);}
    function reveal(selector){if(window.matchMedia('(max-width: 1000px)').matches)document.querySelector(selector)?.scrollIntoView({block:'start',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}
    function commit(message,change){const state=data(),before=structuredClone(state);try{change(state);state.activity??=[];state.activity.unshift({text:message,date:now()});if(ctx.save())return true;}catch(error){ctx.toast(error.message||'The change could not be saved.');}Object.keys(state).forEach(k=>delete state[k]);Object.assign(state,before);return false;}

    function songs(){
      const s=data(),f=songFilter,q=f.q.toLocaleLowerCase(),insights=catalogInsights(),workData=insights.workData;
      const existingIds=new Set(s.works.map(work=>work.id));selectedSongIds=new Set([...selectedSongIds].filter(id=>existingIds.has(id)));
      const count=w=>workData.get(w.id)?.cues.length||0,names=w=>workData.get(w.id)?.artistNames||'';
      const rows=s.works.filter(w=>{const record=workData.get(w.id);return (!q||searchText({...w,research:undefined,status:undefined}).includes(q)||names(w).toLocaleLowerCase().includes(q))&&(f.view==='All'||f.view==='Needs resolution'&&w.needsResolution||f.view==='Ready'&&!w.needsResolution&&hasIdentifier(w)&&hasRights(w)||f.view==='Missing identifiers'&&!hasIdentifier(w)||f.view==='Missing rights'&&!hasRights(w)||f.view==='Uneven percentage'&&unevenPercentage(w))&&(!f.quality||record.issues.includes(f.quality))&&(f.type==='All'||w.type===f.type)&&(f.language==='All'||w.language===f.language)&&(f.source==='All'||w.source===f.source)&&(f.society==='All'||record.memberships.includes(f.society))&&(f.role==='All'||f.role==='Performer'&&Boolean(record.artistNames)||(w.parties||[]).some(party=>party.role===f.role))&&(f.usage==='All'||f.usage==='Used'&&count(w)>0||f.usage==='Unused'&&count(w)===0||f.usage==='3+ usages'&&count(w)>=3);});
      rows.sort((a,b)=>{const alphabetical=text(a.title).localeCompare(text(b.title));if(f.sort==='title-desc')return -alphabetical;if(f.sort==='updated')return (Date.parse(latest(b))||0)-(Date.parse(latest(a))||0)||alphabetical;if(f.sort==='usage')return count(b)-count(a)||alphabetical;if(f.sort==='usage-asc')return count(a)-count(b)||alphabetical;return alphabetical;});
      const pageSize=40,pages=Math.max(1,Math.ceil(rows.length/pageSize));if(songPage<1)songPage=Math.max(1,Math.floor(rows.findIndex(work=>work.id===songId)/pageSize)+1);songPage=Math.min(songPage,pages);const visibleRows=rows.slice((songPage-1)*pageSize,songPage*pageSize);
      if(!visibleRows.some(w=>w.id===songId))songId=visibleRows[0]?.id||'';const selected=visibleRows.find(w=>w.id===songId);
      const resolution=s.works.filter(w=>w.needsResolution).length,ready=s.works.filter(w=>!w.needsResolution&&hasIdentifier(w)&&hasRights(w)).length,missingIdentifiers=s.works.filter(w=>!hasIdentifier(w)).length,missingRights=s.works.filter(w=>!hasRights(w)).length;
      const actions='<button class="btn primary" data-action="new-work">'+icon('plus')+' Add song</button><button class="btn" data-db="open">'+icon('upload')+' Upload database</button><button class="btn ghost" data-db="template">'+icon('download')+' Template</button>';
      const filtersActive=Object.entries(f).some(([name,value])=>name==='sort'?value!=='title':value&&value!=='All');
      const view=(name,value,total,description)=>`<div class="${f.view===value?'active':''}"><button type="button" data-catalog="song-view" data-id="${e(value)}" aria-pressed="${f.view===value}"><strong>${total}</strong><span>${e(name)}</span><small>${e(description)}</small></button></div>`;
      const allVisibleSelected=visibleRows.length>0&&visibleRows.every(work=>selectedSongIds.has(work.id));
      const row=w=>{const record=workData.get(w.id),ids=[['ISRC',w.isrc],['PRS',w.societies?.PRS||w.tuneCode],['ISWC',w.iswc],['IPRS',w.societies?.IPRS],['ASCAP',w.societies?.ASCAP]].filter(([,value])=>value),visible=ids.slice(0,2),cueCount=count(w),playCount=record.cues.reduce((sum,c)=>sum+(c.occurrences?.length||Number(c.usageCount)||1),0),recordReady=!w.needsResolution&&hasIdentifier(w)&&hasRights(w),recordState=w.needsResolution?'Needs match resolution':recordReady?'Catalog ready':!hasIdentifier(w)&&!hasRights(w)?'Identifiers & rights needed':!hasIdentifier(w)?'Identifier needed':'Rights needed';return `<tr class="${w.id===songId?'selected':''}" aria-selected="${w.id===songId}"><td class="cat-check-cell"><input type="checkbox" data-catalog="song-check" data-id="${e(w.id)}" aria-label="Select ${e(w.title)}" ${selectedSongIds.has(w.id)?'checked':''}></td><td><div class="cat-song-primary"><span class="cat-song-mark" aria-hidden="true">${e((w.title||'?').trim().charAt(0).toUpperCase()||'?')}</span><span><button class="cat-title-button" data-catalog="song-select" data-id="${e(w.id)}" aria-pressed="${w.id===songId}">${e(w.title)}</button><span class="cat-cell-secondary">${label(names(w))}</span></span></div><div class="cat-row-societies">${record.memberships.map(chip).join('')}</div></td><td class="cat-record-summary"><span>${label(w.type)} · ${label(w.language)}</span><span class="cat-data-state ${recordReady?'ready':'attention'}">${e(recordState)}</span>${f.view==='Uneven percentage'?`<span class="cat-data-state attention">Shares: ${e(Number(shareTotal(w).toFixed(2)))}%</span>`:''}<small>Updated ${e(date(record.updated))}</small></td><td class="cat-identifiers">${visible.map(([name,value])=>`<span><b>${e(name)}</b> ${e(value)}</span>`).join('')||'<span class="cat-empty-id">No identifiers</span>'}${ids.length>visible.length?`<small>+${ids.length-visible.length} more</small>`:''}</td><td class="cat-row-actions"><div class="cat-row-content"><span class="cat-cue-usage"><span class="cat-cue-count">${playCount}</span><small>${playCount===1?'play':'plays'}</small></span><span class="cat-cell-secondary">${record.episodes.size} episodes · ${cueCount} ${cueCount===1?'cue':'cues'} · ${e(w.recordingDuration||w.duration||'Duration not set')}</span>${button(icon('settings')+' Edit','song-edit',w.id,'cat-edit-button')}</div></td></tr>`;};
      return `<div class="ux-page cat-page cat-song-page"><header class="cat-library-hero"><div class="cat-library-head"><div class="cat-library-title"><span class="cat-library-icon" aria-hidden="true">${icon('music')}</span><div><span class="cat-overline">AMISHNA MUSIC · LIBRARY</span><h1>Song database</h1><p>Every recording, contributor and appearance. Connected in one place.</p></div></div><div class="button-row">${actions}</div></div><div class="cat-library-metrics" role="group" aria-label="Catalog views">${view('All songs','All',s.works.length,'Complete library')}${view('Needs resolution','Needs resolution',resolution,'Ambiguous imports')}${view('Catalog ready','Ready',ready,'Identifiers and rights')}${view('Missing identifiers','Missing identifiers',missingIdentifiers,'ISRC, ISWC or tune code')}${view('Missing rights','Missing rights',missingRights,'No rights holders')}${view('Uneven percentage','Uneven percentage',s.works.filter(unevenPercentage).length,'Shares need a review')}</div></header>
      <form class="cat-control-panel" data-catalog="song-filter-form"><div class="cat-control-heading"><div><strong>Find your next record</strong><span>Search song titles, performers, composers, lyricists, publishers and identifiers</span></div><span>${rows.length} ${rows.length===1?'result':'results'}</span></div><div class="cat-control-main"><div class="cat-search">${icon('search')}<input type="search" id="cat-song-search" name="q" data-catalog="song-search" value="${e(f.q)}" placeholder="Search your music library…" aria-label="Search songs"></div><button class="btn" type="submit">Search</button>${button(filtersActive?'Reset filters':'Reset','song-reset','','ghost')}</div><details class="cat-filter-disclosure" open><summary>Filters and sort <span>${filtersActive?'Active':'Optional'}</span></summary><div class="cat-filter-row">${select('Type','type',['All',...unique(s.works.map(w=>w.type))],f.type,'song-type')}${select('Language','language',['All',...unique(s.works.map(w=>w.language))],f.language,'song-language')}${select('Source','source',['All',...unique(s.works.map(w=>w.source))],f.source,'song-source')}${select('Society membership','society',['All','IPRS','PRS','ASCAP'],f.society,'song-society')}${select('Contributor role','role',['All','Performer','Composer','Lyricist','Publisher'],f.role,'song-role')}${select('Cue usage','usage',['All','Used','Unused','3+ usages'],f.usage,'song-usage')}${select('Order','sort',[{value:'title',label:'Title A–Z'},{value:'title-desc',label:'Title Z–A'},{value:'updated',label:'Recently updated'},{value:'usage',label:'Most appearances'},{value:'usage-asc',label:'Fewest appearances'}],f.sort,'song-sort')}</div></details>${f.quality?`<div class="cat-quality-filter">Data quality filter: ${e(f.quality.replace(/([A-Z])/g,' $1').toLowerCase())} ${button('Clear','song-reset','','small ghost')}</div>`:''}</form>
      ${rows.length?`<div class="cat-song-layout"><section class="ux-card cat-song-list"><header class="cat-list-head"><div><h2>Catalog results <span>${rows.length}</span></h2><p>Showing ${(songPage-1)*pageSize+1}–${Math.min(songPage*pageSize,rows.length)} of ${rows.length} matching songs</p></div><div class="cat-bulk-actions"><span>${selectedSongIds.size} selected</span>${button(icon('trash')+' Delete selected','song-bulk-delete','','danger')}</div></header><div class="table-wrap"><table class="cat-table"><thead><tr><th class="cat-check-cell"><input type="checkbox" data-catalog="song-check-all" aria-label="Select all visible songs" ${allVisibleSelected?'checked':''}></th><th>Song / Artist</th><th>Record</th><th>Identifiers</th><th>Usage / Edit</th></tr></thead><tbody>${visibleRows.map(row).join('')}</tbody></table></div><div class="cat-pagination"><span>Page ${songPage} of ${pages}</span><div><button class="btn small" data-catalog="song-page-previous" ${songPage===1?'disabled':''}>Previous</button><button class="btn small" data-catalog="song-page-next" ${songPage===pages?'disabled':''}>Next</button></div></div></section>${songDetail(selected,insights)}</div>`:`<section class="ux-card cat-no-results">${empty('No songs match your filters',button('Clear filters','song-reset'))}</section>`}</div>`;
    }
    function metadata(value,depth=0){
      if(value===null||value===undefined)return '<span class="ux-muted">—</span>';
      if(typeof value!=='object')return e(String(value));
      if(Array.isArray(value))return value.length?`<ol class="cat-metadata-list">${value.map(v=>`<li>${metadata(v,depth+1)}</li>`).join('')}</ol>`:'<span class="ux-muted">None</span>';
      return `<dl class="cat-metadata">${Object.entries(value).map(([name,val])=>`<div><dt>${e(name.replace(/([a-z])([A-Z])/g,'$1 $2'))}</dt><dd>${metadata(val,depth+1)}</dd></div>`).join('')}</dl>`;
    }
    function songDetail(w,insights=catalogInsights()){
      const record=insights.workData.get(w.id),cues=record.cues,artists=[...record.artistIds].map(id=>insights.artistsById.get(id)).filter(Boolean),rights=w.parties||[],storedMetadata={...w};delete storedMetadata.research;delete storedMetadata.status;
      const credited=role=>unique(rights.filter(party=>party.role===role).map(party=>party.name)).join(', '),exports=(insights.exportHistory.get(w.id)||[]).slice().sort((a,b)=>(Date.parse(b.date)||0)-(Date.parse(a.date)||0));
      return `<aside class="ux-card cat-detail cat-song-detail"><header class="cat-detail-head"><div><span class="cat-overline">SONG DETAILS</span><h2>${e(w.title)}</h2><span class="cat-record-id">${e(w.id)}</span></div><div class="cat-record-actions">${button(icon('settings')+' Edit','song-edit',w.id,'primary cat-edit-record')}${button(icon('copy')+' Merge','song-merge',w.id,'cat-merge-record')}${button(icon('trash')+' Delete','song-delete',w.id,'danger cat-delete-record')}</div></header>${w.needsResolution?`<div class="cat-operation-note"><strong>Match needs resolution.</strong> ${e(w.resolutionReason||'The uploaded data matched more than one saved song.')} Use Merge to connect these cues to the correct master song, or Edit to keep this as a separate record.${w.possibleMatchIds?.length?`<br><small>Possible records: ${w.possibleMatchIds.map(e).join(', ')}</small>`:''}</div>`:''}<div class="cat-record-checks"><div class="${hasIdentifier(w)?'complete':'missing'}"><span>Identifiers</span><strong>${hasIdentifier(w)?'Recorded':'Missing'}</strong></div><div class="${rights.length?'complete':'missing'}"><span>Rights holders</span><strong>${rights.length||'Missing'}</strong></div><div class="complete"><span>Appearances</span><strong>${cues.length}</strong></div></div><div class="cat-tags">${[w.type,w.language,...record.memberships].filter(Boolean).map(chip).join('')}</div>
      <section class="cat-section"><h3>Song information</h3><dl class="cat-facts">${info('Artist',record.artistNames)}${info('Composer',credited('Composer'))}${info('Lyricist',credited('Lyricist'))}${info('Publisher',credited('Publisher'))}${info('Label',w.label)}${info('Album',w.album)}${info('Release date',w.releaseDate)}${info('Genre',w.genre)}${info('Song duration',w.recordingDuration||w.duration)}${info('ISRC',w.isrc)}${info('ISWC',w.iswc)}${info('PRS code / Tune Code',w.societies?.PRS||w.tuneCode)}${info('Source',w.source)}${info('Last updated',date(record.updated))}${info('Alternate titles',list(w.alternateTitles).join(', '))}</dl>${list(w.tags).length?`<div class="cat-tags">${w.tags.map(chip).join('')}</div>`:''}${w.notes?`<p class="cat-notes">${e(w.notes)}</p>`:''}</section>
      <section class="cat-section"><h3>Rights information <span>${rights.length}</span></h3><p class="${unevenPercentage(w)?'cat-operation-note':'ux-muted'}">Ownership total: ${e(Number(shareTotal(w).toFixed(2)))}%. ${unevenPercentage(w)?'Review missing or invalid shares and make the total 100%.':'Shares total 100%.'}</p>${button('Edit percentages','song-shares',w.id,'small')}${rights.length?`<div class="cat-rights-list">${rights.map(p=>`<article><div><strong>${p.artistId?`<button class="link-button" data-catalog="artist-open" data-id="${e(p.artistId)}">${e(p.name)}</button>`:e(p.name)}</strong><span>${e(p.role||'Role not set')} · ${p.share===null||p.share===undefined?'Share not set':e(p.share)+'%'}</span></div><dl>${info('IPI',p.ipi)}${info('Society',(window.CueSocieties?.memberships(p,data().artists)||[p.society]).join(', '))}</dl></article>`).join('')}</div>`:'<p class="ux-muted">No rights holders recorded.</p>'}<dl class="cat-facts cat-society-codes">${Object.entries(w.societies||{}).filter(([,value])=>value).map(([name,value])=>info(name+' code',value)).join('')}</dl></section>
      <section class="cat-section"><h3>Artist information</h3>${artists.length?`<div class="cat-artist-directory">${artists.map(a=>`<button type="button" class="cat-linked-song" data-catalog="artist-open" data-id="${e(a.id)}"><span><strong>${e(a.name)}</strong><small>${e((a.roles||[]).join(' · '))}</small><small>${e((window.CueSocieties?.memberships(a)||[]).join(' · ')||'Society not recorded')}</small></span>${icon('arrow')}</button>`).join('')}</div>`:'<p class="ux-muted">No linked artist profiles. Add contributors using Edit.</p>'}</section>
      <section class="cat-section"><h3>Usage history <span>${cues.length}</span></h3><div class="cat-usage-summary"><span><strong>${record.projectIds.size}</strong> productions</span><span><strong>${record.episodes.size}</strong> episodes</span><span><strong>${e(window.CueDomain.time(record.duration))}</strong> total music</span></div>${[...record.projectIds].map(id=>{const project=insights.projectsById.get(id);return `<button class="cat-linked-song" data-project="${e(id)}"><span><strong>${e(project?.title||id)}</strong><small>${cues.filter(c=>c.projectId===id).length} appearances · ${project?.type==='Movie'?'Movie':'Serial'}</small></span>${icon('arrow')}</button>`;}).join('')||'<p class="ux-muted">This song is not used in a cue yet.</p>'}</section>
      <details class="cat-section cat-disclosure" open><summary>Episodes used in <span>${record.episodes.size}</span></summary>${[...record.episodes.values()].map(usage=>`<button class="cat-linked-song" data-dx-episode="${e(usage.projectId)}" data-number="${e(usage.number)}"><span><strong>${e(insights.projectsById.get(usage.projectId)?.title||usage.projectId)} · Episode ${e(usage.number)}</strong><small>${usage.cues} appearances · ${e(window.CueDomain.time(usage.duration))}</small></span>${icon('arrow')}</button>`).join('')||'<p class="ux-muted">No episode appearances recorded.</p>'}</details>
      <details class="cat-section cat-disclosure"><summary>Export history <span>${exports.length}</span></summary>${exports.slice(0,12).map(item=>`<div class="cat-export-item"><div><strong>${e(item.society)} · ${e(item.projectTitle)}</strong><small>${item.episodes?.length>1?'Episodes '+e(item.episodes[0])+'-'+e(item.episodes.at(-1))+' | '+item.episodes.length+' sheets':item.episode==null?'Movie':'Episode '+e(item.episode)} · ${e(date(item.date))}</small></div><button type="button" class="btn small" data-regenerate="${e(item.id)}">Download</button></div>`).join('')||'<p class="ux-muted">No saved export snapshot includes this song.</p>'}${exports.length>12?'<button type="button" class="btn small ghost" data-nav="exports">See all exports</button>':''}<p class="ux-muted">Based on saved snapshots. Exports with pruned snapshots cannot be linked to songs.</p></details>
      ${history(w.activity)}<details class="cat-section cat-all-metadata"><summary>All stored song metadata</summary>${metadata(storedMetadata)}</details></aside>`;
    }
    function history(items){return items?.length?`<section class="cat-section"><h3>Recent activity</h3><ol class="cat-history">${items.slice(0,8).map(a=>`<li><span>${e(a.text||a.action||'Updated')}</span><time>${e(date(a.date))}</time></li>`).join('')}</ol></section>`:'';}

    function artists(){
      const s=data(),f=artistFilter,q=f.q.toLocaleLowerCase();
      selectedArtistIds=new Set([...selectedArtistIds].filter(id=>s.artists.some(artist=>artist.id===id)));
      const rows=s.artists.filter(a=>(!q||searchText(a).includes(q)||linkedWorks(s,a.id).some(w=>text(w.title).toLocaleLowerCase().includes(q)))&&(f.role==='All'||list(a.roles).includes(f.role))&&(f.status==='All'||a.status===f.status)&&(f.society==='All'||(f.society==='Unknown'?!root.CueSocieties.memberships(a).length:root.CueSocieties.has(a,f.society))));
      rows.sort((a,b)=>f.sort==='updated'?(Date.parse(b.updatedAt)||0)-(Date.parse(a.updatedAt)||0):f.sort==='songs'?linkedWorks(s,b.id).length-linkedWorks(s,a.id).length||text(a.name).localeCompare(text(b.name)):text(a.name).localeCompare(text(b.name)));
      if(!rows.some(a=>a.id===artistId))artistId=rows[0]?.id||'';
      const selected=rows.find(a=>a.id===artistId);
      const allVisibleSelected=rows.length>0&&rows.every(artist=>selectedArtistIds.has(artist.id));
      return `<div class="ux-page cat-page">${title('Artist database',button(icon('plus')+' Add artist','artist-new','','primary'))}<div class="ux-stats">${stat('Artists & rights holders',s.artists.length)}${stat('Active',s.artists.filter(a=>a.status==='Active').length)}${stat('With IPI',s.artists.filter(a=>clean(a.ipi)).length)}${stat('Linked songs',s.works.filter(w=>w.artistIds?.length||w.parties?.some(p=>p.artistId)).length)}</div>
      <form class="ux-toolbar cat-toolbar" data-catalog="artist-filter-form"><div class="cat-search">${icon('search')}<input type="search" id="cat-artist-search" name="q" data-catalog="artist-search" value="${e(f.q)}" placeholder="Search names, IPI, aliases or songs" aria-label="Search artists"></div>${select('Role','role',['All',...unique(s.artists.flatMap(a=>list(a.roles)))],f.role,'artist-role')}${select('Society','society',['All','IPRS','PRS','ASCAP','Unknown'],f.society,'artist-society')}${select('Status','status',['All','Active','Archived'],f.status,'artist-status')}${select('Sort','sort',[{value:'name',label:'Name A–Z'},{value:'updated',label:'Recently updated'},{value:'songs',label:'Most linked songs'}],f.sort,'artist-sort')}<button class="btn" type="submit">Search</button>${button('Reset','artist-reset')}</form>
      <div class="cat-results cat-results-bulk"><label><input type="checkbox" data-catalog="artist-check-all" ${allVisibleSelected?'checked':''}> Select all ${rows.length} visible</label><span>${selectedArtistIds.size} selected</span>${button(icon('trash')+' Delete selected','artist-bulk-delete','','danger')}</div>${rows.length?`<div class="cat-artist-layout"><section class="ux-card cat-artist-list">${rows.map(a=>`<article class="cat-artist-card ${a.id===artistId?'selected':''}"><label class="cat-artist-check"><input type="checkbox" data-catalog="artist-check" data-id="${e(a.id)}" aria-label="Select ${e(a.name)}" ${selectedArtistIds.has(a.id)?'checked':''}></label><button class="cat-artist-select" data-catalog="artist-select" data-id="${e(a.id)}" aria-pressed="${a.id===artistId}"><span class="cat-monogram">${e(a.name.split(/\s+/).filter(Boolean).slice(0,2).map(n=>n[0]).join('').toUpperCase())}</span><span class="cat-artist-summary"><strong>${e(a.name)}</strong><small>${e(list(a.roles).join(', ')||'Role not set')}</small><small class="cat-ipi">IPI ${e(a.ipi||'not recorded')} · ${e(root.CueSocieties.memberships(a).join(' · ')||'Society not recorded')}</small></span><span class="cat-artist-count">${linkedWorks(s,a.id).length}<small>songs</small></span></button></article>`).join('')}</section>${artistDetail(selected)}</div>`:empty('No artists match your filters',s.artists.length?button('Clear filters','artist-reset'):button('Add artist','artist-new','','primary'))}</div>`;
    }
    function artistDetail(a){
      const works=linkedWorks(data(),a.id),cues=data().cues.filter(c=>works.some(w=>w.id===c.workId));
      return `<aside class="ux-card cat-detail cat-artist-detail"><header class="cat-detail-head"><div><span class="cat-overline">ARTIST PROFILE</span><h2>${e(a.name)}</h2><span class="cat-record-id">${e(a.id)}</span></div><div class="cat-record-actions">${button(icon('settings')+' Edit','artist-edit',a.id,'primary')}${button(icon('copy')+' Merge','artist-merge',a.id,'cat-merge-record')}${button(icon('trash')+' Delete','artist-delete',a.id,'danger cat-delete-record')}</div></header><div class="cat-tags">${chip(a.status||'Active')}${list(a.roles).map(chip).join('')}</div>
      <section class="cat-section"><h3>Society memberships</h3><div class="cat-society-options">${['IPRS','PRS','ASCAP'].map(society=>`<span>${society} <strong>${root.CueSocieties.has(a,society)?'Yes':'No'}</strong></span>`).join('')}</div></section><section class="cat-section"><h3>Identity & contact</h3><dl class="cat-facts">${info('IPI / CAE number',a.ipi)}${info('ISNI',a.isni)}${info('Entity type',a.entityType)}${info('Societies',list(a.societies).join(', '))}${info('Aliases',list(a.aliases).join(', '))}${info('Country',a.country)}${info('Email',a.email)}${info('Phone',a.phone)}</dl>${a.website?`<p class="cat-reference">${safeUrl(a.website)?`<a href="${e(safeUrl(a.website))}" target="_blank" rel="noopener noreferrer">${e(a.website)} ${icon('arrow')}</a>`:e(a.website)}</p>`:''}${a.notes?`<p class="cat-notes">${e(a.notes)}</p>`:''}</section>
      <section class="cat-section"><div class="cat-section-head"><h3>Linked songs <span>${works.length}</span></h3><span class="ux-muted">${cues.length} cue uses</span></div>${works.map(w=>{const credits=unique([...(w.artistIds||[]).includes(a.id)?['Performer']:[],...(w.parties||[]).filter(p=>p.artistId===a.id).map(p=>p.role)]);return `<button class="cat-linked-song" data-catalog="song-open" data-id="${e(w.id)}"><span><strong>${e(w.title)}</strong><small>${e(credits.join(', '))}</small></span>${icon('arrow')}</button>`;}).join('')||'<p class="ux-muted">No songs linked yet.</p>'}</section>
      ${history(a.activity)}<dl class="cat-facts cat-section">${info('Created',date(a.createdAt))}${info('Updated',date(a.updatedAt))}</dl><details class="cat-section cat-all-metadata"><summary>All stored artist metadata</summary>${metadata(a)}</details></aside>`;
    }
    function artistModal(id){
      const a=data().artists.find(a=>a.id===id)||{};
      ctx.modal(ctx.modalHead(a.id?'Edit artist':'Add artist')+`<div class="modal-body cat-modal"><form data-catalog="artist-form" data-id="${e(a.id||'')}"><div class="form-grid">${field('Artist / rights-holder name','name',a.name,'text','required autocomplete="name"')}${field('IPI / CAE number','ipi',a.ipi,'text','inputmode="text" autocomplete="off"')}${select('Status','status',['Active','Archived'],a.status||'Active','')}${select('Entity type','entityType',['','Person','Group','Organization'],a.entityType||'','')}${field('Roles (comma separated)','roles',list(a.roles).join(', '),'text','placeholder="Performer, Composer, Lyricist"')}<fieldset class="field full cat-society-membership"><legend>Society memberships</legend><div class="cat-society-options">${['IPRS','PRS','ASCAP'].map(society=>`<label><input type="checkbox" name="membership" value="${society}" ${root.CueSocieties.has(a,society)?'checked':''}> ${society}</label>`).join('')}</div><p class="ux-muted">Select every confirmed membership. Each export includes members of that society only.</p></fieldset>${field('Other societies (comma separated)','societies',root.CueSocieties.memberships(a).filter(society=>!['IPRS','PRS','ASCAP'].includes(society)).join(', '),'text','placeholder="BMI, SESAC…"')}${field('Aliases (comma separated)','aliases',list(a.aliases).join(', '))}${field('ISNI','isni',a.isni)}${field('Email','email',a.email,'email')}${field('Phone','phone',a.phone,'tel')}${field('Country','country',a.country)}${field('Website','website',a.website,'url')}${textArea('Notes','notes',a.notes)}</div><div class="panel-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">${a.id?'Save artist':'Create artist'}</button></div></form></div>`);
    }
    function songMergeModal(id){
      const s=data(),source=s.works.find(work=>work.id===id),targets=s.works.filter(work=>work.id!==id).sort((a,b)=>text(a.title).localeCompare(text(b.title)));if(!source)return ctx.toast('This song is no longer available.');if(!targets.length)return ctx.toast('Add another song before using merge.');
      const cueCount=uses(id).length;
      ctx.modal(ctx.modalHead('Merge duplicate song')+`<div class="modal-body cat-control-modal"><form data-catalog="song-merge-form" data-id="${e(id)}"><div class="cat-merge-intro"><span>MERGE FROM</span><strong>${e(source.title)}</strong><small>${e(source.id)} · ${cueCount} ${cueCount===1?'cue':'cues'}</small></div><div class="field"><label for="cat-song-merge-target">Keep this song as the master record</label><select class="input" id="cat-song-merge-target" name="targetId" required><option value="">Choose the correct song…</option>${targets.map(work=>`<option value="${e(work.id)}">${e(work.title)} · ${e(work.id)}</option>`).join('')}</select></div><div class="cat-operation-note">Every active and deleted cue linked to <strong>${e(source.title)}</strong> will use the selected master song. Missing metadata, artists, rights holders and alternate titles will be combined. Conflicting identifiers remain recorded in the master song's stored metadata.</div><div class="panel-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">${icon('copy')} Merge song records</button></div></form></div>`);
    }
    function songDeleteModal(id){
      const s=data(),song=s.works.find(work=>work.id===id);if(!song)return ctx.toast('This song is no longer available.');const cueCount=uses(id).length,deletedCueCount=(s.deletedCues||[]).filter(item=>item.cue?.workId===id).length;
      ctx.modal(ctx.modalHead('Delete song permanently')+`<div class="modal-body cat-control-modal"><form data-catalog="song-delete-form" data-id="${e(id)}"><div class="cat-danger-card">${icon('trash')}<div><strong>${e(song.title)}</strong><span>${e(song.id)}</span></div></div><div class="cat-impact-grid"><div><strong>${cueCount}</strong><span>active cues deleted</span></div><div><strong>${deletedCueCount}</strong><span>deleted-cue history removed</span></div></div><p class="cat-operation-note danger">This removes the song and its linked cue records from the current database. Existing export snapshots remain unchanged.</p><label class="cat-confirm-control"><input type="checkbox" name="confirm" value="yes" required><span>I understand that this database deletion cannot be undone.</span></label><div class="panel-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn danger cat-confirm-delete" type="submit">${icon('trash')} Delete song</button></div></form></div>`);
    }
    function artistMergeModal(id){
      const s=data(),source=s.artists.find(artist=>artist.id===id),targets=s.artists.filter(artist=>artist.id!==id).sort((a,b)=>text(a.name).localeCompare(text(b.name)));if(!source)return ctx.toast('This artist is no longer available.');if(!targets.length)return ctx.toast('Add another artist before using merge.');const works=linkedWorks(s,id),credits=s.works.reduce((total,work)=>total+(work.parties||[]).filter(party=>party.artistId===id).length,0);
      ctx.modal(ctx.modalHead('Merge duplicate artist')+`<div class="modal-body cat-control-modal"><form data-catalog="artist-merge-form" data-id="${e(id)}"><div class="cat-merge-intro"><span>MERGE FROM</span><strong>${e(source.name)}</strong><small>${e(source.id)}${source.ipi?' · IPI '+e(source.ipi):''}</small></div><div class="field"><label for="cat-artist-merge-target">Keep this artist as the master profile</label><select class="input" id="cat-artist-merge-target" name="targetId" required><option value="">Choose the correct artist…</option>${targets.map(artist=>`<option value="${e(artist.id)}">${e(artist.name)}${artist.ipi?' · IPI '+e(artist.ipi):''}</option>`).join('')}</select></div><div class="cat-impact-grid"><div><strong>${works.length}</strong><span>linked songs updated</span></div><div><strong>${credits}</strong><span>rights credits updated</span></div></div><div class="cat-operation-note">Performer links and rights-holder credits will point to the selected master artist. Roles, societies, aliases and missing contact metadata will be combined.</div><div class="panel-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">${icon('copy')} Merge artist profiles</button></div></form></div>`);
    }
    function artistDeleteModal(id){
      const s=data(),artist=s.artists.find(item=>item.id===id);if(!artist)return ctx.toast('This artist is no longer available.');const works=linkedWorks(s,id),credits=s.works.reduce((total,work)=>total+(work.parties||[]).filter(party=>party.artistId===id).length,0);
      ctx.modal(ctx.modalHead('Delete artist permanently')+`<div class="modal-body cat-control-modal"><form data-catalog="artist-delete-form" data-id="${e(id)}"><div class="cat-danger-card">${icon('trash')}<div><strong>${e(artist.name)}</strong><span>${e(artist.id)}${artist.ipi?' · IPI '+e(artist.ipi):''}</span></div></div><div class="cat-impact-grid"><div><strong>${works.length}</strong><span>linked songs updated</span></div><div><strong>${credits}</strong><span>rights credits removed</span></div></div><p class="cat-operation-note danger">This removes the artist profile, performer links and its related rights-holder rows. Merge the profile instead when this is a spelling duplicate.</p><label class="cat-confirm-control"><input type="checkbox" name="confirm" value="yes" required><span>I understand that this database deletion cannot be undone.</span></label><div class="panel-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn danger cat-confirm-delete" type="submit">${icon('trash')} Delete artist</button></div></form></div>`);
    }
    function songBulkDeleteModal(){
      const s=data(),ids=[...selectedSongIds].filter(id=>s.works.some(work=>work.id===id));if(!ids.length)return ctx.toast('Select at least one song first.');
      const cues=(s.cues||[]).filter(cue=>ids.includes(cue.workId)).length,deleted=(s.deletedCues||[]).filter(item=>ids.includes(item.cue?.workId)).length;
      ctx.modal(ctx.modalHead('Delete selected songs?')+`<div class="modal-body cat-control-modal"><form data-catalog="song-bulk-delete-form"><div class="cat-danger-card">${icon('trash')}<div><strong>${ids.length} song ${ids.length===1?'record':'records'} selected</strong><span>This includes IPRS and other society metadata stored on those songs.</span></div></div><div class="cat-impact-grid"><div><strong>${cues}</strong><span>active cue ${cues===1?'record':'records'} deleted</span></div><div><strong>${deleted}</strong><span>deleted-cue history ${deleted===1?'record':'records'} removed</span></div></div><p class="cat-operation-note danger">Linked cue records will be removed immediately. Export snapshots stay unchanged. Use Merge first when the selected rows are spelling duplicates.</p><label class="cat-confirm-control"><input type="checkbox" name="confirm" value="yes" required><span>I understand that these database records and their linked cues will be permanently deleted.</span></label><div class="panel-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn danger cat-confirm-delete" type="submit">${icon('trash')} Delete ${ids.length} ${ids.length===1?'song':'songs'}</button></div></form></div>`);
    }
    function artistBulkDeleteModal(){
      const s=data(),ids=[...selectedArtistIds].filter(id=>s.artists.some(artist=>artist.id===id));if(!ids.length)return ctx.toast('Select at least one artist first.');
      const works=new Set(),credits=s.works.reduce((total,work)=>{if((work.artistIds||[]).some(id=>ids.includes(id))||(work.parties||[]).some(party=>ids.includes(party.artistId)))works.add(work.id);return total+(work.parties||[]).filter(party=>ids.includes(party.artistId)).length;},0);
      ctx.modal(ctx.modalHead('Delete selected artists?')+`<div class="modal-body cat-control-modal"><form data-catalog="artist-bulk-delete-form"><div class="cat-danger-card">${icon('trash')}<div><strong>${ids.length} artist ${ids.length===1?'profile':'profiles'} selected</strong><span>Check for spelling duplicates and use Merge before deleting.</span></div></div><div class="cat-impact-grid"><div><strong>${works.size}</strong><span>linked songs updated</span></div><div><strong>${credits}</strong><span>rights-holder credits removed</span></div></div><p class="cat-operation-note danger">Performer links and rights-holder rows for these artists will be removed from every existing song record.</p><label class="cat-confirm-control"><input type="checkbox" name="confirm" value="yes" required><span>I understand that these artist profiles and relationships will be permanently deleted.</span></label><div class="panel-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn danger cat-confirm-delete" type="submit">${icon('trash')} Delete ${ids.length} ${ids.length===1?'artist':'artists'}</button></div></form></div>`);
    }
    function click(event){
      const target=event.target.closest('button[data-catalog]');if(!target)return false;const action=target.dataset.catalog,id=target.dataset.id;
      switch(action){
        case 'song-select':songId=id;ctx.render();reveal('.cat-song-detail');break;
        case 'song-open':songId=id;songPage=0;songFilter=emptySongFilter();ctx.go('works');reveal('.cat-song-detail');break;
        case 'song-edit':ctx.openWork(id);break;
        case 'song-shares':ctx.openWork(id,'Rights holders');break;
        case 'song-merge':songMergeModal(id);break;
        case 'song-delete':songDeleteModal(id);break;
        case 'song-bulk-delete':songBulkDeleteModal();break;
        case 'song-view':songFilter.view=id;songFilter.quality='';songPage=1;ctx.render();break;
        case 'song-quality':songFilter=emptySongFilter();songFilter.quality=id;songPage=1;ctx.go('works');break;
        case 'song-page-previous':songPage=Math.max(1,songPage-1);ctx.render();break;
        case 'song-page-next':songPage++;ctx.render();break;
        case 'song-reset':songFilter=emptySongFilter();songPage=1;ctx.render();break;
        case 'artist-new':artistModal();break;
        case 'artist-edit':artistModal(id);break;
        case 'artist-merge':artistMergeModal(id);break;
        case 'artist-delete':artistDeleteModal(id);break;
        case 'artist-bulk-delete':artistBulkDeleteModal();break;
        case 'artist-select':artistId=id;ctx.render();reveal('.cat-artist-detail');break;
        case 'artist-open':artistId=id;artistFilter={q:'',role:'All',society:'All',status:'All',sort:'name'};ctx.go('artists');reveal('.cat-artist-detail');break;
        case 'artist-reset':artistFilter={q:'',role:'All',society:'All',status:'All',sort:'name'};ctx.render();break;
        default:return false;
      }
      event.preventDefault();return true;
    }
    function change(event){
      const action=event.target.dataset.catalog,id=event.target.dataset.id;
      if(action==='song-check'){event.target.checked?selectedSongIds.add(id):selectedSongIds.delete(id);ctx.render();return true;}
      if(action==='song-check-all'){const checked=event.target.checked;document.querySelectorAll('[data-catalog="song-check"]').forEach(input=>{checked?selectedSongIds.add(input.dataset.id):selectedSongIds.delete(input.dataset.id);});ctx.render();return true;}
      if(action==='artist-check'){event.target.checked?selectedArtistIds.add(id):selectedArtistIds.delete(id);ctx.render();return true;}
      if(action==='artist-check-all'){const checked=event.target.checked;document.querySelectorAll('[data-catalog="artist-check"]').forEach(input=>{checked?selectedArtistIds.add(input.dataset.id):selectedArtistIds.delete(input.dataset.id);});ctx.render();return true;}
      const field={'song-type':[songFilter,'type'],'song-language':[songFilter,'language'],'song-source':[songFilter,'source'],'song-society':[songFilter,'society'],'song-role':[songFilter,'role'],'song-usage':[songFilter,'usage'],'song-sort':[songFilter,'sort'],'artist-role':[artistFilter,'role'],'artist-society':[artistFilter,'society'],'artist-status':[artistFilter,'status'],'artist-sort':[artistFilter,'sort']}[event.target.dataset.catalog];
      if(!field)return false;field[0][field[1]]=event.target.value;if(field[0]===songFilter)songPage=1;ctx.render();return true;
    }
    function input(event){const filter={'song-search':songFilter,'artist-search':artistFilter}[event.target.dataset.catalog];if(!filter)return false;filter.q=event.target.value;if(filter===songFilter)songPage=1;const id=event.target.id,position=event.target.selectionStart;ctx.render();focusSearch(id,position);return true;}
    function submit(event){
      const form=event.target,action=form.dataset.catalog;if(!['song-filter-form','artist-filter-form','artist-form','song-merge-form','song-delete-form','song-bulk-delete-form','artist-merge-form','artist-delete-form','artist-bulk-delete-form'].includes(action))return false;event.preventDefault();
      const values=new FormData(form),get=name=>clean(values.get(name));
      if(action.endsWith('-filter-form')){(action==='song-filter-form'?songFilter:artistFilter).q=get('q');ctx.render();return true;}
      if(action==='song-merge-form'){
        const sourceId=form.dataset.id,targetId=get('targetId');if(!targetId){ctx.toast('Choose the master song to keep.');return true;}let result;
        if(commit('Merged duplicate song',state=>{result=mergeSong(state,sourceId,targetId);})){songId=targetId;ctx.close();ctx.render();ctx.toast(`Songs merged. ${result.cueCount} ${result.cueCount===1?'cue now uses':'cues now use'} ${result.target.title}.`);}return true;
      }
      if(action==='song-delete-form'){
        if(get('confirm')!=='yes'){ctx.toast('Confirm the permanent deletion first.');return true;}const id=form.dataset.id;let result;
        if(commit('Deleted song from database',state=>{result=deleteSong(state,id);})){songId='';ctx.close();ctx.render();ctx.toast(`${result.song.title} deleted with ${result.cueCount} linked ${result.cueCount===1?'cue':'cues'}.`);}return true;
      }
      if(action==='song-bulk-delete-form'){
        if(get('confirm')!=='yes'){ctx.toast('Confirm the permanent deletion first.');return true;}const ids=[...selectedSongIds];let removed=0,cues=0;
        if(commit('Bulk deleted songs from database',state=>{for(const id of ids){if(!state.works.some(work=>work.id===id))continue;const result=deleteSong(state,id);removed++;cues+=result.cueCount;}})){selectedSongIds.clear();songId='';ctx.close();ctx.render();ctx.toast(`${removed} ${removed===1?'song':'songs'} deleted with ${cues} linked ${cues===1?'cue':'cues'}.`);}return true;
      }
      if(action==='artist-merge-form'){
        const sourceId=form.dataset.id,targetId=get('targetId');if(!targetId){ctx.toast('Choose the master artist to keep.');return true;}let result;
        if(commit('Merged duplicate artist',state=>{result=mergeArtist(state,sourceId,targetId);})){artistId=targetId;ctx.close();ctx.render();ctx.toast(`Artists merged. ${result.workCount} linked ${result.workCount===1?'song was':'songs were'} updated.`);}return true;
      }
      if(action==='artist-delete-form'){
        if(get('confirm')!=='yes'){ctx.toast('Confirm the permanent deletion first.');return true;}const id=form.dataset.id;let result;
        if(commit('Deleted artist from database',state=>{result=deleteArtist(state,id);})){artistId='';ctx.close();ctx.render();ctx.toast(`${result.artist.name} deleted. ${result.workCount} linked ${result.workCount===1?'song was':'songs were'} updated.`);}return true;
      }
      if(action==='artist-bulk-delete-form'){
        if(get('confirm')!=='yes'){ctx.toast('Confirm the permanent deletion first.');return true;}const ids=[...selectedArtistIds];let removed=0,works=0;
        if(commit('Bulk deleted artists from database',state=>{for(const id of ids){if(!state.artists.some(artist=>artist.id===id))continue;const result=deleteArtist(state,id);removed++;works+=result.workCount;}})){selectedArtistIds.clear();artistId='';ctx.close();ctx.render();ctx.toast(`${removed} ${removed===1?'artist':'artists'} deleted. ${works} linked song updates were applied.`);}return true;
      }
      const id=form.dataset.id,record={};for(const name of ['name','ipi','status','entityType','isni','email','phone','country','website','notes'])record[name]=get(name);for(const name of ['roles','aliases'])record[name]=unique(get(name).split(',').map(clean));record.societies=root.CueSocieties.parse([...values.getAll('membership'),get('societies')]);
      let createdId;
      if(commit((id?'Updated':'Created')+' artist · '+record.name,s=>{const artist=applyArtist(s,record,id);createdId=artist.id;artist.activity??=[];artist.activity.unshift({text:id?'Artist profile updated':'Artist created',date:now()});})){artistId=createdId;if(!id)artistFilter={q:'',role:'All',society:'All',status:'All',sort:'name'};ctx.close();ctx.render();ctx.toast(id?'Artist updated.':'Artist created.');}
      return true;
    }
    return {songs,artists,click,change,input,submit};
  }
  const api={ensure,create,linkedWorks,applyArtist,mergeSong,deleteSong,mergeArtist,deleteArtist};
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.CueCatalog=api;
})(typeof window==='undefined'?null:window);

/* database-import.js */
/* Safe, staged CSV/XLSX song-catalog import. No workspace mutation occurs before confirmation. */
(function(root){
  'use strict';
  // Entries with a seventh value reproduce Upload Format.xlsx exactly.
  // ISWC remains available for custom/older files and database matching.
  const schema=[
    ['title','Song Name',true,'Text','Monsoon Theme','Song or work name.','Song Name'],
    ['artist','Singer',false,'Text','Asha Rao, Aman Shah','Separate multiple singers with commas; each singer is linked individually.','Singer'],
    ['composer1Role','Composer 1 · Role',false,'Text','Composer','Role for Composer 1.','Role'],
    ['composer1Name','Composer 1',false,'Text','Dev Mehta','First composer name.','Composer 1'],
    ['composer1Ipi','Composer 1 · CAE',false,'Digits as text','00012345678','IPI/CAE, up to 13 digits.','CAE'],
    ['composer1Society','Composer 1 · Society',false,'Text','IPRS','Rights society for Composer 1.','Society'],
    ['composer1Share','Composer 1 · Share',false,'Percent','50','Share from 0 to 100; blank means unknown.','Share'],
    ['composer2Role','Composer 2 · Role',false,'Text','Composer','Role for Composer 2.','Role'],
    ['composer2Name','Composer 2',false,'Text','Aman Shah','Second composer name.','Composer 2'],
    ['composer2Ipi','Composer 2 · CAE',false,'Digits as text','00012345679','IPI/CAE, up to 13 digits.','CAE'],
    ['composer2Society','Composer 2 · Society',false,'Text','IPRS','Rights society for Composer 2.','Society'],
    ['composer2Share','Composer 2 · Share',false,'Percent','25','Share from 0 to 100; blank means unknown.','Share'],
    ['composer3Role','Composer 3 · Role',false,'Text','Composer','Role for Composer 3.','Role'],
    ['composer3Name','Composer 3',false,'Text','','Third composer name.','Composer 3'],
    ['composer3Ipi','Composer 3 · CAE',false,'Digits as text','','IPI/CAE, up to 13 digits.','CAE'],
    ['composer3Society','Composer 3 · Society',false,'Text','','Rights society for Composer 3.','Society'],
    ['composer3Share','Composer 3 · Share',false,'Percent','','Share from 0 to 100; blank means unknown.','Share'],
    ['author1Role','Lyricist / Author 1 · Role',false,'Text','Lyricist','Author means the song lyricist; it is not a composer credit.','Role'],
    ['author1Name','Lyricist / Author 1',false,'Text','Maya Sen','First song lyricist (called Author in society files).','Lyricist / Author 1'],
    ['author1Ipi','Lyricist / Author 1 · CAE',false,'Digits as text','00022345678','Lyricist/Author IPI/CAE, up to 13 digits.','CAE'],
    ['author1Society','Lyricist / Author 1 · Society',false,'Text','IPRS','Rights society for Lyricist / Author 1.','Society'],
    ['author1Share','Lyricist / Author 1 · Share',false,'Percent','25','Share from 0 to 100; blank means unknown.','Share'],
    ['author2Role','Lyricist / Author 2 · Role',false,'Text','Lyricist','Author means the song lyricist; it is not a composer credit.','Role'],
    ['author2Name','Lyricist / Author 2',false,'Text','','Second song lyricist (called Author in society files).','Lyricist / Author 2'],
    ['author2Ipi','Lyricist / Author 2 · CAE',false,'Digits as text','','Lyricist/Author IPI/CAE, up to 13 digits.','CAE'],
    ['author2Society','Lyricist / Author 2 · Society',false,'Text','','Rights society for Lyricist / Author 2.','Society'],
    ['author2Share','Lyricist / Author 2 · Share',false,'Percent','','Share from 0 to 100; blank means unknown.','Share'],
    ['publisherRole','Publisher · Role',false,'Text','Publisher','Publisher role.','Role'],
    ['publisherName','Publisher',false,'Text','Example Publishing','Publisher name.','Publisher'],
    ['publisherIpi','Publisher · CAE',false,'Digits as text','00000000222','Publisher IPI/CAE, up to 13 digits.','CAE'],
    ['publisherSociety','Publisher · Society',false,'Text','IPRS','Publisher rights society.','Society'],
    ['publisherShare','Publisher · Share',false,'Percent','','Share from 0 to 100; blank means unknown.','Share'],
    ['isrc','ISRC',false,'Text','IN-ABC-26-00001','Recording identifier; unique when supplied.','ISRC'],
    ['iprsCode','IPRS Work Code',false,'Text','IPRS-12345','IPRS song/work identifier; unique when supplied.','IPRS Work Code'],
    ['tuneCode','Tune Code',false,'Text','TUNE-12345','Tune identifier; unique when supplied.','Tune Code'],
    ['ascapCode','ASCAP Code',false,'Text','ASCAP-12345','ASCAP work identifier; unique when supplied.','ASCAP Code'],
    ['iswc','ISWC',false,'Text','T-123.456.789-0','Accepted from custom files and used for database lookup.']
  ];
  const templateSchema=schema.filter(row=>row[6]),templateFields=templateSchema.map(row=>row[0]),templateHeaders=templateSchema.map(row=>row[6]);
  const fields=schema.map(row=>row[0]),labels=Object.fromEntries(schema.map(row=>[row[0],row[1]]));
  const aliases={
    title:['songtitle','trackname','tracktitle','worktitle','songname','name'],artist:['artistname','performer','performername','singer'],
    isrc:['isrccode'],iswc:['iswccode'],iprsCode:['iprsworkcode','iprssongcode','iprscode'],tuneCode:['tunecode','tuneid'],ascapCode:['ascapcode','ascapworkcode'],
    composer1Name:['composer','composername'],composer1Ipi:['composeripicae','composeripi','composeripinumber','ipi','ipinumber'],
    author1Name:['author1','lyricist1','authorlyricist1','lyricistauthor1','author','lyricist','writer','writername'],
    author2Name:['author2','lyricist2','authorlyricist2','lyricistauthor2'],
    publisherName:['publishername'],publisherIpi:['publisheripicae','publisheripi','publisheripinumber']
  };
  const groups=[
    {prefix:'composer1',defaultRole:'Composer'},{prefix:'composer2',defaultRole:'Composer'},{prefix:'composer3',defaultRole:'Composer'},
    {prefix:'author1',defaultRole:'Lyricist'},{prefix:'author2',defaultRole:'Lyricist'},{prefix:'publisher',defaultRole:'Publisher'}
  ];
  const clean=value=>String(value??'').trim();
  const key=value=>clean(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  function normalizeRole(value,fallback=''){
    const role=clean(value)||fallback,normalized=key(role);
    if(normalized==='c')return 'Composer';
    if(normalized==='a'||normalized==='author'||normalized==='authorlyricist'||normalized==='lyricistauthor')return 'Lyricist';
    if(['ca','composerauthor','authorcomposer','composerlyricist','lyricistcomposer'].includes(normalized))return 'Composer / Lyricist';
    if(normalized==='e')return 'Publisher';
    if(normalized==='ar')return 'Arranger';
    if(fallback&&/^\d+(?:\.\d+)?%?$/.test(role))return fallback;
    return role;
  }
  const csv=value=>{let text=String(value??'');if(/^[\s]*[=+\-@]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};
  const signature=record=>[key(record.title),key(record.artist),...groups.map(group=>key(record[group.prefix+'Name'])),key(record.isrc),key(record.iswc),key(record.tuneCode),key(record.iprsCode),key(record.ascapCode)].join('|');

  function mapping(headers){
    if(templateHeaders.every((header,index)=>key(headers[index])===key(header)))return headers.map((_,index)=>templateFields[index]||'');
    const used=new Set();
    const repeated={role:0,cae:0,society:0,share:0};
    const repeatFields={role:groups.map(group=>group.prefix+'Role'),cae:groups.map(group=>group.prefix+'Ipi'),society:groups.map(group=>group.prefix+'Society'),share:groups.map(group=>group.prefix+'Share')};
    return headers.map(header=>{
      const normalized=key(header);let match='';
      if(repeatFields[normalized])match=repeatFields[normalized][repeated[normalized]++]||'';
      if(!match)match=fields.find(field=>!used.has(field)&&(key(field)===normalized||key(labels[field])===normalized||(aliases[field]||[]).includes(normalized)))||'';
      if(match)used.add(match);return match||'';
    });
  }
  function issue(field,value,message,suggestion){return {field,value:clean(value),message,suggestion};}
  function addIndex(map,value,id){const normalized=key(value);if(!normalized)return;const ids=map.get(normalized)||new Set();ids.add(id);map.set(normalized,ids);}
  function indexes(works){
    const result={works:new Map(),byTitle:new Map(),byIsrc:new Map(),byIswc:new Map(),byTune:new Map(),byIprs:new Map(),byAscap:new Map()};
    for(const work of works){
      result.works.set(work.id,work);addIndex(result.byTitle,work.title,work.id);for(const title of work.alternateTitles||[])addIndex(result.byTitle,title,work.id);
      addIndex(result.byIsrc,work.isrc,work.id);addIndex(result.byIswc,work.iswc,work.id);addIndex(result.byTune,work.tuneCode,work.id);
      addIndex(result.byIprs,work.societies?.IPRS,work.id);addIndex(result.byAscap,work.societies?.ASCAP,work.id);
    }
    return result;
  }
  function partiesFromRecord(record){
    return groups.filter(group=>clean(record[group.prefix+'Name'])).map(group=>{
      const share=clean(record[group.prefix+'Share']);
      return {name:clean(record[group.prefix+'Name']),role:normalizeRole(record[group.prefix+'Role'],group.defaultRole),ipi:clean(record[group.prefix+'Ipi']),society:clean(record[group.prefix+'Society']),share:share===''?null:Number(share.replace(/%$/,'')),importSlot:group.prefix};
    });
  }
  function recordFromWork(work){
    const record={title:clean(work.title),artist:clean(work.artist),isrc:clean(work.isrc),iswc:clean(work.iswc),iprsCode:clean(work.societies?.IPRS),tuneCode:clean(work.tuneCode),ascapCode:clean(work.societies?.ASCAP)};
    const parties=work.parties||[],used=new Set();
    groups.forEach(group=>{
      const pattern=group.prefix.startsWith('composer')?/composer/i:group.prefix.startsWith('author')?/author|lyricist|writer/i:/publisher|label/i;
      const party=parties.find(item=>item.importSlot===group.prefix)||parties.find(item=>!used.has(item)&&pattern.test(clean(item.role)));if(!party)return;used.add(party);
      record[group.prefix+'Role']=clean(party.role);record[group.prefix+'Name']=clean(party.name);record[group.prefix+'Ipi']=clean(party.ipi);record[group.prefix+'Society']=clean(party.society);record[group.prefix+'Share']=party.share===null||party.share===undefined?'':String(party.share);
    });
    return record;
  }
  function existingMatch(record,known){
    const ids=new Set(),reasons=[];let ambiguous='';
    for(const [field,map,label] of [['isrc',known.byIsrc,'ISRC'],['iswc',known.byIswc,'ISWC'],['tuneCode',known.byTune,'Tune Code'],['iprsCode',known.byIprs,'IPRS Work Code'],['ascapCode',known.byAscap,'ASCAP Code']]){
      if(!clean(record[field]))continue;const found=map.get(key(record[field]));if(!found)continue;
      if(found.size>1)ambiguous=`${label} matches more than one database record.`;for(const id of found)ids.add(id);reasons.push(label);
    }
    if(ambiguous)return {error:ambiguous};
    if(ids.size>1)return {error:'The supplied identifiers match different database records.'};
    if(ids.size===1){const id=[...ids][0];return {work:known.works.get(id),reason:reasons.join(' + ')};}
    const titleIds=known.byTitle.get(key(record.title));if(!titleIds)return {};
    let matches=[...titleIds].map(id=>known.works.get(id));
    if(clean(record.artist)){const artist=key(record.artist),byArtist=matches.filter(work=>key(work.artist)===artist);if(byArtist.length)matches=byArtist;}
    return matches.length===1?{work:matches[0],reason:'exact Song Name'}:matches.length>1?{warning:'Song Name matches multiple database records; add an identifier to auto-fill safely.'}:{};
  }
  function enrich(record,match){
    if(!match.work)return [];
    const source=recordFromWork(match.work),filled=[];
    for(const field of fields)if(!clean(record[field])&&clean(source[field])){record[field]=source[field];filled.push(field);}
    return filled;
  }
  function preview(rows,map,existing=[]){
    if(!map.some(field=>['title','isrc','iswc','tuneCode','iprsCode','ascapCode'].includes(field)))throw Error('Map Song Name or at least one identifier before previewing.');
    const selected=map.filter(Boolean);if(new Set(selected).size!==selected.length)throw Error('Map each field only once.');
    if(selected.some(field=>!fields.includes(field)))throw Error('Unknown mapped field.');
    if(rows.length>10000)throw Error('Import at most 10,000 rows at a time.');
    const known=indexes(existing),seenSignatures=new Map(),seen=Object.fromEntries(['isrc','iswc','tuneCode','iprsCode','ascapCode'].map(field=>[field,new Map()]));
    return rows.map((cells,index)=>{
      const record={};map.forEach((field,column)=>{if(field)record[field]=clean(cells[column]);});
      if(!Object.values(record).some(Boolean))return null;
      const issues=[],warnings=[];
      const match=existingMatch(record,known);if(match.error)issues.push(issue('title',record.title,match.error,'Correct the conflicting identifier values.'));if(match.warning)warnings.push(match.warning);
      const filledFields=enrich(record,match);
      if(!record.title)issues.push(issue('title',record.title,'Song Name is required.','Enter a song name or supply an identifier that matches the database.'));
      for(const [field,value] of Object.entries(record))if(value.length>4000)issues.push(issue(field,value,'Value exceeds 4,000 characters.','Shorten this value.'));
      for(const group of groups){
        const name=record[group.prefix+'Name'],ipi=record[group.prefix+'Ipi'],share=record[group.prefix+'Share'],hasDetails=['Role','Ipi','Society','Share'].some(suffix=>clean(record[group.prefix+suffix]));
        if(hasDetails&&!clean(name))issues.push(issue(group.prefix+'Name',name,'Rights-holder details need a name.','Enter the corresponding composer, lyricist/author, or publisher name.'));
        if(clean(ipi)&&!/^\d{1,13}$/.test(clean(ipi)))issues.push(issue(group.prefix+'Ipi',ipi,'CAE/IPI must contain up to 13 digits.','Format the cell as text and remove spaces or punctuation.'));
        if(clean(share)&&(!/^\d+(?:\.\d+)?%?$/.test(clean(share))||Number(clean(share).replace(/%$/,''))>100))issues.push(issue(group.prefix+'Share',share,'Share must be between 0 and 100.','Enter a number from 0 to 100 or leave it blank.'));
      }
      if(!record.isrc&&!record.iswc&&!record.tuneCode&&!record.iprsCode&&!record.ascapCode)warnings.push('No identifier supplied; matching uses the exact Song Name and Singer when available.');
      if(match.work)warnings.push(`Matched ${match.reason}; ${filledFields.length} empty fields auto-filled from the database.`);
      const sig=signature(record);let duplicate=match.work?{reason:match.reason,existingId:match.work.id,sourceRow:null,identifier:match.reason!=='exact Song Name'}:null;
      if(!duplicate)for(const field of Object.keys(seen)){const normalized=key(record[field]);if(normalized&&seen[field].has(normalized)){duplicate={reason:labels[field],existingId:'',sourceRow:seen[field].get(normalized),identifier:true};break;}}
      if(!duplicate&&seenSignatures.has(sig))duplicate={reason:'matching metadata',existingId:'',sourceRow:seenSignatures.get(sig),identifier:false};
      if(!issues.length&&!duplicate){seenSignatures.set(sig,index+2);for(const field of Object.keys(seen)){const normalized=key(record[field]);if(normalized)seen[field].set(normalized,index+2);}}
      return {row:index+2,record,issues,errors:issues.map(item=>item.message),warnings,duplicate,matchedExistingId:match.work?.id||'',matchReason:match.reason||'',filledFields,status:issues.length?'Error':duplicate?'Duplicate':'Ready'};
    }).filter(Boolean);
  }
  function newWork(record,filename){return {
    id:'WRK-'+crypto.randomUUID(),title:record.title,artist:record.artist||'',type:'Song',language:'',
    isrc:record.isrc||'',iswc:record.iswc||'',tuneCode:record.tuneCode||'',label:'',source:'Unknown',status:'Complete',alternateTitles:[],
    societies:{IPRS:record.iprsCode||'',PRS:'',ASCAP:record.ascapCode||''},parties:partiesFromRecord(record),
    research:{source:'',url:'',notes:''},activity:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
  };}
  function updateWork(work,record,filename){
    if(clean(record.artist)&&record.artist!==work.artist)delete work.artistIds;
    for(const field of ['title','artist','isrc','iswc','tuneCode'])if(record[field])work[field]=record[field];
    work.societies??={};if(record.iprsCode)work.societies.IPRS=record.iprsCode;if(record.ascapCode)work.societies.ASCAP=record.ascapCode;
    work.status='Complete';
    for(const incoming of partiesFromRecord(record)){
      const party=(work.parties??=[]).find(item=>incoming.ipi&&item.ipi===incoming.ipi||key(item.name)===key(incoming.name)&&key(item.role)===key(incoming.role));
      if(party)Object.assign(party,{...incoming,artistId:party.artistId});else work.parties.push(incoming);
    }
    work.updatedAt=new Date().toISOString();
  }
  function plan(review,strategy='skip',resolutions={}){
    if(!review.length)throw Error('The selected worksheet has no data rows.');
    if(review.some(row=>row.issues.length))throw Error('Resolve all row errors before importing.');
    return review.map(row=>{
      let action=row.status==='Ready'?'create':strategy==='manual'?(resolutions[row.row]||'skip'):strategy;
      if(row.duplicate?.sourceRow)action='skip';if(action==='update'&&!row.duplicate?.existingId)action='skip';
      if(action==='create'&&row.duplicate?.identifier)throw Error(`Row ${row.row}: ${row.duplicate.reason} already belongs to another song and cannot be duplicated.`);
      return {row,action};
    });
  }
  function execute(state,review,filename,{strategy='skip',resolutions={}}={}){
    const fresh=preview(review.map(row=>fields.map(field=>row.record[field]||'')),fields,state.works);fresh.forEach((row,index)=>row.row=review[index]?.row??row.row);
    const actions=plan(fresh,strategy,resolutions),additions=[],updates=[];
    for(const item of actions){if(item.action==='create')additions.push(newWork(item.row.record,filename));if(item.action==='update')updates.push({id:item.row.duplicate.existingId,record:item.row.record});}
    for(const update of updates)if(!state.works.some(work=>work.id===update.id))throw Error('A duplicate target changed. Preview the file again.');
    for(const update of updates)updateWork(state.works.find(work=>work.id===update.id),update.record,filename);state.works.push(...additions);
    return {added:additions.length,updated:updates.length,skipped:actions.length-additions.length-updates.length,total:actions.length};
  }
  function apply(state,review,filename){return execute(state,review,filename).added;}
  function buildTemplate(library){
    const sheet=library.utils.aoa_to_sheet([templateHeaders]);sheet['!cols']=templateHeaders.map((header,index)=>({wch:index<2?26:['Role','CAE','Society','Share'].includes(header)?14:20}));sheet['!autofilter']={ref:'A1:AJ1'};sheet['!ref']='A1:AJ1000';
    const wb=library.utils.book_new();library.utils.book_append_sheet(wb,sheet,'Sheet1');return wb;
  }
  function filledWorkbook(library,review){const sheet=library.utils.aoa_to_sheet([templateHeaders,...review.map(row=>templateFields.map(field=>row.record[field]??''))]);sheet['!cols']=templateHeaders.map((header,index)=>({wch:index<2?26:['Role','CAE','Society','Share'].includes(header)?14:20}));sheet['!autofilter']={ref:`A1:AJ${Math.max(1,review.length+1)}`};const wb=library.utils.book_new();library.utils.book_append_sheet(wb,sheet,'Sheet1');return wb;}
  function errorReport(review){const rows=[['Row','Column','Uploaded value','Problem','Suggested correction']];for(const row of review)for(const item of row.issues)rows.push([row.row,labels[item.field]||item.field,item.value,item.message,item.suggestion]);return '\ufeff'+rows.map(row=>row.map(csv).join(',')).join('\r\n');}
  function create(ctx){
    let session=null,generation=0;const e=ctx.esc,area=()=>document.getElementById('db-review');
    function template(){XLSX.writeFile(buildTemplate(XLSX),'Upload Format.xlsx');}
    function progress(label,value){if(area())area().innerHTML=`<div class="db-progress" role="status"><strong>${e(label)}</strong><progress max="100" value="${value}">${value}%</progress></div>`;}
    function open(){generation++;session=null;ctx.modal(ctx.modalHead('Database / Data Import')+`<div class="modal-body"><p>Upload the 36-column Upload Format workbook. Song Name, ISRC, ISWC, Tune Code, IPRS Work Code, and ASCAP Code can match existing database records and auto-fill empty columns. Separate multiple singers with commas; each singer will be linked individually. Nothing is saved until confirmation.</p><div class="button-row"><button class="btn" data-db="template">Download Upload Format.xlsx</button></div><label class="db-drop" id="db-drop" for="db-file" tabindex="0"><strong>Drag and drop a file here</strong><span>or browse for .csv or .xlsx · maximum 10 MB</span><input id="db-file" type="file" accept=".xlsx,.csv,text/csv"></label><div id="db-review" aria-live="polite"></div><div class="panel-actions"><button class="btn" data-db="cancel">Cancel import</button></div></div>`);}
    function mapView(){if(!area())return;const s=session;area().innerHTML=`<div class="db-step"><strong>1. File validated</strong><span>${e(s.filename)} · ${s.dataRows.toLocaleString()} data rows</span></div><div class="form-grid"><label>Worksheet<select class="input" id="db-sheet">${s.wb.SheetNames.map(name=>`<option ${name===s.sheet?'selected':''}>${e(name)}</option>`).join('')}</select></label><label>Header row<input class="input" id="db-header" type="number" min="1" max="${s.rows.length}" value="${s.header+1}"></label></div><h3>2. Detected column mapping</h3><p>Change any incorrect match. Unmapped columns are ignored.</p><div class="form-grid db-mapping">${s.map.map((field,index)=>`<label>${e(s.rows[s.header][index]||'Column '+(index+1))}<select class="input" data-db-map="${index}"><option value="">Ignore</option>${fields.map(value=>`<option value="${value}" ${field===value?'selected':''}>${e(labels[value])}</option>`).join('')}</select></label>`).join('')}</div><div class="panel-actions"><button class="btn primary" data-db="preview">Validate and preview</button></div>`;}
    function loadSheet(){const s=session;s.rows=XLSX.utils.sheet_to_json(s.wb.Sheets[s.sheet],{header:1,defval:'',raw:false,blankrows:true});if(!s.rows.length)throw Error('This worksheet is empty.');if(s.rows.length>10001)throw Error('Import at most 10,000 rows at a time.');if(s.rows.some(row=>row.length>100))throw Error('Import at most 100 columns at a time.');s.header=0;s.map=mapping(s.rows[0]);s.dataRows=s.rows.slice(1).filter(row=>row.some(value=>clean(value))).length;s.review=null;mapView();}
    async function readFile(file){const token=++generation;session=null;if(!file)return;try{if(!/\.(xlsx|csv)$/i.test(file.name))throw Error('Choose an .xlsx or .csv file.');if(file.size>10*1024*1024)throw Error('File exceeds 10 MB.');progress('Reading and detecting format…',15);await new Promise(resolve=>setTimeout(resolve,0));progress('Validating workbook structure…',45);const wb=await CueFileSafety.read(file,{extensions:['xlsx','csv'],raw:true});if(token!==generation||!area())return;session={wb,filename:file.name,sheet:wb.SheetNames[0]};loadSheet();}catch(error){if(token===generation&&area()){session=null;area().innerHTML=`<div class="db-error" role="alert"><strong>File could not be validated.</strong><span>${e(error.message)}</span></div>`;}}}
    function report(){if(!session?.review)return;ctx.download(errorReport(session.review),'Database_Import_Errors.csv','text/csv;charset=utf-8');}
    function reviewView(){
      const s=session,count=status=>s.review.filter(row=>row.status===status).length,warnings=s.review.reduce((sum,row)=>sum+row.warnings.length,0),errors=s.review.reduce((sum,row)=>sum+row.issues.length,0),ready=count('Ready'),duplicates=count('Duplicate'),autoFilled=s.review.reduce((sum,row)=>sum+row.filledFields.length,0),matched=s.review.filter(row=>row.matchedExistingId).length,rows=s.review.filter(row=>row.status!=='Ready'||s.review.length<=200).slice(0,500);
      const duplicateRows=s.review.filter(row=>row.status==='Duplicate'),eligible=ready+(s.strategy==='update'?duplicateRows.filter(row=>row.duplicate.existingId&&!row.duplicate.sourceRow).length:s.strategy==='create'?duplicateRows.filter(row=>!row.duplicate.identifier&&!row.duplicate.sourceRow).length:s.strategy==='manual'?duplicateRows.filter(row=>['update','create'].includes(s.resolutions[row.row])).length:0);
      const detail=row=>row.issues.length?row.issues.map(item=>`${labels[item.field]||item.field}: ${item.message} Suggested: ${item.suggestion}`).join(' '):row.matchedExistingId?`Matched ${row.matchReason}. Auto-filled ${row.filledFields.length} fields: ${row.filledFields.map(field=>labels[field]).join(', ')||'record was already complete'}.`:row.duplicate?`Duplicate ${row.duplicate.reason}${row.duplicate.sourceRow?' of row '+row.duplicate.sourceRow:''}`:row.warnings.join(' ')||'Ready to import';
      area().innerHTML=`<h3>3. Validation and database matching</h3><div class="db-summary"><div><strong>${s.review.length}</strong><span>Total rows</span></div><div><strong>${ready}</strong><span>New</span></div><div><strong>${matched}</strong><span>Database matches</span></div><div><strong>${autoFilled}</strong><span>Fields auto-filled</span></div><div><strong>${errors}</strong><span>Errors</span></div></div><div class="button-row"><button class="btn" data-db="filled-file" ${!s.review.length?'disabled':''}>Download auto-filled Excel</button>${errors?'<button class="btn" data-db="error-report">Download error report</button>':''}</div>${errors?`<div class="db-error" role="alert"><strong>Fix the reported rows before importing.</strong><span>No production data has changed.</span></div>`:''}<div class="db-table-wrap"><table class="data-table"><thead><tr><th>Row</th><th>Song Name</th><th>Result</th><th>Details</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${row.row}</td><td>${e(row.record.title)}</td><td>${e(row.status)}</td><td>${e(detail(row))}</td></tr>`).join('')}</tbody></table></div>${s.review.length>rows.length?`<p>Showing ${rows.length} rows. All ${s.review.length} rows were validated.</p>`:''}<h3>4. Duplicate strategy</h3><label>How should existing database records be handled?<select class="input" id="db-strategy"><option value="skip" ${s.strategy==='skip'?'selected':''}>Skip matched records (recommended)</option><option value="update" ${s.strategy==='update'?'selected':''}>Sync uploaded values into matched records</option><option value="create" ${s.strategy==='create'?'selected':''}>Create copies when identifiers allow</option><option value="manual" ${s.strategy==='manual'?'selected':''}>Resolve each match manually</option></select></label>${s.strategy==='manual'&&duplicates?`<div class="db-resolutions">${duplicateRows.map(row=>`<label>Row ${row.row} · ${e(row.record.title)}<select class="input" data-db-resolution="${row.row}"><option value="skip">Skip</option>${row.duplicate.existingId?`<option value="update" ${s.resolutions[row.row]==='update'?'selected':''}>Sync existing</option>`:''}${!row.duplicate.identifier?`<option value="create" ${s.resolutions[row.row]==='create'?'selected':''}>Create new</option>`:''}</select></label>`).join('')}</div>`:''}<div class="panel-actions"><button class="btn" data-db="back">Back to mapping</button><button class="btn primary" data-db="confirm" ${errors||!eligible?'disabled':''}>Confirm import</button></div>`;
    }
    async function change(event){const target=event.target;if(target.id==='db-file'){await readFile(target.files?.[0]);return;}if(!session)return;try{if(target.id==='db-sheet'){session.sheet=target.value;loadSheet();}if(target.id==='db-header'){const value=Number(target.value);if(!Number.isInteger(value)||value<1||value>session.rows.length)throw Error('Choose an existing header row.');session.header=value-1;session.map=mapping(session.rows[session.header]);session.dataRows=session.rows.slice(session.header+1).filter(row=>row.some(value=>clean(value))).length;session.review=null;mapView();}if(target.dataset.dbMap!==undefined){session.map[Number(target.dataset.dbMap)]=target.value;session.review=null;}if(target.id==='db-strategy'){session.strategy=target.value;reviewView();}if(target.dataset.dbResolution!==undefined){session.resolutions[target.dataset.dbResolution]=target.value;reviewView();}}catch(error){ctx.toast(error.message);}}
    function click(event){const action=event.target.closest('[data-db]')?.dataset.db;if(!action)return false;event.preventDefault();try{
      if(action==='open')open();if(action==='template')template();if(action==='filled-file'&&session?.review)XLSX.writeFile(filledWorkbook(XLSX,session.review),'Upload Format - Auto-filled.xlsx');if(action==='cancel'){generation++;session=null;ctx.close();}if(action==='back')mapView();if(action==='error-report')report();
      if(action==='preview'){if(!session)throw Error('Choose a database file.');progress('Checking values and duplicates…',75);session.review=preview(session.rows.slice(session.header+1),session.map,ctx.state().works);session.review.forEach(row=>row.row+=session.header);session.strategy='skip';session.resolutions={};reviewView();}
      if(action==='confirm'){if(!session?.review)throw Error('Validate your file first.');progress('Importing and verifying…',90);const state=ctx.state(),before=structuredClone(state);try{const result=execute(state,session.review,session.filename,{strategy:session.strategy,resolutions:session.resolutions});if(!result.added&&!result.updated)throw Error('No rows are eligible for import with this duplicate strategy.');state.imports.unshift({id:'IMP-'+crypto.randomUUID(),filename:session.filename,sheet:session.sheet,projectId:'',clientId:'',count:result.added+result.updated,newWorks:result.added,matched:result.updated,warnings:session.review.reduce((sum,row)=>sum+row.warnings.length,0),profile:'Song database · '+session.strategy,mapping:session.map,headers:session.rows[session.header],user:'Local administrator',date:new Date().toISOString()});state.activity.unshift({text:`Database import · ${result.added} added, ${result.updated} updated`,date:new Date().toISOString()});if(!ctx.save())throw Error('The import could not be saved. Free device storage and try again.');ctx.render();area().innerHTML=`<div class="db-success" role="status"><strong>Import completed successfully</strong><span>${result.added} added · ${result.updated} updated · ${result.skipped} skipped · ${result.total} verified</span><span>The saved workspace was verified after import.</span></div><div class="panel-actions"><button class="btn primary" data-db="done">Done</button></div>`;ctx.toast('Database import completed.');}catch(error){Object.keys(state).forEach(key=>delete state[key]);Object.assign(state,before);reviewView();throw error;}}
      if(action==='done'){generation++;session=null;ctx.close();}
    }catch(error){ctx.toast(error.message);if(area()&&!session?.review)area().innerHTML=`<div class="db-error" role="alert">${e(error.message)}</div>`;}return true;}
    document.addEventListener('dragover',event=>{if(event.target.closest?.('#db-drop')){event.preventDefault();event.dataTransfer.dropEffect='copy';}});
    document.addEventListener('drop',event=>{if(event.target.closest?.('#db-drop')){event.preventDefault();readFile(event.dataTransfer.files?.[0]);}});
    document.addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&event.target.id==='db-drop'){event.preventDefault();document.getElementById('db-file')?.click();}});
    return {click,change};
  }
  const api={schema,fields,labels,templateFields,templateHeaders,mapping,normalizeRole,preview,plan,execute,apply,buildTemplate,filledWorkbook,errorReport,create};if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.CueDatabaseImport=api;
})(typeof window==='undefined'?null:window);

/* app.prototype.js */

/* insights.js — derived metrics, rebuilt from the current workspace without extra reads. */
(function(root){
  'use strict';
  const clean=value=>String(value??'').trim();
  const normalize=value=>clean(value).normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  const role=party=>clean(party.role).toLocaleLowerCase();
  const timestamp=value=>value&&Number.isFinite(Date.parse(value))?value:'';
  const updated=work=>timestamp(work.updatedAt)||timestamp(work.activity?.[0]?.date)||timestamp(work.createdAt);
  const duration=value=>typeof value==='number'?value:root.CueDomain?.seconds(value);
  function analyze(state){
    const works=state.works||[],artists=state.artists||[],projects=state.projects||[],cues=state.cues||[];
    const worksById=new Map(works.map(work=>[work.id,work])),artistsById=new Map(artists.map(artist=>[artist.id,artist])),projectsById=new Map(projects.map(project=>[project.id,project]));
    const workData=new Map(),projectData=new Map(),titles=new Map(),societyArtists=root.CueSocieties?.indexArtists(artists)||artists;
    const quality={missingArtist:[],missingComposer:[],missingLyricist:[],missingIsrc:[],missingPrs:[],missingDuration:[],missingSociety:[],duplicateSongs:[],unevenShares:[],incompleteCues:[]};
    for(const work of works){
      const parties=work.parties||[],linked=(work.artistIds||[]).map(id=>artistsById.get(id)).filter(Boolean);
      const contributorIds=new Set([...linked.map(artist=>artist.id),...parties.map(party=>party.artistId).filter(id=>artistsById.has(id))]);
      const memberships=root.CueSocieties?.workSocieties(work,societyArtists)||[];
      const record={work,cues:[],projectIds:new Set(),episodes:new Map(),artistIds:contributorIds,memberships,duration:0,artistNames:linked.map(artist=>artist.name).join(', ')||work.artist||'',updated:updated(work),issues:[]};
      const add=(key,condition)=>{if(condition){quality[key].push(work.id);record.issues.push(key);}};
      add('missingArtist',!clean(record.artistNames));
      add('missingComposer',!parties.some(party=>['composer','c','ca','composer/author'].includes(role(party))&&clean(party.name)));
      add('missingLyricist',!parties.some(party=>['lyricist','author','a','ca','composer/author'].includes(role(party))&&clean(party.name)));
      add('missingIsrc',!clean(work.isrc));add('missingPrs',!clean(work.societies?.PRS)&&!clean(work.tuneCode));
      add('missingDuration',!(duration(work.recordingDuration||work.duration)>0));add('missingSociety',!memberships.length);
      const total=parties.reduce((sum,party)=>sum+(Number(party.share)||0),0);
      add('unevenShares',!parties.length||parties.some(party=>!clean(party.name)||party.share==null||clean(party.share)===''||!Number.isFinite(Number(party.share))||Number(party.share)<0||Number(party.share)>100)||Math.abs(total-100)>.010000001);
      workData.set(work.id,record);
      const name=normalize(work.title);if(name){if(!titles.has(name))titles.set(name,[]);titles.get(name).push(work.id);}
    }
    for(const ids of titles.values())if(ids.length>1)for(const id of ids){quality.duplicateSongs.push(id);workData.get(id).issues.push('duplicateSongs');}
    let episodes=0,musicDuration=0;
    for(const project of projects){const episodeCount=project.type==='Movie'?0:new Set((project.episodes||[]).map(item=>String(item.number))).size;episodes+=episodeCount;projectData.set(project.id,{project,cues:0,songs:new Set(),artists:new Set(),duration:0,episodes:episodeCount,episodeNumbers:new Set((project.episodes||[]).map(episode=>Number(episode.number))),units:project.type==='Movie'?1:episodeCount});}
    for(const cue of cues){
      const work=workData.get(cue.workId),project=projectData.get(cue.projectId),seconds=Number(cue.duration),validDuration=Number.isFinite(seconds)&&seconds>0;
      const used=validDuration?seconds:0;musicDuration+=used;
      if(work){work.cues.push(cue);work.duration+=used;work.projectIds.add(cue.projectId);if(project?.project.type!=='Movie'&&cue.episode!=null){const key=cue.projectId+'::'+cue.episode;const usage=work.episodes.get(key)||{projectId:cue.projectId,number:cue.episode,cues:0,duration:0};usage.cues++;usage.duration+=used;work.episodes.set(key,usage);}}
      if(project){project.cues++;project.duration+=used;if(work){project.songs.add(cue.workId);for(const id of work.artistIds)project.artists.add(id);}}
      const missingEpisode=project?.project.type!=='Movie'&&(!Number.isInteger(Number(cue.episode))||!project?.episodeNumbers.has(Number(cue.episode)));
      const cumulativeTiming=Array.isArray(cue.occurrences)&&cue.occurrences.length>1&&cue.occurrences.every(use=>Number.isFinite(use.start)&&Number.isFinite(use.end)&&use.end>use.start&&use.duration===use.end-use.start);
      if(!work||!project||!clean(work?.work.title)||!validDuration||!clean(cue.usage)||work?.issues.includes('unevenShares')||missingEpisode||!cumulativeTiming&&(cue.start==null||cue.start===''||cue.end==null||cue.end===''||!Number.isFinite(Number(cue.start))||!Number.isFinite(Number(cue.end))||Number(cue.end)<Number(cue.start)))quality.incompleteCues.push(cue.id);
    }
    const society=root.CueSocieties?.summary({works,cues,artists})||{};
    const recentSongs=(field)=>works.filter(work=>timestamp(work[field])).slice().sort((a,b)=>Date.parse(b[field])-Date.parse(a[field])).slice(0,5);
    const recentEpisodes=[];for(const project of projects)for(const episode of project.episodes||[]){const date=timestamp(episode.createdAt)||timestamp(episode.updatedAt);if(date)recentEpisodes.push({projectId:project.id,projectTitle:project.title,...episode,date});}recentEpisodes.sort((a,b)=>Date.parse(b.date)-Date.parse(a.date));
    const exportHistory=new Map();for(const record of state.exports||[]){const ids=new Set((record.snapshot?.cues||[]).map(cue=>cue.workId));for(const id of ids){if(!exportHistory.has(id))exportHistory.set(id,[]);exportHistory.get(id).push(record);}}
    return {worksById,artistsById,projectsById,workData,projectData,quality,society,exportHistory,movies:projects.filter(project=>project.type==='Movie').length,serials:projects.filter(project=>project.type!=='Movie').length,episodes,musicDuration,missingSongs:[...workData.values()].filter(record=>record.issues.length).length,averageCue:cues.length?musicDuration/cues.length:0,averageUsage:projects.length?musicDuration/projects.length:0,recent:{added:recentSongs('createdAt'),edited:recentSongs('updatedAt'),episodes:recentEpisodes.slice(0,5),exports:(state.exports||[]).slice().sort((a,b)=>(Date.parse(b.date)||0)-(Date.parse(a.date)||0)).slice(0,5)}};
  }
  const cache=new WeakMap();
  function get(state,revision){if(revision===undefined)return analyze(state);const cached=cache.get(state);if(cached?.revision===revision)return cached.value;const value=analyze(state);cache.set(state,{revision,value});return value;}
  root.CueInsights={analyze,get,updated};
})(typeof window==='undefined'?globalThis:window);
/* insights.js end */

/* Cue Rights Manager — local browser workspace. */
(async () => {
'use strict';
const D=CueDomain, KEY='cue-rights-local-sqlite-v1'+(window.CueAuth?.user?':'+window.CueAuth.user.id:''), THEME_KEY='cue-rights-theme';
let state,storageError=false,modalDraft=false,modalTrigger=null,dataRevision=0,workspaceClosed=false,historyRetentionTimer=null,databaseActionBusy=false;
const systemTheme=window.matchMedia('(prefers-color-scheme: dark)');
let themePreference='system';
try{const saved=localStorage.getItem(THEME_KEY);if(['light','dark','system'].includes(saved))themePreference=saved;}catch(_error){}
let theme=themePreference==='system'?(systemTheme.matches?'dark':'light'):themePreference;
document.documentElement.dataset.theme=theme;
let legacyPending=false;
try{const oldRaw=localStorage.getItem(KEY),oldMeta=JSON.parse(localStorage.getItem(KEY+':sync')||'null');legacyPending=!!oldRaw&&(!oldMeta||oldMeta.pending);}catch(_error){legacyPending=true;}
const localRecords=['','localhost','127.0.0.1','[::1]'].includes(location.hostname)&&window.CueLocalRecords&&!legacyPending;
const persistence=localRecords
  ? CueLocalRecords.create({key:KEY,onReplace:()=>location.reload()})
  : CuePersistence.create({key:KEY,...(legacyPending?{}:{resetId:'2026-10-10-cms-data-reset'}),onReplace:()=>location.reload()});
window.addEventListener('amishna-auth-expired',()=>{
  clearInterval(historyRetentionTimer);
  workspaceClosed=true;modalDraft=false;persistence.destroy();state=null;
  window.AmishnaGlass?.destroy();document.body.style.overflow='';
  window.CueAuth?.lock();
});
window.addEventListener('pagehide',event=>{if(event.persisted)return;clearInterval(historyRetentionTimer);workspaceClosed=true;modalDraft=false;persistence.destroy();window.AmishnaGlass?.destroy();state=null;document.body.style.overflow='';});
persistence.mount(document.getElementById('sync-root'));
new ResizeObserver(entries=>document.documentElement.style.setProperty('--sync-height',Math.ceil(entries[0].contentRect.height)+'px')).observe(document.getElementById('sync-root'));

state=await persistence.load(CueSeed);
if(workspaceClosed){state=null;return;}
const historyMigrated=CueHistoryRetention.prune(state).total>0;
const cumulativeMigrated=D.combineImportedOccurrences(state);
const usageMigrated=D.applyTitleUsage(state);
const catalogMigrated=CueCatalog.ensure(state);
const routePages=new Set(['dashboard','search','projects','cues','builder','works','artists','clients','societies','exports','repositories','reports','members','settings','import']);
function decodeRoute(hash){try{return decodeURIComponent(String(hash||'').replace(/^#/,''));}catch{return 'dashboard';}}
const requestedRoute=decodeRoute(location.hash);
let page=requestedRoute==='research'?'works':routePages.has(requestedRoute)?requestedRoute:'dashboard',query='',cueProject='All',cueListPage=1,importHistoryPage=1,modalWork=null,workTab='Overview',exportSociety='IPRS',exportProject='PRJ-001',exportEpisode=49;
if(requestedRoute==='research')history.replaceState({page:'works'},'','#works');
let importQueue=[],importReadProgress=null,importDefaultType='Series',bulkImportSummary=null,bulkImportPending=null,bulkImportActive=false,googleSheetBusy=false,googleSheetError='',googleSheetSelection=null,importSourceMode='excel',importTargetProjectId=null,importModalSource='excel',importModalProjectId=null,excelSelection=[],excelInspectBusy=false,excelSelectionError='';
persistence.subscribe(updateBulkImportSyncStatus);
const icons={copy:'M8 8h13v13H8z M16 8V3H3v13h5',trash:'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',folder:'M3 7h7l2-3h8a1 1 0 0 1 1 1v14H3z',users:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M17 4a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-4',music:'M9 18V5l12-2v13 M9 8l12-2 M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M18 13a3 3 0 1 0 0 6 3 3 0 0 0 0-6',list:'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',upload:'M12 16V3 M7 8l5-5 5 5 M3 15v6h18v-6',search:'M21 21l-5-5 M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16',globe:'M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0 M3 12h18 M12 3c5 5 5 13 0 18-5-5-5-13 0-18',download:'M12 3v13 M7 11l5 5 5-5 M3 16v5h18v-5',chart:'M4 20V10 M10 20V4 M16 20v-7 M22 20H2',settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z',arrow:'M5 12h14 M14 7l5 5-5 5',chevron:'M9 5l7 7-7 7',down:'M6 9l6 6 6-6',plus:'M12 5v14 M5 12h14',check:'M5 12l4 4L19 6',clock:'M12 8v5l3 2 M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0',alert:'M12 8v5 M12 17h.01 M10 3L1 20h22L14 3z',file:'M14 2H4v20h16V8z M14 2v6h6 M8 12h8 M8 16h8',bell:'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 10h18c0-3-3-3-3-10 M10 21h4',close:'M6 6l12 12 M6 18L18 6',film:'M3 3h18v18H3z M7 3v18 M17 3v18 M3 8h4 M3 16h4 M17 8h4 M17 16h4',shield:'M12 2l9 4v7c0 5-9 9-9 9s-9-4-9-9V6z M8 12l3 3 5-6',menu:'M3 6h18 M3 12h18 M3 18h18',help:'M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 3 M12 17h.01 M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0',moon:'M20.5 14.2A8 8 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2z',sun:'M12 3V1 M12 23v-2 M4.2 4.2 2.8 2.8 M21.2 21.2l-1.4-1.4 M3 12H1 M23 12h-2 M4.2 19.8l-1.4 1.4 M21.2 2.8l-1.4 1.4 M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0'};
icons.refresh='M20 7v5h-5 M4 17v-5h5 M5.5 9A7 7 0 0 1 18 7l2 5 M4 12l2 5a7 7 0 0 0 12.5-2';
const icon=name=>`<svg aria-hidden="true" viewBox="0 0 24 24"><path d="${icons[name]||icons.file}"/></svg>`;
function appearanceButton(){return `<button type="button" class="theme-toggle appearance-trigger" data-action="appearance-studio" aria-label="Open Appearance Studio" aria-haspopup="dialog" aria-expanded="false" title="Appearance Studio">${icon('settings')}<span>Appearance</span></button>${window.CueAuth?.controls?.()||''}`;}
function applyTheme(next){
  themePreference=['light','dark','system'].includes(next)?next:'system';
  theme=themePreference==='system'?(systemTheme.matches?'dark':'light'):themePreference;
  document.documentElement.dataset.theme=theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='dark'?'#191d1f':'#1b3443');
  try{localStorage.setItem(THEME_KEY,themePreference);}catch(_error){}
  document.querySelectorAll('[data-theme-choice]').forEach(button=>{const selected=button.dataset.themeChoice===themePreference;button.classList.toggle('active',selected);button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));});
  window.AmishnaAppearance?.sync();
}
window.AmishnaAppearance?.configure({getMode:()=>themePreference,setMode:applyTheme});
systemTheme.addEventListener('change',()=>{if(themePreference==='system')applyTheme('system');});
applyTheme(themePreference);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const administratorName=()=>window.CueAuth?.user?.name||'Administrator';
const uid=prefix=>prefix+'-'+crypto.randomUUID().slice(0,8);
const date=v=>new Date(v).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'});
function toast(message){const el=document.querySelector('#toast');el.textContent=message;el.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('show'),4200);}
function save(){if(workspaceClosed||!state)return false;dataRevision++;lookupState=null;CueHistoryRetention.prune(state);CueCatalog.ensure(state);D.applyTitleUsage(state);if(persistence.save(state)){storageError=false;modalDraft=false;queueMicrotask(()=>persistence.setDraft?.(!!UI?.hasDraft?.()));return true;}storageError=true;toast(persistence.getStatus().message||'This change could not be saved.');return false;}
function cleanupExpiredHistory(){
  if(workspaceClosed||!state)return false;
  const syncStatus=persistence.getStatus();
  if(modalDraft||UI.hasDraft?.()||syncStatus.draft||['conflict','update-available'].includes(syncStatus.kind)||bulkImportActive||bulkImportPending||googleSheetBusy||restoreBackupBusy||ExportDialog.isBusy?.())return false;
  if(document.querySelector('#modal-root .modal')||document.activeElement?.matches('input, textarea, select, [contenteditable="true"]'))return false;
  const previous={imports:state.imports,exports:state.exports};
  if(!CueHistoryRetention.prune(state).total)return false;
  if(!save()){state.imports=previous.imports;state.exports=previous.exports;return false;}
  renderPage();return true;
}
function commit(message,change=()=>{}){const before=structuredClone(state);try{change(state);state.activity??=[];state.activity.unshift({text:message,date:new Date().toISOString()});if(save())return true;}catch(error){toast(error.message||'This change could not be saved.');}state=before;return false;}
const btn=(label,action,ico='',kind='')=>`<button class="btn ${kind}" data-action="${action}">${ico?icon(ico):''}${label}</button>`;
const badge=(text,color='')=>`<span class="badge ${color}"><i class="dot"></i>${esc(text)}</span>`;
const statusBadge=status=>badge(status,['Complete','Society Verified'].includes(status)?'green':status==='Researching'?'amber':status==='Not Researched'?'gray':'blue');
const empty=(title,description)=>`<div class="empty">${icon('file')}<strong>${title}</strong>${description}</div>`;
const options=(items,selected)=>items.map(item=>{const value=typeof item==='object'?item.value:item,label=typeof item==='object'?item.label:item;return `<option value="${esc(value)}" ${String(value)===String(selected)?'selected':''}>${esc(label)}</option>`;}).join('');
let lookupState=null,lookupRevision=-1,lookupMaps;
function lookups(){if(lookupState!==state||lookupRevision!==dataRevision){lookupState=state;lookupRevision=dataRevision;lookupMaps={clients:new Map(state.clients.map(x=>[x.id,x])),works:new Map(state.works.map(x=>[x.id,x])),projects:new Map(state.projects.map(x=>[x.id,x]))};}return lookupMaps;}
const clientName=id=>lookups().clients.get(id)?.name||'Unknown client';
const workName=id=>lookups().works.get(id)?.title||'Unresolved Work';
const projectName=id=>lookups().projects.get(id)?.title||'Unknown project';
const nav=[['dashboard','Overview','grid'],['search','Search','search'],['projects','Projects','folder'],['cues','Cues / Workfile','list'],['works','Song database','music'],['artists','Artist database','users'],['clients','Clients','users'],['societies','Societies','globe'],['exports','Exports','download'],['repositories','Repositories','folder'],['reports','Reports','chart'],['members','Team','users'],['settings','Settings','settings']];
const hostedWorkspace=()=>!['','localhost','127.0.0.1','[::1]'].includes(location.hostname);
function pageTitle(){return page==='builder'?'Cues / Workfile':page==='import'?'Import workfiles':(nav.find(n=>n[0]===page)?.[1]||'Overview');}
function shell(){
  const accountName=administratorName(),accountInitials=accountName.trim().split(/\s+/).slice(0,2).map(part=>part[0]).join('').toUpperCase();
  if(!document.querySelector('#app > .shell'))document.querySelector('#app').innerHTML=`<div class="shell"><aside id="workspace-navigation" class="sidebar lg-navigation" aria-label="Workspace navigation" tabindex="-1" data-glass-light><button type="button" class="icon-button navigation-close" data-action="close-navigation" aria-label="Close navigation">${icon('close')}</button><button class="brand amishna-brand" data-nav="dashboard" aria-label="Amishna Music overview"><span class="brand-art"><img src="assets/amishna-logo.png" alt="Amishna Music" width="1080" height="1350"></span><span class="brand-name">Amishna Music<small>MUSIC RIGHTS WORKSPACE</small></span></button><div class="nav-caption">WORKSPACE</div><nav class="nav-section">${nav.slice(0,7).map(navItem).join('')}</nav><div class="nav-caption">RIGHTS &amp; DELIVERY</div><nav class="nav-section">${nav.slice(7).map(navItem).join('')}</nav><div class="sidebar-bottom"><button class="user account-button" data-nav="settings"><span class="avatar">${esc(accountInitials)}</span><span><strong>${esc(accountName)}</strong><small>Settings</small></span>${icon('settings')}</button></div></aside><button type="button" class="navigation-backdrop" data-action="close-navigation" aria-label="Close navigation" tabindex="-1"></button><main class="main"><header class="topbar lg-toolbar"><button class="icon-button mobile-menu" data-action="menu" aria-label="Toggle navigation" aria-controls="workspace-navigation" aria-expanded="false">${icon('menu')}</button><div class="breadcrumb"><span class="header-brand">Amishna Music</span><span>/</span><strong>${pageTitle()}</strong></div><div class="top-actions"><form id="global-search" class="search-box" data-glass-light>${icon('search')}<input name="search" aria-label="Search the workspace" placeholder="Search the workspace…" autocomplete="off"><span class="key">↵</span></form>${appearanceButton()}</div></header><div class="content"><div id="page"></div><footer class="footer"><span>${icon('shield')} Amishna Music · Music rights, thoughtfully managed.</span><span><i class="dot"></i>${hostedWorkspace()?'Online':'Local'} workspace</span></footer></div></main></div>`;
  document.querySelectorAll('.nav-item').forEach(item=>{const selected=item.dataset.nav===page||(page==='builder'&&item.dataset.nav==='cues');item.classList.toggle('active',selected);if(selected)item.setAttribute('aria-current','page');else item.removeAttribute('aria-current');});
  document.querySelector('.breadcrumb strong').textContent=pageTitle();
  document.title=pageTitle()+' · Amishna Music';
  AmishnaAccessibility.closeNavigation();
  renderPage();
}
function navItem([id,label,ico]){return `<button class="nav-item ${(page===id||(page==='builder'&&id==='cues'))?'active':''}" data-nav="${id}">${icon(ico)}${label}</button>`;}
function heading(title,sub,actions='',eyebrow=''){return `<div class="page-heading"><div>${eyebrow?`<div class="eyebrow">${eyebrow}</div>`:''}<h1>${title}</h1><p class="subtitle">${sub}</p></div><div class="button-row">${actions}</div></div>`;}
function go(target,{historyMode='push',preserveQuery=false,importProjectId=null,importSource='excel'}={}){if(!routePages.has(target))target='dashboard';const changed=page!==target;if(page==='builder'&&!UI.flush()){if(historyMode==='none')history.pushState({page},'',`#${page}`);return false;}page=target;importTargetProjectId=target==='import'&&state.projects.some(project=>project.id===importProjectId)?importProjectId:null;if(target==='import')importSourceMode=importSource==='google'?'google':'excel';if(!preserveQuery)query='';if(historyMode==='push'&&location.hash!==`#${target}`)history.pushState({page:target},'',`#${target}`);shell();window.scrollTo(0,0);if(changed)AmishnaAccessibility.focusPage();return true;}
function renderPage(){
  window.AmishnaGlass?.reset();
  if(!state||workspaceClosed)return;
  const previousTabs=document.querySelector('#page .cr-tabs-scroll');
  const episodeScroll=previousTabs?{projectId:previousTabs.dataset.projectId,left:previousTabs.scrollLeft}:null;
  const rangeScroll=page==='import'?document.querySelector('#page .wi-range-list')?.scrollTop:null;
  const activeRange=page==='import'&&document.activeElement?.dataset?.excelRange?{index:document.activeElement.dataset.excelIndex,bound:document.activeElement.dataset.excelRange}:null;
  const activeGoogleRange=page==='import'?document.activeElement?.dataset?.googleRange:null;
  document.body.classList.add('ux-modern');const views={dashboard:Portfolio.overview,search:Discovery.search,projects:Portfolio.projects,builder:()=>UI.builder(),members:()=>UI.members(),works:Catalog.songs,artists:Catalog.artists,clients:Management.clients,cues,import:importView,societies,exports:Discovery.exports,repositories:Management.repositories,reports,settings};document.querySelector('#page').innerHTML=(views[page]||Portfolio.overview)();UI.mount(page);if(page==='builder')window.initModernCueResizer?.();
  // Replacing the page recreates the strip; keep the user's place within this project.
  const tabs=document.querySelector('#page .cr-tabs-scroll');
  if(tabs&&episodeScroll&&tabs.dataset.projectId===episodeScroll.projectId)tabs.scrollLeft=episodeScroll.left;
  if(rangeScroll!=null){const list=document.querySelector('#page .wi-range-list');if(list)list.scrollTop=rangeScroll;}
  if(activeRange)document.querySelector(`#page [data-excel-index="${activeRange.index}"][data-excel-range="${activeRange.bound}"]`)?.focus({preventScroll:true});
  if(activeGoogleRange)document.querySelector(`#page [data-google-range="${activeGoogleRange}"]`)?.focus({preventScroll:true});
}
function metric(label,value,ico,foot,color=''){return `<div class="metric"><div class="metric-top">${label}<span class="metric-icon ${color}">${icon(ico)}</span></div><div class="metric-number">${value}</div><div class="metric-foot">${foot}</div></div>`;}
function cues(){
  if(!state.projects.length)return heading('Music cues','',btn('New project','new-project','plus','primary'))+'<section class="panel"><div class="ux-empty"><h2>Create a project to add music cues</h2><button class="btn primary" data-action="new-project">New project</button></div></section>';
  const rows=state.cues.filter(c=>(cueProject==='All'||c.projectId===cueProject)&&workName(c.workId).toLowerCase().includes(query.toLowerCase()));
  const pageSize=100,pages=Math.max(1,Math.ceil(rows.length/pageSize));cueListPage=Math.min(cueListPage,pages);
  const first=(cueListPage-1)*pageSize,visible=rows.slice(first,first+pageSize);
  const pager=rows.length>pageSize?`<div class="am-pagination"><span>${first+1}–${Math.min(first+pageSize,rows.length)} of ${rows.length} cues</span><div><button type="button" class="btn small" data-action="cues-prev" ${cueListPage===1?'disabled':''}>Previous</button><span>${cueListPage} / ${pages}</span><button type="button" class="btn small" data-action="cues-next" ${cueListPage===pages?'disabled':''}>Next</button></div></div>`:'';
  return heading('Every cue has a home.','Usage-specific timing, linked to your permanent Work records.',btn('Add cue','add-music-cue','plus','primary')+btn('Import workfile','upload','upload'))+`<div class="panel"><div class="filterbar"><input id="cue-search" class="input input-search" placeholder="Search cue titles…" aria-label="Search cues" value="${esc(query)}"><select id="cue-project" class="input" aria-label="Filter project">${options([{value:'All',label:'All projects'},...state.projects.map(p=>({value:p.id,label:p.title}))],cueProject)}</select><span class="muted">${rows.length} cues · ${D.time(rows.reduce((sum,c)=>sum+c.duration,0))}</span></div><div class="table-wrap"><table><thead><tr><th>WORK</th><th>PROJECT / CONTENT</th><th>IN</th><th>OUT</th><th>DURATION</th><th>USAGE</th><th>SOURCE</th></tr></thead><tbody>${visible.map(c=>{const multi=c.occurrences?.length>1;return `<tr><td><button class="link-button" data-work="${esc(c.workId)}">${esc(workName(c.workId))}</button>${multi?`<div class="cell-meta">${c.occurrences.length} plays · ${D.time(c.duration)} total</div>`:''}<button class="link-button" data-edit-cue="${esc(c.id)}">Open cue</button></td><td>${esc(projectName(c.projectId))}<div class="cell-meta">${c.episode?'Episode '+c.episode:'Movie'}</div></td><td class="mono">${multi?'Multiple plays':D.time(c.start)}</td><td class="mono">${multi?c.occurrences.length+' plays':D.time(c.end)}</td><td class="mono">${D.time(c.duration)}</td><td>${badge(c.usage||'Missing',c.usage?'gray':'rose')}</td><td>${badge(c.source,c.source==='Third-party'?'amber':'green')}</td></tr>`;}).join('')}</tbody></table></div>${!rows.length?empty('No cues yet','Add a cue or import a workfile to get started.'):''}${pager}</div>`;
}
function societies(){return heading('Three societies. One database.','Mappings are separate from your permanent Work and cue records.')+`<div class="notice">Every export is generated inside the supplied reference workbook, preserving its styling, merged cells, widths and print layout. Only Music usage, duration, named contributors and shares totaling 100% are required.</div><div class="card-grid">${['IPRS','PRS','ASCAP'].map(s=>`<section class="society-card"><div class="society-logo">${s}</div>${badge('Reference template · '+(s==='ASCAP'?'v1.1':'v1.0'),'green')}<p>${s==='IPRS'?'Contributors are written on separate rows.':s==='PRS'?'Interested parties are written on separate rows.':'Writer shares go to Column E and publisher/label shares go to Column F; ASCAP output doubles them to the 200% scale.'} Optional identifiers remain blank when they are not available.</p><p><strong>${state.works.filter(w=>w.societies[s]).length} / ${state.works.length}</strong> Works with a ${s} identifier</p><div class="progress-track"><span style="width:${100*state.works.filter(w=>w.societies[s]).length/Math.max(state.works.length,1)}%"></span></div><div class="button-row spacer"><a class="btn small" href="${s}-verification.xlsx" download>${icon('download')}Reference workbook</a><button class="btn small" data-society="${s}">Open export</button></div></section>`).join('')}</div><div class="spacer"></div>`;}
function reports(){
  const a=window.CueInsights.get(state,dataRevision),q=a.quality,entries=[['Total movies',a.movies,'film','Feature productions'],['Total serials',a.serials,'folder','Series productions'],['Total episodes',a.episodes,'list','Saved episodes'],['Total songs',state.works.length,'music','Master recordings'],['Total artists',state.artists.length,'users','People & publishers'],['Total cues',state.cues.length,'list','Combined cue records'],['Total plays',state.cues.reduce((sum,c)=>sum+(c.occurrences?.length||Number(c.usageCount)||1),0),'list','Original music appearances'],['Total music duration',D.time(a.musicDuration),'clock','All cue occurrences'],['IPRS artists',a.society.IPRS?.artists||0,'globe','IPRS members'],['PRS artists',a.society.PRS?.artists||0,'globe','PRS members'],['ASCAP artists',a.society.ASCAP?.artists||0,'globe','ASCAP members'],['Songs with missing information',a.missingSongs,'alert','Metadata & quality review'],['Cues requiring attention',q.incompleteCues.length,'alert','Timing, links, usage or rights']];
  const qualities=[['missingArtist','Missing artist'],['missingComposer','Missing composer'],['missingLyricist','Missing lyricist'],['missingIsrc','Missing ISRC'],['missingPrs','Missing PRS code'],['missingDuration','Missing song duration'],['missingSociety','Missing society'],['duplicateSongs','Possible duplicate songs'],['unevenShares','Uneven ownership shares']];
  const recent=(title,items,render)=>`<section class="report-activity-group"><h3>${title}</h3>${items.length?items.map(render).join(''):'<p class="muted">No dated activity recorded yet.</p>'}</section>`;
  const songActivity=(work,field)=>`<div class="report-activity"><button type="button" class="link-button" data-catalog="song-open" data-id="${esc(work.id)}">${esc(work.title)}</button><time>${esc(date(work[field]))}</time></div>`;
  return `<div class="insights-page">${heading('Your workspace, in view.','A live overview of your productions, music library and rights.',btn('Download cue report','report-download','download'),'AMISHNA MUSIC · REPORTS')}<div class="report-metric-grid">${entries.map(([label,value,ico,foot])=>metric(label,value,ico,foot)).join('')}</div>
    <section class="panel report-project-panel"><div class="panel-head"><div><h2>Production overview</h2><p class="subtitle">Music usage across every movie and serial</p></div><button type="button" class="btn small" data-nav="projects">Open projects ${icon('arrow')}</button></div><div class="report-average-row"><div><span>Average music / project</span><strong>${D.time(a.averageUsage)}</strong></div><div><span>Average cue duration</span><strong>${D.time(a.averageCue)}</strong></div><div><span>Unique songs used</span><strong>${[...a.workData.values()].filter(record=>record.cues.length).length}</strong></div></div>${state.projects.length?`<div class="table-wrap"><table class="report-project-table"><thead><tr><th>Production</th><th>Episodes</th><th>Songs</th><th>Artists</th><th>Cues</th><th>Music usage</th><th>Avg. / episode or movie</th><th>Avg. cue</th></tr></thead><tbody>${[...a.projectData.values()].map(record=>`<tr><td><button class="link-button" data-project="${esc(record.project.id)}">${esc(record.project.title)}</button><span class="cell-meta">${record.project.type==='Movie'?'Movie':'Serial'}</span></td><td>${record.project.type==='Movie'?'—':record.episodes}</td><td>${record.songs.size}</td><td>${record.artists.size}</td><td>${record.cues}</td><td class="mono">${D.time(record.duration)}</td><td class="mono">${record.units?D.time(record.duration/record.units):'—'}</td><td class="mono">${record.cues?D.time(record.duration/record.cues):'—'}</td></tr>`).join('')}</tbody></table></div>`:empty('Your first production starts here','Create a movie or serial to see project insights.')}</section>
    <section class="report-society-section"><div class="report-section-title"><div><h2>Society membership</h2><p>Each society includes its members and contributors marked Non Member. Dual members appear in each relevant society.</p></div><button type="button" class="btn small" data-nav="artists">Manage artists ${icon('arrow')}</button></div><div class="report-society-grid">${['IPRS','PRS','ASCAP'].map(name=>{const item=a.society[name]||{artists:0,songs:0,cues:0,duration:0};return `<article class="panel report-society-card"><div class="report-society-title"><h3>${name}</h3>${icon('globe')}</div><div class="report-society-number">${item.artists}<span>artists</span></div><dl><div><dt>Songs with eligible rights holders</dt><dd>${item.songs}</dd></div><div><dt>Cue appearances</dt><dd>${item.cues}</dd></div><div><dt>Music usage</dt><dd>${D.time(item.duration)}</dd></div></dl><button type="button" class="btn small ghost" data-society="${name}">Prepare ${name} export ${icon('arrow')}</button></article>`;}).join('')}</div><p class="report-context">${a.society.prsOnlyArtists||0} PRS-only artists are excluded from IPRS exports. ${a.society.unknownArtists||0} artists have no recorded society. Songs and usage count eligible rights holders; one song can appear in multiple societies.</p></section>
    <div class="report-lower-grid"><section class="panel report-quality"><div class="panel-head"><div><h2>Data quality</h2><p class="subtitle">Find the records that could use a little attention</p></div>${badge(a.missingSongs?'Review suggested':'Up to date',a.missingSongs?'amber':'green')}</div><div class="report-quality-list">${qualities.map(([key,label])=>`<button type="button" data-catalog="song-quality" data-id="${key}"><span>${label}</span><strong class="${q[key].length?'needs-review':''}">${q[key].length}</strong>${icon('arrow')}</button>`).join('')}<button type="button" data-nav="cues"><span>Incomplete cue information</span><strong class="${q.incompleteCues.length?'needs-review':''}">${q.incompleteCues.length}</strong>${icon('arrow')}</button></div><p class="report-context">These are review suggestions. Optional identifiers and non-applicable lyricist fields remain optional. Matching song titles may be valid alternate recordings.</p></section>
    <section class="panel report-recent"><div class="panel-head"><div><h2>Recent activity</h2><p class="subtitle">The latest changes across your workspace</p></div>${icon('clock')}</div><div class="report-activity-grid">${recent('Songs added',a.recent.added,work=>songActivity(work,'createdAt'))}${recent('Songs edited',a.recent.edited,work=>songActivity(work,'updatedAt'))}${recent('Episodes added / updated',a.recent.episodes,episode=>`<div class="report-activity"><button type="button" class="link-button" data-dx-episode="${esc(episode.projectId)}" data-number="${esc(episode.number)}">${esc(episode.projectTitle)} · Episode ${esc(episode.number)}</button><time>${esc(date(episode.date))}</time></div>`)}${recent('Exports generated',a.recent.exports,record=>`<div class="report-activity"><button type="button" class="link-button" ${record.snapshot?`data-regenerate="${esc(record.id)}"`:'data-nav="exports"'}>${esc(record.projectTitle)} · ${esc(record.society)}</button><time>${esc(date(record.date))}</time></div>`)}</div></section></div></div>`;
}
function workspaceBytes(value=state){try{return new TextEncoder().encode(JSON.stringify(value)).byteLength;}catch(_error){return 0;}}
function formatBytes(bytes){if(bytes<1024)return bytes+' B';if(bytes<1024*1024)return (bytes/1024).toFixed(1)+' KB';return (bytes/1024/1024).toFixed(2)+' MB';}
function settings(){
  const bytes=workspaceBytes(),hosted=hostedWorkspace(),limit=(hosted?12:64)*1024*1024,snapshotCount=state.exports.filter(item=>item.snapshot).length,level=localRecords?'green':bytes>=limit*.85?'rose':bytes>=limit*.6?'amber':'green',status=persistence.getStatus();
  const preference=typeof themePreference==='undefined'?theme:themePreference;
  const prefs=state.preferences?.exportDefaults||{},formats=Array.isArray(prefs.formats)?prefs.formats:['IPRS','PRS','ASCAP'],behavior=prefs.downloadBehavior||'zip',separator=prefs.filenameSeparator||'underscore';
  const recordCounts=[['Projects',state.projects.length],['Episodes',state.projects.reduce((sum,project)=>sum+(project.episodes?.length||0),0)],['Songs',state.works.length],['Artists',state.artists.length],['Cues',state.cues.length],['Exports',state.exports.length]];
  const fullDate=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}):'Not recorded';
  const detail=(name,value)=>`<div><dt>${esc(name)}</dt><dd>${esc(value)}</dd></div>`;
  return `<div class="settings-page">${heading('Make it yours.','Your preferences and workspace care.','','AMISHNA MUSIC · SETTINGS')}<div class="settings-grid">
    <section class="panel settings-card"><div class="settings-card-title">${icon('sun')}<div><h2>Appearance</h2><p>A comfortable workspace, day or night</p></div></div><div class="settings-appearance" role="group" aria-label="Color theme">${[['light','Light','sun'],['dark','Dark','moon'],['system','System','grid']].map(([value,label,ico])=>`<button type="button" data-theme-choice="${value}" aria-pressed="${preference===value}" class="${preference===value?'selected':''}"><span class="settings-theme-preview ${value}">${icon(ico)}</span><strong>${label}</strong></button>`).join('')}</div><p class="settings-help">System follows your device’s appearance automatically.</p><div class="settings-card-actions"><button type="button" class="btn primary" data-action="appearance-studio" aria-haspopup="dialog" aria-expanded="false">Open Appearance Studio</button></div></section>
    <section class="panel settings-card"><div class="settings-card-title">${icon('grid')}<div><h2>Application</h2><p>Amishna Music rights workspace</p></div></div><dl class="settings-details">${detail('Version','1.0.0')}${detail('Database',status.databaseMessage||status.message)}${detail('Last database update',fullDate(status.updatedAt))}</dl><div class="settings-record-counts">${recordCounts.map(([name,total])=>`<span><strong>${total}</strong>${name}</span>`).join('')}</div></section>
    <section class="panel settings-card"><div class="settings-card-title">${icon('download')}<div><h2>Export preferences</h2><p>Your defaults for the next download</p></div></div><fieldset class="settings-formats"><legend>Default formats</legend>${['IPRS','PRS','ASCAP'].map(name=>`<label><input type="checkbox" data-export-default="${name}" ${formats.includes(name)?'checked':''}><span>${name}</span></label>`).join('')}</fieldset><label class="settings-field"><span>Multiple files</span><select class="input" data-setting="downloadBehavior"><option value="zip" ${behavior==='zip'?'selected':''}>One ZIP download</option><option value="files" ${behavior==='files'?'selected':''}>Separate Excel files</option></select></label><label class="settings-field"><span>File name separator</span><select class="input" data-setting="filenameSeparator"><option value="underscore" ${separator==='underscore'?'selected':''}>Underscore · Name_Episode_01_IPRS.xlsx</option><option value="hyphen" ${separator==='hyphen'?'selected':''}>Hyphen · Name-Episode-01-IPRS.xlsx</option></select></label><p class="settings-help">Project name and episode number are always included where applicable. Your browser controls the download folder and “Ask where to save” setting.</p></section>
    <section class="panel settings-card"><div class="settings-card-title">${icon('globe')}<div><h2>Societies</h2><p>Memberships, identifiers and export formats</p></div></div><div class="settings-societies">${['IPRS','PRS','ASCAP'].map(name=>`<div><strong>${name}</strong><span>${state.artists.filter(artist=>window.CueSocieties?.has(artist,name)).length} member profiles</span><button type="button" class="btn small ghost" data-society="${name}">Open export ${icon('arrow')}</button></div>`).join('')}</div><div class="settings-card-actions"><button type="button" class="btn" data-nav="artists">Manage memberships</button><button type="button" class="btn ghost" data-nav="societies">Society reference formats</button></div></section>
    <section class="panel settings-card"><div class="settings-card-title">${icon('shield')}<div><h2>Database & backups</h2><p>Keep your work protected and portable</p></div></div><dl class="settings-details">${detail('Connection',status.serverReachable===false?'Disconnected':'Local SQLite')}${detail('Last database update',fullDate(status.updatedAt))}${detail('Last JSON backup',fullDate(state.preferences?.lastBackupAt))}${!hosted?detail('Database snapshots','Keep 7 days + newest'):''}${detail('Saved snapshots',snapshotCount+' export snapshots')}${detail('History retention','7 days for imports and exports')}</dl><div class="settings-card-actions">${btn('Download full JSON backup','backup','download','primary')}${!hosted?`<button type="button" class="btn" data-action="download-database" ${window.CueAuth?.user?.role==='admin'?'':'hidden'} ${databaseActionBusy?'disabled':''}>${icon('download')}Download database (.sqlite)</button><button type="button" class="btn ghost" data-action="sync-database" ${databaseActionBusy?'disabled':''}>${icon('refresh')}Sync &amp; refresh episodes</button>`:''}<button type="button" class="btn" data-db="open">${icon('upload')}Import song database</button><button type="button" class="btn ghost" data-action="restore-backup">${icon('upload')}Restore backup</button></div><p class="settings-help">${hosted?'A full JSON backup includes projects, songs, artists, cues, preferences and history.':'Database downloads also save a dated SQLite snapshot in the Database folder beside this app. Your browser may save a second copy in its Downloads folder. Sync saves pending changes and refreshes episodes from SQLite.'} Song imports accept CSV or Excel.</p>${snapshotCount?`<details class="settings-maintenance"><summary>Storage maintenance</summary><p>Remove saved export source snapshots to reduce storage. History remains; exact regeneration of those files will no longer be available.</p>${btn('Prune export snapshots','prune-snapshots','trash')}</details>`:''}</section>
    <section class="panel settings-card"><div class="settings-card-title">${icon('settings')}<div><h2>System</h2><p>${hosted?'Online':'Local'} application health</p></div></div><dl class="settings-details">${detail('Administrator',administratorName())}${detail('Environment',(hosted?'Online':'Local')+' · '+location.host)}${detail('Server',status.serverReachable===true?'Application connected':status.serverReachable===false?'Connection unavailable':'Not checked')}${detail('Database sync',status.kind==='synced'?'Up to date':status.message)}${detail('Device storage',storageError?'Needs attention':'Available')}${detail('Estimated workspace size',localRecords?formatBytes(bytes)+' in SQLite records':formatBytes(bytes)+' / '+(hosted?12:64)+' MB working limit')}${hosted?detail('Online saves','Large workspaces compressed automatically'):''}</dl>${localRecords?'':`<div class="progress-track" role="progressbar" aria-label="Workspace capacity" aria-valuenow="${Math.min(100,Math.round(bytes/limit*100))}" aria-valuemin="0" aria-valuemax="100"><span style="width:${Math.min(100,bytes/limit*100)}%"></span></div>`}<p class="settings-help">${badge(formatBytes(bytes),level)} Includes ${state.imports.length} imports and ${state.exports.length} export records.</p></section>
    <section class="panel settings-card"><div class="settings-card-title">${icon('file')}<div><h2>Workfile template</h2><p>One familiar import format for every production</p></div></div><p class="settings-help">Movies and serials use the same template: A1 total duration, B1 date, C1 project name, E1 episode or work number, and A:D for cue rows.</p><div class="settings-card-actions"><a class="btn" href="Fixed-Workfile-Template.xlsx" download>${icon('download')}Download workfile template</a><button class="btn ghost" data-db="template">Song database template</button></div></section>
  </div></div>`;
}
function showModal(html,className=''){const root=document.querySelector('#modal-root'),wasOpen=Boolean(root.querySelector('.modal'));if(!wasOpen){modalTrigger=document.activeElement;modalDraft=false;}root.innerHTML=`<div class="modal-backdrop"><section class="modal lg-modal ${className}" role="dialog" aria-modal="true" tabindex="-1">${html}</section></div>`;const title=root.querySelector('.modal-head h2');if(title){title.id='dialog-title';root.querySelector('.modal').setAttribute('aria-labelledby',title.id);}else root.querySelector('.modal').setAttribute('aria-label','Record details');AmishnaAccessibility.setModalOpen(true);if(!wasOpen)window.AmishnaGlass?.enterModal(root.querySelector('.modal'));const modal=root.querySelector('.modal');setTimeout(()=>AmishnaAccessibility.focusDialog(modal),0);}
function closeModal(force=false){const root=document.querySelector('#modal-root');if(!root.querySelector('.modal'))return true;if(modalDraft&&!force&&!window.confirm('Discard unsaved changes?'))return false;window.AmishnaGlass?.exitModal(root.querySelector('.modal'));root.innerHTML='';AmishnaAccessibility.setModalOpen(false);modalWork=null;modalDraft=false;const target=modalTrigger;modalTrigger=null;if(target?.isConnected)setTimeout(()=>target.focus(),0);return true;}
function modalHead(title){return `<div class="modal-head"><h2>${esc(title)}</h2><button class="icon-button" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button></div>`;}
function field(label,name,value='',type='text',extra=''){return `<div class="field ${extra}"><label for="f-${name}">${label}</label><input class="input" id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" ${['title','name'].includes(name)?'required':''}></div>`;}
function openWork(id,tab='Overview'){
  modalWork=structuredClone(state.works.find(w=>w.id===id)||{id:uid('WRK'),title:'',type:'Score',language:'Hindi',status:'Complete',alternateTitles:[],isrc:'',iswc:'',tuneCode:'',societies:{IPRS:'',PRS:'',ASCAP:''},parties:[],artist:'',label:'',source:'Unknown',research:{source:'',url:'',notes:''},activity:[]});
  modalWork.alternateTitles??=[];modalWork.parties??=[];modalWork.activity??=[];modalWork.societies??={};modalWork.research??={};
  workTab=tab;renderWorkModal();
}
function collectWork(){
  const form=document.querySelector('#work-form');if(!form||!modalWork)return;
  const data=new FormData(form),artistChanged=data.has('artist')&&String(data.get('artist')).trim()!==modalWork.artist;
  for(const key of ['title','type','language','isrc','iswc','tuneCode','artist','label','source','album','genre','releaseDate','recordingDuration','notes'])if(data.has(key))modalWork[key]=String(data.get(key)).trim();
  if(data.has('alternateTitles'))modalWork.alternateTitles=String(data.get('alternateTitles')).split(',').map(v=>v.trim()).filter(Boolean);
  if(data.has('tags'))modalWork.tags=String(data.get('tags')).split(',').map(v=>v.trim()).filter(Boolean);
  if(artistChanged)delete modalWork.artistIds;
  else if(form.elements.namedItem('artistIds'))modalWork.artistIds=data.getAll('artistIds');
  for(const society of ['IPRS','PRS','ASCAP'])if(data.has(society))modalWork.societies[society]=String(data.get(society)).trim();
  for(const society of ['IPRS','PRS','ASCAP'])if(data.has('usage'+society)){modalWork.societyUsage??={};modalWork.societyUsage[society]=String(data.get('usage'+society)).trim().toUpperCase();}
  if(workTab==='Rights holders')modalWork.parties=[...form.querySelectorAll('.party-row[data-party]')].map(row=>{
    const get=key=>row.querySelector(`[data-party-field="${key}"]`)?.value.trim()||'';
    const party={...modalWork.parties[Number(row.dataset.party)],name:get('name'),role:get('role'),ipi:get('ipi'),share:get('share')===''?null:Number(get('share')),society:get('society')};
    if(get('artistId'))party.artistId=get('artistId');else delete party.artistId;
    return party;
  });
}
function performerField(work){
  const selected=work.artistIds||[];
  return `<div class="field full"><label for="f-artistIds">Linked recording artists</label><select class="input" id="f-artistIds" name="artistIds" multiple size="4">${(state.artists||[]).filter(a=>a.status!=='Archived'||selected.includes(a.id)).map(a=>`<option value="${esc(a.id)}" ${selected.includes(a.id)?'selected':''}>${esc(a.name)}${a.ipi?' · IPI '+esc(a.ipi):''}</option>`).join('')}</select></div>`;
}
function renderWorkModal(){const w=modalWork;let body='';if(workTab==='Overview')body=`<div class="form-grid">${field('Work title','title',w.title)}${field('Alternate titles (comma separated)','alternateTitles',w.alternateTitles.join(', '))}${field('Language','language',w.language)}<div class="field"><label for="f-type">Work type</label><select id="f-type" name="type" class="input">${options(['Score','Song','Theme','Instrumental','Library'],w.type)}</select></div>${field('ISRC','isrc',w.isrc)}${field('ISWC','iswc',w.iswc)}${field('Tune Code','tuneCode',w.tuneCode)}${field('Recording artist / singer','artist',w.artist)}${field('Record label','label',w.label)}${field('Album / release','album',w.album)}${field('Genre','genre',w.genre)}${field('Release date','releaseDate',w.releaseDate,'date')}${field('Recording duration (HH:MM:SS)','recordingDuration',w.recordingDuration)}${field('Tags (comma separated)','tags',(w.tags||[]).join(', '))}${performerField(w)}<div class="field full"><label for="f-notes">Song notes</label><textarea class="input" id="f-notes" name="notes" rows="3">${esc(w.notes)}</textarea></div><div class="field"><label for="f-source">Ownership / source</label><select class="input" id="f-source" name="source">${options(['Original','Third-party','Library','Unknown'],w.source)}</select></div></div><p class="subtitle">Permanent metadata is stored once. Every cue references this Work ID.</p>`;
if(workTab==='Rights holders')body=`<p class="subtitle">Add any number of creators, publishers, and rights holders. Author means the song lyricist, so it is stored as Lyricist. Draft mapping uses combined shares totaling 100%.</p><div class="party-row party-labels spacer"><span>NAME</span><span>ROLE</span><span>SHARE %</span><span>IPI</span><span>SOCIETY</span></div>${w.parties.map((p,i)=>`<div class="party-row" data-party="${i}"><div class="song-party-identity"><input class="input" aria-label="Party name" data-party-field="name" value="${esc(p.name)}" required><select class="input" aria-label="Link artist profile" data-party-field="artistId">${options([{value:'',label:'Link artist profile'},...(state.artists||[]).filter(a=>a.status!=='Archived'||a.id===p.artistId).map(a=>({value:a.id,label:a.name+(a.ipi?' / '+a.ipi:'')}))],p.artistId||'')}</select></div><select class="input" aria-label="Party role" data-party-field="role">${options(['Composer',{value:'Lyricist',label:'Lyricist / Author'},{value:'Composer / Lyricist',label:'Composer + Lyricist / Author'},'Publisher','Label','Arranger','Adaptor'],p.role)}</select><input class="input" aria-label="Share percent" data-party-field="share" type="number" min="0" max="100" step="0.01" value="${p.share??''}"><input class="input" aria-label="IPI" data-party-field="ipi" value="${esc(p.ipi)}"><input class="input" aria-label="Society" data-party-field="society" value="${esc(p.society)}"><button type="button" class="icon-button" data-remove-party="${i}" aria-label="Remove rights holder">${icon('close')}</button></div>`).join('')}<button type="button" class="btn small spacer" data-action="add-party">${icon('plus')}Add rights holder</button>`;
if(workTab==='Society IDs')body=`<div class="form-grid">${['IPRS','PRS','ASCAP'].map(s=>`${field(s+' Work ID',s,w.societies[s])}<div class="field"><label for="f-usage${s}">${s} music usage code</label><select class="input" id="f-usage${s}" name="usage${s}">${options([{value:'',label:'Choose a code'},...D.usageCodes[s]],D.usageSetForWork(w)[s])}</select></div>`).join('')}</div><p class="subtitle">Saving these codes updates every existing cue for this song across all projects. Future cues use the same codes.</p>`;
if(workTab==='Cue usage')body=`<div class="table-wrap"><table><thead><tr><th>PROJECT</th><th>CONTENT</th><th>IN / OUT</th><th>DURATION</th><th></th></tr></thead><tbody>${state.cues.filter(c=>c.workId===w.id).map(c=>`<tr><td>${esc(projectName(c.projectId))}</td><td>${c.episode?'Episode '+c.episode:'Movie'}</td><td>${c.occurrences?.length>1?c.occurrences.length+' plays':D.time(c.start)+' — '+D.time(c.end)}</td><td>${D.time(c.duration)}</td><td><button type="button" class="btn small" data-edit-cue="${esc(c.id)}">Open cue</button></td></tr>`).join('')}</tbody></table></div>`;
if(workTab==='History')body=(w.activity||[]).map(a=>`<div class="attention-item">${icon('clock')}<div>${esc(a.text)}<p>${date(a.date)}</p></div></div>`).join('')||empty('No edits recorded','Updates to this Work will appear here.');
showModal(modalHead(w.title||'Create a Work')+`<div class="modal-body"><div class="subtitle mono">${esc(w.id)}</div><div class="tabs">${['Overview','Rights holders','Society IDs','Cue usage','History'].map(t=>`<button class="tab ${t===workTab?'active':''}" data-work-tab="${t}">${t}</button>`).join('')}</div><form id="work-form">${body}<div class="panel-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">${icon('check')}Save Work</button></div></form></div>`);}
function importHistory(){
  const pageSize=100,pages=Math.max(1,Math.ceil(state.imports.length/pageSize));importHistoryPage=Math.min(importHistoryPage,pages);
  const first=(importHistoryPage-1)*pageSize,visible=state.imports.slice(first,first+pageSize);
  const pager=state.imports.length>pageSize?`<div class="am-pagination"><span>${first+1}–${Math.min(first+pageSize,state.imports.length)} of ${state.imports.length} imports</span><div><button type="button" class="btn small" data-action="imports-prev" ${importHistoryPage===1?'disabled':''}>Previous</button><span>${importHistoryPage} / ${pages}</span><button type="button" class="btn small" data-action="imports-next" ${importHistoryPage===pages?'disabled':''}>Next</button></div></div>`:'';
  return `<section class="panel"><div class="panel-head"><div><h2>Import history</h2><p class="subtitle">History is kept for 7 days. Imported songs and cues stay saved.</p></div>${badge(state.imports.length+' imports','gray')}</div>${state.imports.length?`<div class="table-wrap"><table><thead><tr><th>FILE / SHEET</th><th>PROJECT</th><th>CUES</th><th>NEW WORKS</th><th>IMPORTED</th><th>ACTIONS</th></tr></thead><tbody>${visible.map(i=>`<tr><td>${esc(i.filename)}<div class="cell-meta">${esc(i.sheet)} · ${esc(i.profile||'Fixed workfile')}${i.workfileMetadata?` · Episode ${i.workfileMetadata.episodeNumber}`:''}</div></td><td>${esc(projectName(i.projectId))}${i.workfileMetadata?`<div class="cell-meta">${esc(i.workfileMetadata.serialName)} · ${esc(i.workfileMetadata.date)} · ${esc(i.workfileMetadata.totalDuration)}</div>`:''}</td><td>${i.count}${i.usages&&i.usages!==i.count?'<div class="cell-meta">'+i.usages+' uses</div>':''}</td><td>${i.newWorks}</td><td>${date(i.date)}</td><td>${i.id?`<button type="button" class="btn small danger" data-mx="import-delete" data-id="${esc(i.id)}" aria-label="Delete import record for ${esc(i.filename)}">${icon('trash')} Delete record</button>`:''}</td></tr>`).join('')}</tbody></table></div>`:empty('A fresh start','Your confirmed imports will appear here with their project, sheet, and counts.')}${pager}</section>`;
}
function exportScope(){const project=state.projects.find(p=>p.id===exportProject)||state.projects[0];return {project,cues:state.cues.filter(c=>c.projectId===project.id&&(project.type==='Movie'||c.episode===Number(exportEpisode)))};}
function downloadBlob(content,filename,type){const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
function parseWorkspaceBackup(text){
  if(typeof text!=='string'||new TextEncoder().encode(text).length>((typeof hostedWorkspace==='function'&&hostedWorkspace())?12:64)*1024*1024)throw new Error('Choose an Amishna Music JSON backup within the workspace size limit.');
  let candidate;try{candidate=JSON.parse(text.replace(/^\uFEFF/,''));}catch(_error){throw new Error('This file is not valid JSON. Choose a full workspace backup.');}
  const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  if(!record(candidate)||candidate.version!==1)throw new Error('This is not a supported Amishna Music workspace backup (version 1).');
  for(const key of ['works','projects','cues','clients','imports','exports','profiles','activity'])if(!Array.isArray(candidate[key])||candidate[key].some(item=>!record(item)))throw new Error('The backup contains invalid '+key+' records.');
  if(candidate.preferences!==undefined&&!record(candidate.preferences))throw new Error('The backup contains invalid application preferences.');
  const stack=[{value:candidate,depth:0}];
  while(stack.length){const {value,depth}=stack.pop();if(depth>90)throw new Error('The backup data is nested too deeply.');for(const [key,child] of Object.entries(value)){if(['__proto__','constructor','prototype'].includes(key))throw new Error('The backup contains an unsupported data property.');if(child&&typeof child==='object')stack.push({value:child,depth:depth+1});}}
  return candidate;
}
function backupSummary(workspace){return [['Projects',workspace.projects.length],['Episodes',workspace.projects.reduce((total,project)=>total+(Array.isArray(project.episodes)?project.episodes.length:0),0)],['Songs',workspace.works.length],['Artists',workspace.artists?.length||0],['Cues',workspace.cues.length],['Exports',workspace.exports.length]];}
let restoreBackupPlan=null,restoreBackupBusy=false;
function prepareBackupAction(){
  if(workspaceClosed||!state)return false;
  if(UI.hasDraft?.()&&!UI.flush())return false;
  if(modalDraft){toast('Save or cancel your open form before working with a full backup.');return false;}
  if(bulkImportActive){toast('Wait for the workfile import to finish before working with a full backup.');return false;}
  return true;
}
if(typeof window!=='undefined'&&window.CueAuth){
  window.CueAuth.beforeLogout=async()=>{
    if(!prepareBackupAction())return false;
    await persistence.sync();
    return !workspaceClosed&&!persistence.getStatus().pending;
  };
  window.CueAuth.clearCache=()=>{
    const keys=[];
    for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key===KEY||key.startsWith(KEY+':'))keys.push(key);}
    keys.forEach(key=>localStorage.removeItem(key));
  };
}
function downloadWorkspaceBackup(){
  if(!prepareBackupAction())return;
  const stamp=new Date().toISOString(),before=structuredClone(state);
  state.preferences??={};state.preferences.lastBackupAt=stamp;
  const saved=save();if(!saved)state=before;
  try{downloadBlob(JSON.stringify(state,null,2),'Amishna_Music_Backup_'+stamp.slice(0,10)+'.json','application/json');if(page==='settings')renderPage();toast(saved?'Full workspace backup downloaded.':'Backup downloaded. Storage still needs attention before importing.');}
  catch(error){if(saved){state=before;save();}toast('The backup could not be downloaded. Please try again.');}
}
async function syncDatabaseAndEpisodes(){
  if(databaseActionBusy||!prepareBackupAction())return false;
  databaseActionBusy=true;if(page==='settings')renderPage();
  try{
    let status=persistence.getStatus();
    if(status.kind==='conflict'){toast('Resolve the database conflict using the save bar before syncing.');return false;}
    if(status.kind==='update-available')return await persistence.useDatabase();
    const saved=await (['offline','error','local-error'].includes(status.kind)?persistence.retry():persistence.sync());
    status=persistence.getStatus();
    if(!saved||status.pending){toast('Database sync could not finish. Check the save bar and retry.');return false;}
    await persistence.checkForUpdates();
    status=persistence.getStatus();
    if(status.kind==='update-available')return await persistence.useDatabase();
    if(status.kind!=='synced'){toast('Database connection needs attention. Check the save bar.');return false;}
    if(page==='settings')renderPage();
    const episodes=state.projects.reduce((count,project)=>count+(project.episodes?.length||0),0);
    toast('SQLite synced · '+episodes+' episodes across '+state.projects.length+' project'+(state.projects.length===1?'':'s')+'.');
    return true;
  }catch(error){toast('Database sync failed: '+(error?.message||'Try again.'));return false;}
  finally{databaseActionBusy=false;if(page==='settings'&&!workspaceClosed)renderPage();}
}
async function downloadDatabaseSnapshot(){
  if(databaseActionBusy||!prepareBackupAction())return;
  databaseActionBusy=true;if(page==='settings')renderPage();
  try{
    const status=persistence.getStatus();
    if(status.kind==='conflict'||status.kind==='update-available'){
      toast('Sync & refresh episodes before downloading the database.');return;
    }
    const synced=await (['offline','error','local-error'].includes(status.kind)?persistence.retry():persistence.sync());
    if(!synced||persistence.getStatus().pending){toast('Wait for SQLite to sync before downloading the database.');return;}
    await persistence.checkForUpdates();
    if(persistence.getStatus().kind!=='synced'){toast('Sync & refresh episodes before downloading the database.');return;}
    const response=await fetch('/api/database/backup',{method:'POST',cache:'no-store',headers:{Accept:'application/vnd.sqlite3'}});
    if(!response.ok){const body=await response.json().catch(()=>null);throw new Error(body?.error?.message||'Database download failed (HTTP '+response.status+').');}
    const filename=response.headers.get('X-Database-Backup-Name');
    if(!/^Amishna_Database_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}(?:_\d+)?\.sqlite$/.test(filename||''))throw new Error('The database backup response had an invalid filename.');
    const blob=await response.blob();
    if(!blob.size)throw new Error('The database backup was empty.');
    downloadBlob(blob,filename,'application/vnd.sqlite3');
    toast(response.headers.get('X-Database-Retention-Warning')?'Database saved, but old snapshots could not be cleaned. Check Database folder permissions.':'Database snapshot saved in Database/'+filename+' and sent to your browser.');
  }catch(error){toast('Database download failed: '+(error?.message||'Try again.'));}
  finally{databaseActionBusy=false;if(page==='settings'&&!workspaceClosed)renderPage();}
}
function reviewWorkspaceBackup(){
  if(!restoreBackupPlan||workspaceClosed)return;
  restoreBackupPlan.currentRaw=JSON.stringify(state);
  const current=backupSummary(state),next=backupSummary(restoreBackupPlan.workspace);
  showModal(modalHead('Restore workspace backup?')+`<div class="modal-body"><p><strong>${esc(restoreBackupPlan.filename)}</strong> passed the workspace checks.</p><p>This replaces your current projects, catalog, cues, settings and history with the contents of this backup.</p><div class="table-wrap"><table><thead><tr><th>Records</th><th>Current workspace</th><th>Backup</th></tr></thead><tbody>${next.map(([label,count],index)=>`<tr><td>${esc(label)}</td><td>${current[index][1]}</td><td>${count}</td></tr>`).join('')}</tbody></table></div><p class="subtitle">Your current workspace will be kept as a recovery copy on this device. After restoring, use “Download previous copy” in the save bar to retrieve it.</p><div class="panel-actions"><button type="button" class="btn" data-action="backup">Download current backup</button><button type="button" class="btn" data-action="close-modal">Cancel</button><button type="button" class="btn primary" data-action="confirm-restore-backup">Replace with this backup</button></div></div>`);
}
function chooseWorkspaceBackup(){
  if(!prepareBackupAction()||restoreBackupBusy)return;
  if(document.querySelector('.modal')&&!closeModal())return;
  const input=document.createElement('input');input.type='file';input.accept='.json,application/json';input.hidden=true;input.setAttribute('aria-label','Choose a full workspace JSON backup');document.body.append(input);
  input.addEventListener('cancel',()=>input.remove(),{once:true});
  input.addEventListener('change',async()=>{
    const file=input.files?.[0];input.remove();if(!file)return;
    restoreBackupPlan=null;restoreBackupBusy=true;
    try{
      if(file.size>(hostedWorkspace()?12:64)*1024*1024)throw new Error('Choose a JSON backup within the workspace size limit.');
      toast('Checking workspace backup…');const candidate=parseWorkspaceBackup(await file.text());
      const prepared=await CuePersistence.prepareRequest({workspace:candidate},{online:hostedWorkspace()});
      const response=await fetch('/api/workspace/validate',{method:'POST',credentials:'same-origin',...prepared});
      const result=await response.json();if(!response.ok)throw new Error(result.error?.message||'This workspace backup could not be validated.');
      if(workspaceClosed||!prepareBackupAction())return;
      restoreBackupPlan={workspace:candidate,filename:file.name};reviewWorkspaceBackup();
    }catch(error){if(!workspaceClosed)toast(error.message||'The backup could not be opened. Your current workspace is unchanged.');}
    finally{restoreBackupBusy=false;}
  },{once:true});input.click();
}
async function restoreWorkspaceBackup(){
  if(!restoreBackupPlan||restoreBackupBusy||!prepareBackupAction())return;
  if(JSON.stringify(state)!==restoreBackupPlan.currentRaw){reviewWorkspaceBackup();toast('The current workspace changed. Review the updated counts before replacing it.');return;}
  restoreBackupBusy=true;
  const controls=[...document.querySelectorAll('#modal-root button')];controls.forEach(button=>button.disabled=true);
  let before=null,replaced=false;
  try{
    await persistence.sync();
    if(workspaceClosed||!state)return;
    if(['conflict','update-available','local-error','error'].includes(persistence.getStatus().kind))throw new Error('Resolve the database or storage message in the save bar before restoring a backup.');
    if(JSON.stringify(state)!==restoreBackupPlan.currentRaw)throw new Error('The workspace changed during the backup check. Choose Restore backup again to review it.');
    before=structuredClone(state);
    const recoveryKey=KEY+':backups',recoveries=JSON.parse(localStorage.getItem(recoveryKey)||'[]');
    if(!Array.isArray(recoveries))throw new Error('Existing recovery storage needs attention. Download the current backup before restoring.');
    recoveries.push({createdAt:new Date().toISOString(),source:'before-restore',raw:JSON.stringify(before)});
    try{localStorage.setItem(recoveryKey,JSON.stringify(recoveries));}catch(_error){throw new Error('There is not enough device storage to preserve your current workspace. Download a backup and free space before restoring.');}
    state=structuredClone(restoreBackupPlan.workspace);state.preferences??={};state.preferences.lastRestoreAt=new Date().toISOString();
    state.activity.unshift({text:'Restored workspace backup · '+restoreBackupPlan.filename,date:new Date().toISOString()});
    if(!save()){state=before;throw new Error('The restored workspace could not be saved. Your current workspace was kept.');}
    replaced=true;restoreBackupPlan=null;
    const synced=await persistence.sync();
    if(workspaceClosed)return;
    closeModal(true);history.replaceState({page:'settings'},'','#settings');
    toast(synced?'Workspace restored. Reopening your saved data…':'Workspace restored on this device. Database sync needs attention; your previous copy is preserved.');
    setTimeout(()=>location.reload(),synced?350:1400);
  }catch(error){if(!replaced&&before)state=before;if(!workspaceClosed)toast(error.message||'The workspace could not be restored.');}
  finally{restoreBackupBusy=false;controls.forEach(button=>button.disabled=false);}
}
function openProjectExport(project,episode,options={}){
  if(!project){toast('Choose a project to export.');return;}
  const sourceCues=state.cues.filter(cue=>cue.projectId===project.id),number=project.type==='Movie'?null:(episode!=null&&project.episodes.some(ep=>Number(ep.number)===Number(episode))?Number(episode):project.episodes[0]?.number??1);
  const episodes=project.type==='Series'&&(options.allowEpisodeSelection||options.episodeNumbers)?project.episodes.filter(ep=>!options.episodeNumbers||options.episodeNumbers.some(value=>Number(value)===Number(ep.number))).map(ep=>({episode:ep.number,cues:sourceCues.filter(cue=>Number(cue.episode)===Number(ep.number))})):undefined;
  ExportDialog.open({project,episode:number,cues:sourceCues.filter(cue=>project.type==='Movie'||Number(cue.episode)===Number(number)),works:state.works,episodes,scope:options.episodeNumbers?.length>1?'all':'single'});
}
function prepareImportedSocietyCueSheets(){
  const projectIds=bulkImportSummary?.projectIds||[];
  if(projectIds.length!==1)return toast('Open one imported project at a time to prepare its society cue sheets.');
  const project=state.projects.find(item=>item.id===projectIds[0]);
  if(!project)return toast('The imported project could not be found. Open Cues / Workfile and try again.');
  const episodes=[...new Set(state.cues.filter(cue=>cue.projectId===project.id&&cue.episode!=null).map(cue=>Number(cue.episode)).filter(Number.isFinite))].sort((a,b)=>a-b);
  openProjectExport(project,episodes[0]??null,project.type==='Series'&&episodes.length?{allowEpisodeSelection:true,episodeNumbers:episodes}:{});
}
function generateExport(){const scope=exportScope();openProjectExport(scope.project,exportEpisode,{allowEpisodeSelection:true});}
function newClient(){showModal(modalHead('Add a client')+`<div class="modal-body"><form id="client-form"><div class="form-grid">${field('Client name','name')}${field('Primary contact','contact')}</div><div class="panel-actions">${btn('Cancel','close-modal')}<button type="submit" class="btn primary">Create client</button></div></form></div>`);}
function newProject(){
  const field=(label,name,value='',type='text',attrs='')=>`<div class="field"><label for="f-${name}">${label}</label><input class="input" id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" ${attrs}></div>`;
  showModal(modalHead('Create a project')+`<div class="modal-body"><form id="project-form"><div class="form-grid">${field('Project title','title','','text','required')}<div class="field"><label for="project-client">Client</label><select class="input" id="project-client" name="clientId">${options(state.clients.map(c=>({value:c.id,label:c.name})))}</select></div><div class="field"><label for="project-type">Project type</label><select class="input" id="project-type" name="type">${options(['Movie','Series'],'Movie')}</select></div>${field('Genre / category','genre')}${field('Language','language','Hindi')}${field('Production year','year',new Date().getFullYear(),'number','min="1800" max="2500"')}${field('Production number','productionNo')}<div class="field full"><small id="project-format-help">IPRS uses the Movie Cue Sheet. Enter the production number from the censor certificate.</small></div>${field('Director','director')}${field('Producer','producer')}${field('Banner / production company','company')}${field('Principal actors / actress','cast')}${field('Background music composer','bgComposer')}${field('Submitted by (name of C/A/E)','submittedBy','Amishna Music')}<fieldset id="project-movie-fields" class="full" style="border:0;padding:0;margin:0"><legend>Movie cue sheet details</legend><div class="form-grid">${field('Date of first performed','airdate')}${field('Total movie duration','duration','','text','placeholder="HH:MM:SS"')}</div><p class="subtitle">Total musical duration is calculated from the movie cues.</p></fieldset><fieldset id="project-series-fields" class="full" style="border:0;padding:0;margin:0" hidden disabled><legend>TV/Web Series cue sheet details</legend><div class="form-grid">${field('Serial type (documentary, soap, web series)','serialType','Web Series')}${field('Channel name','channel')}${field('Season number','season',1,'number','min="1" step="1"')}${field('Total planned episodes','totalEpisodes',1,'number','min="1" step="1"')}${field('First episode number','episode',1,'number','min="1" step="1"')}${field('Episode title','episodeTitle','Episode 1')}${field('Date of episode first performed / aired','episodeAirdate')}${field('Total episode duration','episodeDuration','','text','placeholder="HH:MM:SS"')}</div></fieldset></div><div class="panel-actions">${btn('Cancel','close-modal')}<button type="submit" class="btn primary">Create project</button></div></form></div>`);}
function workfileSourceChoices(mode,modal=false){
  return '';
}
function workfileProjectContext(project){return `<div class="wi-project-context">${icon(project.type==='Movie'?'film':'folder')}<span>Importing into <strong>${esc(project.title)}</strong> · ${esc(project.type)}</span></div>`;}
function openWorkfileImportModal(projectId){
  const project=state.projects.find(item=>item.id===projectId);
  if(!project)return toast('Choose a saved project before importing.');
  if(bulkImportPending||bulkImportActive||googleSheetBusy){go('import',{importProjectId:project.id});toast('Finish the current workfile review before starting another import.');return;}
  importModalProjectId=project.id;importModalSource='excel';renderWorkfileImportModal();
}
function renderWorkfileImportModal(){
  const project=state.projects.find(item=>item.id===importModalProjectId);if(!project)return;
  importModalSource='excel';
  const excel=`<div class="wi-source-content"><div class="wi-excel-source"><div class="wi-upload-copy"><h3>Choose Excel workfiles</h3><p>After choosing files, you can select the worksheet range and see a compact preview before saving.</p></div><div class="dropzone wi-dropzone-simple">${icon('upload')}<h3>Choose workfiles</h3><p>Up to 250 selected episodes · 10 MB per file</p><label class="btn primary" for="project-import-file">${icon('plus')}Choose files</label><input id="project-import-file" type="file" accept=".xlsx,.xls,.csv" multiple aria-label="Choose project workfiles"></div></div></div>`;
  const google=`<div class="wi-source-content"><div class="wi-google-source"><div class="panel-head"><div><h3>Connect a Google Sheet</h3><p>Share the sheet as “Anyone with the link · Viewer”, then paste its link below.</p></div></div><form id="project-google-sheet-form" class="wi-google-form"><label>Google Sheets link<input class="input" type="url" name="googleSheetUrl" placeholder="https://docs.google.com/spreadsheets/d/…/edit" required></label><button class="btn primary" type="submit">Load tabs</button></form></div></div>`;
  showModal(modalHead('Import workfile')+`<div class="modal-body"><section class="wi-import-source">${workfileProjectContext(project)}${workfileSourceChoices(importModalSource,true)}${importModalSource==='google'?google:excel}</section></div>`,'wi-import-modal');
}
function updateProjectTypeFields(){
  const movie=document.querySelector('#project-type').value==='Movie';
  for(const [id,enabled] of [['project-movie-fields',movie],['project-series-fields',!movie]]){const group=document.getElementById(id);group.hidden=!enabled;group.disabled=!enabled;}
  document.getElementById('project-format-help').textContent=movie?'IPRS uses the Movie Cue Sheet. Enter the production number from the censor certificate.':'IPRS uses the TV/Web Series Cue Sheet. PRS and ASCAP keep the same layouts for both project types.';
}
document.addEventListener('click',event=>{if(DatabaseImport.click(event)||Catalog.click(event)||Portfolio.click(event)||Management.click(event)||Discovery.click(event))return;const el=event.target.closest('button,a');if(!el)return;const d=el.dataset;
if(d.nav){if(!closeModal())return;if(d.nav==='cues'){const target=cueProject!=='All'&&state.projects.some(p=>p.id===cueProject)?cueProject:state.projects[0]?.id;if(target){UI.openProject(target);return;}}go(d.nav);return;}
if(d.work){openWork(d.work,d.tab||'Overview');return;}
if(d.project){UI.openProject(d.project);return;}
if(d.client){Portfolio.setClient(d.client);go('projects');return;}
if(d.projectCues){if(!closeModal())return;cueProject=d.projectCues;UI.openProject(d.projectCues);return;}
if(d.action==='cancel-google-range'){if(googleSheetBusy)return;googleSheetSelection=null;googleSheetError='';renderPage();return;}
if(d.action==='clear-excel-selection'){if(excelInspectBusy||bulkImportActive)return;excelSelection=[];excelSelectionError='';renderPage();return;}
if(d.action==='preview-excel-selection'){previewExcelSelection();return;}
if(d.excelRemove!==undefined){if(excelInspectBusy||bulkImportActive)return;excelSelection.splice(Number(d.excelRemove),1);excelSelectionError='';renderPage();return;}
if(d.importSource){if(bulkImportActive||googleSheetBusy)return;importSourceMode=d.importSource==='google'?'google':'excel';googleSheetError='';renderPage();return;}
if(d.importModalSource){importModalSource=d.importModalSource==='google'?'google':'excel';renderWorkfileImportModal();return;}
if(d.workTab){collectWork();workTab=d.workTab;renderWorkModal();return;}
if(d.removeParty!==undefined){collectWork();modalWork.parties.splice(Number(d.removeParty),1);renderWorkModal();return;}
if(d.editCue){UI.openCue(d.editCue);return;}
if(d.society){exportSociety=d.society;openProjectExport(state.projects.find(p=>p.id===exportProject)||state.projects[0],undefined,{allowEpisodeSelection:true});return;}
if(d.regenerate){const r=state.exports.find(e=>e.id===d.regenerate);if(!r?.snapshot){toast('This saved export has no source snapshot.');return;}ExportDialog.open({project:r.snapshot.project,episode:r.episode,cues:r.snapshot.cues,works:r.snapshot.works,episodes:r.snapshot.episodes,scope:r.snapshot.episodes?.length>1?'all':undefined,membershipPolicy:r.society==='ASCAP'?r.snapshot.membershipPolicy:undefined});return;}
if(d.googleSync){const linked=(state.preferences?.googleSheets||[]).find(item=>item.id===d.googleSync);if(linked)loadGoogleSheetTabs(linked);return;}
if(d.googleDetach){const linked=(state.preferences?.googleSheets||[]).find(item=>item.id===d.googleDetach);if(linked&&commit('Detached Google Sheet '+linked.projectName,workspace=>{workspace.preferences??={};workspace.preferences.googleSheets=(workspace.preferences.googleSheets||[]).filter(item=>item.id!==linked.id);})){renderPage();toast('Google Sheet link removed. Imported cues were kept.');}return;}
if(d.themeChoice){applyTheme(d.themeChoice);return;}
const action=d.action;
if(action==='menu'){AmishnaAccessibility.toggleNavigation();return;}
if(action==='close-navigation'){AmishnaAccessibility.closeNavigation(true);return;}
if(action==='appearance-studio'){window.AmishnaAppearance?.open(el);return;}
if(action==='upload')go('import');
if(action==='view-works')go('works');
if(action==='new-work')openWork(null);
if(action==='add-music-cue'){const project=state.projects.find(p=>p.id===cueProject)||state.projects[0];if(project){UI.openProject(project.id);UI.addCue();}else newProject();}
if(action==='new-client')newClient();
if(action==='new-project')newProject();
if(action==='close-modal'){event.preventDefault();closeModal();}
if(action==='add-party'){collectWork();modalWork.parties.push({name:'',role:'Composer',share:0,ipi:'',society:''});renderWorkModal();}
if(action==='iprs-import')UI.openIprsImport();
if(action==='view-bulk-cues'){const projectId=bulkImportSummary?.projectIds?.[0];if(projectId){cueProject=projectId;UI.openProject(projectId);}else go('cues');return;}
if(action==='prepare-society-cue-sheets'){prepareImportedSocietyCueSheets();return;}
if(action==='confirm-bulk-import'){confirmBulkImport();return;}
if(action==='cancel-bulk-import'){bulkImportPending=null;importQueue=[];renderPage();toast('The workfile batch was not imported.');return;}
if(action==='clear-bulk-summary'){bulkImportSummary=null;importQueue=[];renderPage();return;}
if(action==='generate-export')generateExport();
if(action==='backup'){downloadWorkspaceBackup();return;}
if(action==='download-database'){downloadDatabaseSnapshot();return;}
if(action==='sync-database'){syncDatabaseAndEpisodes();return;}
if(action==='cues-prev'){cueListPage=Math.max(1,cueListPage-1);renderPage();return;}
if(action==='cues-next'){cueListPage++;renderPage();return;}
if(action==='imports-prev'){importHistoryPage=Math.max(1,importHistoryPage-1);renderPage();return;}
if(action==='imports-next'){importHistoryPage++;renderPage();return;}
if(action==='restore-backup'){chooseWorkspaceBackup();return;}
if(action==='confirm-restore-backup'){restoreWorkspaceBackup();return;}
if(action==='prune-snapshots'){const count=state.exports.filter(item=>item.snapshot).length;showModal(modalHead('Prune export snapshots?')+`<div class="modal-body"><p>This removes the saved source copies from <strong>${count} export record${count===1?'':'s'}</strong> to reduce workspace size. Export history remains visible.</p><p class="subtitle">Download a workspace backup first if you may need to regenerate an old file exactly as it was exported.</p><div class="panel-actions"><button class="btn" data-action="close-modal">Cancel</button><button class="btn danger" data-action="confirm-prune-snapshots">Prune snapshots</button></div></div>`);}
if(action==='confirm-prune-snapshots'){const count=state.exports.filter(item=>item.snapshot).length;if(commit('Pruned '+count+' export snapshots',workspace=>{for(const item of workspace.exports)if(item.snapshot){delete item.snapshot;item.snapshotPrunedAt=new Date().toISOString();}})){closeModal(true);renderPage();toast(count+' export snapshots pruned. Export history was kept.');}}
if(action==='report-download'){const rows=[['Cue ID','Project','Client','Episode','Work ID','Work title','IN','OUT','Plays','Occurrence times','Total duration','Usage','Source'],...state.cues.map(c=>[c.id,projectName(c.projectId),clientName(state.projects.find(p=>p.id===c.projectId).clientId),c.episode,c.workId,workName(c.workId),c.occurrences?.length>1?'Multiple plays':D.time(c.start),c.occurrences?.length>1?'Multiple plays':D.time(c.end),c.occurrences?.length||Number(c.usageCount)||1,c.occurrences?.length?c.occurrences.map(use=>D.time(use.start)+'–'+D.time(use.end)).join('; '):D.time(c.start)+'–'+D.time(c.end),D.time(c.duration),c.usage,c.source])],wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),'Cue report');XLSX.writeFile(wb,'Cue_usage_report.xlsx');}
});
document.addEventListener('change',event=>{DatabaseImport.change(event);if(Catalog.change(event)||Portfolio.change(event)||Management.change(event)||Discovery.change(event))return;const el=event.target,d=el.dataset;
if(d.googleRange&&googleSheetSelection&&!googleSheetBusy){googleSheetSelection[d.googleRange]=Number(el.value);renderPage();return;}
if(d.excelRange&&excelSelection[Number(d.excelIndex)]&&!excelInspectBusy){excelSelection[Number(d.excelIndex)][d.excelRange]=Number(el.value);excelSelectionError='';renderPage();return;}
if(d.exportDefault||d.setting){
  const defaults={formats:['IPRS','PRS','ASCAP'],downloadBehavior:'zip',filenameSeparator:'underscore',...state.preferences?.exportDefaults};
  if(d.exportDefault){defaults.formats=[...document.querySelectorAll('[data-export-default]:checked')].map(input=>input.dataset.exportDefault);if(!defaults.formats.length){el.checked=true;return toast('Keep at least one default export format.');}}
  else if(d.setting==='downloadBehavior')defaults.downloadBehavior=el.value==='files'?'files':'zip';
  else if(d.setting==='filenameSeparator')defaults.filenameSeparator=el.value==='hyphen'?'hyphen':'underscore';
  if(commit('Updated export preferences',workspace=>{workspace.preferences??={};workspace.preferences.exportDefaults=defaults;}))toast('Export preferences saved.');
  return;
}
if(el.id==='f-artistIds' &&modalWork){modalWork.artistIds=[...el.selectedOptions].map(option=>option.value);modalWork.artist=(state.artists||[]).filter(a=>modalWork.artistIds.includes(a.id)).map(a=>a.name).join(', ');document.querySelector('#f-artist').value=modalWork.artist;}
if(d.partyField==='artistId'&&modalWork){const row=el.closest('[data-party]'),artist=(state.artists||[]).find(a=>a.id===el.value);if(artist){row.querySelector('[data-party-field="name"]').value=artist.name;row.querySelector('[data-party-field="ipi"]').value=artist.ipi||'';if(artist.societies?.length===1)row.querySelector('[data-party-field="society"]').value=artist.societies[0];}}
if(el.id==='project-type')updateProjectTypeFields();
if(el.id==='file-input'){chooseExcelFiles(el.files);el.value='';}
if(el.id==='project-import-file'){const files=[...el.files],project=state.projects.find(item=>item.id===importModalProjectId);if(!files.length||!project)return;closeModal(true);if(go('import',{importProjectId:project.id,importSource:'excel'}))chooseExcelFiles(files);}
if(el.id==='workfile-default-type'){importDefaultType=el.value==='Movie'?'Movie':'Series';renderPage();}
if(el.id==='cue-project'){cueProject=el.value;cueListPage=1;renderPage();}
if(el.id==='export-project'){exportProject=el.value;exportEpisode=state.projects.find(p=>p.id===el.value).episodes[0]?.number||null;renderPage();}
if(el.id==='export-episode'){exportEpisode=Number(el.value);renderPage();}
if(el.id==='export-society'){exportSociety=el.value;renderPage();}
});
document.addEventListener('input',event=>{if(Catalog.input?.(event)||Management.input?.(event)||Discovery.input?.(event))return;if(['work-search','cue-search'].includes(event.target.id)){const id=event.target.id,position=event.target.selectionStart;query=event.target.value;if(id==='cue-search')cueListPage=1;renderPage();const el=document.getElementById(id);el.focus();el.setSelectionRange(position,position);}});
document.addEventListener('submit',event=>{if(Catalog.submit(event)||Portfolio.submit(event)||Management.submit(event)||Discovery.submit(event))return;event.preventDefault();const form=event.target,data=new FormData(form);
if(form.id==='google-sheet-range-form'){importGoogleSheetRange();return;}
if(form.id==='google-sheet-form'){loadGoogleSheetTabs({url:String(data.get('googleSheetUrl')||'').trim(),projectId:importTargetProjectId||String(data.get('projectId')||'')});return;}
if(form.id==='project-google-sheet-form'){const project=state.projects.find(item=>item.id===importModalProjectId),url=String(data.get('googleSheetUrl')||'').trim();if(!project)return toast('Choose a saved project before syncing.');closeModal(true);if(go('import',{importProjectId:project.id,importSource:'google'}))loadGoogleSheetTabs({url,projectId:project.id});return;}
if(form.id==='global-search'){query=String(data.get('search')).trim();go('search',{preserveQuery:true});}
if(form.id==='workspace-search'){query=String(data.get('q')).trim();page='search';renderPage();}
if(form.id==='cue-form'){const cue=state.cues.find(c=>c.id===form.dataset.id),title=workName(cue.workId),raw=Object.fromEntries(data),usage=D.usageFor(cue,'IPRS',title);if(cue.occurrences?.length>1){if(commit('Updated cumulative cue '+cue.id+' · '+title,()=>Object.assign(cue,{source:raw.source,notes:raw.notes}))){closeModal(true);renderPage();toast('Cumulative cue details saved.');}return;}const validation=D.validateRow({title,...raw,usage});if(validation.errors.length)return toast(validation.errors.join('. '));if(validation.start==null||validation.end==null)return toast('Enter both IN and OUT times to confirm timing.');if(state.cues.some(c=>c.id!==cue.id&&c.projectId===cue.projectId&&c.episode===cue.episode&&c.workId===cue.workId&&c.start===validation.start&&c.end===validation.end))return toast('This cue would duplicate an existing occurrence.');if(commit('Corrected cue '+cue.id+' · '+title,()=>{Object.assign(cue,{start:validation.start,end:validation.end,duration:validation.duration,usage,societyUsage:{...D.usageSetForTitle(title),...cue.societyUsage,IPRS:usage},source:raw.source,notes:raw.notes});if(cue.occurrences?.length===1)Object.assign(cue.occurrences[0],{start:cue.start,end:cue.end,duration:cue.duration});})){closeModal(true);renderPage();toast('Cue corrected. Duration recalculated from IN / OUT.');}}
if(form.id==='work-form'){
  collectWork();if(!modalWork.title.trim())return toast('A song title is required.');
  if(modalWork.parties.some(p=>!p.name||(p.share!==null&&(!Number.isFinite(p.share)||p.share<0||p.share>100))))return toast('Each rights holder needs a name and a share between 0 and 100, or a blank share when unknown.');
  const identifierConflict=state.works.find(work=>work.id!==modalWork.id&&((modalWork.isrc&&D.normalize(work.isrc)===D.normalize(modalWork.isrc))||(modalWork.iswc&&D.normalize(work.iswc)===D.normalize(modalWork.iswc))||(modalWork.tuneCode&&D.normalize(work.tuneCode)===D.normalize(modalWork.tuneCode))||['IPRS','ASCAP'].some(society=>modalWork.societies[society]&&D.normalize(work.societies?.[society])===D.normalize(modalWork.societies[society]))));
  if(identifierConflict)return toast('One of these song identifiers already belongs to '+identifierConflict.title+'. Open that record instead.');
  const before=structuredClone(state),i=state.works.findIndex(w=>w.id===modalWork.id),savedWork=structuredClone(modalWork);savedWork.status='Complete';delete savedWork.needsResolution;delete savedWork.resolutionReason;delete savedWork.resolutionKey;delete savedWork.possibleMatchIds;
  savedWork.activity.unshift({text:i<0?'Song created':'Song metadata updated',date:new Date().toISOString()});
  if(i<0)state.works.push(savedWork);else state.works[i]=savedWork;
  state.activity.unshift({text:'Updated song · '+savedWork.title,date:new Date().toISOString()});
  if(!save()){state=before;return;}
  closeModal();shell();toast('Song saved. All linked cues use this record.');
}
if(form.id==='client-form'){const name=String(data.get('name')).trim();if(!name)return toast('Enter a client name.');if(commit('Created client · '+name,workspace=>workspace.clients.push({id:uid('CL'),name,initials:name.split(/\s+/).slice(0,2).map(s=>s[0]).join('').toUpperCase(),contact:String(data.get('contact')).trim()}))){closeModal(true);go('clients');toast('Client created.');}}
if(form.id==='project-form'){
  const get=name=>String(data.get(name)||'').trim(),title=get('title'),type=get('type'),episode=Number(get('episode')),year=Number(get('year')),movie=type==='Movie',duration=get(movie?'duration':'episodeDuration'),season=Number(get('season')),totalEpisodes=Number(get('totalEpisodes'));
  if(!title)return toast('Enter a project title.');
  if(!['Series','Movie'].includes(type))return toast('Choose Series or Movie.');
  if(!Number.isInteger(year)||year<1800||year>2500)return toast('Use a valid four-digit production year.');
  if(!movie&&(!Number.isInteger(episode)||episode<1||!Number.isInteger(season)||season<1||!Number.isInteger(totalEpisodes)||totalEpisodes<episode))return toast('Use positive whole episode and season numbers. Total episodes must include the first episode.');
  if(duration&&(!Number.isFinite(D.seconds(duration))||D.seconds(duration)<=0))return toast('Duration must be a valid positive HH:MM:SS time.');
  const project={id:uid('PRJ'),title,type,clientId:get('clientId'),language:get('language'),year,genre:get('genre'),productionNo:get('productionNo'),bgComposer:get('bgComposer'),submittedBy:get('submittedBy'),channel:movie?'':get('channel'),serialType:movie?'':get('serialType'),duration:movie?duration:'',airdate:movie?get('airdate'):'',season:movie?1:season,totalEpisodes:movie?0:totalEpisodes,episodes:movie?[]:[{number:episode,title:get('episodeTitle'),airdate:get('episodeAirdate'),duration,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}],periods:[{from:1,to:movie?1:totalEpisodes,director:get('director'),producer:get('producer'),company:get('company'),cast:get('cast')}],color:'sage',updatedAt:new Date().toISOString()};
  if(commit('Created project · '+title,workspace=>workspace.projects.push(project))){closeModal(true);go('projects');toast('Project created.');}
}
});
document.addEventListener('dragover',event=>{if(event.target.closest('#dropzone')){event.preventDefault();document.querySelector('#dropzone').classList.add('dragging');}});
document.addEventListener('dragleave',event=>{if(event.target.closest('#dropzone'))document.querySelector('#dropzone').classList.remove('dragging');});
document.addEventListener('drop',event=>{if(event.target.closest('#dropzone')){event.preventDefault();document.querySelector('#dropzone')?.classList.remove('dragging');chooseExcelFiles(event.dataTransfer.files);}});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&document.querySelector('.modal')){event.preventDefault();closeModal();}});
function editCue(id){const c=state.cues.find(c=>c.id===id),title=workName(c.workId),cumulative=c.occurrences?.length>1;modalWork=null;showModal(modalHead('Correct cue · '+title)+`<div class="modal-body"><p class="subtitle">${esc(projectName(c.projectId))} · ${c.episode?'Episode '+c.episode:'Movie'} · ${esc(c.id)}</p><form id="cue-form" data-id="${esc(c.id)}"><div class="form-grid">${cumulative?`<p class="subtitle">${c.occurrences.map((use,index)=>`${index+1}. ${D.time(use.start)} → ${D.time(use.end)} · ${D.time(use.duration)}`).join('<br>')}<br><strong>Total: ${D.time(c.duration)} · ${c.usageCount} usages</strong></p>`:field('IN time (HH:MM:SS)','start',c.start==null?'':D.time(c.start))+field('OUT time (HH:MM:SS)','end',c.end==null?'':D.time(c.end))}<div class="field"><label for="cue-usage">Saved usage code</label><input class="input" name="usage" id="cue-usage" value="${esc(D.usageFor(c,'IPRS',title))}" readonly></div><div class="field"><label for="cue-source">Source</label><select class="input" name="source" id="cue-source">${options(['Original','Third-party','Library','Unknown'],c.source)}</select></div>${field('Cue notes','notes',c.notes,'text','full')}</div><p class="subtitle">${cumulative?'The imported occurrence timings and cumulative duration are preserved.':'Duration is recalculated automatically. Usage is classified from the cue title. Your original import history remains unchanged.'}</p><div class="panel-actions">${btn('Cancel','close-modal')}<button class="btn primary" type="submit">Save cue correction</button></div></form></div>`);}
const UI=createAmishnaUI({state:()=>state,revision:()=>dataRevision,replaceState:s=>{state=s;dataRevision++;lookupState=null;},save,esc,icon,options,toast,go,render:renderPage,modal:showModal,modalHead,close:closeModal,newProject,download:downloadBlob,startImport:openWorkfileImportModal,openExport:openProjectExport});
UI.initialize();
const uxContext={state:()=>state,revision:()=>dataRevision,esc,icon,options,badge,statusBadge,date,toast,save,commit,render:renderPage,go,openWork,download:downloadBlob,modal:showModal,modalHead,close:closeModal,startImport:openWorkfileImportModal,query:()=>query,setQuery:v=>{query=v;},exportState:()=>({project:exportProject,episode:exportEpisode,society:exportSociety}),setExportState:values=>{if(Object.hasOwn(values,'project'))exportProject=values.project;if(Object.hasOwn(values,'episode'))exportEpisode=values.episode;if(Object.hasOwn(values,'society'))exportSociety=values.society;},exportScope,generateExport,openExport:openProjectExport,UI:()=>UI};
const ExportDialog=createCueExportDialog({state:()=>state,modal:showModal,modalHead,close:closeModal,toast,commit,download:downloadBlob});
const Portfolio=createPortfolioUX(uxContext),Management=createManagementUX(uxContext),Discovery=createDiscoveryUX(uxContext),Catalog=CueCatalog.create(uxContext),DatabaseImport=CueDatabaseImport.create(uxContext);
const refreshDraftStatus=()=>persistence.setDraft?.(!!modalDraft||!!UI.hasDraft?.());
function guardUnsavedModal(event){if(!workspaceClosed&&modalDraft&&document.querySelector('#modal-root .modal form')){event.preventDefault();event.returnValue='';}}
window.addEventListener('beforeunload',guardUnsavedModal);
for(const eventName of ['input','change'])document.addEventListener(eventName,event=>{
  if(event.target.closest('.modal form'))modalDraft=true;
  queueMicrotask(refreshDraftStatus);
},true);
for(const eventName of ['click','submit','keydown'])document.addEventListener(eventName,event=>{
  if(eventName==='click'&&event.target.closest('[data-action="add-party"],[data-remove-party]'))modalDraft=true;
  queueMicrotask(refreshDraftStatus);
},true);
function simpleWorkfileGuide(){
  const cells=[['A1','Total duration','00:24:06'],['B1','Date','12 Sep 2022'],['C1','Serial / movie name','Monsoon Diaries'],['E1','Episode / work no.','49']];
  return `<section class="wi-format-card" aria-labelledby="fixed-format-title"><div class="wi-format-head"><div><span class="eyebrow">YOUR PERMANENT FORMAT</span><h2 id="fixed-format-title">One layout for serials and movies</h2><p>Every workfile uses these cells. Repeated tracks in one episode become one cue with cumulative duration and usage count.</p></div>${badge('Fixed format','green')}</div><div class="wi-cell-strip">${cells.map(([cell,label,value])=>`<div><span class="wi-cell">${cell}</span><strong>${label}</strong><small>${value}</small></div>`).join('')}</div><div class="wi-cue-rule"><span>Row 2</span><strong>A · In Time</strong><strong>B · Out Time</strong><strong>C · Duration</strong><strong>D · Track Name</strong><span>Row 3 onward · one occurrence per row</span></div></section>`;
}
const importMovieFields=[['Genre / category','genre'],['Language','language'],['Production number (from censor certificate)','productionNo'],['Date of first performed','airdate','date'],['Production year','year','number'],['Producer','producer'],['Director','director'],['Banner / production company','company'],['Principal actors / actress','cast'],['Total movie duration (HH:MM:SS)','duration'],['Background music composer','bgComposer'],['Submitted by (name of C/A/E)','submittedBy']];
const importMovieDetails={};
for(const eventName of ['input','change'])document.addEventListener(eventName,event=>{
  const name=event.target.dataset.workfileMovieField;
  if(name&&importMovieFields.some(([,field])=>field===name)&&!bulkImportActive)importMovieDetails[name]=event.target.value;
});
function bulkMovieDetailsView(){
  if(importDefaultType!=='Movie')return '';
  return `<section class="wi-movie-details" aria-labelledby="workfile-movie-heading"><div><span class="eyebrow">IPRS MOVIE CUE SHEET</span><h3 id="workfile-movie-heading">Movie details</h3><p>Fill the details before choosing a workfile. For a batch, these values apply to every newly created movie; leave any details that differ blank and edit them in each project's Production details. Saved projects keep their metadata.</p><p>The movie title comes from C1. Leave the date and duration blank to use B1 and A1. Total musical duration is calculated from the cues.</p></div><fieldset class="form-grid" ${bulkImportActive?'disabled':''}><legend class="sr-only">Details for new movie projects</legend>${importMovieFields.map(([label,name,type='text'])=>`<div class="field"><label for="workfile-movie-${name}">${label}</label><input class="input" id="workfile-movie-${name}" data-workfile-movie-field="${name}" type="${type}" value="${esc(importMovieDetails[name]||'')}" ${name==='year'?'min="1800" max="2500" step="1"':name==='duration'?'placeholder="02:00:00"':''}></div>`).join('')}</fieldset></section>`;
}
function bulkMovieDetailsError(details){
  if(details.year&&(!/^\d{4}$/.test(details.year)||Number(details.year)<1800||Number(details.year)>2500))return 'Use a valid four-digit movie production year.';
  if(details.duration&&(!/^\d+:[0-5]\d:[0-5]\d$/.test(details.duration)||D.seconds(details.duration)<=0))return 'Movie duration must be a positive HH:MM:SS time.';
  return '';
}
function bulkApplyMovieDetails(project,details={}){
  for(const key of ['genre','language','productionNo','airdate','bgComposer','submittedBy'])if(details[key])project[key]=details[key];
  if(details.year)project.year=Number(details.year);
  if(details.duration)project.duration=D.time(D.seconds(details.duration));
  for(const key of ['director','producer','company','cast'])if(details[key])project.periods[0][key]=details[key];
}
function bulkColumnField(value){const automatic=D.autoMap([value])[0];if(automatic)return automatic;const key=D.normalize(value);return ({iswc:'iswc',tunecode:'tuneCode',artist:'artist',artistname:'artist',singer:'artist',singername:'artist',iprsworkcode:'iprsCode',iprssongcode:'iprsCode',iprcode:'iprsCode',ascapcode:'ascapCode',ascapworkcode:'ascapCode'})[key]||'';}
function bulkEpisodeFromSheet(sheetName,index,total){
  const name=String(sheetName||'').trim(),labelled=name.match(/(?:episode|ep)\s*[-_:#]*\s*0*(\d+)\b/i),numeric=name.match(/^0*(\d+)$/);let value=labelled?.[1]||numeric?.[1];
  if(!value&&total>1)value=String(index+1);const number=Number(value);return Number.isInteger(number)&&number>0?number:null;
}
function bulkGoogleEpisodeTitle(session,sharedName,projectNames){
  const cellTitle=String(session.workfile.serialName||'').trim(),number=session.workfile.episodeNumber||1;
  if(cellTitle&&!sharedName&&!projectNames.has(D.normalize(cellTitle)))return cellTitle;
  const tab=String(session.sheet||'').trim();
  return tab&&!/^(?:workfile|sheet\s*\d*|\d+)$/i.test(tab)?tab:'Episode '+number;
}
function bulkWorkbookTitle(filename){return String(filename||'Imported series').replace(/\.[^.]+$/,'').replace(/[_-]+/g,' ').replace(/\s+/g,' ').trim()||'Imported series';}
function bulkImportRows(session){
  const start=session.workfile.dataStartIndex,header=session.workfile.hasHeader?(session.raw[session.workfile.headerIndex]||[]):[],mapping=session.workfile.hasHeader?header.map(bulkColumnField):['start','end','duration','title'];
  mapping[0]='start';mapping[1]='end';mapping[2]='duration';mapping[3]='title';
  return session.raw.slice(start).map((cells,index)=>({cells,rowNumber:start+index+1})).filter(({cells})=>cells.slice(0,4).some(value=>value!==''&&value!=null)).map(({cells,rowNumber})=>{
    const raw={};mapping.forEach((field,index)=>{if(field&&cells[index]!==''&&cells[index]!=null)raw[field]=cells[index];});
    const extra={};if(header.length>4)header.slice(4).forEach((name,index)=>{const value=cells[index+4];if(String(name??'').trim()&&value!==''&&value!=null&&!mapping[index+4])extra[String(name).trim()]=String(value);});
    return {raw,rowNumber,extra};
  });
}
function bulkValidateSession(session){
  const errors=[...D.validateFixedWorkfile(session.workfile)],rows=bulkImportRows(session);
  if(!rows.length)errors.push('Add at least one cue row below the header');
  for(const item of rows){
    const prefix='Row '+item.rowNumber+': ',raw=item.raw||{},timing=D.validateRow(raw);
    if(!String(raw.title||'').trim())errors.push(prefix+'Track Name is required');
    if(!Number.isFinite(timing.start)||!Number.isFinite(timing.end)||timing.end<=timing.start)errors.push(prefix+'enter valid In Time and Out Time, with Out after In');
    if(timing.errors.some(message=>message.includes('Supplied duration differs')))errors.push(prefix+'Duration does not match In Time and Out Time');
    if(Number.isFinite(session.workfile.totalDurationSeconds)&&Number.isFinite(timing.end)&&timing.end>session.workfile.totalDurationSeconds)errors.push(prefix+'Out Time exceeds the total duration in A1');
    if(errors.length>=20)break;
  }
  return errors;
}
function bulkProject(session,workspace,titleCounts){
  const m=session.workfile,name=String(session.projectName||m.serialName||session.filename.replace(/\.[^.]+$/,'')||'Imported workfile').trim(),normalized=D.normalize(name),episodeText=String(session.raw?.[0]?.[4]??''),episodeNumber=Number.isInteger(m.episodeNumber)&&m.episodeNumber>0?m.episodeNumber:1,episodeTitle=String(session.episodeTitle||'Episode '+episodeNumber).trim();
  let matches=workspace.projects.filter(project=>D.normalize(project.title)===normalized),project=session.linkedProjectId?workspace.projects.find(item=>item.id===session.linkedProjectId)||null:null;
  project??=session.forceSeries?(matches.find(item=>item.type==='Series')||null):(matches.find(item=>item.type==='Series'&&item.episodes?.some(ep=>ep.number===episodeNumber))||matches[0]);
  let created=false;
  if(!project){
    const repeated=(titleCounts.get(normalized)||0)>1,explicitSeries=/\b(?:episode|ep)\b/i.test(episodeText),explicitMovie=/\b(?:movie|film|feature)\b/i.test(episodeText),type=session.forceSeries||explicitSeries||repeated?'Series':explicitMovie?'Movie':session.defaultProjectType==='Movie'?'Movie':'Series',year=(()=>{const parsed=new Date(m.dateDisplay||m.date);return Number.isFinite(parsed.getTime())?parsed.getFullYear():new Date().getFullYear();})();
    project={id:uid('PRJ'),title:name,type,clientId:'',language:'',year,genre:'',channel:'',productionNo:'',duration:'',airdate:'',season:1,totalEpisodes:type==='Series'?episodeNumber:0,episodes:type==='Series'?[{number:episodeNumber,title:episodeTitle,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}]:[],periods:[{from:1,to:type==='Series'?episodeNumber:1,director:'',producer:'',company:'',cast:''}],status:'Draft',color:'sage',importNeedsReview:true,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    workspace.projects.push(project);created=true;
  }
  const duration=Number.isFinite(m.totalDurationSeconds)&&m.totalDurationSeconds>0?D.time(m.totalDurationSeconds):'',airdate=String(m.dateDisplay||m.date||'');
  if(project.type==='Series'){
    let episode=project.episodes.find(item=>item.number===episodeNumber);if(!episode){episode={number:episodeNumber,title:episodeTitle,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};project.episodes.push(episode);project.episodes.sort((a,b)=>a.number-b.number);}
    const baseline=session.googleSheetId&&session.previousEpisodeBaseline?.episodeNumber===episodeNumber?session.previousEpisodeBaseline:null;
    if(session.googleSheetId){
      if(episodeTitle&&(!episode.title||(baseline?episode.title===baseline.title:episode.title==='Episode '+episodeNumber)))episode.title=episodeTitle;
      if(duration&&(!episode.duration||baseline&&episode.duration===baseline.duration))episode.duration=duration;
      if(airdate&&(!episode.airdate||baseline&&episode.airdate===baseline.airdate))episode.airdate=airdate;
    }else{
      if(session.episodeTitle&&(!episode.title||episode.title==='Episode '+episodeNumber))episode.title=episodeTitle;
      if(duration)episode.duration=duration;if(airdate)episode.airdate=airdate;
    }
    project.totalEpisodes=Math.max(Number(project.totalEpisodes)||0,...project.episodes.map(item=>item.number));
    if(project.importNeedsReview&&project.periods?.length===1&&!project.periods[0].director&&!project.periods[0].producer&&!project.periods[0].company){project.periods[0].from=Math.min(...project.episodes.map(item=>item.number));project.periods[0].to=Math.max(...project.episodes.map(item=>item.number));}
    session.episode=episodeNumber;
  }else{
    if(duration&&!project.duration)project.duration=duration;if(airdate&&!project.airdate)project.airdate=airdate;if(m.episodeNumber&&!project.workNumber)project.workNumber=m.episodeNumber;session.episode=null;
    if(created)bulkApplyMovieDetails(project,session.movieDetails);
  }
  project.updatedAt=new Date().toISOString();session.projectId=project.id;session.destinationCreated=created;return project;
}
function bulkFillMissingWork(workspace,work,raw){
  const free=(field,value)=>value&&!workspace.works.some(other=>other.id!==work.id&&D.normalize(other[field])===D.normalize(value));
  if(!work.isrc&&free('isrc',raw.isrc))work.isrc=String(raw.isrc).trim();if(!work.iswc&&free('iswc',raw.iswc))work.iswc=String(raw.iswc).trim();if(!work.tuneCode&&free('tuneCode',raw.tuneCode))work.tuneCode=String(raw.tuneCode).trim();
  work.societies??={IPRS:'',PRS:'',ASCAP:''};const iprs=raw.iprsCode||raw.societyId;if(!work.societies.IPRS&&iprs&&!workspace.works.some(other=>other.id!==work.id&&D.normalize(other.societies?.IPRS)===D.normalize(iprs)))work.societies.IPRS=String(iprs).trim();if(!work.societies.ASCAP&&raw.ascapCode&&!workspace.works.some(other=>other.id!==work.id&&D.normalize(other.societies?.ASCAP)===D.normalize(raw.ascapCode)))work.societies.ASCAP=String(raw.ascapCode).trim();
  if(!work.artist&&raw.artist)work.artist=String(raw.artist).trim();if((!work.source||work.source==='Unknown')&&raw.source)work.source=String(raw.source).trim();if(!(work.parties||[]).length&&raw.composer)work.parties=[{name:String(raw.composer).trim(),role:'Composer',share:null,ipi:'',society:''}];return work;
}
function bulkNewWork(raw,title,project,details={}){
  const unresolved=Boolean(details.ambiguous),resolutionKey=JSON.stringify([D.normalize(title),D.normalize(raw.workId),D.normalize(raw.isrc),D.normalize(raw.iswc),D.normalize(raw.tuneCode),D.normalize(raw.iprsCode||raw.societyId),D.normalize(raw.ascapCode),D.normalize(raw.composer)]),work={id:uid('WRK'),title,alternateTitles:[],type:'Song',language:project.language||'',status:unresolved?'Needs resolution':'Complete',isrc:unresolved?'':String(raw.isrc||''),iswc:unresolved?'':String(raw.iswc||''),tuneCode:unresolved?'':String(raw.tuneCode||''),societies:{IPRS:unresolved?'':String(raw.iprsCode||raw.societyId||''),PRS:'',ASCAP:unresolved?'':String(raw.ascapCode||'')},parties:raw.composer?[{name:String(raw.composer).trim(),role:'Composer',share:null,ipi:'',society:''}]:[],artist:String(raw.artist||''),label:'',source:String(raw.source||'Unknown'),notes:'',research:{source:'',url:'',notes:''},needsMetadata:true,needsResolution:unresolved,resolutionKey:unresolved?resolutionKey:undefined,possibleMatchIds:details.possibleMatchIds||[],resolutionReason:details.reason||'',importedIdentifiers:unresolved?{workId:String(raw.workId||''),isrc:String(raw.isrc||''),iswc:String(raw.iswc||''),tuneCode:String(raw.tuneCode||''),IPRS:String(raw.iprsCode||raw.societyId||''),ASCAP:String(raw.ascapCode||'')}:undefined,importedFromWorkfile:true,activity:[{text:unresolved?'Created for manual resolution because uploaded identifiers were ambiguous':'Created automatically from '+project.title+' workfile',date:new Date().toISOString()}]};
  return work;
}
function bulkFindWork(workspace,raw,title,project){
  const resolutionKey=JSON.stringify([D.normalize(title),D.normalize(raw.workId),D.normalize(raw.isrc),D.normalize(raw.iswc),D.normalize(raw.tuneCode),D.normalize(raw.iprsCode||raw.societyId),D.normalize(raw.ascapCode),D.normalize(raw.composer)]),pending=workspace.works.find(work=>work.needsResolution&&work.resolutionKey===resolutionKey);if(pending)return {work:pending,created:false,ambiguous:true};
  const checks=[['workId',raw.workId,work=>work.id],['ISRC',raw.isrc,work=>work.isrc],['ISWC',raw.iswc,work=>work.iswc],['Tune Code',raw.tuneCode,work=>work.tuneCode],['IPRS Work Code',raw.iprsCode||raw.societyId,work=>work.societies?.IPRS],['ASCAP Code',raw.ascapCode,work=>work.societies?.ASCAP]].filter(([,value])=>String(value??'').trim());
  const identifierMatches=checks.map(([label,value,read])=>({label,ids:workspace.works.filter(work=>D.normalize(read(work))===D.normalize(value)).map(work=>work.id)})).filter(item=>item.ids.length),identifierIds=new Set(identifierMatches.flatMap(item=>item.ids));
  if(identifierIds.size===1){const work=workspace.works.find(item=>item.id===[...identifierIds][0]);return {work:bulkFillMissingWork(workspace,work,raw),created:false,ambiguous:false};}
  if(identifierIds.size>1){const work=bulkNewWork(raw,title,project,{ambiguous:true,possibleMatchIds:[...identifierIds],reason:'Uploaded identifiers point to different saved songs'});workspace.works.push(work);return {work,created:true,ambiguous:true};}
  let choices=workspace.works.filter(work=>[work.title,...(work.alternateTitles||[])].some(value=>D.normalize(value)===D.normalize(title)));const composer=D.normalize(raw.composer);if(composer){const exact=choices.filter(work=>(work.parties||[]).some(party=>party.role==='Composer'&&D.normalize(party.name)===composer));if(exact.length)choices=exact;}
  if(choices.length===1)return {work:bulkFillMissingWork(workspace,choices[0],raw),created:false,ambiguous:false};
  if(choices.length>1){const work=bulkNewWork(raw,title,project,{ambiguous:true,possibleMatchIds:choices.map(item=>item.id),reason:'The title matches multiple saved songs'});workspace.works.push(work);return {work,created:true,ambiguous:true};}
  const work=bulkNewWork(raw,title,project);workspace.works.push(work);return {work,created:true,ambiguous:false};
}
function bulkTiming(raw,workfile){
  const checked=D.validateRow(raw),parsedStart=D.seconds(raw.start),parsedEnd=D.seconds(raw.end),supplied=D.seconds(raw.duration),validPair=Number.isFinite(parsedStart)&&Number.isFinite(parsedEnd)&&parsedEnd>parsedStart;
  const start=Number.isFinite(parsedStart)?parsedStart:null,end=Number.isFinite(parsedEnd)?parsedEnd:null,duration=validPair?parsedEnd-parsedStart:Number.isFinite(supplied)&&supplied>0?supplied:0,warnings=[...checked.errors,...checked.warnings];
  if(Number.isFinite(workfile.totalDurationSeconds)&&Number.isFinite(end)&&end>workfile.totalDurationSeconds)warnings.push('OUT time exceeds A1 total duration');
  return {start,end,duration,warnings:[...new Set(warnings)]};
}
function bulkApplySession(session,workspace,titleCounts,createdWorkIds,onValidated,cueBuckets=null){
  const validationErrors=bulkValidateSession(session);
  if(validationErrors.length){session.validationErrors=validationErrors;session.setupError=validationErrors.slice(0,3).join('; ')+(validationErrors.length>3?'; +'+(validationErrors.length-3)+' more errors':'');session.queueState='error';return {cues:0,usages:0,matched:0,newWorks:0,duplicates:0,warnings:0,projectId:null};}
  const rows=bulkImportRows(session);if(!rows.length){session.setupError='No cue rows were found from row 4 onward';session.queueState='error';return {cues:0,matched:0,newWorks:0,duplicates:0,warnings:1,projectId:null};}
  if(onValidated)onValidated();
  const project=bulkProject(session,workspace,titleCounts),importId=uid('IMP'),fileWarnings=[...D.validateFixedWorkfile(session.workfile),...(session.inferenceWarnings||[])];let cues=0,usages=0,matched=0,newWorks=0,duplicates=0,warnings=fileWarnings.length;session.fileWarnings=fileWarnings;
  const bucketKey=project.id+'\0'+(project.type==='Movie'?'movie':session.episode);
  const episodeCues=cueBuckets
    ? (cueBuckets.get(bucketKey)||[])
    : workspace.cues.filter(cue=>cue.projectId===project.id&&cue.episode===(project.type==='Movie'?null:session.episode));
  if(cueBuckets&&!cueBuckets.has(bucketKey))cueBuckets.set(bucketKey,episodeCues);
  for(const item of rows){
    const missingTitle=!String(item.raw.title||'').trim(),title=missingTitle?`Untitled cue · ${session.filename} · row ${item.rowNumber}`:String(item.raw.title).trim(),timing=bulkTiming({...item.raw,title},session.workfile),episode=project.type==='Movie'?null:session.episode,sourceKey=[session.sourceKeyPrefix||session.filename,session.sheet,item.rowNumber].join('|'),importFingerprint=JSON.stringify([D.normalize(project.title),episode,D.normalize(session.workfile.dateDisplay||session.workfile.date),item.rowNumber,D.normalize(item.raw.title||''),timing.start,timing.end,timing.duration]);
    if(episodeCues.some(cue=>cue.importFingerprint===importFingerprint||cue.importSourceKey===sourceKey||cue.occurrences?.some(use=>use.importFingerprint===importFingerprint||use.importSourceKey===sourceKey))){duplicates++;continue;}
    const match=bulkFindWork(workspace,item.raw,title,project);
    if(match.created){newWorks++;createdWorkIds.add(match.work.id);}else if(!createdWorkIds.has(match.work.id))matched++;
    const exactDuplicate=episodeCues.some(cue=>cue.workId===match.work.id&&Number.isFinite(timing.start)&&Number.isFinite(timing.end)&&(cue.start===timing.start&&cue.end===timing.end||cue.occurrences?.some(use=>use.start===timing.start&&use.end===timing.end)));
    if(exactDuplicate){duplicates++;continue;}
    const possibleDurationDuplicate=timing.start==null&&timing.end==null&&timing.duration>0&&episodeCues.some(cue=>cue.workId===match.work.id&&(cue.occurrences?.some(use=>use.start==null&&use.end==null&&use.duration===timing.duration)||!cue.occurrences&&cue.start==null&&cue.end==null&&cue.duration===timing.duration)),rowWarnings=[...timing.warnings];if(missingTitle)rowWarnings.push('Track name was empty; replace the generated title later');if(match.ambiguous)rowWarnings.push('Song match needs resolution; a separate editable record was created without copying conflicting identifiers');if(possibleDurationDuplicate)rowWarnings.push('Possible repeated duration-only cue; kept because separate occurrences cannot be proved identical');warnings+=rowWarnings.length;
    const societyUsage=D.usageSetForWork(match.work);
    const occurrence={start:timing.start,end:timing.end,duration:timing.duration,rowNumber:item.rowNumber,filename:session.filename,sheet:session.sheet,importSourceKey:sourceKey,importFingerprint,notes:String(item.raw.notes||''),importWarnings:rowWarnings,importedValues:item.extra};if(session.googleSheetId){occurrence.googleSheetId=session.googleSheetId;occurrence.googleSheetTab=session.sheet;}
    const existing=episodeCues.find(cue=>cue.workId===match.work.id&&(cue.importedFromWorkfile||cue.importSourceKey));
    if(existing){
      if(!Array.isArray(existing.occurrences))existing.occurrences=[{start:existing.start,end:existing.end,duration:existing.duration,importSourceKey:existing.importSourceKey,importFingerprint:existing.importFingerprint,notes:existing.notes||'',importWarnings:existing.importWarnings||[],importedValues:existing.importedValues||{}}];
      existing.occurrences.push(occurrence);existing.duration=existing.occurrences.reduce((sum,use)=>sum+(Number(use.duration)||0),0);existing.usageCount=existing.occurrences.length;existing.start=null;existing.end=null;existing.importedFromWorkfile=true;existing.importWarnings=[...new Set([...(existing.importWarnings||[]),...rowWarnings])];
    }else{
      const cue={id:uid('CUE'),projectId:project.id,episode,workId:match.work.id,start:timing.start,end:timing.end,duration:timing.duration,usage:societyUsage.IPRS,societyUsage,source:String(item.raw.source||match.work.source||'Unknown'),notes:String(item.raw.notes||''),timingReviewed:false,usageCount:1,themeTreatment:'Not specified',importId,importSourceKey:sourceKey,importFingerprint,importWarnings:rowWarnings,importedValues:item.extra,importedFromWorkfile:true,occurrences:[occurrence]};workspace.cues.push(cue);episodeCues.push(cue);cues++;
    }
    usages++;
  }
  workspace.imports.unshift({id:importId,filename:session.filename,sheet:session.sheet,projectId:project.id,clientId:project.clientId,count:cues,usages,newWorks,matched,warnings,skippedDuplicates:duplicates,profile:'Automatic fixed workfile',sourceType:session.googleSheetId?'Google Sheet':'Excel',googleSheetId:session.googleSheetId||undefined,mapping:['start','end','duration','title'],headers:['In Time','Out Time','Duration','Track Name'],workfileMetadata:{totalDuration:Number.isFinite(session.workfile.totalDurationSeconds)?D.time(session.workfile.totalDurationSeconds):'',date:String(session.workfile.dateDisplay||session.workfile.date||''),serialName:String(session.projectName||session.workfile.serialName||project.title),episodeTitle:String(session.episodeTitle||''),episodeNumber:session.workfile.episodeNumber},automatic:true,user:'Local administrator',date:new Date().toISOString()});
  Object.assign(session,{queueState:'complete',importedCount:cues,importedUsages:usages,createdCount:newWorks,matchedCount:matched,duplicateCount:duplicates,warningCount:warnings});return {cues,usages,matched,newWorks,duplicates,warnings,projectId:project.id};
}
function bulkQueueView(){
  if(!importQueue.length&&!importReadProgress)return '';
  const imported=importQueue.filter(item=>['ready','complete'].includes(item.queueState)).length,removed=importQueue.filter(item=>['removed','removed-complete'].includes(item.queueState)).length;
  const countLabel=imported+(bulkImportPending?' ready':' imported')+(removed?' · '+removed+' tab'+(removed===1?'':'s')+(bulkImportPending?' to remove':' removed'):'');
  const description=bulkImportActive?'Files and worksheets are being checked. Keep this tab open.':bulkImportPending?'Review valid, failed and removed worksheets before saving.':removed?'Google Sheet sync completed. Review removed and failed tabs below.':'Only valid worksheets were imported. Review any failed sheets below.';
  const cardState=item=>item.queueState==='complete'?'Imported':item.queueState==='ready'?'Ready':item.queueState==='removed-complete'?'Removed':item.queueState==='removed'?'Will remove':item.queueState==='error'?'Not imported':'Reading';
  const cardColor=item=>item.queueState==='complete'?'green':item.queueState==='ready'?'blue':['removed','removed-complete'].includes(item.queueState)?'amber':item.queueState==='error'?'rose':'gray';
  return `<section class="panel wi-queue-simple"><div class="panel-head"><div><h2>${bulkImportActive?'Processing':bulkImportPending?'Review worksheets':'Latest batch'}</h2><p>${description}</p></div>${importReadProgress?badge(importReadProgress.done+' / '+importReadProgress.total,'green'):badge(countLabel,'green')}</div>${importReadProgress?`<div class="wi-reading" role="status"><span style="width:${Math.round(importReadProgress.done/Math.max(1,importReadProgress.total)*100)}%"></span><p>${esc(importReadProgress.phase||'Reading')} · ${importReadProgress.done} of ${importReadProgress.total}</p></div>`:''}<div class="wi-queue-cards">${importQueue.map(item=>`<article class="wi-queue-item"><span class="wi-queue-file-icon">${icon(item.queueState==='error'?'alert':item.queueState==='removed'||item.queueState==='removed-complete'?'trash':'file')}</span><div class="wi-queue-file-copy"><strong>${esc(item.filename)}${item.sheet?' · '+esc(item.sheet):''}</strong><span>${esc(item.setupError||item.projectName||item.workfile?.serialName||'Reading fixed cells…')}${item.workfile?.episodeNumber?' · Episode '+item.workfile.episodeNumber:''}</span></div><span class="wi-cue-count">${item.importedCount??item.cueCount??'—'} cues</span>${badge(cardState(item),cardColor(item))}</article>`).join('')}</div></section>`;
}
function googleSheetView(){
  const project=state.projects.find(item=>item.id===importTargetProjectId),links=(state.preferences?.googleSheets||[]).filter(link=>!project||link.projectId===project.id),busy=googleSheetBusy||bulkImportActive;
  const picker=project?'':state.projects.length?`<label class="wi-project-select">Project in CMS<select class="input" name="projectId" form="google-sheet-form" required ${busy?'disabled':''}><option value="">Choose a saved project</option>${options(state.projects.map(item=>({value:item.id,label:item.title})))}</select></label>`:`<div class="wi-project-select"><span>Create a project before linking a Google Sheet.</span><button class="btn" type="button" data-action="new-project">Create project</button></div>`;
  return `<div class="wi-google-source wi-source-stage"><div class="wi-stage-intro"><span class="wi-kicker">STEP 1 · CONNECT SHEET</span><h2>Paste a Google Sheets link</h2><p>Set sharing to “Anyone with the link · Viewer”, then load its tabs. You choose the episode range before preview.</p></div>${picker}<form id="google-sheet-form" class="wi-google-form"><label>Google Sheets link<input class="input" type="url" name="googleSheetUrl" placeholder="https://docs.google.com/spreadsheets/d/.../edit" value="${esc(googleSheetSelection?.url||'')}" required ${busy?'disabled':''}></label><button class="btn primary" type="submit" ${busy||!state.projects.length?'disabled':''}>${googleSheetBusy?'Loading tabs…':'Load tabs'}</button></form>${googleSheetRangeView()}${googleSheetError?`<p class="wi-google-error" role="alert">${esc(googleSheetError)}</p>`:''}${links.length?`<div class="wi-google-links"><h3>Linked sheets</h3>${links.map(link=>`<div class="wi-google-link"><div><strong>${esc(state.projects.find(item=>item.id===link.projectId)?.title||link.projectName)}</strong><span>Last synced ${link.lastSyncedAt?esc(date(link.lastSyncedAt)):'-'} - ${esc(link.id)}</span></div><button class="btn" type="button" data-google-sync="${esc(link.id)}" ${busy?'disabled':''}>Sync now</button><button class="btn" type="button" data-google-detach="${esc(link.id)}" ${busy?'disabled':''}>Detach</button></div>`).join('')}</div>`:''}<p class="wi-google-note">Sync replaces cue rows imported from this sheet, including edits made to those rows in the CMS. Make lasting corrections in Google Sheets. Other imports and song metadata stay in place. The Excel import size limits also apply.</p></div>`;
}
function excelSelectionPlan(){
  let count=0;
  for(const item of excelSelection){
    if(!item.sheetNames.length||!Number.isSafeInteger(item.from)||!Number.isSafeInteger(item.to)||item.from<1||item.to<item.from||item.to>item.sheetNames.length)return {count,error:'Choose a valid first and last worksheet for every file.'};
    count+=item.to-item.from+1;
  }
  const chosenProject=state.projects.find(project=>project.id===importTargetProjectId);
  if(chosenProject?.type==='Movie'&&excelSelection.some(item=>item.to>item.from))
    return {count,error:`${chosenProject.title} is a Movie project. Use Import on a Series project, or open Import workfiles from the sidebar to create one.`};
  return {count,error:count>250?'Choose up to 250 episodes in one batch. Narrow a file range or remove a file.':''};
}
async function chooseExcelFiles(fileList){
  if(excelInspectBusy||bulkImportActive||bulkImportPending)return toast('Finish the current import or review first.');
  const files=[...fileList];if(!files.length)return;
  if(files.length>250){excelSelectionError='Choose up to 250 files so the batch can stay within 250 episodes.';renderPage();return;}
  excelSelection=[];excelSelectionError='';excelInspectBusy=true;renderPage();const errors=[];
  for(const file of files){
    try{
      const details=await CueFileSafety.inspect(file),sheetNames=details.sheetNames;
      excelSelection.push({file,sheetNames,from:1,to:files.length===1?Math.min(250,sheetNames.length):1});
    }catch(error){errors.push(file.name+': '+(error.message||'File could not be read.'));}
  }
  excelInspectBusy=false;excelSelectionError=errors.slice(0,3).join(' ')+(errors.length>3?' '+(errors.length-3)+' more files could not be read.':'');renderPage();
}
async function previewExcelSelection(){
  if(excelInspectBusy||bulkImportActive||bulkImportPending)return;
  const plan=excelSelectionPlan();if(plan.error||!plan.count){excelSelectionError=plan.error||'Choose at least one file.';renderPage();return;}
  const project=state.projects.find(item=>item.id===importTargetProjectId);
  await bulkReadFiles(excelSelection.map(item=>item.file),{...(project?{projectId:project.id,projectName:project.title}:{}),excelSelection:excelSelection.map(item=>({sheetNames:item.sheetNames.slice(item.from-1,item.to),sheetOffset:item.from-1}))});
}
function excelRangeView(){
  if(!excelSelection.length&&!excelInspectBusy&&!excelSelectionError)return '';
  const plan=excelSelectionPlan(),busy=excelInspectBusy||bulkImportActive,optionsFor=(item,bound)=>item.sheetNames.map((name,index)=>`<option value="${index+1}" ${item[bound]===index+1?'selected':''}>${index+1}. ${esc(name)}</option>`).join('');
  return `<section class="wi-range-card" aria-label="Excel worksheet selection"><div class="wi-range-head"><div><span class="wi-kicker">STEP 2 · CHOOSE EPISODES</span><h3>${excelInspectBusy?'Finding worksheets…':'Select the range to preview'}</h3><p>Choose the first and last worksheet from each file. Each worksheet counts as one episode.</p></div>${excelSelection.length?`<button type="button" class="btn" data-action="clear-excel-selection" ${busy?'disabled':''}>Clear files</button>`:''}</div>${excelSelection.length?`<div class="wi-range-list">${excelSelection.map((item,index)=>`<div class="wi-range-row"><div class="wi-range-file"><strong>${esc(item.file.name)}</strong><span>${item.sheetNames.length} worksheet${item.sheetNames.length===1?'':'s'} · ${(item.file.size/1024/1024).toFixed(2)} MB</span></div><label>First worksheet<select class="input" data-excel-index="${index}" data-excel-range="from" ${busy?'disabled':''}>${optionsFor(item,'from')}</select></label><label>Last worksheet<select class="input" data-excel-index="${index}" data-excel-range="to" ${busy?'disabled':''}>${optionsFor(item,'to')}</select></label><button type="button" class="btn wi-remove-file" data-excel-remove="${index}" aria-label="Remove ${esc(item.file.name)}" ${busy?'disabled':''}>Remove</button></div>`).join('')}</div><div class="wi-range-footer"><div><strong>${plan.count} / 250 episodes selected</strong><span>Original files stay unchanged. Only the selected worksheets are parsed for preview.</span></div><button type="button" class="btn primary" data-action="preview-excel-selection" ${busy||!!plan.error?'disabled':''}>${busy?'Reading files…':'Preview selected episodes'}</button></div>`:''}${excelSelectionError||plan.error?`<p class="wi-range-error" role="alert">${esc(excelSelectionError||plan.error)}</p>`:''}</section>`;
}
function excelWorkfileView(project){
  return `<div class="wi-source-stage"><div class="wi-stage-intro"><span class="wi-kicker">STEP 1 · ADD FILES</span><h2>Choose Excel workfiles</h2><p>Pick one or more XLSX, XLS, or CSV files. Then choose which episodes to preview.</p></div><div id="dropzone" class="dropzone wi-dropzone-simple wi-dropzone-new ${bulkImportActive||excelInspectBusy?'wi-disabled':''}">${icon('upload')}<h3>${excelInspectBusy?'Finding worksheets…':'Drop files here or browse'}</h3><p>10 MB per file · Up to 250 episodes per batch</p><label class="btn primary" for="file-input">${icon('plus')}Browse files</label><input id="file-input" type="file" accept=".xlsx,.xls,.csv" multiple aria-label="Choose one or more workfiles" ${bulkImportActive||excelInspectBusy?'disabled':''}></div>${excelRangeView()}${project?'':`<details class="wi-advanced" ${importDefaultType==='Movie'?'open':''}><summary>New project settings</summary><label class="wi-project-type">When a title is not already a saved project <select class="input" id="workfile-default-type" ${bulkImportActive?'disabled':''}>${options(['Series','Movie'],importDefaultType)}</select><small>Existing matched projects keep their saved type. Multi-sheet episode workbooks are treated as a series.</small></label>${bulkMovieDetailsView()}</details>`}<div class="wi-upload-tools"><a class="btn" href="Fixed-Workfile-Template.xlsx" download>${icon('download')}Download workfile template</a><button class="btn" data-action="iprs-import">${icon('upload')}Import IPRS metadata</button></div></div>`;
}
function bulkCompactPreviewView(){
  const items=importQueue.filter(item=>item.queueState==='ready'||item.queueState==='error'||item.queueState==='removed'),shown=items.slice(0,8);
  if(!shown.length)return '';
  const card=item=>`<div class="wi-preview-row"><span class="wi-preview-indicator ${item.queueState}">${item.queueState==='ready'?'✓':item.queueState==='removed'?'−':'!'}</span><div><strong>${esc(item.sheet||item.filename)}</strong><span>${esc(item.projectName||item.workfile?.serialName||item.filename)}${item.workfile?.episodeNumber?' · Episode '+esc(item.workfile.episodeNumber):''}</span>${item.previewTracks?.length?`<small>${esc(item.previewTracks.join(' · '))}${item.cueCount>3?' · +'+(item.cueCount-3)+' more':''}</small>`:''}${item.setupError?`<small class="wi-preview-error">${esc(item.setupError)}</small>`:''}</div><b>${item.queueState==='ready'?item.cueCount+' cues':item.queueState==='removed'?'Remove':'Skip'}</b></div>`;
  return `<div class="wi-compact-preview"><div class="wi-compact-head"><strong>Compact worksheet preview</strong><span>First three cue titles per worksheet · Original files unchanged</span></div>${shown.map(card).join('')}${items.length>shown.length?`<details><summary>Show ${items.length-shown.length} more worksheets</summary>${items.slice(shown.length).map(card).join('')}</details>`:''}</div>`;
}
function bulkImportReviewView(){
  if(!bulkImportPending)return '';
  const total=bulkImportPending.total;
  const googleReview=total.googleSheetId?`<p class="wi-google-refresh-note">This sync will replace ${total.replacedGooglePlays} saved ${total.replacedGooglePlays===1?'play':'plays'} from this sheet with ${total.usages} ${total.usages===1?'play':'plays'} from valid worksheets. Rows removed within synced tabs will be removed from imported cues. Tabs outside a selected range are kept. CMS edits to those linked cue rows will also be replaced.${total.removedTabs?' '+total.removedTabs+' previously linked '+(total.removedTabs===1?'tab is':'tabs are')+' missing and will be removed after confirmation.':''}${total.errors?' Previously imported plays from failed worksheets will be kept.':''}</p>`:'';
  return `<section class="panel wi-import-review ${total.googleSheetId?'wi-google-review':''}" role="status"><div class="panel-head"><div><h2>${total.googleSheetId?'Review Google Sheets sync':'Review before importing'}</h2><p>${total.files} valid ${total.files===1?'worksheet':'worksheets'} contain ${total.cues} ${total.cues===1?'cue':'cues'} from ${total.usages} ${total.usages===1?'play':'plays'}.${total.errors?' '+total.errors+' failed worksheets or files will be skipped.':''}</p></div>${badge('Not saved yet','amber')}</div><div class="wi-auto-metrics"><div><strong>${total.files}</strong><span>Valid worksheets</span></div><div><strong>${total.cues}</strong><span>Combined cues</span></div><div><strong>${total.usages}</strong><span>Original plays</span></div><div><strong>${total.matched}</strong><span>Existing songs matched</span></div><div><strong>${total.newWorks}</strong><span>New songs</span></div><div><strong>${total.errors}</strong><span>Failed items</span></div>${total.googleSheetId?`<div><strong>${total.removedTabs}</strong><span>Removed tabs</span></div>`:''}</div>${bulkCompactPreviewView()}<p class="subtitle">New songs may need rights and identifiers before export.</p>${googleReview}<div class="button-row"><button class="btn primary" data-action="confirm-bulk-import">${icon('check')}${total.googleSheetId?'Confirm sync':'Import valid worksheets'}</button><button class="btn" data-action="cancel-bulk-import">Cancel batch</button></div></section>`;
}
function importFlowSteps(){
  const current=bulkImportSummary?4:bulkImportPending?3:(importSourceMode==='google'?googleSheetSelection:excelSelection.length)?2:1;
  return `<nav class="wi-flow-steps" aria-label="Import progress">${[['Choose source',1],['Select range',2],['Review cues',3],['Done',4]].map(([label,step])=>`<span class="${current===step?'current':current>step?'complete':''}" ${current===step?'aria-current="step"':''}><b>${current>step?'✓':step}</b>${label}</span>`).join('')}</nav>`;
}
function bulkImportView(){
  importSourceMode='excel';
  const summary=bulkImportSummary,project=state.projects.find(item=>item.id===importTargetProjectId);
  const databaseStatus=summary?.syncKind?`<p class="subtitle" role="status">${summary.syncKind==='synced'?'Saved to database.':summary.syncKind==='syncing'?'Saving this workspace to the database…':esc(summary.syncMessage||'Saved on this device. Database sync needs attention.')}</p>`:'';
  const canPrepareCueSheets=summary?.cues>0&&summary.projectIds?.length===1;
  const nextActions=summary?`<div class="button-row">${canPrepareCueSheets?`<button class="btn primary" data-action="prepare-society-cue-sheets">${icon('download')}Prepare IPRS / PRS / ASCAP cue sheets</button>`:''}<button class="btn ${canPrepareCueSheets?'':'primary'}" data-action="view-bulk-cues">${icon('list')}Review cues / Workfile</button><button class="btn" data-action="clear-bulk-summary">Upload another batch</button></div>`:'';
  return heading('Import workfiles','Choose up to 250 worksheets, preview the cues, then confirm the import.')+importFlowSteps()+(bulkImportPending?bulkImportReviewView():'')+`<section class="panel wi-import-source"><div class="panel-head"><div><h2>Import source</h2><p>Upload XLSX, XLS, or CSV workfiles from this computer.</p></div></div>${project?workfileProjectContext(project):''}${workfileSourceChoices(importSourceMode)}<div class="wi-source-content">${importSourceMode==='google'?googleSheetView():excelWorkfileView(project)}</div></section>${summary?`<section class="wi-auto-summary" role="status"><div class="wi-auto-summary-head"><span class="wi-success">${icon('check')}</span><div><span class="eyebrow">${summary.syncKind==='syncing'?'SAVING TO DATABASE':summary.syncKind==='pending'?'SAVED ON THIS DEVICE':summary.googleSheetId?(summary.files||summary.removedTabs?'SYNC COMPLETE':'NOT SYNCED'):summary.files?'BATCH COMPLETE':'NOT IMPORTED'}</span><h2>${summary.cues} cues from ${summary.usages} uses</h2><p>${summary.files} workfile worksheets ${summary.googleSheetId?'synced':'imported'}${summary.removedTabs?' · '+summary.removedTabs+' linked '+(summary.removedTabs===1?'tab':'tabs')+' removed':''}${summary.errors?' · '+summary.errors+' items could not be read':''}. Missing metadata can be filled later.</p>${databaseStatus}</div></div><div class="wi-auto-metrics"><div><strong>${summary.files}</strong><span>${summary.googleSheetId?'Worksheets synced':'Worksheets imported'}</span></div><div><strong>${summary.cues}</strong><span>Cues added</span></div><div><strong>${summary.matched}</strong><span>Database matches</span></div><div><strong>${summary.newWorks}</strong><span>New songs</span></div><div><strong>${summary.duplicates}</strong><span>Duplicates skipped</span></div><div><strong>${summary.warnings}</strong><span>Fill later</span></div></div>${nextActions}</section>`:''}${bulkQueueView()}${simpleWorkfileGuide()}${importHistory()}`;
}
function googleSheetRangeView(){
  if(!googleSheetSelection)return '';
  const selection=googleSheetSelection,count=selection.to-selection.from+1,valid=count>0&&count<=250;
  const choices=bound=>selection.tabs.map(tab=>`<option value="${tab.number}" ${selection[bound]===tab.number?'selected':''}>${esc(tab.name)}</option>`).join('');
  return `<section class="wi-range-card wi-google-range"><span class="wi-kicker">STEP 2 · CHOOSE EPISODES</span><h3>Select the tabs to preview</h3><p>${selection.tabs.length} tabs found in ${esc(selection.projectName)}${selection.sourceBytes?' · '+(selection.sourceBytes/1024/1024).toFixed(2)+' MB source':''}. Choose up to 250 tabs in spreadsheet order.</p><form id="google-sheet-range-form"><div class="form-grid"><label for="google-range-from">From tab<select id="google-range-from" class="input" data-google-range="from" ${googleSheetBusy?'disabled':''}>${choices('from')}</select></label><label for="google-range-to">To tab<select id="google-range-to" class="input" data-google-range="to" ${googleSheetBusy?'disabled':''}>${choices('to')}</select></label></div><p role="status">${valid?count+' tabs selected. Only these tabs will be imported.':'Choose an ordered range of 1 to 250 tabs.'} Previously imported tabs outside this range will be kept.</p><div class="button-row"><button class="btn primary" type="submit" ${!valid||googleSheetBusy?'disabled':''}>${googleSheetBusy?'Preparing preview…':'Preview selected episodes'}</button><button class="btn" type="button" data-action="cancel-google-range" ${googleSheetBusy?'disabled':''}>Cancel selection</button></div></form></section>`;
}
async function loadGoogleSheetTabs(link){
  if(googleSheetBusy||bulkImportActive||bulkImportPending)return toast('Finish the current import or review first.');
  let parsed;try{parsed=window.GoogleSheetSync.parseUrl(link.url);}catch(error){googleSheetError=error.message;renderPage();return;}
  const savedLink=(state.preferences?.googleSheets||[]).find(item=>item.id===parsed.id),projectId=savedLink?.projectId||link.projectId,project=state.projects.find(item=>item.id===projectId);
  if(!project){googleSheetError='Choose a saved project for this Google Sheet.';renderPage();return;}
  if(savedLink?.projectId&&link.projectId&&savedLink.projectId!==link.projectId){googleSheetError='This Google Sheet is already linked to another project. Detach it before linking it elsewhere.';renderPage();return;}
  googleSheetBusy=true;googleSheetError='';googleSheetSelection=null;renderPage();
  try{
    const response=await fetch('/api/google-sheet/tabs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:parsed.url}),cache:'no-store'});
    const result=await response.json();if(!response.ok)throw Error(result?.error?.message||'The tab list could not be loaded.');
    if(workspaceClosed||!state)return;
    if(!Array.isArray(result.tabs)||!result.tabs.length)throw Error('No tabs were found in this spreadsheet.');
    googleSheetSelection={url:parsed.url,projectId,projectName:project.title,tabs:result.tabs,sourceBytes:result.sourceBytes,from:1,to:Math.min(250,result.tabs.length)};
  }catch(error){googleSheetError=error.message||'The tab list could not be loaded.';}
  finally{googleSheetBusy=false;renderPage();}
}
async function importGoogleSheetRange(){
  const selection=googleSheetSelection;if(!selection)return;
  const count=selection.to-selection.from+1;if(count<1||count>250)return toast('Choose an ordered range of 1 to 250 tabs.');
  await syncGoogleSheet({...selection,range:{from:selection.from,to:selection.to,expectedTabs:selection.tabs.slice(selection.from-1,selection.to).map(tab=>tab.name)}});
}
async function syncGoogleSheet(link){
  if(googleSheetBusy||bulkImportActive)return toast('Wait for the current sheet import to finish.');
  if(typeof bulkImportPending!=='undefined'&&bulkImportPending)return toast('Review or cancel the current import first.');
  let parsed;try{parsed=window.GoogleSheetSync.parseUrl(link.url);}catch(error){googleSheetError=error.message;renderPage();return;}
  const savedLink=(state.preferences?.googleSheets||[]).find(item=>item.id===parsed.id),projectId=savedLink?.projectId||link.projectId,linkedProject=projectId?state.projects.find(item=>item.id===projectId):null,projectName=String(linkedProject?.title||link.projectName||savedLink?.projectName||'').trim();if(savedLink?.projectId&&link.projectId&&savedLink.projectId!==link.projectId){googleSheetError='This Google Sheet is already linked to another project. Detach it before linking it elsewhere.';renderPage();return;}if(projectId&&!linkedProject||!projectName){googleSheetError='Choose a saved project for this Google Sheet.';renderPage();return;}
  googleSheetError='';googleSheetBusy=true;renderPage();
  try{
    const response=await fetch('/api/google-sheet/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:parsed.url,...(link.range?{range:link.range}:{})}),cache:'no-store'});
    if(!response.ok){const problem=await response.json().catch(()=>null);throw Error(problem?.error?.message||'The Google Sheet could not be fetched. Check its sharing setting and try again.');}
    const bytes=await response.arrayBuffer(),displayName=projectName.replace(/[<>:"/\\|?*\x00-\x1f]/g,' ').replace(/\s+/g,' ').trim().slice(0,100)||'Google Sheet',file={name:`${displayName} - Google Sheet.xlsx`,size:bytes.byteLength,lastModified:Date.now(),type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',arrayBuffer:async()=>bytes};
    googleSheetBusy=false;googleSheetSelection=null;await bulkReadFiles([file],{selectedGoogleRange:!!link.range,googleTabOffset:link.range?link.range.from-1:0,googleSheetId:parsed.id,googleSheetUrl:parsed.url,projectName,projectId:linkedProject?.id||projectId,originalProjectName:savedLink?.originalProjectName||link.originalProjectName||savedLink?.projectName||projectName,tabBaselines:savedLink?.tabBaselines||link.tabBaselines||[]});
  }catch(error){googleSheetBusy=false;googleSheetError=error.message||'The Google Sheet could not be synced.';renderPage();toast(googleSheetError);}
}
async function bulkReadFiles(fileList,sourceOptions={}){
  if(workspaceClosed||!state)return;
  if(typeof googleSheetBusy!=='undefined'&&googleSheetBusy&&!sourceOptions.googleSheetId)return toast('Wait for the Google Sheet to finish loading.');
  const importStillCurrent=()=>!workspaceClosed&&!!state;
  if(bulkImportActive)return toast('The current batch is still importing.');const files=[...fileList];if(!files.length)return;
  if(typeof bulkImportPending!=='undefined'&&bulkImportPending)return toast('Review or cancel the current import first.');
  if(files.length>250)return toast('Choose up to 250 workfiles per batch. You selected '+files.length+'; no files were processed.');
  const selectedFiles=sourceOptions.excelSelection;
  if(selectedFiles){
    const valid=Array.isArray(selectedFiles)&&selectedFiles.length===files.length&&selectedFiles.every(item=>Array.isArray(item.sheetNames)&&item.sheetNames.length>=1&&item.sheetNames.length<=250&&item.sheetNames.every(name=>typeof name==='string')&&new Set(item.sheetNames).size===item.sheetNames.length&&Number.isSafeInteger(item.sheetOffset)&&item.sheetOffset>=0);
    if(!valid||selectedFiles.reduce((sum,item)=>sum+item.sheetNames.length,0)>250)return toast('Choose 1 to 250 worksheets across the selected files before preview.');
  }
  const targetProject=sourceOptions.projectId?state.projects.find(item=>item.id===sourceOptions.projectId):null;if(sourceOptions.projectId&&!targetProject)return toast('The selected project no longer exists. Choose it again.');
  const defaultProjectType=targetProject?.type||importDefaultType,movieDetails=!targetProject&&defaultProjectType==='Movie'?Object.fromEntries(importMovieFields.map(([,key])=>[key,String(importMovieDetails[key]||'').trim()])):{},detailsError=bulkMovieDetailsError(movieDetails);if(detailsError){const fileInput=document.getElementById('file-input');if(fileInput)fileInput.value='';return toast(detailsError);}
  const priorBaselines=new Map((Array.isArray(sourceOptions.tabBaselines)?sourceOptions.tabBaselines:[]).filter(item=>item&&typeof item.tab==='string').map(item=>[item.tab,item]));
  const incoming=files,before=state,baseRevision=dataRevision,candidate=structuredClone(state),seenFiles=new Set(),sessions=[],previousGoogleTabs=new Set(sourceOptions.googleSheetId?[...state.cues.flatMap(cue=>cue.occurrences||[]).filter(use=>use.googleSheetId===sourceOptions.googleSheetId).map(use=>use.googleSheetTab),...priorBaselines.keys()]:[]);let parsedGoogleWorkbook=false;bulkImportActive=true;bulkImportSummary=null;bulkImportPending=null;importQueue=[];importReadProgress={phase:'Reading workfiles',done:0,total:incoming.length};renderPage();
  for(const [fileIndex,file] of incoming.entries()){
    if(!importStillCurrent())return;
    const fileKey=[file.name,file.size,file.lastModified].join(':'),errorSession={filename:file.name,size:file.size,lastModified:file.lastModified,fileKey,sheet:'',queueState:'error'};
    if(seenFiles.has(fileKey)){errorSession.setupError='Duplicate file in this batch';importQueue.push(errorSession);}
    else if(!/\.(xlsx|xls|csv)$/i.test(file.name)){errorSession.setupError='Use an XLSX, XLS, or CSV file';importQueue.push(errorSession);}
    else if(file.size>10*1024*1024){errorSession.setupError='File is larger than 10 MB';importQueue.push(errorSession);}
    else try{
      seenFiles.add(fileKey);const selected=selectedFiles?.[fileIndex],workbook=await CueFileSafety.read(file,{cellDates:false,...(selected?{sheetNames:selected.sheetNames}:{})}),found=[],detectedTitles=[];if(!importStillCurrent())return;
      for(let sheetIndex=0;sheetIndex<workbook.SheetNames.length;sheetIndex++){
        const sheetName=workbook.SheetNames[sheetIndex],sheet=workbook.Sheets[sheetName],raw=XLSX.utils.sheet_to_json(sheet,{header:1,defval:'',raw:true,blankrows:true}),workfile=D.fixedWorkfile(raw);if(!workfile){if(sourceOptions.googleSheetId&&previousGoogleTabs.has(sheetName))importQueue.push({...errorSession,fileKey:fileKey+':'+sheetName,sheet:sheetName,setupError:'This linked tab no longer has the fixed Workfile cells. Its previously imported cues were kept.'});continue;}
        const session={filename:file.name,size:file.size,lastModified:file.lastModified,fileKey:fileKey+':'+sheetName,sheet:sheetName,raw,workfile,queueState:'reading',inferenceWarnings:[],defaultProjectType,movieDetails:{...movieDetails}},shown=(address,fallback)=>String(sheet[address]?.w??fallback??'');
        session.workfile.totalDurationDisplay=shown('A1',session.workfile.totalDuration);session.workfile.dateDisplay=shown('B1',session.workfile.date);session.workfile.serialName=shown('C1',session.workfile.serialName).trim();detectedTitles.push(D.normalize(session.workfile.serialName));
        if(targetProject){session.projectName=targetProject.title;session.linkedProjectId=targetProject.id;}
        if(sourceOptions.googleSheetId){session.googleSheetId=sourceOptions.googleSheetId;session.sourceKeyPrefix='google:'+sourceOptions.googleSheetId;session.previousEpisodeBaseline=priorBaselines.get(sheetName)||null;}
        if(!session.workfile.episodeNumber){const offset=selected?.sheetOffset??sourceOptions.googleTabOffset??0,inferred=bulkEpisodeFromSheet(sheetName,sheetIndex+offset,workbook.SheetNames.length+offset);if(inferred){session.workfile.episodeNumber=inferred;session.episodeInferred=true;session.forceSeries=/\b(?:episode|ep)\b/i.test(sheetName)||workbook.SheetNames.length>1;session.inferenceWarnings.push('E1 was blank; episode '+inferred+' was inferred from worksheet '+sheetName);}}
        const previewRows=bulkImportRows(session);session.cueCount=previewRows.length;session.previewTracks=previewRows.slice(0,3).map(item=>String(item.raw.title||'Untitled cue').trim());
        const validationErrors=session.cueCount>5000?['More than 5,000 cue rows in this worksheet']:bulkValidateSession(session);
        if(validationErrors.length){session.validationErrors=validationErrors;session.setupError=validationErrors.slice(0,3).join('; ')+(validationErrors.length>3?'; +'+(validationErrors.length-3)+' more errors':'');session.queueState='error';importQueue.push(session);}else found.push(session);
      }
      if(sourceOptions.googleSheetId){
        const names=new Set(detectedTitles.filter(Boolean)),sharedName=detectedTitles.length>1&&names.size===1,projectNames=new Set([sourceOptions.projectName,sourceOptions.originalProjectName].map(D.normalize).filter(Boolean));
        found.forEach(session=>{session.episodeTitle=bulkGoogleEpisodeTitle(session,sharedName,projectNames);});
        for(const tab of previousGoogleTabs)if(!sourceOptions.selectedGoogleRange&&!workbook.SheetNames.includes(tab))importQueue.push({...errorSession,fileKey:fileKey+':'+tab,sheet:tab,queueState:'removed',setupError:'This linked tab was removed. Its previously imported cues will be removed after you confirm the sync.'});
      }
      if(!found.length&&!importQueue.some(item=>item.fileKey?.startsWith(fileKey+':')))throw Error('No worksheet contains the fixed Workfile cells and cue rows');
      if(found.length>1&&targetProject?.type==='Movie'){found.forEach(item=>{item.queueState='error';item.setupError=`${targetProject.title} is a Movie project. Use Import on a Series project, or open Import workfiles from the sidebar to create one.`;importQueue.push(item);});found.length=0;}
      if(found.length>1){const titles=new Set(found.map(item=>D.normalize(item.workfile.serialName)).filter(Boolean)),projectName=targetProject?.title||(sourceOptions.googleSheetId?sourceOptions.projectName:titles.size===1?found[0].workfile.serialName:bulkWorkbookTitle(file.name));found.forEach(item=>{item.forceSeries=true;item.projectName=projectName;if(titles.size>1&&!sourceOptions.googleSheetId){item.episodeTitle=item.workfile.serialName||'Episode '+item.workfile.episodeNumber;if(!targetProject)item.inferenceWarnings.push('C1 differs between worksheets; the workbook name was used as the series title');}});}
      found.forEach(session=>{importQueue.push(session);sessions.push(session);});
      if(sourceOptions.googleSheetId)parsedGoogleWorkbook=true;
    }catch(error){if(!importStillCurrent())return;errorSession.setupError=error.message||'The workbook is unreadable or encrypted';importQueue.push(errorSession);}
    importReadProgress.done++;if(importReadProgress.done%4===0||importReadProgress.done===importReadProgress.total){renderPage();await new Promise(resolve=>setTimeout(resolve,0));}
  }
  if(!importStillCurrent())return;
  if(importQueue.filter(item=>item.sheet&&item.queueState!=='removed').length>250){bulkImportActive=false;importReadProgress=null;importQueue=[];renderPage();return toast('This batch contains more than 250 worksheets. Select a smaller range and try again.');}
  const removedTabs=sourceOptions.googleSheetId?importQueue.filter(item=>item.queueState==='removed').length:0;
  const allGoogleTabs=new Set([...previousGoogleTabs,...sessions.map(session=>session.sheet)]);
  let replacedGooglePlays=0;
  if(sourceOptions.googleSheetId&&parsedGoogleWorkbook&&removedTabs){
    const removedNames=new Set(importQueue.filter(item=>item.queueState==='removed').map(item=>item.sheet));
    const preserveTabs=new Set([...allGoogleTabs].filter(tab=>!removedNames.has(tab)));
    replacedGooglePlays+=window.GoogleSheetSync.replaceManagedOccurrences(candidate,sourceOptions.googleSheetId,{preserveTabs});
  }
  const cueBuckets=sourceOptions.googleSheetId?null:new Map();
  if(cueBuckets)for(const cue of candidate.cues){const key=cue.projectId+'\0'+(cue.episode==null?'movie':cue.episode);if(!cueBuckets.has(key))cueBuckets.set(key,[]);cueBuckets.get(key).push(cue);}
  const titleCounts=new Map();sessions.forEach(session=>{const key=D.normalize(session.projectName||session.workfile.serialName||session.filename.replace(/\.[^.]+$/,''));titleCounts.set(key,(titleCounts.get(key)||0)+1);});
  importReadProgress={phase:'Preparing review',done:0,total:sessions.length};renderPage();const createdWorkIds=new Set(),total={files:0,cues:0,usages:0,matched:0,newWorks:0,duplicates:0,warnings:0,errors:importQueue.filter(item=>item.queueState==='error').length,removedTabs,projectIds:[]};
  for(const session of sessions){if(!importStillCurrent())return;const onValidated=sourceOptions.googleSheetId?()=>{const preserveTabs=new Set([...allGoogleTabs].filter(tab=>tab!==session.sheet));replacedGooglePlays+=window.GoogleSheetSync.replaceManagedOccurrences(candidate,sourceOptions.googleSheetId,{preserveTabs});}:null;const result=bulkApplySession(session,candidate,titleCounts,createdWorkIds,onValidated,cueBuckets);if(session.queueState==='complete'){total.files++;for(const key of ['cues','usages','matched','newWorks','duplicates','warnings'])total[key]+=result[key];if(result.projectId&&!total.projectIds.includes(result.projectId))total.projectIds.push(result.projectId);}else total.errors++;importReadProgress.done++;if(importReadProgress.done%4===0||importReadProgress.done===importReadProgress.total){renderPage();await new Promise(resolve=>setTimeout(resolve,0));}}
  const nextBaselines=new Map(priorBaselines);for(const item of importQueue)if(item.queueState==='removed')nextBaselines.delete(item.sheet);
  for(const session of sessions)if(session.queueState==='complete')nextBaselines.set(session.sheet,{tab:session.sheet,episodeNumber:session.workfile.episodeNumber,title:session.episodeTitle,duration:D.time(session.workfile.totalDurationSeconds),airdate:String(session.workfile.dateDisplay||session.workfile.date||'')});
  if(!importStillCurrent())return;
  bulkImportActive=false;importReadProgress=null;
  if(dataRevision!==baseRevision){importQueue.forEach(item=>{if(item.queueState==='complete'){item.queueState='error';item.setupError='The workspace changed while this batch was being read. Choose the files again.';}});bulkImportSummary={...total,files:0,cues:0,usages:0,errors:total.errors+total.files};renderPage();toast('The workspace changed while the batch was being read. Choose the files again.');return;}
  if(total.files||sourceOptions.googleSheetId&&removedTabs){if(sourceOptions.googleSheetId){candidate.preferences??={};const links=Array.isArray(candidate.preferences.googleSheets)?candidate.preferences.googleSheets:[],projectId=total.projectIds[0]||sourceOptions.projectId,projectName=candidate.projects.find(item=>item.id===projectId)?.title||sourceOptions.projectName;if(projectId&&!total.projectIds.includes(projectId))total.projectIds.push(projectId);candidate.preferences.googleSheets=[...links.filter(item=>item.id!==sourceOptions.googleSheetId),{id:sourceOptions.googleSheetId,url:sourceOptions.googleSheetUrl,projectId,projectName,originalProjectName:sourceOptions.originalProjectName||sourceOptions.projectName,tabBaselines:[...nextBaselines.values()],lastSyncedAt:new Date().toISOString()}];total.googleSheetId=sourceOptions.googleSheetId;total.replacedGooglePlays=replacedGooglePlays;}importQueue.forEach(item=>{if(item.queueState==='complete')item.queueState='ready';});bulkImportPending={candidate,before,baseRevision,total};renderPage();toast(sourceOptions.googleSheetId?'Review the Google Sheet changes, then choose Confirm sync.':'Review '+total.cues+' cues from '+total.usages+' plays, then choose Import valid worksheets.');return;}
  bulkImportSummary=total;renderPage();toast('No workfiles were imported. Check the file messages below.');
}
function confirmBulkImport(){
  const pending=bulkImportPending;if(!pending)return;
  if(dataRevision!==pending.baseRevision){bulkImportPending=null;importQueue.forEach(item=>{if(item.queueState==='ready'){item.queueState='error';item.setupError='The workspace changed after review. Choose the files again.';}});renderPage();toast('The workspace changed after review. Choose the files again.');return;}
  const {candidate,before,total}=pending;candidate.activity.unshift({text:(total.googleSheetId?'Synced Google Sheet · ':'Imported ')+total.files+' workfile worksheets · '+total.cues+' cues from '+total.usages+' plays'+(total.removedTabs?' · '+total.removedTabs+' tabs removed':''),date:new Date().toISOString()});state=candidate;
  if(!save()){const reason=persistence.getStatus().message||'Workspace storage failed.';state=before;importQueue.forEach(item=>{if(item.queueState==='ready'||item.queueState==='removed'){item.queueState='error';item.setupError='Nothing was saved. '+reason;}});total.errors+=total.files;total.files=total.cues=total.usages=total.matched=total.newWorks=total.duplicates=total.warnings=total.removedTabs=0;total.projectIds=[];}
  else {total.syncKind='syncing';importQueue.forEach(item=>{if(item.queueState==='ready')item.queueState='complete';else if(item.queueState==='removed'){item.queueState='removed-complete';item.setupError='This linked tab was removed. Its previously imported cues were removed.';}});}
  bulkImportPending=null;bulkImportSummary=total;renderPage();toast(total.googleSheetId?(total.files||total.removedTabs?'Google Sheet synced.':'Google Sheet was not synced.'):total.files?total.cues+' cues from '+total.usages+' plays imported.':'No workfiles were imported. Check the file messages below.');
  if(total.syncKind)return syncBulkImport(total);
}
function updateBulkImportSyncStatus(status){
  const summary=bulkImportSummary;if(!summary?.syncKind||workspaceClosed)return;
  const kind=status.kind==='synced'&&!status.pending?'synced':['offline','error','local-error','conflict','update-available'].includes(status.kind)?'pending':'syncing';
  if(summary.syncKind===kind&&summary.syncMessage===status.message)return;
  summary.syncKind=kind;summary.syncMessage=status.message;
  if(page==='import')renderPage();
}
async function syncBulkImport(summary){
  try{await persistence.sync();if(bulkImportSummary===summary)updateBulkImportSyncStatus(persistence.getStatus());}
  catch(error){if(bulkImportSummary!==summary||workspaceClosed)return;summary.syncKind='pending';summary.syncMessage='Saved on this device. '+(error.message||'Database sync needs attention.');if(page==='import')renderPage();}
}
const importView=bulkImportView,readFiles=bulkReadFiles;
if(catalogMigrated||usageMigrated||cumulativeMigrated||historyMigrated)save();
historyRetentionTimer=setInterval(cleanupExpiredHistory,60*1000);
history.replaceState({page},'',`#${page}`);
window.addEventListener('popstate',()=>{const requested=decodeRoute(location.hash),target=requested==='research'?'works':routePages.has(requested)?requested:'dashboard';if(!closeModal()){history.pushState({page},'',`#${page}`);return;}if(requested!==target)history.replaceState({page:target},'',`#${target}`);go(target,{historyMode:'none'});});
shell();
})().catch(error=>{console.error('Workspace startup failed',error);document.getElementById('app').textContent='The workspace could not open. Refresh to retry. Your saved data has not been removed.';});
