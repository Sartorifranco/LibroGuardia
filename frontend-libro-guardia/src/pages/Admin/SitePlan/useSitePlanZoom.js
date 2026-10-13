import { useLayoutEffect, useRef, useState } from 'react';

export const ZOOMS = [1, 1.5, 2, 3, 4];

/** Zoom por pasos que mantiene centrado lo que se estaba mirando. */
export function useSitePlanZoom(viewportRef) {
  const [zoomIndex, setZoomIndex] = useState(0);
  const centerRef = useRef(null);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const center = centerRef.current;
    if (!viewport || !center) return;
    centerRef.current = null;
    viewport.scrollLeft = center.x * viewport.scrollWidth - viewport.clientWidth / 2;
    viewport.scrollTop = center.y * viewport.scrollHeight - viewport.clientHeight / 2;
  }, [zoomIndex, viewportRef]);

  const changeZoom = (nextIndex) => {
    const viewport = viewportRef.current;
    if (viewport && viewport.scrollWidth) {
      centerRef.current = {
        x: (viewport.scrollLeft + viewport.clientWidth / 2) / viewport.scrollWidth,
        y: (viewport.scrollTop + viewport.clientHeight / 2) / viewport.scrollHeight
      };
    }
    setZoomIndex(Math.max(0, Math.min(ZOOMS.length - 1, nextIndex)));
  };

  const fitZoom = () => {
    centerRef.current = null;
    setZoomIndex(0);
    if (viewportRef.current) {
      viewportRef.current.scrollLeft = 0;
      viewportRef.current.scrollTop = 0;
    }
  };

  return {
    zoom: ZOOMS[zoomIndex],
    zoomIndex,
    canZoomOut: zoomIndex > 0,
    canZoomIn: zoomIndex < ZOOMS.length - 1,
    zoomIn: () => changeZoom(zoomIndex + 1),
    zoomOut: () => changeZoom(zoomIndex - 1),
    fitZoom
  };
}
