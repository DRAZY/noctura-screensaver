import { describe, expect, it, mock } from "bun:test";
import { installExitOnInput, type ListenerTarget } from "./exit";

/** Tiny in-memory EventTarget double that lets a test dispatch by type. */
function fakeTarget() {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const target: ListenerTarget = {
    addEventListener(type, listener) {
      const arr = listeners.get(type) ?? [];
      arr.push(listener);
      listeners.set(type, arr);
    },
    removeEventListener(type, listener) {
      const arr = listeners.get(type);
      if (!arr) return;
      listeners.set(
        type,
        arr.filter((l) => l !== listener),
      );
    },
  };
  const dispatch = (type: string, event?: unknown) => {
    for (const l of listeners.get(type) ?? []) l(event);
  };
  const count = (type: string) => (listeners.get(type) ?? []).length;
  return { target, dispatch, count };
}

describe("installExitOnInput", () => {
  it("fires onExit on keydown", () => {
    const { target, dispatch } = fakeTarget();
    const onExit = mock();
    installExitOnInput(target, { onExit });
    dispatch("keydown");
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("fires onExit on mousedown and wheel", () => {
    for (const evt of ["mousedown", "wheel"]) {
      const { target, dispatch } = fakeTarget();
      const onExit = mock();
      installExitOnInput(target, { onExit });
      dispatch(evt);
      expect(onExit).toHaveBeenCalledTimes(1);
    }
  });

  it("fires at most once even across multiple events", () => {
    const { target, dispatch } = fakeTarget();
    const onExit = mock();
    installExitOnInput(target, { onExit });
    dispatch("keydown");
    dispatch("mousedown");
    dispatch("wheel");
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("ignores small mouse jitter below the threshold", () => {
    const { target, dispatch } = fakeTarget();
    const onExit = mock();
    installExitOnInput(target, { onExit, moveThreshold: 8 });
    dispatch("mousemove", { clientX: 100, clientY: 100 }); // establishes origin
    dispatch("mousemove", { clientX: 103, clientY: 102 }); // ~3.6px < 8
    expect(onExit).not.toHaveBeenCalled();
  });

  it("fires once the pointer travels past the threshold", () => {
    const { target, dispatch } = fakeTarget();
    const onExit = mock();
    installExitOnInput(target, { onExit, moveThreshold: 8 });
    dispatch("mousemove", { clientX: 100, clientY: 100 }); // origin
    dispatch("mousemove", { clientX: 100, clientY: 120 }); // 20px > 8
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("cleanup removes every listener", () => {
    const { target, dispatch, count } = fakeTarget();
    const onExit = mock();
    const cleanup = installExitOnInput(target, { onExit });
    cleanup();
    for (const type of ["keydown", "mousedown", "wheel", "mousemove"]) {
      expect(count(type)).toBe(0);
    }
    dispatch("keydown");
    expect(onExit).not.toHaveBeenCalled();
  });
});
