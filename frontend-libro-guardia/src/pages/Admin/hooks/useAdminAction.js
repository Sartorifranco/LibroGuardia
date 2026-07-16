import { useCallback, useRef, useState } from 'react';

/**
 * Extracted shared "pending action" lock used across all admin sections.
 * Only one asynchronous admin action may run at a time; the header shows
 * a single indicator while `pendingAction` is set.
 */
export function useAdminAction() {
  const [pendingAction, setPendingAction] = useState(null);
  const actionLockRef = useRef(false);

  const runAction = useCallback(async (actionId, asyncFn) => {
    if (actionLockRef.current) return;
    actionLockRef.current = true;
    setPendingAction(actionId);
    try {
      await asyncFn();
    } finally {
      actionLockRef.current = false;
      setPendingAction(null);
    }
  }, []);

  return { pendingAction, setPendingAction, runAction };
}

export default useAdminAction;
