import {currentModel} from './model-settings';
import 'dotenv/config';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import {normalizePublicOrigin} from './request-policy';
export const config = {
 port:Number(process.env.PORT||4318),host:process.env.HOST||'127.0.0.1',
 publicOrigin:normalizePublicOrigin(process.env.PUBLIC_ORIGIN),
 proxyAccessToken:process.env.PROXY_ACCESS_TOKEN||'',
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
 if(config.publicOrigin&&config.proxyAccessToken.length<32)throw new Error('公网部署请配置至少32字符的 PROXY_ACCESS_TOKEN，并由认证入口覆盖同名请求头。');
}
