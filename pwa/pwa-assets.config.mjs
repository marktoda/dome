// @vite-pwa/assets-generator 1.0.2's minimal-2023 inventory with Dome's
// full-bleed platform backgrounds. The stock preset pads maskable and Apple
// assets onto white; Dome's charcoal field must instead reach every edge.
export default {
  root: ".",
  images: "public/dome.svg",
  preset: {
    transparent: {
      sizes: [64, 192, 512],
      padding: 0.05,
      resizeOptions: { fit: "contain", background: "transparent" },
    },
    maskable: {
      sizes: [512],
      padding: 0,
      resizeOptions: { fit: "contain", background: "#111111" },
    },
    apple: {
      sizes: [180],
      padding: 0,
      resizeOptions: { fit: "contain", background: "#111111" },
    },
  },
  headLinkOptions: { preset: "2023" },
};
