import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useUsbScanner } from '../hooks/useUsbScanner';
import AccessScanModal from './AccessScanModal';
import { apiFetch } from '../services/api';
import { hasPermission } from '../utils/permissions';
import { parseScanData } from '../utils/dniParser';
import { unlockKioskAudio } from '../utils/kioskSounds';

const AccessScanContext = createContext(null);

const MIN_VERDICT_VISIBLE_MS = 2500;
const AUTO_CLOSE_AFTER_VERDICT_MS = 2000;

const isConnectionFailure = (err) => Boolean(err?.isNetworkError || err?.status === 0);

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export function AccessScanProvider({
  children,
  authToken,
  currentUser,
  paused = false,
  onReloadEntries,
  onAuthorizeManual
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [modalStatus, setModalStatus] = useState('processing');
  const [modalResult, setModalResult] = useState(null);
  const [lastRawScan, setLastRawScan] = useState('');
  const processingRef = useRef(false);
  const autoCloseRef = useRef(null);
  const verdictShownAtRef = useRef(0);

  const enabled = Boolean(
    currentUser
    && authToken
    && hasPermission(currentUser, 'access.kiosk')
  );

  const canAuthorizeManual = hasPermission(currentUser, 'master.citaciones.write');
  const canExceptionalEntry = hasPermission(currentUser, 'access.exceptional_entry');

  const clearAutoClose = () => {
    if (autoCloseRef.current) {
      clearTimeout(autoCloseRef.current);
      autoCloseRef.current = null;
    }
  };

  const closeModal = useCallback(() => {
    clearAutoClose();
    setModalOpen(false);
    setModalStatus('processing');
    setModalResult(null);
    verdictShownAtRef.current = 0;
  }, []);

  const scheduleAutoCloseAfterVerdict = useCallback((extraMs = AUTO_CLOSE_AFTER_VERDICT_MS) => {
    clearAutoClose();
    const shownAt = verdictShownAtRef.current || Date.now();
    const elapsed = Date.now() - shownAt;
    const remainingMin = Math.max(0, MIN_VERDICT_VISIBLE_MS - elapsed);
    autoCloseRef.current = setTimeout(() => {
      closeModal();
    }, remainingMin + extraMs);
  }, [closeModal]);

  useEffect(() => () => clearAutoClose(), []);

  const showVerdict = useCallback(async (status, data) => {
    setModalResult(data);
    setModalStatus(status);
    verdictShownAtRef.current = Date.now();
    await wait(MIN_VERDICT_VISIBLE_MS);
  }, []);

  const processScan = useCallback(async (rawData) => {
    if (!enabled || processingRef.current || paused) return;

    const trimmed = String(rawData || '').trim();
    if (!trimmed) return;

    const preview = parseScanData(trimmed);

    processingRef.current = true;
    setLastRawScan(trimmed);
    setModalOpen(true);
    setModalStatus('processing');
    setModalResult({
      name: preview.name || '',
      idNumber: preview.idNumber || ''
    });

    await unlockKioskAudio();

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      await showVerdict('connection_error', { message: 'Sin conexión' });
      processingRef.current = false;
      scheduleAutoCloseAfterVerdict(3000);
      return;
    }

    try {
      const data = await apiFetch('/access/kiosk-scan', {
        method: 'POST',
        token: authToken,
        body: { rawData: trimmed, readerId: 'guard-desk' }
      });

      if (data.authorized) {
        await showVerdict('authorized', data);
        onReloadEntries?.();
        scheduleAutoCloseAfterVerdict();
      } else {
        await showVerdict('denied', data);
        scheduleAutoCloseAfterVerdict(3500);
      }
    } catch (err) {
      if (isConnectionFailure(err)) {
        await showVerdict('connection_error', { message: err.message });
        scheduleAutoCloseAfterVerdict(3000);
      } else {
        await showVerdict('denied', {
          authorized: false,
          name: preview.name || '',
          idNumber: preview.idNumber || '',
          message: err.message || 'No se pudo validar el acceso'
        });
        scheduleAutoCloseAfterVerdict(3500);
      }
    } finally {
      processingRef.current = false;
    }
  }, [
    authToken,
    enabled,
    onReloadEntries,
    paused,
    scheduleAutoCloseAfterVerdict,
    showVerdict
  ]);

  useUsbScanner({
    enabled,
    paused: paused || modalOpen,
    onScan: processScan
  });

  const handleAuthorizeManual = useCallback(() => {
    clearAutoClose();
    const parsed = parseScanData(lastRawScan);
    const prefill = {
      dni: modalResult?.idNumber || parsed.idNumber || '',
      name: modalResult?.name || parsed.name || '',
      rawData: lastRawScan
    };
    closeModal();
    onAuthorizeManual?.(prefill);
  }, [closeModal, lastRawScan, modalResult, onAuthorizeManual]);

  const handleExceptionalEntry = useCallback(() => {
    clearAutoClose();
    closeModal();
    onAuthorizeManual?.({
      dni: modalResult?.idNumber || '',
      name: modalResult?.name || '',
      exceptional: true,
      rawData: lastRawScan
    });
  }, [closeModal, lastRawScan, modalResult, onAuthorizeManual]);

  return (
    <AccessScanContext.Provider value={{ processScan, closeModal }}>
      {children}
      <input
        type="text"
        className="global-scanner-capture usb-scanner-input"
        tabIndex={-1}
        aria-hidden="true"
        autoComplete="off"
        readOnly
      />
      <AccessScanModal
        open={modalOpen}
        status={modalStatus}
        result={modalResult}
        canAuthorizeManual={canAuthorizeManual}
        canExceptionalEntry={canExceptionalEntry}
        onClose={closeModal}
        onAuthorizeManual={handleAuthorizeManual}
        onExceptionalEntry={handleExceptionalEntry}
      />
    </AccessScanContext.Provider>
  );
}

export const useAccessScan = () => useContext(AccessScanContext);
