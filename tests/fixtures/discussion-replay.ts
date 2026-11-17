import {createProject} from '../../server/domain';
import {FIELDS,type Card,type Fields} from '../../shared/types';
export function discussionReplayProject(name='办公用品多轮讨论回放'){
 const p=createProject(name);p.materials=[];
 const fields:Fields={goal:'员工提交物品申领。',scope:'桌面网页，固定一名虚构员工；不含登录、审批、库存和通知，也不含品牌信息。',flow:'填写物品名称、数量、用途；名称去除首尾空格后必填且最多40字；用途必填且最多100字；数量1到20的整数。提交成功生成编号，状态为已提交。',permission:'只创建本人记录。',exception:'无效输入提示错误并保留输入；提交中禁止重复提交。',data:'保存编号、物品名称、数量、用途、状态和创建时间。',constraint:'前端内存模拟数据，刷新清空，编号从A0001开始。',quality:'1280×800下无整页横向溢出。',acceptance:'其余字段有效时，名称40字可提交、41字不可提交；用途100字可提交、101字不可提交；数量1和20可提交，0和21不可提交。'};
 const c:Card={id:'replay-card',title:'提交物品申领',type:'功能要求',revision:1,round:1,fields,sources:[],provenance:Object.fromEntries(FIELDS.map(([key])=>[key,[]])) as unknown as Card['provenance'],included:true,exclusionReason:'',assessment:'可确认',issues:[],messages:[],blockers:[],approvals:{},confirmations:[],history:[],followUps:[]};p.cards=[c];return {p,c};
}
