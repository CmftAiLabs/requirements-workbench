import type {PoolClient} from 'pg';
import type {Project,Message,AuditEvent} from '../shared/types';
import {compactProject,messageChangeKey} from './workspace-sync';
import {digest} from './demo-schema';

export interface DiscussionAppend {cardId:string;message:Message;event:AuditEvent}
export function hydrateProject(body:Project,stamp:number,appends:DiscussionAppend[]):Project{
 const p=body;p.stamp=stamp;
 for(const {cardId,message,event} of appends){const c=p.cards.find(c=>c.id===cardId);if(c){c.messages.push(message);if(c.suggestion?.status==='待决定')c.suggestion.status='已失效';}p.events.push(event);}
 return p;
}
/** Updated atomically with cold domain writes. Message appends update just one card row. */
export async function writeReadModel(client:PoolClient,p:Project){
 const old=new Map((await client.query('SELECT card_id,message_fingerprint FROM workspace_cards WHERE project_id=$1',[p.id])).rows.map(r=>[r.card_id,r.message_fingerprint]));
 const view=compactProject(p),rows=view.cards.map((body,i)=>({id:body.id,position:i,body,history:p.cards[i].history,change_key:messageChangeKey(p.cards[i])}));
 await client.query(`INSERT INTO workspace_heads(project_id,body,base_stamp,demo) VALUES($1,$2,$3,$4) ON CONFLICT(project_id) DO UPDATE SET body=EXCLUDED.body,base_stamp=EXCLUDED.base_stamp,demo=EXCLUDED.demo`,[p.id,{...view,cards:[]},p.stamp,p.generatedDemo||null]);
 await client.query('DELETE FROM workspace_cards WHERE project_id=$1 AND NOT(card_id=ANY($2::text[]))',[p.id,p.cards.map(c=>c.id)]);
 await client.query(`INSERT INTO workspace_cards(project_id,card_id,position,body,history,change_key,changed_stamp) SELECT $1,x->>'id',(x->>'position')::int,x->'body',x->'history',x->>'change_key',$3 FROM jsonb_array_elements($2::jsonb) AS x ON CONFLICT(project_id,card_id) DO UPDATE SET position=EXCLUDED.position,body=EXCLUDED.body,history=EXCLUDED.history,change_key=EXCLUDED.change_key,changed_stamp=EXCLUDED.changed_stamp`,[p.id,JSON.stringify(rows),p.stamp]);
 for(const card of p.cards){
  const fingerprint=digest(card.messages);if(old.get(card.id)===fingerprint)continue;
  await client.query('DELETE FROM workspace_messages WHERE project_id=$1 AND card_id=$2',[p.id,card.id]);
  if(card.messages.length)await client.query(`INSERT INTO workspace_messages(project_id,card_id,ordinal,message_id,body,client_key) SELECT $1,$2,ordinality-1,x->>'id',x,CASE WHEN x ? 'clientMessageId' THEN COALESCE(x->>'participantId',x->>'role')||':'||(x->>'clientMessageId') ELSE NULL END FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS t(x,ordinality)`,[p.id,card.id,JSON.stringify(card.messages)]);
  await client.query('UPDATE workspace_cards SET message_fingerprint=$3 WHERE project_id=$1 AND card_id=$2',[p.id,card.id,fingerprint]);
 }
 await client.query('DELETE FROM workspace_materials WHERE project_id=$1 AND NOT(material_id=ANY($2::text[]))',[p.id,p.materials.map(m=>m.id)]);
 if(p.materials.length)await client.query(`INSERT INTO workspace_materials(project_id,material_id,body) SELECT $1,x->>'id',x FROM jsonb_array_elements($2::jsonb) AS x ON CONFLICT(project_id,material_id) DO UPDATE SET body=EXCLUDED.body`,[p.id,JSON.stringify(p.materials)]);
}
