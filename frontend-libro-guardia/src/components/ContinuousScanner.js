import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScanLine } from 'lucide-react';

function ContinuousScanner({ onScan, scannerId = 'continuous-scanner', paused = false }) {
  const scannerRef = useRef(null);
  const html5QrCodeRef = useRef(null);
  const usbInputRef = useRef(null);
  const usbBufferRef = useRef('');
  const lastScanRef = useRef({ value: '', at: 0 });
  const [cameraError, setCameraError] = useState(null);

  const emitScan = useCallback((value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return;

    const now = Date.now();
    if (lastScanRef.current.value === trimmed && now - lastScanRef.current.at < 5000) {
      return;
    }

    lastScanRef.current = { value: trimmed, at: now };
    onScan(trimmed);
  }, [onScan]);

  useEffect(() => {
    if (paused) return undefined;

    let mounted = true;

    const startScanner = async () => {
      try {
        const { Html5Qrcode } = await import('html5-qrcode');
        if (!mounted) return;

        const scanner = new Html5Qrcode(scannerId);
        html5QrCodeRef.current = scanner;

        await scanner.start(
          { facingMode: 'environment' },
          {
            fps: 12,
            qrbox: { width: 320, height: 220 },
            disableFlip: false
          },
          (decodedText) => {
            emitScan(decodedText);
          },
          () => {}
        );
        setCameraError(null);
      } catch (err) {
        setCameraError('Cámara no disponible. El lector USB sigue activo.');
      }
    };

    startScanner();

    return () => {
      mounted = false;
      if (html5QrCodeRef.current) {
        html5QrCodeRef.current.stop().catch(() => {});
        html5QrCodeRef.current.clear().catch(() => {});
        html5QrCodeRef.current = null;
      }
    };
  }, [emitScan, paused, scannerId]);

  useEffect(() => {
    if (paused) return undefined;

    const focusInput = () => {
      if (usbInputRef.current) {
        usbInputRef.current.focus();
      }
    };

    focusInput();
    const intervalId = setInterval(focusInput, 2000);
    return () => clearInterval(intervalId);
  }, [paused]);

  const handleUsbKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      emitScan(usbBufferRef.current);
      usbBufferRef.current = '';
      if (usbInputRef.current) usbInputRef.current.value = '';
      return;
    }

    if (e.key.length === 1) {
      usbBufferRef.current += e.key;
    }
  };

  return (
    <div className="continuous-scanner">
      <div className="continuous-scanner-header">
        <ScanLine size={22} />
        <span>Lector activo — acerque su DNI o QR de ingreso</span>
      </div>

      {!paused && (
        <div id={scannerId} ref={scannerRef} className="continuous-scanner-camera" />
      )}

      {cameraError && (
        <div className="continuous-scanner-note">{cameraError}</div>
      )}

      <input
        ref={usbInputRef}
        type="text"
        defaultValue=""
        onChange={() => {}}
        onKeyDown={handleUsbKeyDown}
        className="usb-scanner-input"
        aria-label="Entrada lector USB"
        autoComplete="off"
      />
    </div>
  );
}

export default ContinuousScanner;
