import React, { useEffect, useRef, useState } from 'react';
import { XCircle, Camera, Keyboard } from 'lucide-react';

function QrScanner({ onScan, onClose, title = 'Escanear DNI o QR' }) {
  const scannerRef = useRef(null);
  const html5QrCodeRef = useRef(null);
  const [manualInput, setManualInput] = useState('');
  const [cameraError, setCameraError] = useState(null);
  const [useManual, setUseManual] = useState(false);

  useEffect(() => {
    if (useManual) return undefined;

    let mounted = true;

    const startScanner = async () => {
      try {
        const { Html5Qrcode } = await import('html5-qrcode');
        if (!mounted || !scannerRef.current) return;

        const scanner = new Html5Qrcode('qr-reader');
        html5QrCodeRef.current = scanner;

        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 260, height: 260 } },
          (decodedText) => {
            onScan(decodedText);
            scanner.stop().catch(() => {});
            onClose();
          },
          () => {}
        );
      } catch (err) {
        setCameraError('No se pudo acceder a la cámara. Use ingreso manual o lector USB.');
        setUseManual(true);
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
  }, [onClose, onScan, useManual]);

  const handleManualSubmit = (e) => {
    e.preventDefault();
    if (!manualInput.trim()) return;
    onScan(manualInput.trim());
    onClose();
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content max-w-lg">
        <button type="button" className="close-button" onClick={onClose} aria-label="Cerrar">
          <XCircle size={24} />
        </button>
        <h3 className="text-xl font-semibold text-gray-800 mb-2 flex items-center gap-2">
          <Camera size={20} /> {title}
        </h3>
        <p className="text-sm text-gray-600 mb-4">
          Escanee el código QR del DNI, use un lector USB o ingrese el número manualmente.
        </p>

        {!useManual && (
          <div id="qr-reader" ref={scannerRef} className="rounded-lg overflow-hidden mb-4" />
        )}

        {cameraError && (
          <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-3 mb-4">
            {cameraError}
          </div>
        )}

        <form onSubmit={handleManualSubmit} className="space-y-3">
          <label htmlFor="manualScanInput" className="block text-sm font-medium text-gray-700">
            <Keyboard size={16} className="inline mr-1" /> DNI / código escaneado
          </label>
          <input
            id="manualScanInput"
            type="text"
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
            className="input-field"
            placeholder="Ej: 12345678 o pegue datos del lector"
            autoFocus={useManual}
          />
          <div className="flex gap-2">
            {!useManual && (
              <button type="button" className="btn btn-secondary flex-1" onClick={() => setUseManual(true)}>
                Usar solo manual
              </button>
            )}
            {useManual && (
              <button type="button" className="btn btn-secondary flex-1" onClick={() => setUseManual(false)}>
                Reintentar cámara
              </button>
            )}
            <button type="submit" className="btn btn-primary flex-1">
              Confirmar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default QrScanner;
