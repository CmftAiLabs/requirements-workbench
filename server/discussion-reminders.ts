import {cardReminders,type AssignedReminder,type DiscussionReminder} from '../shared/discussion-reminders';
import type {ParticipantId} from '../shared/participants';
import type {Card,Project} from '../shared/types';
import {pool,type WorkspaceProjectVersion} from './store';

type ReminderRow = WorkspaceProjectVersion & Pick<Project,'createdAt'|'deliveries'> & {cards:Card[]};

/** Reuse the compact card read model. Only projects with a changed stamp require card reads. */
export function createReminderReader() {
  const cache = new Map<string,{stamp:string;name:string;items:AssignedReminder[]}>();
  return async (projects:WorkspaceProjectVersion[], participantId:ParticipantId):Promise<DiscussionReminder[]> => {
    const changed = projects.filter(({id,stamp,name}) => {
      const saved = cache.get(id);
      return saved?.stamp !== stamp || saved.name !== name;
    });
    if (changed.length) {
      const {rows} = await pool.query<ReminderRow>(`
        SELECT p.id,p.view_name AS name,p.view_stamp AS stamp,
               h.body->>'createdAt' AS "createdAt",h.body->'deliveries' AS deliveries,
               COALESCE((
                 SELECT jsonb_agg(c.body ORDER BY c.position)
                 FROM workspace_cards c
                 WHERE c.project_id=p.id AND c.body->>'included'='true'
                   AND c.body->>'granularity' IS DISTINCT FROM '概要'
               ),'[]'::jsonb) AS cards
        FROM projects p JOIN workspace_heads h ON h.project_id=p.id
        WHERE p.id=ANY($1::text[])
      `,[changed.map(project=>project.id)]);
      for (const row of rows) {
        const previous = cache.get(row.id);
        if (previous && BigInt(previous.stamp) > BigInt(row.stamp)) continue;
        cache.set(row.id,{stamp:row.stamp,name:row.name,items:row.cards.flatMap(card=>cardReminders(row,card))});
      }
      const projectIds = new Set(projects.map(project=>project.id));
      for (const id of cache.keys()) if (!projectIds.has(id)) cache.delete(id);
    }
    return projects.flatMap(({id})=>cache.get(id)?.items || [])
      .filter(item=>item.participantId===participantId)
      .sort((a,b)=>b.createdAt.localeCompare(a.createdAt))
      .map(({participantId:_,...item})=>item);
  };
}
