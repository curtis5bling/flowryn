/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: { fontFamily: { display: ['Georgia', 'serif'], sans: ['Inter', 'ui-sans-serif', 'sans-serif'] } } },
  plugins: [],
};