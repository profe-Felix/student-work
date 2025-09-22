//src/lib/realtime.ts
import { supabase } from './db';

export interface SetPagePayload {
  pageId: string;
  pageIndex: number;
  ts?: number;
}

export interface FocusPayload {
  on: boolean;
  lockNav?: boolean;
  ts?: number;
}

export interface AutoFollowPayload {
  on: boolean;
  allowedPages?: number[] | null; // zero-based allowed page indexes
  teacherPageIndex?: number;      // teacher's current page
  ts?: number;
}

export type TeacherPresenceState = {
  role: 'teacher';
  autoFollow: boolean;
  allowedPages: number[] | null;
  teacherPageIndex?: number;
  focusOn: boolean;
  lockNav: boolean;
  updatedAt: number;
};

export function assignmentChannel(assignmentId: string) {
  return supabase.channel(`assign:${assignmentId}`, {
    config: { broadcast: { ack: true }, presence: { key: 'teacher' } },
  });
}

/** Broadcast helpers */
export async function publishSetPage(ch: any, pageId: string, pageIndex: number) {
  const payload: SetPagePayload = { pageId, pageIndex, ts: Date.now() };
  await ch.send({ type: 'broadcast', event: 'SET_PAGE', payload });
}

export async function publishAutoFollow(
  ch: any,
  on: boolean,
  allowedPages?: number[] | null,
  teacherPageIndex?: number
) {
  const payload: AutoFollowPayload = {
    on,
    allowedPages: allowedPages ?? null,
    teacherPageIndex,
    ts: Date.now(),
  };
  await ch.send({ type: 'broadcast', event: 'AUTO_FOLLOW', payload });
}

export async function publishFocus(ch: any, on: boolean, lockNav = true) {
  const payload: FocusPayload = { on, lockNav, ts: Date.now() };
  await ch.send({ type: 'broadcast', event: 'FOCUS', payload });
}

/** Presence: teacher publishes current state; students read it on join */
export async function setTeacherPresence(
  ch: any,
  state: Omit<TeacherPresenceState, 'role' | 'updatedAt'> & Partial<Pick<TeacherPresenceState, 'updatedAt'>>
) {
  const payload: TeacherPresenceState = {
    role: 'teacher',
    autoFollow: !!state.autoFollow,
    allowedPages: state.allowedPages ?? null,
    teacherPageIndex: state.teacherPageIndex,
    focusOn: !!state.focusOn,
    lockNav: !!state.lockNav,
    updatedAt: state.updatedAt ?? Date.now(),
  };
  await ch.track(payload);
}

/** STUDENT side subscription: reads presence + listens to broadcasts */
export function subscribeToAssignment(
  assignmentId: string,
  handlers: {
    onSetPage?: (p: SetPagePayload) => void;
    onFocus?: (p: FocusPayload) => void;
    onAutoFollow?: (p: AutoFollowPayload) => void;
  }
) {
  const ch = supabase.channel(`assign:${assignmentId}`, {
    config: { broadcast: { ack: true }, presence: { key: 'student' } },
  });

  // Broadcasts
  ch
    .on('broadcast', { event: 'SET_PAGE' }, ({ payload }) =>
      handlers.onSetPage?.(payload as SetPagePayload)
    )
    .on('broadcast', { event: 'FOCUS' }, ({ payload }) =>
      handlers.onFocus?.(payload as FocusPayload)
    )
    .on('broadcast', { event: 'AUTO_FOLLOW' }, ({ payload }) =>
      handlers.onAutoFollow?.(payload as AutoFollowPayload)
    );

  // Presence sync
  ch.on('presence', { event: 'sync' }, () => {
    try {
      const state = ch.presenceState() as Record<string, TeacherPresenceState[]>;
      const arr = (state?.teacher ?? []).filter(s => s?.role === 'teacher');
      if (arr.length === 0) return;
      const latest = arr.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b));
      if (!latest) return;

      handlers.onAutoFollow?.({
        on: !!latest.autoFollow,
        allowedPages: latest.allowedPages ?? null,
        teacherPageIndex: latest.teacherPageIndex,
        ts: latest.updatedAt,
      });
      handlers.onFocus?.({
        on: !!latest.focusOn,
        lockNav: !!latest.lockNav,
        ts: latest.updatedAt,
      });
      if (typeof latest.teacherPageIndex === 'number') {
        handlers.onSetPage?.({
          pageId: '',
          pageIndex: latest.teacherPageIndex,
          ts: latest.updatedAt,
        });
      }
    } catch {}
  });

  // Safety read shortly after subscribe (helps late joiners)
  ch.subscribe((status: string) => {
    if (status === 'SUBSCRIBED') {
      setTimeout(() => {
        try {
          const state = ch.presenceState() as Record<string, TeacherPresenceState[]>;
          const arr = (state?.teacher ?? []).filter(s => s?.role === 'teacher');
          if (arr.length === 0) return;
          const latest = arr.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b));
          if (!latest) return;

          handlers.onAutoFollow?.({
            on: !!latest.autoFollow,
            allowedPages: latest.allowedPages ?? null,
            teacherPageIndex: latest.teacherPageIndex,
            ts: latest.updatedAt,
          });
          handlers.onFocus?.({
            on: !!latest.focusOn,
            lockNav: !!latest.lockNav,
            ts: latest.updatedAt,
          });
          if (typeof latest.teacherPageIndex === 'number') {
            handlers.onSetPage?.({
              pageId: '',
              pageIndex: latest.teacherPageIndex,
              ts: latest.updatedAt,
            });
          }
        } catch {}
      }, 50);
    }
  });

  return ch;
}
