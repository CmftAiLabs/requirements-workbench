import {useSyncExternalStore} from 'react';

export type ConversationDraft={text:string;replyTo:string;files:File[]};
const empty:ConversationDraft={text:'',replyTo:'',files:[]};
const drafts=new Map<string,ConversationDraft>(),listeners=new Set<()=>void>();
export const readConversationDraft=(key:string)=>drafts.get(key)||empty;
export function updateConversationDraft(key:string,patch:Partial<ConversationDraft>){
 const next={...readConversationDraft(key),...patch};
 if(next.text||next.replyTo||next.files.length)drafts.set(key,next);else drafts.delete(key);
 listeners.forEach(fn=>fn());
}
export function clearSentDraft(key:string,sent:ConversationDraft){
 // A late response from another conversation must not clear newer typing/files.
 if(readConversationDraft(key)===sent)updateConversationDraft(key,empty);
}
const subscribe=(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};};
export function useConversationDraft(key:string){
 const value=useSyncExternalStore(subscribe,()=>readConversationDraft(key),()=>empty);
 return {value,setText:(text:string)=>updateConversationDraft(key,{text}),setReplyTo:(replyTo:string)=>updateConversationDraft(key,{replyTo}),setFiles:(files:File[])=>updateConversationDraft(key,{files}),clear:()=>clearSentDraft(key,value)};
}
