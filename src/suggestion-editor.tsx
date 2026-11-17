import {useId, useState} from 'react';
import {FIELDS, type FieldChange} from '../shared/types';
import './suggestion-editor.css';

export interface FieldSuggestionEditorProps {
 change:FieldChange;
 value:string;
 adjusted:boolean;
 applied?:boolean;
 disabledReason?:string;
 onChange:(text:string)=>void;
 onReset:()=>void;
}

/** Edits only the pending review draft; the parent owns the final application. */
export function FieldSuggestionEditor({change,value,adjusted,applied=false,disabledReason,onChange,onReset}:FieldSuggestionEditorProps) {
 const [editing,setEditing]=useState(false);
 const descriptionId=useId();
 const disabledId=useId();
 const emptyId=useId();
 const fieldLabel=FIELDS.find(([key])=>key===change.field)?.[1]||change.field;
 const isAdjusted=adjusted||value!==change.after;
 const isEmpty=!value.trim();
 const isEditing=editing&&!disabledReason;
 const describedBy=[descriptionId,disabledReason?disabledId:'',isEmpty?emptyId:''].filter(Boolean).join(' ');

 return <div className={`suggestion-editor${isAdjusted?' is-adjusted':''}`}>
  <div className="suggestion-editor-before">
   <span>修改前</span>
   <p>{change.before||'未填写'}</p>
  </div>
  <div className="suggestion-editor-after">
   <div className="suggestion-editor-heading">
    <strong>{isAdjusted?'产品调整':'建议改为'}</strong>
    <button type="button" className="text-button" disabled={!!disabledReason} title={disabledReason} aria-describedby={describedBy} aria-expanded={isEditing} onClick={()=>setEditing(!editing)}>{isEditing?'完成调整':'调整内容'}</button>
   </div>
   {isEditing?<textarea
    autoFocus
    aria-label={`调整${fieldLabel}建议`}
    aria-describedby={describedBy}
    aria-invalid={isEmpty}
    value={value}
    maxLength={6000}
    rows={5}
    onChange={event=>onChange(event.target.value)}
   />:<p>{value||'未填写'}</p>}
   {isAdjusted&&<button type="button" className="text-button suggestion-editor-reset" disabled={!!disabledReason} title={disabledReason} aria-describedby={describedBy} onClick={onReset}>恢复 Agent 建议</button>}
   {isEmpty&&<small className="suggestion-editor-empty" id={emptyId}>内容不能为空，请补充后再统一确认。</small>}
  </div>
  <small className="suggestion-editor-hint" id={descriptionId}>{applied?'本轮审核已保存，修改结果见当前需求卡。':'调整仅保存在本次审核中，统一确认后写入卡片。'}</small>
  {disabledReason&&<small className="suggestion-editor-disabled" id={disabledId}>{disabledReason}</small>}
 </div>;
}
