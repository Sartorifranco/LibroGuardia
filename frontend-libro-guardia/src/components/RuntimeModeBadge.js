import React from 'react';
import { useRuntime } from '../context/RuntimeContext';

function RuntimeModeBadge() {
  const { mode, status, cloudOnline } = useRuntime();
  if (status !== 'ready' || mode !== 'lan') return null;
  const offline = cloudOnline === false;
  return (
    <span
      className={`runtime-mode-badge${offline ? ' runtime-mode-badge--off' : ' runtime-mode-badge--on'}`}
      role="status"
    >
      {offline ? 'Red local · sin internet' : 'Red local'}
    </span>
  );
}

export default RuntimeModeBadge;
