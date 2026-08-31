// thinking — ждём начала ответа (точки), typing — идёт стрим текста,
// listening — человек печатает черновик, ответа ещё не было
export type BroPose = 'default' | 'wave' | 'thinking' | 'typing' | 'happy' | 'empty' | 'listening';

// разные фоновые анимации "живости" — независимо от позы, поверх неё.
// sway — спокойное покачивание (для аватарки в шапке),
// bounce — более живой лёгкий подпрыг (для аватарок в ленте чата)
export type BroIdle = 'sway' | 'bounce';

interface BroMascotProps {
  pose?: BroPose;
  size?: number;
  idle?: BroIdle;
}

// цвета глаз/искры вынесены в CSS-токены (--mascot-eye/--mascot-spark), чтобы
// маскот тоже реагировал на смену темы, а не оставался хардкодным в тёмном режиме
const EYE = 'var(--mascot-eye)';
const SPARK = 'var(--mascot-spark)';

interface PoseConfig {
  leftRot: number;
  rightRot: number;
  closedEyes: boolean;
  blink: boolean;
  sparkle: boolean;
  wrapperClass: string;
}

function getPoseConfig(pose: BroPose): PoseConfig {
  switch (pose) {
    case 'wave':
      return { leftRot: 0, rightRot: -35, closedEyes: false, blink: true, sparkle: false, wrapperClass: 'bro-mascot--wave' };
    case 'thinking':
      return { leftRot: 0, rightRot: 0, closedEyes: false, blink: true, sparkle: false, wrapperClass: 'bro-mascot--thinking' };
    case 'typing':
      return { leftRot: 0, rightRot: 0, closedEyes: false, blink: true, sparkle: false, wrapperClass: 'bro-mascot--typing' };
    case 'happy':
      return { leftRot: 30, rightRot: -30, closedEyes: false, blink: false, sparkle: true, wrapperClass: 'bro-mascot--happy' };
    case 'empty':
      return { leftRot: -15, rightRot: 15, closedEyes: true, blink: false, sparkle: false, wrapperClass: 'bro-mascot--empty' };
    case 'listening':
      return { leftRot: 8, rightRot: -8, closedEyes: false, blink: true, sparkle: false, wrapperClass: 'bro-mascot--listening' };
    default:
      return { leftRot: 0, rightRot: 0, closedEyes: false, blink: true, sparkle: false, wrapperClass: '' };
  }
}

// поворот вокруг произвольной точки через CSS transform (а не SVG-атрибут),
// чтобы смена позы плавно доезжала через transition, а не прыгала
function rotateAround(deg: number, cx: number, cy: number) {
  return `translate(${cx}px, ${cy}px) rotate(${deg}deg) translate(${-cx}px, ${-cy}px)`;
}

export default function BroMascot({ pose = 'default', size = 120, idle = 'sway' }: BroMascotProps) {
  const cfg = getPoseConfig(pose);
  const eyeY = cfg.closedEyes ? 70 : 62;
  const eyeH = cfg.closedEyes ? 6 : 22;
  const eyeClass = cfg.blink ? 'bro-eye--blink' : undefined;
  const idleClass = idle === 'bounce' ? 'bro-mascot--idle-bounce' : 'bro-mascot--idle-sway';
  const breatheClass = idle === 'bounce' ? 'bro-mascot-breathe--quick' : '';

  return (
    <div className={`bro-mascot ${idleClass}`} style={{ width: size, height: size }}>
      <div className={`bro-mascot-breathe ${breatheClass}`}>
        <svg
          className={cfg.wrapperClass || undefined}
          width={size}
          height={size}
          viewBox="0 0 200 170"
          style={{ shapeRendering: 'crispEdges' }}
          xmlns="http://www.w3.org/2000/svg"
          role="img"
          aria-label="бро"
        >
          {/* лапки — на 3px шире, заходят ПОД корпус, чтобы при повороте не было щели у основания */}
          <rect
            className="bro-paw"
            x={20}
            y={63}
            width={28}
            height={20}
            fill="var(--accent)"
            style={{ transform: rotateAround(cfg.leftRot, 45, 73) }}
          />
          <rect
            className="bro-paw"
            x={152}
            y={63}
            width={28}
            height={20}
            fill="var(--accent)"
            style={{ transform: rotateAround(cfg.rightRot, 155, 73) }}
          />

          {/* корпус */}
          <rect x={45} y={50} width={110} height={70} fill="var(--accent)" />

          {/* глаза */}
          <g className="bro-eyes">
            <rect x={71} y={eyeY} width={22} height={eyeH} fill={EYE} className={eyeClass} />
            <rect x={107} y={eyeY} width={22} height={eyeH} fill={EYE} className={eyeClass} />
          </g>

          {/* ноги — на 3px выше, заходят ПОД корпус */}
          <rect x={45} y={117} width={14} height={33} fill="var(--accent)" />
          <rect x={77} y={117} width={14} height={33} fill="var(--accent)" />
          <rect x={109} y={117} width={14} height={33} fill="var(--accent)" />
          <rect x={141} y={117} width={14} height={33} fill="var(--accent)" />

          {/* искра — staggered burst-and-settle при входе, а не просто "появилась" */}
          {cfg.sparkle && (
            <>
              <rect className="bro-sparkle" x={160} y={4} width={8} height={8} fill={SPARK} style={{ animationDelay: '0ms' }} />
              <rect className="bro-sparkle" x={148} y={16} width={8} height={8} fill={SPARK} style={{ animationDelay: '40ms' }} />
              <rect className="bro-sparkle" x={160} y={16} width={8} height={8} fill={SPARK} style={{ animationDelay: '90ms' }} />
              <rect className="bro-sparkle" x={172} y={16} width={8} height={8} fill={SPARK} style={{ animationDelay: '60ms' }} />
              <rect className="bro-sparkle" x={160} y={28} width={8} height={8} fill={SPARK} style={{ animationDelay: '130ms' }} />
            </>
          )}
        </svg>
      </div>
    </div>
  );
}
