 function iprsMovieTemplate(xml){
  // The movie reference has seven production rows, followed by its work table.
  // Reuse the supplied workbook's fonts, borders and contributor rows.
  const bottomStyles=rowBlueprint(xml,12,11).styles,lastMetadata=rowXml(xml,9);
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
  const widths=[43,13.5,13.5,18,15.5,8.5,42,30.5,14,17.5,18,26,24.5];
  xml=xml.replace(/<cols>[\s\S]*?<\/cols>/,`<cols>${widths.map((width,index)=>`<col min="${index+1}" max="${index+1}" width="${width}" style="1" customWidth="1"/>`).join('')}</cols>`);
  const heading='<r><rPr><b/><sz val="36"/><rFont val="Arial Narrow"/></rPr><t>The Indian Performing Right Society Limited</t></r>'+
   '<r><rPr><b/><sz val="11"/><rFont val="Arial Narrow"/></rPr><t xml:space="preserve">\nRegd. Office : 208, Golden Chambers, 2nd Floor, New Andheri Link Road, Andheri (W), Mumbai - 400 053.\nTel: IPRS Call Center Number: 8097539960 &amp; Office No. (091 22) 2673 3748 / 49 / 50 / 6616. Email : documentation@iprs.org, support.documentation@iprs.org. Visit us at : www.iprs.org\nCIN : U92140MH1969GAP014359</t></r>';
  xml=xml.replace(/<c\b[^>]*\br="A1"[^>]*>[\s\S]*?<\/c>/,`<c r="A1" s="52" t="inlineStr"><is>${heading}</is></c>`);
  const edits=new Map([['A2','MOVIE CUE SHEET'],['B12','Code'],['F11','COMPOSER / AUTHOR / PUBLISHER / SINGER DETAILS'],['G11',''],['A33','']]);
  xml=xml.replace(/<c\b([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g,(whole,attributes)=>{const address=attributes.match(/\br="([A-Z]+\d+)"/)?.[1];if(address==='E11'||address==='K11')return cellMarkup(address,null,'s="47"');if(address==='L11'||address==='M11')return cellMarkup(address,null,'s="40"');if(!edits.has(address))return whole;return cellMarkup(address,{value:edits.get(address),type:'string'},address==='F11'?'s="48"':address==='G11'?'s="46"':attributes);});
  // Keep the long censor-certificate label and the narrower duration column legible.
  for(const [row,height] of [[1,96],[2,30],[6,30],[11,22],[12,96]])xml=xml.replace(new RegExp(`<row\\b(?=[^>]*\\br="${row}")([^>]*)>`),(whole,attributes)=>`<row${attributes.replace(/\s+(?:ht|customHeight)="[^"]*"/g,'')} ht="${height}" customHeight="1">`);
  return xml;
 }
