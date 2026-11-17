import {config,validateConfig} from './config.js';
import {initStore,pool} from './store.js';
import {buildApp} from './app.js';
validateConfig();
await initStore();
const app=await buildApp();
await app.listen({host:config.host,port:config.port});
console.log(`需求协作工作台已启动：http://${config.host}:${config.port} · 模型 ${config.model}`);
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void(async()=>{await app.close();await pool.end();process.exit(0)})()});
