import test from 'node:test';
import assert from 'node:assert/strict';
import {CLARIFICATION_IDLE_MS,shouldShowClarification,clarificationKey,clarificationBasis} from '../shared/idle-clarification';
import type {Card} from '../shared/types';
const ready={idleMs:CLARIFICATION_IDLE_MS,enabled:true,seen:false,typing:false,waiting:false,running:false};
test('安静90秒后才允许提醒；输入、追问和分析期间不打断',()=>{
 assert.equal(shouldShowClarification({...ready,idleMs:CLARIFICATION_IDLE_MS-1}),false);
 assert.equal(shouldShowClarification(ready),true);
 for(const key of ['typing','waiting','running','seen'] as const)assert.equal(shouldShowClarification({...ready,[key]:true}),false);
 assert.equal(shouldShowClarification({...ready,enabled:false}),false);
});
test('同一个未决问题保持提醒身份；新消息和卡片修订使在途解释过期',()=>{
 const c={id:'c',revision:1,messages:[{id:'m1'}],blockers:[{id:'b',reason:'错误提示文案待明确',resolved:false}]} as Card;
 const key=clarificationKey(c),basis=clarificationBasis(c);
 c.messages.push({id:'m2'} as Card['messages'][number]);assert.equal(clarificationKey(c),key);assert.notEqual(clarificationBasis(c),basis);
 const after=clarificationBasis(c);c.revision++;assert.notEqual(clarificationBasis(c),after);
 c.blockers[0].reason='月份是否必填待明确';assert.notEqual(clarificationKey(c),key);
 c.blockers[0].resolved=true;assert.equal(clarificationKey(c),'');
});
