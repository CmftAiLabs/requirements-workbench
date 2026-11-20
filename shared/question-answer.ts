import {eligibleQuestionAnswer} from './question-lifecycle';
import type {Card,FollowUp} from './types';
import {latestHumanMessage,waitingQuestion} from './discussion';
import {withoutLeadingAgentMention} from './agent-mention';
import {isQuestionRecipient} from './participants';

export function questionAnswerCandidate(card:Card){
 const message=latestHumanMessage(card);
 if(!message||message.role==='agent'||message.kind==='change')return null;
 const question=message.replyTo?card.followUps?.find(q=>q.id===message.replyTo&&['waiting','deferred'].includes(q.status)&&q.baseRevision===card.revision):waitingQuestion(card);
 if(!question||!isQuestionRecipient(question,message.role,message.participantId))return null;
 if(!eligibleQuestionAnswer(card,question,message))return null;
 return {message,question};
}
const comparable=(value:string)=>withoutLeadingAgentMention(value).normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu,'');

/** Only match explicit options or an unambiguous, two-option inclusion question.
 * Do not turn arbitrary acknowledgements, other people's replies, or negatives
 * about different rules into a decision. The original message remains evidence. */
export function matchQuestionOption(card:Card){
 const candidate=questionAnswerCandidate(card);if(!candidate)return null;
 const {message,question}=candidate;
 const option=matchQuestionText(question,message.text);return option?{...candidate,option}:null;
}

/** Conservative, reusable matching for original replies and explicit correction clauses. */
export function matchQuestionText(question:Pick<FollowUp,'question'|'options'|'field'>,value:string){
 if(/[？?]/.test(value))return null;
 const text=comparable(value);
 let matches=question.options.filter(option=>comparable(option)===text);
 if(!matches.length)matches=question.options.filter(option=>comparable(option.split(/[，,；;：:]/)[0])===text);
 if(!matches.length){const ordinal=/^(?:选|选择)?第?([一二三四1-4])(?:个|项)$/.exec(text);if(ordinal){const n='一二三四'.indexOf(ordinal[1]);const index=n>=0?n:Number(ordinal[1])-1;if(question.options[index])matches=[question.options[index]];}}
 if(!matches.length&&question.field==='scope'&&question.options.length===2&&/是否[^？?。]{0,20}(?:纳入|加入|添加|增加|列入)/.test(question.question)&&!/是否[^？?。]{0,12}(?:不|不要|无需|不必)/.test(question.question)){
  const negative=question.options.filter(option=>/(?:不|不要|暂不)(?:纳入|加入|添加|增加|列入)/.test(option));
  const positive=question.options.filter(option=>/(?:纳入|加入|添加|增加|列入)/.test(option)&&!negative.includes(option));
  if(negative.length===1&&positive.length===1){
   if(/^(?:(?:本期|这次|暂时|暂)?(?:不|不要|不加|不加入|不要加入|不添加|不要添加|不纳入|不增加|不要增加|不列入|不用加))$/.test(text))matches=negative;
   else if(/^(?:(?:本期|这次)?(?:加|加入|添加|纳入|增加|列入|要|可以|同意))$/.test(text))matches=positive;
  }
 }
 return matches.length===1?matches[0]:null;
}
