/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        navy:  { 50:'#eef2ff',100:'#e0e7ff',500:'#1e3a5f',600:'#162d4a',700:'#0f2035',800:'#091527',900:'#040c17' },
        teal:  { 50:'#f0fdfa',100:'#ccfbf1',400:'#2dd4bf',500:'#14b8a6',600:'#0d9488',700:'#0f766e' },
        status:{ online:'#22c55e', offline:'#ef4444', warning:'#f59e0b', unknown:'#6b7280' },
      },
      fontFamily: { sans: ['Inter var','Inter','system-ui','sans-serif'] },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4,0,0.6,1) infinite',
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-in': 'slideIn 0.3s ease-out',
      },
      keyframes: {
        fadeIn: { from:{ opacity:0, transform:'translateY(8px)' }, to:{ opacity:1, transform:'translateY(0)' } },
        slideIn: { from:{ transform:'translateX(-100%)' }, to:{ transform:'translateX(0)' } },
      }
    }
  },
  plugins: []
}
