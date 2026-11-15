import React, { useRef, useState, useCallback, useEffect } from 'react';

// Ritmo máximo de repintado del timeline (el RAF sigue a 60 fps solo para cálculos)
const LIVE_FRAME_MS = 1000 / 15;
const EDIT_FRAME_MS = 1000 / 30;

const fmt = (sec) => {
  if (isNaN(sec) || sec === null || sec === undefined || sec < 0) return '--:--:--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

const Timeline = ({
  inputs, activeSession, markers, isRecording,
  inPoint, outPoint, duration, onSeek,
  playerRef, onSetIn, onSetOut, onGoLive,
  isLiveMode, onSaveClip, hasInOut,
  focusRange, onFocusConsumed, playbackRate = 1, onPlaybackRateChange, onPlayPauseChange,
  renderClocks, onDeleteClip, currentClipId,
  onPlayheadUpdate
}) => {
  const trackRef = useRef(null);
  const [playhead, setPlayhead] = useState(0);
  const [visibleSeconds, setVisibleSeconds] = useState(60);
  const [viewStart, setViewStart] = useState(0);
  const [fixedWindow, setFixedWindow] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [draggingMarker, setDraggingMarker] = useState(null);
  const rafRef = useRef(null);
  const isPlayingRef = useRef(false);
  const isDraggingRef = useRef(false);
  const draggingMarkerRef = useRef(null);
  
  // En Edición los límites usan SIEMPRE la duración real. Antes se congelaba al salir de LIVE
  // y no se actualizaba: con la grabación en marcha no se podía ir más allá del instante en que
  // se entró en Edición, y al cargar otra sesión se heredaba la duración de la anterior.
  // La vista no salta al crecer la duración: viewStart solo cambia por acciones del operador.

  // Al cambiar de sesión: vista desde el principio y sin ventana fija del clip anterior
  const sessionId = activeSession?.id;
  useEffect(() => {
    if (isLiveMode) return;
    setFixedWindow(null);
    setViewStart(0);
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refs para listeners globales — siempre actualizados
  const viewStartRef = useRef(0);
  const visibleSecondsRef = useRef(60);
  const visibleDurationRef = useRef(60); // Siempre sincronizado con visibleDuration real (respeta fixedWindow)
  const durationRef = useRef(0);
  useEffect(() => { viewStartRef.current = viewStart; }, [viewStart]);
  useEffect(() => { visibleSecondsRef.current = visibleSeconds; }, [visibleSeconds]);
  // durationRef necesita el valor REAL (no congelado) para que el RAF loop en LIVE funcione correctamente
  useEffect(() => { durationRef.current = duration; }, [duration]);

  // Derived visible window (puro, sin efectos secundarios, absoluto en segundos)
  const visibleDuration = fixedWindow ? Math.min(fixedWindow, Math.max(1, duration)) : Math.min(visibleSeconds, Math.max(1, duration));
  const visibleEnd = viewStart + visibleDuration;
  // Mantener el ref sincronizado con el valor real en cada render
  visibleDurationRef.current = visibleDuration;

  // Funciones de utilidad eliminadas de cámaras guardadas previas

  const getClockTime = (sec) => {
    if (!activeSession || isNaN(sec) || sec === null || sec < 0) return '--:--:--';
    const start = new Date(activeSession.start_time).getTime();
    return new Date(start + sec * 1000).toLocaleTimeString();
  };

  // ── Al entrar en modo LIVE: posicionar la vista al final y limpiar candado ──
  useEffect(() => {
    if (!isLiveMode) return;
    setFixedWindow(null); // Romper el candado de ventana fija
    // Posición inicial al entrar en LIVE: vista al final
    const vd = Math.min(visibleSecondsRef.current, Math.max(1, durationRef.current));
    setViewStart(Math.max(0, durationRef.current - vd));
  }, [isLiveMode]); // Solo al ENTRAR en LIVE, no cada segundo

  // ── Auto-zoom al cargar un clip (focusRange) ────────────────────────────────
  useEffect(() => {
    if (!focusRange) return;
    const effectiveDuration = duration;
    if (!effectiveDuration) return;
    
    const { in: inPt, out: outPt, center: reqCenter } = focusRange;
    if (reqCenter !== undefined) {
      setViewStart(Math.max(0, Math.min(effectiveDuration - visibleDuration, reqCenter - visibleDuration / 2)));
      if (onFocusConsumed) onFocusConsumed();
      return;
    }
    if (inPt == null || outPt == null) return;
    const clipLen = Math.max(outPt - inPt, 1);
    const padding = clipLen * 0.3;
    const windowLen = clipLen + padding * 2;
    const center = (inPt + outPt) / 2;
    const newStart = Math.max(0, Math.min(Math.max(0, effectiveDuration - windowLen), center - windowLen / 2));
    setFixedWindow(windowLen);
    setViewStart(newStart);
    setPlayhead(inPt); // Mover también el playhead visual al punto IN del clip
    if (onPlayheadUpdate) onPlayheadUpdate(inPt);
    if (onFocusConsumed) onFocusConsumed();
  }, [focusRange, duration]);

  // ── RAF: sincronizar playhead con el video real (NO mueve la vista) ─────────
  useEffect(() => {
    if (isLiveMode) {
      // En LIVE: RAF continuo que interpola el playhead suavemente entre actualizaciones de duration
      let lastRafTime = performance.now();
      let currentPlayhead = durationRef.current;
      let lastCommit = 0;
      const liveSync = (now) => {
        const elapsed = (now - lastRafTime) / 1000; // segundos reales transcurridos
        lastRafTime = now;
        // GUARDA: Si ya NO se está grabando, congelar el playhead en la duración actual
        // Esto previene que el timeline siga avanzando tras parar la grabación
        if (!isRecording) {
          setPlayhead(durationRef.current);
          rafRef.current = requestAnimationFrame(liveSync);
          return;
        }
        // Avanzar el playhead interpolado por el tiempo real transcurrido
        currentPlayhead += elapsed;
        // Corregir drift: si duration (actualizado cada 1s) se adelanta, sincronizar
        if (durationRef.current > currentPlayhead + 0.5) {
          currentPlayhead = durationRef.current;
        } else if (currentPlayhead > durationRef.current + 2) {
          currentPlayhead = durationRef.current; // Evitar que se pase demasiado
        }
        if (onPlayheadUpdate) onPlayheadUpdate(currentPlayhead);
        // Repintar el timeline como mucho a ~15 fps: cada setPlayhead re-renderiza el
        // componente entero, y a 60 fps era el mayor consumo de CPU del kiosko
        if (now - lastCommit >= LIVE_FRAME_MS) {
          lastCommit = now;
          setPlayhead(currentPlayhead);
          // Auto-scroll en LIVE: mantener el borde derecho visible
          const vd = visibleDurationRef.current;
          if (currentPlayhead > viewStartRef.current + vd) {
            setViewStart(Math.max(0, currentPlayhead - vd));
          }
        }
        rafRef.current = requestAnimationFrame(liveSync);
      };
      rafRef.current = requestAnimationFrame(liveSync);
      return () => cancelAnimationFrame(rafRef.current);
    }
    // En EDICIÓN: sincronizar playhead con el reproductor HLS real
    let lastCommit = 0;
    const sync = (now) => {
      // NO actualizar el playhead desde el vídeo mientras el operador arrastra —
      // evita que el cursor "se ralle" al hacer scrubbing.
      if (!isDraggingRef.current && !draggingMarkerRef.current && playerRef?.current?.getCurrentTime) {
        const currentTime = playerRef.current.getCurrentTime();
        if (onPlayheadUpdate) onPlayheadUpdate(currentTime);
        // Re-render como mucho a ~30 fps mientras reproduce (en pausa el valor no cambia
        // y React ni siquiera re-renderiza)
        if (now - lastCommit >= EDIT_FRAME_MS) {
          lastCommit = now;
          setPlayhead(currentTime);
        }
        if (typeof playerRef.current.isPaused === 'function') {
          const paused = playerRef.current.isPaused();
          if (paused && isPlayingRef.current)  { isPlayingRef.current = false; setIsPlaying(false); }
          if (!paused && !isPlayingRef.current){ isPlayingRef.current = true;  setIsPlaying(true);  }
        }
      }
      rafRef.current = requestAnimationFrame(sync);
    };
    rafRef.current = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playerRef, isLiveMode, isRecording, duration]);

  // ── Listeners globales (drag fiable fuera del div) ──────────────────────────
  useEffect(() => {
    const xToT = (clientX) => {
      if (!trackRef.current) return viewStartRef.current;
      const rect = trackRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      // Usar visibleDurationRef para que coincida EXACTAMENTE con timeToPct() y el render
      return Math.max(0, Math.min(durationRef.current, viewStartRef.current + pct * visibleDurationRef.current));
    };
    const onMove = (e) => {
      const t = xToT(e.clientX);
      if (draggingMarkerRef.current === 'in')  { onSetIn(t);  return; }
      if (draggingMarkerRef.current === 'out') { onSetOut(t); return; }
      if (isDraggingRef.current) {
        setPlayhead(t);
        if (onPlayheadUpdate) onPlayheadUpdate(t);
        if (onSeek) onSeek(t);
        if (onGoLive) onGoLive(false);
      }
    };
    const onUp = () => {
      if (isDraggingRef.current && wasPlayingRef.current) {
        try {
          playerRef?.current?.play?.();
          if (onPlayPauseChange) onPlayPauseChange('play');
        } catch {}
      }
      isDraggingRef.current   = false;
      draggingMarkerRef.current = null;
      setIsDragging(false);
      setDraggingMarker(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, [onSetIn, onSetOut, onSeek, onGoLive, onPlayheadUpdate]);

  // ── Helpers de coordenadas ──────────────────────────────────────────────────
  const timeToPct = (t) => {
    if (!visibleDuration) return 0;
    return Math.max(0, Math.min(100, ((t - viewStart) / visibleDuration) * 100));
  };

  const xToTime = useCallback((clientX) => {
    if (!trackRef.current) return viewStart;
    const rect = trackRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.max(0, Math.min(duration, viewStart + pct * visibleDuration));
  }, [viewStart, visibleDuration, duration]);

  // ── Seek (sin mover la vista salvo que el punto quede fuera) ───────────────
  const seekTo = (t) => {
    const clamped = Math.max(0, Math.min(duration || Infinity, t));
    setPlayhead(clamped);
    if (onPlayheadUpdate) onPlayheadUpdate(clamped);
    if (onSeek) onSeek(clamped);
    if (onGoLive) onGoLive(false);
    // Re-centrar solo si el punto queda fuera de la ventana visible
    if ((clamped < viewStart || clamped > viewStart + visibleDuration) && duration > 0) {
      setViewStart(Math.max(0, Math.min(duration - visibleDuration, clamped - visibleDuration / 2)));
    }
  };

  const handleTrackClick = (e) => {
    if (isDraggingRef.current || draggingMarkerRef.current) return;
    seekTo(xToTime(e.clientX));
  };

  const wasPlayingRef = useRef(false);

  const handleTrackMouseDown = (e) => {
    if (draggingMarkerRef.current) return;
    isDraggingRef.current = true;
    setIsDragging(true);
    wasPlayingRef.current = isPlaying;
    try {
      if (isPlaying) {
        playerRef?.current?.pause?.();
        if (onPlayPauseChange) onPlayPauseChange('pause');
      }
    } catch {}
    if (e && e.clientX) {
      const t = xToTime(e.clientX);
      setPlayhead(t);
      if (onPlayheadUpdate) onPlayheadUpdate(t);
      if (onSeek) onSeek(t);
      if (onGoLive) onGoLive(false);
    }
  };

  const handlePlayPause = () => {
    if (isLiveMode) return;
    try {
      if (isPlaying) {
        playerRef?.current?.pause?.();
        onPlayPauseChange?.('pause');
      } else {
        playerRef?.current?.play?.();
        onPlayPauseChange?.('play');
      }
    } catch {}
  };

  const jog = (delta) => {
    if (isLiveMode) return;
    seekTo(Math.max(0, Math.min(duration, (playhead ?? 0) + delta)));
  };

  const handleZoomChange = (e) => {
    const newVd = parseFloat(e.target.value);
    const center = viewStart + visibleDuration / 2;
    const newStart = Math.max(0, Math.min(Math.max(0, duration - newVd), center - newVd / 2));
    setFixedWindow(null);
    setVisibleSeconds(newVd);
    setViewStart(newStart);
  };

  // ── Ticks ──────────────────────────────────────────────────────────────────
  const ticks = [];
  if (visibleDuration > 0) {
    const rawInterval = visibleDuration / 8;
    const steps = [1,2,5,10,15,30,60,120,300,600,1800,3600];
    const interval = steps.find(s => s >= rawInterval) || 3600;
    const firstTick = Math.ceil(viewStart / interval) * interval;
    for (let t = firstTick; t <= visibleEnd; t += interval)
      ticks.push({ t, pct: timeToPct(t) });
  }

  const inPct       = inPoint  !== null ? timeToPct(inPoint)  : null;
  const outPct      = outPoint !== null ? timeToPct(outPoint) : null;
  const playheadPct = timeToPct(playhead);

  const btnS = (active, color = 'var(--accent-blue)') => ({
    background: active ? `${color}22` : 'var(--bg-tertiary)',
    border: `1px solid ${active ? color : 'var(--border)'}`,
    color: active ? color : 'var(--text-secondary)',
    borderRadius: 6, padding: '8px 14px', cursor: 'pointer',
    fontSize: '0.9rem', fontWeight: 600, transition: 'all 0.12s',
    display: 'flex', alignItems: 'center', gap: 6,
    minWidth: 40, justifyContent: 'center', userSelect: 'none',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>

      {/* ── Fila de transporte ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, flexWrap: 'wrap' }}>
        <button style={btnS(false)} onClick={() => jog(-30)} title="-30s">⏮</button>
        <button style={btnS(false)} onClick={() => jog(-10)} title="-10s">⏪</button>
        <button style={btnS(false)} onClick={() => jog(-1)}  title="-1s">◁</button>
        <button
          style={{ ...btnS(isPlaying, 'var(--accent-amber)'), padding: '5px 16px', minWidth: 44, opacity: isLiveMode ? 0.4 : 1 }}
          onClick={handlePlayPause} disabled={isLiveMode}
          title={isPlaying ? 'Pausa' : 'Play'}
        >{isPlaying ? '⏸' : '▶'}</button>
        <button style={btnS(false)} onClick={() => jog(1)}  title="+1s">▷</button>
        <button style={btnS(false)} onClick={() => jog(10)} title="+10s">⏩</button>
        <button style={btnS(false)} onClick={() => jog(30)} title="+30s">⏭</button>

        <div style={{ width:1, height:20, background:'var(--border)', margin:'0 4px', flexShrink:0 }} />

        <button style={{ ...btnS(inPoint !== null, 'var(--accent-green)'), padding: '6px 16px', fontSize: '0.85rem' }}
          onClick={() => onSetIn(playhead)} disabled={!activeSession} title="Marcar IN en la posición actual">
          [IN]{inPoint !== null && <span style={{fontSize:'0.65rem',opacity:.8}}>{getClockTime(inPoint)}</span>}
        </button>
        <button style={{ ...btnS(outPoint !== null, 'var(--accent-green)'), padding: '6px 16px', fontSize: '0.85rem' }}
          onClick={() => onSetOut(playhead)} disabled={!activeSession} title="Marcar OUT en la posición actual">
          [OUT]{outPoint !== null && <span style={{fontSize:'0.65rem',opacity:.8}}>{getClockTime(outPoint)}</span>}
        </button>

        {inPoint !== null && outPoint !== null && (
          <>
            <span style={{
              fontFamily:"'JetBrains Mono',monospace", fontSize:'0.68rem',
              color:'var(--accent-green)', background:'rgba(81,207,102,0.08)',
              border:'1px solid rgba(81,207,102,0.2)', padding:'3px 7px', borderRadius:4
            }}>{fmt(Math.abs(outPoint - inPoint))}</span>
            <button 
              onClick={() => { onSetIn(null); onSetOut(null); }}
              style={{
                background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)',
                color: 'var(--text-muted)', borderRadius: 4, padding: '3px 7px', fontSize: '0.68rem',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center'
              }}
              title="Limpiar puntos IN/OUT"
            >✕</button>
          </>
        )}

        {hasInOut && (
          <div style={{display:'flex',alignItems:'center',gap:6,background:'rgba(255,255,255,0.03)',padding:'3px 8px',borderRadius:6,border:'1px solid rgba(255,255,255,0.1)'}}>
            <button onClick={() => onSaveClip([])}
              style={{
                background: 'var(--accent-green)',
                border:'none',
                color: '#000',
                borderRadius: 5, padding: '7px 14px',
                cursor: 'pointer',
                fontSize: '0.8rem', fontWeight: 800, transition: 'all 0.12s',
                display: 'flex', alignItems: 'center', gap: 5,
                boxShadow: '0 2px 8px rgba(81,207,102,0.35)'
              }}>💾 GUARDAR CLIP</button>
            <button onClick={() => onDeleteClip && onDeleteClip()}
              style={{
                background: 'rgba(255, 51, 68, 0.18)',
                border: '1px solid rgba(255, 51, 68, 0.45)',
                color: '#ff4d5d',
                borderRadius: 5, padding: '7px 12px',
                cursor: 'pointer',
                fontSize: '0.8rem', fontWeight: 800, transition: 'all 0.12s',
                display: 'flex', alignItems: 'center', gap: 5
              }}
              title={currentClipId ? "Eliminar este clip permanentemente" : "Descartar selección IN/OUT"}
            >
              🗑️ BORRAR CLIP
            </button>
          </div>
        )}

        <div style={{ flex: 1 }} />

        {/* ── Centro-Derecha: Relojes, LIVE, Velocidad ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {renderClocks && renderClocks()}
          
          <button onClick={() => onGoLive(!isLiveMode)}
            style={{
              fontFamily:"'JetBrains Mono',monospace", fontSize:'0.7rem',
              color: isLiveMode ? 'var(--accent-red)' : 'var(--text-muted)',
              background: isLiveMode ? 'rgba(224,49,49,0.12)' : 'rgba(255,255,255,0.05)',
              padding:'5px 12px', borderRadius:5,
              border:`1px solid ${isLiveMode ? 'rgba(224,49,49,0.4)' : 'rgba(255,255,255,0.1)'}`,
              display:'flex', alignItems:'center', gap:5,
              fontWeight:700, letterSpacing:1, cursor: 'pointer',
              transition:'all 0.15s',
            }}
            title={isLiveMode ? 'Pausar seguimiento (salir del directo)' : 'Volver al directo'}
          >
            <span style={{width:7,height:7,borderRadius:'50%',
              background: isLiveMode ? 'var(--accent-red)' : 'var(--text-muted)',
              display:'inline-block',
              boxShadow: isLiveMode ? '0 0 6px var(--accent-red)' : 'none'
            }}/>LIVE
          </button>

          {/* Playback speed control */}
          <div style={{ 
            display: 'flex', flexDirection: 'column', gap: 4, 
            background: 'var(--bg-tertiary)', padding: '4px 10px', 
            borderRadius: 6, border: '1px solid var(--border)',
            visibility: isLiveMode ? 'hidden' : 'visible'
          }}>
            {/* Fila superior: botones de preset */}
              <div style={{ display: 'flex', gap: 4, justifyContent: 'space-between' }}>
                {[0.25, 0.5, 0.8].map(rate => (
                  <button key={rate} onClick={() => { 
                    if (playerRef?.current?.setPlaybackRate) playerRef.current.setPlaybackRate(rate); 
                    if (onPlaybackRateChange) onPlaybackRateChange(rate);
                  }} style={{  
                    background: playbackRate === rate ? 'var(--accent-amber)' : 'rgba(255,255,255,0.05)', 
                    color: playbackRate === rate ? '#000' : 'var(--text-muted)', 
                    border: `1px solid ${playbackRate === rate ? 'var(--accent-amber)' : 'var(--border)'}`, 
                    borderRadius: 3, fontSize: '0.6rem', fontWeight: 800, padding: '2px 8px', cursor: 'pointer',
                    transition: 'all 0.15s'
                  }}>
                    x{rate.toString().replace('.', ',')}
                  </button>
                ))}
                <button onClick={() => { 
                  if (playerRef?.current?.setPlaybackRate) playerRef.current.setPlaybackRate(1); 
                  if (onPlaybackRateChange) onPlaybackRateChange(1);
                }} style={{  
                  background: playbackRate === 1 ? 'var(--accent-amber)' : 'rgba(255,255,255,0.05)', 
                  color: playbackRate === 1 ? '#000' : 'var(--text-muted)', 
                  border: `1px solid ${playbackRate === 1 ? 'var(--accent-amber)' : 'var(--border)'}`, 
                  borderRadius: 3, fontSize: '0.6rem', fontWeight: 800, padding: '2px 8px', cursor: 'pointer',
                  transition: 'all 0.15s'
                }}>
                  RESET
                </button>
              </div>
              {/* Fila inferior: slider */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'monospace', fontWeight: 600 }}>VEL</span>
                <input 
                  type="range" min="0.1" max="2" step="0.1" 
                  value={playbackRate} 
                  onChange={(e) => {
                    const rate = parseFloat(e.target.value);
                    if (playerRef?.current?.setPlaybackRate) playerRef.current.setPlaybackRate(rate);
                    if (onPlaybackRateChange) onPlaybackRateChange(rate);
                  }}  
                  style={{ width: 120, accentColor: 'var(--accent-amber)', cursor: 'pointer' }}
                  title={`Velocidad: ${playbackRate}x`}
                />
                <span style={{ fontSize: '0.7rem', color: 'var(--accent-amber)', fontFamily: 'monospace', minWidth: 26, textAlign: 'right', fontWeight: 700 }}>
                  {playbackRate}x
                </span>
              </div>
            </div>
        </div>

        <div style={{ flex: 1 }} />

        {/* ── Extremo Derecho: Escala ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{fontSize:'0.65rem',color:'var(--text-muted)',fontFamily:'monospace'}}>ESCALA (seg)</span>
          <input type="range" min="10" max={Math.max(10, duration)} step="1" value={visibleDuration}
            onChange={handleZoomChange}
            style={{width:70, accentColor:'var(--accent-blue)', cursor:'pointer'}}
            title={`Zoom a ${Math.round(visibleDuration)}s`}
            dir="rtl" />
          <span style={{fontSize:'0.65rem',color:'var(--accent-blue)',fontFamily:'monospace',minWidth:28}}>
            {Math.round(visibleDuration)}s</span>
        </div>
      </div>

      {/* ── Pista principal FIJA ── */}
      <div ref={trackRef}
        className="timeline-scroll"
        style={{
          flex:1, minHeight:0, userSelect:'none',
          cursor: draggingMarker ? 'ew-resize' : (isDragging ? 'grabbing' : (isLiveMode ? 'default' : 'crosshair'))
        }}
        onClick={!isLiveMode ? handleTrackClick : undefined}
        onMouseDown={!isLiveMode ? handleTrackMouseDown : undefined}
      >
        <div className="timeline-recorded" style={{width:`${timeToPct(duration)}%`}} />

        {inPct !== null && outPct !== null && (() => {
          const selLeft = Math.max(0, Math.min(100, inPct));
          const selRight = Math.max(0, Math.min(100, outPct));
          const selWidth = Math.max(0, selRight - selLeft);
          return (
            <div className="timeline-selection" style={{left:`${selLeft}%`,width:`${selWidth}%`}} />
          );
        })()}

        {inPct !== null && (
          <>
            <div style={{position:'absolute',top:0,left:`${inPct}%`,height:'100%',
              width:16,background:'transparent',transform:'translateX(-50%)',zIndex:6,cursor:'ew-resize'}}
              onMouseDown={e => {
                e.stopPropagation();
                isDraggingRef.current = false; setIsDragging(false);
                draggingMarkerRef.current = 'in'; setDraggingMarker('in');
              }}>
              <div style={{position:'absolute',top:0,left:'50%',transform:'translateX(-50%)',
                width:3,height:'100%',
                background:draggingMarker==='in' ? '#fff' : 'var(--accent-green)',
                transition:'background 0.1s'}}/>
            </div>
            <div className="timeline-point-label" style={{left:`${inPct}%`,pointerEvents:'none'}}>
              IN {getClockTime(inPoint)}
            </div>
          </>
        )}

        {outPct !== null && (
          <>
            <div style={{position:'absolute',top:0,left:`${outPct}%`,height:'100%',
              width:16,background:'transparent',transform:'translateX(-50%)',zIndex:6,cursor:'ew-resize'}}
              onMouseDown={e => {
                e.stopPropagation();
                isDraggingRef.current = false; setIsDragging(false);
                draggingMarkerRef.current = 'out'; setDraggingMarker('out');
              }}>
              <div style={{position:'absolute',top:0,left:'50%',transform:'translateX(-50%)',
                width:3,height:'100%',
                background:draggingMarker==='out' ? '#fff' : 'var(--accent-green)',
                transition:'background 0.1s'}}/>
            </div>
            <div className="timeline-point-label out-label" style={{left:`${outPct}%`,pointerEvents:'none'}}>
              OUT {getClockTime(outPoint)}
            </div>
          </>
        )}

        {markers.map((m,i) => {
          const p = timeToPct(m.timestamp_offset);
          if (p < -1 || p > 101) return null;
          return (
            <div key={m.id||i} className="timeline-marker" style={{left:`${p}%`}}
              onClick={e => {e.stopPropagation(); seekTo(m.timestamp_offset);}}>
              <div className="marker-tooltip">{m.label} · {getClockTime(m.timestamp_offset)}</div>
            </div>
          );
        })}

        {playheadPct >= -1 && playheadPct <= 101 && (
          <div style={{
            position:'absolute',top:0,
            left:`${Math.max(0,Math.min(100,playheadPct))}%`,
            height:'100%', width: isLiveMode ? 3 : 2,
            background: isLiveMode ? 'var(--accent-red)' : '#ffffff',
            boxShadow: isLiveMode ? '0 0 10px rgba(224,49,49,0.9)' : '0 0 6px rgba(255,255,255,0.7)',
            transform:'translateX(-50%)', zIndex:10, pointerEvents:'none',
          }}>
            <div style={{position:'absolute',top:-1,left:'50%',transform:'translateX(-50%)',
              width:10,height:10,
              background: isLiveMode ? 'var(--accent-red)' : '#fff',
              clipPath:'polygon(50% 0%,100% 50%,50% 100%,0% 50%)'}}/>
            {!isLiveMode && (
              <div style={{position:'absolute',top:12,left:'50%',transform:'translateX(-50%)',
                background:'rgba(0,0,0,0.85)',border:'1px solid rgba(255,255,255,0.15)',
                color:'#fff',fontSize:8,fontFamily:'monospace',
                padding:'1px 4px',borderRadius:3,whiteSpace:'nowrap',pointerEvents:'none'}}>
                {getClockTime(playhead)}
              </div>
            )}
          </div>
        )}

        <div className="timeline-ticks">
          {ticks.map(({t,pct}) => (
            <div key={t} className="timeline-tick" style={{left:`${pct}%`}}>
              {getClockTime(t)}
            </div>
          ))}
        </div>
      </div>

      {/* ── Scrollbar horizontal (absoluto en segundos) ── */}
      <div style={{display:'flex',alignItems:'center',gap:8,flexShrink:0}}>
        <span style={{fontSize:'0.6rem',color:'var(--text-muted)',fontFamily:'monospace',flexShrink:0,minWidth:52}}>
          {getClockTime(viewStart)}
        </span>
        <input type="range"
          min={0}
          max={Math.max(0.01, duration - visibleDuration)}
          step={Math.max(0.1, visibleDuration / 200)}
          value={Math.min(viewStart, Math.max(0, duration - visibleDuration))}
          onChange={e => setViewStart(parseFloat(e.target.value))}
          style={{flex:1, accentColor:'var(--accent-blue)', cursor:'pointer', height:6}}
          title="Desplazar por la línea de tiempo"
        />
        <span style={{fontSize:'0.6rem',color:'var(--text-muted)',fontFamily:'monospace',flexShrink:0,minWidth:52,textAlign:'right'}}>
          {getClockTime(Math.min(visibleEnd, duration))}
        </span>
      </div>
    </div>
  );
};

export default Timeline;
