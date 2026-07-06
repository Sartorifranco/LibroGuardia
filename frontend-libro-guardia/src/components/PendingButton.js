import React from 'react';
import { Loader2 } from 'lucide-react';

function PendingButton({
  actionId,
  pendingAction,
  children,
  pendingLabel = 'Procesando...',
  className = 'btn btn-primary',
  type = 'button',
  disabled,
  ...props
}) {
  const isPending = pendingAction === actionId;
  const isBlocked = Boolean(pendingAction && pendingAction !== actionId);

  return (
    <button
      type={type}
      className={`${className}${isPending ? ' btn-pending' : ''}`}
      disabled={disabled || isPending || isBlocked}
      aria-busy={isPending}
      {...props}
    >
      {isPending ? <Loader2 className="animate-spin" size={18} aria-hidden /> : null}
      {isPending ? pendingLabel : children}
    </button>
  );
}

export default PendingButton;
