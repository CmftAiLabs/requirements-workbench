import {withDemoTrace} from './demo-trace.ts';
import {buildDemoHTML as buildCRMHTML,demoModel as crmModel} from './crm-demo.ts';
import {buildConferenceHTML,conferencePage} from './conference-demo.ts';
import {cardStatus,type Card,type Project} from './types.ts';
import {liveSuggestion,previewFields} from './crm-demo.ts';
export const demoLabel=(p:Project)=>p.demo?.kind==='conference'?'大会小程序':'CRM';
export const buildDemoHTML=(p:Project,c:Card)=>withDemoTrace(p.demo?.kind==='conference'?buildConferenceHTML(p,c):buildCRMHTML(p,c),p,c);
export const demoModel=(p:Project,c:Card)=>p.demo?.kind==='conference'?{projectName:p.name,cardId:c.id,title:c.title,revision:c.revision,status:cardStatus(c),kind:'conference',page:conferencePage(c),draft:!!liveSuggestion(c),suggestionId:liveSuggestion(c)?.id||null,fields:previewFields(c),included:c.included}:crmModel(p,c);
