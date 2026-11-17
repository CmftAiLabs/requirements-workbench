import {currentModel} from './model-settings';
import 'dotenv/config';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
export const config = {
 port:Number(process.env.PORT||4318),host:'127.0.0.1',
 databaseUrl:process.env.DATABASE_URL||'',sessionSecret:process.env.SESSION_SECRET||'',
 get model(){return currentModel()},modelConfigured:!!process.env.MODEL_API_KEY,
 dataDir:path.resolve('data'),
 targets:{
  knowledge:{url:process.env.KNOWLEDGE_DELIVERY_URL||'',token:process.env.KNOWLEDGE_DELIVERY_TOKEN||''},
  teammate:{url:process.env.TEAMMATE_DELIVERY_URL||'',token:process.env.TEAMMATE_DELIVERY_TOKEN||''},
 },
};
for(const dir of ['materials','receipts/knowledge','receipts/teammate']) mkdirSync(path.join(config.dataDir,dir),{recursive:true,mode:0o700});
export function validateConfig(){
 if(!config.databaseUrl)throw new Error('请配置 DATABASE_URL');
 if(config.sessionSecret.length<32)throw new Error('请配置至少32字符的 SESSION_SECRET');
}
