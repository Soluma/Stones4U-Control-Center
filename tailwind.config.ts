import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter var",
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      colors: {
        canvas: "#fafafa",
        surface: "#ffffff",
        "surface-hover": "#f6f6f8",
        border: {
          subtle: "#ececed",
          DEFAULT: "#e3e3e6",
          strong: "#d3d3d8",
        },
        ink: {
          primary: "#17171a",
          secondary: "#5c5c66",
          tertiary: "#8b8b96",
          disabled: "#c2c2c9",
        },
        accent: {
          50: "#eef1ff",
          100: "#dfe4fe",
          400: "#7b86f5",
          500: "#5561e8",
          600: "#4247cf",
          700: "#3538a8",
        },
        success: { 50: "#eafaf1", 500: "#1fa971", 700: "#127a51" },
        warning: { 50: "#fff8ea", 500: "#d99a1b", 700: "#9c6d0f" },
        danger: { 50: "#fdeeee", 500: "#dc4444", 700: "#a52e2e" },
      },
      boxShadow: {
        xs: "0 1px 2px 0 rgba(20, 20, 24, 0.04)",
        card: "0 1px 2px 0 rgba(20,20,24,0.04), 0 1px 1px 0 rgba(20,20,24,0.02)",
        popover:
          "0 4px 12px -2px rgba(20,20,24,0.10), 0 2px 4px -2px rgba(20,20,24,0.06)",
      },
      borderRadius: {
        md: "8px",
        lg: "10px",
        xl: "14px",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "slide-in-right": {
          from: { transform: "translateX(8px)", opacity: "0" },
          to: { transform: "translateX(0)", opacity: "1" },
        },
        "scale-in": {
          from: { transform: "scale(0.98)", opacity: "0" },
          to: { transform: "scale(1)", opacity: "1" },
        },
      },
      animation: {
        "fade-in": "fade-in 120ms ease-out",
        "slide-in-right": "slide-in-right 160ms ease-out",
        "scale-in": "scale-in 120ms ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
