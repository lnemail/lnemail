/**
 * Tailwind configuration for the LNemail web UI.
 *
 * This mirrors the theme that previously lived inline in base.html and was
 * compiled in the browser by the Tailwind Play CDN. We now compile it ahead
 * of time into a static stylesheet (../src/lnemail/static/css/tailwind.css)
 * so the production site has zero third-party CDN dependencies.
 *
 * IMPORTANT: many Tailwind classes are emitted at runtime by the frontend
 * JavaScript (e.g. ui.js, inbox.js, utils.js render markup with class="..."),
 * so the content globs below must include the JS sources as well as the
 * Jinja templates. If you add new dynamic classes in JS, rebuild with
 * `bun run build` (see frontend/README is not needed; see package.json).
 */
/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: [
    "../src/lnemail/templates/**/*.html",
    "../src/lnemail/static/js/**/*.js",
  ],
  theme: {
    extend: {
      colors: {
        "on-tertiary-fixed-variant": "#3f465c",
        "surface-bright": "#36465c",
        "surface-variant": "#314058",
        "secondary": "#ffb874",
        "on-secondary": "#4b2800",
        "inverse-on-surface": "#263143",
        "secondary-container": "#e78603",
        "on-tertiary-container": "#3c4459",
        "danger-red": "#EF4444",
        "on-secondary-fixed": "#2d1600",
        "on-tertiary-fixed": "#131b2e",
        "surface-container-highest": "#31425b",
        "on-background": "#d8e3fb",
        "inverse-primary": "#00668a",
        "on-error-container": "#ffdad6",
        "surface": "#081425",
        "error-container": "#93000a",
        "on-surface-variant": "#bdc8d1",
        "inverse-surface": "#d8e3fb",
        "on-secondary-container": "#522c00",
        "glow-blue": "rgba(56, 189, 248, 0.15)",
        "surface-glass": "rgba(38, 52, 74, 0.85)",
        "success-green": "#10B981",
        "secondary-fixed": "#ffdcbf",
        "tertiary-container": "#a9b1ca",
        "primary-container": "#38bdf8",
        "surface-container-lowest": "#040e1f",
        "on-primary-fixed-variant": "#004c69",
        "surface-container-low": "#16243a",
        "surface-dim": "#081425",
        "tertiary-fixed": "#dae2fd",
        "primary": "#8ed5ff",
        "error": "#ffb4ab",
        "tertiary-fixed-dim": "#bec6e0",
        "on-primary": "#00354a",
        "surface-container-high": "#27374e",
        "primary-fixed-dim": "#7bd0ff",
        "surface-container": "#1b2a40",
        "on-surface": "#d8e3fb",
        "on-error": "#690005",
        "on-primary-container": "#004965",
        "on-tertiary": "#283044",
        "tertiary": "#c5cce6",
        "outline": "#9aa5ad",
        "primary-fixed": "#c4e7ff",
        "outline-variant": "#4a5663",
        "secondary-fixed-dim": "#ffb874",
        "background": "#081425",
        "on-primary-fixed": "#001e2c",
        "surface-tint": "#7bd0ff",
        "on-secondary-fixed-variant": "#6b3b00",
        "cyber-blue": "#38bdf8",
        "cyber-green": "#10B981",
        "tech-black": "#081425",
        "tech-gray": "#1e293b",
      },
      borderRadius: {
        DEFAULT: "0.25rem",
        lg: "0.5rem",
        xl: "0.75rem",
        full: "9999px",
      },
      spacing: {
        gutter: "24px",
        "container-max": "1100px",
        "margin-mobile": "16px",
        "margin-desktop": "40px",
        unit: "4px",
      },
      fontFamily: {
        "headline-xl": ["Inter"],
        "headline-lg": ["Inter"],
        "headline-lg-mobile": ["Inter"],
        "label-caps": ["JetBrains Mono"],
        "code-sm": ["JetBrains Mono"],
        "body-md": ["Inter"],
      },
      fontSize: {
        "headline-xl": ["48px", { lineHeight: "1.1", letterSpacing: "-0.02em", fontWeight: "800" }],
        "headline-lg": ["32px", { lineHeight: "1.2", letterSpacing: "-0.01em", fontWeight: "700" }],
        "headline-lg-mobile": ["28px", { lineHeight: "1.2", fontWeight: "700" }],
        "label-caps": ["12px", { lineHeight: "1", letterSpacing: "0.1em", fontWeight: "700" }],
        "code-sm": ["14px", { lineHeight: "1.5", fontWeight: "400" }],
        "body-md": ["16px", { lineHeight: "1.6", fontWeight: "400" }],
      },
    },
  },
  plugins: [
    require("@tailwindcss/forms"),
    require("@tailwindcss/container-queries"),
  ],
};
