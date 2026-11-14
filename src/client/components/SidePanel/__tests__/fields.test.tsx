// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ColorInput } from "../ColorInput";
import { CommitInput } from "../fields";

afterEach(cleanup);

function Harness({ commit }: { commit: (v: string) => boolean | void }) {
  const [value, setValue] = useState("abc");
  return (
    <>
      <CommitInput
        value={value}
        testId="in"
        commit={(v) => {
          commit(v);
          setValue(v);
        }}
      />
    </>
  );
}
const input = () => screen.getByTestId("in") as HTMLInputElement;

describe("CommitInput", () => {
  it("commits on Enter", () => {
    const commit = vi.fn();
    render(<Harness commit={commit} />);
    fireEvent.change(input(), { target: { value: "xyz" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(commit).toHaveBeenCalledExactlyOnceWith("xyz");
  });
  it("commits on blur", () => {
    const commit = vi.fn();
    render(<Harness commit={commit} />);
    fireEvent.change(input(), { target: { value: "xyz" } });
    fireEvent.blur(input());
    expect(commit).toHaveBeenCalledExactlyOnceWith("xyz");
  });
  it("Escape reverts and does not commit", () => {
    const commit = vi.fn();
    render(<Harness commit={commit} />);
    input().focus();
    fireEvent.change(input(), { target: { value: "xyz" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(commit).not.toHaveBeenCalled();
    expect(input().value).toBe("abc");
  });
  it("commits a pending draft on unmount", () => {
    const commit = vi.fn();
    const { unmount } = render(<Harness commit={commit} />);
    fireEvent.change(input(), { target: { value: "xyz" } });
    unmount();
    expect(commit).toHaveBeenCalledExactlyOnceWith("xyz");
  });
  it("does not commit on unmount right after Escape", () => {
    const commit = vi.fn();
    const { unmount } = render(<Harness commit={commit} />);
    fireEvent.change(input(), { target: { value: "xyz" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    unmount();
    expect(commit).not.toHaveBeenCalled();
  });
  it("does not double-commit when blurred then unmounted", () => {
    const commit = vi.fn();
    const { unmount } = render(<Harness commit={commit} />);
    fireEvent.change(input(), { target: { value: "xyz" } });
    fireEvent.blur(input());
    unmount();
    expect(commit).toHaveBeenCalledTimes(1);
  });
});

describe("ColorInput", () => {
  it("commits two consecutive changes", () => {
    const onCommit = vi.fn();
    function H() {
      const [v, setV] = useState("#4A90D9");
      return (
        <ColorInput
          value={v}
          label="color"
          onCommit={(c) => {
            onCommit(c);
            setV(c);
          }}
        />
      );
    }
    render(<H />);
    const el = screen.getByLabelText("color") as HTMLInputElement;
    fireEvent.input(el, { target: { value: "#ff0000" } });
    fireEvent.change(el);
    fireEvent.input(el, { target: { value: "#00ff00" } });
    fireEvent.change(el);
    expect(onCommit.mock.calls).toEqual([["#FF0000"], ["#00FF00"]]);
  });
});
