import {EventEmitter} from 'node:events';
const events=new EventEmitter();events.setMaxListeners(128);
export function notifyProject(id:string){events.emit(id);}
export function watchProject(id:string,callback:()=>void){events.on(id,callback);return()=>{events.off(id,callback);};}
