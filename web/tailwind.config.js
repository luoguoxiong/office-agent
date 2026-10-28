/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 暗色主题中间过渡色（neutral-800 与 neutral-900 之间）
        'neutral-850': '#262626',
      },
      boxShadow: {
        'ux-soft': '0 1px 2px 0 rgb(0 0 0 / 0.2)',
      },
      keyframes: {
        thinking: {
          '0%, 80%, 100%': { opacity: '0.3', transform: 'scale(0.8)' },
          '40%': { opacity: '1', transform: 'scale(1)' },
        },
      },
    },
  },
  plugins: [],
};
