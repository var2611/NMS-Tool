/**
 * SentinelNMS inline SVG logo — scales cleanly at any size.
 * Props:
 *   size     — icon size in px (default 32)
 *   showText — show "SentinelNMS" wordmark beside icon (default false)
 *   className — extra CSS classes on the wrapper
 *
 * Deliberately avoids SVG filter primitives (feGaussianBlur etc.) to
 * stay clear of React's SVG-attribute edge cases. Glow is achieved
 * with CSS drop-shadow which is universally safe in JSX.
 */
import { useId } from 'react'

export default function SentinelLogo({ size = 32, showText = false, className = '' }) {
  const uid = useId().replace(/:/g, '')   // useId returns e.g. ":r0:" — strip colons for valid XML id
  const glowStyle = { filter: 'drop-shadow(0 0 3px #14b8a6)' }
  const bgGlowStyle = { filter: 'drop-shadow(0 0 6px rgba(20,184,166,0.4))' }

  return (
    <div className={`flex items-center gap-2 ${className}`} style={{ lineHeight: 1, flexShrink: 0 }}>
      {/* ── Shield icon ── */}
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        xmlns="http://www.w3.org/2000/svg"
        style={{ flexShrink: 0 }}
        aria-label="SentinelNMS logo"
        role="img"
      >
        <defs>
          <radialGradient id={`${uid}-bg`} cx="50%" cy="35%" r="60%">
            <stop offset="0%" stopColor="#163150" />
            <stop offset="100%" stopColor="#0a1520" />
          </radialGradient>
          <radialGradient id={`${uid}-shield`} cx="50%" cy="20%" r="80%">
            <stop offset="0%" stopColor="#122847" />
            <stop offset="100%" stopColor="#07121e" />
          </radialGradient>
        </defs>

        {/* Background circle */}
        <circle cx="50" cy="50" r="49" fill={`url(#${uid}-bg)`} />

        {/* Shield glow (CSS drop-shadow on group) */}
        <g style={bgGlowStyle}>
          {/* Shield body */}
          <path
            d="M 18 13 L 82 13 L 82 58 L 50 88 L 18 58 Z"
            fill={`url(#${uid}-shield)`}
          />
          {/* Shield border */}
          <path
            d="M 18 13 L 82 13 L 82 58 L 50 88 L 18 58 Z"
            fill="none"
            stroke="#14b8a6"
            strokeWidth="2.8"
            strokeLinejoin="round"
          />
        </g>

        {/* Top highlight */}
        <line x1="20" y1="14.5" x2="80" y2="14.5" stroke="#2dd4bf" strokeWidth="1.4" opacity="0.75" />

        {/* Corner accent dots */}
        <circle cx="18" cy="13" r="2" fill="#14b8a6" opacity="0.6" />
        <circle cx="82" cy="13" r="2" fill="#14b8a6" opacity="0.6" />

        {/* Signal arcs — CSS drop-shadow glow */}
        <g style={glowStyle}>
          {/* Large arc - faintest */}
          <path
            d="M 28 65 A 22 22 0 0 0 72 65"
            fill="none"
            stroke="#14b8a6"
            strokeWidth="2.2"
            strokeLinecap="round"
            opacity="0.40"
          />
          {/* Medium arc */}
          <path
            d="M 35 65 A 15 15 0 0 0 65 65"
            fill="none"
            stroke="#14b8a6"
            strokeWidth="2.8"
            strokeLinecap="round"
            opacity="0.70"
          />
          {/* Small arc - brightest */}
          <path
            d="M 42 65 A 8 8 0 0 0 58 65"
            fill="none"
            stroke="#14b8a6"
            strokeWidth="3.4"
            strokeLinecap="round"
          />
          {/* Center dot glow ring */}
          <circle cx="50" cy="65" r="7" fill="#14b8a6" opacity="0.18" />
          {/* Center dot */}
          <circle cx="50" cy="65" r="4.5" fill="#14b8a6" />
          <circle cx="50" cy="65" r="2.2" fill="#2dd4bf" />
        </g>
      </svg>

      {/* ── Wordmark ── */}
      {showText && (
        <div style={{ lineHeight: 1.2 }}>
          <p style={{
            margin: 0,
            fontWeight: 700,
            fontSize: Math.round(size * 0.44),
            color: 'white',
            letterSpacing: '-0.01em',
            fontFamily: 'inherit',
          }}>
            Sentinel<span style={{ color: '#14b8a6' }}>NMS</span>
          </p>
          <p style={{
            margin: 0,
            fontSize: Math.round(size * 0.27),
            color: '#64748b',
            fontWeight: 400,
            marginTop: 2,
            fontFamily: 'inherit',
          }}>
            Nav Wireless Technologies
          </p>
        </div>
      )}
    </div>
  )
}
