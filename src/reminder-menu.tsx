import {useEffect,useId,useRef,useState} from 'react';
import {Bell,ChevronRight} from 'lucide-react';
import {reminderLabels,type DiscussionReminder} from '../shared/discussion-reminders';
import './reminder-menu.css';

export function ReminderMenu({items,busy,onOpen}:{items:DiscussionReminder[];busy:boolean;onOpen:(item:DiscussionReminder)=>void}){
  const [open,setOpen]=useState(false);
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const listId=useId();
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    const escape=(event:KeyboardEvent)=>{
      if(event.key!=='Escape')return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown',outside);
    document.addEventListener('keydown',escape);
    return ()=>{
      document.removeEventListener('pointerdown',outside);
      document.removeEventListener('keydown',escape);
    };
  },[open]);

  const count=items.length;
  return <div className="workspace-reminders" ref={root}>
    <button type="button" ref={trigger} className="reminder-trigger"
      aria-label={count?`提醒，${count} 项待办`:'提醒'} aria-expanded={open} aria-controls={listId}
      disabled={busy} onClick={()=>setOpen(!open)}>
      <Bell size={16} aria-hidden="true"/><span className="reminder-label">提醒</span>
      {count>0&&<span className="reminder-count" aria-hidden="true">{count>99?'99+':count}</span>}
    </button>
    {open&&<section id={listId} className="reminder-popover" aria-label="我的待办">
      <div className="reminder-heading"><strong>我的待办</strong>{count>0&&<small>{count} 项</small>}</div>
      {!count?<p className="reminder-empty">暂无待办</p>:
        <ul className="reminder-list">
          {items.map(item=><li key={`${item.projectId}:${item.cardId}:${item.anchorId}`}>
            <button type="button" disabled={busy} onClick={()=>{trigger.current?.focus();setOpen(false);onOpen(item);}}>
              <span className="reminder-item">
                <span className="reminder-item-meta"><span>{reminderLabels[item.kind]}</span><small>{item.projectName}</small></span>
                <strong>{item.cardTitle}</strong>
                {item.detail&&<span className="reminder-item-detail">{item.detail}</span>}
              </span>
              <ChevronRight size={15} aria-hidden="true"/>
            </button>
          </li>)}
        </ul>}
    </section>}
  </div>;
}
