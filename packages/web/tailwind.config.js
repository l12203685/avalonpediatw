/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        avalon: {
          good: '#4CAF50',
          evil: '#F44336',
          merlin: '#2196F3',
          assassin: '#FF5722',
          dark: '#1a1a1a',
          card: '#2d2d2d',
        },
      },
    },
  },
  plugins: [],
}
