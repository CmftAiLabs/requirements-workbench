import type {FieldKey} from './types';
import type {DemoViewport} from './demo-viewport';
export interface DemoBinding {cardId:string;testId:string;field:FieldKey;navigationTestId?:string}
export interface DemoCheckStep {action:'click'|'fill'|'select'|'check'|'uncheck'|'expectDisabled'|'expectEnabled'|'expectText'|'expectValue'|'expectCount'|'expectVisible';testId:string;value?:string;count?:number}
export interface DemoCheck {name:string;cardIds:string[];steps:DemoCheckStep[]}
export interface DemoTimings {queueMs?:number;generationMs:number;buildMs:number;checkMs:number;totalMs:number}
export interface DemoModule {id:string;name:string;cardIds:string[];inputKey:string;artifactId:string;dependencies:string[];summary:string;viewport:DemoViewport;timings:DemoTimings;sourceHash:string}
export interface DemoCodeProposal {dependencies?:string[];viewport?:DemoViewport;summary:string;files:{path:string;content:string}[];deletePaths:string[];edits?:{path:string;search:string;replace:string}[];bindings:DemoBinding[];checks:DemoCheck[];assumptions:string[]}
export interface DemoBusinessContract {inputKey:string;source:string;summary:string}
export interface DemoRevision {businessContract?:DemoBusinessContract;modules?:DemoModule[];timings?:DemoTimings;viewport?:DemoViewport;id:string;artifactId:string;number:number;createdAt:string;inputKey:string;basisKey:string;draft:boolean;summary:string;cardIds:string[];bindings:DemoBinding[];assumptions:string[];checksPassed:number;sourceHash:string;model:string;parentId?:string;adoptedFrom?:string}
export interface GeneratedDemo {currentId:string;revisions:DemoRevision[]}
export interface DemoView {html:string;url?:string;revision?:DemoRevision;stale:boolean;draft:boolean;status:string}
