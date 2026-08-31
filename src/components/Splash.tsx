import { useEffect, useState } from 'react';
import { motion } from 'motion/react';

const TOTAL_FRAMES = 12;
const FPS = 12;

// Generate the frames once when the module loads
const frames = Array.from({ length: TOTAL_FRAMES }).map((_, frameIndex) => {
  const progress = frameIndex / (TOTAL_FRAMES - 1);
  // Start from 0, grow exponentially to cover the screen
  const radius = progress === 0 ? 0 : 5 + Math.pow(progress, 3) * 400; 
  
  let path = '';
  const pointsCount = 48; // Resolution of the shape
  for (let i = 0; i < pointsCount; i++) {
    const angle = (i / pointsCount) * Math.PI * 2;
    // Base 6-pointed star (Claude-style asterisk)
    const starAmplitude = radius * 0.35;
    const starBump = Math.sin(angle * 6) * starAmplitude;
    // Boiling/jitter effect for organic stop-motion feel
    const jitter = Math.sin(frameIndex * 13.3 + i * 9.7) * (radius * 0.05);
    const r = radius + starBump + jitter;
    
    const angleJitter = Math.sin(frameIndex * 7.1 + i * 11.3) * 0.04;
    const finalAngle = angle + angleJitter;

    const x = Math.cos(finalAngle) * r;
    const y = Math.sin(finalAngle) * r;
    
    if (i === 0) path += `M ${x.toFixed(1)} ${y.toFixed(1)} `;
    else path += `L ${x.toFixed(1)} ${y.toFixed(1)} `;
  }
  path += 'Z';
  
  // Outer rectangle drawn in opposite direction to create an evenodd hole
  return `M -500 -500 L 500 -500 L 500 500 L -500 500 Z ${path}`;
});

export default function Splash({ onComplete }: { onComplete: () => void }) {
  const [frame, setFrame] = useState(0);
  const [isReduced, setIsReduced] = useState(false);

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setIsReduced(reducedMotion);

    if (reducedMotion) {
      const timer = setTimeout(() => onComplete(), 200);
      return () => clearTimeout(timer);
    }

    const interval = setInterval(() => {
      setFrame((prev) => {
        if (prev >= TOTAL_FRAMES - 1) {
          clearInterval(interval);
          setTimeout(onComplete, 0);
          return prev;
        }
        return prev + 1;
      });
    }, 1000 / FPS);

    return () => clearInterval(interval);
  }, [onComplete]);

  // выход всегда через motion.div с exit-анимацией — раньше сплэш пропадал
  // мгновенно вместе с размонтированием (App.tsx снимал showSplash сразу по
  // onComplete), финальный кадр обрывался без перехода. Теперь AnimatePresence
  // в App.tsx придерживает элемент в дереве, пока не доиграет exit-фейд
  if (isReduced) {
    return <motion.div className="splash-gooey splash-reduced" exit={{ opacity: 0 }} transition={{ duration: 0.3 }} />;
  }

  if (frame >= TOTAL_FRAMES) return null;

  return (
    <motion.div className="splash-gooey" exit={{ opacity: 0 }} transition={{ duration: 0.4, ease: 'easeOut' }}>
      {/* Noise grain overlay for analog/crafted aesthetic */}
      <div className="splash-noise" />

      {/* Stop-motion flipbook layer */}
      <svg
        width="100%"
        height="100%"
        viewBox="-100 -100 200 200"
        preserveAspectRatio="xMidYMid slice"
        style={{ position: 'relative', zIndex: 2 }}
      >
        <path
          d={frames[frame]}
          fill="var(--accent)"
          fillRule="evenodd"
        />
      </svg>
    </motion.div>
  );
}
