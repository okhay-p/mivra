import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { routeConnectors, type Box, type ConnectorLayout, type ConnectorRequest } from "./composition-geometry.js";

/** How long a card takes to glide to its new place. Short, so stepping quickly never feels held back. */
export const MOVE_MS = 320;
const EASING = "cubic-bezier(0.2, 0, 0, 1)";

/** "step" is Prev, Next or an arrow key, the only moves that animate; "seek" is the picker, Restart, Home or End. */
export type Navigation = "step" | "seek";

const CARD = '[data-testid="composition-entity"]';
const OBSTACLE = "[data-composition-obstacle]";
const FOCUSABLE = "[tabindex], a[href], button, input, select, textarea";

/** The card holding an id, found by comparing data rather than by building a selector from the id. */
const cardFor = (grid: HTMLElement, id: string) => [...grid.querySelectorAll<HTMLElement>(CARD)].find((card) => card.dataset.entity === id);

const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Where a card is drawn now, mid-glide included, relative to the grid. */
function visualBox(el: Element, origin: DOMRect): Box {
  const r = el.getBoundingClientRect();
  return { x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height };
}

/** Where layout puts an element, relative to the grid, ignoring any transform a glide has on it. */
function layoutBox(el: HTMLElement, grid: HTMLElement): Box {
  let x = 0;
  let y = 0;
  let at: HTMLElement | null = el;
  while (at && at !== grid) {
    x += at.offsetLeft;
    y += at.offsetTop;
    at = at.offsetParent as HTMLElement | null;
  }
  if (at !== grid) return visualBox(el, grid.getBoundingClientRect());
  return { x, y, width: el.offsetWidth, height: el.offsetHeight };
}

const sameLayout = (a: ConnectorLayout, b: ConnectorLayout) =>
  a.narrow === b.narrow && a.connectors.length === b.connectors.length && a.connectors.every((c, i) => c.id === b.connectors[i]!.id && c.path === b.connectors[i]!.path);

/**
 * The motion and the drawn connectors of a composition (#114), layered on the snapshot the component renders.
 * Neither ever changes what step is shown: `navigate` moves the stepper at once, and only afterwards do the cards
 * that were already on show glide from where they were drawn to where the new step puts them (FLIP, with the Web
 * Animations API). Only a step to the next or previous snapshot glides; a seek, a reset or a learner who prefers
 * reduced motion gets a cut. Starting from where a card is drawn, mid-glide included, is what rebases an
 * interrupted glide, and every glide is cancelled before the next step lays out, so the cards always end where
 * the selected step puts them. A width change mid-glide cancels it too.
 *
 * A card that moves to another group is a new element, so focus inside it would fall to the page. It goes back
 * to the same place in the card's new element, or to the artifact if that place can't take it or the card is gone.
 *
 * The connectors are routed from where layout puts the cards, so a glide doesn't move them; they're hidden while
 * cards glide and drawn again when they land. They're measured on every render, when the grid or a card changes
 * size and when fonts load.
 */
export function useCompositionStage(grid: RefObject<HTMLDivElement | null>, index: number, last: number, go: (next: number) => void, connections: readonly ConnectorRequest[]) {
  const committed = useRef(index);
  const pending = useRef<{ to: number; from: Map<string, Box> } | null>(null);
  const running = useRef<Animation[]>([]);
  const generation = useRef(0);
  const width = useRef(0);
  const focus = useRef<{ entity: string; at: number } | null>(null);
  const [moving, setMoving] = useState(false);
  const [layout, setLayout] = useState<ConnectorLayout>({ narrow: false, connectors: [] });
  const requests = useRef(connections);
  requests.current = connections;

  const stop = () => {
    for (const animation of running.current) animation.cancel();
    running.current = [];
    generation.current++;
  };

  const navigate = (next: number, how: Navigation) => {
    const to = Math.max(0, Math.min(next, last));
    const el = grid.current;
    pending.current = null;
    const active = document.activeElement;
    const holder = el && active instanceof HTMLElement && el.contains(active) ? active.closest<HTMLElement>(CARD) : null;
    focus.current = holder ? { entity: holder.dataset.entity!, at: [...holder.querySelectorAll(FOCUSABLE)].indexOf(active!) } : null;
    // A seek or reset to the step already chosen changes nothing, so no effect would cut a glide still landing.
    if (to === committed.current && how === "seek" && running.current.length) {
      stop();
      setMoving(false);
    }
    if (el && how === "step" && Math.abs(to - committed.current) === 1 && !reducedMotion()) {
      const origin = el.getBoundingClientRect();
      pending.current = { to, from: new Map([...el.querySelectorAll<HTMLElement>(CARD)].map((card) => [card.dataset.entity!, visualBox(card, origin)])) };
    }
    go(to);
  };

  useLayoutEffect(() => {
    if (committed.current === index) return;
    committed.current = index;
    const from = pending.current?.to === index ? pending.current.from : undefined;
    pending.current = null;
    stop();
    const el = grid.current;
    const animations: Animation[] = [];
    if (from && el) {
      const origin = el.getBoundingClientRect();
      for (const card of el.querySelectorAll<HTMLElement>(CARD)) {
        const was = from.get(card.dataset.entity!);
        if (!was || typeof card.animate !== "function") continue;
        const now = visualBox(card, origin);
        const [dx, dy] = [was.x - now.x, was.y - now.y];
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
        animations.push(card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: MOVE_MS, easing: EASING }));
      }
    }
    running.current = animations;
    setMoving(animations.length > 0);
    if (!animations.length) return;
    const mine = generation.current;
    Promise.all(animations.map((animation) => animation.finished)).then(
      () => {
        if (generation.current !== mine) return;
        running.current = [];
        setMoving(false);
      },
      () => {}, // Cancelled: whoever cancelled it has already settled what's shown.
    );
  }, [index]);

  // A task later, after the re-render in which a scroll box in the new card measures whether it's a tab stop.
  useEffect(() => {
    const keep = focus.current;
    focus.current = null;
    if (!keep) return;
    const timer = setTimeout(() => {
      const el = grid.current;
      const active = document.activeElement;
      if (!el || (active && active !== document.body && active.isConnected)) return;
      const target = cardFor(el, keep.entity)?.querySelectorAll<HTMLElement>(FOCUSABLE)[keep.at];
      target?.focus({ preventScroll: true });
      if (!target || document.activeElement !== target) el.closest<HTMLElement>('[data-testid="composition"]')?.focus({ preventScroll: true });
    });
    return () => clearTimeout(timer);
  }, [index]);

  // Routing reads layout only, so it's cheap to redo after every render; an unchanged result doesn't re-render.
  const measure = () => {
    const el = grid.current;
    if (!el) return;
    const cards = new Map([...el.querySelectorAll<HTMLElement>(CARD)].map((card) => [card.dataset.entity!, layoutBox(card, el)]));
    const obstacles = [...el.querySelectorAll<HTMLElement>(OBSTACLE)].map((obstacle) => layoutBox(obstacle, el));
    const next = routeConnectors(el.clientWidth, el.clientHeight, cards, obstacles, requests.current);
    setLayout((before) => (sameLayout(before, next) ? before : next));
  };
  useLayoutEffect(measure);

  useEffect(() => {
    const el = grid.current;
    if (!el) return;
    width.current = el.clientWidth;
    let current = true;
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            // A new width lays every card out again, so a glide towards the old layout would land in the wrong place.
            if (el.clientWidth !== width.current) {
              width.current = el.clientWidth;
              if (running.current.length) {
                stop();
                setMoving(false);
              }
            }
            measure();
          });
    observer?.observe(el);
    for (const card of el.querySelectorAll(CARD)) observer?.observe(card);
    void document.fonts?.ready.then(() => {
      if (current) measure();
    });
    return () => {
      current = false;
      observer?.disconnect();
    };
  }, [index]);

  // Nothing glides on after the card is gone.
  useEffect(() => stop, []);

  return { layout, moving, navigate };
}
