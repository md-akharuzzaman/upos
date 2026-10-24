import { useEffect, useRef, useState } from 'react';

// Scan a barcode with the device camera, using the browser's built-in
// BarcodeDetector (Chrome / Edge on Android, ChromeOS, macOS). On other
// browsers the Register hides the Camera button; a USB or Bluetooth scanner
// (which types the code and presses Enter) works everywhere.
export default function CameraScanner({ onCode, onClose }) {
  const video = useRef(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stream;
    let timer;
    let stopped = false;
    let last = '';
    (async () => {
      try {
        const detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (stopped) return;
        video.current.srcObject = stream;
        await video.current.play();
        const tick = async () => {
          if (stopped) return;
          try {
            const [hit] = await detector.detect(video.current);
            if (hit && hit.rawValue !== last) {
              last = hit.rawValue;
              await onCode(hit.rawValue);
            }
          } catch {
            /* frame not ready */
          }
          timer = setTimeout(tick, 250);
        };
        tick();
      } catch (err) {
        setError(err.name === 'NotAllowedError' ? 'Camera permission was refused.' : `Camera not available: ${err.message}`);
      }
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onCode]);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Scan with camera">
      <div className="card dialog">
        <h2>Scan a barcode</h2>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : (
          <video ref={video} muted playsInline style={{ width: '100%', borderRadius: 8, background: '#000' }} />
        )}
        <p className="hint">Hold the barcode steady in the frame. Each new code is added to the sale.</p>
        <div className="actions">
          <button onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
