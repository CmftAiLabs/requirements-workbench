import type {Bootstrap} from './types';

export type StatePatch = {op:'set'|'remove'|'append';path:string[];value?:unknown};
export type WorkspaceSync =
 | {kind:'snapshot';cursor:string;value:Bootstrap}
 | {kind:'delta';cursor:string;base:string;patches:StatePatch[]}
 | {kind:'unchanged';cursor:string};
const unsafe = new Set(['__proto__','prototype','constructor']);
const object = (value:unknown):value is Record<string,unknown> => !!value && typeof value==='object' && !Array.isArray(value);

export function stateDiff(before:unknown,after:unknown,path:string[]=[]):StatePatch[]{
 if(Object.is(before,after))return [];
 if(Array.isArray(before)&&Array.isArray(after)){
  if(before.length<=after.length&&before.every((v,i)=>JSON.stringify(v)===JSON.stringify(after[i])))return after.length===before.length?[]:[{op:'append',path,value:after.slice(before.length)}];
  if(before.length===after.length&&before.every((v,i)=>object(v)&&object(after[i])&&typeof v.id==='string'&&v.id===after[i].id))return before.flatMap((v,i)=>stateDiff(v,after[i],[...path,String(i)]));
 }else if(object(before)&&object(after)){
  return [...new Set([...Object.keys(before),...Object.keys(after)])].flatMap(key=>{
   if(unsafe.has(key))throw new Error('非法增量字段');
   if(!(key in after))return [{op:'remove' as const,path:[...path,key]}];
   return stateDiff(before[key],after[key],[...path,key]);
  });
 }
 return JSON.stringify(before)===JSON.stringify(after)?[]:[{op:'set',path,value:after}];
}

/** Clone only changed branches; unchanged cards retain their React identities. */
export function applyStatePatches<T>(value:T,patches:StatePatch[]):T{
 let result:unknown=value;
 for(const patch of patches){
  if(patch.path.some(key=>unsafe.has(key))||patch.path.length>32)throw new Error('非法增量路径');
  const update=(node:unknown,depth:number):unknown=>{
   if(depth===patch.path.length){
    if(patch.op==='append'){if(!Array.isArray(node)||!Array.isArray(patch.value))throw new Error('增量数组不匹配');return [...node,...patch.value];}
    return patch.value;
   }
   if(!Array.isArray(node)&&!object(node))throw new Error('增量路径不匹配');
   const key=patch.path[depth],copy:Record<string,unknown>|unknown[]=Array.isArray(node)?[...node]:{...node};
   if(Array.isArray(node)&&(!/^(0|[1-9]\d*)$/.test(key)||Number(key)>=node.length))throw new Error('增量索引越界');
   if(depth===patch.path.length-1&&patch.op==='remove'){if(Array.isArray(copy))throw new Error('不允许删除数组索引');delete copy[key];}
   else (copy as Record<string,unknown>)[key]=update((node as Record<string,unknown>)[key],depth+1);
   return copy;
  };
  result=update(result,0);
 }
 return result as T;
}
