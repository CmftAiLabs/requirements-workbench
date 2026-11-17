import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import {config} from './config.js';
import type {Material} from '../shared/types.js';
import {IMAGE_EXTENSIONS} from './image-materials.js';
import {MAX_ARCHIVE_BYTES} from './archive-materials.js';
export const MAX_TEXT=160000;
export const MAX_FILE_BYTES=10*1024*1024;
export const DOCUMENT_EXTENSIONS=['.txt','.md','.csv','.pdf','.docx','.xlsx'];
export const isImageFile=(filename:string)=>IMAGE_EXTENSIONS.includes(path.extname(filename).toLowerCase());
export const isArchiveFile=(filename:string)=>path.extname(filename).toLowerCase()==='.zip';
const uploadName=(filename:string)=>{const base=path.basename(filename.replace(/\\/g,'/')),ext=path.extname(base);return (ext?base.slice(0,-ext.length):base).slice(0,Math.max(0,180-ext.length))+ext;};
/** Image OCR and ZIP expansion run in persisted jobs; upload returns promptly. */
export async function prepareUpload(filename:string,buffer:Buffer):Promise<Material>{
 const name=uploadName(filename),ext=path.extname(name).toLowerCase();
 if(!isImageFile(name)&&!isArchiveFile(name))return parseFile(name,buffer);
 const archive=isArchiveFile(name),limit=archive?MAX_ARCHIVE_BYTES:MAX_FILE_BYTES;
 if(buffer.length>limit)throw new Error(archive?'单个 ZIP 压缩包最多 30 MB，请拆分上传。':'单个文件最多 10 MB，请拆分上传。');
 const id=randomUUID(),filePath=`materials/${id}${ext}`;
 await writeFile(path.join(config.dataDir,filePath),buffer,{mode:0o600});
 return {id,name,kind:archive?'ZIP 压缩包':ext.slice(1).toUpperCase()+' 图片',location:'上传文件'+(archive?'':' · 图片识别'),text:'',status:'处理中',cardIds:[],createdAt:new Date().toISOString(),filePath,
  ...(!archive?{mimeType:ext==='.jpg'||ext==='.jpeg'?'image/jpeg':ext==='.tif'||ext==='.tiff'?'image/tiff':`image/${ext.slice(1)}`}:{})};
}
export function textMaterial(name:string,text:string,kind='文字材料',location='本地录入'):Material{
 if(!text.trim())throw new Error('材料正文不能为空');
 if(text.length>MAX_TEXT)throw new Error('单份材料正文最多16万字符，请拆分上传。');
 return {id:randomUUID(),name,kind,location,text,status:'待整理',cardIds:[],createdAt:new Date().toISOString()};
}
export async function parseFile(filename:string,buffer:Buffer):Promise<Material>{
 const name=uploadName(filename),ext=path.extname(name).toLowerCase();
 if(!DOCUMENT_EXTENSIONS.includes(ext))throw new Error('支持 TXT、MD、CSV、PDF、DOCX、XLSX、PNG、JPG、WebP、GIF、TIFF 和 ZIP。RAR、7Z 请先解压或转为 ZIP；音视频请先转写文字。');
 if(buffer.length>MAX_FILE_BYTES)throw new Error('单个文件最多 10 MB，请拆分上传。');
 const id=randomUUID(),filePath=`materials/${id}${ext}`;
 await writeFile(path.join(config.dataDir,filePath),buffer,{mode:0o600});
 let text='';let error='';
 try{
  if(['.txt','.md','.csv'].includes(ext))text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);
  else if(ext==='.docx')text=(await mammoth.extractRawText({buffer})).value;
  else if(ext==='.pdf'){
   const {PDFParse}=await import('pdf-parse');const parser=new PDFParse({data:buffer});
   try{
    const result=await parser.getText();
    if(!result.pages.some(page=>page.text.trim()))throw new Error('未读到可用文字；扫描件请先做文字识别，再上传。');
    text=result.pages.filter(page=>page.text.trim()).map(page=>`[第 ${page.num} 页]\n${page.text}`).join('\n\n');
   }finally{await parser.destroy()}
  }else{
   const book=new ExcelJS.Workbook();await book.xlsx.load(buffer as never);
   const parts:string[]=[];let total=0;
   book.eachSheet(sheet=>{
    const rows:string[]=[];
    sheet.eachRow((row,n)=>{
     if(++total>10000)throw new Error('表格超过1万行，请拆分材料');
     const cells:string[]=[];
     row.eachCell(cell=>{
      const value=cell.value;
      const visible=value instanceof Date?value.toISOString():cell.text;
      const fallback=value&&typeof value==='object'&&'formula' in value?`=${value.formula}（未含计算结果）`:'';
      const content=visible.trim()||fallback;
      if(content)cells.push(`[列 ${cell.address.replace(/\d+$/,'')}] ${content}`);
     });
     if(cells.length)rows.push(`[行 ${n}] ${cells.join(' | ')}`);
    });
    if(rows.length)parts.push(`[工作表：${sheet.name}]`,...rows);
   });
   text=parts.join('\n');
  }
  if(!text.trim())throw new Error('未读到可用文字；扫描件请先做文字识别，再上传。');
  if(text.length>MAX_TEXT)throw new Error('正文超过16万字符，请拆分材料后重传，系统没有截断原文。');
 }catch(e){error=e instanceof Error&&/请|扫描件|表格超过|正文超过/.test(e.message)?e.message:'正文解析失败，请检查文件是否损坏、加密或采用非 UTF-8 编码。';text=''}
 return {id,name,kind:ext.slice(1).toUpperCase()+' 文件',location:'上传文件'+(ext==='.pdf'?' · 按页引用':''),text,status:text?'待整理':'待解析',cardIds:[],createdAt:new Date().toISOString(),filePath,error:error||undefined};
}
