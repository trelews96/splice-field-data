// Standard 12-color fiber/tube sequence, spelled the way the as-built workbook spells it.
// Keep in sync with generator/fiber_colors.py.
export const COLORS = ["blue", "Orange", "green", "Brown", "slate", "white",
  "red", "black", "yellow", "violet", "rose", "aqua"];

export const ABBREV = { blue: "BL", Orange: "OR", green: "GR", Brown: "BR", slate: "SL", white: "WH",
  red: "RD", black: "BK", yellow: "YL", violet: "VI", rose: "RS", aqua: "AQ" };

// Swatch colors for the UI only.
export const SWATCH = { blue: "#1f5fd1", Orange: "#f08a00", green: "#1d9a3a", Brown: "#8a5a2b", slate: "#7d8790",
  white: "#ffffff", red: "#d62828", black: "#111111", yellow: "#f5d000", violet: "#8e44ad", rose: "#f4a6c0", aqua: "#2ec4c4" };

const color = (i) => COLORS[(i - 1) % 12] + (i > 12 ? " stripe" : "");

export function tubeAndFiber(n, fibersPerTube = 12) {
  const tube = Math.floor((n - 1) / fibersPerTube) + 1;
  const pos = ((n - 1) % fibersPerTube) + 1;
  return [color(tube), color(pos)];
}

export function shortCode(n, fibersPerTube = 12) {
  return tubeAndFiber(n, fibersPerTube)
    .map((c) => ABBREV[c.split(" ")[0]] + (c.includes("stripe") ? "*" : ""))
    .join("-");
}

export function tubeCount(fiberCount, fibersPerTube = 12) {
  return Math.ceil((fiberCount || 0) / fibersPerTube);
}
