import { JUMP, LEFT, RIGHT } from "../../sim/index";

const down = new Set<string>();
const touch = { left: false, right: false, jump: false };

window.addEventListener("keydown", (e) => {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"].includes(e.code)) e.preventDefault();
  down.add(e.code);
});
window.addEventListener("keyup", (e) => down.delete(e.code));
window.addEventListener("blur", () => down.clear());

const any = (...codes: string[]) => codes.some((c) => down.has(c));

/** Player using either key set (single player and online). */
export function readSolo(): number {
  return (
    (any("ArrowLeft", "KeyA") || touch.left ? LEFT : 0) |
    (any("ArrowRight", "KeyD") || touch.right ? RIGHT : 0) |
    (any("ArrowUp", "KeyW", "Space") || touch.jump ? JUMP : 0)
  );
}

/** Two players on one keyboard: WASD on the left, arrows on the right. */
export function readLocal(side: 0 | 1): number {
  if (side === 0) return (any("KeyA") ? LEFT : 0) | (any("KeyD") ? RIGHT : 0) | (any("KeyW") ? JUMP : 0);
  return (any("ArrowLeft") ? LEFT : 0) | (any("ArrowRight") ? RIGHT : 0) | (any("ArrowUp") ? JUMP : 0);
}

export function setupTouch(root: HTMLElement) {
  if (!("ontouchstart" in window) && !navigator.maxTouchPoints) return;
  document.body.classList.add("touch");
  root.hidden = false;
  for (const b of root.querySelectorAll<HTMLButtonElement>("button[data-key]")) {
    const key = b.dataset.key as keyof typeof touch;
    const set = (v: boolean) => (e: Event) => {
      e.preventDefault();
      touch[key] = v;
      b.classList.toggle("down", v);
    };
    b.addEventListener("pointerdown", set(true));
    b.addEventListener("pointerup", set(false));
    b.addEventListener("pointercancel", set(false));
    b.addEventListener("pointerleave", set(false));
  }
}
